/* SPDX-License-Identifier: GPL-3.0-only */
/* FM1C frames through the BLE-MIDI codec the FM1C_BLE build links (firmware/ble/ble_midi.c, unchanged), both ways:
 * frame -> CC words (fm1c_frame_ccs) -> USB-MIDI packets (fm1c_ble_pkt) -> BLE-MIDI packets of an ATT payload (MTU 23
 * and MTU 247) -> decoded -> fm1c_ble_unpkt -> the console's assembler -> the same payload, decoded to the same message.
 * Also: what the glue drops (SysEx, notes), a 13-bit timestamp wrap, and the packet counts of a full resync next to
 * docs/discovery/wireless.md section 4's arithmetic. Host only: no radio, no hardware header. */
#define BLE_API static
#include "ble_midi.c"
#include "fm1c_proto.h"
#include "fm1c_frame.h"
#include "fm1c_ble.h"
#include "../console/t.h"

/* ---- one direction of the link over BLE-MIDI: the encoder's packets, then the decoder */
typedef struct {
    struct ble_midi_dec dec;
    fm1c_asm as;
    uint8_t frames[64][FM1C_MAX_FRAME];
    uint32_t n[64], nframes, dropped, packets, octets;
} sink_t;

static void on_msg(void *ctx, uint32_t pkt, uint16_t ts)
{
    sink_t *s = ctx;
    uint8_t st, d1, d2;
    int32_t n;
    (void)ts;
    if (!fm1c_ble_unpkt(pkt, &st, &d1, &d2)) { s->dropped++; return; }
    if ((n = fm1c_asm_push(&s->as, st, d1, d2)) < 0) return;
    if (s->nframes < 64u) {
        memcpy(s->frames[s->nframes], s->as.buf, (size_t)n);
        s->n[s->nframes] = (uint32_t)n;
    }
    s->nframes++;
}

static void deliver(sink_t *s, const uint8_t *p, uint16_t len)
{
    s->packets++;
    s->octets += len;
    CHECK(ble_midi_dec(&s->dec, p, len, on_msg, s) == 1, "packet of %u octets has no valid header", len);
}

/* send USB-MIDI packets as one notification after another, each at most cap octets (ATT MTU - 3) */
static void send_pkts(sink_t *s, const uint32_t *pkts, uint32_t n, uint16_t cap, uint32_t t0)
{
    uint8_t buf[256];
    struct ble_midi_enc e;
    uint32_t i = 0;
    ble_midi_enc_begin(&e, buf, cap);
    while (i < n) {
        int r = ble_midi_enc_add(&e, pkts[i], t0 + i / 8u);   /* a millisecond per 8 messages */
        if (r == 1) { i++; continue; }
        CHECK(r == 0, "event %u refused (%d)", i, r);
        if (r < 0) { i++; continue; }
        CHECK(ble_midi_enc_len(&e) > 0, "a full packet with nothing in it");
        deliver(s, buf, ble_midi_enc_len(&e));
        ble_midi_enc_begin(&e, buf, cap);
    }
    if (ble_midi_enc_len(&e)) deliver(s, buf, ble_midi_enc_len(&e));
}

static void sink_init(sink_t *s, uint32_t ctl, uint32_t data)
{
    memset(s, 0, sizeof *s);
    ble_midi_dec_reset(&s->dec);
    fm1c_asm_init(&s->as, ctl, data);
}

