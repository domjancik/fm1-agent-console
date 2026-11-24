/* SPDX-License-Identifier: GPL-3.0-only */
/* FM1C protocol, versions 1-7 (docs/protocol.md; version 4 changes no frame, versions 5 and 6 add optional trailing fields,
 * version 7 control bytes in SET_TEXT rows): constants, the message struct,
 * checksum, encode and decode. Pure C on <stdint.h> only, so the host tests include it on its own (tests/console/).
 * The TypeScript codec in packages/device-protocol is the reference; tests/console/vectors_test.c checks this file
 * against its vectors. */
#pragma once
#include <stdint.h>

#define FM1C_PROTO_MIN 1u
#define FM1C_PROTO_MAX 7u                       /* 2: a rendering marker (docs/ux-v2.md section 4); 3: + SET_TEXT, view 5 (section 7);
                                                 * 4: a rendering marker again, the characters (docs/ui-v3.md section 5);
                                                 * 5: + SET_VIEW.layout, SET_SLOT.title / age, the LIST layout (section 8);
                                                 *    + layout 2 and SET_SLOT row / head, the GROUPED list (section 9);
                                                 * 6: + SET_VIEW.keys / task page, view 6 settings, SET_SLOT flag bit 4 chosen
                                                 *    (docs/ui-v3.md section 10: SPLIT keys and the SETTINGS view);
                                                 * 7: + SET_TEXT control bytes 0x01-0x04, inline highlights and table
                                                 *    rules (docs/ui-v3.md section 13.5) */
#define FM1C_PROTO_V4 4u
#define FM1C_PROTO_V5 5u
#define FM1C_PROTO_V6 6u
#define FM1C_PROTO_V7 7u
#define FM1C_CC_STATUS 0xBFu                    /* control change, MIDI channel 16 */
#define FM1C_CC_HOST_CTL 118u
#define FM1C_CC_HOST_DATA 119u
#define FM1C_CC_DEV_CTL 116u
#define FM1C_CC_DEV_DATA 117u
#define FM1C_CTL_START 1u
#define FM1C_CTL_END 2u
#define FM1C_CTL_ABORT 3u
#define FM1C_MAX_BODY 100u
#define FM1C_OVERHEAD 4u                        /* TYPE SEQ LEN CK */
#define FM1C_MAX_FRAME (FM1C_MAX_BODY + FM1C_OVERHEAD)
#define FM1C_CK_XOR 0x2Au
#define FM1C_NSLOT 27u
#define FM1C_NO_REQ 127u

enum {
    FM1C_T_HELLO = 0x01, FM1C_T_BUTTON = 0x02, FM1C_T_KEY = 0x03, FM1C_T_ENCODER = 0x04, FM1C_T_POT = 0x05,
    FM1C_T_DEV_HB = 0x06, FM1C_T_DEV_ACK = 0x07,
    FM1C_T_HELLO_ACK = 0x41, FM1C_T_SET_VIEW = 0x42, FM1C_T_SET_SLOT = 0x43, FM1C_T_SET_DETAIL = 0x44,
    FM1C_T_SET_VOICE = 0x45, FM1C_T_SET_LEGEND = 0x46, FM1C_T_SET_STATUS = 0x47, FM1C_T_CMD_RESULT = 0x48,
    FM1C_T_HOST_HB = 0x49, FM1C_T_HOST_ACK = 0x4A, FM1C_T_CLEAR_SLOTS = 0x4B, FM1C_T_SET_TEXT = 0x4C
};

/* enum sizes; every enum starts at 0 except the gesture (1..5) */
#define FM1C_N_BUTTON 14u
#define FM1C_N_EDGE 2u
#define FM1C_N_ENCODER 7u
#define FM1C_N_POT 1u
#define FM1C_N_ACK 4u
#define FM1C_N_VIEW 7u
#define FM1C_N_STATE 10u
#define FM1C_N_PROVIDER 4u
#define FM1C_N_VOICE 9u
#define FM1C_N_LINK 3u
#define FM1C_N_RESULT 7u
#define FM1C_N_STYLE 3u

