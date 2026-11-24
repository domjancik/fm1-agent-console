/* SPDX-License-Identifier: GPL-3.0-only */
/* FM1 CONSOLE: the FM-1 as the panel of a coding-agent console. The companion on the computer owns the sessions,
 * the navigation and every decision; this app reads the panel, sends what happened (docs/protocol.md, CC frames
 * on MIDI channel 16), and draws and lights what the companion last said. No sound, no flash writes.
 *
 *   keys       KEY frames: down / up at once, single / double / long by timing (fm1c_input.h)
 *   buttons    BUTTON frames, both edges (REC is push-to-talk on the companion)
 *   encoders   ENCODER frames, detents summed, at most every 20 ms each
 *   MASTER     POT frames, smoothed, 8-count deadband, at most every 50 ms
 *   screen     docs/firmware-ui.md; only the regions that changed are drawn, the MIDI is read meanwhile (LCD_IDLE)
 *   LEDs       docs/protocol.md section 6
 *   no host    after 3500 ms without a frame: NO COMPANION over the dimmed screen, key LEDs glow, OCT+ blinks,
 *              HELLO every second until the companion answers
 *   help       version 2 or later agreed: SCL held 400 ms shows what each control does (fm1c_help.h); meanwhile only
 *              SCL's edges go out (fm1c_input.h), host frames still update the model, and letting go redraws all
 *   list       version 5 agreed (docs/ui-v3.md section 8): SET_VIEW's layout byte draws Sessions and TO DO as a list
 *              (fm1c_draw5.h); the host toggles it on SEQ, the SEQ LED is lit while it shows
 *   characters version 4 agreed (docs/ui-v3.md): the sprites animate on passes that drew no content, with no host
 *              frame queued, no device frame awaiting its ACK and 20 ms after the last host frame, at most
 *              FM1C_ANIM_PX_PASS pixels a pass (fm1c_anim.h); a K1-K4 turn shows the knob row for 2 s. Content
 *              is drawn a region at a time, stopping when a host frame came in (fm1c_yield), and not at all while a
 *              burst of host frames is still arriving (draw_held), so ACKs never wait behind the screen
 *
 * Built by tools/build.py (the unity build: platform.c first, then fm1c_*.h). tests/console/ runs it on the host. */
#define APP_NAME "FM1 CONSOLE"
#define FELUCCA_UAC 0                           /* MIDI only: no USB audio input for macOS to pick as a microphone */
#define CV_MAX (240u * 80u)                     /* the biggest canvas: the banner (208 x 80; version 4: 208 x 64 twice), the
                                                 * key strip (240 x 64), the help's chunks (240 x 80) */
static void app_idle(void);
#define LCD_IDLE app_idle                       /* while a strip goes out: MIDI in and out (lcd.c) */
#define FM1_GLOW_NS 8000u                       /* the glow layer (hal/fm1_input.h default 4000: ~1/24 of lit), doubled
                                                 * so the active-button glow reads (operator 2026-11-22); keys glow too */
#include "platform.c"
#if defined(DINGHY_HOST) && defined(FM1C_BLE)
#undef FM1C_BLE                                 /* host mode has no radio: the USB build's behaviour */
#endif

#if BOARD_SMK37
#error "FM1 CONSOLE is an FM-1 firmware (key LEDs, the panel ids of docs/firmware-controls.md)"
#endif
/* the protocol's button and encoder ids are the HAL's (docs/firmware-controls.md) */
_Static_assert(BTN_OCT_DOWN == 0 && BTN_OCT_UP == 1 && BTN_FX == 2 && BTN_SEL == 3 && BTN_ENV == 4 && BTN_LFO == 5 &&
               BTN_EDIT == 6 && BTN_GLO == 7 && BTN_HOME == 8 && BTN_SAVE == 9 && BTN_ARP == 10 && BTN_SEQ == 11 &&
               BTN_PLAY == 12 && BTN_REC == 13, "button ids");
_Static_assert(ENC_SELECT == 0 && ENC_ALGORITHM == 1 && ENC_KNOB1 == 2 && ENC_KNOB4 == 5 && ENC_PRESETS == 6, "encoder ids");

