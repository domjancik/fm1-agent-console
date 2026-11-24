/* SPDX-License-Identifier: GPL-3.0-only */
/* Gesture timing (firmware/src/fm1c_input.h) on a 1 ms main loop: single after the 300 ms window, double without a
 * single, long at 600 ms, taps shorter than a pass, and the button, encoder and MASTER filters. */
#include "t.h"
#include "fm1c_input.h"

static char got[512];                           /* "k:gesture@ms " records */
static uint32_t now;

static void rec(void *ctx, uint32_t key, uint32_t g)
{
    static const char *const N[] = {"", "single", "double", "long", "down", "up"};
    char b[32];
    (void)ctx;
    snprintf(b, sizeof b, "%u:%s@%u ", key, N[g], now);
    strncat(got, b, sizeof got - strlen(got) - 1);
}

static fm1c_keys g;
static uint32_t held, prev, edges;

static void reset(void)
{
    fm1c_keys_init(&g, rec, 0);
    got[0] = 0;
    now = 0;
    held = prev = edges = 0;
}
static void pass(void)                          /* one main-loop pass at now */
{
    fm1c_keys_scan(&g, held, prev, edges, now);
    prev = held;
    edges = 0;
}
static void until(uint32_t t) { while (now < t) { now++; pass(); } }
static void step_to(uint32_t t) { until(t - 1u); now = t; }   /* the next pass is at t: set the keys, then pass() */
static void press(uint32_t k) { held |= 1u << k; edges |= 1u << k; }
static void release(uint32_t k) { held &= ~(1u << k); }

static void expect(const char *want, const char *what)
{
    CHECK(!strcmp(got, want), "%s:\n   got  '%s'\n   want '%s'", what, got, want);
}

static void test_gestures(void)
{
    reset();
    step_to(10); press(4); pass();
    step_to(110); release(4); pass();
    until(409);
    expect("4:down@10 4:up@110 ", "no single inside the window");
    until(410);
    expect("4:down@10 4:up@110 4:single@410 ", "single 300 ms after the up");
    until(2000);
    expect("4:down@10 4:up@110 4:single@410 ", "and nothing more");

    reset();
    step_to(10); press(7); pass();
    step_to(90); release(7); pass();
    step_to(250); press(7); pass();
    step_to(330); release(7); pass();
    until(2000);
    expect("7:down@10 7:up@90 7:down@250 7:up@330 7:double@330 ", "double: down up down up double, no single");

    reset();
    step_to(10); press(1); pass();
    step_to(50); release(1); pass();
    step_to(350); press(1); pass();               /* exactly 300 ms after the up: still a double */
    step_to(400); release(1); pass();
    until(1000);
    expect("1:down@10 1:up@50 1:down@350 1:up@400 1:double@400 ", "a second down at 300 ms is a double");

    reset();
    step_to(10); press(1); pass();
    step_to(50); release(1); pass();
    step_to(351); press(1); pass();               /* 301 ms: the window closed at 350 */
    step_to(360); release(1); pass();
    until(1000);
    expect("1:down@10 1:up@50 1:single@350 1:down@351 1:up@360 1:single@660 ", "301 ms: two singles");

    reset();
    step_to(10); press(26); pass();
    until(609);
    expect("26:down@10 ", "no long before 600 ms");
    until(610);
    expect("26:down@10 26:long@610 ", "long at 600 ms, while held");
    step_to(900); release(26); pass();
    until(2000);
    expect("26:down@10 26:long@610 26:up@900 ", "its release: up only");

    reset();
    step_to(10); press(3); pass();
    step_to(60); release(3); pass();
    step_to(100); press(3); pass();               /* second press held: a long, not a double */
    step_to(1000); release(3); pass();
    until(2000);
    expect("3:down@10 3:up@60 3:down@100 3:long@700 3:up@1000 ", "a long second press: no double, no single");

    reset();
    step_to(20); edges = 1u << 9; pass();         /* pressed and let go inside one pass */
    until(400);
    expect("9:down@20 9:up@20 9:single@320 ", "a tap shorter than a pass");

    reset();
    step_to(10); press(5); pass();
    step_to(30); edges = 1u << 5; pass();         /* held, but let go and pressed again between passes */
    until(30);
    expect("5:down@10 5:up@30 5:down@30 ", "re-pressed between passes: up, down");

    reset();
    step_to(10); press(0); press(2); pass();      /* two keys at once: each its own */
    step_to(20); release(0); pass();
    step_to(30); release(2); pass();
    until(400);
    expect("0:down@10 2:down@10 0:up@20 2:up@30 0:single@320 2:single@330 ", "keys are independent");
}

