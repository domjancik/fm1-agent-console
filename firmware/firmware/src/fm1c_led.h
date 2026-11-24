/* SPDX-License-Identifier: GPL-3.0-only */
/* LED patterns and priorities (docs/protocol.md section 6). The FM-1's LEDs are single colour with three levels
 * here: off, glow (the HAL's dim layer, ~1/24) and full. All blinking runs off one clock (fm1_ms) so keys in the same
 * state blink together. Pure: state and time in, a level out. */
#pragma once
#include "fm1c_proto.h"

enum { FM1C_LED_OFF = 0, FM1C_LED_GLOW = 1, FM1C_LED_FULL = 2, FM1C_LED_BACK = 3 };   /* BACK: the backlight layer
                                                                                    * (version 5 LEDs v2: breathing) */

static uint32_t fm1c_blink(uint32_t ms, uint32_t half) { return ms % (2u * half) < half; }

/* a key's level from its slot (priority 1 = selected ... 9 = unknown) */
static uint32_t fm1c_key_level(uint32_t state, uint32_t flags, uint32_t ms)
{
    if (flags & FM1C_F_SELECTED) {
        if (state == FM1C_S_APPROVAL && ms % 1000u < 100u) return FM1C_LED_OFF;   /* the attention dip */
        return FM1C_LED_FULL;
    }
    switch (state) {
    case FM1C_S_APPROVAL: return fm1c_blink(ms, 500u) ? FM1C_LED_FULL : FM1C_LED_OFF;
    case FM1C_S_FAILED: return fm1c_blink(ms, 150u) ? FM1C_LED_FULL : FM1C_LED_OFF;
    case FM1C_S_WAITING_INPUT: return fm1c_blink(ms, 500u) ? FM1C_LED_FULL : FM1C_LED_GLOW;
    case FM1C_S_DONE_UNREAD: return ms % 2000u < 120u ? FM1C_LED_FULL : FM1C_LED_GLOW;
    case FM1C_S_WORKING: return FM1C_LED_FULL;
    case FM1C_S_IDLE:
    case FM1C_S_DONE_READ: return FM1C_LED_GLOW;
    case FM1C_S_UNKNOWN: return ms % 2000u < 120u ? FM1C_LED_OFF : FM1C_LED_GLOW;
    default: return FM1C_LED_OFF;               /* empty, disconnected */
    }
}

/* the key level with no host: every key glows, the kept selection stays full */
static uint32_t fm1c_key_level_nohost(uint32_t flags) { return flags & FM1C_F_SELECTED ? FM1C_LED_FULL : FM1C_LED_GLOW; }

/* button LEDs by protocol button id (HAL ids: OCT- 0 ... REC 13) */
#define FM1C_B_OCT_UP 1u
#define FM1C_B_FX 2u
#define FM1C_B_ENV 4u
#define FM1C_B_LFO 5u
#define FM1C_B_EDIT 6u
#define FM1C_B_GLO 7u
#define FM1C_B_HOME 8u
#define FM1C_B_SAVE 9u
#define FM1C_B_ARP 10u
#define FM1C_B_SEQ 11u
#define FM1C_B_PLAY 12u
#define FM1C_B_REC 13u

typedef struct {
    uint8_t host, view, voice, attention;
    uint8_t list;                               /* version 5: the LIST (1) or GROUPED (2) layout is shown */
    uint8_t v2;                                 /* version 5: LED language v2 (docs/ui-v3.md section 9.9) */
    uint8_t dstate;                             /* SET_DETAIL.state (v2: SAVE blinks for an approval) */
} fm1c_button_ctx;

