/* SPDX-License-Identifier: GPL-3.0-only */
/* LED patterns and priorities (firmware/src/fm1c_led.h, docs/protocol.md section 6), sampled over time. */
#include "t.h"
#include "fm1c_led.h"
#include "led_v2.h"                               /* fixtures/device/led-v2.json (gen_led_v2.py) */

/* the level string of a key over [0, ms) in 10 ms steps: '.' off, 'g' glow, 'F' full; run-length compressed */
static void pattern(uint32_t state, uint32_t flags, uint32_t ms, char *out, uint32_t cap)
{
    uint32_t t, run = 0;
    char cur = 0;
    out[0] = 0;
    for (t = 0; t <= ms; t += 10u) {
        uint32_t lv = t < ms ? fm1c_key_level(state, flags, t) : 9u;
        char c = lv == FM1C_LED_OFF ? '.' : lv == FM1C_LED_GLOW ? 'g' : lv == FM1C_LED_FULL ? 'F' : 0;
        if (c != cur && cur) {
            char b[16];
            snprintf(b, sizeof b, "%c%u ", cur, run * 10u);
            strncat(out, b, cap - strlen(out) - 1);
            run = 0;
        }
        cur = c;
        run++;
    }
}

static void expect(uint32_t state, uint32_t flags, uint32_t ms, const char *want, const char *what)
{
    char got[256];
    pattern(state, flags, ms, got, sizeof got);
    CHECK(!strcmp(got, want), "%s: got '%s' want '%s'", what, got, want);
}


