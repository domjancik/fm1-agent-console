/* SPDX-License-Identifier: GPL-3.0-only */
/* FM1 CONSOLE's Bluetooth LE MIDI glue (FM1C_BLE builds only; interface and rules in fm1c_ble.h).
 *
 * A unit of its own, compiled by tools/build.py --ble with the include path firmware/ble (the BLE stack: Optimist's,
 * through fm1-base, GPL-3.0-only OR MPL-2.0, used here under GPL-3.0-only), firmware/hal/ble (felucca-bsp's radio
 * driver headers, MPL-2.0 and Apache-2.0) and build/gen (the radio start-up tables). It never includes firmware/hal:
 * felucca-bsp's headers are newer copies of the same files. Linked into the app only: the update loader has none of it.
 *
 * The stack runs in the radio's two interrupts (IRQ 45 event, IRQ 29 RX, priority 2: below the audio 3 and TIMER5 4)
 * and talks to the main loop through the two single-producer rings below. BLE-MIDI peripheral only: no central, no
 * pairing, no LL encryption, no diagnostics. No register access here: every register is reached through hal/ble.
 *
 * The radio calibrates itself at each start (felucca-bsp fm1_rf_cal.h, fm1_rf_cal_on = 1) with the SDK board's
 * constants for records 106-108. No flash location is read or written, the stock VM at 0x0E8000 included: the only
 * flash commands are the two ID reads below (JEDEC ID, unique ID).
 *
 * The address: the same on every start of a given FM-1, nothing stored. Once per boot, before the radio starts,
 * hal/ble/fm1c_flash_uid.h reads the SPI flash's factory unique ID (commands 0x9F and 0x4B only, from RAM with every
 * interrupt off; no write command exists there) and fm1c_ble_addr_make (fm1c_ble.h) hashes it into a static random
 * address. Without a usable ID (an unknown part, a timeout, an ID of equal octets) the fixed FM1C_BLE_ADDR_FIXED_INIT,
 * never a random one: the name then ends in 0000. What happened is kept in fm1c_ble_id below (the "log": this unit has
 * no channel of its own; console.c may show it through fm1c_ble_addr). */
#define BLE_DEVICE_NAME "FM1 CONSOLE"           /* advertised and GAP name: "FM1 CONSOLE XXXX" (fm1c_ble_name_hex) */
#define BLE_NAME_HEX 1
#define BLE_CENTRAL 0
#define BLE_LL_ENC 0
#define BLE_SMP_LEGACY 0
#define BLE_DIAG 0
#define BLE_HW_IRQ_PRIO 2u
#define FM1_IRQ_DEFS 0                          /* console.o owns the crash record and the fault handler */
#define RING_PUBLISH() __asm__ volatile("" ::: "memory")
#include <stdint.h>
#include "fm1c_ble.h"
#include "fm1_guard.h"
#include "fm1c_flash_uid.h"                     /* hal/ble: ours, read-only */
#include "ble_stack.c"

/* ---- the rings: out (main loop -> the interrupts), in (the interrupts -> main loop) */
#define OQ 512u                                 /* a power of two; a whole frame or nothing (fm1c_ble_put's caller) */
#define IQ 256u
static uint32_t out_pkt[OQ];
static uint16_t out_ms[OQ];
static volatile uint32_t oo_w, oo_r;
static uint32_t in_pkt[IQ];
static volatile uint32_t ii_w, ii_r, in_lost, in_other;
static uint8_t radio_on;

BLE_API int ble_app_midi_peek(uint32_t *pkt, uint32_t *t_ms)
{
    if (oo_r == oo_w) return 0;
    *pkt = out_pkt[oo_r % OQ];
    *t_ms = out_ms[oo_r % OQ];
    return 1;
}

BLE_API void ble_app_midi_pop(void)
{
    if (oo_r != oo_w) oo_r++;
}

BLE_API void ble_app_midi_in(uint32_t pkt, uint16_t ts, uint16_t last_ts)
{
    (void)ts;
    (void)last_ts;
    if ((pkt & 0xFu) != FM1C_BLE_CIN_CC) { in_other++; return; }   /* SysEx, notes, real time: never to the app */
    if (ii_w - ii_r >= IQ) { in_lost++; return; }
    in_pkt[ii_w % IQ] = pkt;
    RING_PUBLISH();
    ii_w++;
}