#define FM1C_ENCODE_DEVICE_ONLY                 /* the device encodes only its own messages (fm1c_proto.h) */
#include "fm1c_proto.h"
#include "fm1c_frame.h"
#include "fm1c_link.h"
#include "fm1c_input.h"
#include "fm1c_led.h"
#include "fm1c_model.h"
#include "fm1c_draw.h"
#if FM1C_BLE
#include "fm1c_ble.h"                           /* the same frames over Bluetooth LE MIDI too (tools/build.py --ble) */
#endif

static const uint8_t FW_VERSION[3] = {0, 1, 0};   /* HELLO's fw_major, fw_minor, fw_patch */

/* ---- the few places host mode differs (tests/host.c stands in for the platform there) */
#ifdef DINGHY_HOST
static int port_usb_up(void) { return 1; }
static uint32_t port_tx_room(void) { return 64u; }
static uint32_t port_seed(void) { return 0x1234u; }   /* (a fixed boot id: the tests compare it) */
static uint32_t port_keys(uint32_t *edges) { *edges = fm1_input_note_edges(); return fm1_in.notes; }
#else
static int port_usb_up(void) { return usb.config != 0; }
static uint32_t port_tx_room(void) { return MQ - (mo_w - mo_r); }   /* free slots in usb.c's MIDI out ring */
static uint32_t port_seed(void)                 /* per boot: the boot's timing jitter and the battery ADC's noise */
{
    int32_t a = fm1_adc_read(FM1_ADC_BATT);
    return fm1_ticks() ^ (uint32_t)(a < 0 ? 0 : a) << 5 ^ fm1_ms * 2654435761u;
}
/* The held keys and the presses latched since, in one critical section: read apart, a press landing between the
 * two reads looks like a finished tap and then a second down, which the gesture timer turns into a double. */
static uint32_t port_keys(uint32_t *edges)
{
    uint32_t k = fm1__lock(), held = fm1_in.notes;
    *edges = fm1_in.notes_pressed;
    fm1_in.notes_pressed = 0;
    fm1__unlock(k);
    return held;
}
#endif

/* ---- MIDI out: frames as CC words, sent as usb.c's ring takes them (it drops what does not fit) */
#define TXQ 1024u
static uint16_t txq[TXQ];
static uint32_t txq_w, txq_r, tx_dropped;

static void tx_frame(void *ctx, const uint8_t *payload, uint32_t n)
{
    uint16_t w[FM1C_MAX_FRAME + 2u];
    uint32_t k = fm1c_frame_ccs(payload, n, FM1C_CC_DEV_CTL, FM1C_CC_DEV_DATA, w), i;
    (void)ctx;
    if (TXQ - (txq_w - txq_r) < k) { tx_dropped++; return; }   /* (an ACKed frame is sent again; the rest repeats) */
    for (i = 0; i < k; i++) txq[txq_w++ % TXQ] = w[i];
#if FM1C_BLE
    if (fm1c_ble_state() == FM1C_BLE_READY && fm1c_ble_tx_room() >= k)   /* whole frames only, as on USB */
        for (i = 0; i < k; i++) fm1c_ble_put(fm1c_ble_pkt(FM1C_CC_STATUS, w[i] >> 8, w[i] & 0x7Fu), fm1_ms);
#endif
}

static void tx_drain(void)
{
    uint32_t room;
    if (!port_usb_up()) { txq_r = txq_w; return; }   /* no host on the cable: nothing stale for the next one */
    room = port_tx_room();
    while (room-- && txq_r != txq_w) {
        uint16_t w = txq[txq_r++ % TXQ];
        midi_send(FM1C_CC_STATUS, w >> 8, w & 0x7Fu);
    }
}

/* ---- MIDI in: whole frames into a small queue; parsed in the main loop, not while drawing */
#define RXQ 8u
static fm1c_asm rx_asm;
#if FM1C_BLE
static fm1c_asm rx_asm_ble;
#endif
static uint8_t rxq[RXQ][FM1C_MAX_FRAME], rxq_n[RXQ];
static uint32_t rxq_w, rxq_r;