/* LED language v2 (docs/ui-v3.md section 9.9): the timelines, the breathing table, the buttons */
static void pattern2(uint32_t state, uint32_t flags, uint32_t ms, char *out, uint32_t cap)
{
    uint32_t t, run = 0;
    char cur = 0;
    out[0] = 0;
    for (t = 0; t <= ms; t += 10u) {
        uint32_t lv = t < ms ? fm1c_key_level2(state, flags, t) : 9u;
        char c = lv == FM1C_LED_OFF ? '.' : lv == FM1C_LED_GLOW ? 'g' : lv == FM1C_LED_FULL ? 'F' : lv == FM1C_LED_BACK ? 'B' : 0;
        if (c != cur && cur) {
            char b[16];
            snprintf(b, sizeof b, "%c%u ", cur, run * 10u);
            strncat(out, b, cap - strlen(out) - 1);
            run = 0;
        }
        cur = c;
        run++;
    }
}
static void expect2(uint32_t state, uint32_t flags, uint32_t ms, const char *want, const char *what)
{
    char got[256];
    pattern2(state, flags, ms, got, sizeof got);
    CHECK(!strcmp(got, want), "v2 %s: got '%s' want '%s'", what, got, want);
}
static void leds_v2(void)
{
    fm1c_button_ctx c;
    uint32_t i, ms;
    expect2(FM1C_S_APPROVAL, 0, 1000, "F250 .250 F250 .250 ", "approval: sharp 2 Hz");
    expect2(FM1C_S_WAITING_INPUT, 0, 1260, "F120 g120 F120 g900 ", "waiting input: double blink");
    expect2(FM1C_S_FAILED, 0, 3000, "g1500 .1500 ", "failed: slow glow/off blink, never lit");
    expect2(FM1C_S_DONE_UNREAD, 0, 5000, "F150 g2350 F150 g2350 ", "completed unread: a 150 ms tick every 2.5 s");
    expect2(FM1C_S_WORKING, 0, 1000, "F1000 ", "working: steady full");
    expect2(FM1C_S_IDLE, 0, 1000, "g1000 ", "idle: glow");
    expect2(FM1C_S_DONE_READ, 0, 1000, "g1000 ", "completed read: glow");
    expect2(FM1C_S_UNKNOWN, 0, 3000, ".150 g2850 ", "unknown: a 150 ms off-wink every 3 s");
    expect2(FM1C_S_IDLE, FM1C_F_STALE, 4000, "g150 .3850 ", "stale: a glow wink every 4 s");
    expect2(FM1C_S_APPROVAL, FM1C_F_STALE, 4000, "g150 .3850 ", "stale wins over its state");
    expect2(FM1C_S_EMPTY, 0, 1000, ".1000 ", "empty: off");
    expect2(FM1C_S_DISCONNECTED, FM1C_F_STALE, 1000, ".1000 ", "disconnected: off");
    expect2(FM1C_S_WORKING, FM1C_F_SELECTED, 1000, "B1000 ", "selected: the backlight (breathing)");
    expect2(FM1C_S_IDLE, FM1C_F_SELECTED | FM1C_F_STALE, 1000, "B1000 ", "selected stale: breathing");
    expect2(FM1C_S_APPROVAL, FM1C_F_SELECTED, 1000, "F250 B250 F250 B250 ", "selected approval: its blink breaks through");
    expect2(FM1C_S_WAITING_INPUT, FM1C_F_SELECTED, 1260, "F120 B120 F120 B900 ", "selected question: double blink through");
    expect2(FM1C_S_FAILED, FM1C_F_SELECTED, 3000, ".150 B2700 .150 ", "selected failed: a 300 ms off-dip at the breath's bottom");
    CHECK(fm1c_key_level2_nohost(0) == FM1C_LED_GLOW && fm1c_key_level2_nohost(FM1C_F_SELECTED) == FM1C_LED_BACK, "v2 no host");
    CHECK(fm1c_breath_ns(0) == 12000u && fm1c_breath_ns(1500) == 48000u && fm1c_breath_ns(1519) == 48000u && fm1c_breath_ns(1520) == FM1C_BREATH_NS[74] &&
          fm1c_breath_ns(3000) == 12000u && fm1c_breath_ns(2999) == FM1C_BREATH_NS[1], "breathing: 12,000 -> 48,000 -> 12,000 ns over 3,000 ms");
    for (i = 1; i < 76u; i++) CHECK(FM1C_BREATH_NS[i] > FM1C_BREATH_NS[i - 1], "breathing table rises (%u)", i);
    for (i = 0; i < 76u; i++) CHECK(FM1C_BREATH_NS[i] >= 12000u, "breathing never goes dark (%u)", i);
    for (i = 2; i < 76u; i++) CHECK((FM1C_BREATH_NS[i] - FM1C_BREATH_NS[i - 1]) - (FM1C_BREATH_NS[i - 1] - FM1C_BREATH_NS[i - 2]) + 1200u <= 2400u,
                                    "breathing steps change gently (%u)", i);
    for (ms = 0; ms < 3000u; ms += 20u) CHECK(fm1c_breath_ns(ms) == fm1c_breath_ns(6000u - ms) || ms == 0u, "breathing symmetric (%u)", ms);
    memset(&c, 0, sizeof c);
    c.v2 = 1;
    CHECK(fm1c_button_level(FM1C_B_OCT_UP, &c, 100) == FM1C_LED_FULL && fm1c_button_level(FM1C_B_OCT_UP, &c, 600) == FM1C_LED_OFF, "v2 no host: OCT+");
    c.host = 1;
    c.view = FM1C_VIEW_SESSIONS;
    c.dstate = FM1C_S_APPROVAL;
    CHECK(fm1c_button_level(FM1C_B_SAVE, &c, 0) == FM1C_LED_FULL && fm1c_button_level(FM1C_B_SAVE, &c, 130) == FM1C_LED_OFF &&
          fm1c_button_level(FM1C_B_SAVE, &c, 250) == FM1C_LED_FULL && fm1c_button_level(FM1C_B_SAVE, &c, 400) == FM1C_LED_OFF, "v2 SAVE: double blink for an approval");
    c.dstate = FM1C_S_IDLE;
    CHECK(fm1c_button_level(FM1C_B_SAVE, &c, 0) == FM1C_LED_OFF, "v2 SAVE: off with nothing to approve");
    c.view = FM1C_VIEW_CONFIRM;
    CHECK(fm1c_button_level(FM1C_B_SAVE, &c, 0) == FM1C_LED_FULL, "v2 SAVE: confirm view");
    c.view = FM1C_VIEW_SESSIONS;
    c.list = 2;
    CHECK(fm1c_button_level(FM1C_B_SEQ, &c, 0) == FM1C_LED_GLOW && fm1c_button_level(FM1C_B_HOME, &c, 0) == FM1C_LED_FULL, "v2 SEQ glows in grouped");
    c.attention = 2;
    CHECK(fm1c_button_level(FM1C_B_GLO, &c, 100) == FM1C_LED_FULL && fm1c_button_level(FM1C_B_GLO, &c, 200) == FM1C_LED_OFF &&
          fm1c_button_level(FM1C_B_GLO, &c, 2550) == FM1C_LED_FULL, "v2 GLO: a single tick every 2.5 s");
    c.voice = FM1C_V_TRANSCRIBING;
    CHECK(fm1c_button_level(FM1C_B_REC, &c, 100) == FM1C_LED_FULL && fm1c_button_level(FM1C_B_REC, &c, 300) == FM1C_LED_OFF, "v2 REC transcribing");
}

