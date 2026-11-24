/* SPDX-License-Identifier: GPL-3.0-only */
/* Version 6's screens (docs/ui-v3.md section 10.7 and 10.2): SPLIT keys and the SETTINGS view. Included by fm1c_draw4.h
 * after the version 4/5 drawers it reuses; fm1c_draw4() and fm1c_scene() (fm1c_trans.h) come here when the model says
 * so (fm1c_split_band, fm1c_compact, fm1c_settings in fm1c_model.h).
 *
 * SPLIT (SET_VIEW keys 1, Sessions): the 11 black keys as chips 26 x 16 at their physical positions, centre
 * c = 8 + 14 (a + 1) for the white key a they follow (22 ... 218), on two staggered lines (black index i even: line A,
 * odd: line B, 16 px lower), so a 3-character tag fits where neighbours are only 14 px apart; a line A chip has a 1 px
 * stem down between the line B chips. The task page dots (task_pages > 1) at x 234-235.
 *   Buddy:  bubble frame 236 x 92 at (2, 74), body rows 1-4, row 5 the "more" wedge (strip y 160-167);
 *           band y 168-199 (FM1C_D_BAND); white minis y 200-223 as version 4 (FM1C_D_KBD)
 *   List / Grouped: header as version 5; band y 60-91; 8 rows of 16 px from y 94 (fm1c_draw5.h with fm1c_list_y)
 *   voice / confirm over SPLIT Sessions: the version 4 strip, each black box drawn compact (fm1c_key4)
 * SETTINGS (view 6): top bar (no page number), rows 18-21 black, 9 item rows 240 x 20 at y 22 + 20 n (the cursor row on
 * FM1C_C_OUTLINE with a ">"), the description at y 202-223, the hint bar. No hero, no keys, no animation.
 * Chips never animate (fm1c_anim_key NONE); a chip's redraw is its box (416 px) and its stem (16 px). */
#pragma once

#define FM1C_V6_BAND_Y 168                      /* Buddy: the black row band */
#define FM1C_V6_LBAND_Y 60                      /* List / Grouped */
#define FM1C_V6_WHITE_Y 200                     /* Buddy: the white row */
#define FM1C_V6_SET_Y 22                        /* settings: item row 0 */
#define FM1C_V6_DESC_Y 202                      /* settings: the description band */

static const uint8_t FM1C_BLACK_KEY[11] = {1, 3, 5, 8, 10, 13, 15, 17, 20, 22, 25};

static uint32_t fm1c_black_index(uint32_t k)    /* 0..10 in key order (k must be black) */
{
    uint32_t i;
    for (i = 0; i < 10u && FM1C_BLACK_KEY[i] != k; i++) {}
    return i;
}
static int32_t fm1c_chip_cx(uint32_t k) { return 8 + 14 * ((int32_t)(FM1C_WHITE_OF[k] & 0x7Fu) + 1); }
static int fm1c_filter_key(uint32_t k) { return k == 1u || k == 3u || k == 5u; }   /* ALL, PINNED, NEEDS YOU */
static uint32_t fm1c_band_y(const fm1c_model *m) { return fm1c_split_list(m) ? FM1C_V6_LBAND_Y : FM1C_V6_BAND_Y; }
/* chip k's box: x0, y0 (screen) */
static void fm1c_chip_box(const fm1c_model *m, uint32_t k, int32_t *x0, int32_t *y0)
{
    *x0 = fm1c_chip_cx(k) - 13;
    *y0 = (int32_t)fm1c_band_y(m) + ((fm1c_black_index(k) & 1u) ? 16 : 0);
}