/* ---- the frames of a full resync (the companion's, host -> device) */
static uint32_t resync(fm1c_msg *m)
{
    uint32_t k = 0, i;
    memset(m, 0, sizeof(fm1c_msg) * 32u);
    m[k].type = FM1C_T_SET_VIEW; m[k].u.view.pages = 2; strcpy(m[k].u.view.title, "SESSIONS 12345678901"); k++;
    for (i = 0; i < FM1C_NSLOT; i++, k++) {
        m[k].type = FM1C_T_SET_SLOT;
        m[k].u.slot.key = (uint8_t)i;
        m[k].u.slot.state = (uint8_t)(i % FM1C_N_STATE);
        m[k].u.slot.flags = (uint8_t)(i & 15u);
        strcpy(m[k].u.slot.label, "agent-abcdef");
    }
    m[k].type = FM1C_T_SET_DETAIL; m[k].u.detail.provider = 1; m[k].u.detail.state = 3;
    for (i = 0; i < 4u; i++) strcpy(m[k].u.detail.line[i], "a detail line of 20c");
    k++;
    m[k].type = FM1C_T_SET_LEGEND;
    for (i = 0; i < 4u; i++) strcpy(m[k].u.legend.label[i], "LEGEND");
    k++;
    m[k].type = FM1C_T_SET_VOICE; m[k].u.voice.voice = FM1C_V_RECORDING; m[k].u.voice.level = 90;
    m[k].u.voice.elapsed_ds = 1234; strcpy(m[k].u.voice.target, "the target session x"); k++;
    m[k].type = FM1C_T_SET_STATUS; strcpy(m[k].u.status.text, "all good on the link"); k++;
    return k;
}

static uint32_t frames_to_pkts(const fm1c_msg *m, uint32_t nm, uint32_t ctl, uint32_t data, uint32_t *pkts,
                               uint8_t pay[][FM1C_MAX_FRAME], uint32_t *pn)
{
    uint32_t i, j, k = 0;
    for (i = 0; i < nm; i++) {
        uint16_t w[FM1C_MAX_FRAME + 2u];
        uint32_t n = fm1c_encode(&m[i], i & 0x7Fu, pay[i]), c;
        CHECK(n > 0, "message %u (type %02x) does not encode", i, m[i].type);
        pn[i] = n;
        c = fm1c_frame_ccs(pay[i], n, ctl, data, w);
        for (j = 0; j < c; j++) pkts[k++] = fm1c_ble_pkt(FM1C_CC_STATUS, w[j] >> 8, w[j] & 0x7Fu);
    }
    return k;
}

static sink_t sk;
static uint32_t pkts[4096];
static uint8_t pay[32][FM1C_MAX_FRAME];
static uint32_t pn[32];

static void roundtrip(const char *what, const fm1c_msg *m, uint32_t nm, uint32_t ctl, uint32_t data, uint32_t from,
                      uint16_t cap, uint32_t t0, uint32_t *packets_out, uint32_t *ccs_out)
{
    uint32_t np = frames_to_pkts(m, nm, ctl, data, pkts, pay, pn), i;
    sink_init(&sk, ctl, data);
    send_pkts(&sk, pkts, np, cap, t0);
    CHECK(sk.nframes == nm, "%s cap %u: %u frames out of %u", what, cap, sk.nframes, nm);
    CHECK(sk.dropped == 0, "%s cap %u: %u messages dropped", what, cap, sk.dropped);
    CHECK(sk.as.aborted == 0 && sk.as.restarted == 0 && sk.as.overflowed == 0 && sk.as.stray == 0,
          "%s cap %u: assembler errors", what, cap);
    for (i = 0; i < nm && i < sk.nframes; i++) {
        fm1c_msg d;
        CHECK(sk.n[i] == pn[i] && memcmp(sk.frames[i], pay[i], pn[i]) == 0, "%s cap %u: frame %u differs", what, cap, i);
        CHECK(fm1c_decode(sk.frames[i], sk.n[i], from, &d) == FM1C_OK && d.type == m[i].type,
              "%s cap %u: frame %u does not decode as type %02x", what, cap, i, m[i].type);
    }
    *packets_out = sk.packets;
    *ccs_out = np;
}

