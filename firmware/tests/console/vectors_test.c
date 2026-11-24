/* SPDX-License-Identifier: GPL-3.0-only */
/* The C codec (firmware/src/fm1c_proto.h, fm1c_frame.h) against the TypeScript reference's shared vectors
 * (fixtures/device/vectors.json via gen_vectors.py): every valid frame decodes to the same message, encodes to
 * the same bytes and frames to the same MIDI; every invalid frame fails with the same error. */
#include "t.h"
#include "fm1c_frame.h"

typedef struct {
    const char *name;
    int dir;                                    /* 1 device -> host, 2 host -> device */
    uint8_t seq;
    const uint8_t *payload;
    uint32_t n;
    const uint8_t (*midi)[3];
    uint32_t nmidi;
    fm1c_msg expect, source;
    int encodable;
} vec_valid;
typedef struct {
    const char *name;
    const uint8_t *payload;
    uint32_t n, from;                           /* from: the decoder's expected sender (FM1C_FROM_*) */
    int error;
} vec_invalid;
typedef struct {
    const char *name;
    uint32_t dmin, dmax, hmin, hmax, proto;     /* the device's and the host's ranges; the version agreed */
} vec_neg;
#include "vectors.h"

static void dump(const char *what, const void *p, uint32_t n)
{
    const uint8_t *b = p;
    uint32_t i;
    printf("  %s:", what);
    for (i = 0; i < n; i++) printf(" %02x", b[i]);
    printf("\n");
}

static uint32_t fm1c_len_(const char *s) { uint32_t n = 0; while (s[n]) n++; return n; }

static void valid_case(const vec_valid *v)
{
    fm1c_msg m;
    uint8_t out[FM1C_MAX_FRAME];
    uint16_t ccs[FM1C_MAX_FRAME + 2];
    uint32_t n, k, i, ctl = v->dir == 1 ? FM1C_CC_DEV_CTL : FM1C_CC_HOST_CTL, data = ctl + 1u;
    int rc = fm1c_decode(v->payload, v->n, FM1C_FROM_ANY, &m);
    fm1c_asm a;
    int32_t got = -1;

    CHECK(rc == FM1C_OK, "%s: decode -> %d", v->name, rc);
    CHECK(!memcmp(&m, &v->expect, sizeof m), "%s: decoded message differs", v->name);
    if (memcmp(&m, &v->expect, sizeof m)) { dump("got   ", &m, sizeof m); dump("expect", &v->expect, sizeof m); }
    rc = fm1c_decode(v->payload, v->n, (uint32_t)v->dir, &m);
    CHECK(rc == FM1C_OK, "%s: decode from its own side -> %d", v->name, rc);
    rc = fm1c_decode(v->payload, v->n, (uint32_t)(3 - v->dir), &m);
    CHECK(rc == FM1C_E_UNKNOWN_TYPE && m.seq == v->seq, "%s: from the other side -> %d (want unknown_type)", v->name, rc);

    n = fm1c_encode(&v->expect, v->seq, out);
    CHECK(n == v->n && !memcmp(out, v->payload, n), "%s: encode differs (%u bytes)", v->name, n);
    if (v->encodable) {
        n = fm1c_encode(&v->source, v->seq, out);
        CHECK(n == v->n && !memcmp(out, v->payload, n), "%s: encode of the unsanitised message differs", v->name);
    }

    k = fm1c_frame_ccs(v->payload, v->n, ctl, data, ccs);
    CHECK(k == v->nmidi, "%s: %u CCs, want %u", v->name, k, v->nmidi);
    for (i = 0; i < k && i < v->nmidi; i++)
        CHECK(v->midi[i][0] == FM1C_CC_STATUS && v->midi[i][1] == ccs[i] >> 8 && v->midi[i][2] == (ccs[i] & 0x7Fu),
              "%s: CC %u differs", v->name, i);

    fm1c_asm_init(&a, ctl, data);               /* the vector's MIDI with noise between: the same payload */
    fm1c_asm_push(&a, 0x90, 60, 100);
    fm1c_asm_push(&a, FM1C_CC_STATUS, data, 5);   /* a stray byte outside a frame */
    for (i = 0; i < v->nmidi; i++) {
        int32_t r;
        fm1c_asm_push(&a, 0xBE, data, 9);       /* channel 15: not ours */
        fm1c_asm_push(&a, FM1C_CC_STATUS, ctl == FM1C_CC_DEV_CTL ? FM1C_CC_HOST_DATA : FM1C_CC_DEV_DATA, 9);
        r = fm1c_asm_push(&a, v->midi[i][0], v->midi[i][1], v->midi[i][2]);
        if (r >= 0) got = r;
    }
    CHECK(got == (int32_t)v->n && !memcmp(a.buf, v->payload, v->n), "%s: assembler -> %d bytes", v->name, got);
    CHECK(a.stray == 1, "%s: stray count %u", v->name, a.stray);
}