static void rx_pump(void)
{
    uint8_t st, d1, d2;
    while (rxq_w - rxq_r < RXQ && midi_get(&st, &d1, &d2)) {   /* full: the rest waits in usb.c (the host is held) */
        int32_t n = fm1c_asm_push(&rx_asm, st, d1, d2), i;
        if (n < 0) continue;
        for (i = 0; i < n; i++) rxq[rxq_w % RXQ][i] = rx_asm.buf[i];
        rxq_n[rxq_w % RXQ] = (uint8_t)n;
        rxq_w++;
    }
#if FM1C_BLE
    {                                           /* BLE's frames: an assembler of their own, never interleaved with USB's */
        uint32_t pkt;
        while (rxq_w - rxq_r < RXQ && fm1c_ble_get(&pkt)) {
            int32_t n, i;
            if (!fm1c_ble_unpkt(pkt, &st, &d1, &d2)) continue;
            if ((n = fm1c_asm_push(&rx_asm_ble, st, d1, d2)) < 0) continue;
            for (i = 0; i < n; i++) rxq[rxq_w % RXQ][i] = rx_asm_ble.buf[i];
            rxq_n[rxq_w % RXQ] = (uint8_t)n;
            rxq_w++;
        }
    }
#endif
}

static uint8_t idle_ok, usb_was_up;
static uint32_t last_host_rx;                   /* when the last host frame was parsed (the animation waits 20 ms) */
static void app_idle(void)
{
    if (!idle_ok) return;
    idle_ok = 0;                                /* (never inside itself) */
    rx_pump();
    tx_drain();
    idle_ok = 1;
}

/* ---- the app */
static fm1c_link lnk;
static fm1c_model model;
static fm1c_keys keys;
static fm1c_encs encs;
static fm1c_pot pot;
static fm1c_help help;

static void send_input(fm1c_msg *m) { fm1c_link_send(&lnk, m, fm1_ms); }

static void on_key(void *ctx, uint32_t key, uint32_t gesture)
{
    fm1c_msg m;
    (void)ctx;
    if (!fm1c_help_key(&help, key, gesture)) return;   /* (under the help) */
    fm1c_zero(&m, sizeof m);
    m.type = FM1C_T_KEY;
    m.u.key.key = (uint8_t)key;
    m.u.key.gesture = (uint8_t)gesture;
    send_input(&m);
}

static void on_button(void *ctx, uint32_t button, uint32_t edge)
{
    fm1c_msg m;
    (void)ctx;
    if (!fm1c_help_button(&help, button, edge)) return;   /* (under the help: SCL's edges only) */
    fm1c_zero(&m, sizeof m);
    m.type = FM1C_T_BUTTON;
    m.u.button.button = (uint8_t)button;
    m.u.button.edge = (uint8_t)edge;
    send_input(&m);
}

static void send_pot(int32_t v)
{
    fm1c_msg m;
    fm1c_zero(&m, sizeof m);
    m.type = FM1C_T_POT;
    m.u.pot.pot = 0;
    m.u.pot.value = (uint16_t)v;
    send_input(&m);
}

static void read_panel(uint32_t now)
{
    static uint32_t prev_notes, t_pot;
    uint32_t rel, pressed = fm1_input_edges(&rel), nedges, notes = port_keys(&nedges) & FM1C_KEYS_ALL, e, on;
    on = fm1c_help_tick(&help, fm1_in.buttons >> BTN_SEL & 1u, fm1c_v2(&model) && model.conn == FM1C_C_OK, now);
    if (pressed || rel || (nedges & FM1C_KEYS_ALL) || notes != prev_notes)   /* (section 9.10; a key down: a press, 9.10.1) */
        fm1c_trans_input(&model, now, (notes & ~prev_notes) != 0u);
    if ((on ? 1u : 0u) != model.help) {         /* the help opens or closes: what was drawn before it is no trigger */
        fm1c_trans_finish(&model);
        fm1c_sn.valid = 0;
    }
    fm1c_model_help(&model, on);
    fm1c_buttons_scan(pressed, rel, fm1_in.buttons, on_button, 0);
    fm1c_keys_scan(&keys, notes, prev_notes, nedges & FM1C_KEYS_ALL, now);
    prev_notes = notes;
    for (e = 0; e < FM1C_N_ENCODER; e++) {
        int32_t steps = fm1_enc_take(e), d;
        if (steps) fm1c_trans_input(&model, now, 1);   /* (an encoder edge completes a transition at once; a press) */
        if (!lnk.proto || help.on) { encs.owed[e] = 0; continue; }   /* turns with no host or under the help: dropped */
        if ((d = fm1c_enc_step(&encs, e, steps, now)) != 0) {
            fm1c_msg m;
            fm1c_zero(&m, sizeof m);
            m.type = FM1C_T_ENCODER;
            m.u.enc.encoder = (uint8_t)e;
            m.u.enc.delta = (int8_t)d;
            send_input(&m);
            fm1c_model_knob(&model, e, now);    /* (version 4, K1-K4: the knob row for 2 s) */
        }
    }
    if (now - t_pot >= 20u) {                   /* (a conversion takes some us: not every pass) */
        int32_t v = fm1c_pot_feed(&pot, fm1_adc_read(FM1_ADC_MASTER), now);
        t_pot = now;
        if (v >= 0 && lnk.proto && !help.on) send_pot(v);   /* (under the help: dropped, not owed) */
    }
}