static uint32_t fm1c_button_level2(uint32_t b, const fm1c_button_ctx *c, uint32_t ms);
static uint32_t fm1c_button_level(uint32_t b, const fm1c_button_ctx *c, uint32_t ms)
{
    if (c->v2) return fm1c_button_level2(b, c, ms);
    if (!c->host) return b == FM1C_B_OCT_UP && fm1c_blink(ms, 500u) ? FM1C_LED_FULL : FM1C_LED_OFF;
    switch (b) {
    case FM1C_B_REC:
        if (c->voice == FM1C_V_RECORDING) return FM1C_LED_FULL;
        if (c->voice == FM1C_V_TRANSCRIBING) return fm1c_blink(ms, 250u) ? FM1C_LED_FULL : FM1C_LED_OFF;
        return FM1C_LED_OFF;
    case FM1C_B_SAVE: return c->voice == FM1C_V_REVIEWING ? FM1C_LED_FULL : FM1C_LED_OFF;
    case FM1C_B_HOME: return c->view == FM1C_VIEW_SESSIONS ? FM1C_LED_FULL : FM1C_LED_OFF;
    case FM1C_B_LFO: return c->view == FM1C_VIEW_DETAIL ? FM1C_LED_FULL : FM1C_LED_OFF;   /* (docs/ux-v2.md 7.3) */
    case FM1C_B_SEQ: return c->list ? FM1C_LED_FULL : FM1C_LED_OFF;   /* (docs/ui-v3.md 8.5) */
    case FM1C_B_EDIT: return c->view == FM1C_VIEW_TASKS ? FM1C_LED_FULL : FM1C_LED_OFF;
    case FM1C_B_GLO:
        if (c->view == FM1C_VIEW_INBOX) return FM1C_LED_FULL;
        return c->attention && fm1c_blink(ms, 500u) ? FM1C_LED_FULL : FM1C_LED_OFF;
    default: return FM1C_LED_OFF;
    }
}

/* ---- LED language v2 (protocol 5, docs/ui-v3.md section 9.9). Unselected keys blink in lit / glow / off rhythms; the
 * selected key is the only LED in the backlight layer, whose pulse length the main loop ramps every 20 ms
 * (FM1C_BREATH_NS: breathing); the blinks of approval and question break through it, failed dips it to off. */
static const uint16_t FM1C_BREATH_NS[76] = {
    12000, 12010, 12041, 12092, 12163, 12255, 12367, 12500, 12654, 12829, 13025, 13242, 13480, 13740, 14022, 14325,
    14650, 14997, 15367, 15758, 16171, 16607, 17064, 17544, 18045, 18568, 19111, 19676, 20262, 20867, 21492, 22136,
    22797, 23477, 24172, 24883, 25609, 26348, 27099, 27861, 28632, 29412, 30198, 30989, 31783, 32579, 33374, 34168,
    34957, 35741, 36517, 37283, 38038, 38778, 39503, 40210, 40898, 41563, 42206, 42822, 43412, 43972, 44502, 45000,
    45463, 45892, 46284, 46638, 46953, 47228, 47462, 47655, 47806, 47913, 47978, 48000,
};
#define FM1C_BREATH_STEP_MS 20u
/* the backlight pulse at ms: p = (ms / 20) mod 150, i = p <= 75 ? p : 150 - p (period 3,000 ms). The table is a
 * raised cosine in perceived brightness (gamma 2.2) from 12,000 ns (never dark) to 48,000 ns: slow at both ends. */
static uint32_t fm1c_breath_ns(uint32_t ms)
{
    uint32_t p = ms / FM1C_BREATH_STEP_MS % 150u;
    return FM1C_BREATH_NS[p <= 75u ? p : 150u - p];
}
/* the lit windows of the two states whose blink breaks through the selection (1: lit now) */
static int fm1c_led2_burst(uint32_t state, uint32_t ms)
{
    uint32_t t;
    switch (state) {
    case FM1C_S_APPROVAL: return ms % 500u < 250u;
    case FM1C_S_WAITING_INPUT: t = ms % 1260u; return t < 120u || (t >= 240u && t < 360u);
    default: return 0;
    }
}
/* failed: a slow glow/off blink, never lit, so many failed keys stay calm (G 0-1499, O 1500-2999) */
static int fm1c_led2_failed_off(uint32_t ms) { return ms % 3000u >= 1500u; }
/* protocol 6 (docs/ui-v3.md section 10.8): the chosen filter / task key of the SPLIT black row, whatever its state, is in
 * the backlight layer with the selected session, so both breathe in step (operator 2026-11-19: the earlier lit/glow
 * blink read as flashing). Breathing means "your current choice": no state timeline uses it. */