static void assembler_edges(void)
{
    fm1c_asm a;
    uint32_t i;
    fm1c_asm_init(&a, FM1C_CC_HOST_CTL, FM1C_CC_HOST_DATA);
    fm1c_asm_push(&a, 0xBF, 118, 1);
    fm1c_asm_push(&a, 0xBF, 119, 7);
    fm1c_asm_push(&a, 0xBF, 118, 1);            /* START again: the open frame is gone */
    fm1c_asm_push(&a, 0xBF, 119, 75);
    CHECK(fm1c_asm_push(&a, 0xBF, 118, 2) == 1 && a.buf[0] == 75 && a.restarted == 1, "restart discards the open frame");
    fm1c_asm_push(&a, 0xBF, 118, 1);
    fm1c_asm_push(&a, 0xBF, 119, 3);
    fm1c_asm_push(&a, 0xBF, 118, 3);            /* ABORT */
    CHECK(fm1c_asm_push(&a, 0xBF, 118, 2) == -1 && a.aborted == 1, "abort drops the frame, END after it is nothing");
    fm1c_asm_push(&a, 0xBF, 118, 1);
    for (i = 0; i < FM1C_MAX_FRAME + 5u; i++) fm1c_asm_push(&a, 0xBF, 119, 1);
    CHECK(fm1c_asm_push(&a, 0xBF, 118, 2) == -1 && a.overflowed == 1, "a frame over 104 bytes is dropped");
    fm1c_asm_push(&a, 0xBF, 118, 1);
    for (i = 0; i < FM1C_MAX_FRAME; i++) fm1c_asm_push(&a, 0xBF, 119, 1);
    CHECK(fm1c_asm_push(&a, 0xBF, 118, 2) == (int32_t)FM1C_MAX_FRAME, "104 bytes still assemble");
    fm1c_asm_push(&a, 0xBF, 118, 1);
    CHECK(fm1c_asm_push(&a, 0xBF, 118, 2) == 0, "an empty frame completes with 0 bytes");
}

/* version 5 (docs/ui-v3.md section 8.6): the optional trailing fields, decoded in every version, both body forms
 * round trip byte for byte (the shared vectors cover them too once vectors.json has them) */