#define NLED 41u                                /* LED ids: buttons 0..13, keys 14..40 */
static uint8_t led_now[NLED];               /* the level each LED has (0xFF: not set yet) */
/* the backlight layer (version 5 LEDs v2: the selected key alone, breathing): hal/fm1_input.h's fm1_led_bg[] and
 * fm1_led_bg_ns, set as fm1_led_key_glow sets the glow (platform.c); host mode keeps a mask and prints its changes */
#ifdef DINGHY_HOST
static uint64_t host_bg;
static uint32_t host_bg_ns;
static void led_key_bg(uint32_t id, int on)
{
    uint64_t was = host_bg;
    if (on) host_bg |= (uint64_t)1 << id; else host_bg &= ~((uint64_t)1 << id);
    if (host_bg != was) printf("%6u ms  LEDBG %011llx\n", fm1_ms, (unsigned long long)host_bg);
}
static void led_bg_ns(uint32_t ns) { host_bg_ns = ns; }
#else
static void led_key_bg(uint32_t id, int on)
{
    uint32_t p, r;
    for (p = 0; p < FM1_NCOL; p++)
        for (r = 1; r < 5u; r++)
            if (FM1_KEYMAP[r][p] == (int8_t)id) {
                if (on) fm1_led_bg[p] |= (uint8_t)(1u << r);
                else fm1_led_bg[p] &= (uint8_t)~(1u << r);
            }
}
static void led_bg_ns(uint32_t ns) { fm1_led_bg_ns = (uint16_t)ns; }
#endif
static void led_set(uint32_t id, uint32_t level)
{
    if (led_now[id] == level) return;
    led_now[id] = (uint8_t)level;
    fm1_led_key(id, level == FM1C_LED_FULL);
    fm1_led_key_glow(id, level == FM1C_LED_GLOW);
    led_key_bg(id, level == FM1C_LED_BACK);
}

static void update_leds(uint32_t now)
{
    static uint32_t breath_step = 0xFFFFFFFFu;
    fm1c_button_ctx c;
    uint32_t k, b, host = model.conn == FM1C_C_OK || model.conn == FM1C_C_WAIT;
    uint32_t v2 = model.look >= FM1C_PROTO_V5;  /* LEDs v2 (docs/ui-v3.md section 9.9): version 5, or kept from it */
    for (k = 0; k < FM1C_NSLOT; k++) {
        const fm1c_slot *s = &model.slot[k];
        uint32_t lv = v2 ? (host ? fm1c_key_level2(s->state, s->flags, now) : fm1c_key_level2_nohost(s->flags))
                         : (host ? fm1c_key_level(s->state, s->flags, now) : fm1c_key_level_nohost(s->flags));
        led_set(KEY_LED(k), lv);
    }
    if (v2 && now / FM1C_BREATH_STEP_MS != breath_step) {   /* the breathing: a new backlight pulse every 20 ms */
        breath_step = now / FM1C_BREATH_STEP_MS;
        led_bg_ns(fm1c_breath_ns(now));
    }
    c.host = (uint8_t)host;
    c.view = model.view;
    c.voice = model.voice;
    c.attention = model.attention;
    c.list = (uint8_t)fm1c_shown_layout(&model);
    c.v2 = (uint8_t)v2;
    c.dstate = model.dstate;
    for (b = 0; b < FM1C_N_BUTTON; b++) led_set(b, fm1c_button_level(b, &c, now));
}

/* version 5 transitions start only from a screen drawn this long after the link (re)started: its resync is drawn as
 * it comes (docs/ui-v3.md section 9.10) */