static char bgot[128];
static void brec(void *ctx, uint32_t b, uint32_t e)
{
    char s[16];
    (void)ctx;
    snprintf(s, sizeof s, "%u%c ", b, e ? 'v' : '^');
    strncat(bgot, s, sizeof bgot - strlen(bgot) - 1);
}

static void test_buttons(void)
{
    bgot[0] = 0;
    fm1c_buttons_scan(1u << 13, 0, 1u << 13, brec, 0);
    fm1c_buttons_scan(0, 1u << 13, 0, brec, 0);
    CHECK(!strcmp(bgot, "13v 13^ "), "REC down, up: '%s'", bgot);
    bgot[0] = 0;
    fm1c_buttons_scan(1u << 9, 1u << 9, 0, brec, 0);   /* a tap inside one pass */
    CHECK(!strcmp(bgot, "9v 9^ "), "tap: down then up: '%s'", bgot);
    bgot[0] = 0;
    fm1c_buttons_scan(1u << 2, 1u << 2, 1u << 2, brec, 0);   /* held now: let go, then pressed again */
    CHECK(!strcmp(bgot, "2^ 2v "), "release then press: '%s'", bgot);
}

static void test_encoders(void)
{
    fm1c_encs e;
    memset(&e, 0, sizeof e);
    CHECK(fm1c_enc_step(&e, 0, 3, 100) == 3, "first turn goes at once");
    CHECK(fm1c_enc_step(&e, 0, 2, 105) == 0 && fm1c_enc_step(&e, 0, 1, 110) == 0, "within 20 ms: summed");
    CHECK(fm1c_enc_step(&e, 0, 0, 120) == 3, "sent 20 ms later");
    CHECK(fm1c_enc_step(&e, 1, -100, 200) == -64 && fm1c_enc_step(&e, 1, 0, 220) == -36, "clamped to -64, the rest next");
    CHECK(fm1c_enc_step(&e, 2, 70, 300) == 63 && fm1c_enc_step(&e, 2, 0, 320) == 7, "clamped to 63");
    CHECK(fm1c_enc_step(&e, 3, 0, 400) == 0, "no turn, nothing");
}

static void test_pot(void)
{
    fm1c_pot p;
    fm1c_pot_init(&p);
    CHECK(fm1c_pot_feed(&p, -1, 0) == -1, "not ready: nothing");
    CHECK(fm1c_pot_feed(&p, 512, 20) == 512, "the first reading is sent");
    CHECK(fm1c_pot_feed(&p, 515, 100) == -1, "inside the deadband: nothing");
    CHECK(fm1c_pot_feed(&p, 1023, 120) == 640, "a big move, smoothed (avg/4 moves a quarter of the way)");
    CHECK(fm1c_pot_feed(&p, 1023, 140) == -1, "at most every 50 ms");
    CHECK(fm1c_pot_feed(&p, 1023, 170) == 808, "then the smoothed value");
    {
        int32_t i, v = -1;
        for (i = 0; i < 40; i++) { int32_t r = fm1c_pot_feed(&p, 1023, 200 + (uint32_t)i * 60u); if (r >= 0) v = r; }
        CHECK(v >= 1015 && v <= 1023 && fm1c_pot_value(&p) == 1023, "settles at the top (%d)", v);
    }
}