static uint32_t frame_of(uint32_t type, const uint8_t *body, uint32_t n, uint8_t *out)
{
    uint32_t i;
    out[0] = (uint8_t)type;
    out[1] = 5;
    out[2] = (uint8_t)n;
    for (i = 0; i < n; i++) out[3u + i] = body[i];
    out[3u + n] = fm1c_checksum(out, n);
    return n + 4u;
}
static int v5_decode(uint32_t type, const uint8_t *body, uint32_t n, fm1c_msg *m)
{
    uint8_t f[FM1C_MAX_FRAME], g[FM1C_MAX_FRAME];
    uint32_t len = frame_of(type, body, n, f), k;
    int rc = fm1c_decode(f, len, FM1C_FROM_HOST, m);
    if (rc == FM1C_OK) {
        k = fm1c_encode(m, 5, g);
        CHECK(k == len && !memcmp(f, g, len), "v5 type 0x%02x: re-encodes byte for byte", type);
    }
    return rc;
}
static void version5_forms(void)
{
    fm1c_msg m;
    static const uint8_t VIEW4[] = {0, 0, 1, 2, 'H', 'i'}, VIEW_LIST[] = {0, 0, 1, 2, 'H', 'i', 1},
                         VIEW_BUDDY[] = {2, 0, 1, 0, 0}, VIEW_L2[] = {0, 0, 1, 0, 2}, VIEW_L3[] = {0, 0, 1, 0, 3},
                         VIEW_EXTRA[] = {0, 0, 1, 0, 1, 0, 0};   /* (version 6: one byte after the layout is the keys byte) */
    static const uint8_t SLOT4[] = {3, 6, 9, 2, 'V', 't'},
                         SLOT5[] = {3, 6, 9, 2, 'V', 't', 5, 'V', 'o', 'i', 'c', 'e', 2, '2', 'm'},
                         SLOT5_EMPTY[] = {3, 6, 9, 0, 0, 0},
                         SLOT_NO_AGE[] = {3, 6, 9, 0, 1, 'x'},
                         SLOT_AGE4[] = {3, 6, 9, 0, 0, 4, '1', '2', '3', 'm'},
                         SLOT_EXTRA[] = {3, 6, 9, 0, 0, 0, 0, 0},
                         SLOT_CTRL[] = {3, 6, 9, 0, 1, 0x1F, 0};
    uint8_t title21[3 + 1 + 1 + 21 + 1] = {3, 6, 9, 0, 21}, max[3 + 13 + 21 + 4];
    uint32_t i, n = 0;
    CHECK(v5_decode(FM1C_T_SET_VIEW, VIEW4, sizeof VIEW4, &m) == FM1C_OK && !m.u.view.v5 && m.u.view.layout == 0,
          "SET_VIEW without the layout byte: buddy, the version 4 form");
    CHECK(v5_decode(FM1C_T_SET_VIEW, VIEW_LIST, sizeof VIEW_LIST, &m) == FM1C_OK && m.u.view.v5 && m.u.view.layout == 1 &&
          !strcmp(m.u.view.title, "Hi"), "SET_VIEW layout list");
    CHECK(v5_decode(FM1C_T_SET_VIEW, VIEW_BUDDY, sizeof VIEW_BUDDY, &m) == FM1C_OK && m.u.view.v5 && m.u.view.layout == 0 &&
          m.u.view.view == FM1C_VIEW_INBOX, "SET_VIEW inbox, layout byte 0");
    CHECK(v5_decode(FM1C_T_SET_VIEW, VIEW_L2, sizeof VIEW_L2, &m) == FM1C_OK && m.u.view.layout == 2, "SET_VIEW layout 2: grouped (section 9.5)");
    CHECK(v5_decode(FM1C_T_SET_VIEW, VIEW_L3, sizeof VIEW_L3, &m) == FM1C_E_BAD_BODY, "SET_VIEW layout 3: bad body");
    CHECK(v5_decode(FM1C_T_SET_VIEW, VIEW_EXTRA, sizeof VIEW_EXTRA, &m) == FM1C_E_BAD_BODY, "SET_VIEW two bytes after the layout (keys 0, then one more): bad body");
    CHECK(v5_decode(FM1C_T_SET_SLOT, SLOT4, sizeof SLOT4, &m) == FM1C_OK && !m.u.slot.v5 && !m.u.slot.title[0] && !m.u.slot.age[0],
          "SET_SLOT without title and age: the version 4 form");
    CHECK(v5_decode(FM1C_T_SET_SLOT, SLOT5, sizeof SLOT5, &m) == FM1C_OK && m.u.slot.v5 && !strcmp(m.u.slot.label, "Vt") &&
          !strcmp(m.u.slot.title, "Voice") && !strcmp(m.u.slot.age, "2m") && m.u.slot.flags == 9, "SET_SLOT with title and age");
    CHECK(v5_decode(FM1C_T_SET_SLOT, SLOT5_EMPTY, sizeof SLOT5_EMPTY, &m) == FM1C_OK && m.u.slot.v5, "SET_SLOT empty title and age");
    CHECK(v5_decode(FM1C_T_SET_SLOT, SLOT_NO_AGE, sizeof SLOT_NO_AGE, &m) == FM1C_E_BAD_BODY, "a title without an age: bad body");
    CHECK(v5_decode(FM1C_T_SET_SLOT, SLOT_AGE4, sizeof SLOT_AGE4, &m) == FM1C_E_BAD_BODY, "an age of 4: bad body");
    CHECK(v5_decode(FM1C_T_SET_SLOT, SLOT_EXTRA, sizeof SLOT_EXTRA, &m) == FM1C_E_BAD_BODY, "two bytes after the age (row 0, then one more): bad body");
    CHECK(v5_decode(FM1C_T_SET_SLOT, SLOT_CTRL, sizeof SLOT_CTRL, &m) == FM1C_E_BAD_BODY, "a control byte in the title: bad body");
    for (i = 0; i < 21u; i++) title21[5u + i] = 'a';
    title21[26] = 0;
    CHECK(v5_decode(FM1C_T_SET_SLOT, title21, sizeof title21, &m) == FM1C_E_BAD_BODY, "a title of 21: bad body");
    max[n++] = 26; max[n++] = 9; max[n++] = 15; max[n++] = 12;
    for (i = 0; i < 12u; i++) max[n++] = (uint8_t)('A' + i);
    max[n++] = 20;
    for (i = 0; i < 20u; i++) max[n++] = (uint8_t)('a' + i);
    max[n++] = 3; max[n++] = '4'; max[n++] = '7'; max[n++] = 'h';
    CHECK(n == 41u && v5_decode(FM1C_T_SET_SLOT, max, n, &m) == FM1C_OK && fm1c_len_(m.u.slot.title) == 20u &&
          !strcmp(m.u.slot.age, "47h"), "the largest SET_SLOT body: 41 bytes");
    {                                           /* the encoder truncates as the TS one does */
        uint8_t out[FM1C_MAX_FRAME];
        fm1c_zero(&m, sizeof m);
        m.type = FM1C_T_SET_SLOT;
        m.u.slot.key = 1;
        m.u.slot.v5 = 1;
        memcpy(m.u.slot.title, "12345678901234567890", 21);
        memcpy(m.u.slot.age, "abc", 4);
        CHECK(fm1c_encode(&m, 0, out) == 4u + 3u + 1u + 21u + 4u, "encode v5 SET_SLOT: 33 bytes");
    }
    {                                           /* section 9.5: the row byte and the head fields */
        static const uint8_t MEMBER[] = {3, 6, 9, 0, 0, 0, 1}, CHILD[] = {3, 6, 9, 0, 0, 0, 2},
                             HEAD[] = {3, 6, 9, 0, 0, 0, 5, 8, 1, 2, 'T', 'k', 1, '1'},
                             FOLD[] = {3, 2, 0, 0, 0, 0, 12, 2, 0, 0, 0},
                             IND3[] = {3, 6, 9, 0, 0, 0, 3}, BIT4[] = {3, 6, 9, 0, 0, 0, 16},
                             TASKNS[] = {3, 6, 9, 0, 0, 0, 8}, NOHEAD[] = {3, 6, 9, 0, 0, 0, 4},
                             HFLAG2[] = {3, 6, 9, 0, 0, 0, 4, 2, 2, 0, 0}, HEXTRA[] = {3, 6, 9, 0, 0, 0, 4, 2, 0, 0, 0, 0},
                             ROWNOAGE[] = {3, 6, 9, 0, 1, 'x', 1};
        uint8_t big[100], out[FM1C_MAX_FRAME];
        fm1c_msg e;
        CHECK(v5_decode(FM1C_T_SET_SLOT, MEMBER, sizeof MEMBER, &m) == FM1C_OK && m.u.slot.v5g && m.u.slot.row == 1, "row: indent 1");
        CHECK(v5_decode(FM1C_T_SET_SLOT, CHILD, sizeof CHILD, &m) == FM1C_OK && (m.u.slot.row & 3u) == 2u, "row: indent 2");
        CHECK(v5_decode(FM1C_T_SET_SLOT, HEAD, sizeof HEAD, &m) == FM1C_OK && m.u.slot.head_state == 8 && m.u.slot.head_flags == 1 &&
              !strcmp(m.u.slot.head_title, "Tk") && !strcmp(m.u.slot.head_count, "1"), "row start: the head fields");
        CHECK(v5_decode(FM1C_T_SET_SLOT, FOLD, sizeof FOLD, &m) == FM1C_OK && m.u.slot.row == 12 && !m.u.slot.head_title[0], "a folded task row");
        CHECK(v5_decode(FM1C_T_SET_SLOT, IND3, sizeof IND3, &m) == FM1C_E_BAD_BODY, "indent 3: bad body");
        CHECK(v5_decode(FM1C_T_SET_SLOT, BIT4, sizeof BIT4, &m) == FM1C_E_BAD_BODY, "row bit 4: bad body");
        CHECK(v5_decode(FM1C_T_SET_SLOT, TASKNS, sizeof TASKNS, &m) == FM1C_E_BAD_BODY, "task without start: bad body");
        CHECK(v5_decode(FM1C_T_SET_SLOT, NOHEAD, sizeof NOHEAD, &m) == FM1C_E_BAD_BODY, "start without the head: bad body");
        CHECK(v5_decode(FM1C_T_SET_SLOT, HFLAG2, sizeof HFLAG2, &m) == FM1C_E_BAD_BODY, "head flags 2: bad body");
        CHECK(v5_decode(FM1C_T_SET_SLOT, HEXTRA, sizeof HEXTRA, &m) == FM1C_E_BAD_BODY, "a byte after the head: bad body");
        CHECK(v5_decode(FM1C_T_SET_SLOT, ROWNOAGE, sizeof ROWNOAGE, &m) == FM1C_E_BAD_BODY, "a row byte without the age: bad body");
        n = 0;                                  /* the largest body: 77 bytes */
        big[n++] = 26; big[n++] = 5; big[n++] = 15; big[n++] = 12;
        for (i = 0; i < 12u; i++) big[n++] = 'L';
        big[n++] = 20;
        for (i = 0; i < 20u; i++) big[n++] = 'T';
        big[n++] = 3; big[n++] = '9'; big[n++] = '9'; big[n++] = 'w';
        big[n++] = 6; big[n++] = 5; big[n++] = 1; big[n++] = 20;
        for (i = 0; i < 20u; i++) big[n++] = 'H';
        big[n++] = 11;
        for (i = 0; i < 11u; i++) big[n++] = 'C';
        CHECK(n == 77u && v5_decode(FM1C_T_SET_SLOT, big, n, &m) == FM1C_OK && fm1c_len_(m.u.slot.head_count) == 11u,
              "the largest grouped SET_SLOT body: 77 bytes");
        fm1c_zero(&e, sizeof e);
        e.type = FM1C_T_SET_SLOT;
        e.u.slot.v5 = e.u.slot.v5g = 1;
        e.u.slot.row = 8;
        CHECK(fm1c_encode(&e, 0, out) == 0u, "encode: task without start refused");
    }
}

