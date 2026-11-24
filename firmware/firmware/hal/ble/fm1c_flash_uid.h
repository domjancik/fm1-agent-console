/* SPDX-License-Identifier: GPL-3.0-only */
/* FM1 CONSOLE's own file (not felucca-bsp's, unlike the rest of this directory): the SPI NOR's factory unique ID,
 * READ-ONLY, for the BLE unit's stable address (src/fm1c_ble.c). FM1C_BLE builds only; the USB build never includes it.
 *
 *   fm1c_flash_uid(dst16, &jedec)   0: dst holds the part's 16-byte unique ID (0x4B); < 0: nothing read (FM1C_UID_E*)
 *
 * The sequence is Dinghy's fl_jedec_ram (firmware/hal/fm1_flash.h, run at every boot of this firmware on this FM-1),
 * with felucca-bsp's 0x4B read (chip/fm1_flash.h fl_uid_ram @ fbc254d: opcode, four dummy bytes, 16 ID bytes; fm1-base
 * reads it at every boot for its Wi-Fi MAC and BLE address). Only two commands go to the part: 0x9F (JEDEC ID) and,
 * when the ID is a part the FM-1 is known to carry, 0x4B. Neither writes: no write enable (0x06), no erase, no program,
 * no status write. Nothing else in this file can send a command.
 *
 * XIP: the SFC (execute-in-place) is off between fm1c_flash_uid_ram's enter and exit, so that function lives in
 * .ram_text, is entered only through a pointer (XIP -> RAM is beyond a direct call's reach), inlines every helper
 * (tools/build.py: no calls in .ram_text) and touches only SFRs, its stack and the caller's RAM buffers. It masks every
 * interrupt itself, both ICFG bits (bit 9 = cli, bit 8 = the global enable the SDK clears, which also holds priority 7
 * off: felucca-bsp fm1_flash_access.h), because a handler fetched from flash would fault, and gives the caller's ICFG
 * back at the end. It waits for the cache to go idle before XIP goes off, refuses a continuous-read SFC mode (6, 7)
 * and any core but CPU0. Call it before the radio's start-up (fm1_ble_rf.h: the crystal ramp leaves XIP unusable
 * until it completes), as fm1c_ble_start does. */
#pragma once
#include <stdint.h>
#include "fm1_cc.h"

#ifndef FM1C_UID_HOST                           /* tests/ble/fm1c_uid_test.c brings a model of the part instead */
#define FM1C_UID_SFC_CON    (*(volatile uint32_t *)0x40200u)    /* bit31 busy; [11:8] read mode */
#define FM1C_UID_SPI0_CON   (*(volatile uint32_t *)0x11C00u)    /* b15 PND, b14 PCLR, b12 DIR = rx, b3 */
#define FM1C_UID_SPI0_BUF   (*(volatile uint32_t *)0x11C08u)
#define FM1C_UID_IOMAP_CON0 (*(volatile uint32_t *)0x5101Cu)    /* b5: 1 = the SFC owns the flash pins */
#define FM1C_UID_PORTD_OUT  (*(volatile uint32_t *)0x500C0u)    /* PD0 = flash CS# */
#define FM1C_UID_PORTD_DIR  (*(volatile uint32_t *)0x500C8u)
#define FM1C_UID_CACHE_CON  (*(volatile uint32_t *)0x1EEE008u)  /* b14 = cache idle */
#define FM1C_UID_RAMFN __attribute__((section(".ram_text"), noinline, used))
#endif

/* the parts an FM-1 carries (firmware/hal/fm1_flash_map.h FL_JEDEC_OK): the Puya P25Q80 and the UC25HQ80 */
#define FM1C_UID_PART_OK(id) ((id) == 0x856014u || (id) == 0xB36014u)

enum { FM1C_UID_OK = 0, FM1C_UID_ECORE = -1, FM1C_UID_EMODE = -2, FM1C_UID_EPART = -3, FM1C_UID_ESPI = -4 };

#ifndef FM1C_UID_HOST
FM1_INLINE void fm1c_uid_sync(void) { __asm__ volatile("csync" ::: "memory"); }
FM1_INLINE uint32_t fm1c_uid_icfg(void) { uint32_t v; __asm__ volatile("%0 = icfg" : "=r"(v) :: "memory"); return v; }
FM1_INLINE void fm1c_uid_icfg_set(uint32_t v) { __asm__ volatile("icfg = %0" :: "r"(v) : "memory"); }
FM1_INLINE uint32_t fm1c_uid_core(void) { uint32_t v; __asm__ volatile("%0 = cnum" : "=r"(v)); return v; }
#endif
FM1_INLINE void fm1c_uid_delay(uint32_t n) { volatile uint32_t i = n; while (i--) ; }