static uint32_t fm1c_led2_chosen(uint32_t ms) { (void)ms; return FM1C_LED_BACK; }
static uint32_t fm1c_key_level2(uint32_t state, uint32_t flags, uint32_t ms)
{
    uint32_t t;
    if (flags & FM1C_F_CHOSEN) return fm1c_led2_chosen(ms);   /* (first: it overrides the state; never with selected) */
    if (flags & FM1C_F_SELECTED) {
        if (state == FM1C_S_FAILED) return (ms + 150u) % 3000u < 300u ? FM1C_LED_OFF : FM1C_LED_BACK;   /* the breath's bottom */
        return fm1c_led2_burst(state, ms) ? FM1C_LED_FULL : FM1C_LED_BACK;
    }
    if (state == FM1C_S_EMPTY || state == FM1C_S_DISCONNECTED || state >= FM1C_N_STATE) return FM1C_LED_OFF;
    if (flags & FM1C_F_STALE) return ms % 4000u < 150u ? FM1C_LED_GLOW : FM1C_LED_OFF;
    switch (state) {
    case FM1C_S_APPROVAL: return fm1c_led2_burst(state, ms) ? FM1C_LED_FULL : FM1C_LED_OFF;
    case FM1C_S_WAITING_INPUT: return fm1c_led2_burst(state, ms) ? FM1C_LED_FULL : FM1C_LED_GLOW;
    case FM1C_S_FAILED: return fm1c_led2_failed_off(ms) ? FM1C_LED_OFF : FM1C_LED_GLOW;
    case FM1C_S_DONE_UNREAD: return ms % 2500u < 150u ? FM1C_LED_FULL : FM1C_LED_GLOW;
    case FM1C_S_WORKING: return FM1C_LED_FULL;
    case FM1C_S_UNKNOWN: t = ms % 3000u; return t < 150u ? FM1C_LED_OFF : FM1C_LED_GLOW;
    default: return FM1C_LED_GLOW;              /* idle, completed read */
    }
}
/* v2 with no host: every key glows, the kept selection breathes */
static uint32_t fm1c_key_level2_nohost(uint32_t flags) { return flags & FM1C_F_SELECTED ? FM1C_LED_BACK : FM1C_LED_GLOW; }

static uint32_t fm1c_led2_double(uint32_t ms)  /* L 0-119, O 120-239, L 240-359, O 360-1259 */
{
    uint32_t t = ms % 1260u;
    return t < 120u || (t >= 240u && t < 360u);
}
/* v2 "active controls" (operator 2026-11-22, docs/ui-v3.md section 9.9): a button the companion acts on in the shown
 * view glows dim steady, unless its own pattern (full, blink, double) is in force; never the backlight layer. The voice
 * overlay (view 3) decides alone, CONFIRM (view 4) wins over it as the companion's currentView does; the base views
 * read SET_DETAIL.state (empty: nothing selected). REC never glows in a base view (always there: noise). */
