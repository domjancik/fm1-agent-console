/* SPDX-License-Identifier: GPL-3.0-only */
/* FM1C link, device side (docs/protocol.md section 3): SEQ, ACK and retransmit (250 ms, 3 times, then a fault),
 * the 32-entry duplicate guard, HEARTBEAT every 1000 ms, host lost after 3500 ms of silence, HELLO every 1000 ms
 * until a HELLO_ACK agrees on a version. Time comes in as an argument and frames go out through emit(), so the host
 * tests drive it without the platform. Mirrors packages/device-protocol/src/link.ts. */
#pragma once
#include "fm1c_proto.h"

#define FM1C_RETX_MS 250u
#define FM1C_RETX_MAX 3u
#define FM1C_HB_MS 1000u
#define FM1C_HELLO_MS 1000u
#define FM1C_LOST_MS 3500u
#define FM1C_WIN 32u
#define FM1C_PEND_BYTES 12u                     /* the device's acknowledged frames are 6..7 bytes */

/* events for the app, collected in ev until it reads them */
#define FM1C_EV_ALIVE 1u                        /* the first valid host frame after silence */
#define FM1C_EV_LOST 2u                         /* 3500 ms without one */
#define FM1C_EV_NEGOTIATED 4u                   /* HELLO_ACK with a version we speak */
#define FM1C_EV_NEW_SESSION 8u                  /* ... from a companion run we have not seen */
#define FM1C_EV_INCOMPATIBLE 16u                /* HELLO_ACK with version 0 or one we do not speak */
#define FM1C_EV_FAULT 32u                       /* a frame went unacknowledged after 3 retransmissions */
#define FM1C_EV_RESTART 64u                     /* the host's heartbeat uptime went back: a new companion run */

typedef void (*fm1c_emit_fn)(void *ctx, const uint8_t *payload, uint32_t n);

typedef struct {
    uint8_t used, tx, len;
    uint32_t due;
    uint8_t payload[FM1C_PEND_BYTES];
} fm1c_pend;

typedef struct { uint8_t seq, ck, status; } fm1c_seen;

typedef struct {
    fm1c_emit_fn emit;
    void *ctx;
    uint32_t start, last_rx, next_hb, next_hello;
    uint32_t rx_errors, faults, acked, retx, dup;
    uint16_t boot_id, session, host_up;
    uint8_t have_up, next_seq, alive, proto, have_session, incompatible, fault;
    uint8_t fw[3];
    uint8_t win_n;
    uint32_t ev;
    char reason[FM1C_L_REASON + 1];
    fm1c_seen win[FM1C_WIN];                    /* oldest first */
    fm1c_pend pend[128];                        /* by SEQ */
} fm1c_link;

static void fm1c_link_out(fm1c_link *l, const fm1c_msg *m, uint32_t seq)
{
    uint8_t b[FM1C_MAX_FRAME];
    uint32_t n = fm1c_encode(m, seq, b);
    if (n) l->emit(l->ctx, b, n);
}

static uint32_t fm1c_link_take_seq(fm1c_link *l)
{
    uint32_t s = l->next_seq;
    l->next_seq = (uint8_t)((s + 1u) & 127u);
    return s;
}

static void fm1c_link_hello(fm1c_link *l)       /* not tracked: it repeats every second until answered */
{
    fm1c_msg m;
    fm1c_zero(&m, sizeof m);
    m.type = FM1C_T_HELLO;
    m.u.hello.pmin = FM1C_PROTO_MIN;
    m.u.hello.pmax = FM1C_PROTO_MAX;
    m.u.hello.fw_major = l->fw[0];
    m.u.hello.fw_minor = l->fw[1];
    m.u.hello.fw_patch = l->fw[2];
    m.u.hello.boot_id = l->boot_id;
    fm1c_link_out(l, &m, fm1c_link_take_seq(l));
}

static void fm1c_link_init(fm1c_link *l, uint32_t now, uint32_t boot_id, const uint8_t fw[3], fm1c_emit_fn emit, void *ctx)
{
    fm1c_zero(l, sizeof *l);
    l->emit = emit;
    l->ctx = ctx;
    l->boot_id = (uint16_t)(boot_id & 0x3FFFu);
    l->fw[0] = fw[0];
    l->fw[1] = fw[1];
    l->fw[2] = fw[2];
    l->start = now;
    l->next_hb = now + FM1C_HB_MS;
    l->next_hello = now + FM1C_HELLO_MS;
    fm1c_link_hello(l);
}

static void fm1c_link_ack(fm1c_link *l, uint32_t seq, uint32_t status)
{
    fm1c_msg m;
    fm1c_zero(&m, sizeof m);
    m.type = FM1C_T_DEV_ACK;
    m.u.ack.seq = (uint8_t)seq;
    m.u.ack.status = (uint8_t)status;
    fm1c_link_out(l, &m, fm1c_link_take_seq(l));
}

