/* SPDX-License-Identifier: GPL-3.0-only */
/* The character animation scheduler (docs/ui-v3.md section 6.1): which sprite boxes show a stale frame now, and which
 * of them one main-loop pass may redraw within its pixel budget. Animation is the lowest-priority drawing: console.c
 * calls it only on a pass that drew no content, with no host frame queued, no device frame awaiting its ACK and
 * 20 ms after the last host frame. Frames come from the clock, so every box in the same pose shows the same frame
 * (as the key LEDs blink together); a box not redrawn on time is redrawn later at the frame of that later time:
 * frames are skipped, never queued. Pure (<stdint.h> and the generated sprite tables), so tests/console/anim_test.c
 * runs it alone.
 *
 * The content drawers (fm1c_draw.h) record what they drew with fm1c_anim_hero / fm1c_anim_key / fm1c_anim_dot; a
 * pose of FM1C_SPR_NONE means "not on the screen" (an empty key, the DETAILS page, the help, the dimmed screen). */
#pragma once
#include <stdint.h>
#include "fm1c_sprites.h"

#define FM1C_ANIM_PX_PASS 2400u                 /* per pass: one hero frame (2,304 px, 3.1 ms of SPI at 12 MHz) or 16 minis */
#define FM1C_ANIM_HERO_PX 2304u                 /* the 48 x 48 hero box */
#define FM1C_ANIM_HERO1_PX 576u                 /* version 5 list: the 24 x 24 hero box (1x) */
#define FM1C_ANIM_MINI_PX 144u                  /* a mini's 12 x 12 sprite box (its frame, pin and selection stay) */
#define FM1C_ANIM_DOT_PX 64u                    /* the voice bubble's 8 x 8 REC dot */
#define FM1C_ANIM_DOT_MS 500u                   /* the REC dot: on 500 ms, off 500 ms */
#define FM1C_ANIM_PHASE_MS 60u                  /* frame edges at 60 ms before whole seconds (0, 500 ms are mid-frame) */
#define FM1C_ANIM_NKEY 27u
enum { FM1C_ANIM_HERO = 0, FM1C_ANIM_MINI = 1 };

typedef struct {
    uint8_t hero_pose, hero_frame, hero_banner; /* the hero box (hero_banner: the NO COMPANION banner's ghost) */
    uint8_t hero_small;                         /* the hero is the list layout's 24 x 24 at 1x */
    uint8_t dot;                                /* the REC dot as drawn: 0 off, 1 on, FM1C_SPR_NONE not shown */
    uint8_t key_pose[FM1C_ANIM_NKEY], key_frame[FM1C_ANIM_NKEY];
} fm1c_anim;

static void fm1c_anim_init(fm1c_anim *a)
{
    uint32_t k;
    a->hero_pose = FM1C_SPR_NONE;
    a->hero_frame = 0;
    a->hero_banner = 0;
    a->hero_small = 0;
    a->dot = FM1C_SPR_NONE;
    for (k = 0; k < FM1C_ANIM_NKEY; k++) { a->key_pose[k] = FM1C_SPR_NONE; a->key_frame[k] = 0; }
}

/* the frame of a pose at time now: floor((now + phase) * fps / 1000) mod frames, computed without 64-bit math */
static uint32_t fm1c_anim_frame(uint32_t pose, uint32_t which, uint32_t now)
{
    uint32_t n, fps, t, s;
    if (pose >= FM1C_SPR_POSES) return 0;
    n = FM1C_SPR_ANIM[pose][which ? 2 : 0];
    fps = FM1C_SPR_ANIM[pose][which ? 3 : 1];
    if (n <= 1u || !fps) return 0;
    t = now + FM1C_ANIM_PHASE_MS;
    s = t / 1000u;                              /* whole seconds: s * fps frames, exactly */
    return ((s % n) * fps + (t % 1000u) * fps / 1000u) % n;
}