static int fm1c_button_glow2(uint32_t b, const fm1c_button_ctx *c)
{
    uint32_t d = c->dstate;
    int shown = d != FM1C_S_EMPTY && d != FM1C_S_DISCONNECTED && d < FM1C_N_STATE;   /* a chat is shown */
    int busy = d == FM1C_S_WORKING || d == FM1C_S_WAITING_INPUT || d == FM1C_S_APPROVAL;   /* ENV stops it */
    int ask = d == FM1C_S_APPROVAL;                                                       /* FX denies */
    switch (c->view) {
    case FM1C_VIEW_CONFIRM: return b == FM1C_B_FX;                                         /* FX cancels */
    case FM1C_VIEW_VOICE:
        switch (c->voice) {
        case FM1C_V_RECORDING:
        case FM1C_V_TRANSCRIBING:
        case FM1C_V_NO_TARGET: return b == FM1C_B_FX;                                     /* cancel */
        case FM1C_V_REVIEWING: return b == FM1C_B_FX || b == FM1C_B_ARP;                  /* cancel, save canned */
        case FM1C_V_FAILED: return b == FM1C_B_FX || b == FM1C_B_PLAY;                    /* dismiss, retry */
        default: return 0;                      /* submitting: FX only says "still sending" */
        }
    case FM1C_VIEW_DETAIL:
        return b == FM1C_B_HOME || (b == FM1C_B_FX && ask) || (b == FM1C_B_ENV && busy) || (b == FM1C_B_PLAY && shown);
    case FM1C_VIEW_SETTINGS: return b == FM1C_B_SAVE || b == FM1C_B_HOME || b == FM1C_B_LFO;
    case FM1C_VIEW_SESSIONS: return (b == FM1C_B_FX && ask) || (b == FM1C_B_ENV && busy) || (b == FM1C_B_PLAY && shown);
    case FM1C_VIEW_INBOX: return (b == FM1C_B_FX && shown) || (b == FM1C_B_ENV && busy) || (b == FM1C_B_PLAY && shown);
    case FM1C_VIEW_TASKS: return b == FM1C_B_PLAY && d != FM1C_S_EMPTY && d < FM1C_N_STATE;   /* a task: new chat */
    default: return 0;
    }
}
static uint32_t fm1c_button_primary2(uint32_t b, const fm1c_button_ctx *c, uint32_t ms);
static uint32_t fm1c_button_level2(uint32_t b, const fm1c_button_ctx *c, uint32_t ms)
{
    uint32_t lv;
    if (!c->host) return b == FM1C_B_OCT_UP && ms % 1000u < 500u ? FM1C_LED_FULL : FM1C_LED_OFF;
    if (c->view == FM1C_VIEW_SETTINGS)          /* (protocol 6, section 10.8): ARP lit, the active ones glow, all else off */
        return b == FM1C_B_ARP ? FM1C_LED_FULL : fm1c_button_glow2(b, c) ? FM1C_LED_GLOW : FM1C_LED_OFF;
    lv = fm1c_button_primary2(b, c, ms);
    return lv == FM1C_LED_OFF && fm1c_button_glow2(b, c) ? FM1C_LED_GLOW : lv;
}
/* the state / primary patterns. No glowing button has a blink here (SAVE glows in view 6 only, REC and GLO never), so a
 * blink's off phase never turns into a glow. */
static uint32_t fm1c_button_primary2(uint32_t b, const fm1c_button_ctx *c, uint32_t ms)
{
    switch (b) {
    case FM1C_B_REC:
        if (c->voice == FM1C_V_RECORDING) return FM1C_LED_FULL;
        if (c->voice == FM1C_V_TRANSCRIBING) return ms % 500u < 250u ? FM1C_LED_FULL : FM1C_LED_OFF;
        return FM1C_LED_OFF;
    case FM1C_B_SAVE: {                         /* a send or an approval awaits SAVE */
        int wait = c->voice == FM1C_V_REVIEWING || c->view == FM1C_VIEW_CONFIRM ||
                   ((c->view == FM1C_VIEW_SESSIONS || c->view == FM1C_VIEW_INBOX || c->view == FM1C_VIEW_DETAIL) &&
                    c->dstate == FM1C_S_APPROVAL);
        return wait && fm1c_led2_double(ms) ? FM1C_LED_FULL : FM1C_LED_OFF;
    }
    case FM1C_B_LFO: return c->view == FM1C_VIEW_DETAIL ? FM1C_LED_FULL : FM1C_LED_OFF;
    case FM1C_B_SEQ: return c->list ? FM1C_LED_GLOW : FM1C_LED_OFF;
    case FM1C_B_HOME: return c->view == FM1C_VIEW_SESSIONS ? FM1C_LED_FULL : FM1C_LED_OFF;
    case FM1C_B_EDIT: return c->view == FM1C_VIEW_TASKS ? FM1C_LED_FULL : FM1C_LED_OFF;
    case FM1C_B_ARP: return c->view == FM1C_VIEW_SETTINGS ? FM1C_LED_FULL : FM1C_LED_OFF;   /* (protocol 6, section 10.8) */
    case FM1C_B_GLO:
        if (c->view == FM1C_VIEW_INBOX) return FM1C_LED_FULL;
        return c->attention && ms % 2500u < 150u ? FM1C_LED_FULL : FM1C_LED_OFF;
    default: return FM1C_LED_OFF;
    }
}
