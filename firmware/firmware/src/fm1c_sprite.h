/* SPDX-License-Identifier: GPL-3.0-only */
/* Sprite drawing into the open canvas (gfx.c cv_pset): the 4 bpp frames of fm1c_sprites.h, index 0 transparent,
 * at 1x or 2x, through a 16-entry RGB565 palette. Uses only the platform's cv_* calls. Included by fm1c_draw.h after
 * fm1c_c (a dimmed frame draws its characters dimmed too, except the banner's, which never is). */
#pragma once
#include "fm1c_sprites.h"

/* the palette of a state's characters: the fixed colours 1-12, the state's body / light / shade as 13-15 */
static void fm1c_spr_pal(uint32_t state, uint16_t out[16])
{
    uint32_t i;
    if (state >= 10u) state = 9u;
    out[0] = 0;
    for (i = 1; i < 13u; i++) out[i] = fm1c_c(FM1C_SPR_PAL_BASE[i]);
    for (i = 0; i < 3u; i++) out[13u + i] = fm1c_c(FM1C_SPR_PAL_STATE[state][i]);
}

/* an n x n frame at canvas (x, y), each pixel scale x scale */
static void fm1c_sprite(int32_t x, int32_t y, const uint8_t *px4, uint32_t n, const uint16_t pal[16], uint32_t scale)
{
    uint32_t sx, sy;
    for (sy = 0; sy < n; sy++)
        for (sx = 0; sx < n; sx++) {
            uint32_t v = px4[(sy * n + sx) >> 1];
            v = (sx & 1u) ? (v & 15u) : (v >> 4);
            if (!v) continue;
            if (scale == 2u) {
                int32_t X = x + (int32_t)sx * 2, Y = y + (int32_t)sy * 2;
                cv_pset(X, Y, pal[v]);
                cv_pset(X + 1, Y, pal[v]);
                cv_pset(X, Y + 1, pal[v]);
                cv_pset(X + 1, Y + 1, pal[v]);
            } else {
                cv_pset(x + (int32_t)sx, y + (int32_t)sy, pal[v]);
            }
        }
}

/* the frames of a pose: provider 1 = Codex's bot, anything else Claude's cat */
static const uint8_t *fm1c_spr_hero(uint32_t pose, uint32_t codex, uint32_t frame)
{
    return FM1C_SPR_HERO[FM1C_SPR_HERO_AT[pose][codex ? 1 : 0] + frame];
}
static const uint8_t *fm1c_spr_mini(uint32_t pose, uint32_t codex, uint32_t frame)
{
    return FM1C_SPR_MINI[FM1C_SPR_MINI_AT[pose][codex ? 1 : 0] + frame];
}