/* the shared timelines (fixtures/device/led-v2.json, the simulator's numbers): every key condition and button sample */
static uint32_t led2_button_level(const char *name, uint32_t ms)
{
    fm1c_button_ctx c;
    memset(&c, 0, sizeof c);
    c.v2 = 1;
    c.host = 1;
    if (!strcmp(name, "sharp")) { c.voice = FM1C_V_TRANSCRIBING; return fm1c_button_level(FM1C_B_REC, &c, ms); }
    if (!strcmp(name, "double")) { c.view = FM1C_VIEW_CONFIRM; return fm1c_button_level(FM1C_B_SAVE, &c, ms); }
    if (!strcmp(name, "tick")) { c.attention = 1; return fm1c_button_level(FM1C_B_GLO, &c, ms); }
    if (!strcmp(name, "nohost")) { c.host = 0; return fm1c_button_level(FM1C_B_OCT_UP, &c, ms); }
    return 99u;
}
static void leds_v2_fixture(void)
{
    uint32_t i, j, n = 0;
    for (i = 0; i < 76u; i++) CHECK(FM1C_BREATH_NS[i] == LED2_BREATH_NS[i], "led-v2.json breathNs[%u]", i);
    CHECK(FM1C_BREATH_STEP_MS == LED2_BREATH_STEP_MS && 150u * FM1C_BREATH_STEP_MS == LED2_BREATH_PERIOD_MS, "led-v2.json breath step and period");
    for (i = 0; i < sizeof LED2_KEYS / sizeof LED2_KEYS[0]; i++) {
        const led2_key *k = &LED2_KEYS[i];
        uint32_t flags = (k->selected ? FM1C_F_SELECTED : 0u) | (k->stale ? FM1C_F_STALE : 0u);
        for (j = 0; j < k->n; j++, n++)
            CHECK(fm1c_key_level2(k->state, flags, k->s[j].ms) == k->s[j].level, "led-v2.json key %s at %u ms", k->name, k->s[j].ms);
    }
    for (i = 0; i < sizeof LED2_BUTTONS / sizeof LED2_BUTTONS[0]; i++) {
        const led2_button *b = &LED2_BUTTONS[i];
        for (j = 0; j < b->n; j++, n++)
            CHECK(led2_button_level(b->name, b->s[j].ms) == b->s[j].level, "led-v2.json button %s at %u ms", b->name, b->s[j].ms);
    }
    CHECK(n >= 600u, "led-v2.json: %u samples compared", n);
}

/* protocol 6 (docs/ui-v3.md section 10.8): the CHOSEN timeline (led-v2.json "chosen"), whatever the state and the other
 * flags; always in the backlight layer (breathing with the selection); ARP lit in view 6 only */
