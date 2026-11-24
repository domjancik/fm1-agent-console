/* SPDX-License-Identifier: GPL-3.0-only */
/* hal/ble/fm1c_flash_uid.h's read against a model of the SFC, SPI0, CS# and the SPI NOR part: the only commands the
 * part sees are 0x9F and (for an FM-1 part only) 0x4B with four dummy bytes; never a write enable, erase, program or
 * status write. Every path gives the caller's ICFG back with both interrupt enables cleared in between, and XIP
 * (SFC_CON, the pin map, SPI0_CON) back as it was; a continuous-read SFC mode, a second core, an unknown part and a
 * stuck SPI each refuse with nothing sent past what they need. Host only (FM1C_UID_HOST: no register, no asm). */
#include <stdint.h>
#include <string.h>
#include "../console/t.h"

/* ---- the model */
#define SENT 0x80000000u                          /* nothing written to SPI0_BUF since the last byte */
#define RESP 0x10000u                             /* a byte the part answered with (the firmware masks to 8 bits) */
static uint32_t r_sfc, r_spi, r_buf = SENT, r_iomap, r_out, r_dir, r_cache = 0x4000u;
static uint32_t m_icfg, m_core, m_icfg_min, m_stuck, m_jedec;
static uint8_t m_uid[16];
static uint8_t cmds[64], seq[256];
static uint32_t ncmd, nseq, pos, cs_prev = 1, xip_touch, sfc_off_seen, bad_ram;

static void tick(void)
{
    uint32_t cs = r_out & 1u;
    if (r_spi & 0x4000u) r_spi &= ~0xC000u;       /* PCLR (written at the last access) clears PND */
    if (cs_prev && !cs) pos = 0;                  /* CS# fell: a new command */
    cs_prev = cs;
    if (r_buf != SENT && !(r_buf & RESP) && (r_spi & 8u)) {   /* a byte went out */
        uint32_t out = r_buf & 0xFFu, in = 0xFFu;
        if (m_stuck) return;                      /* PND never comes */
        if (r_sfc != 0) bad_ram++;                /* a command while the SFC still drives the pins */
        if (pos == 0 && ncmd < sizeof cmds) cmds[ncmd++] = (uint8_t)out;
        if (nseq < sizeof seq) seq[nseq++] = (uint8_t)out;
        if (pos > 0 && ncmd) {
            uint8_t c = cmds[ncmd - 1];
            if (c == 0x9F && pos <= 3) in = m_jedec >> (8u * (3u - pos)) & 0xFFu;
            if (c == 0x4B && pos >= 5 && pos < 21) in = m_uid[pos - 5];
        }
        pos++;
        r_buf = (r_spi & 0x1000u) ? (in | RESP) : SENT;   /* DIR rx: the answer waits in BUF; tx: nothing to read */
        r_spi |= 0x8000u;                         /* PND */
    }
}
static volatile uint32_t *acc(uint32_t *r)
{
    tick();
    return (volatile uint32_t *)r;
}
static volatile uint32_t *acc_buf(void)
{
    tick();
    if (r_buf & RESP) {                           /* an rx answer: read once (the firmware reads it at once) */
        static uint32_t tmp;
        tmp = r_buf;
        r_buf = SENT;
        return (volatile uint32_t *)&tmp;
    }
    return (volatile uint32_t *)&r_buf;
}
static volatile uint32_t *acc_sfc(void)
{
    tick();
    if (r_sfc == 0) sfc_off_seen = 1;
    xip_touch++;
    return (volatile uint32_t *)&r_sfc;
}

#define FM1C_UID_HOST 1
#define FM1C_UID_SFC_CON    (*acc_sfc())
#define FM1C_UID_SPI0_CON   (*acc(&r_spi))
#define FM1C_UID_SPI0_BUF   (*acc_buf())
#define FM1C_UID_IOMAP_CON0 (*acc(&r_iomap))
#define FM1C_UID_PORTD_OUT  (*acc(&r_out))
#define FM1C_UID_PORTD_DIR  (*acc(&r_dir))
#define FM1C_UID_CACHE_CON  (*acc(&r_cache))
#define FM1C_UID_RAMFN
static inline void fm1c_uid_sync(void) {}
static inline uint32_t fm1c_uid_icfg(void) { return m_icfg; }
static inline void fm1c_uid_icfg_set(uint32_t v)
{
    m_icfg = v;
    if ((v & 0x300u) == 0) m_icfg_min = 1;        /* both enables off at some point */
}
static inline uint32_t fm1c_uid_core(void) { return m_core; }
#include "fm1c_flash_uid.h"

static void reset(uint32_t jedec, uint32_t sfc_mode)
{
    uint32_t i;
    r_sfc = 0x00000200u | sfc_mode << 8 | 0x5u;   /* some XIP setting to get back */
    r_spi = 0x00000123u;
    r_buf = SENT;
    r_iomap = 0x20u | 0x1u;
    r_out = 1u;
    r_dir = 0;
    m_icfg = 0x0000037Fu;                         /* both enables on, other bits set */
    m_core = 0;
    m_icfg_min = 0;
    m_stuck = 0;
    m_jedec = jedec;
    for (i = 0; i < 16u; i++) m_uid[i] = (uint8_t)(0xA0u + i);
    ncmd = nseq = pos = 0;
    cs_prev = 1;
    xip_touch = sfc_off_seen = bad_ram = 0;
}