/* the pose a slot shows: none for an empty slot, the ghost for a stale one (its identity no longer resolves) */
static uint32_t fm1c_anim_pose(uint32_t state, uint32_t stale)
{
    if (state >= 10u) state = 9u;               /* (an unknown value: "no status") */
    if (FM1C_SPR_POSE_OF_STATE[state] == FM1C_SPR_NONE) return FM1C_SPR_NONE;
    return stale ? (uint32_t)FM1C_POSE_GHOST : FM1C_SPR_POSE_OF_STATE[state];
}

/* a mini in this pose moves (the five states that want attention); calm minis stay still and cost nothing */
static int fm1c_anim_mini_moves(uint32_t pose)
{
    return pose < FM1C_SPR_POSES && FM1C_SPR_ANIM[pose][2] > 1u && FM1C_SPR_ANIM[pose][3] > 0u;
}

static uint32_t fm1c_anim_dot_at(uint32_t now) { return ((now + FM1C_ANIM_PHASE_MS) / FM1C_ANIM_DOT_MS) % 2u == 0u; }

/* what the content drawers drew */
static void fm1c_anim_hero(fm1c_anim *a, uint32_t pose, uint32_t now, uint32_t banner)
{
    a->hero_pose = (uint8_t)pose;
    a->hero_frame = (uint8_t)fm1c_anim_frame(pose, FM1C_ANIM_HERO, now);
    a->hero_banner = (uint8_t)(banner ? 1u : 0u);
    a->hero_small = 0;                          /* (the list's hero sets it after this) */
}
static void fm1c_anim_key(fm1c_anim *a, uint32_t k, uint32_t pose, uint32_t now)
{
    if (k >= FM1C_ANIM_NKEY) return;
    a->key_pose[k] = (uint8_t)pose;
    a->key_frame[k] = (uint8_t)fm1c_anim_frame(pose, FM1C_ANIM_MINI, now);
}
static void fm1c_anim_dot(fm1c_anim *a, uint32_t shown, uint32_t now)
{
    a->dot = (uint8_t)(shown ? fm1c_anim_dot_at(now) : FM1C_SPR_NONE);
}
static void fm1c_anim_forget_keys(fm1c_anim *a)
{
    uint32_t k;
    for (k = 0; k < FM1C_ANIM_NKEY; k++) a->key_pose[k] = FM1C_SPR_NONE;
}

/* The boxes due now within budget_px: the hero first, then the REC dot, then the keys in order. It stops before
 * the next box would pass the budget. *hero / *dot: 1 to redraw; *keys: a bit per key. The chosen boxes are taken
 * as drawn (their frame is recorded): the caller draws them at once. Returns the pixels chosen. */
static uint32_t fm1c_anim_due(fm1c_anim *a, uint32_t now, uint32_t budget_px, uint32_t *hero, uint32_t *dot,
                              uint32_t *keys)
{
    uint32_t px = 0, k, f, hpx = a->hero_small ? FM1C_ANIM_HERO1_PX : FM1C_ANIM_HERO_PX;
    *hero = 0;
    *dot = 0;
    *keys = 0;
    if (a->hero_pose != FM1C_SPR_NONE && (f = fm1c_anim_frame(a->hero_pose, FM1C_ANIM_HERO, now)) != a->hero_frame) {
        if (px + hpx > budget_px) return px;
        px += hpx;
        a->hero_frame = (uint8_t)f;
        *hero = 1;
    }
    if (a->dot != FM1C_SPR_NONE && (f = fm1c_anim_dot_at(now)) != a->dot) {
        if (px + FM1C_ANIM_DOT_PX > budget_px) return px;
        px += FM1C_ANIM_DOT_PX;
        a->dot = (uint8_t)f;
        *dot = 1;
    }
    for (k = 0; k < FM1C_ANIM_NKEY; k++) {
        uint32_t pose = a->key_pose[k];
        if (!fm1c_anim_mini_moves(pose) || (f = fm1c_anim_frame(pose, FM1C_ANIM_MINI, now)) == a->key_frame[k]) continue;
        if (px + FM1C_ANIM_MINI_PX > budget_px) break;
        px += FM1C_ANIM_MINI_PX;
        a->key_frame[k] = (uint8_t)f;
        *keys |= 1u << k;
    }
    return px;
}