/* the help overlay's hold and gate (docs/ux-v2.md section 2.5) */
static void test_help(void)
{
    fm1c_help h;
    uint32_t t, first = 0;
    fm1c_help_init(&h);
    for (t = 1000; t <= 1399; t++) CHECK(!fm1c_help_tick(&h, 1, 1, t), "SCL held %u ms: no help yet", t - 1000);
    fm1c_help_init(&h);
    for (t = 1000; t <= 1500 && !first; t++) if (fm1c_help_tick(&h, 1, 1, t)) first = t;
    CHECK(first == 1400, "SCL held 400 ms: help (at %u)", first);
    CHECK(fm1c_help_tick(&h, 1, 1, 1600) && !fm1c_help_tick(&h, 0, 1, 1601), "letting go of SCL closes it");
    fm1c_help_init(&h);
    fm1c_help_tick(&h, 1, 1, 0);
    fm1c_help_tick(&h, 0, 1, 399);
    CHECK(!fm1c_help_tick(&h, 1, 1, 400) && !fm1c_help_tick(&h, 1, 1, 799) && fm1c_help_tick(&h, 1, 1, 800),
          "a release restarts the 400 ms");
    fm1c_help_init(&h);
    CHECK(!fm1c_help_tick(&h, 1, 0, 0) && !fm1c_help_tick(&h, 1, 0, 5000), "version 1 (or no host): never");
    fm1c_help_init(&h);
    fm1c_help_tick(&h, 1, 1, 0);
    fm1c_help_tick(&h, 1, 1, 500);
    CHECK(h.on && !fm1c_help_tick(&h, 1, 0, 501), "losing version 2 closes it");

    /* the gate */
    fm1c_help_init(&h);
    CHECK(fm1c_help_button(&h, 13, 1), "REC down with no help: sent");
    CHECK(fm1c_help_key(&h, 4, FM1C_G_DOWN), "key 4 down with no help: sent");
    CHECK(fm1c_help_button(&h, FM1C_BTN_SCL, 1), "SCL down: sent");
    fm1c_help_tick(&h, 1, 1, 0);
    fm1c_help_tick(&h, 1, 1, 400);
    CHECK(h.on, "help up");
    CHECK(!fm1c_help_button(&h, 9, 1) && !fm1c_help_button(&h, 9, 0), "SAVE under the help: neither edge sent");
    CHECK(!fm1c_help_button(&h, 2, 1) && !fm1c_help_button(&h, 12, 1) && !fm1c_help_button(&h, 7, 1),
          "FX, PLAY, GLO under the help: dropped");
    CHECK(!fm1c_help_key(&h, 6, FM1C_G_DOWN) && !fm1c_help_key(&h, 6, FM1C_G_UP) && !fm1c_help_key(&h, 6, FM1C_G_SINGLE),
          "a key tapped under the help: nothing sent");
    CHECK(!fm1c_help_key(&h, 4, FM1C_G_LONG), "a long press maturing under the help: dropped");
    CHECK(fm1c_help_key(&h, 4, FM1C_G_UP), "the up of a key pressed before the help: sent");
    CHECK(!fm1c_help_key(&h, 4, FM1C_G_SINGLE), "but not its gesture");
    CHECK(fm1c_help_button(&h, 13, 0), "REC let go under the help, pressed before: sent (the recording ends)");
    CHECK(!fm1c_help_button(&h, 13, 0), "a second REC up: not");
    CHECK(fm1c_help_button(&h, FM1C_BTN_SCL, 0), "SCL up: sent");
    fm1c_help_tick(&h, 0, 1, 900);
    CHECK(!fm1c_help_key(&h, 6, FM1C_G_SINGLE), "a tap made under the help: its single, due after the help closed, dropped");
    CHECK(!h.on && fm1c_help_button(&h, 9, 1) && fm1c_help_key(&h, 6, FM1C_G_DOWN), "after the help: everything again");
    CHECK(fm1c_help_key(&h, 6, FM1C_G_UP) && fm1c_help_key(&h, 6, FM1C_G_SINGLE), "and the next tap is whole");
    /* a button pressed under the help and let go after it closed: the host never heard the down, so not the up */
    fm1c_help_init(&h);
    fm1c_help_button(&h, FM1C_BTN_SCL, 1);
    fm1c_help_tick(&h, 1, 1, 0);
    fm1c_help_tick(&h, 1, 1, 400);
    CHECK(!fm1c_help_button(&h, 13, 1), "REC down under the help: dropped");
    CHECK(fm1c_help_button(&h, FM1C_BTN_SCL, 0), "SCL up: sent");
    fm1c_help_tick(&h, 0, 1, 500);
    CHECK(!h.on && !fm1c_help_button(&h, 13, 0), "its up after the help closed: dropped (no orphan REC up)");
    CHECK(fm1c_help_button(&h, 13, 1) && fm1c_help_button(&h, 13, 0), "the next REC press: both edges sent");
    CHECK(fm1c_help_button(&h, 9, 0), "an up with no help and no muted press (e.g. held at power-on): sent, as before");
}

int main(void)
{
    test_help();
    test_gestures();
    test_buttons();
    test_encoders();
    test_pot();
    T_DONE("input_test");
}