enum { FM1C_G_SINGLE = 1, FM1C_G_DOUBLE = 2, FM1C_G_LONG = 3, FM1C_G_DOWN = 4, FM1C_G_UP = 5 };
enum { FM1C_ACK_OK = 0, FM1C_ACK_UNKNOWN_TYPE = 1, FM1C_ACK_BAD_BODY = 2, FM1C_ACK_BUSY = 3 };
enum {
    FM1C_VIEW_SESSIONS = 0, FM1C_VIEW_TASKS = 1, FM1C_VIEW_INBOX = 2, FM1C_VIEW_VOICE = 3, FM1C_VIEW_CONFIRM = 4,
    FM1C_VIEW_DETAIL = 5,                       /* version 3: the DETAILS page (docs/ux-v2.md section 7.4) */
    FM1C_VIEW_SETTINGS = 6                      /* version 6: the SETTINGS list (docs/ui-v3.md section 10.2) */
};
enum { FM1C_TS_BODY = 0, FM1C_TS_HEADING = 1, FM1C_TS_MUTED = 2 };   /* SET_TEXT row styles */
enum {
    FM1C_S_EMPTY = 0, FM1C_S_DISCONNECTED, FM1C_S_IDLE, FM1C_S_WORKING, FM1C_S_WAITING_INPUT,
    FM1C_S_APPROVAL, FM1C_S_DONE_UNREAD, FM1C_S_DONE_READ, FM1C_S_FAILED, FM1C_S_UNKNOWN
};
enum {
    FM1C_V_READY = 0, FM1C_V_RECORDING, FM1C_V_TRANSCRIBING, FM1C_V_REVIEWING, FM1C_V_SUBMITTING,
    FM1C_V_DELIVERED, FM1C_V_CANCELLED, FM1C_V_FAILED, FM1C_V_NO_TARGET
};
enum { FM1C_LINK_OK = 0, FM1C_LINK_DEGRADED = 1, FM1C_LINK_DOWN = 2 };
enum {
    FM1C_R_ACCEPTED = 0, FM1C_R_SENT, FM1C_R_ACKED, FM1C_R_COMPLETED, FM1C_R_FAILED, FM1C_R_UNSUPPORTED,
    FM1C_R_UNAVAILABLE
};
#define FM1C_F_SELECTED 1u
#define FM1C_F_CODEX 2u
#define FM1C_F_STALE 4u
#define FM1C_F_PINNED 8u
#define FM1C_F_CHOSEN 16u                       /* version 6: the chosen filter / task key of the SPLIT black row; never with
                                                 * FM1C_F_SELECTED (docs/ui-v3.md section 10.6) */
#define FM1C_FLAGS_MAX 31u

/* string maxima (characters; the struct fields hold one more for the NUL) */
#define FM1C_L_REASON 24u
#define FM1C_L_TITLE 20u
#define FM1C_L_LABEL 12u
#define FM1C_L_LINE 20u
#define FM1C_L_LEGEND 6u
#define FM1C_L_TEXT 29u                         /* SET_TEXT: visible characters of a row (printable ASCII and 0x04) */
#define FM1C_TEXT_MARKS 8u                      /* version 7: style bytes (0x01-0x03) a sender keeps per row */
#define FM1C_L_TEXT_WIRE 37u                    /* version 7: bytes of a row on the wire (29 visible + 8 style bytes) */
#define FM1C_TM_BOLD 1u                         /* version 7 SET_TEXT control bytes (docs/ui-v3.md section 13.5): */
#define FM1C_TM_CODE 2u                         /*   bold on, code on (no column), */
#define FM1C_TM_OFF 3u                          /*   back to the row colour (no column), */
#define FM1C_TM_RULE 4u                         /*   a column rule (one 8 px cell) */
#define FM1C_L_ROW 20u                          /* version 5: SET_SLOT.title, the list row's title */
#define FM1C_L_AGE 3u                           /* version 5: SET_SLOT.age */
#define FM1C_LAYOUT_BUDDY 0u                    /* version 5: SET_VIEW.layout */
#define FM1C_LAYOUT_LIST 1u
#define FM1C_LAYOUT_GROUPED 2u                  /* version 5 (docs/ui-v3.md section 9.5): Sessions grouped by task */
#define FM1C_L_HEAD 20u                         /* version 5 grouped: SET_SLOT.head_title */
#define FM1C_L_COUNT 11u                        /* version 5 grouped: SET_SLOT.head_count */
#define FM1C_ROW_INDENT 3u                      /* SET_SLOT.row: bits 0-1 the indent (0-2) */
#define FM1C_ROW_START 4u                       /*   bit 2: a header row before this key's row (the head fields follow) */
#define FM1C_ROW_TASK 8u                        /*   bit 3: a folded task row (needs bit 2) */
#define FM1C_HEAD_PINNED 1u                     /* SET_SLOT.head_flags bit 0 */
#define FM1C_KEYS_RANKED 0u                     /* version 6: SET_VIEW.keys (docs/ui-v3.md section 10.6) */
#define FM1C_KEYS_SPLIT 1u
#define FM1C_TEXT_ROWS 12u                      /* SET_TEXT: rows in the DETAILS buffer */
#define FM1C_TEXT_PER_FRAME 3u                  /* SET_TEXT: rows in one frame */