static void leds_v6(void)
{
    uint32_t i, j, n = 0, ms, b, f;
    fm1c_button_ctx c;
    static const uint32_t OTHER[4] = {0, FM1C_F_PINNED, FM1C_F_CODEX, FM1C_F_STALE | FM1C_F_PINNED};
    CHECK(LED2_N_CHOSEN == 8u, "led-v2.json: 8 chosen timelines (%u)", LED2_N_CHOSEN);
    for (i = 0; i < LED2_N_CHOSEN; i++) {
        const led2_key *k = &LED2_CHOSEN[i];
        for (j = 0; j < k->n; j++, n++)
            for (f = 0; f < 4u; f++)
                CHECK(fm1c_key_level2(k->state, FM1C_F_CHOSEN | OTHER[f], k->s[j].ms) == k->s[j].level,
                      "led-v2.json chosen %s at %u ms (flags %u)", k->name, k->s[j].ms, FM1C_F_CHOSEN | OTHER[f]);
    }
    CHECK(n == 72u, "led-v2.json chosen: %u samples", n);
    for (ms = 0; ms < 3000u; ms += 10u)
        for (i = 0; i < FM1C_N_STATE; i++) {
            uint32_t lv = fm1c_key_level2(i, FM1C_F_CHOSEN | FM1C_F_PINNED, ms);
            if (lv != FM1C_LED_BACK) { CHECK(0, "chosen state %u at %u ms: %u", i, ms, lv); break; }
        }
    for (i = 0; i < FM1C_N_STATE; i++)          /* distinct from every state timeline: no unselected state breathes */
        for (ms = 0; ms < 3000u; ms += 10u)
            if (fm1c_key_level2(i, 0, ms) == FM1C_LED_BACK) { CHECK(0, "state %u breathes unselected at %u ms", i, ms); break; }
    memset(&c, 0, sizeof c);
    c.v2 = 1;
    c.host = 1;
    for (b = 0; b < 7u; b++) {
        c.view = (uint8_t)b;
        CHECK(fm1c_button_level(FM1C_B_ARP, &c, 123) == (b == FM1C_VIEW_SETTINGS ? FM1C_LED_FULL : FM1C_LED_OFF), "ARP lit in view 6 only (view %u)", b);
    }
    c.view = FM1C_VIEW_SETTINGS;
    CHECK(fm1c_button_level(FM1C_B_HOME, &c, 0) == FM1C_LED_GLOW && fm1c_button_level(FM1C_B_EDIT, &c, 0) == FM1C_LED_OFF &&
          fm1c_button_level(FM1C_B_SAVE, &c, 0) == FM1C_LED_GLOW && fm1c_button_level(FM1C_B_SEQ, &c, 0) == FM1C_LED_OFF &&
          fm1c_button_level(FM1C_B_LFO, &c, 0) == FM1C_LED_GLOW, "view 6: SAVE, HOME, LFO glow (active); EDIT, SEQ off");
    c.attention = 3;
    CHECK(fm1c_button_level(FM1C_B_GLO, &c, 100) == FM1C_LED_OFF, "view 6: GLO off even with attention (section 10.8)");
    c.attention = 0;
    c.host = 0;
    CHECK(fm1c_button_level(FM1C_B_ARP, &c, 100) == FM1C_LED_OFF && fm1c_key_level2_nohost(FM1C_F_CHOSEN) == FM1C_LED_GLOW,
          "no host: ARP off, the chosen key glows like every key");
    c.host = 1;
    c.v2 = 0;
    CHECK(fm1c_button_level(FM1C_B_ARP, &c, 100) == FM1C_LED_OFF, "version 1-4 LEDs: ARP never lit");
}

/* v2 active controls (operator 2026-11-22, docs/ui-v3.md section 9.9): dim steady glow on the buttons the companion acts
 * on in the shown view; the primary patterns unchanged */