/* version 6 (docs/ui-v3.md section 10.6): the keys byte and the task page after the layout, view 6, flag bit 4; every
 * earlier body form still decodes; both directions round trip byte for byte */
static void version6_forms(void)
{
    fm1c_msg m;
    static const uint8_t RANKED[] = {0, 0, 1, 0, 1, 0}, SPLIT[] = {0, 1, 3, 0, 0, 1, 2, 3}, SPLIT_MAX[] = {0, 0, 1, 0, 2, 1, 126, 127},
                         SETTINGS6[] = {6, 0, 1, 0}, SETTINGS_T[] = {6, 2, 3, 0, 0, 1, 0, 1},
                         VIEW7[] = {7, 0, 1, 0}, KEYS2[] = {0, 0, 1, 0, 0, 2}, NO_PAGE[] = {0, 0, 1, 0, 0, 1},
                         NO_PAGES[] = {0, 0, 1, 0, 0, 1, 0}, PAGES0[] = {0, 0, 1, 0, 0, 1, 0, 0},
                         PAST[] = {0, 0, 1, 0, 0, 1, 3, 3}, RANKED_X[] = {0, 0, 1, 0, 0, 0, 0},
                         SPLIT_X[] = {0, 0, 1, 0, 0, 1, 0, 1, 0}, PAGE127[] = {0, 0, 1, 0, 0, 1, 127, 127};
    static const uint8_t CHOSEN4[] = {8, 5, 24, 3, 'F', 'V', '5'}, CHOSEN5[] = {8, 3, 16, 3, 'A', 'L', 'L', 3, 'A', 'l', 'l', 0},
                         MAXROW[] = {5, 4, 30, 3, 'Y', 'O', 'U', 0, 0, 0}, SELCH[] = {8, 5, 17, 0}, F32[] = {8, 5, 32, 0},
                         F31SEL[] = {8, 5, 31, 0};
    CHECK(v5_decode(FM1C_T_SET_VIEW, RANKED, sizeof RANKED, &m) == FM1C_OK && m.u.view.v6 && m.u.view.keys == 0 && m.u.view.layout == 1,
          "SET_VIEW keys 0 after the layout: ranked");
    CHECK(v5_decode(FM1C_T_SET_VIEW, SPLIT, sizeof SPLIT, &m) == FM1C_OK && m.u.view.keys == 1 && m.u.view.task_page == 2 &&
          m.u.view.task_pages == 3 && m.u.view.page == 1 && m.u.view.pages == 3, "SET_VIEW split: task page 2 of 3");
    CHECK(v5_decode(FM1C_T_SET_VIEW, SPLIT_MAX, sizeof SPLIT_MAX, &m) == FM1C_OK && m.u.view.task_page == 126 && m.u.view.task_pages == 127,
          "SET_VIEW split: task page 126 of 127");
    CHECK(v5_decode(FM1C_T_SET_VIEW, SETTINGS6, sizeof SETTINGS6, &m) == FM1C_OK && m.u.view.view == FM1C_VIEW_SETTINGS && !m.u.view.v5,
          "SET_VIEW view 6 in the version 1-4 body form");
    CHECK(v5_decode(FM1C_T_SET_VIEW, SETTINGS_T, sizeof SETTINGS_T, &m) == FM1C_OK && m.u.view.view == FM1C_VIEW_SETTINGS && m.u.view.keys == 1,
          "SET_VIEW view 6 with the version 6 tail (cursor 2 of 3)");
    CHECK(v5_decode(FM1C_T_SET_VIEW, VIEW7, sizeof VIEW7, &m) == FM1C_E_BAD_BODY, "view 7: bad body");
    CHECK(v5_decode(FM1C_T_SET_VIEW, KEYS2, sizeof KEYS2, &m) == FM1C_E_BAD_BODY, "keys 2: bad body");
    CHECK(v5_decode(FM1C_T_SET_VIEW, NO_PAGE, sizeof NO_PAGE, &m) == FM1C_E_BAD_BODY, "keys 1 without the task page: bad body");
    CHECK(v5_decode(FM1C_T_SET_VIEW, NO_PAGES, sizeof NO_PAGES, &m) == FM1C_E_BAD_BODY, "keys 1 without the task page count: bad body");
    CHECK(v5_decode(FM1C_T_SET_VIEW, PAGES0, sizeof PAGES0, &m) == FM1C_E_BAD_BODY, "task_pages 0: bad body");
    CHECK(v5_decode(FM1C_T_SET_VIEW, PAST, sizeof PAST, &m) == FM1C_E_BAD_BODY, "task_page = task_pages: bad body");
    CHECK(v5_decode(FM1C_T_SET_VIEW, PAGE127, sizeof PAGE127, &m) == FM1C_E_BAD_BODY, "task_page 127: bad body");
    CHECK(v5_decode(FM1C_T_SET_VIEW, RANKED_X, sizeof RANKED_X, &m) == FM1C_E_BAD_BODY, "a byte after keys 0: bad body");
    CHECK(v5_decode(FM1C_T_SET_VIEW, SPLIT_X, sizeof SPLIT_X, &m) == FM1C_E_BAD_BODY, "a byte after task_pages: bad body");
    CHECK(v5_decode(FM1C_T_SET_SLOT, CHOSEN4, sizeof CHOSEN4, &m) == FM1C_OK && m.u.slot.flags == 24 && !m.u.slot.v5,
          "SET_SLOT chosen + pinned on a version 1-4 body");
    CHECK(v5_decode(FM1C_T_SET_SLOT, CHOSEN5, sizeof CHOSEN5, &m) == FM1C_OK && (m.u.slot.flags & FM1C_F_CHOSEN) && !strcmp(m.u.slot.label, "ALL") &&
          !strcmp(m.u.slot.title, "All") && !m.u.slot.age[0], "SET_SLOT chosen filter, version 5 body");
    CHECK(v5_decode(FM1C_T_SET_SLOT, MAXROW, sizeof MAXROW, &m) == FM1C_OK && m.u.slot.flags == 30 && m.u.slot.v5g,
          "SET_SLOT flags 30 with a grouped row byte");
    CHECK(v5_decode(FM1C_T_SET_SLOT, SELCH, sizeof SELCH, &m) == FM1C_E_BAD_BODY, "selected and chosen: bad body");
    CHECK(v5_decode(FM1C_T_SET_SLOT, F31SEL, sizeof F31SEL, &m) == FM1C_E_BAD_BODY, "flags 31 (selected and chosen): bad body");
    CHECK(v5_decode(FM1C_T_SET_SLOT, F32, sizeof F32, &m) == FM1C_E_BAD_BODY, "flags 32: bad body");
    {                                           /* the encoder refuses what the decoder refuses */
        uint8_t out[FM1C_MAX_FRAME];
        fm1c_zero(&m, sizeof m);
        m.type = FM1C_T_SET_VIEW;
        m.u.view.v6 = 1;
        m.u.view.keys = 1;
        m.u.view.task_page = 1;
        m.u.view.task_pages = 1;
        CHECK(fm1c_encode(&m, 0, out) == 0u, "encode: task_page >= task_pages refused");
        m.u.view.task_page = 0;
        CHECK(fm1c_encode(&m, 0, out) == 4u + 8u, "encode: split with the layout byte first (8 bytes)");
        fm1c_zero(&m, sizeof m);
        m.type = FM1C_T_SET_SLOT;
        m.u.slot.flags = FM1C_F_CHOSEN | FM1C_F_SELECTED;
        CHECK(fm1c_encode(&m, 0, out) == 0u, "encode: selected and chosen refused");
    }
}