typedef struct {
    uint8_t type, seq, ck;
    union {
        struct { uint8_t pmin, pmax, fw_major, fw_minor, fw_patch; uint16_t boot_id; } hello;
        struct { uint8_t button, edge; } button;
        struct { uint8_t key, gesture; } key;
        struct { uint8_t encoder; int8_t delta; } enc;
        struct { uint8_t pot; uint16_t value; } pot;
        struct { uint16_t uptime_s; uint8_t rx_errors; } dhb;
        struct { uint8_t seq, status; } ack;              /* device ACK and host ACK */
        struct { uint8_t proto; uint16_t session; char reason[FM1C_L_REASON + 1]; } hello_ack;
        struct { uint8_t view, page, pages; char title[FM1C_L_TITLE + 1]; uint8_t layout, v5;   /* v5: the layout byte came */
                 uint8_t keys, task_page, task_pages, v6; } view;   /* v6: the keys byte came (task page with keys 1) */
        struct { uint8_t key, state, flags; char label[FM1C_L_LABEL + 1]; char title[FM1C_L_ROW + 1], age[FM1C_L_AGE + 1]; uint8_t v5;
                 uint8_t row, head_state, head_flags; char head_title[FM1C_L_HEAD + 1], head_count[FM1C_L_COUNT + 1];
                 uint8_t v5g; } slot;           /* v5g: the grouped row byte came (docs/ui-v3.md section 9.5) */
        struct { uint8_t provider, state; char line[4][FM1C_L_LINE + 1]; } detail;
        struct { uint8_t voice, level; uint16_t elapsed_ds; char target[FM1C_L_LINE + 1]; } voice;
        struct { char label[4][FM1C_L_LEGEND + 1]; } legend;
        struct { uint8_t link, attention; char text[FM1C_L_LINE + 1]; } status;
        struct { uint8_t req_seq, result; char text[FM1C_L_LINE + 1]; } result;
        struct { uint16_t uptime_s; } hhb;
        struct { uint8_t row, count; uint8_t style[FM1C_TEXT_PER_FRAME]; char text[FM1C_TEXT_PER_FRAME][FM1C_L_TEXT_WIRE + 1]; } text;
    } u;
} fm1c_msg;

/* decode results, in the order the TypeScript codec reports them */
enum {
    FM1C_OK = 0, FM1C_E_BAD_LENGTH, FM1C_E_NOT_7BIT, FM1C_E_LEN_TOO_LARGE, FM1C_E_BAD_CHECKSUM,
    FM1C_E_UNKNOWN_TYPE, FM1C_E_BAD_BODY
};
enum { FM1C_FROM_ANY = 0, FM1C_FROM_DEVICE = 1, FM1C_FROM_HOST = 2 };

static void fm1c_zero(void *p, uint32_t n)
{
    uint8_t *d = p;
    while (n--) *d++ = 0;
}

static uint8_t fm1c_checksum(const uint8_t *frame, uint32_t body_len)   /* frame: TYPE SEQ LEN BODY... */
{
    uint32_t s = 0, i;
    for (i = 0; i < 3u + body_len; i++) s += frame[i];
    return (uint8_t)((s & 0x7Fu) ^ FM1C_CK_XOR);
}

static uint32_t fm1c_origin(uint32_t type)      /* FM1C_FROM_DEVICE / _HOST, 0 for an unknown type */
{
    if (type >= FM1C_T_HELLO && type <= FM1C_T_DEV_ACK) return FM1C_FROM_DEVICE;
    if (type >= FM1C_T_HELLO_ACK && type <= FM1C_T_SET_TEXT) return FM1C_FROM_HOST;
    return 0;
}

/* ---- body reader: sets err on the first field out of range */
typedef struct {
    const uint8_t *p;
    uint32_t n, pos;
    uint8_t err;
} fm1c_rd;