static uint32_t lv2(uint32_t b, uint32_t view, uint32_t voice, uint32_t dstate, uint32_t ms)
{
    fm1c_button_ctx c;
    memset(&c, 0, sizeof c);
    c.v2 = 1;
    c.host = 1;
    c.view = (uint8_t)view;
    c.voice = (uint8_t)voice;
    c.dstate = (uint8_t)dstate;
    return fm1c_button_level(b, &c, ms);
}
#define G FM1C_LED_GLOW
#define O FM1C_LED_OFF
#define F FM1C_LED_FULL
static void leds_active(void)
{
    uint32_t b, ms, s, v, n = 0;
    const uint32_t VV = FM1C_VIEW_VOICE, R = FM1C_V_READY;
    /* voice overlay */
    CHECK(lv2(FM1C_B_REC, VV, FM1C_V_RECORDING, FM1C_S_IDLE, 300) == F && lv2(FM1C_B_FX, VV, FM1C_V_RECORDING, FM1C_S_IDLE, 300) == G &&
          lv2(FM1C_B_PLAY, VV, FM1C_V_RECORDING, FM1C_S_IDLE, 0) == O && lv2(FM1C_B_SAVE, VV, FM1C_V_RECORDING, FM1C_S_IDLE, 0) == O,
          "recording: REC full, FX glows, PLAY and SAVE off");
    CHECK(lv2(FM1C_B_REC, VV, FM1C_V_TRANSCRIBING, 0, 100) == F && lv2(FM1C_B_REC, VV, FM1C_V_TRANSCRIBING, 0, 300) == O &&
          lv2(FM1C_B_FX, VV, FM1C_V_TRANSCRIBING, 0, 300) == G, "transcribing: REC blinks (off phase stays off), FX glows");
    CHECK(lv2(FM1C_B_SAVE, VV, FM1C_V_REVIEWING, 0, 0) == F && lv2(FM1C_B_SAVE, VV, FM1C_V_REVIEWING, 0, 130) == O &&
          lv2(FM1C_B_FX, VV, FM1C_V_REVIEWING, 0, 130) == G && lv2(FM1C_B_ARP, VV, FM1C_V_REVIEWING, 0, 130) == G &&
          lv2(FM1C_B_REC, VV, FM1C_V_REVIEWING, 0, 130) == O, "reviewing: SAVE double (dark phase off), FX and ARP glow, REC off (inert)");
    CHECK(lv2(FM1C_B_FX, VV, FM1C_V_FAILED, 0, 0) == G && lv2(FM1C_B_PLAY, VV, FM1C_V_FAILED, 0, 0) == G &&
          lv2(FM1C_B_ARP, VV, FM1C_V_FAILED, 0, 0) == O && lv2(FM1C_B_SAVE, VV, FM1C_V_FAILED, 0, 0) == O,
          "voice failed: FX and PLAY (retry) glow; ARP (inert) and SAVE off");
    CHECK(lv2(FM1C_B_FX, VV, FM1C_V_NO_TARGET, 0, 0) == G && lv2(FM1C_B_PLAY, VV, FM1C_V_NO_TARGET, 0, 0) == O, "no target: FX glows");
    for (b = 0; b < FM1C_N_BUTTON; b++)
        CHECK(lv2(b, VV, FM1C_V_SUBMITTING, FM1C_S_APPROVAL, 0) == O, "submitting: button %u off", b);
    CHECK(lv2(FM1C_B_ENV, VV, FM1C_V_REVIEWING, FM1C_S_WORKING, 0) == O && lv2(FM1C_B_PLAY, VV, FM1C_V_REVIEWING, FM1C_S_IDLE, 0) == O,
          "voice wins over the base-view rules");
    /* confirm (wins over voice, as the companion's currentView) */
    CHECK(lv2(FM1C_B_SAVE, FM1C_VIEW_CONFIRM, R, 0, 0) == F && lv2(FM1C_B_FX, FM1C_VIEW_CONFIRM, R, 0, 0) == G &&
          lv2(FM1C_B_FX, FM1C_VIEW_CONFIRM, FM1C_V_REVIEWING, 0, 130) == G && lv2(FM1C_B_ARP, FM1C_VIEW_CONFIRM, FM1C_V_REVIEWING, 0, 0) == O &&
          lv2(FM1C_B_PLAY, FM1C_VIEW_CONFIRM, R, FM1C_S_IDLE, 0) == O, "confirm: SAVE double, FX glows; voice glows do not apply");
    /* DETAILS */
    CHECK(lv2(FM1C_B_LFO, FM1C_VIEW_DETAIL, R, FM1C_S_IDLE, 0) == F && lv2(FM1C_B_HOME, FM1C_VIEW_DETAIL, R, FM1C_S_IDLE, 0) == G &&
          lv2(FM1C_B_PLAY, FM1C_VIEW_DETAIL, R, FM1C_S_IDLE, 0) == G && lv2(FM1C_B_ENV, FM1C_VIEW_DETAIL, R, FM1C_S_IDLE, 0) == O &&
          lv2(FM1C_B_FX, FM1C_VIEW_DETAIL, R, FM1C_S_IDLE, 0) == O, "DETAILS idle: LFO full, HOME and PLAY glow");
    CHECK(lv2(FM1C_B_SAVE, FM1C_VIEW_DETAIL, R, FM1C_S_APPROVAL, 0) == F && lv2(FM1C_B_FX, FM1C_VIEW_DETAIL, R, FM1C_S_APPROVAL, 0) == G &&
          lv2(FM1C_B_ENV, FM1C_VIEW_DETAIL, R, FM1C_S_APPROVAL, 0) == G, "DETAILS approval: SAVE double, FX (deny) and ENV glow");
    CHECK(lv2(FM1C_B_PLAY, FM1C_VIEW_DETAIL, R, FM1C_S_DISCONNECTED, 0) == O && lv2(FM1C_B_PLAY, FM1C_VIEW_DETAIL, R, FM1C_S_EMPTY, 0) == O &&
          lv2(FM1C_B_HOME, FM1C_VIEW_DETAIL, R, FM1C_S_EMPTY, 0) == G, "DETAILS: PLAY needs a shown chat; HOME always");
    /* base views */
    for (s = 0; s < FM1C_N_STATE; s++) {
        int busy = s == FM1C_S_WORKING || s == FM1C_S_WAITING_INPUT || s == FM1C_S_APPROVAL;
        int shown = s != FM1C_S_EMPTY && s != FM1C_S_DISCONNECTED;
        CHECK(lv2(FM1C_B_ENV, FM1C_VIEW_SESSIONS, R, s, 0) == (busy ? G : O) && lv2(FM1C_B_ENV, FM1C_VIEW_INBOX, R, s, 0) == (busy ? G : O) &&
              lv2(FM1C_B_ENV, FM1C_VIEW_TASKS, R, s, 0) == O, "ENV glows for a busy chat in Sessions / TO DO only (state %u)", s);
        CHECK(lv2(FM1C_B_PLAY, FM1C_VIEW_SESSIONS, R, s, 0) == (shown ? G : O) && lv2(FM1C_B_PLAY, FM1C_VIEW_INBOX, R, s, 0) == (shown ? G : O) &&
              lv2(FM1C_B_PLAY, FM1C_VIEW_TASKS, R, s, 0) == (s != FM1C_S_EMPTY ? G : O), "PLAY with a selection (state %u)", s);
        CHECK(lv2(FM1C_B_FX, FM1C_VIEW_SESSIONS, R, s, 0) == (s == FM1C_S_APPROVAL ? G : O) && lv2(FM1C_B_FX, FM1C_VIEW_INBOX, R, s, 0) == (shown ? G : O) &&
              lv2(FM1C_B_FX, FM1C_VIEW_TASKS, R, s, 0) == O, "FX: deny in Sessions, dismiss/deny in TO DO (state %u)", s);
        for (v = 0; v < 3u; v++)
            CHECK(lv2(FM1C_B_REC, v, R, s, 0) == O && lv2(3u /* SEL */, v, R, s, 0) == O && lv2(FM1C_B_ARP, v, R, s, 0) == O,
                  "base view %u: REC, SEL and ARP never glow (state %u)", v, s);
    }
    CHECK(lv2(FM1C_B_HOME, FM1C_VIEW_SESSIONS, R, FM1C_S_IDLE, 0) == F && lv2(FM1C_B_EDIT, FM1C_VIEW_TASKS, R, FM1C_S_IDLE, 0) == F &&
          lv2(FM1C_B_GLO, FM1C_VIEW_INBOX, R, FM1C_S_IDLE, 0) == F && lv2(FM1C_B_SAVE, FM1C_VIEW_INBOX, R, FM1C_S_APPROVAL, 130) == O,
          "base views: HOME / EDIT / GLO lit as before; SAVE double's dark phase stays off");
    /* never the backlight layer; no host and version <= 4 unchanged (no glow) */
    for (v = 0; v < FM1C_N_VIEW; v++)
        for (s = 0; s < FM1C_N_STATE; s++)
            for (b = 0; b < FM1C_N_BUTTON; b++)
                for (ms = 0; ms < 1300u; ms += 130u) {
                    fm1c_button_ctx c;
                    CHECK(lv2(b, v, FM1C_V_REVIEWING, s, ms) != FM1C_LED_BACK && lv2(b, v, FM1C_V_FAILED, s, ms) != FM1C_LED_BACK,
                          "button %u never breathes (view %u state %u)", b, v, s);
                    memset(&c, 0, sizeof c);
                    c.v2 = 1;
                    c.view = (uint8_t)v;
                    c.dstate = (uint8_t)s;
                    CHECK(fm1c_button_level(b, &c, ms) == (b == FM1C_B_OCT_UP && ms % 1000u < 500u ? F : O), "no host: OCT+ only (%u)", b);
                    c.v2 = 0;
                    c.host = 1;
                    CHECK(fm1c_button_level(b, &c, ms) != G || (b == FM1C_B_SEQ), "version <= 4: no glow (button %u)", b);
                    n++;
                }
    CHECK(n == FM1C_N_VIEW * FM1C_N_STATE * FM1C_N_BUTTON * 10u, "active controls: %u combinations", n);
}

