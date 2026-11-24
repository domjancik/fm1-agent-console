/* SPDX-License-Identifier: GPL-3.0-only */
/* The BLE address made from the flash's unique ID (fm1c_ble.h fm1c_ble_addr_make): the bit pattern of a static random
 * address, determinism (golden vectors: a change here renames every FM-1 on its Mac), sensitivity to every ID bit, no
 * collisions in 200,000 IDs, the fixed fallback and its "0000" name, and that it differs from fm1-base's address for
 * the same ID. Host only. */
#include <stdlib.h>
#include "fm1c_ble.h"
#include "../console/t.h"

/* pinned on 2026-11-18: changing the derivation renames every FM-1 (and macOS keeps the old entry) */
#define GOLD_EMU_ADDR "CE:5D:B1:E5:9F:7F"   /* "FM1 CONSOLE 9F7F" */
#define GOLD_SEQ_ADDR "F2:4D:35:6D:1D:E2"   /* "FM1 CONSOLE 1DE2" */

static uint32_t rs = 0x2545F491u;
static uint32_t xs(void) { rs ^= rs << 13; rs ^= rs >> 17; rs ^= rs << 5; return rs; }
static void rnd_uid(uint8_t u[16]) { uint32_t i; for (i = 0; i < 16u; i++) u[i] = (uint8_t)xs(); }

static int valid_static(const uint8_t a[6])   /* Core Vol 6 Part B 1.3.2.1 */
{
    uint32_t i, all0 = 1, all1 = 1;
    if ((a[5] & 0xC0u) != 0xC0u) return 0;
    for (i = 0; i < 5u; i++) {
        if (a[i] != 0x00) all0 = 0;
        if (a[i] != 0xFF) all1 = 0;
    }
    if ((a[5] & 0x3Fu) != 0x00) all0 = 0;
    if ((a[5] & 0x3Fu) != 0x3F) all1 = 0;
    return !all0 && !all1;
}

static void fmt(const uint8_t a[6], char out[18])   /* as macOS writes it: most significant octet first */
{
    snprintf(out, 18, "%02X:%02X:%02X:%02X:%02X:%02X", a[5], a[4], a[3], a[2], a[1], a[0]);
}

/* fm1-base device/bt_own.c own_addr, for the same ID (domain separation check) */
static void fm1base_addr(const uint8_t *u, uint8_t a[6])
{
    uint32_t h = 2166136261u, g = 0x9E3779B9u, i;
    for (i = 0; i < 16u; i++) { h = (h ^ u[i]) * 16777619u; g = (g ^ u[i]) * 2246822519u; }
    h ^= h >> 16;
    a[0] = (uint8_t)h; a[1] = (uint8_t)(h >> 8); a[2] = (uint8_t)g; a[3] = (uint8_t)(g >> 8);
    a[4] = (uint8_t)(g >> 16); a[5] = (uint8_t)((g >> 24) | 0xC0u);
}

static int cmp48(const void *x, const void *y)
{
    uint64_t a = *(const uint64_t *)x, b = *(const uint64_t *)y;
    return a < b ? -1 : a > b;
}

#define NRND 200000u
static uint64_t seen[NRND];

