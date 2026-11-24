/* SPDX-License-Identifier: GPL-3.0-only */
/* Key gestures and the knob filters, timed in the app (the HAL has edges only). docs/protocol.md section 4:
 *   down / up    always, at once
 *   long         held >= 600 ms (sent while still held; its release sends only up)
 *   double       a second down within 300 ms of the first up; sent after the second up
 *   single       once the 300 ms window after the first up has closed without a second down
 * so a double press is down, up, down, up, double and never a single. Pure: time in, events out via a callback. */
#pragma once
#include "fm1c_proto.h"

#define FM1C_LONG_MS 600u
#define FM1C_DOUBLE_MS 300u

enum { FM1C_K_IDLE = 0, FM1C_K_DOWN1, FM1C_K_WAIT, FM1C_K_DOWN2 };

typedef struct {
    uint8_t phase, long_sent;
    uint32_t t_down, t_up;
} fm1c_key;

typedef void (*fm1c_gesture_fn)(void *ctx, uint32_t key, uint32_t gesture);

typedef struct {
    fm1c_key k[FM1C_NSLOT];
    fm1c_gesture_fn emit;
    void *ctx;
} fm1c_keys;

static void fm1c_keys_init(fm1c_keys *g, fm1c_gesture_fn emit, void *ctx)
{
    fm1c_zero(g, sizeof *g);
    g->emit = emit;
    g->ctx = ctx;
}

static void fm1c_key_down(fm1c_keys *g, uint32_t k, uint32_t now)
{
    fm1c_key *s = &g->k[k];
    g->emit(g->ctx, k, FM1C_G_DOWN);
    s->phase = s->phase == FM1C_K_WAIT ? FM1C_K_DOWN2 : FM1C_K_DOWN1;
    s->t_down = now;
    s->long_sent = 0;
}

static void fm1c_key_up(fm1c_keys *g, uint32_t k, uint32_t now)
{
    fm1c_key *s = &g->k[k];
    g->emit(g->ctx, k, FM1C_G_UP);
    if (s->phase == FM1C_K_DOWN1 && !s->long_sent) {
        s->phase = FM1C_K_WAIT;
        s->t_up = now;
        return;
    }
    if (s->phase == FM1C_K_DOWN2 && !s->long_sent) g->emit(g->ctx, k, FM1C_G_DOUBLE);
    s->phase = FM1C_K_IDLE;
}

/* One pass: held = the keys down now, prev = at the last pass, edges = presses latched since (a tap shorter than a
 * pass shows only there). Edges first, then the timers, so a second down at exactly 300 ms still counts. */
static void fm1c_keys_scan(fm1c_keys *g, uint32_t held, uint32_t prev, uint32_t edges, uint32_t now)
{
    uint32_t k;
    for (k = 0; k < FM1C_NSLOT; k++) {
        uint32_t p = prev >> k & 1u, c = held >> k & 1u, e = edges >> k & 1u;
        if (p && !c) {
            fm1c_key_up(g, k, now);
            if (e) { fm1c_key_down(g, k, now); fm1c_key_up(g, k, now); }   /* released, tapped again */
        } else if (!p && c) {
            fm1c_key_down(g, k, now);
        } else if (!p && !c && e) {
            fm1c_key_down(g, k, now);
            fm1c_key_up(g, k, now);
        } else if (p && c && e) {
            fm1c_key_up(g, k, now);
            fm1c_key_down(g, k, now);
        }
    }
    for (k = 0; k < FM1C_NSLOT; k++) {
        fm1c_key *s = &g->k[k];
        if ((s->phase == FM1C_K_DOWN1 || s->phase == FM1C_K_DOWN2) && !s->long_sent && now - s->t_down >= FM1C_LONG_MS) {
            s->long_sent = 1;
            g->emit(g->ctx, k, FM1C_G_LONG);
        } else if (s->phase == FM1C_K_WAIT && now - s->t_up >= FM1C_DOUBLE_MS) {
            s->phase = FM1C_K_IDLE;
            g->emit(g->ctx, k, FM1C_G_SINGLE);
        }
    }
}

/* ---- button edges: pressed / released bits since the last pass, in the order they happened */
typedef void (*fm1c_button_fn)(void *ctx, uint32_t button, uint32_t edge);

static void fm1c_buttons_scan(uint32_t pressed, uint32_t released, uint32_t held, fm1c_button_fn emit, void *ctx)
{
    uint32_t b;
    for (b = 0; b < FM1C_N_BUTTON; b++) {
        uint32_t p = pressed >> b & 1u, r = released >> b & 1u;
        if (p && r) {                           /* both: held now = it was let go and pressed again */
            if (held >> b & 1u) { emit(ctx, b, 0); emit(ctx, b, 1); }
            else { emit(ctx, b, 1); emit(ctx, b, 0); }
        } else if (p) {
            emit(ctx, b, 1);
        } else if (r) {
            emit(ctx, b, 0);
        }
    }
}

/* ---- encoders: detents add up; one frame per encoder at most every FM1C_ENC_MS, -64..63 each */
#define FM1C_ENC_MS 20u
typedef struct {
    int32_t owed[FM1C_N_ENCODER];
    uint32_t t_sent[FM1C_N_ENCODER];
} fm1c_encs;