/* version 7 (docs/ui-v3.md section 13.5): SET_TEXT rows with control bytes 0x01-0x04; the decoder's limits are the
 * TypeScript reader's (fields.ts textRow), the encoder sanitises as rich-text.ts sanitizeTextRow */
static void version7_forms(void)
{
    fm1c_msg m, e;
    uint8_t body[FM1C_MAX_BODY], f[FM1C_MAX_FRAME], out[FM1C_MAX_FRAME];
    uint32_t n, i, len;
    static const uint8_t RULE[] = {0, 1, 0, 5, 'a', 4, 'b', 1, 'c'}, DEL[] = {0, 1, 0, 2, 'a', 0x7F}, HIGH[] = {0, 1, 0, 1, 0x7F};
    CHECK(v5_decode(FM1C_T_SET_TEXT, RULE, sizeof RULE, &m) == FM1C_OK && !strcmp(m.u.text.text[0], "a\004b\001c"),
          "a rule and an open bold span: decoded as sent, re-encoded byte for byte");
    CHECK(v5_decode(FM1C_T_SET_TEXT, DEL, sizeof DEL, &m) == FM1C_E_BAD_BODY && v5_decode(FM1C_T_SET_TEXT, HIGH, sizeof HIGH, &m) == FM1C_E_BAD_BODY,
          "0x7F: bad body");
    n = 0;                                      /* 29 visible + 8 style bytes: 37, the largest row */
    body[n++] = 0; body[n++] = 1; body[n++] = 1; body[n++] = 37;
    for (i = 0; i < 8u; i++) body[n++] = (uint8_t)((i & 1u) ? 3u : 1u + ((i >> 1) & 1u));
    for (i = 0; i < 28u; i++) body[n++] = 'x';
    body[n++] = 4;
    CHECK(v5_decode(FM1C_T_SET_TEXT, body, n, &m) == FM1C_OK && fm1c_len_(m.u.text.text[0]) == 37u, "a 37-byte row (29 visible, 8 marks)");
    body[3] = 38; body[n++] = 3;
    CHECK(v5_decode(FM1C_T_SET_TEXT, body, n, &m) == FM1C_E_BAD_BODY, "38 bytes: bad body");
    n = 0;                                      /* 10 style bytes and 20 visible (30 bytes): the reader accepts it */
    body[n++] = 0; body[n++] = 1; body[n++] = 0; body[n++] = 30;
    for (i = 0; i < 10u; i++) body[n++] = (uint8_t)(i & 1u ? 3 : 1);
    for (i = 0; i < 20u; i++) body[n++] = 'y';
    len = frame_of(FM1C_T_SET_TEXT, body, n, f);
    CHECK(fm1c_decode(f, len, FM1C_FROM_HOST, &m) == FM1C_OK && fm1c_len_(m.u.text.text[0]) == 30u,
          "10 style bytes within 37: decoded (as the TypeScript reader)");
    CHECK(fm1c_encode(&m, 0, out) == 4u + 4u + 28u && out[3 + 3] == 28u, "the encoder keeps 8 of them (28 bytes)");
    fm1c_zero(&e, sizeof e);                    /* the sender: '?' for other bytes, cut after 29 visible, marks after it dropped */
    e.type = FM1C_T_SET_TEXT;
    e.u.text.count = 1;
    for (i = 0; i < 30u; i++) e.u.text.text[0][i] = i == 0 ? '\a' : 'z';
    e.u.text.text[0][30] = 1;
    n = fm1c_encode(&e, 0, out);
    CHECK(n == 4u + 4u + 29u && out[6] == 29u && out[7] == '?' && out[8 + 27] == 'z', "encode: 0x07 -> ?, cut at 29 visible");
}

