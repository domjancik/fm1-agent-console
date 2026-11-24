/* SPDX-License-Identifier: GPL-3.0-only */
/* The device link (firmware/src/fm1c_link.h) on a fake clock: HELLO until HELLO_ACK, ACKs and the duplicate
 * guard, retransmit 250 ms x 3 then a fault, heartbeats, host lost at 3500 ms, version mismatch, host restart. */
#include "t.h"
#include "fm1c_link.h"

#define MAXOUT 512
static fm1c_msg out[MAXOUT];
static uint32_t nout, out_t[MAXOUT], now;

static void emit(void *ctx, const uint8_t *p, uint32_t n)
{
    (void)ctx;
    if (nout < MAXOUT) {
        int rc = fm1c_decode(p, n, FM1C_FROM_DEVICE, &out[nout]);
        CHECK(rc == FM1C_OK, "device sent an undecodable frame (%d)", rc);
        out_t[nout++] = now;
    }
}

static uint32_t count(uint32_t type, uint32_t from)   /* frames of type sent since index from */
{
    uint32_t i, c = 0;
    for (i = from; i < nout; i++) c += out[i].type == type;
    return c;
}
static const fm1c_msg *last(uint32_t type)
{
    uint32_t i = nout;
    while (i--) if (out[i].type == type) return &out[i];
    return 0;
}

static uint8_t hseq;
static uint32_t host_frame(const fm1c_msg *m, uint8_t *b, uint32_t seq) { return fm1c_encode(m, seq, b); }
static int rx(fm1c_link *l, const fm1c_msg *m, fm1c_msg *got)   /* the host sends m with its next SEQ */
{
    uint8_t b[FM1C_MAX_FRAME];
    uint32_t n = host_frame(m, b, hseq);
    hseq = (uint8_t)((hseq + 1u) & 127u);
    return fm1c_link_rx(l, b, n, now, got);
}
static int rx_seq(fm1c_link *l, const fm1c_msg *m, uint32_t seq, fm1c_msg *got)
{
    uint8_t b[FM1C_MAX_FRAME];
    uint32_t n = host_frame(m, b, seq);
    return fm1c_link_rx(l, b, n, now, got);
}
static void run_to(fm1c_link *l, uint32_t t) { while (now < t) { now++; fm1c_link_tick(l, now); } }

static fm1c_msg mk(uint32_t type)
{
    fm1c_msg m;
    memset(&m, 0, sizeof m);
    m.type = (uint8_t)type;
    return m;
}
static fm1c_msg hello_ack(uint32_t proto, uint32_t session, const char *reason)
{
    fm1c_msg m = mk(FM1C_T_HELLO_ACK);
    m.u.hello_ack.proto = (uint8_t)proto;
    m.u.hello_ack.session = (uint16_t)session;
    strncpy(m.u.hello_ack.reason, reason, FM1C_L_REASON);
    return m;
}
static fm1c_msg slot(uint32_t key, const char *label)
{
    fm1c_msg m = mk(FM1C_T_SET_SLOT);
    m.u.slot.key = (uint8_t)key;
    m.u.slot.state = FM1C_S_WORKING;
    strncpy(m.u.slot.label, label, FM1C_L_LABEL);
    return m;
}
static fm1c_msg key_msg(uint32_t key)
{
    fm1c_msg m = mk(FM1C_T_KEY);
    m.u.key.key = (uint8_t)key;
    m.u.key.gesture = FM1C_G_SINGLE;
    return m;
}

static const uint8_t FW[3] = {0, 1, 0};

static void start(fm1c_link *l)
{
    nout = 0;
    now = 0;
    hseq = 0;
    fm1c_link_init(l, now, 0x2345u, FW, emit, 0);
}

static void negotiate(fm1c_link *l, uint32_t session)
{
    fm1c_msg ha = hello_ack(1, session, ""), got;
    CHECK(rx(l, &ha, &got) == 1 && got.type == FM1C_T_HELLO_ACK, "HELLO_ACK reaches the app");
}