/* adds steps for encoder e; returns the delta to send now (0: nothing yet) */
static int32_t fm1c_enc_step(fm1c_encs *s, uint32_t e, int32_t steps, uint32_t now)
{
    int32_t d;
    s->owed[e] += steps;
    if (!s->owed[e] || now - s->t_sent[e] < FM1C_ENC_MS) return 0;
    d = s->owed[e] > 63 ? 63 : s->owed[e] < -64 ? -64 : s->owed[e];
    s->owed[e] -= d;
    s->t_sent[e] = now;
    return d;
}

/* ---- MASTER: smoothed, a deadband of 8 counts, at most every 50 ms */
#define FM1C_POT_MS 50u
#define FM1C_POT_DEADBAND 8
typedef struct {
    int32_t avg, sent;                          /* avg: value x 4; sent: -1 = never */
    uint32_t t_sent;
    uint8_t primed;
} fm1c_pot;

static void fm1c_pot_init(fm1c_pot *p) { p->avg = 0; p->sent = -1; p->t_sent = 0; p->primed = 0; }

static int32_t fm1c_pot_value(const fm1c_pot *p) { return p->avg >> 2; }

/* a raw reading (0..1023, < 0 = none); returns the value to send now, or -1 */
static int32_t fm1c_pot_feed(fm1c_pot *p, int32_t raw, uint32_t now)
{
    int32_t v, d;
    if (raw < 0) return -1;
    if (!p->primed) { p->avg = raw << 2; p->primed = 1; }
    else p->avg += raw - (p->avg >> 2);         /* (avg/4 follows raw by a quarter a reading) */
    v = fm1c_pot_value(p);
    d = v - p->sent;
    if (p->sent >= 0 && d < FM1C_POT_DEADBAND && d > -FM1C_POT_DEADBAND) return -1;
    if (p->sent >= 0 && now - p->t_sent < FM1C_POT_MS) return -1;
    p->sent = v;
    p->t_sent = now;
    return v;
}

/* ---- the help overlay (docs/ux-v2.md section 2.5): SCL (button 3) held >= 400 ms while version 2 is agreed.
 * While it is up the panel says nothing to the host but SCL's own edges: no KEY, ENCODER or POT frame and no other
 * BUTTON frame; those inputs are dropped, never queued. One exception keeps the host's picture of the panel whole:
 * the release of a button or key whose press the host was told about before the help opened (REC let go under the
 * help still ends the recording). Pure: the held state and time in, the gate's answers out. */
#define FM1C_HELP_MS 400u
#define FM1C_BTN_SCL 3u

typedef struct {
    uint8_t down, on;
    uint32_t t_down;
    uint32_t btn_sent, key_sent;                /* buttons / keys whose down the host was told and whose up it was not */
    uint32_t btn_muted, key_muted;              /* buttons / keys whose press began under the help: silent to its end */
} fm1c_help;

static void fm1c_help_init(fm1c_help *h) { fm1c_zero(h, sizeof *h); }

/* one pass: scl = SCL held now, enabled = version 2 agreed. Returns 1 while the help is up. */
static uint32_t fm1c_help_tick(fm1c_help *h, uint32_t scl, uint32_t enabled, uint32_t now)
{
    if (!scl || !enabled) { h->down = 0; h->on = 0; return 0; }
    if (!h->down) { h->down = 1; h->t_down = now; }
    if (!h->on && now - h->t_down >= FM1C_HELP_MS) h->on = 1;
    return h->on;
}

/* may this BUTTON edge go out now? (edge 1 down, 0 up) Under the help only SCL and an up whose down went out pass.
 * A press that began under the help stays silent to its end: its up, let go after the help closed, is dropped too
 * (the host never heard the down). */
static int fm1c_help_button(fm1c_help *h, uint32_t b, uint32_t edge)
{
    uint32_t bit = 1u << b;
    if (edge) {
        if (b != FM1C_BTN_SCL && h->on) { h->btn_muted |= bit; return 0; }
        h->btn_muted &= ~bit;
        h->btn_sent |= bit;
        return 1;
    }
    if (h->btn_sent & bit) { h->btn_sent &= ~bit; return 1; }
    if (h->btn_muted & bit) { h->btn_muted &= ~bit; return 0; }
    return b == FM1C_BTN_SCL || !h->on;
}

/* may this KEY gesture go out now? Under the help only an up whose down went out passes. A press that began under
 * the help stays silent to its end, so its single / double, timed after the help closed, is dropped too. */
static int fm1c_help_key(fm1c_help *h, uint32_t k, uint32_t gesture)
{
    uint32_t bit = 1u << k;
    if (gesture == FM1C_G_DOWN) {
        if (h->on) { h->key_muted |= bit; return 0; }
        h->key_muted &= ~bit;
        h->key_sent |= bit;
        return 1;
    }
    if (gesture == FM1C_G_UP && (h->key_sent & bit)) { h->key_sent &= ~bit; return 1; }
    return !h->on && !(h->key_muted & bit);
}