#define FM1C_SEEN_HOLD_MS 300u
static uint32_t seen_hold;
static void seen_take(uint32_t now)
{
    fm1c_seen_take(&model);
    if ((int32_t)(now - seen_hold) < 0) fm1c_sn.valid = 0;
}

static void link_events(uint32_t now)
{
    uint32_t ev = fm1c_link_events(&lnk), conn;
    if (ev & FM1C_EV_NEW_SESSION) fm1c_model_clear(&model);   /* another companion run: its resync fills it */
    if (ev & (FM1C_EV_NEW_SESSION | FM1C_EV_NEGOTIATED)) {   /* a resync is drawn as it comes, never as a transition */
        fm1c_trans_finish(&model);
        fm1c_sn.valid = 0;
        seen_hold = now + FM1C_SEEN_HOLD_MS;
    }
    if (ev & FM1C_EV_NEGOTIATED) {              /* the knob as it stands: the host cannot read it otherwise */
        int32_t v = pot.primed ? fm1c_pot_value(&pot) : -1;
        if (v >= 0) { pot.sent = v; pot.t_sent = now; send_pot(v); }
    }
    conn = !lnk.alive ? FM1C_C_NOHOST : lnk.incompatible ? FM1C_C_INCOMPAT : lnk.proto ? FM1C_C_OK : FM1C_C_WAIT;
    if (conn == FM1C_C_INCOMPAT && fm1c_str_set(model.reason, lnk.reason, FM1C_L_REASON)) model.dirty |= FM1C_D_BANNER;
    if (conn != model.conn) {                   /* (lost, back, incompatible) */
        fm1c_trans_finish(&model);
        fm1c_sn.valid = 0;
        seen_hold = now + FM1C_SEEN_HOLD_MS;
    }
    fm1c_model_conn(&model, conn, lnk.fault);
    fm1c_model_proto(&model, lnk.proto);        /* version 2: the layout of docs/ux-v2.md section 2.4 */
    if (!fm1c_v2(&model) || conn != FM1C_C_OK) fm1c_model_help(&model, 0);
}

/* version 4 draws a region at a time: it stops when a host frame came in meanwhile, so that frame is ACKed first */
static int host_waiting(void) { return rxq_r != rxq_w; }

/* Version 4: while host frames keep coming (a resync is ~25 frames ~1 ms apart), parse and ACK them and draw once
 * the burst pauses for FM1C_BURST_GAP_MS, never later than FM1C_BURST_MAX_MS after it began. Drawing between the
 * frames of a burst only redraws regions the next frame marks again, and it is what held the ACKs back. */
#define FM1C_BURST_GAP_MS 3u
#define FM1C_BURST_MAX_MS 120u
static uint32_t burst_t0;
static uint8_t in_burst;
static int draw_held(uint32_t now)
{
    int arriving = model.look >= FM1C_PROTO_V5 && rx_asm.open;   /* version 5: a frame half in counts as the burst going
                                                                 * on (a 40-byte SET_SLOT takes 3 ms on the wire) */
    if (!fm1c_v4(&model) || fm1c_dimmed(&model) || (now - last_host_rx >= FM1C_BURST_GAP_MS && !arriving)) { in_burst = 0; return 0; }
    if (!in_burst) { in_burst = 1; burst_t0 = now; }
    return now - burst_t0 < FM1C_BURST_MAX_MS;
}

/* the character animation may draw now (docs/ui-v3.md section 6.1): USB and BLE come first */
static int anim_ok(uint32_t now)
{
    return fm1c_v4(&model) && !model.help                                    /* (dimmed: only the banner's ghost) */
        && model.dirty == 0 && model.dirty_keys == 0 && model.dirty_rows == 0 && model.dirty_bars == 0   /* content first */
        && model.dirty_lrows == 0 && !fm1c_tr.kind                           /* (a transition: the sprites wait) */
        && rxq_r == rxq_w                                                    /* no host frame waiting to be parsed */
        && !fm1c_link_busy(&lnk)                                             /* no device frame awaiting its ACK */
        && now - last_host_rx >= 20u;                                        /* a burst (a resync) is not running */
}

static void app_audio(int32_t *out, uint32_t n) { (void)out; (void)n; }   /* silent (out comes zeroed) */

