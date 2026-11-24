/* SPDX-License-Identifier: GPL-3.0-only */
/* Version 5's LIST layout (docs/ui-v3.md section 8, direction B's chat list): Sessions and TO DO with SET_VIEW.layout 1.
 * The same slots, in key order, as rows with key names; the selected chat's character and its newest line on top.
 * Version 5 grouped (section 9.3): Sessions with layout 2, the same bands; header rows and indented sessions.
 * Included by fm1c_draw4.h (after the version 4 drawers it reuses); fm1c_draw4() comes here when fm1c_list(m).
 *
 *   y   0- 17  top bar, as version 4
 *   y  18- 59  x 0-28: the hero, 24 x 24 at 1x at (4, 26) | x 29-239: the header bubble, a cut-corner frame 204 x 40 at
 *               (34, 19) with its tail left at the hero; caption (row 0) at (40, 22) and the key name ending at x 231;
 *               the message line (row 1) at (40, 38); row 2 non-empty: the more wedge at (224, 55)
 *   y  60- 223 x 0-235: 10 list rows of 16 px at y 62 + 16 n (rows 60-61 and 222-223 black) | x 236-239: the scroll
 *               column, a 2 px thumb at x 237 when the page has more than 10 entries
 *   y 224-239  hint bar, as version 4
 * Regions tile the screen: hero 29 x 42, header 211 x 42 (or its caption / message / wedge strips alone), each row
 * 236 x 16, the two gaps 236 x 2, the scroll column 4 x 164, the hint bar. Animation redraws the hero's 24 x 24 and the
 * 12 x 12 minis of the rows shown (fm1c_draw_anim). */
#pragma once

#define FM1C_V5_HERO_X 4
#define FM1C_V5_HERO_Y 26
#define FM1C_V5_ROW_Y 62
#define FM1C_V5_ROW_W 236
#define FM1C_V5_MINI_X 4                        /* the mini in its row */
#define FM1C_V5_MINI_Y 2
#define FM1C_V6_ROW_Y 94                        /* version 6 SPLIT (docs/ui-v3.md section 10.7): 8 rows below the black row band */
/* the list rows' first y: 62, or 94 under the SPLIT band */
static uint32_t fm1c_list_y(const fm1c_model *m) { return fm1c_split_list(m) ? FM1C_V6_ROW_Y : FM1C_V5_ROW_Y; }

/* ---- the hero: x 0-28, y 18-59 */
static void fm1c_draw5_hero(const fm1c_model *m)
{
    uint32_t pose = fm1c_anim_pose(fm1c_v4_state(m), 0);
    uint16_t pal[16];
    fm1c_cvb(29, 42, C_BLACK);
    if (pose != FM1C_SPR_NONE) {
        fm1c_spr_pal(fm1c_v4_state(m), pal);
        fm1c_sprite(FM1C_V5_HERO_X, FM1C_V5_HERO_Y - 18, fm1c_spr_hero(pose, (uint32_t)fm1c_v4_codex(m),
                    fm1c_anim_frame(pose, FM1C_ANIM_HERO, fm1c_now)), FM1C_SPR_HERO_N, pal, 1);
    }
    fm1c_cvx(0, 18);
    fm1c_anim_hero(&fm1c_an, fm1c_dim ? FM1C_SPR_NONE : pose, fm1c_now, 0);
    fm1c_an.hero_small = 1;
}

/* ---- a SET_TEXT row cut to max visible cells (the header's caption 20, message line 24: SET_TEXT rows carry up to
 * 29, and a longer row would reach the key name or the frame in the whole-header redraw but not in its strip); with
 * the version 7 marks of the row's style st */
static void fm1c_v5_text(int32_t x, int32_t y, const char *t, uint32_t max, uint16_t c, uint32_t st)
{
    fm1c_rich(x, y, t, max, c, st);
}