int main(void)
{
    static fm1c_msg m[32];
    uint32_t nm = resync(m), p23, p247, ccs, p, c;

    /* host -> device: a full resync */
    roundtrip("resync", m, nm, FM1C_CC_HOST_CTL, FM1C_CC_HOST_DATA, FM1C_FROM_HOST, 20, 100, &p23, &ccs);
    roundtrip("resync", m, nm, FM1C_CC_HOST_CTL, FM1C_CC_HOST_DATA, FM1C_FROM_HOST, 244, 100, &p247, &c);
    printf("full resync: %u frames, %u CCs; %u notifications at MTU 23, %u at MTU 247\n", nm, ccs, p23, p247);
    /* this encoder writes a timestamp octet before every message, running status included: a packet of cap octets
     * holds 1 + (cap - 5) / 3 CCs (header, then ts + status + 2 data, then ts + 2 data each): 6 at MTU 23, 80 at MTU
     * 247. (wireless.md section 4 assumed running status without timestamps, 8 per packet: 102, not 135.) */
    CHECK(ccs == 810u, "resync: %u CCs (wireless.md section 4 counts 810)", ccs);
    CHECK(p23 == (ccs + 5u) / 6u, "MTU 23: %u packets for %u CCs, %u expected", p23, ccs, (ccs + 5u) / 6u);
    CHECK(p247 == (ccs + 79u) / 80u, "MTU 247: %u packets for %u CCs, %u expected", p247, ccs, (ccs + 79u) / 80u);

    /* the timestamps' 13 bits wrap inside the stream (8190 ms on): nothing lost */
    roundtrip("wrap", m, nm, FM1C_CC_HOST_CTL, FM1C_CC_HOST_DATA, FM1C_FROM_HOST, 20, 8190, &p, &c);

    /* device -> host: the panel's frames on the device's controllers */
    {
        fm1c_msg d[4];
        memset(d, 0, sizeof d);
        d[0].type = FM1C_T_HELLO; d[0].u.hello.pmin = 1; d[0].u.hello.pmax = 1; d[0].u.hello.fw_minor = 1;
        d[0].u.hello.boot_id = 0x1234;
        d[1].type = FM1C_T_KEY; d[1].u.key.key = 26; d[1].u.key.gesture = FM1C_G_DOUBLE;
        d[2].type = FM1C_T_ENCODER; d[2].u.enc.encoder = 6; d[2].u.enc.delta = -3;
        d[3].type = FM1C_T_DEV_HB; d[3].u.dhb.uptime_s = 600;
        roundtrip("device", d, 4, FM1C_CC_DEV_CTL, FM1C_CC_DEV_DATA, FM1C_FROM_DEVICE, 20, 0, &p, &c);
    }

    /* what never reaches the app: SysEx (the updater's trigger F0 22 24 35 7D included), notes, real time */
    {
        uint8_t st = 0, d1 = 0, d2 = 0;
        CHECK(!fm1c_ble_unpkt(0x24F04u | 0x22u << 16 | 0x24u << 24, &st, &d1, &d2), "SysEx start taken");
        CHECK(!fm1c_ble_unpkt(0x7u | 0x35u << 8 | 0x7Du << 16 | 0xF7u << 24, &st, &d1, &d2), "SysEx end taken");
        CHECK(!fm1c_ble_unpkt(0x9u | 0x90u << 8 | 60u << 16 | 100u << 24, &st, &d1, &d2), "note on taken");
        CHECK(!fm1c_ble_unpkt(0xFu | 0xF8u << 8, &st, &d1, &d2), "clock taken");
        CHECK(!fm1c_ble_unpkt(0xBu | 0x90u << 8, &st, &d1, &d2), "CIN B with a non-CC status taken");
        CHECK(fm1c_ble_unpkt(fm1c_ble_pkt(0xBF, 118, 0x7F), &st, &d1, &d2) && st == 0xBF && d1 == 118 && d2 == 0x7F,
              "a CC comes back as it went");
        CHECK(fm1c_ble_pkt(0xBF, 0xF6, 0xFF) == (0xBu | 0xBFu << 8 | 0x76u << 16 | 0x7Fu << 24), "data masked to 7 bits");
    }

    /* a SysEx over BLE-MIDI decodes (the stack passes it on) and the glue's filter drops all of it */
    {
        static const uint8_t sx[] = {0x80, 0x80, 0xF0, 0x22, 0x24, 0x35, 0x7D, 0x80, 0xF7};
        sink_init(&sk, FM1C_CC_HOST_CTL, FM1C_CC_HOST_DATA);
        deliver(&sk, sx, sizeof sx);
        CHECK(sk.dropped >= 2 && sk.nframes == 0, "SysEx: %u dropped, %u frames", sk.dropped, sk.nframes);
    }
    T_DONE("fm1c_ble");
}