static uint32_t fm1c_next(fm1c_rd *r)
{
    if (r->pos >= r->n) { r->err = 1; return 0; }
    return r->p[r->pos++];
}
static uint8_t fm1c_u7(fm1c_rd *r, uint32_t lo, uint32_t hi)
{
    uint32_t v = fm1c_next(r);
    if (v < lo || v > hi) r->err = 1;
    return (uint8_t)v;
}
static uint16_t fm1c_u14(fm1c_rd *r, uint32_t hi)
{
    uint32_t v = fm1c_next(r) << 7;
    v |= fm1c_next(r);
    if (v > hi) r->err = 1;
    return (uint16_t)v;
}
static int8_t fm1c_s7(fm1c_rd *r) { return (int8_t)((int32_t)fm1c_next(r) - 64); }
static void fm1c_str(fm1c_rd *r, char *dst, uint32_t max)
{
    uint32_t len = fm1c_next(r), i;
    if (len > max) { r->err = 1; return; }
    for (i = 0; i < len; i++) {
        uint32_t c = fm1c_next(r);
        if (c < 0x20u || c > 0x7Eu) { r->err = 1; return; }
        dst[i] = (char)c;
    }
    dst[len] = 0;
}
/* a SET_TEXT row (version 7): <= 37 bytes, each printable ASCII or a control byte 0x01-0x04, <= 29 of them visible
 * (printable or 0x04). The decoder does not depend on the agreed version (docs/protocol.md section 3). */
static void fm1c_text_str(fm1c_rd *r, char *dst)
{
    uint32_t len = fm1c_next(r), i, vis = 0;
    if (len > FM1C_L_TEXT_WIRE) { r->err = 1; return; }
    for (i = 0; i < len; i++) {
        uint32_t c = fm1c_next(r);
        if (c >= 0x20u && c <= 0x7Eu) vis++;
        else if (c == FM1C_TM_RULE) vis++;
        else if (c < FM1C_TM_BOLD || c > FM1C_TM_OFF) { r->err = 1; return; }
        dst[i] = (char)c;
    }
    dst[len] = 0;
    if (vis > FM1C_L_TEXT) r->err = 1;
}

/* Decodes one frame payload into *m (zeroed first). from: FM1C_FROM_HOST on the device, so a device-only type
 * reads as unknown. For FM1C_E_UNKNOWN_TYPE and FM1C_E_BAD_BODY the frame is intact: m->type, seq, ck are set and
 * the receiver ACKs with status 1 or 2. */