/* ---- the header bubble into the open canvas whose top-left is screen (ox, oy) */
static void fm1c_v5_head_into(const fm1c_model *m, int32_t ox, int32_t oy)
{
    uint16_t c = fm1c_v4_bubble_col(m);
    int32_t sel = fm1c_selected(m), i;
    fm1c_v4_frame(34 - ox, 19 - oy, 204, 40, c);
    for (i = 0; i < 5; i++) {                   /* the tail: left, at the hero, open into the bubble */
        fm1c_rect(29 + i - ox, 31 - oy, 1, 1, c);
        fm1c_rect(29 + i - ox, 32 + i - oy, 1, 1, c);
    }
    fm1c_rect(34 - ox, 32 - oy, 1, 5, C_BLACK);
    fm1c_v5_text(40 - ox, 22 - oy, m->text[0], 20u, fm1c_v4_col(fm1c_v4_state(m)), fm1c_tst(m, 0));
    if (sel >= 0)
        fm1c_text(232 - ox - text_w(&FONT_S, FM1C_NOTE[sel]), 22 - oy, &FONT_S, FM1C_NOTE[sel], FM1C_C_GREY);
    fm1c_v5_text(40 - ox, 38 - oy, m->text[1], 24u, FM1C_STYLE_RGB[fm1c_tst(m, 1)], fm1c_tst(m, 1));
    if (m->text[2][0])
        for (i = 0; i < 4; i++)                 /* more below: the white wedge on the bottom edge */
            fm1c_rect(224 + i - ox, 55 + i - oy, 7 - 2 * i, 1, C_WHITE);
}
static void fm1c_v5_head(const fm1c_model *m, int32_t x, int32_t y, int32_t w, int32_t h)
{
    fm1c_cvb((uint32_t)w, (uint32_t)h, C_BLACK);
    fm1c_v5_head_into(m, x, y);
    fm1c_cvx((uint32_t)x, (uint32_t)y);
}

/* ---- a header row (version 5 grouped, docs/ui-v3.md section 9.3): rule, still mini, pin dot, title, count; a
 * folded task row adds its key name. Into the open 236 x 16 canvas. */
static void fm1c_v5_header(const fm1c_model *m, uint32_t k)
{
    const fm1c_slot *s = &m->slot[k];
    uint32_t st = s->head_state < FM1C_N_STATE ? s->head_state : FM1C_S_UNKNOWN, pose = fm1c_anim_pose(st, 0), i, max;
    int folded = (s->row & FM1C_ROW_TASK) != 0u;
    int32_t xc = 233 - text_w(&FONT_S, s->head_count), x0 = folded ? 48 : 20;
    char b[FM1C_L_HEAD + 1];
    uint16_t pal[16];
    fm1c_rect(0, 0, FM1C_V5_ROW_W, 1, FM1C_C_OUTLINE);
    if (pose != FM1C_SPR_NONE) {
        fm1c_spr_pal(st, pal);
        fm1c_sprite(FM1C_V5_MINI_X, FM1C_V5_MINI_Y, fm1c_spr_mini(pose, 0, 0), FM1C_SPR_MINI_N, pal, 1);
    }
    if (s->head_flags & FM1C_HEAD_PINNED) fm1c_rect(15, 1, 2, 2, C_WHITE);
    if (folded) fm1c_text(20, 0, &FONT_S, FM1C_NOTE[k], FM1C_C_GREY);
    max = xc - 8 - x0 > 0 ? (uint32_t)(xc - 8 - x0) / 8u : 0u;
    for (i = 0; i < max && s->head_title[i]; i++) b[i] = s->head_title[i];
    b[i] = 0;
    fm1c_text(x0, 0, &FONT_S, b, folded ? FM1C_C_TEXT2 : C_WHITE);
    fm1c_text(xc, 0, &FONT_S, s->head_count, fm1c_v4_col(st));
}

/* ---- one list row (n = 0..9): a session (mini, pin, key name, title, age; the selected row on grey; grouped: shifted
 * right by 8 per indent) or, grouped, a header */