BLE_API void ble_app_state(void) {}             /* (fm1c_ble_state asks the stack itself) */

/* ---- console.c's side (main loop) */
static const struct ble_rf_trims TRIMS = {{0x0B, 0x0B}, {1, 7, 4, 7, 11, 1, 7}, {0}, {0}};   /* the SDK board's */

/* the address's record, in RAM only (readable in the emulator and over a debugger): tag, where the address came from
 * (FM1C_BLE_ADDR_*), the flash read's result (FM1C_UID_*) and the JEDEC ID it saw, the address. The ID itself is not
 * kept. Volatile, so every field stays in RAM as written (else the compiler keeps only what fm1c_ble_addr reads). */
static volatile struct {
    char tag[8];
    uint32_t src, jedec;
    int32_t rc;
    uint8_t addr[6];
} fm1c_ble_id = {"FM1CADR", FM1C_BLE_ADDR_NONE, 0, 0, {0}};

static void ble_addr_load(uint8_t addr[6])
{
    uint8_t uid[16];
    uint32_t jedec = 0, i;
    int rc = fm1c_flash_uid(uid, &jedec);
    fm1c_ble_id.rc = rc;
    fm1c_ble_id.jedec = jedec;
    fm1c_ble_id.src = fm1c_ble_addr_make(rc == FM1C_UID_OK ? uid : 0, addr);
    for (i = 0; i < 6u; i++) fm1c_ble_id.addr[i] = addr[i];
}

uint32_t fm1c_ble_addr(uint8_t a[6])
{
    uint32_t i;
    for (i = 0; i < 6u; i++) a[i] = fm1c_ble_id.addr[i];
    return fm1c_ble_id.src;
}

void fm1c_ble_start(void)
{
    uint8_t addr[6];
    if (radio_on) return;
    radio_on = 1;
    ble_addr_load(addr);                        /* before the radio: its start-up leaves XIP unusable for a while */
    ble_init(addr, 1);                          /* 1: random (static) address type */
    fm1_irq_off();
    fm1_guard_unlock_top();                     /* (the vector table sits in the guarded top of RAM) */
    ble_hw_wl82_attach();                       /* both vectors, masked until the radio runs */
    fm1_guard_lock_top();
    fm1_irq_on();
    fm1_rf_cal_on = 1;                          /* measure; no stored record 187 */
    fm1_irq_off();                              /* about 210 ms with no interrupt: Chipbox saw start-ups hang with
                                                 * them on (felucca-bsp users, 2026-11-12) */
    ble_hw_wl82_start(&TRIMS);
    fm1_irq_on();
    ble_enable(1);                              /* advertising (the BLE interrupts are still held) */
    fm1_ble_irqs_hold(0);
}

uint32_t fm1c_ble_state(void)
{
    if (!radio_on) return FM1C_BLE_OFF;
    if (!ble_connected()) return FM1C_BLE_ADV;
    return ble_midi_ready() ? FM1C_BLE_READY : FM1C_BLE_LINKED;
}

uint32_t fm1c_ble_tx_room(void) { return OQ - (oo_w - oo_r); }

int fm1c_ble_put(uint32_t pkt, uint32_t ms)
{
    if (oo_w - oo_r >= OQ) return 0;
    out_pkt[oo_w % OQ] = pkt;
    out_ms[oo_w % OQ] = (uint16_t)(ms & 0x1FFFu);
    RING_PUBLISH();
    oo_w++;
    return 1;
}

int fm1c_ble_get(uint32_t *pkt)
{
    if (ii_r == ii_w) return 0;
    *pkt = in_pkt[ii_r % IQ];
    RING_PUBLISH();
    ii_r++;
    return 1;
}

void fm1c_ble_drop_tx(void)
{
    if (!radio_on) { oo_r = oo_w; return; }
    fm1_ble_irqs_hold(1);                       /* the reader is the interrupts: hold them while it moves */
    oo_r = oo_w;
    fm1_ble_irqs_hold(0);
}