static void test_hello(void)
{
    static fm1c_link l;
    fm1c_msg got;
    const fm1c_msg *h;
    uint32_t ev, mark;
    start(&l);
    CHECK(nout == 1 && out[0].type == FM1C_T_HELLO && out[0].seq == 0, "HELLO at boot, SEQ 0");
    h = &out[0];
    CHECK(h->u.hello.pmin == 1 && h->u.hello.pmax == 7 && h->u.hello.fw_minor == 1 && h->u.hello.boot_id == 0x2345u,
          "HELLO carries proto 1..7, fw 0.1.0, the boot id");
    run_to(&l, 3999);
    CHECK(count(FM1C_T_HELLO, 0) == 4 && count(FM1C_T_DEV_HB, 0) == 3, "HELLO every 1000 ms, HEARTBEAT every 1000 ms (%u, %u)",
          count(FM1C_T_HELLO, 0), count(FM1C_T_DEV_HB, 0));
    CHECK(out_t[nout - 1] == 3000 && l.alive == 0, "the last at 3000 ms; no host yet");
    negotiate(&l, 77);
    ev = fm1c_link_events(&l);
    CHECK(ev == (FM1C_EV_ALIVE | FM1C_EV_NEGOTIATED | FM1C_EV_NEW_SESSION), "events alive, negotiated, new session (%x)", ev);
    CHECK(last(FM1C_T_DEV_ACK)->u.ack.seq == 0 && last(FM1C_T_DEV_ACK)->u.ack.status == FM1C_ACK_OK, "HELLO_ACK acknowledged");
    mark = nout;
    run_to(&l, 6000);
    CHECK(count(FM1C_T_HELLO, mark) == 0, "no HELLO once negotiated");
    {   /* the host keeps talking: heartbeats keep the link up */
        fm1c_msg hb = mk(FM1C_T_HOST_HB);
        hb.u.hhb.uptime_s = 5;
        mark = nout;
        CHECK(rx(&l, &hb, &got) == 0, "a host HEARTBEAT is the link's");
        CHECK(nout == mark, "and is not acknowledged");
    }
}

static void test_retransmit(void)
{
    static fm1c_link l;
    fm1c_msg k = key_msg(4), got, ack = mk(FM1C_T_HOST_ACK);
    uint32_t mark, i;
    int32_t seq;
    start(&l);
    k = key_msg(4);
    CHECK(fm1c_link_send(&l, &k, now) == -1 && nout == 1, "no input frames before a version is agreed");
    negotiate(&l, 1);
    fm1c_link_events(&l);
    run_to(&l, 100);
    mark = nout;
    seq = fm1c_link_send(&l, &k, now);
    CHECK(seq >= 0 && count(FM1C_T_KEY, mark) == 1, "KEY sent");
    run_to(&l, 349);
    CHECK(count(FM1C_T_KEY, mark) == 1, "nothing again before 250 ms");
    run_to(&l, 350);
    CHECK(count(FM1C_T_KEY, mark) == 2 && last(FM1C_T_KEY)->seq == seq, "retransmitted at 250 ms with the same SEQ");
    run_to(&l, 1099);
    CHECK(count(FM1C_T_KEY, mark) == 4 && !l.fault, "three retransmissions (at 250, 500, 750 ms), no fault yet");
    for (i = mark; i < nout; i++)
        if (out[i].type == FM1C_T_KEY) CHECK(out_t[i] == 100 || out_t[i] == 350 || out_t[i] == 600 || out_t[i] == 850, "at %u", out_t[i]);
    run_to(&l, 1100);
    CHECK(l.fault && (fm1c_link_events(&l) & FM1C_EV_FAULT) && count(FM1C_T_KEY, mark) == 4, "fault at 1000 ms, no fifth send");
    run_to(&l, 2000);
    CHECK(count(FM1C_T_KEY, mark) == 4, "and nothing after");

    mark = nout;
    seq = fm1c_link_send(&l, &k, now);
    ack.u.ack.seq = (uint8_t)seq;
    CHECK(rx(&l, &ack, &got) == 0 && !l.fault && l.acked == 1, "an ACK settles it and clears the fault");
    run_to(&l, 3000);
    CHECK(count(FM1C_T_KEY, mark) == 1, "an acknowledged frame is not sent again");
    ack.u.ack.status = FM1C_ACK_BUSY;
    seq = fm1c_link_send(&l, &k, now);
    ack.u.ack.seq = (uint8_t)seq;
    rx(&l, &ack, &got);
    CHECK(!l.pend[seq].used, "a busy ACK counts as acknowledged");
}