/* the simulator's button matrix (led-v2.json buttonMatrix, buttonLedsV2): every view x voice x SET_DETAIL.state */
static void leds_v2_matrix(void)
{
    uint32_t i, j, b, n = 0;
    CHECK(!strcmp(LED2_BM_BUTTONS, "OCT_DOWN,OCT_UP,FX,SEL,ENV,LFO,EDIT,GLO,HOME,SAVE,ARP,SEQ,PLAY,REC"), "button matrix: HAL id order");
    CHECK(LED2_N_BM == FM1C_N_VIEW * FM1C_N_VOICE * FM1C_N_STATE, "button matrix: %u rows", LED2_N_BM);
    for (i = 0; i < LED2_N_BM; i++)
        for (j = 0; j < LED2_BM_NT; j++)
            for (b = 0; b < FM1C_N_BUTTON; b++, n++) {
                uint32_t lv = lv2(b, LED2_BM[i].view, LED2_BM[i].voice, LED2_BM[i].dstate, LED2_BM_TIMES[j]);
                char got = lv == O ? '.' : lv == G ? 'g' : lv == F ? 'F' : 'B';
                CHECK(got == LED2_BM[i].levels[j][b], "button matrix: view %u voice %u state %u button %u at %u ms: got %c want %c",
                      LED2_BM[i].view, LED2_BM[i].voice, LED2_BM[i].dstate, b, LED2_BM_TIMES[j], got, LED2_BM[i].levels[j][b]);
            }
    CHECK(n == 630u * 4u * 14u, "button matrix: %u samples", n);
}
#undef G
#undef O
#undef F