/* the duplicate guard: a (SEQ, checksum) seen before is a retransmission */
static int fm1c_win_find(const fm1c_link *l, uint32_t seq, uint32_t ck)
{
    uint32_t i;
    for (i = 0; i < l->win_n; i++)
        if (l->win[i].seq == seq && l->win[i].ck == ck) return (int)i;
    return -1;
}
static void fm1c_win_record(fm1c_link *l, uint32_t seq, uint32_t ck, uint32_t status)
{
    uint32_t i, k = 0;
    for (i = 0; i < l->win_n; i++)              /* the same SEQ once only, as the newest */
        if (l->win[i].seq != seq) l->win[k++] = l->win[i];
    l->win_n = (uint8_t)k;
    if (l->win_n == FM1C_WIN) {
        for (i = 1; i < FM1C_WIN; i++) l->win[i - 1u] = l->win[i];
        l->win_n--;
    }
    l->win[l->win_n].seq = (uint8_t)seq;
    l->win[l->win_n].ck = (uint8_t)ck;
    l->win[l->win_n].status = (uint8_t)status;
    l->win_n++;
}

static void fm1c_link_cancel(fm1c_link *l)      /* dropped without a verdict: the host is gone or restarted */
{
    uint32_t i;
    for (i = 0; i < 128u; i++) l->pend[i].used = 0;
}

static void fm1c_link_alive(fm1c_link *l, uint32_t now)
{
    l->last_rx = now;
    if (!l->alive) { l->alive = 1; l->ev |= FM1C_EV_ALIVE; }
}

static void fm1c_link_hello_ack(fm1c_link *l, const fm1c_msg *m)
{
    uint32_t i;
    if (m->u.hello_ack.proto >= FM1C_PROTO_MIN && m->u.hello_ack.proto <= FM1C_PROTO_MAX) {
        if (!l->have_session || l->session != m->u.hello_ack.session) l->ev |= FM1C_EV_NEW_SESSION;
        l->have_session = 1;
        l->session = m->u.hello_ack.session;
        l->proto = m->u.hello_ack.proto;
        l->incompatible = 0;
        l->fault = 0;
        l->ev |= FM1C_EV_NEGOTIATED;
    } else {
        l->proto = 0;
        l->incompatible = 1;
        for (i = 0; i <= FM1C_L_REASON; i++) l->reason[i] = m->u.hello_ack.reason[i];
        l->ev |= FM1C_EV_INCOMPATIBLE;
    }
}

/* A frame payload from the host. Returns 1 when *m is a new message for the app (SET_*, COMMAND_RESULT,
 * CLEAR_SLOTS, HELLO_ACK), 0 when the link consumed it (ACK, HEARTBEAT, a duplicate, an invalid frame). */
static int fm1c_link_rx(fm1c_link *l, const uint8_t *b, uint32_t n, uint32_t now, fm1c_msg *m)
{
    int rc = fm1c_decode(b, n, FM1C_FROM_HOST, m), i;
    if (rc != FM1C_OK) {
        l->rx_errors++;
        if (rc == FM1C_E_UNKNOWN_TYPE || rc == FM1C_E_BAD_BODY) {   /* intact frame: ACK it with the reason */
            uint32_t st = rc == FM1C_E_UNKNOWN_TYPE ? FM1C_ACK_UNKNOWN_TYPE : FM1C_ACK_BAD_BODY;
            fm1c_link_alive(l, now);
            i = fm1c_win_find(l, m->seq, m->ck);
            if (i >= 0) st = l->win[i].status;
            else fm1c_win_record(l, m->seq, m->ck, st);
            fm1c_link_ack(l, m->seq, st);
        }
        return 0;
    }
    fm1c_link_alive(l, now);
    if (m->type == FM1C_T_HOST_ACK) {
        fm1c_win_record(l, m->seq, m->ck, FM1C_ACK_OK);
        if (l->pend[m->u.ack.seq].used) {
            l->pend[m->u.ack.seq].used = 0;
            l->acked++;
            l->fault = 0;
        }
        return 0;
    }
    if (m->type == FM1C_T_HOST_HB) {
        uint32_t up = m->u.hhb.uptime_s;
        fm1c_win_record(l, m->seq, m->ck, FM1C_ACK_OK);
        /* A companion that restarted within the 3500 ms never sees a HELLO from a device that still counts as
         * linked; its uptime going back gives it away (not the u14 wrap after 4.5 h). Ask again at once. */
        if (l->have_up && up < l->host_up && !(l->host_up > 16380u && up < 4u)) {
            l->proto = 0;
            l->win_n = 0;
            fm1c_link_cancel(l);
            l->next_hello = now;
            l->ev |= FM1C_EV_RESTART;
        }
        l->host_up = (uint16_t)up;
        l->have_up = 1;
        return 0;
    }
    i = fm1c_win_find(l, m->seq, m->ck);
    if (i >= 0) {                               /* a retransmission: ACK again, do not process again */
        l->dup++;
        fm1c_link_ack(l, m->seq, l->win[i].status);
        return 0;
    }
    /* A HELLO_ACK means the host (re)started and its SEQ did too, unless it repeats the session we are linked with:
     * that is the same run answering a second HELLO, and the inputs in flight to it stay tracked. */
    if (m->type == FM1C_T_HELLO_ACK && !(l->proto && l->have_session && l->session == m->u.hello_ack.session)) {
        l->win_n = 0;
        fm1c_link_cancel(l);
    }
    fm1c_win_record(l, m->seq, m->ck, FM1C_ACK_OK);
    fm1c_link_ack(l, m->seq, FM1C_ACK_OK);
    if (m->type == FM1C_T_HELLO_ACK) fm1c_link_hello_ack(l, m);
    return 1;
}