static int fm1c_decode(const uint8_t *b, uint32_t n, uint32_t from, fm1c_msg *m)
{
    fm1c_rd r;
    uint32_t i, len, t;
    fm1c_zero(m, sizeof *m);
    if (n < FM1C_OVERHEAD) return FM1C_E_BAD_LENGTH;
    for (i = 0; i < n; i++)
        if (b[i] > 0x7Fu) return FM1C_E_NOT_7BIT;
    len = b[2];
    if (len > FM1C_MAX_BODY) return FM1C_E_LEN_TOO_LARGE;
    if (n != len + FM1C_OVERHEAD) return FM1C_E_BAD_LENGTH;
    if (b[n - 1u] != fm1c_checksum(b, len)) return FM1C_E_BAD_CHECKSUM;
    t = b[0];
    m->type = (uint8_t)t;
    m->seq = b[1];
    m->ck = b[n - 1u];
    if (!fm1c_origin(t)) return FM1C_E_UNKNOWN_TYPE;
    r.p = b + 3;
    r.n = len;
    r.pos = 0;
    r.err = 0;
    switch (t) {
    case FM1C_T_HELLO:
        m->u.hello.pmin = fm1c_u7(&r, 0, 127);
        m->u.hello.pmax = fm1c_u7(&r, 0, 127);
        m->u.hello.fw_major = fm1c_u7(&r, 0, 127);
        m->u.hello.fw_minor = fm1c_u7(&r, 0, 127);
        m->u.hello.fw_patch = fm1c_u7(&r, 0, 127);
        m->u.hello.boot_id = fm1c_u14(&r, 0x3FFFu);
        break;
    case FM1C_T_BUTTON:
        m->u.button.button = fm1c_u7(&r, 0, FM1C_N_BUTTON - 1u);
        m->u.button.edge = fm1c_u7(&r, 0, FM1C_N_EDGE - 1u);
        break;
    case FM1C_T_KEY:
        m->u.key.key = fm1c_u7(&r, 0, FM1C_NSLOT - 1u);
        m->u.key.gesture = fm1c_u7(&r, FM1C_G_SINGLE, FM1C_G_UP);
        break;
    case FM1C_T_ENCODER:
        m->u.enc.encoder = fm1c_u7(&r, 0, FM1C_N_ENCODER - 1u);
        m->u.enc.delta = fm1c_s7(&r);
        break;
    case FM1C_T_POT:
        m->u.pot.pot = fm1c_u7(&r, 0, FM1C_N_POT - 1u);
        m->u.pot.value = fm1c_u14(&r, 1023u);
        break;
    case FM1C_T_DEV_HB:
        m->u.dhb.uptime_s = fm1c_u14(&r, 0x3FFFu);
        m->u.dhb.rx_errors = fm1c_u7(&r, 0, 127);
        break;
    case FM1C_T_DEV_ACK:
    case FM1C_T_HOST_ACK:
        m->u.ack.seq = fm1c_u7(&r, 0, 127);
        m->u.ack.status = fm1c_u7(&r, 0, FM1C_N_ACK - 1u);
        break;
    case FM1C_T_HELLO_ACK:
        m->u.hello_ack.proto = fm1c_u7(&r, 0, 127);
        m->u.hello_ack.session = fm1c_u14(&r, 0x3FFFu);
        fm1c_str(&r, m->u.hello_ack.reason, FM1C_L_REASON);
        break;
    case FM1C_T_SET_VIEW:
        m->u.view.view = fm1c_u7(&r, 0, FM1C_N_VIEW - 1u);
        m->u.view.page = fm1c_u7(&r, 0, 127);
        m->u.view.pages = fm1c_u7(&r, 0, 127);
        fm1c_str(&r, m->u.view.title, FM1C_L_TITLE);
        if (!r.err && r.pos < r.n) {            /* version 5: the layout, optional */
            m->u.view.layout = fm1c_u7(&r, 0, FM1C_LAYOUT_GROUPED);
            m->u.view.v5 = 1;
        }
        if (!r.err && r.pos < r.n) {            /* version 6: the keys, optional; split: the task page and the count */
            m->u.view.keys = fm1c_u7(&r, 0, FM1C_KEYS_SPLIT);
            m->u.view.v6 = 1;
            if (!r.err && m->u.view.keys == FM1C_KEYS_SPLIT) {
                m->u.view.task_page = fm1c_u7(&r, 0, 126);
                m->u.view.task_pages = fm1c_u7(&r, 1, 127);
                if (m->u.view.task_page >= m->u.view.task_pages) r.err = 1;
            }
        }                                       /* (keys 0 then a byte, or a byte after task_pages: left over, bad body) */
        break;
    case FM1C_T_SET_SLOT:
        m->u.slot.key = fm1c_u7(&r, 0, FM1C_NSLOT - 1u);
        m->u.slot.state = fm1c_u7(&r, 0, FM1C_N_STATE - 1u);
        m->u.slot.flags = fm1c_u7(&r, 0, FM1C_FLAGS_MAX);   /* (version 6: bit 4 chosen, never with bit 0) */
        if ((m->u.slot.flags & FM1C_F_CHOSEN) && (m->u.slot.flags & FM1C_F_SELECTED)) r.err = 1;
        fm1c_str(&r, m->u.slot.label, FM1C_L_LABEL);
        if (!r.err && r.pos < r.n) {            /* version 5: the row's title and age, both or neither */
            fm1c_str(&r, m->u.slot.title, FM1C_L_ROW);
            if (!r.err) fm1c_str(&r, m->u.slot.age, FM1C_L_AGE);
            m->u.slot.v5 = 1;
        }
        if (!r.err && r.pos < r.n) {            /* version 5 grouped: the row byte, then with start the group's header */
            uint32_t row = fm1c_u7(&r, 0, 15);
            if ((row & FM1C_ROW_INDENT) == 3u || ((row & FM1C_ROW_TASK) && !(row & FM1C_ROW_START))) r.err = 1;
            m->u.slot.row = (uint8_t)row;
            m->u.slot.v5g = 1;
            if (!r.err && (row & FM1C_ROW_START)) {
                m->u.slot.head_state = fm1c_u7(&r, 0, FM1C_N_STATE - 1u);
                m->u.slot.head_flags = fm1c_u7(&r, 0, FM1C_HEAD_PINNED);
                if (!r.err) fm1c_str(&r, m->u.slot.head_title, FM1C_L_HEAD);
                if (!r.err) fm1c_str(&r, m->u.slot.head_count, FM1C_L_COUNT);
            }
        }
        break;
    case FM1C_T_SET_DETAIL:
        m->u.detail.provider = fm1c_u7(&r, 0, FM1C_N_PROVIDER - 1u);
        m->u.detail.state = fm1c_u7(&r, 0, FM1C_N_STATE - 1u);
        for (i = 0; i < 4u && !r.err; i++) fm1c_str(&r, m->u.detail.line[i], FM1C_L_LINE);
        break;
    case FM1C_T_SET_VOICE:
        m->u.voice.voice = fm1c_u7(&r, 0, FM1C_N_VOICE - 1u);
        m->u.voice.level = fm1c_u7(&r, 0, 100);
        m->u.voice.elapsed_ds = fm1c_u14(&r, 0x3FFFu);
        fm1c_str(&r, m->u.voice.target, FM1C_L_LINE);
        break;
    case FM1C_T_SET_LEGEND:
        for (i = 0; i < 4u && !r.err; i++) fm1c_str(&r, m->u.legend.label[i], FM1C_L_LEGEND);
        break;
    case FM1C_T_SET_STATUS:
        m->u.status.link = fm1c_u7(&r, 0, FM1C_N_LINK - 1u);
        m->u.status.attention = fm1c_u7(&r, 0, 127);
        fm1c_str(&r, m->u.status.text, FM1C_L_LINE);
        break;
    case FM1C_T_CMD_RESULT:
        m->u.result.req_seq = fm1c_u7(&r, 0, FM1C_NO_REQ);
        m->u.result.result = fm1c_u7(&r, 0, FM1C_N_RESULT - 1u);
        fm1c_str(&r, m->u.result.text, FM1C_L_LINE);
        break;
    case FM1C_T_HOST_HB:
        m->u.hhb.uptime_s = fm1c_u14(&r, 0x3FFFu);
        break;
    case FM1C_T_CLEAR_SLOTS:
        break;
    case FM1C_T_SET_TEXT:                       /* row 0..11, count 1..3 with row + count <= 12, then count rows */
        m->u.text.row = fm1c_u7(&r, 0, FM1C_TEXT_ROWS - 1u);
        if (r.err) break;
        m->u.text.count = fm1c_u7(&r, 1, FM1C_TEXT_ROWS - m->u.text.row < FM1C_TEXT_PER_FRAME
                                         ? FM1C_TEXT_ROWS - m->u.text.row : FM1C_TEXT_PER_FRAME);
        for (i = 0; i < m->u.text.count && !r.err; i++) {
            m->u.text.style[i] = fm1c_u7(&r, 0, FM1C_N_STYLE - 1u);
            fm1c_text_str(&r, m->u.text.text[i]);
        }
        break;
    }
    if (r.err || r.pos != r.n) return FM1C_E_BAD_BODY;
    if (from && fm1c_origin(t) != from) return FM1C_E_UNKNOWN_TYPE;   /* (after the body, as the TS codec) */
    return FM1C_OK;
}