int main(void)
{
    fm1c_button_ctx c;
    uint32_t b;
    expect(FM1C_S_APPROVAL, 0, 2000, "F500 .500 F500 .500 ", "approval: slow blink full/off 500 ms");
    expect(FM1C_S_FAILED, 0, 600, "F150 .150 F150 .150 ", "failed: fast blink 150 ms");
    expect(FM1C_S_WAITING_INPUT, 0, 2000, "F500 g500 F500 g500 ", "waiting input: full/glow 500 ms");
    expect(FM1C_S_DONE_UNREAD, 0, 4000, "F120 g1880 F120 g1880 ", "completed unread: 120 ms pulse every 2 s");
    expect(FM1C_S_WORKING, 0, 1000, "F1000 ", "working: steady full");
    expect(FM1C_S_IDLE, 0, 1000, "g1000 ", "idle: glow");
    expect(FM1C_S_DONE_READ, 0, 1000, "g1000 ", "completed read: glow");
    expect(FM1C_S_EMPTY, 0, 1000, ".1000 ", "empty: off");
    expect(FM1C_S_DISCONNECTED, 0, 1000, ".1000 ", "disconnected: off");
    expect(FM1C_S_UNKNOWN, 0, 2000, ".120 g1880 ", "unknown: glow with a 120 ms gap every 2 s");
    expect(FM1C_S_WORKING, FM1C_F_SELECTED, 1000, "F1000 ", "selected: steady full");
    expect(FM1C_S_FAILED, FM1C_F_SELECTED, 1000, "F1000 ", "selected beats failed");
    expect(FM1C_S_EMPTY, FM1C_F_SELECTED, 1000, "F1000 ", "selected beats empty");
    expect(FM1C_S_APPROVAL, FM1C_F_SELECTED, 2000, ".100 F900 .100 F900 ", "selected approval keeps a 100 ms dip a second");
    expect(FM1C_S_IDLE, FM1C_F_STALE | FM1C_F_CODEX | FM1C_F_PINNED, 500, "g500 ", "other flags do not change the light");
    CHECK(fm1c_key_level_nohost(0) == FM1C_LED_GLOW && fm1c_key_level_nohost(FM1C_F_SELECTED) == FM1C_LED_FULL,
          "no host: glow, the kept selection full");

    memset(&c, 0, sizeof c);                    /* no host: only OCT+ blinks slowly */
    for (b = 0; b < 14u; b++)
        CHECK(fm1c_button_level(b, &c, 100) == (b == FM1C_B_OCT_UP ? FM1C_LED_FULL : FM1C_LED_OFF) &&
              fm1c_button_level(b, &c, 700) == FM1C_LED_OFF, "no host: button %u", b);
    c.host = 1;
    c.view = FM1C_VIEW_TASKS;
    CHECK(fm1c_button_level(FM1C_B_EDIT, &c, 0) == FM1C_LED_FULL && fm1c_button_level(FM1C_B_HOME, &c, 0) == FM1C_LED_OFF &&
          fm1c_button_level(FM1C_B_OCT_UP, &c, 100) == FM1C_LED_OFF, "tasks view: EDIT lit");
    c.view = FM1C_VIEW_SESSIONS;
    CHECK(fm1c_button_level(FM1C_B_HOME, &c, 0) == FM1C_LED_FULL, "sessions: HOME");
    c.attention = 3;
    CHECK(fm1c_button_level(FM1C_B_GLO, &c, 100) == FM1C_LED_FULL && fm1c_button_level(FM1C_B_GLO, &c, 600) == FM1C_LED_OFF,
          "attention: GLO blinks");
    c.view = FM1C_VIEW_INBOX;
    CHECK(fm1c_button_level(FM1C_B_GLO, &c, 600) == FM1C_LED_FULL, "inbox view: GLO steady");
    c.voice = FM1C_V_RECORDING;
    CHECK(fm1c_button_level(FM1C_B_REC, &c, 300) == FM1C_LED_FULL, "recording: REC full");
    c.voice = FM1C_V_TRANSCRIBING;
    CHECK(fm1c_button_level(FM1C_B_REC, &c, 100) == FM1C_LED_FULL && fm1c_button_level(FM1C_B_REC, &c, 300) == FM1C_LED_OFF,
          "transcribing: REC blinks");
    c.voice = FM1C_V_REVIEWING;
    CHECK(fm1c_button_level(FM1C_B_SAVE, &c, 0) == FM1C_LED_FULL && fm1c_button_level(FM1C_B_REC, &c, 0) == FM1C_LED_OFF,
          "reviewing: SAVE full");
    c.view = FM1C_VIEW_DETAIL;                  /* docs/ux-v2.md section 7.3 */
    CHECK(fm1c_button_level(FM1C_B_LFO, &c, 0) == FM1C_LED_FULL && fm1c_button_level(FM1C_B_HOME, &c, 0) == FM1C_LED_OFF &&
          fm1c_button_level(FM1C_B_EDIT, &c, 0) == FM1C_LED_OFF, "DETAILS: LFO full, HOME and EDIT off");
    c.view = FM1C_VIEW_SESSIONS;
    CHECK(fm1c_button_level(FM1C_B_LFO, &c, 0) == FM1C_LED_OFF, "outside DETAILS: LFO off");
    CHECK(fm1c_button_level(FM1C_B_SEQ, &c, 0) == FM1C_LED_OFF, "buddy layout: SEQ off");
    c.list = 1;                                 /* docs/ui-v3.md section 8.5 */
    CHECK(fm1c_button_level(FM1C_B_SEQ, &c, 0) == FM1C_LED_FULL && fm1c_button_level(FM1C_B_SEQ, &c, 777) == FM1C_LED_FULL,
          "the LIST layout shown: SEQ full");
    c.host = 0;
    CHECK(fm1c_button_level(FM1C_B_SEQ, &c, 0) == FM1C_LED_OFF, "no host: SEQ off");
    leds_v2();
    leds_v2_fixture();
    leds_v6();
    leds_active();
    leds_v2_matrix();
    T_DONE("led_test");
}