static void check_restored(const char *what, uint32_t sfc0)
{
    CHECK(m_icfg == 0x37Fu, "%s: ICFG %03x, not given back", what, m_icfg);
    CHECK(m_icfg_min, "%s: interrupts were never masked (both ICFG enables)", what);
    CHECK(r_sfc == sfc0, "%s: SFC_CON %08x, was %08x (XIP not restored)", what, r_sfc, sfc0);
    CHECK((r_iomap & 0x20u) != 0, "%s: the flash pins not given back to the SFC", what);
    CHECK((r_out & 1u) == 1u, "%s: CS# left low", what);
    CHECK(bad_ram == 0, "%s: %u bytes sent with the SFC on", what, bad_ram);
}

static int never_writes(void)
{
    uint32_t i;
    for (i = 0; i < ncmd; i++)
        if (cmds[i] != 0x9F && cmds[i] != 0x4B) return 0;
    return 1;
}

int main(void)
{
    uint8_t uid[16];
    uint32_t jedec, sfc0, i;
    int rc;

    /* both FM-1 parts: 9F then 4B, the 16 ID octets */
    {
        static const uint32_t parts[2] = {0x856014u, 0xB36014u};
        for (i = 0; i < 2u; i++) {
            reset(parts[i], 2);
            sfc0 = r_sfc;
            memset(uid, 0, sizeof uid);
            rc = fm1c_flash_uid(uid, &jedec);
            CHECK(rc == FM1C_UID_OK, "part %06x: rc %d", parts[i], rc);
            CHECK(jedec == parts[i], "part %06x: JEDEC %06x", parts[i], jedec);
            CHECK(!memcmp(uid, m_uid, 16), "part %06x: the ID differs", parts[i]);
            CHECK(ncmd == 2 && cmds[0] == 0x9F && cmds[1] == 0x4B, "part %06x: %u commands (%02x %02x)", parts[i], ncmd,
                  cmds[0], cmds[1]);
            CHECK(nseq == 4u + 21u, "part %06x: %u bytes on the bus, 25 expected", parts[i], nseq);
            CHECK(seq[5] == 0 && seq[6] == 0 && seq[7] == 0 && seq[8] == 0, "4B: four zero dummy bytes");
            CHECK(sfc_off_seen, "XIP was not switched off around the commands");
            check_restored("FM-1 part", sfc0);
        }
    }

    /* an unknown part: 9F only, nothing more sent */
    reset(0xEF4014u, 2);
    sfc0 = r_sfc;
    rc = fm1c_flash_uid(uid, &jedec);
    CHECK(rc == FM1C_UID_EPART && jedec == 0xEF4014u, "unknown part: rc %d JEDEC %06x", rc, jedec);
    CHECK(ncmd == 1 && cmds[0] == 0x9F && nseq == 4u, "unknown part: %u commands, %u bytes", ncmd, nseq);
    check_restored("unknown part", sfc0);

    /* no part answering (all FF): unknown */
    reset(0xFFFFFFu, 2);
    rc = fm1c_flash_uid(uid, &jedec);
    CHECK(rc == FM1C_UID_EPART && ncmd == 1, "no answer: rc %d, %u commands", rc, ncmd);

    /* continuous-read XIP (modes 6, 7): refused before XIP is touched */
    for (i = 6; i <= 7; i++) {
        reset(0x856014u, i);
        sfc0 = r_sfc;
        rc = fm1c_flash_uid(uid, &jedec);
        CHECK(rc == FM1C_UID_EMODE && nseq == 0 && !sfc_off_seen, "mode %u: rc %d, %u bytes", i, rc, nseq);
        CHECK(r_sfc == sfc0 && m_icfg == 0x37Fu, "mode %u: state not as before", i);
    }

    /* the second core: refused, nothing touched */
    reset(0x856014u, 2);
    m_core = 1;
    rc = fm1c_flash_uid(uid, &jedec);
    CHECK(rc == FM1C_UID_ECORE && nseq == 0 && xip_touch == 0 && m_icfg == 0x37Fu, "CPU1: rc %d", rc);

    /* a stuck SPI (PND never set): a timeout, no 4B, XIP and interrupts back */
    reset(0x856014u, 2);
    sfc0 = r_sfc;
    m_stuck = 1;
    rc = fm1c_flash_uid(uid, &jedec);
    CHECK(rc == FM1C_UID_ESPI && ncmd == 0, "stuck SPI: rc %d, %u commands", rc, ncmd);
    CHECK(r_sfc == sfc0 && m_icfg == 0x37Fu && (r_iomap & 0x20u), "stuck SPI: XIP or interrupts not given back");

    CHECK(never_writes(), "a command other than 9F / 4B was sent");
    T_DONE("fm1c_flash_uid");
}