int main(void)
{
    uint8_t u[16], a[6], b[6];
    char s[18], n[5];
    uint32_t i, k, bad = 0, zero_name = 0, dup = 0;

    /* golden vectors: fm1-emu 0.5.1's flash answers 0x4B with "FM1-" four times (crates/fm1-soc/src/spiflash.rs) */
    for (i = 0; i < 16u; i++) u[i] = (uint8_t)"FM1-"[i & 3u];
    CHECK(fm1c_ble_addr_make(u, a) == FM1C_BLE_ADDR_UID, "emu ID: not taken as an ID");
    fmt(a, s);
    fm1c_ble_name_hex(a, n);
    printf("emu ID 464D312D x4 -> %s, name \"FM1 CONSOLE %s\"\n", s, n);
    CHECK(!strcmp(s, GOLD_EMU_ADDR), "emu ID: %s, pinned %s", s, GOLD_EMU_ADDR);
    for (i = 0; i < 16u; i++) u[i] = (uint8_t)i;
    fm1c_ble_addr_make(u, a);
    fmt(a, s);
    fm1c_ble_name_hex(a, n);
    printf("ID 00 01 .. 0F -> %s, name \"FM1 CONSOLE %s\"\n", s, n);
    CHECK(!strcmp(s, GOLD_SEQ_ADDR), "ID 00..0F: %s, pinned %s", s, GOLD_SEQ_ADDR);

    /* determinism: the same ID twice (and from a copy) gives the same address */
    for (k = 0; k < 1000u; k++) {
        uint8_t c[16];
        rnd_uid(u);
        memcpy(c, u, 16);
        fm1c_ble_addr_make(u, a);
        fm1c_ble_addr_make(c, b);
        if (memcmp(a, b, 6)) bad++;
    }
    CHECK(bad == 0, "determinism: %u of 1000 IDs gave two addresses", bad);

    /* the bit pattern, the name, uniqueness over many IDs */
    rs = 0x9E3779B9u;
    bad = 0;
    for (k = 0; k < NRND; k++) {
        rnd_uid(u);
        if (fm1c_ble_addr_make(u, a) != FM1C_BLE_ADDR_UID) { bad++; continue; }
        if (!valid_static(a)) bad++;
        if (a[0] == 0 && a[1] == 0) zero_name++;
        seen[k] = (uint64_t)a[0] | (uint64_t)a[1] << 8 | (uint64_t)a[2] << 16 | (uint64_t)a[3] << 24 |
                  (uint64_t)a[4] << 32 | (uint64_t)a[5] << 40;
    }
    CHECK(bad == 0, "%u of %u random IDs: not a valid static random address", bad, NRND);
    CHECK(zero_name == 0, "%u IDs got the fallback's name 0000", zero_name);
    qsort(seen, NRND, sizeof seen[0], cmp48);
    for (k = 1; k < NRND; k++) if (seen[k] == seen[k - 1]) dup++;
    CHECK(dup == 0, "%u duplicate addresses among %u IDs", dup, NRND);

    /* every one of the ID's 128 bits changes the address (and, nearly always, the name's 16 bits) */
    {
        uint32_t name_same = 0;
        rnd_uid(u);
        fm1c_ble_addr_make(u, a);
        bad = 0;
        for (i = 0; i < 128u; i++) {
            u[i / 8u] ^= (uint8_t)(1u << (i % 8u));
            fm1c_ble_addr_make(u, b);
            u[i / 8u] ^= (uint8_t)(1u << (i % 8u));
            if (!memcmp(a, b, 6)) bad++;
            if (a[0] == b[0] && a[1] == b[1]) name_same++;
        }
        CHECK(bad == 0, "%u of 128 single-bit ID changes left the address as it was", bad);
        CHECK(name_same <= 1u, "%u of 128 single-bit ID changes kept the name", name_same);
    }

    /* fallback: no ID, all FF, all 00, any 16 equal octets -> the fixed address, name 0000 */
    {
        static const uint8_t fixed[6] = FM1C_BLE_ADDR_FIXED_INIT;
        static const uint8_t fills[4] = {0xFF, 0x00, 0x5A, 0x46};
        CHECK(fm1c_ble_addr_make(0, a) == FM1C_BLE_ADDR_FIXED && !memcmp(a, fixed, 6), "no ID: not the fixed address");
        for (k = 0; k < 4u; k++) {
            memset(u, fills[k], 16);
            memset(b, 0xAA, 6);
            CHECK(fm1c_ble_addr_make(u, b) == FM1C_BLE_ADDR_FIXED && !memcmp(b, fixed, 6),
                  "ID of 16 x %02X: not the fixed address", fills[k]);
        }
        memset(u, 0xFF, 16);
        u[15] = 0xFE;                               /* one octet differs: an ID */
        CHECK(fm1c_ble_addr_make(u, a) == FM1C_BLE_ADDR_UID, "15 x FF + FE: taken as no ID");
        CHECK(valid_static(fixed), "the fixed address is not a valid static random one");
        fmt(fixed, s);
        fm1c_ble_name_hex(fixed, n);
        printf("fallback -> %s, name \"FM1 CONSOLE %s\"\n", s, n);
        CHECK(!strcmp(s, "C6:46:31:43:00:00") && !strcmp(n, "0000"), "fallback: %s \"%s\"", s, n);
    }

    /* the name: a[1] then a[0], upper-case hex (firmware/ble/ble_host.c gap_name) */
    {
        static const uint8_t t[6] = {0xB2, 0xA1, 0, 0, 0, 0xC0};
        fm1c_ble_name_hex(t, n);
        CHECK(!strcmp(n, "A1B2"), "name hex of ..:A1:B2: %s", n);
    }

    /* domain separation: never fm1-base's address for the same ID */
    bad = 0;
    for (k = 0; k < 10000u; k++) {
        rnd_uid(u);
        fm1c_ble_addr_make(u, a);
        fm1base_addr(u, b);
        if (!memcmp(a, b, 6)) bad++;
    }
    CHECK(bad == 0, "%u of 10000 IDs: the same address as fm1-base's", bad);
    T_DONE("fm1c_ble_addr");
}
