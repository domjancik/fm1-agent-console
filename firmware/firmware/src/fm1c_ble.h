/* SPDX-License-Identifier: GPL-3.0-only */
/* FM1C over Bluetooth LE MIDI (FM1C_BLE builds only: tools/build.py --ble). The link is transport-agnostic: the same
 * frames as on USB, each CC word (BF cc vv) one USB-MIDI event packet for the BLE-MIDI stack. On the computer the
 * FM-1 is a CoreMIDI port like the USB one. Implemented by src/fm1c_ble.c, a unit of its own (the stack's and
 * felucca-bsp's headers stay out of console.c); the packet helpers below use only <stdint.h>, so host tests use them.
 *
 *   fm1c_ble_start()        the radio up and advertising; once per boot, from the main loop
 *   fm1c_ble_state()        FM1C_BLE_*: off, advertising, a central connected, its MIDI notifications on (ready)
 *   fm1c_ble_put(pkt, ms)   one packet to send (main loop); 0 when the ring is full
 *   fm1c_ble_tx_room()      free slots in that ring
 *   fm1c_ble_get(&pkt)      one received control change (main loop); everything else the central sends, SysEx
 *                           included, is dropped in the radio's interrupt and never reaches the app or the updater
 *   fm1c_ble_drop_tx()      forget what waits to go out (the central left: nothing stale for the next one)
 *   fm1c_ble_addr(a)        the device address in use (a[0] least significant), -> FM1C_BLE_ADDR_* (where it came from)
 *
 * The address is the same on every start of a given FM-1 (fm1c_ble_addr_make below): a static random address made
 * from the SPI flash's factory unique ID, read (never written) once per boot by hal/ble/fm1c_flash_uid.h. A part that
 * gives no usable ID gets one fixed address, the same on every unit, whose name ends in 0000. */
#pragma once
#include <stdint.h>

enum { FM1C_BLE_OFF, FM1C_BLE_ADV, FM1C_BLE_LINKED, FM1C_BLE_READY };

void fm1c_ble_start(void);
uint32_t fm1c_ble_state(void);
int fm1c_ble_put(uint32_t pkt, uint32_t ms);
uint32_t fm1c_ble_tx_room(void);
int fm1c_ble_get(uint32_t *pkt);
void fm1c_ble_drop_tx(void);
uint32_t fm1c_ble_addr(uint8_t a[6]);

#define FM1C_BLE_CIN_CC 0xBu                    /* USB-MIDI code index: control change */

/* a control change as a USB-MIDI event packet: cin | status << 8 | d1 << 16 | d2 << 24 (cable 0) */
static inline uint32_t fm1c_ble_pkt(uint32_t status, uint32_t d1, uint32_t d2)
{
    return (status >> 4 & 0xFu) | (status & 0xFFu) << 8 | (d1 & 0x7Fu) << 16 | (d2 & 0x7Fu) << 24;
}

/* the packet back to (status, d1, d2): 1 for a control change, 0 for anything else (left untouched) */
static inline int fm1c_ble_unpkt(uint32_t pkt, uint8_t *st, uint8_t *d1, uint8_t *d2)
{
    uint32_t s = pkt >> 8 & 0xFFu;
    if ((pkt & 0xFu) != FM1C_BLE_CIN_CC || (s & 0xF0u) != 0xB0u) return 0;
    *st = (uint8_t)s;
    *d1 = (uint8_t)(pkt >> 16 & 0x7Fu);
    *d2 = (uint8_t)(pkt >> 24 & 0x7Fu);
    return 1;
}

/* ---- the stable address (host-tested: tests/ble/fm1c_ble_addr_test.c) */
enum { FM1C_BLE_ADDR_NONE, FM1C_BLE_ADDR_UID, FM1C_BLE_ADDR_FIXED };

/* the fallback, least significant octet first: C6:46:31:43:00:00 as written; the name "FM1 CONSOLE 0000", which no
 * address made from an ID has (fm1c_ble_addr_make) */
#define FM1C_BLE_ADDR_FIXED_INIT {0x00, 0x00, 0x43, 0x31, 0x46, 0xC6}

static inline uint32_t fm1c_ble_mix32(uint32_t h)  /* MurmurHash3's finaliser: every input bit reaches every output bit */
{
    h ^= h >> 16;
    h *= 0x85EBCA6Bu;
    h ^= h >> 13;
    h *= 0xC2B2AE35u;
    h ^= h >> 16;
    return h;
}

/* uid: the flash's 16-byte unique ID, or 0 when it could not be read. Out: a static random address (Core Vol 6 Part B
 * 1.3.2.1: the two most significant bits 1, the other 46 neither all 0 nor all 1), a[0] least significant. Two 32-bit
 * FNV-1a hashes with their own seeds over "FM1C" then the ID, each finalised; the domain prefix keeps this address
 * apart from the one fm1-base or Melodee derives from the same ID (so a Mac never mixes their cached names). An ID of
 * 16 equal octets (all FF or all 00: a part that does not answer 0x4B) counts as none. -> FM1C_BLE_ADDR_UID or
 * FM1C_BLE_ADDR_FIXED. Pure: the same ID gives the same address on every start, firmware build and host. */
static inline uint32_t fm1c_ble_addr_make(const uint8_t *uid, uint8_t a[6])
{
    static const uint8_t fixed[6] = FM1C_BLE_ADDR_FIXED_INIT, dom[4] = {'F', 'M', '1', 'C'};
    uint32_t h = 2166136261u, g = 0x9E3779B9u, i, same = 1;
    if (uid)
        for (i = 1; i < 16u; i++)
            if (uid[i] != uid[0]) same = 0;
    if (!uid || same) {
        for (i = 0; i < 6u; i++) a[i] = fixed[i];
        return FM1C_BLE_ADDR_FIXED;
    }
    for (i = 0; i < 20u; i++) {
        uint32_t b = i < 4u ? dom[i] : uid[i - 4u];
        h = (h ^ b) * 16777619u;
        g = (g ^ b) * 2246822519u;
    }
    h = fm1c_ble_mix32(h);
    g = fm1c_ble_mix32(g ^ h);
    a[0] = (uint8_t)h;
    a[1] = (uint8_t)(h >> 8);
    a[2] = (uint8_t)g;
    a[3] = (uint8_t)(g >> 8);
    a[4] = (uint8_t)(g >> 16);
    a[5] = (uint8_t)(g >> 24 | 0xC0u);
    if (a[0] == 0 && a[1] == 0) a[0] = 1;           /* "0000" names the fallback only (and the 46 bits are not all 0) */
    if ((a[0] & a[1] & a[2] & a[3] & a[4]) == 0xFFu && a[5] == 0xFFu) a[0] = 0xFE;   /* nor all 1 */
    return FM1C_BLE_ADDR_UID;
}

/* the four hex digits the stack appends to the name (firmware/ble/ble_host.c gap_name, BLE_NAME_HEX 1): a[1] then
 * a[0], upper case, so the Mac shows "FM1 CONSOLE " + these */
static inline void fm1c_ble_name_hex(const uint8_t a[6], char out[5])
{
    static const char hex[] = "0123456789ABCDEF";
    out[0] = hex[a[1] >> 4];
    out[1] = hex[a[1] & 15u];
    out[2] = hex[a[0] >> 4];
    out[3] = hex[a[0] & 15u];
    out[4] = 0;
}