/* one black key's chip and stem into the open canvas whose top-left is screen (ox, oy) */
static void fm1c_chip6(const fm1c_model *m, uint32_t k, int32_t ox, int32_t oy)
{
    const fm1c_slot *s = &m->slot[k];
    uint32_t st = s->state < FM1C_N_STATE ? s->state : FM1C_S_UNKNOWN, n;
    int32_t x0, y0, c = fm1c_chip_cx(k) - ox, stem = (fm1c_black_index(k) & 1u) == 0u;
    int filter = fm1c_filter_key(k), chosen = (s->flags & FM1C_F_CHOSEN) != 0u;
    uint16_t col = fm1c_v4_col(st), tag = C_BLACK, sc = col;
    char b[4];
    fm1c_chip_box(m, k, &x0, &y0);
    x0 -= ox; y0 -= oy;
    fm1c_rect(x0, y0, 26, 16, C_BLACK);
    fm1c_anim_key(&fm1c_an, k, FM1C_SPR_NONE, fm1c_now);   /* (chips never animate) */
    if (chosen) {                               /* the chosen filter or task: white, black tag, white stem */
        fm1c_rect(x0, y0, 26, 16, C_WHITE);
        sc = C_WHITE;
    } else if (filter) {                        /* a filter: a frame and a tag in its colour (no state: grey) */
        fm1c_frame(x0, y0, 26, 16, 1, st == FM1C_S_EMPTY ? FM1C_C_OUTLINE : col);
        tag = st == FM1C_S_EMPTY ? FM1C_C_GREY : col;
    } else if (st == FM1C_S_EMPTY) {            /* an empty task slot: a dash, no stem */
        fm1c_rect(x0 + 11, y0 + 7, 4, 2, FM1C_C_OUTLINE);
        return;
    } else {                                    /* a task: filled with its state colour */
        fm1c_rect(x0, y0, 26, 16, col);
        tag = fm1c_dark(col) ? C_WHITE : C_BLACK;
    }
    for (n = 0; n < 3u && s->label[n]; n++) b[n] = s->label[n];
    b[n] = 0;
    fm1c_text(x0 + (26 - text_w(&FONT_S, b)) / 2, y0, &FONT_S, b, tag);
    if (!filter && (s->flags & FM1C_F_PINNED)) fm1c_rect(x0 + 23, y0 + 1, 2, 2, tag);
    if (stem) fm1c_rect(c, y0 + 16, 1, 16, sc);
}

/* the task page dots into the band's canvas (its top-left at the band's) */
static void fm1c_dots6(const fm1c_model *m)
{
    uint32_t n, j, cur;
    if (m->task_pages <= 1u) return;
    n = m->task_pages < 8u ? m->task_pages : 8u;
    cur = m->task_pages <= 8u ? m->task_page : (uint32_t)m->task_page * 8u / m->task_pages;
    for (j = 0; j < n; j++) fm1c_rect(234, 1 + 4 * (int32_t)j, 2, 2, j == cur ? C_WHITE : FM1C_C_GREY);
}

/* the whole band: 240 x 32 (7,680 px) */
static void fm1c_draw6_band(const fm1c_model *m)
{
    uint32_t ya = fm1c_band_y(m), i;
    fm1c_cvb(240, 32, C_BLACK);
    for (i = 0; i < 11u; i++) fm1c_chip6(m, FM1C_BLACK_KEY[i], 0, (int32_t)ya);
    fm1c_dots6(m);
    fm1c_cvx(0, ya);
}

/* one chip: its box, then (line A) its stem, each its own blit */
static void fm1c_draw6_chip(const fm1c_model *m, uint32_t k)
{
    int32_t x0, y0;
    fm1c_chip_box(m, k, &x0, &y0);
    fm1c_cvb(26, 16, C_BLACK);
    fm1c_chip6(m, k, x0, y0);
    fm1c_cvx((uint32_t)x0, (uint32_t)y0);
    if (fm1c_black_index(k) & 1u) return;
    fm1c_cvb(1, 16, C_BLACK);
    fm1c_chip6(m, k, fm1c_chip_cx(k), y0 + 16);
    fm1c_cvx((uint32_t)fm1c_chip_cx(k), (uint32_t)(y0 + 16));
}

