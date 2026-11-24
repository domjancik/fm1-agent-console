/* SPDX-License-Identifier: GPL-3.0-only */
/* The character animation (docs/ui-v3.md sections 2 and 6.5): the generated sprite tables, the 4 bpp decode and the
 * blitter (against a stand-in canvas), frame timing, the per-pass pixel budget, skipped (never queued) frames, calm
 * minis that never move, and the rate over a second of main-loop passes. Pure: no platform. */
#include "t.h"
#include "fm1c_proto.h"
#include "fm1c_anim.h"

/* a stand-in for gfx.c's canvas, enough for fm1c_sprite.h */
static uint16_t cv[64 * 64];
static void cv_pset(int32_t x, int32_t y, uint16_t c)
{
    if ((uint32_t)x < 64u && (uint32_t)y < 64u) cv[y * 64 + x] = c;
}
static uint16_t fm1c_c(uint16_t c) { return c; }
#include "fm1c_sprite.h"

static uint32_t px_of(const uint8_t *f, uint32_t n, uint32_t x, uint32_t y)
{
    uint32_t v = f[(y * n + x) >> 1];
    return (x & 1u) ? (v & 15u) : (v >> 4);
}
static uint32_t ink(const uint8_t *f, uint32_t n)   /* non-transparent pixels */
{
    uint32_t x, y, c = 0;
    for (y = 0; y < n; y++)
        for (x = 0; x < n; x++) c += px_of(f, n, x, y) != 0u;
    return c;
}
static uint32_t shape_diff(const uint8_t *a, const uint8_t *b, uint32_t n)   /* pixels inked in one only */
{
    uint32_t x, y, c = 0;
    for (y = 0; y < n; y++)
        for (x = 0; x < n; x++) c += (px_of(a, n, x, y) != 0u) != (px_of(b, n, x, y) != 0u);
    return c;
}