FM1_INLINE void fm1c_uid_cs(int high)
{
    FM1C_UID_PORTD_DIR &= ~1u;
    if (high) FM1C_UID_PORTD_OUT |= 1u; else FM1C_UID_PORTD_OUT &= ~1u;
    fm1c_uid_delay(10);
}

/* one byte: fl_tx (rx 0) or fl_rx (rx 1) of firmware/hal/fm1_flash.h, step for step; a wait that times out sets *err */
FM1_INLINE uint32_t fm1c_uid_xfer(uint32_t out, uint32_t rx, uint32_t *err)
{
    uint32_t n = 50000000u, v = 0;
    FM1C_UID_SPI0_CON |= 8u;
    if (rx) FM1C_UID_SPI0_CON |= 0x1000u; else FM1C_UID_SPI0_CON &= ~0x1000u;
    FM1C_UID_SPI0_BUF = out;
    fm1c_uid_sync();
    while (!(FM1C_UID_SPI0_CON & 0x8000u))
        if (--n == 0) break;
    FM1C_UID_SPI0_CON |= 0x4000u;
    if (!n) *err = 1u;
    if (rx) v = FM1C_UID_SPI0_BUF & 0xFFu;
    FM1C_UID_SPI0_CON &= ~8u;
    return v;
}

/* IRQs: masked here. dst (16 bytes) and jedec: RAM. */
FM1C_UID_RAMFN
static int fm1c_flash_uid_ram(uint8_t *dst, uint32_t *jedec)
{
    uint32_t icfg = fm1c_uid_icfg(), sfc, spi, id, i, err = 0;
    int rc = FM1C_UID_OK;
    fm1c_uid_icfg_set(icfg & ~0x300u);                /* every interrupt off (both enables) */
    fm1c_uid_sync();
    *jedec = 0;
    if (fm1c_uid_core() != 0u) { rc = FM1C_UID_ECORE; goto out; }
    while (!(FM1C_UID_CACHE_CON & 0x4000u)) ;         /* cache idle */
    sfc = FM1C_UID_SFC_CON;
    spi = FM1C_UID_SPI0_CON;
    if (((sfc >> 8) & 0xFu) == 6u || ((sfc >> 8) & 0xFu) == 7u) { rc = FM1C_UID_EMODE; goto out; }
    fm1c_uid_sync();
    while ((int32_t)FM1C_UID_SFC_CON < 0) ;           /* SFC idle */
    FM1C_UID_SFC_CON = 0;                             /* XIP OFF from here */
    FM1C_UID_IOMAP_CON0 &= ~0x20u;                    /* the pins to SPI0 / GPIO */
    FM1C_UID_SPI0_CON = 0;
    FM1C_UID_SPI0_CON = 0x1029u;                      /* the SDK's default, as fl_enter */
    fm1c_uid_sync();
    fm1c_uid_cs(0);
    fm1c_uid_xfer(0x9Fu, 0, &err);
    id = fm1c_uid_xfer(0xFFu, 1, &err) << 16;
    id |= fm1c_uid_xfer(0xFFu, 1, &err) << 8;
    id |= fm1c_uid_xfer(0xFFu, 1, &err);
    fm1c_uid_cs(1);
    *jedec = id;
    if (err) rc = FM1C_UID_ESPI;
    else if (!FM1C_UID_PART_OK(id)) rc = FM1C_UID_EPART;
    else {
        fm1c_uid_cs(0);
        for (i = 0; i < 5u; i++) fm1c_uid_xfer(i ? 0u : 0x4Bu, 0, &err);   /* 0x4B, four dummy bytes */
        for (i = 0; i < 16u; i++) dst[i] = (uint8_t)fm1c_uid_xfer(0xFFu, 1, &err);
        fm1c_uid_cs(1);
        if (err) rc = FM1C_UID_ESPI;
    }
    FM1C_UID_SPI0_CON = spi;                          /* exit, as fl_exit */
    FM1C_UID_IOMAP_CON0 |= 0x20u;
    fm1c_uid_sync();
    while ((int32_t)FM1C_UID_SFC_CON < 0) ;
    FM1C_UID_SFC_CON = sfc;                           /* XIP back on */
    fm1c_uid_sync();
out:
    fm1c_uid_sync();
    fm1c_uid_icfg_set(icfg);
    return rc;
}

/* from normal (XIP) code: through a pointer the compiler cannot fold back into a direct call */
static inline int fm1c_flash_uid(uint8_t dst[16], uint32_t *jedec)
{
    int (*volatile f)(uint8_t *, uint32_t *) = fm1c_flash_uid_ram;
    return f(dst, jedec);
}