int main(void)
{
    uint32_t i;
    fm1c_msg m;
    for (i = 0; i < sizeof VALID / sizeof VALID[0]; i++) valid_case(&VALID[i]);
    for (i = 0; i < sizeof INVALID / sizeof INVALID[0]; i++) {
        const vec_invalid *v = &INVALID[i];
        int rc = fm1c_decode(v->payload, v->n, v->from, &m);
        CHECK(rc == v->error, "%s: decode -> %d, want %d", v->name, rc, v->error);
    }
    assembler_edges();
    /* negotiation (docs/ux-v2.md section 4): the host picks the highest common version; this firmware's range is
     * the "device" of the cases that name 1..2, and it must accept the version they agree on (fm1c_link.h's test) */
    for (i = 0; i < N_NEGOTIATION; i++) {
        const vec_neg *v = &NEGOTIATION[i];
        uint32_t lo = v->dmin > v->hmin ? v->dmin : v->hmin, hi = v->dmax < v->hmax ? v->dmax : v->hmax;
        CHECK((lo <= hi ? hi : 0u) == v->proto, "%s: highest common version %u, want %u", v->name, lo <= hi ? hi : 0u, v->proto);
        if (v->dmin == FM1C_PROTO_MIN && v->dmax == FM1C_PROTO_MAX)
            CHECK(v->proto >= FM1C_PROTO_MIN && v->proto <= FM1C_PROTO_MAX, "%s: this firmware accepts version %u", v->name, v->proto);
    }
    CHECK(N_NEGOTIATION == 0 || (FM1C_PROTO_MIN == 1u && FM1C_PROTO_MAX == 7u), "the firmware speaks 1..7");
    version5_forms();
    version6_forms();
    version7_forms();
    printf("vectors: %u valid, %u invalid, %u negotiation\n", (unsigned)(sizeof VALID / sizeof VALID[0]),
           (unsigned)(sizeof INVALID / sizeof INVALID[0]), (unsigned)N_NEGOTIATION);
    T_DONE("vectors_test");
}