static void test_dedup(void)
{
    static fm1c_link l;
    fm1c_msg s = slot(3, "api"), s2 = slot(3, "web"), got;
    uint32_t mark, i;
    start(&l);
    negotiate(&l, 1);
    CHECK(rx_seq(&l, &s, 10, &got) == 1 && got.u.slot.key == 3, "SET_SLOT seq 10 processed");
    mark = nout;
    CHECK(rx_seq(&l, &s, 10, &got) == 0, "the same frame again is not processed");
    CHECK(nout == mark + 1 && out[mark].type == FM1C_T_DEV_ACK && out[mark].u.ack.seq == 10 && out[mark].u.ack.status == 0,
          "but acknowledged again");
    CHECK(rx_seq(&l, &s2, 10, &got) == 1, "the same SEQ with other content (after a wrap) is new");
    for (i = 0; i < FM1C_WIN; i++) rx_seq(&l, &s, 20u + i, &got);   /* 32 newer frames push seq 10 out */
    CHECK(rx_seq(&l, &s2, 10, &got) == 1, "beyond the 32-frame window it is processed again");
    for (i = 0; i < 40u; i++) rx_seq(&l, &s, i, &got);
    CHECK(l.win_n == FM1C_WIN, "the window holds 32");
}

static void test_invalid(void)
{
    static fm1c_link l;
    uint8_t b[FM1C_MAX_FRAME];
    fm1c_msg got, s = slot(1, "x");
    uint32_t n, mark;
    start(&l);
    n = fm1c_encode(&s, 5, b);
    b[n - 1] ^= 1;                              /* bad checksum: dropped, counted, no ACK, not a sign of life */
    mark = nout;
    CHECK(fm1c_link_rx(&l, b, n, now, &got) == 0 && nout == mark && l.rx_errors == 1 && !l.alive, "bad checksum ignored");
    b[0] = 0x4D; b[1] = 6; b[2] = 0; b[3] = fm1c_checksum(b, 0);
    CHECK(fm1c_link_rx(&l, b, 4, now, &got) == 0, "unknown type not processed");
    CHECK(nout == mark + 1 && out[mark].type == FM1C_T_DEV_ACK && out[mark].u.ack.seq == 6 &&
          out[mark].u.ack.status == FM1C_ACK_UNKNOWN_TYPE && l.alive, "ACKed with status 1 (unknown type)");
    b[0] = FM1C_T_SET_SLOT; b[1] = 7; b[2] = 4; b[3] = 30; b[4] = 0; b[5] = 0; b[6] = 0; b[7] = fm1c_checksum(b, 4);
    mark = nout;
    CHECK(fm1c_link_rx(&l, b, 8, now, &got) == 0 && out[mark].u.ack.status == FM1C_ACK_BAD_BODY, "key 30: ACK status 2 (bad body)");
    mark = nout;
    CHECK(fm1c_link_rx(&l, b, 8, now, &got) == 0 && out[mark].u.ack.status == FM1C_ACK_BAD_BODY, "its retransmission: status 2 again");
    b[0] = FM1C_T_KEY; b[1] = 8; b[2] = 2; b[3] = 1; b[4] = 1; b[5] = fm1c_checksum(b, 2);
    mark = nout;
    CHECK(fm1c_link_rx(&l, b, 6, now, &got) == 0 && out[mark].u.ack.status == FM1C_ACK_UNKNOWN_TYPE, "a device type from the host: unknown");
    b[0] = 0x43; b[1] = 0x80;                   /* not 7-bit */
    CHECK(fm1c_link_rx(&l, b, 6, now, &got) == 0 && l.rx_errors == 6, "rx errors counted (%u)", l.rx_errors);
    l.rx_errors = 500;
    run_to(&l, 1000);
    CHECK(last(FM1C_T_DEV_HB)->u.dhb.rx_errors == 127, "heartbeat rx_errors saturates at 127");
}