/* ---- body writer: returns 0 when a field is out of range (a caller bug) */
typedef struct {
    uint8_t *p;
    uint32_t n;
    uint8_t err;
} fm1c_wr;

static void fm1c_put(fm1c_wr *w, uint32_t v, uint32_t lo, uint32_t hi)
{
    if (v < lo || v > hi || w->n >= FM1C_MAX_BODY) { w->err = 1; return; }
    w->p[3u + w->n++] = (uint8_t)v;
}
static void fm1c_put14(fm1c_wr *w, uint32_t v, uint32_t hi)
{
    if (v > hi) { w->err = 1; return; }
    fm1c_put(w, v >> 7, 0, 127);
    fm1c_put(w, v & 0x7Fu, 0, 127);
}
static void fm1c_puts(fm1c_wr *w, const char *s, uint32_t max)   /* sanitised: '?' for non-printable, truncated */
{
    uint32_t len = 0, i;
    while (len < max && s[len]) len++;
    fm1c_put(w, len, 0, 127);
    for (i = 0; i < len; i++) {
        uint32_t c = (uint8_t)s[i];
        fm1c_put(w, c >= 0x20u && c <= 0x7Eu ? c : '?', 0, 127);
    }
}

#ifndef FM1C_ENCODE_DEVICE_ONLY
/* a SET_TEXT row as the TypeScript sender puts it (rich-text.ts sanitizeTextRow): a byte outside printable ASCII and
 * 0x01-0x04 becomes '?'; cut after 29 visible characters; style bytes past the 8th (or after the 29th visible) dropped */
static void fm1c_puts_text(fm1c_wr *w, const char *s)
{
    char b[FM1C_L_TEXT_WIRE];
    uint32_t n = 0, vis = 0, marks = 0, i;
    for (i = 0; i <= FM1C_L_TEXT_WIRE && s[i]; i++) {
        uint32_t c = (uint8_t)s[i];
        if (c >= FM1C_TM_BOLD && c <= FM1C_TM_OFF) {
            if (vis >= FM1C_L_TEXT || marks >= FM1C_TEXT_MARKS) continue;
            marks++;
            b[n++] = (char)c;
            continue;
        }
        if (vis >= FM1C_L_TEXT) break;
        b[n++] = (char)((c >= 0x20u && c <= 0x7Eu) || c == FM1C_TM_RULE ? c : '?');
        vis++;
    }
    fm1c_put(w, n, 0, FM1C_L_TEXT_WIRE);
    for (i = 0; i < n; i++) fm1c_put(w, (uint8_t)b[i], 0, 127);
}
#endif