/* Sends an input frame (BUTTON, KEY, ENCODER, POT); tracked until ACKed. Returns its SEQ, or -1 when no version is
 * agreed (a press with no host is not queued for later: it would act on a stale screen). */
static int32_t fm1c_link_send(fm1c_link *l, const fm1c_msg *m, uint32_t now)
{
    uint8_t b[FM1C_MAX_FRAME];
    uint32_t seq, n, i;
    fm1c_pend *p;
    if (!l->proto) return -1;
    seq = l->next_seq;
    n = fm1c_encode(m, seq, b);
    if (!n || n > FM1C_PEND_BYTES) return -1;
    fm1c_link_take_seq(l);
    p = &l->pend[seq];
    if (p->used) { l->faults++; l->fault = 1; l->ev |= FM1C_EV_FAULT; }   /* (SEQ wrapped onto an unanswered frame) */
    p->used = 1;
    p->tx = 1;
    p->len = (uint8_t)n;
    p->due = now + FM1C_RETX_MS;
    for (i = 0; i < n; i++) p->payload[i] = b[i];
    l->emit(l->ctx, b, n);
    return (int32_t)seq;
}

static void fm1c_link_heartbeat(fm1c_link *l, uint32_t now)
{
    fm1c_msg m;
    fm1c_zero(&m, sizeof m);
    m.type = FM1C_T_DEV_HB;
    m.u.dhb.uptime_s = (uint16_t)(((now - l->start) / 1000u) & 0x3FFFu);
    m.u.dhb.rx_errors = (uint8_t)(l->rx_errors > 127u ? 127u : l->rx_errors);
    fm1c_link_out(l, &m, fm1c_link_take_seq(l));
}

static int fm1c_due(uint32_t now, uint32_t t) { return (int32_t)(now - t) >= 0; }   /* (wraps after 49 days) */

/* Timers: retransmit, heartbeat, HELLO, host lost. Call every main-loop pass. */
static void fm1c_link_tick(fm1c_link *l, uint32_t now)
{
    uint32_t s;
    for (s = 0; s < 128u; s++) {
        fm1c_pend *p = &l->pend[s];
        if (!p->used || !fm1c_due(now, p->due)) continue;
        if (p->tx <= FM1C_RETX_MAX) {
            p->tx++;
            p->due = now + FM1C_RETX_MS;
            l->retx++;
            l->emit(l->ctx, p->payload, p->len);
        } else {
            p->used = 0;
            l->faults++;
            l->fault = 1;
            l->ev |= FM1C_EV_FAULT;
        }
    }
    if (fm1c_due(now, l->next_hb)) {
        l->next_hb = now + FM1C_HB_MS;
        fm1c_link_heartbeat(l, now);
    }
    if (fm1c_due(now, l->next_hello)) {
        l->next_hello = now + FM1C_HELLO_MS;
        if (!l->proto) fm1c_link_hello(l);
    }
    if (l->alive && now - l->last_rx >= FM1C_LOST_MS) {
        l->alive = 0;
        l->proto = 0;
        l->fault = 0;
        l->have_up = 0;
        l->incompatible = 0;
        l->win_n = 0;                           /* the next host may be a new run: its SEQ 0.. are not our duplicates */
        fm1c_link_cancel(l);
        l->ev |= FM1C_EV_LOST;
    }
}

/* the cable just came up: the next tick says HELLO (when no version is agreed), not up to a second later */
static void fm1c_link_hello_soon(fm1c_link *l, uint32_t now)
{
    if (!l->proto) l->next_hello = now;
}

/* a device frame is waiting for its ACK (console.c holds the character animation back meanwhile, so a retransmission
 * never waits behind a sprite); read-only */
static int fm1c_link_busy(const fm1c_link *l)
{
    uint32_t s;
    for (s = 0; s < 128u; s++)
        if (l->pend[s].used) return 1;
    return 0;
}

static uint32_t fm1c_link_events(fm1c_link *l)
{
    uint32_t e = l->ev;
    l->ev = 0;
    return e;
}