static void test_lost(void)
{
    static fm1c_link l;
    fm1c_msg k = key_msg(1), got, hb = mk(FM1C_T_HOST_HB);
    uint32_t mark;
    start(&l);
    negotiate(&l, 9);
    fm1c_link_events(&l);
    run_to(&l, 1000);
    hb.u.hhb.uptime_s = 1;
    rx(&l, &hb, &got);
    fm1c_link_send(&l, &k, now);
    run_to(&l, 4499);
    CHECK(l.alive && l.proto == 1, "alive 3499 ms after the last host frame");
    run_to(&l, 4500);
    CHECK(!l.alive && !l.proto && (fm1c_link_events(&l) & FM1C_EV_LOST), "host lost at 3500 ms");
    CHECK(!l.pend[last(FM1C_T_KEY)->seq].used && !l.fault, "its pending frames dropped without a fault");
    CHECK(fm1c_link_send(&l, &k, now) == -1, "no input frames with no host");
    mark = nout;
    run_to(&l, 6500);
    CHECK(count(FM1C_T_HELLO, mark) == 2 && count(FM1C_T_DEV_HB, mark) == 2, "HELLO and HEARTBEAT every second meanwhile");
    negotiate(&l, 9);
    CHECK(fm1c_link_events(&l) == (FM1C_EV_ALIVE | FM1C_EV_NEGOTIATED), "reconnect, the same companion: no new session");
}

static void test_incompatible(void)
{
    static fm1c_link l;
    fm1c_msg ha = hello_ack(0, 3, "host too old (0-0)"), got;
    uint32_t mark;
    start(&l);
    CHECK(rx(&l, &ha, &got) == 1, "HELLO_ACK 0 reaches the app");
    CHECK(l.incompatible && !l.proto && (fm1c_link_events(&l) & FM1C_EV_INCOMPATIBLE) && !strcmp(l.reason, "host too old (0-0)"),
          "incompatible, with the reason");
    ha = hello_ack(8, 3, "");                    /* a version this device does not speak */
    rx(&l, &ha, &got);
    CHECK(l.incompatible && !l.proto, "proto 8 is incompatible too");
    mark = nout;
    run_to(&l, 2000);
    CHECK(count(FM1C_T_HELLO, mark) == 2, "HELLO goes on");
    negotiate(&l, 3);
    CHECK(!l.incompatible && l.proto == 1, "a later HELLO_ACK 1 links");
}

/* docs/ux-v2.md sections 4 and 7: version 2 is a rendering marker on the same wire format, version 3 adds SET_TEXT
 * and view 5; the device speaks 1..3 */
static void test_version2(void)
{
    static fm1c_link l;
    fm1c_msg ha = hello_ack(2, 11, ""), got;
    start(&l);
    CHECK(rx(&l, &ha, &got) == 1 && l.proto == 2 && !l.incompatible && (fm1c_link_events(&l) & FM1C_EV_NEGOTIATED),
          "HELLO_ACK 2 links at version 2");
    ha = hello_ack(1, 12, "");
    CHECK(rx(&l, &ha, &got) == 1 && l.proto == 1, "an old companion (HELLO_ACK 1) links at version 1");
    ha = hello_ack(3, 13, "");
    CHECK(rx(&l, &ha, &got) == 1 && l.proto == 3 && !l.incompatible, "HELLO_ACK 3 links at version 3 (DETAILS)");
    ha = hello_ack(4, 14, "");
    CHECK(rx(&l, &ha, &got) == 1 && l.proto == 4 && !l.incompatible, "HELLO_ACK 4 links at version 4 (the characters)");
    ha = hello_ack(5, 16, "");
    CHECK(rx(&l, &ha, &got) == 1 && l.proto == 5 && !l.incompatible, "HELLO_ACK 5 links at version 5 (the LIST layout)");
    ha = hello_ack(3, 15, "");
    CHECK(rx(&l, &ha, &got) == 1 && l.proto == 3 && !l.incompatible, "a version 3 companion after it: version 3 again");
    ha = hello_ack(6, 17, "");
    CHECK(rx(&l, &ha, &got) == 1 && l.proto == 6 && !l.incompatible, "HELLO_ACK 6 links at version 6 (SPLIT keys, settings)");
    ha = hello_ack(5, 18, "");
    CHECK(rx(&l, &ha, &got) == 1 && l.proto == 5 && !l.incompatible, "a version 5 companion after it: version 5 again");
    ha = hello_ack(7, 19, "");
    CHECK(rx(&l, &ha, &got) == 1 && l.proto == 7 && !l.incompatible, "HELLO_ACK 7 links at version 7 (rich text)");
    ha = hello_ack(6, 20, "");
    CHECK(rx(&l, &ha, &got) == 1 && l.proto == 6 && !l.incompatible, "a version 6 companion after it: version 6 again");
    ha = hello_ack(8, 21, "");
    CHECK(rx(&l, &ha, &got) == 1 && l.proto == 0 && l.incompatible, "HELLO_ACK 8: incompatible (this firmware speaks 1..7)");
}