/* Encodes *m with seq into out (FM1C_MAX_FRAME bytes): the payload length, or 0 on an invalid field */
static uint32_t fm1c_encode(const fm1c_msg *m, uint32_t seq, uint8_t *out)
{
    fm1c_wr w;
    uint32_t i;
    (void)i;                                    /* (FM1C_ENCODE_DEVICE_ONLY: no loop left) */
    w.p = out;
    w.n = 0;
    w.err = seq > 127u;
    switch (m->type) {
    case FM1C_T_HELLO:
        fm1c_put(&w, m->u.hello.pmin, 0, 127);
        fm1c_put(&w, m->u.hello.pmax, 0, 127);
        fm1c_put(&w, m->u.hello.fw_major, 0, 127);
        fm1c_put(&w, m->u.hello.fw_minor, 0, 127);
        fm1c_put(&w, m->u.hello.fw_patch, 0, 127);
        fm1c_put14(&w, m->u.hello.boot_id, 0x3FFFu);
        break;
    case FM1C_T_BUTTON:
        fm1c_put(&w, m->u.button.button, 0, FM1C_N_BUTTON - 1u);
        fm1c_put(&w, m->u.button.edge, 0, FM1C_N_EDGE - 1u);
        break;
    case FM1C_T_KEY:
        fm1c_put(&w, m->u.key.key, 0, FM1C_NSLOT - 1u);
        fm1c_put(&w, m->u.key.gesture, FM1C_G_SINGLE, FM1C_G_UP);
        break;
    case FM1C_T_ENCODER:
        fm1c_put(&w, m->u.enc.encoder, 0, FM1C_N_ENCODER - 1u);
        fm1c_put(&w, (uint32_t)((int32_t)m->u.enc.delta + 64), 0, 127);
        break;
    case FM1C_T_POT:
        fm1c_put(&w, m->u.pot.pot, 0, FM1C_N_POT - 1u);
        fm1c_put14(&w, m->u.pot.value, 1023u);
        break;
    case FM1C_T_DEV_HB:
        fm1c_put14(&w, m->u.dhb.uptime_s, 0x3FFFu);
        fm1c_put(&w, m->u.dhb.rx_errors, 0, 127);
        break;
    case FM1C_T_DEV_ACK:
    case FM1C_T_HOST_ACK:
        fm1c_put(&w, m->u.ack.seq, 0, 127);
        fm1c_put(&w, m->u.ack.status, 0, FM1C_N_ACK - 1u);
        break;
#ifndef FM1C_ENCODE_DEVICE_ONLY                 /* (console.c: the device never encodes a host message; tests do) */
    case FM1C_T_HELLO_ACK:
        fm1c_put(&w, m->u.hello_ack.proto, 0, 127);
        fm1c_put14(&w, m->u.hello_ack.session, 0x3FFFu);
        fm1c_puts(&w, m->u.hello_ack.reason, FM1C_L_REASON);
        break;
    case FM1C_T_SET_VIEW:
        fm1c_put(&w, m->u.view.view, 0, FM1C_N_VIEW - 1u);
        fm1c_put(&w, m->u.view.page, 0, 127);
        fm1c_put(&w, m->u.view.pages, 0, 127);
        fm1c_puts(&w, m->u.view.title, FM1C_L_TITLE);
        if (m->u.view.v5 || m->u.view.v6) fm1c_put(&w, m->u.view.layout, 0, FM1C_LAYOUT_GROUPED);
        if (m->u.view.v6) {
            fm1c_put(&w, m->u.view.keys, 0, FM1C_KEYS_SPLIT);
            if (m->u.view.keys == FM1C_KEYS_SPLIT) {
                if (m->u.view.task_page >= m->u.view.task_pages) w.err = 1;
                fm1c_put(&w, m->u.view.task_page, 0, 126);
                fm1c_put(&w, m->u.view.task_pages, 1, 127);
            }
        }
        break;
    case FM1C_T_SET_SLOT:
        fm1c_put(&w, m->u.slot.key, 0, FM1C_NSLOT - 1u);
        fm1c_put(&w, m->u.slot.state, 0, FM1C_N_STATE - 1u);
        if ((m->u.slot.flags & FM1C_F_CHOSEN) && (m->u.slot.flags & FM1C_F_SELECTED)) w.err = 1;
        fm1c_put(&w, m->u.slot.flags, 0, FM1C_FLAGS_MAX);
        fm1c_puts(&w, m->u.slot.label, FM1C_L_LABEL);
        if (m->u.slot.v5) {
            fm1c_puts(&w, m->u.slot.title, FM1C_L_ROW);
            fm1c_puts(&w, m->u.slot.age, FM1C_L_AGE);
            if (m->u.slot.v5g) {
                uint32_t row = m->u.slot.row;
                if ((row & FM1C_ROW_INDENT) == 3u || ((row & FM1C_ROW_TASK) && !(row & FM1C_ROW_START))) w.err = 1;
                fm1c_put(&w, row, 0, 15);
                if (row & FM1C_ROW_START) {
                    fm1c_put(&w, m->u.slot.head_state, 0, FM1C_N_STATE - 1u);
                    fm1c_put(&w, m->u.slot.head_flags, 0, FM1C_HEAD_PINNED);
                    fm1c_puts(&w, m->u.slot.head_title, FM1C_L_HEAD);
                    fm1c_puts(&w, m->u.slot.head_count, FM1C_L_COUNT);
                }
            }
        }
        break;
    case FM1C_T_SET_DETAIL:
        fm1c_put(&w, m->u.detail.provider, 0, FM1C_N_PROVIDER - 1u);
        fm1c_put(&w, m->u.detail.state, 0, FM1C_N_STATE - 1u);
        for (i = 0; i < 4u; i++) fm1c_puts(&w, m->u.detail.line[i], FM1C_L_LINE);
        break;
    case FM1C_T_SET_VOICE:
        fm1c_put(&w, m->u.voice.voice, 0, FM1C_N_VOICE - 1u);
        fm1c_put(&w, m->u.voice.level, 0, 100);
        fm1c_put14(&w, m->u.voice.elapsed_ds, 0x3FFFu);
        fm1c_puts(&w, m->u.voice.target, FM1C_L_LINE);
        break;
    case FM1C_T_SET_LEGEND:
        for (i = 0; i < 4u; i++) fm1c_puts(&w, m->u.legend.label[i], FM1C_L_LEGEND);
        break;
    case FM1C_T_SET_STATUS:
        fm1c_put(&w, m->u.status.link, 0, FM1C_N_LINK - 1u);
        fm1c_put(&w, m->u.status.attention, 0, 127);
        fm1c_puts(&w, m->u.status.text, FM1C_L_LINE);
        break;
    case FM1C_T_CMD_RESULT:
        fm1c_put(&w, m->u.result.req_seq, 0, FM1C_NO_REQ);
        fm1c_put(&w, m->u.result.result, 0, FM1C_N_RESULT - 1u);
        fm1c_puts(&w, m->u.result.text, FM1C_L_LINE);
        break;
    case FM1C_T_HOST_HB:
        fm1c_put14(&w, m->u.hhb.uptime_s, 0x3FFFu);
        break;
    case FM1C_T_CLEAR_SLOTS:
        break;
    case FM1C_T_SET_TEXT:
        fm1c_put(&w, m->u.text.row, 0, FM1C_TEXT_ROWS - 1u);
        if (w.err) break;
        fm1c_put(&w, m->u.text.count, 1, FM1C_TEXT_ROWS - m->u.text.row < FM1C_TEXT_PER_FRAME
                                         ? FM1C_TEXT_ROWS - m->u.text.row : FM1C_TEXT_PER_FRAME);
        for (i = 0; i < m->u.text.count && i < FM1C_TEXT_PER_FRAME; i++) {
            fm1c_put(&w, m->u.text.style[i], 0, FM1C_N_STYLE - 1u);
            fm1c_puts_text(&w, m->u.text.text[i]);
        }
        break;
#endif
    default:
        w.err = 1;
    }
    if (w.err) return 0;
    out[0] = m->type;
    out[1] = (uint8_t)seq;
    out[2] = (uint8_t)w.n;
    out[3u + w.n] = fm1c_checksum(out, w.n);
    return w.n + FM1C_OVERHEAD;
}

/* every frame except ACK and HEARTBEAT is acknowledged */
static int fm1c_needs_ack(uint32_t type)
{
    return type != FM1C_T_DEV_ACK && type != FM1C_T_HOST_ACK && type != FM1C_T_DEV_HB && type != FM1C_T_HOST_HB;
}