#if FM1C_BLE
/* The radio: started once, FM1C_BLE_START_MS after power-on (after the OCT- rescue check, USB up and, usually,
 * enumerated), and not at all in a boot that follows a failed one (a warm reset in a boot's first 30 s: bootguard.h),
 * so a radio start-up that hangs costs one boot, never the FM-1. A central subscribing is like the cable coming in:
 * HELLO now. */
#ifndef FM1C_BLE_START_MS
#define FM1C_BLE_START_MS 3000u
#endif
static uint8_t ble_was;
static void ble_tick(uint32_t now)
{
    uint32_t s;
    if (fm1c_ble_state() == FM1C_BLE_OFF) {
        if (now >= FM1C_BLE_START_MS && !bootguard.failed) fm1c_ble_start();
        return;
    }
    s = fm1c_ble_state();
    if (s == FM1C_BLE_READY && ble_was != FM1C_BLE_READY) fm1c_link_hello_soon(&lnk, now);
    if (s != FM1C_BLE_READY && ble_was == FM1C_BLE_READY) fm1c_ble_drop_tx();
    ble_was = (uint8_t)s;
}
#endif

static void app_main(void)
{
    fm1c_msg m;
    uint32_t i, kd;
    for (i = 0; i < NLED; i++) led_now[i] = 0xFFu;
    fm1c_asm_init(&rx_asm, FM1C_CC_HOST_CTL, FM1C_CC_HOST_DATA);
#if FM1C_BLE
    fm1c_asm_init(&rx_asm_ble, FM1C_CC_HOST_CTL, FM1C_CC_HOST_DATA);
#endif
    fm1c_model_init(&model);
    fm1c_keys_init(&keys, on_key, 0);
    fm1c_pot_init(&pot);
    fm1c_help_init(&help);
    fm1c_anim_init(&fm1c_an);
    fm1c_yield = host_waiting;
    fm1c_link_init(&lnk, fm1_ms, port_seed(), FW_VERSION, tx_frame, 0);
    usb_was_up = (uint8_t)port_usb_up();
    lcd_fill(0, 0, 240, 240, C_BLACK);
    for (;;) {
        uint32_t now;
        int up;
        platform_poll();
        now = fm1_ms;
        up = port_usb_up();
        if (up && !usb_was_up) fm1c_link_hello_soon(&lnk, now);   /* enumerated: HELLO now */
        usb_was_up = (uint8_t)up;
#if FM1C_BLE
        ble_tick(now);
#endif
        rx_pump();
        while (rxq_r != rxq_w) {
            uint32_t q = rxq_r++ % RXQ;
            last_host_rx = now;
            if (fm1c_link_rx(&lnk, rxq[q], rxq_n[q], now, &m)) {
                fm1c_trans_host(m.type);        /* (a change under a running transition: its end redraws in full) */
                fm1c_model_apply(&model, &m, now);
            }
        }
        link_events(now);
        read_panel(now);
        fm1c_link_tick(&lnk, now);
        link_events(now);
        fm1c_model_tick(&model, now);
        update_leds(now);
        idle_ok = 1;                            /* MIDI keeps moving while the regions below go out */
        fm1c_now = now;
        if (draw_held(now)) {
            /* (a burst of host frames: drawn after it) */
        } else if (fm1c_tr.kind) {              /* version 5: a transition runs (fm1c_trans.h); the rest waits */
            if (!fm1c_trans_run(&model, now, !host_waiting() && !fm1c_link_busy(&lnk))) seen_take(now);
        } else if (!host_waiting() && !fm1c_link_busy(&lnk) && fm1c_trans_detect(&model, last_host_rx > now - 120u ? last_host_rx : now)) {
            fm1c_trans_run(&model, now, 1);     /* (started: its first step is drawn on this or a later pass; the
                                                 * snapshot of what is shown is taken at its end, fm1c_tr_end) */
        } else {
            uint32_t drew = fm1c_draw(&model, &kd);
            if (drew || kd || (!fm1c_sn.valid && fm1c_v4(&model))) seen_take(now);
            fm1c_trans_drawn(&model);
            if (!drew && !kd && anim_ok(now))
                fm1c_draw_anim(&model, now, FM1C_ANIM_PX_PASS);   /* lowest priority: a pass with no content drawn */
        }
        idle_ok = 0;
        tx_drain();
    }
}