static void tables(void)
{
    uint32_t p, s, f, hero = 0, mini = 0;
    CHECK(sizeof FM1C_SPR_HERO == FM1C_SPR_HERO_FRAMES * 288u && FM1C_SPR_HERO_FRAMES == 60u,
          "60 hero frames of 288 B (8 poses x 2 providers x 4, the ghost 2): %u B", (unsigned)sizeof FM1C_SPR_HERO);
    CHECK(sizeof FM1C_SPR_MINI == FM1C_SPR_MINI_FRAMES * 72u && FM1C_SPR_MINI_FRAMES == 26u,
          "26 mini frames of 72 B: %u B", (unsigned)sizeof FM1C_SPR_MINI);
    for (p = 0; p < FM1C_SPR_POSES; p++) {
        uint32_t hn = FM1C_SPR_ANIM[p][0], mn = FM1C_SPR_ANIM[p][2];
        CHECK(FM1C_SPR_HERO_AT[p][1] == FM1C_SPR_HERO_AT[p][0] + hn && FM1C_SPR_MINI_AT[p][1] == FM1C_SPR_MINI_AT[p][0] + mn,
              "pose %u: Codex's frames follow Claude's", p);
        CHECK(FM1C_SPR_ANIM[p][1] >= 4u && FM1C_SPR_ANIM[p][1] <= 8u, "pose %u: hero 4..8 fps (%u)", p, FM1C_SPR_ANIM[p][1]);
        CHECK(FM1C_SPR_ANIM[p][3] == 0u || FM1C_SPR_ANIM[p][3] == 4u, "pose %u: minis still or 4 fps", p);
        hero += 2u * hn;
        mini += 2u * mn;
        for (s = 0; s < 2u; s++) {
            for (f = 0; f < hn; f++) {
                const uint8_t *fr = fm1c_spr_hero(p, s, f);
                CHECK(ink(fr, 24) >= 150u, "pose %u provider %u hero frame %u: a character (%u px)", p, s, f, ink(fr, 24));
            }
            for (f = 0; f < mn; f++) {
                const uint8_t *fr = fm1c_spr_mini(p, s, f);
                CHECK(ink(fr, 12) >= 50u, "pose %u provider %u mini frame %u: a character (%u px)", p, s, f, ink(fr, 12));
            }
        }
        /* told apart by shape (acceptance 2): Claude's ears against Codex's antenna and box */
        CHECK(shape_diff(fm1c_spr_hero(p, 0, 0), fm1c_spr_hero(p, 1, 0), 24) >= 40u, "pose %u: hero shapes differ (%u px)", p,
              shape_diff(fm1c_spr_hero(p, 0, 0), fm1c_spr_hero(p, 1, 0), 24));
        CHECK(shape_diff(fm1c_spr_mini(p, 0, 0), fm1c_spr_mini(p, 1, 0), 12) >= 10u, "pose %u: mini shapes differ (%u px)", p,
              shape_diff(fm1c_spr_mini(p, 0, 0), fm1c_spr_mini(p, 1, 0), 12));
        for (s = 0; s < 2u; s++)
            for (f = 1; f < hn; f++)            /* an animation: every frame differs from the one before */
                CHECK(memcmp(fm1c_spr_hero(p, s, f), fm1c_spr_hero(p, s, f - 1u), 288) != 0,
                      "pose %u provider %u: hero frame %u differs from frame %u", p, s, f, f - 1u);
        for (s = 0; s < 2u; s++)
            if (mn > 1u)
                CHECK(memcmp(fm1c_spr_mini(p, s, 1), fm1c_spr_mini(p, s, 0), 72) != 0, "pose %u provider %u: mini frames differ", p, s);
    }
    CHECK(hero == FM1C_SPR_HERO_FRAMES && mini == FM1C_SPR_MINI_FRAMES, "the frame index covers every frame once");
    CHECK(FM1C_SPR_POSE_OF_STATE[FM1C_S_EMPTY] == FM1C_SPR_NONE && FM1C_SPR_POSE_OF_STATE[FM1C_S_WORKING] == FM1C_POSE_WORK &&
          FM1C_SPR_POSE_OF_STATE[FM1C_S_WAITING_INPUT] == FM1C_POSE_WAVE && FM1C_SPR_POSE_OF_STATE[FM1C_S_APPROVAL] == FM1C_POSE_HAND &&
          FM1C_SPR_POSE_OF_STATE[FM1C_S_FAILED] == FM1C_POSE_DIZZY && FM1C_SPR_POSE_OF_STATE[FM1C_S_DONE_UNREAD] == FM1C_POSE_HAPPY &&
          FM1C_SPR_POSE_OF_STATE[FM1C_S_DONE_READ] == FM1C_POSE_SLEEP && FM1C_SPR_POSE_OF_STATE[FM1C_S_IDLE] == FM1C_POSE_SLEEP &&
          FM1C_SPR_POSE_OF_STATE[FM1C_S_UNKNOWN] == FM1C_POSE_HUH && FM1C_SPR_POSE_OF_STATE[FM1C_S_DISCONNECTED] == FM1C_POSE_GHOST,
          "each state its pose (docs/ui-v3.md section 2)");
    CHECK(fm1c_anim_pose(FM1C_S_WORKING, 1) == FM1C_POSE_GHOST && fm1c_anim_pose(FM1C_S_EMPTY, 1) == FM1C_SPR_NONE &&
          fm1c_anim_pose(77, 0) == FM1C_POSE_HUH, "stale: the ghost; empty: none; an unknown value: no status");
    for (s = 1; s < 10u; s++)
        CHECK(FM1C_SPR_PAL_STATE[s][0] != 0u && FM1C_SPR_PAL_STATE[s][1] != FM1C_SPR_PAL_STATE[s][0],
              "state %u: body and light colours", s);
    CHECK(!strcmp(FM1C_NOTE[0], "F3") && !strcmp(FM1C_NOTE[3], "G#3") && !strcmp(FM1C_NOTE[26], "G5"), "key names F3 .. G5");
}