/* fm1c_link_busy (docs/ui-v3.md section 6.1): true while a sent input frame awaits its ACK, so the animation waits */
static void test_busy(void)
{
    static fm1c_link l;
    fm1c_msg k = key_msg(3), got, ack = mk(FM1C_T_HOST_ACK);
    int32_t seq;
    start(&l);
    negotiate(&l, 21);
    CHECK(!fm1c_link_busy(&l), "linked, nothing sent: not busy");
    seq = fm1c_link_send(&l, &k, now);
    CHECK(seq >= 0 && fm1c_link_busy(&l), "a KEY awaiting its ACK: busy");
    run_to(&l, now + 300);
    CHECK(fm1c_link_busy(&l), "retransmitted, still unacknowledged: busy");
    ack.u.ack.seq = (uint8_t)seq;
    rx(&l, &ack, &got);
    CHECK(!fm1c_link_busy(&l), "ACKed: not busy");
    seq = fm1c_link_send(&l, &k, now);
    run_to(&l, now + 1100);
    CHECK(!fm1c_link_busy(&l), "given up after 3 retransmissions (a fault): not busy");
}

static void test_restart(void)
{
    static fm1c_link l;
    fm1c_msg hb = mk(FM1C_T_HOST_HB), got, s = slot(2, "a");
    uint32_t mark;
    start(&l);
    negotiate(&l, 5);
    fm1c_link_events(&l);
    hb.u.hhb.uptime_s = 16383;
    rx(&l, &hb, &got);
    hb.u.hhb.uptime_s = 0;
    rx(&l, &hb, &got);
    CHECK(l.proto == 1 && !(fm1c_link_events(&l) & FM1C_EV_RESTART), "the u14 uptime wrapping is not a restart");
    hb.u.hhb.uptime_s = 50;
    rx(&l, &hb, &got);
    rx_seq(&l, &s, 40, &got);
    hb.u.hhb.uptime_s = 1;                      /* the companion restarted within 3500 ms */
    rx(&l, &hb, &got);
    CHECK(!l.proto && (fm1c_link_events(&l) & FM1C_EV_RESTART), "uptime going back: renegotiate");
    mark = nout;
    run_to(&l, now + 1);
    CHECK(count(FM1C_T_HELLO, mark) == 1, "HELLO at once");
    negotiate(&l, 6);
    CHECK(fm1c_link_events(&l) & FM1C_EV_NEW_SESSION, "the new companion's session");
    CHECK(rx_seq(&l, &s, 40, &got) == 1, "its frames are not taken for the old one's duplicates");
}

static void test_seq_wrap(void)
{
    static fm1c_link l;
    fm1c_msg k = key_msg(0), got, ack = mk(FM1C_T_HOST_ACK);
    uint32_t i;
    int32_t seq = 0;
    start(&l);
    negotiate(&l, 1);
    for (i = 0; i < 200u; i++) {
        seq = fm1c_link_send(&l, &k, now);
        ack.u.ack.seq = (uint8_t)seq;
        rx(&l, &ack, &got);
    }
    CHECK(seq == (int32_t)((2u + 200u - 1u) & 127u), "SEQ wraps at 128 (last %d)", seq);
    CHECK(l.faults == 0, "no faults with every frame acknowledged");
}