/* Buddy: the white row, 240 x 24 at y 200 (5,760 px): the 16 white minis as version 4 */
static void fm1c_draw6_white(const fm1c_model *m)
{
    uint32_t k;
    fm1c_cvb(240, 24, C_BLACK);
    for (k = 0; k < FM1C_NSLOT; k++)
        if (!fm1c_key_black(k)) fm1c_key4(m, k, 0, FM1C_V6_WHITE_Y);
    fm1c_cvx(0, FM1C_V6_WHITE_Y);
}

/* Buddy: the 4-row bubble's strips around its rows (6,080 px) */
static void fm1c_draw6_bubble(const fm1c_model *m)
{
    fm1c_v4_strip(m, 0, 68, 240, 10);           /* tail, top edge */
    fm1c_v4_strip(m, 0, 78, 8, 82);             /* left edge */
    fm1c_v4_strip(m, 232, 78, 8, 82);           /* right edge */
    fm1c_v4_strip(m, 8, 94, 224, 2);            /* between the caption and the body */
    fm1c_v4_strip(m, 0, 160, 240, 8);           /* bottom edge, the wedge */
}

/* voice / confirm over SPLIT Sessions: a black key's 14 x 14 box, compact (no tag), into the open canvas */
static void fm1c_key6_compact(const fm1c_model *m, uint32_t k, int32_t bx, int32_t by)
{
    const fm1c_slot *s = &m->slot[k];
    uint32_t st = s->state < FM1C_N_STATE ? s->state : FM1C_S_UNKNOWN;
    uint16_t col = fm1c_v4_col(st);
    fm1c_rect(bx, by, 14, 14, C_BLACK);
    if (s->flags & FM1C_F_CHOSEN) fm1c_rect(bx + 1, by + 1, 12, 12, C_WHITE);
    else if (fm1c_filter_key(k)) fm1c_frame(bx + 1, by + 1, 12, 12, 1, col);
    else if (st == FM1C_S_EMPTY) fm1c_rect(bx + 5, by + 6, 4, 2, FM1C_C_DASH_BLACK);
    else fm1c_rect(bx + 1, by + 1, 12, 12, col);
    fm1c_anim_key(&fm1c_an, k, FM1C_SPR_NONE, fm1c_now);
}

/* ---- SETTINGS (view 6) */
static void fm1c_draw6_item(const fm1c_model *m, uint32_t n)   /* item row n: 240 x 20 */
{
    int on = n < m->pages, cur = on && n == m->page;
    fm1c_cvb(240, 20, C_BLACK);
    if (cur) {
        fm1c_rect(0, 0, 240, 20, FM1C_C_OUTLINE);
        fm1c_text(4, 2, &FONT_S, ">", C_WHITE);
    }
    if (on)                                     /* (26 characters: 208 px from x 16) */
        fm1c_v5_text(16, 2, m->text[n], 26u, cur ? C_WHITE : m->tstyle[n] == FM1C_TS_MUTED ? FM1C_C_GREY : FM1C_C_TEXT2, fm1c_tst(m, n));
    fm1c_cvx(0, FM1C_V6_SET_Y + 20u * n);
}
static void fm1c_draw6_desc(const fm1c_model *m)   /* the description: 240 x 22 at y 202 */
{
    fm1c_cvb(240, 22, C_BLACK);
    fm1c_v5_text(4, 2, m->text[9], FM1C_L_TEXT, FM1C_C_MUTED, fm1c_tst(m, 9));
    fm1c_cvx(0, FM1C_V6_DESC_Y);
}
static void fm1c_draw6_settings(const fm1c_model *m)   /* the body: the gap, every item row, the description */
{
    uint32_t n;
    fm1c_cvb(240, 4, C_BLACK);
    fm1c_cvx(0, 18);
    for (n = 0; n < FM1C_SET_ITEMS; n++) fm1c_draw6_item(m, n);
    fm1c_draw6_desc(m);
}