static void blitter(void)
{
    uint16_t pal[16];
    uint32_t x, y, ok = 1, set = 0, f;
    const uint8_t *fr = fm1c_spr_hero(FM1C_POSE_HAPPY, 0, 0);
    fm1c_spr_pal(FM1C_S_DONE_UNREAD, pal);
    CHECK(pal[0] == 0 && pal[13] == FM1C_SPR_PAL_STATE[FM1C_S_DONE_UNREAD][0] && pal[2] == 0xFFFFu, "palette: fixed 1-12, state 13-15");
    for (x = 0; x < 64u * 64u; x++) cv[x] = 0x1234u;
    fm1c_sprite(4, 2, fr, 24, pal, 2);
    for (y = 0; y < 24u; y++)
        for (x = 0; x < 24u; x++) {
            uint32_t v = px_of(fr, 24, x, y), dx, dy;
            for (dy = 0; dy < 2u; dy++)
                for (dx = 0; dx < 2u; dx++) {
                    uint16_t c = cv[(2 + 2 * y + dy) * 64 + 4 + 2 * x + dx];
                    if (v ? c != pal[v] : c != 0x1234u) ok = 0;
                    set += v != 0u;
                }
        }
    CHECK(ok && set == 4u * ink(fr, 24), "2x: every pixel a 2 x 2 block in its palette colour; index 0 leaves the canvas");
    for (x = 0; x < 64u * 64u; x++) cv[x] = 0;
    fm1c_sprite(1, 1, fm1c_spr_mini(FM1C_POSE_WORK, 1, 1), 12, pal, 1);
    for (f = 0, y = 0; y < 64u; y++)
        for (x = 0; x < 64u; x++) f += cv[y * 64 + x] != 0u && (x < 1u || x > 12u || y < 1u || y > 12u);
    CHECK(f == 0u && ink(fm1c_spr_mini(FM1C_POSE_WORK, 1, 1), 12) > 0u, "1x: a mini stays inside its 12 x 12 box");
}

static uint32_t ref_frame(uint32_t pose, uint32_t which, uint32_t now)   /* the same, in 64-bit arithmetic */
{
    uint32_t n = FM1C_SPR_ANIM[pose][which ? 2 : 0], fps = FM1C_SPR_ANIM[pose][which ? 3 : 1];
    if (n <= 1u || !fps) return 0;
    return (uint32_t)(((uint64_t)(now + FM1C_ANIM_PHASE_MS) * fps / 1000u) % n);
}

static void timing(void)
{
    uint32_t t, p, bad = 0;
    /* work: 8 fps; with the 60 ms phase its edges are at 65, 190, 315, ... ms */
    CHECK(fm1c_anim_frame(FM1C_POSE_WORK, FM1C_ANIM_HERO, 64) == 0 && fm1c_anim_frame(FM1C_POSE_WORK, FM1C_ANIM_HERO, 65) == 1 &&
          fm1c_anim_frame(FM1C_POSE_WORK, FM1C_ANIM_HERO, 189) == 1 && fm1c_anim_frame(FM1C_POSE_WORK, FM1C_ANIM_HERO, 190) == 2 &&
          fm1c_anim_frame(FM1C_POSE_WORK, FM1C_ANIM_HERO, 440) == 0, "work at 8 fps: frames step at 65, 190, ... (4 frames)");
    CHECK(fm1c_anim_frame(FM1C_POSE_WORK, FM1C_ANIM_MINI, 189) == 0 && fm1c_anim_frame(FM1C_POSE_WORK, FM1C_ANIM_MINI, 190) == 1 &&
          fm1c_anim_frame(FM1C_POSE_WORK, FM1C_ANIM_MINI, 440) == 0, "work mini at 4 fps: 2 frames, edges at 190, 440");
    CHECK(fm1c_anim_frame(FM1C_POSE_SLEEP, FM1C_ANIM_MINI, 12345) == 0 && fm1c_anim_frame(FM1C_POSE_GHOST, FM1C_ANIM_MINI, 999) == 0,
          "still minis: always frame 0");
    for (p = 0; p < FM1C_SPR_POSES; p++)
        for (t = 0; t < 200000u; t += 7u)
            bad += fm1c_anim_frame(p, 0, t) != ref_frame(p, 0, t) || fm1c_anim_frame(p, 1, t) != ref_frame(p, 1, t);
    for (p = 0; p < FM1C_SPR_POSES; p++)
        for (t = 4000000000u; t < 4000200000u; t += 13u)
            bad += fm1c_anim_frame(p, 0, t) != ref_frame(p, 0, t);
    CHECK(bad == 0, "the frame formula equals floor((t + 60) fps / 1000) mod n, also after 46 days (%u wrong)", bad);
    for (t = 0; t < 3000u; t++)                 /* shots at whole and half seconds land mid-frame (host vs emulator) */
        if (t % 500u == 0u)
            for (p = 0; p < FM1C_SPR_POSES; p++)
                bad += fm1c_anim_frame(p, 0, t) != fm1c_anim_frame(p, 0, t + 30u) ||
                       fm1c_anim_frame(p, 0, t) != fm1c_anim_frame(p, 0, t - 30u + (t ? 0u : 30u));
    CHECK(bad == 0, "no frame edge within 30 ms of a whole or half second");
    CHECK(fm1c_anim_dot_at(0) == 1 && fm1c_anim_dot_at(439) == 1 && fm1c_anim_dot_at(440) == 0 && fm1c_anim_dot_at(940) == 1,
          "REC dot: 500 ms on, 500 ms off, edges at 440, 940");
}