static void test_hello_soon(void)
{
    static fm1c_link l;
    uint32_t mark;
    start(&l);
    run_to(&l, 300);
    mark = nout;
    fm1c_link_hello_soon(&l, now);
    run_to(&l, 301);
    CHECK(count(FM1C_T_HELLO, mark) == 1 && out_t[nout - 1] == 301, "cable up: HELLO at the next tick");
    run_to(&l, 1301);
    CHECK(count(FM1C_T_HELLO, mark) == 2 && last(FM1C_T_HELLO) == &out[nout - 1] && out_t[nout - 1] == 1301,
          "then every second from there");
    negotiate(&l, 1);
    mark = nout;
    fm1c_link_hello_soon(&l, now);
    run_to(&l, 1400);
    CHECK(count(FM1C_T_HELLO, mark) == 0, "not once linked");
}

/* A new companion after the host was lost starts its SEQ again: a frame of the old run that happens to share SEQ
 * and the 7-bit checksum with the new run's HELLO_ACK must not swallow it as a duplicate. */
static void test_lost_then_new_run(void)
{
    static fm1c_link l;
    fm1c_msg ha = hello_ack(1, 10, ""), s = slot(4, "a"), got;
    uint8_t b[FM1C_MAX_FRAME];
    uint32_t ck, c;
    start(&l);
    negotiate(&l, 9);
    fm1c_link_events(&l);
    ck = b[fm1c_encode(&ha, 1, b) - 1u];
    for (c = 0; c < 95u * 8u; c++) {            /* an old-run SET_SLOT at SEQ 1 with the same checksum */
        s.u.slot.state = (uint8_t)(c / 95u);
        s.u.slot.label[0] = (char)(0x20u + c % 95u);
        if (b[fm1c_encode(&s, 1, b) - 1u] == ck) break;
    }
    CHECK(c < 95u * 8u, "a colliding SET_SLOT exists");
    CHECK(rx_seq(&l, &s, 1, &got) == 1, "the old run's SET_SLOT at SEQ 1");
    run_to(&l, now + FM1C_LOST_MS);
    CHECK(!l.alive && (fm1c_link_events(&l) & FM1C_EV_LOST), "host lost");
    CHECK(rx_seq(&l, &ha, 1, &got) == 1 && l.proto == 1, "the new run's HELLO_ACK at SEQ 1 is processed");
    CHECK(fm1c_link_events(&l) & FM1C_EV_NEW_SESSION, "as a new session");
}

/* The same companion answering a second HELLO (its HELLO_ACK crossed our next HELLO): nothing restarted, so the
 * inputs in flight stay tracked and its earlier frames stay duplicates. */
static void test_repeated_hello_ack(void)
{
    static fm1c_link l;
    fm1c_msg ha = hello_ack(1, 5, ""), k = key_msg(2), s = slot(1, "x"), got, ack = mk(FM1C_T_HOST_ACK);
    int32_t seq;
    start(&l);
    negotiate(&l, 5);
    fm1c_link_events(&l);
    CHECK(rx(&l, &s, &got) == 1, "SET_SLOT processed");
    seq = fm1c_link_send(&l, &k, now);
    CHECK(rx(&l, &ha, &got) == 1 && l.proto == 1, "the second HELLO_ACK reaches the app");
    CHECK(!(fm1c_link_events(&l) & FM1C_EV_NEW_SESSION), "not a new session");
    CHECK(seq >= 0 && l.pend[seq].used, "the KEY in flight is still tracked");
    CHECK(rx_seq(&l, &s, 1, &got) == 0, "the SET_SLOT retransmitted is still a duplicate");
    ack.u.ack.seq = (uint8_t)seq;
    rx(&l, &ack, &got);
    CHECK(!l.pend[seq].used && l.acked == 1, "and its ACK settles the KEY");
    ha = hello_ack(1, 6, "");
    seq = fm1c_link_send(&l, &k, now);
    CHECK(rx(&l, &ha, &got) == 1 && !l.pend[seq].used, "another session's HELLO_ACK drops what was in flight");
}

int main(void)
{
    test_hello();
    test_hello_soon();
    test_retransmit();
    test_dedup();
    test_invalid();
    test_lost();
    test_incompatible();
    test_version2();
    test_busy();
    test_restart();
    test_seq_wrap();
    test_lost_then_new_run();
    test_repeated_hello_ack();
    T_DONE("link_test");
}