static void fm1c_draw5_row(const fm1c_model *m, uint32_t n)
{
    int32_t e = fm1c_list_ent(m, n);
    fm1c_cvb(FM1C_V5_ROW_W, 16, C_BLACK);
    if (e >= 0 && (e & 1)) {
        uint32_t k = (uint32_t)e >> 1;
        fm1c_v5_header(m, k);
        if (m->slot[k].row & FM1C_ROW_TASK) fm1c_anim_key(&fm1c_an, k, FM1C_SPR_NONE, fm1c_now);   /* (still) */
    } else if (e >= 0) {
        uint32_t k = (uint32_t)e >> 1;
        const fm1c_slot *s = &m->slot[k];
        uint32_t st = s->state < FM1C_N_STATE ? s->state : FM1C_S_UNKNOWN;
        uint32_t sel = (s->flags & FM1C_F_SELECTED) != 0u && !fm1c_sel_hide;
        uint32_t pose = fm1c_anim_pose(st, (s->flags & FM1C_F_STALE) != 0u);
        int32_t d = fm1c_grouped(m) ? 8 * (int32_t)(s->row & FM1C_ROW_INDENT) : 0;
        if (sel) fm1c_rect(0, 0, FM1C_V5_ROW_W, 16, FM1C_C_OUTLINE);
        if (pose != FM1C_SPR_NONE)
            fm1c_v4_mini(m, k, FM1C_V5_MINI_X + d, FM1C_V5_MINI_Y, pose, fm1c_anim_frame(pose, FM1C_ANIM_MINI, fm1c_now));
        if (s->flags & FM1C_F_PINNED) fm1c_rect(15 + d, 1, 2, 2, C_WHITE);
        fm1c_text(20 + d, 0, &FONT_S, FM1C_NOTE[k], sel ? C_WHITE : FM1C_C_GREY);
        {                                       /* (grouped: at most 20 - indent characters, so it never reaches the age;
                                                 * the host cuts it so, section 9.3: a longer one is cut here) */
            char tb[FM1C_L_ROW + 1];
            uint32_t i, max = FM1C_L_ROW - (uint32_t)d / 8u;
            for (i = 0; i < max && s->title[i]; i++) tb[i] = s->title[i];
            tb[i] = 0;
            fm1c_text(48 + d, 0, &FONT_S, tb, (s->flags & FM1C_F_STALE) ? FM1C_C_GREY : sel ? C_WHITE : FM1C_C_TEXT2);
        }
        fm1c_text(233 - text_w(&FONT_S, s->age), 0, &FONT_S, s->age, sel ? C_WHITE : FM1C_C_GREY);
        fm1c_anim_key(&fm1c_an, k, fm1c_dim ? FM1C_SPR_NONE : pose, fm1c_now);
    }
    fm1c_cvx(0, fm1c_list_y(m) + 16u * n);
}

/* ---- the gaps above and below the rows and the scroll column: x 236-239, y 60-223 (version 6 SPLIT: y 92-223, the
 * rows' area 128 px from y 94) */
static void fm1c_draw5_frame(const fm1c_model *m)
{
    uint32_t top, n = fm1c_list_win(m, &top, 0), rows = fm1c_list_rows(m), y0 = fm1c_list_y(m) - 2u, area = 16u * rows;
    fm1c_cvb(FM1C_V5_ROW_W, 2, C_BLACK);
    fm1c_cvx(0, y0);
    fm1c_cvx(0, 222);                            /* (the canvas is still black: sent again) */
    fm1c_cvb(4, 224u - y0, C_BLACK);
    if (n > rows) {
        uint32_t left = n - top < rows ? n - top : rows;
        fm1c_rect(1, (int32_t)(2u + area * top / n), 2, (int32_t)(area * left / n), FM1C_C_GREY);
    }
    fm1c_cvx(236, y0);
}