static void scheduler(void)
{
    static fm1c_anim a;
    uint32_t hero, dot, keys, px, k, t, n, sum, worst, passes;
    fm1c_anim_init(&a);
    CHECK(fm1c_anim_due(&a, 5000, FM1C_ANIM_PX_PASS, &hero, &dot, &keys) == 0 && !hero && !dot && !keys,
          "nothing on the screen: nothing due");
    /* keys in the same state share a frame */
    fm1c_anim_key(&a, 2, FM1C_POSE_HAND, 1000);
    fm1c_anim_key(&a, 20, FM1C_POSE_HAND, 1000);
    CHECK(a.key_frame[2] == a.key_frame[20], "two approval keys drawn at the same time: the same frame");
    /* calm poses never mark a mini */
    fm1c_anim_init(&a);
    for (k = 0; k < 27u; k++) fm1c_anim_key(&a, k, k % 3u == 0u ? FM1C_POSE_SLEEP : k % 3u == 1u ? FM1C_POSE_HUH : FM1C_POSE_GHOST, 0);
    for (t = 0, n = 0; t < 5000u; t++) { fm1c_anim_due(&a, t, FM1C_ANIM_PX_PASS, &hero, &dot, &keys); n += keys != 0u; }
    CHECK(n == 0, "27 calm minis (asleep, no status, ghost): never redrawn in 5 s");
    /* skipped frames are not queued */
    fm1c_anim_init(&a);
    fm1c_anim_key(&a, 5, FM1C_POSE_WORK, 0);    /* frame 0 at 0 ms */
    px = fm1c_anim_due(&a, 1190, FM1C_ANIM_PX_PASS, &hero, &dot, &keys);   /* 4 edges later: frame 1 */
    CHECK(px == FM1C_ANIM_MINI_PX && keys == 1u << 5 && a.key_frame[5] == fm1c_anim_frame(FM1C_POSE_WORK, 1, 1190),
          "a mini late by several frames: redrawn once, at the frame of now");
    CHECK(fm1c_anim_due(&a, 1191, FM1C_ANIM_PX_PASS, &hero, &dot, &keys) == 0, "... and nothing left owed");
    /* the hero first, the budget never passed */
    fm1c_anim_init(&a);
    fm1c_anim_hero(&a, FM1C_POSE_WORK, 0, 0);
    for (k = 0; k < 27u; k++) fm1c_anim_key(&a, k, FM1C_POSE_HAPPY, 0);
    px = fm1c_anim_due(&a, 190, FM1C_ANIM_PX_PASS, &hero, &dot, &keys);
    CHECK(hero && keys == 0 && px == FM1C_ANIM_HERO_PX, "hero and 27 minis due: the hero alone first (%u px)", px);
    px = fm1c_anim_due(&a, 191, FM1C_ANIM_PX_PASS, &hero, &dot, &keys);
    CHECK(!hero && keys == 0xFFFFu && px == 16u * FM1C_ANIM_MINI_PX, "next pass: 16 minis, 2,304 px (%u)", px);
    px = fm1c_anim_due(&a, 192, FM1C_ANIM_PX_PASS, &hero, &dot, &keys);
    CHECK(!hero && keys == 0x7FF0000u && px == 11u * FM1C_ANIM_MINI_PX, "then the other 11 (%u)", px);
    CHECK(fm1c_anim_due(&a, 193, FM1C_ANIM_PX_PASS, &hero, &dot, &keys) == 0, "then nothing until the next edge");
    CHECK(fm1c_anim_due(&a, 440, 100, &hero, &dot, &keys) == 0 && !hero, "a budget below one box: nothing (not a partial box)");
    /* the REC dot */
    fm1c_anim_init(&a);
    fm1c_anim_dot(&a, 1, 0);
    CHECK(fm1c_anim_due(&a, 300, FM1C_ANIM_PX_PASS, &hero, &dot, &keys) == 0 &&
          fm1c_anim_due(&a, 440, FM1C_ANIM_PX_PASS, &hero, &dot, &keys) == FM1C_ANIM_DOT_PX && dot && a.dot == 0,
          "REC dot: redrawn at its edge only, 64 px");
    /* a second of main-loop passes (one per ms), the worst page: hero at 8 fps, all 27 minis in attention poses */
    fm1c_anim_init(&a);
    fm1c_anim_hero(&a, FM1C_POSE_HAPPY, 10000, 0);
    for (k = 0; k < 27u; k++) fm1c_anim_key(&a, k, k % 2u ? FM1C_POSE_WORK : FM1C_POSE_DIZZY, 10000);
    for (t = 10000, sum = 0, worst = 0, passes = 0; t < 11000u; t++) {
        px = fm1c_anim_due(&a, t, FM1C_ANIM_PX_PASS, &hero, &dot, &keys);
        sum += px;
        worst = px > worst ? px : worst;
        passes += px != 0u;
    }
    CHECK(worst <= FM1C_ANIM_PX_PASS, "worst pass %u px <= 2,400", worst);
    CHECK(sum <= 34000u && sum == 8u * FM1C_ANIM_HERO_PX + 4u * 27u * FM1C_ANIM_MINI_PX,
          "1 s, all 27 minis animated: %u px <= 34,000 (8 hero frames + 4 x 27 minis), in %u passes", sum, passes);
    /* the sample page of docs/ui-v3.md 3.A: hero at 8 fps, 9 attention minis */
    fm1c_anim_init(&a);
    fm1c_anim_hero(&a, FM1C_POSE_HAPPY, 20000, 0);
    for (k = 0; k < 27u; k++) fm1c_anim_key(&a, k, k < 9u ? FM1C_POSE_WAVE : k < 15u ? FM1C_POSE_SLEEP : FM1C_SPR_NONE, 20000);
    for (t = 20000, sum = 0; t < 21000u; t++) sum += fm1c_anim_due(&a, t, FM1C_ANIM_PX_PASS, &hero, &dot, &keys);
    CHECK(sum == 23616u, "the sample page: %u px/s (docs/ui-v3.md: 23,616)", sum);
    /* calm page: only the hero (asleep, 4 fps) for 3 s */
    fm1c_anim_init(&a);
    fm1c_anim_hero(&a, FM1C_POSE_SLEEP, 30000, 0);
    for (k = 0; k < 27u; k++) fm1c_anim_key(&a, k, FM1C_POSE_SLEEP, 30000);
    for (t = 30000, sum = 0; t < 33000u; t++) sum += fm1c_anim_due(&a, t, FM1C_ANIM_PX_PASS, &hero, &dot, &keys);
    CHECK(sum <= 27648u && sum == 12u * FM1C_ANIM_HERO_PX, "3 s, every session calm: the hero box only, %u px <= 27,648", sum);
    /* version 5 list (docs/ui-v3.md 8.5): the 24 x 24 hero at 1x and the 10 minis of the window; worst ~10,400 px/s */
    fm1c_anim_init(&a);
    fm1c_anim_hero(&a, FM1C_POSE_HAPPY, 40000, 0);
    a.hero_small = 1;
    for (k = 0; k < 10u; k++) fm1c_anim_key(&a, k, k % 2u ? FM1C_POSE_WORK : FM1C_POSE_HAND, 40000);
    for (t = 40000, sum = 0, worst = 0; t < 41000u; t++) {
        px = fm1c_anim_due(&a, t, FM1C_ANIM_PX_PASS, &hero, &dot, &keys);
        sum += px;
        worst = px > worst ? px : worst;
    }
    CHECK(sum == 8u * FM1C_ANIM_HERO1_PX + 4u * 10u * FM1C_ANIM_MINI_PX && sum <= 10400u && worst <= FM1C_ANIM_PX_PASS,
          "list: 1 s, the small hero at 8 fps and 10 attention minis: %u px (<= 10,400), worst pass %u", sum, worst);
    fm1c_anim_hero(&a, FM1C_POSE_HAPPY, 40000, 0);
    CHECK(!a.hero_small, "a version 4 hero drawn again: the 48 x 48 box");
}

int main(void)
{
    tables();
    blitter();
    timing();
    scheduler();
    T_DONE("anim_test");
}
