/* SPDX-License-Identifier: GPL-3.0-only */
/* Version 4's screen (docs/ui-v3.md section 3.A, "Buddy and bubble"): a character for the selected chat, its newest
 * message in a speech bubble, the 27 sessions as critters in keyboard order, the hint bar at the bottom of every view.
 * Included by fm1c_draw.h (after fm1c_help.h); fm1c_draw() comes here when version 4 is the layout (fm1c_v4).
 *
 *   y   0- 17  top bar: title | page, link dot, badge (fm1c_draw_status_in 18, 1)
 *   y  18- 67  x 0-51: the hero, 48 x 48 (the 24 x 24 frame 2x) at (4, 20) | x 52-239: label (FONT_L at x 60 when it
 *               fits 176 px, else FONT_S) and line 1 at y 50
 *   y  68-183  the bubble, a 1 px frame with cut corners 236 x 108 at (2, 74), its tail up at the hero (x 22; voice:
 *               x 206, the operator's own bubble); caption (row 0) at y 78, body rows 1-5 at y 96 + 16 (r - 1), x 8,
 *               224 px each; row 6 non-empty: a white wedge on the bottom edge ("more")
 *   y 184-223  critter keyboard: 11 black-key minis in 14 x 14 boxes at y 184, 16 white-key minis at y 202
 *   y 224-239  hint bar; the toast over it; for 2 s after a K1-K4 turn the knob row
 *   DETAILS: the hero, header rows 0-2 at x 60 (row 0 in the state colour), body rows 3-11 at y 72 + 16 (r - 3).
 *   NO COMPANION: the dimmed screen, a 208 x 128 banner at (16, 56) with the ghost (2x, floating), in two strips.
 * Regions tile the screen, so each is drawn alone and nothing is drawn twice. Animation (fm1c_draw_anim) redraws only
 * sprite boxes: the hero's 48 x 48, a mini's 12 x 12, the REC dot's 8 x 8. */
#pragma once
#include "fm1c_anim.h"
#include "fm1c_sprite.h"

#define FM1C_V4_HERO_X 4
#define FM1C_V4_HERO_Y 20
#define FM1C_V4_ROW_X 8
#define FM1C_V4_ROW_W 224
#define FM1C_V4_CAP_Y 78
#define FM1C_V4_BODY_Y 96
#define FM1C_V4_KBD_Y 184
#define FM1C_V4_HINT_Y 224
#define FM1C_V4_TAIL_X 22
#define FM1C_V4_TAIL_X_VOICE 206
#define FM1C_V4_ELAPSED_X 168
#define FM1C_V4_BANNER_BG RGB(16, 16, 16)
#define FM1C_C_KNOB_LIT RGB(70, 70, 70)
#define FM1C_C_CALM RGB(150, 150, 150)
#define FM1C_C_DASH_BLACK RGB(32, 32, 32)

static const char FM1C_DETAIL_HINT4[] = "PRESETS older  LFO close";
static const char FM1C_CONFIRM_CAPTION[] = "Please confirm";

static uint32_t fm1c_now;                       /* the time of this pass (console.c sets it before fm1c_draw) */

/* ---- the canvas as the version 4/5 drawers use it: gfx.c's, plus a clip rectangle (fm1c_trans.h draws the new
 * content of a transition step region by region, each clipped to the step's slice) and the panel's vertical scroll
 * (rows blitted while a hardware scroll is offset land where the panel shows them: fm1c_lcd_blit) */
static uint8_t fm1c_clip_on;
static uint8_t fm1c_sel_hide;                   /* a selection slide runs: rows and keys under its frame unselected */
static int32_t fm1c_clip_x0, fm1c_clip_y0, fm1c_clip_x1, fm1c_clip_y1;   /* [x0, x1) x [y0, y1) */
static void fm1c_lcd_blit(uint32_t x, uint32_t y, uint32_t w, uint32_t h, const uint16_t *px);   /* (fm1c_trans.h) */
static void fm1c_cvb(uint32_t w, uint32_t h, uint16_t bg) { cv_oy = 0; cv_begin(w, h, bg); }
static void fm1c_cvx(uint32_t x, uint32_t y)
{
    int32_t c0 = 0, r0 = 0, c1 = (int32_t)cv_w, r1 = (int32_t)cv_h, r;
    if (fm1c_clip_on) {
        if (fm1c_clip_x0 > (int32_t)x) c0 = fm1c_clip_x0 - (int32_t)x;
        if (fm1c_clip_y0 > (int32_t)y) r0 = fm1c_clip_y0 - (int32_t)y;
        if (fm1c_clip_x1 < (int32_t)x + c1) c1 = fm1c_clip_x1 - (int32_t)x;
        if (fm1c_clip_y1 < (int32_t)y + r1) r1 = fm1c_clip_y1 - (int32_t)y;
        if (c0 >= c1 || r0 >= r1) return;
    }
    if (c0 == 0 && c1 == (int32_t)cv_w) {       /* whole canvas rows: one transfer */
        fm1c_lcd_blit(x, y + (uint32_t)r0, cv_w, (uint32_t)(r1 - r0), cv_px + (uint32_t)r0 * cv_w);
        return;
    }
    for (r = r0; r < r1; r++)                   /* a column slice: a transfer a row */
        fm1c_lcd_blit(x + (uint32_t)c0, y + (uint32_t)r, (uint32_t)(c1 - c0), 1, cv_px + (uint32_t)r * cv_w + (uint32_t)c0);
}
/* the region (x, y, w, h) intersects the clip (or no clip is set) */
static int fm1c_clip_hit(int32_t x, int32_t y, int32_t w, int32_t h)
{
    return !fm1c_clip_on || (x < fm1c_clip_x1 && x + w > fm1c_clip_x0 && y < fm1c_clip_y1 && y + h > fm1c_clip_y0);
}
static fm1c_anim fm1c_an;                       /* what the sprite boxes show (fm1c_anim.h) */

static uint32_t fm1c_v4_state(const fm1c_model *m) { return m->dstate < FM1C_N_STATE ? m->dstate : FM1C_S_UNKNOWN; }
static int fm1c_v4_codex(const fm1c_model *m) { return m->provider == 2u; }   /* (none, other: the cat) */

/* the caption's colour: the state colour, a light grey for the calm states (too dark to read as text) */
static uint16_t fm1c_v4_col(uint32_t st)
{
    if (st == FM1C_S_EMPTY || st == FM1C_S_IDLE || st == FM1C_S_UNKNOWN || st == FM1C_S_DISCONNECTED ||
        st == FM1C_S_DONE_READ)
        return FM1C_C_CALM;
    return FM1C_STATE_RGB[st];
}
static uint16_t fm1c_v4_80(uint16_t c)          /* 80 % of a colour (the bubble's frame) */
{
    return (uint16_t)((((c >> 11) * 4u / 5u) << 11) | ((((c >> 5) & 63u) * 4u / 5u) << 5) | ((c & 31u) * 4u / 5u));
}
static uint32_t fm1c_v4_voice(const fm1c_model *m) { return m->voice < FM1C_N_VOICE ? m->voice : FM1C_V_FAILED; }
static uint16_t fm1c_v4_bubble_col(const fm1c_model *m)
{
    if (m->view == FM1C_VIEW_VOICE) return fm1c_v4_80(FM1C_VOICE_RGB[fm1c_v4_voice(m)]);
    if (m->view == FM1C_VIEW_CONFIRM) return fm1c_v4_80(FM1C_C_AMBER);
    return fm1c_v4_80(fm1c_v4_col(fm1c_v4_state(m)));
}

/* ---- the hero */
static void fm1c_v4_hero_sprite(const fm1c_model *m, int32_t x, int32_t y, uint32_t pose, uint32_t frame)
{
    uint16_t pal[16];
    fm1c_spr_pal(fm1c_v4_state(m), pal);
    fm1c_sprite(x, y, fm1c_spr_hero(pose, (uint32_t)fm1c_v4_codex(m), frame), FM1C_SPR_HERO_N, pal, 2);
}

static void fm1c_draw4_hero(const fm1c_model *m)   /* x 0-51, y 18-67 (DETAILS: to 71) */
{
    uint32_t pose = fm1c_anim_pose(fm1c_v4_state(m), 0);
    fm1c_cvb(52, fm1c_detail(m) ? 54u : 50u, C_BLACK);
    if (pose != FM1C_SPR_NONE)
        fm1c_v4_hero_sprite(m, FM1C_V4_HERO_X, FM1C_V4_HERO_Y - 18, pose, fm1c_anim_frame(pose, FM1C_ANIM_HERO, fm1c_now));
    fm1c_cvx(0, 18);
    fm1c_anim_hero(&fm1c_an, fm1c_dim ? FM1C_SPR_NONE : pose, fm1c_now, 0);   /* (dimmed: still, under the banner) */
}

/* ---- label and line 1 beside the hero */
static void fm1c_v4_big(const char *s, uint16_t c)   /* FONT_L in 176 px (11 capitals), else FONT_S */
{
    if (text_w(&FONT_L, s) <= 176) fm1c_text(8, 0, &FONT_L, s, c);
    else fm1c_text(8, 8, &FONT_S, s, c);
}

static void fm1c_draw4_label(const fm1c_model *m)   /* x 52-239, y 18-67 */
{
    int32_t sel = fm1c_selected(m);
    const char *slot = sel >= 0 ? m->slot[sel].label : "";
    fm1c_cvb(188, 50, C_BLACK);
    if (m->view == FM1C_VIEW_CONFIRM) {         /* the verb beside the target's character, the target below */
        fm1c_v4_big(m->line[0], C_WHITE);
        fm1c_text(8, 32, &FONT_S, slot, FM1C_C_TEXT2);
    } else {
        if (slot[0]) fm1c_v4_big(slot, C_WHITE);
        else fm1c_text(8, 8, &FONT_S, sel >= 0 ? "(untitled)" : "nothing selected", FM1C_C_GREY);
        if (m->view == FM1C_VIEW_VOICE) {
            int32_t x = fm1c_text(8, 32, &FONT_S, "to ", FM1C_C_GREY);
            fm1c_text(x, 32, &FONT_S, m->target[0] ? m->target : "(no target)", m->target[0] ? C_WHITE : FM1C_C_GREY);
        } else {
            fm1c_text(8, 32, &FONT_S, m->line[0], FM1C_C_TEXT2);
        }
    }
    fm1c_cvx(52, 18);
}

/* ---- a 1 px frame with cut corners (the bubbles), in canvas coordinates */
static void fm1c_v4_frame(int32_t x, int32_t y, int32_t w, int32_t h, uint16_t c)
{
    fm1c_rect(x + 2, y, w - 4, 1, c);
    fm1c_rect(x + 2, y + h - 1, w - 4, 1, c);
    fm1c_rect(x, y + 2, 1, h - 4, c);
    fm1c_rect(x + w - 1, y + 2, 1, h - 4, c);
    fm1c_rect(x + 1, y + 1, 1, 1, c);
    fm1c_rect(x + w - 2, y + 1, 1, 1, c);
    fm1c_rect(x + 1, y + h - 2, 1, 1, c);
    fm1c_rect(x + w - 2, y + h - 2, 1, 1, c);
}

/* ---- the bubble's frame, drawn into the open canvas whose top-left is screen (ox, oy) */
static void fm1c_v4_bubble_into(const fm1c_model *m, int32_t ox, int32_t oy)
{
    uint16_t c = fm1c_v4_bubble_col(m);
    int32_t tx = (m->view == FM1C_VIEW_VOICE ? FM1C_V4_TAIL_X_VOICE : FM1C_V4_TAIL_X) - ox, i;
    int32_t y = 74 - oy, sp = fm1c_split_buddy(m);   /* (version 6 SPLIT: 4 body rows, 16 px shorter) */
    fm1c_v4_frame(2 - ox, y, 236, sp ? 92 : 108, c);
    for (i = 0; i < 5; i++) {                   /* the tail: up at the speaker, open into the bubble */
        fm1c_rect(tx, y - 5 + i, 1, 1, c);
        fm1c_rect(tx + 1 + i, y - 5 + i, 1, 1, c);
    }
    fm1c_rect(tx + 1, y, 5, 1, C_BLACK);
    if (m->view != FM1C_VIEW_VOICE && m->view != FM1C_VIEW_CONFIRM && m->text[sp ? 5 : 6][0])
        for (i = 0; i < 4; i++)                 /* more below: a white wedge on the bottom edge */
            fm1c_rect(224 - ox + i, (sp ? 162 : 178) - oy + i, 7 - 2 * i, 1, C_WHITE);
}
static void fm1c_v4_strip(const fm1c_model *m, int32_t x, int32_t y, int32_t w, int32_t h)
{
    fm1c_cvb((uint32_t)w, (uint32_t)h, C_BLACK);
    fm1c_v4_bubble_into(m, x, y);
    fm1c_cvx((uint32_t)x, (uint32_t)y);
}
static void fm1c_draw4_bubble(const fm1c_model *m)   /* the strips around the rows: 6,336 px */
{
    fm1c_v4_strip(m, 0, 68, 240, 10);           /* tail, top edge */
    fm1c_v4_strip(m, 0, 78, 8, 98);             /* left edge */
    fm1c_v4_strip(m, 232, 78, 8, 98);           /* right edge */
    fm1c_v4_strip(m, 8, 94, 224, 2);            /* between the caption and the body */
    fm1c_v4_strip(m, 0, 176, 240, 8);           /* bottom edge, the wedge */
}

/* ---- the bubble's rows (224 x 16 each at x 8) */
static void fm1c_v4_elapsed_text(char *b, uint32_t ds)
{
    char *p;
    fm1c_utoa(b, ds / 10u);
    p = fm1c_cat(b + fm1c_len(b), ".");
    p[0] = (char)('0' + ds % 10u);
    p[1] = 0;
    fm1c_cat(p + 1, " s");
}

static void fm1c_v4_dot(uint32_t on, int32_t x, int32_t y)   /* the REC dot, blinking while it records */
{
    fm1c_rect(x, y, 8, 8, on ? FM1C_C_RED : RGB(90, 20, 20));
}

static void fm1c_draw4_caption(const fm1c_model *m)
{
    int32_t sel = fm1c_selected(m);
    if (m->view == FM1C_VIEW_VOICE) {           /* REC dot, the voice state's words; the elapsed time: its own box */
        uint32_t vs = fm1c_v4_voice(m), rec = vs == FM1C_V_RECORDING;
        fm1c_cvb(FM1C_V4_ELAPSED_X - FM1C_V4_ROW_X, 16, C_BLACK);
        if (rec) fm1c_v4_dot(fm1c_anim_dot_at(fm1c_now), 2, 6);
        fm1c_text(rec ? 16 : 0, 0, &FONT_S, FM1C_VOICE_NAME[vs], FM1C_VOICE_RGB[vs]);
        fm1c_cvx(FM1C_V4_ROW_X, FM1C_V4_CAP_Y);
        fm1c_anim_dot(&fm1c_an, rec && !fm1c_dim, fm1c_now);
        return;
    }
    fm1c_anim_dot(&fm1c_an, 0, fm1c_now);
    fm1c_cvb(FM1C_V4_ROW_W, 16, C_BLACK);
    if (m->view == FM1C_VIEW_CONFIRM) fm1c_text(0, 0, &FONT_S, FM1C_CONFIRM_CAPTION, FM1C_C_AMBER);
    else fm1c_rich(0, 0, m->text[0], FM1C_L_TEXT, fm1c_v4_col(fm1c_v4_state(m)), fm1c_tst(m, 0));
    if (sel >= 0)                               /* the physical key that holds this chat */
        fm1c_text(FM1C_V4_ROW_W - text_w(&FONT_S, FM1C_NOTE[sel]), 0, &FONT_S, FM1C_NOTE[sel], FM1C_C_GREY);
    fm1c_cvx(FM1C_V4_ROW_X, FM1C_V4_CAP_Y);
}

static void fm1c_draw4_elapsed(const fm1c_model *m)   /* voice: x 168-231 of the caption row */
{
    char b[16];
    fm1c_v4_elapsed_text(b, m->elapsed_ds);
    fm1c_cvb(240 - 8 - FM1C_V4_ELAPSED_X, 16, C_BLACK);
    fm1c_text(240 - 8 - FM1C_V4_ELAPSED_X - text_w(&FONT_S, b), 0, &FONT_S, b, C_WHITE);
    fm1c_cvx(FM1C_V4_ELAPSED_X, FM1C_V4_CAP_Y);
}

static void fm1c_draw4_body(const fm1c_model *m, uint32_t r)   /* rows 1-5 */
{
    uint32_t st = fm1c_tst(m, r);
    fm1c_cvb(FM1C_V4_ROW_W, 16, C_BLACK);
    if (m->view == FM1C_VIEW_CONFIRM) fm1c_text(0, 0, &FONT_S, r < 4u ? m->line[r] : "", C_WHITE);
    else fm1c_rich(0, 0, m->text[r], FM1C_L_TEXT, FM1C_STYLE_RGB[st], st);
    fm1c_cvx(FM1C_V4_ROW_X, FM1C_V4_BODY_Y + 16u * (r - 1u));
}

/* voice, recording or transcribing: the level meter, one bar per elapsed step sweeping left to right; 28 columns of
 * 8 x 80 over the body rows, a bar 5 px wide centred at y 136 */
static void fm1c_draw4_bar(const fm1c_model *m, uint32_t i)
{
    uint32_t lv = m->bar[i], rec = m->voice == FM1C_V_RECORDING;
    fm1c_cvb(8, 80, C_BLACK);
    if (rec && i == m->bar_n) {
        /* the gap ahead of the newest bar */
    } else if (!lv) {
        fm1c_rect(2, 39, 5, 2, FM1C_C_OUTLINE);
    } else {
        int32_t h = 4 + (int32_t)(lv * 72u / 100u);
        uint16_t c = !rec ? FM1C_C_GREY : lv < 70u ? FM1C_C_GREEN : lv < 90u ? FM1C_C_AMBER : FM1C_C_RED;
        fm1c_rect(2, 40 - h / 2, 5, h, c);
    }
    fm1c_cvx(FM1C_V4_ROW_X + 8u * i, FM1C_V4_BODY_Y);
}

/* ---- DETAILS: header rows 0-2 right of the hero (x 52-239), body rows 3-11 (the last one down to y 223) */
static void fm1c_draw4_detail_row(const fm1c_model *m, uint32_t r)
{
    uint32_t st = fm1c_tst(m, r);
    uint16_t c = FM1C_STYLE_RGB[st];
    if (r < 3u) {
        static const uint8_t Y0[3] = {18, 36, 52}, H[3] = {18, 16, 20}, TY[3] = {2, 0, 0};
        if (r == 0u) c = fm1c_v4_col(fm1c_v4_state(m));
        fm1c_cvb(188, H[r], C_BLACK);
        fm1c_rich(8, TY[r], m->text[r], FM1C_L_TEXT, c, st);
        fm1c_cvx(52, Y0[r]);
        return;
    }
    fm1c_cvb(240, r == 11u ? 24u : 16u, C_BLACK);
    fm1c_rich(4, 0, m->text[r], FM1C_L_TEXT, c, st);
    fm1c_cvx(0, 72u + 16u * (r - 3u));
}

/* ---- the critter keyboard */
static void fm1c_v4_mini(const fm1c_model *m, uint32_t k, int32_t x, int32_t y, uint32_t pose, uint32_t frame)
{
    const fm1c_slot *s = &m->slot[k];
    uint16_t pal[16];
    uint32_t st = s->state < FM1C_N_STATE ? s->state : FM1C_S_UNKNOWN;
    fm1c_spr_pal((s->flags & FM1C_F_STALE) ? FM1C_S_DISCONNECTED : st, pal);
    fm1c_sprite(x, y, fm1c_spr_mini(pose, (s->flags & FM1C_F_CODEX) != 0u, frame), FM1C_SPR_MINI_N, pal, 1);
}

/* one key's 14 x 14 box into the canvas whose top-left is screen (ox, oy) */
static void fm1c_key6_compact(const fm1c_model *m, uint32_t k, int32_t bx, int32_t by);   /* (fm1c_draw6.h) */
static void fm1c_key4(const fm1c_model *m, uint32_t k, int32_t ox, int32_t oy)
{
    const fm1c_slot *s = &m->slot[k];
    uint32_t st = s->state < FM1C_N_STATE ? s->state : FM1C_S_UNKNOWN;
    uint32_t pose = fm1c_anim_pose(st, (s->flags & FM1C_F_STALE) != 0u);
    int32_t bx, by, bw, bh;
    fm1c_key_box(m, k, &bx, &by, &bw, &bh);
    bx -= ox; by -= oy;
    if (fm1c_compact(m) && fm1c_key_black(k)) { fm1c_key6_compact(m, k, bx, by); return; }   /* (version 6 SPLIT) */
    fm1c_rect(bx, by, bw, bh, C_BLACK);
    if (pose == FM1C_SPR_NONE) {                /* an empty key: a dash */
        fm1c_rect(bx + 5, by + 6, 4, 2, fm1c_key_black(k) ? FM1C_C_DASH_BLACK : FM1C_C_OUTLINE);
    } else {
        fm1c_v4_mini(m, k, bx + 1, by + 1, pose, fm1c_anim_frame(pose, FM1C_ANIM_MINI, fm1c_now));
        if (s->flags & FM1C_F_PINNED) fm1c_rect(bx + 12, by, 2, 2, C_WHITE);
    }
    if ((s->flags & FM1C_F_SELECTED) && !fm1c_sel_hide) fm1c_frame(bx, by, bw, bh, 1, C_WHITE);
    fm1c_anim_key(&fm1c_an, k, fm1c_dim ? FM1C_SPR_NONE : pose, fm1c_now);
}

static void fm1c_draw4_key(const fm1c_model *m, uint32_t k)
{
    int32_t x, y, w, h;
    fm1c_key_box(m, k, &x, &y, &w, &h);
    fm1c_cvb((uint32_t)w, (uint32_t)h, C_BLACK);
    fm1c_key4(m, k, x, y);
    fm1c_cvx((uint32_t)x, (uint32_t)y);
}

static void fm1c_draw4_keyboard(const fm1c_model *m)   /* y 184-223 */
{
    uint32_t k;
    fm1c_cvb(240, 40, C_BLACK);
    for (k = 0; k < FM1C_NSLOT; k++) fm1c_key4(m, k, 0, FM1C_V4_KBD_Y);
    fm1c_cvx(0, FM1C_V4_KBD_Y);
}

/* ---- the hint bar: the toast, else the knob row (2 s after a K1-K4 turn), else the view's hint */
static void fm1c_v4_knobs(const fm1c_model *m)
{
    uint32_t i;
    fm1c_rect(0, 0, 240, 16, FM1C_C_HINT_BG);
    for (i = 0; i < 4u; i++) {
        int32_t x = (int32_t)i * 60;
        int on = i == m->knob_lit;
        char n[2];
        if (on) fm1c_rect(x, 0, 60, 16, FM1C_C_KNOB_LIT);
        if (i) fm1c_rect(x, 0, 1, 16, FM1C_C_OUTLINE);
        fm1c_rect(x + 5, 4, 6, 1, FM1C_C_GREY);   /* a knob: a ring with its pointer */
        fm1c_rect(x + 5, 11, 6, 1, FM1C_C_GREY);
        fm1c_rect(x + 4, 5, 1, 6, FM1C_C_GREY);
        fm1c_rect(x + 11, 5, 1, 6, FM1C_C_GREY);
        fm1c_rect(x + 7, 5, 2, 3, C_WHITE);
        n[0] = (char)('1' + i);
        n[1] = 0;
        fm1c_text(x + 14, 0, &FONT_S, n, on ? C_WHITE : FM1C_C_GREY);
        fm1c_text(x + 23, 0, &FONT_S, m->legend[i], on ? C_WHITE : FM1C_C_HINT);
    }
}

/* the hint bar's content: mode 0 as the model says, 1 the toast, 2 the knob row, 3 the view's hint (no toast, no
 * knobs); drawn oy px lower (the toast and knob row transitions, fm1c_trans.h), the bar's background above it */
enum { FM1C_HB_MODEL = 0, FM1C_HB_TOAST, FM1C_HB_KNOBS, FM1C_HB_HINT };
static void fm1c_hint_bar(const fm1c_model *m, uint32_t mode, int32_t oy)
{
    fm1c_cvb(240, 16, FM1C_C_HINT_BG);
    cv_oy = oy;
    if (mode == FM1C_HB_MODEL) mode = m->help ? 9u : m->toast_on ? FM1C_HB_TOAST : m->knob_on ? FM1C_HB_KNOBS : FM1C_HB_HINT;
    if (mode == 9u) fm1c_hint_in(FM1C_HELP_HINT4, 16, 0);
    else if (mode == FM1C_HB_TOAST) fm1c_toast_in(m, 16, 0);
    else if (mode == FM1C_HB_KNOBS) fm1c_v4_knobs(m);
    else if (fm1c_detail(m)) fm1c_hint_in(FM1C_DETAIL_HINT4, 16, 0);
    else if (m->view == FM1C_VIEW_CONFIRM) fm1c_hint_in("SAVE yes   FX no", 16, 0);
    else fm1c_hint_in(m->line[3], 16, 0);
    cv_oy = 0;
    fm1c_cvx(0, FM1C_V4_HINT_Y);
}
static void fm1c_draw4_hint(const fm1c_model *m) { fm1c_hint_bar(m, FM1C_HB_MODEL, 0); }

/* ---- the help overlay (rows 18-223): the lines, then in the base views the knobs and who is who */
static void fm1c_v4_help_into(const fm1c_model *m, int32_t oy)
{
    const char *const *t = m->look >= FM1C_PROTO_V5 ? FM1C_HELP_BASE5 : FM1C_HELP_BASE4;   /* (5: the SEQ line) */
    uint32_t n = 6, i, base = 0;
    if (m->look >= FM1C_PROTO_V6)               /* (6: the settings entry; Sessions with SPLIT keys: the split lines) */
        t = fm1c_split_band(m) ? FM1C_HELP_SPLIT6 : FM1C_HELP_BASE6;
    if (m->view == FM1C_VIEW_SETTINGS && m->look >= FM1C_PROTO_V6) { t = FM1C_HELP_SETTINGS6; n = 4; }
    else if (m->view == FM1C_VIEW_VOICE) { t = FM1C_HELP_VOICE; n = 7; }
    else if (m->view == FM1C_VIEW_CONFIRM) { t = FM1C_HELP_CONFIRM; n = 4; }
    else if (m->view == FM1C_VIEW_DETAIL) { t = FM1C_HELP_DETAIL4; n = 10; }
    else base = 1;
    for (i = 0; i < n; i++) fm1c_text(4, 2 + 16 * (int32_t)i - oy, &FONT_S, t[i], i ? C_WHITE : FM1C_C_AMBER);
    if (!base) return;
    for (i = 0; i < 2u; i++) {                  /* "KNOB1 SHOW  KNOB2 REPO", from SET_LEGEND */
        char b[40], *p = b;
        uint32_t j;
        for (j = 0; j < 2u; j++) {
            uint32_t kn = i * 2u + j;
            char d[2];
            d[0] = (char)('1' + kn);
            d[1] = 0;
            p = fm1c_cat(p, j ? "  KNOB" : "KNOB");
            p = fm1c_cat(p, d);
            p = fm1c_cat(p, " ");
            p = fm1c_cat(p, m->legend[kn][0] ? m->legend[kn] : "-");
        }
        fm1c_text(4, 2 + 16 * (int32_t)(6u + i) - oy, &FONT_S, b, FM1C_C_HINT);
    }
    fm1c_rect(4, 132 - oy, 232, 1, FM1C_C_OUTLINE);
    {
        static const uint8_t WHO[8] = {FM1C_S_WORKING, FM1C_S_WAITING_INPUT, FM1C_S_APPROVAL, FM1C_S_FAILED,
                                       FM1C_S_DONE_UNREAD, FM1C_S_IDLE, FM1C_S_UNKNOWN, FM1C_S_DISCONNECTED};
        for (i = 0; i < 8u; i++) {              /* who is who: Claude left, Codex right, still */
            int32_t x = 4 + (int32_t)(i % 2u) * 118, y = 136 + 16 * (int32_t)(i / 2u) - oy;
            uint16_t pal[16];
            uint32_t pose = fm1c_anim_pose(WHO[i], 0);
            fm1c_spr_pal(WHO[i], pal);
            fm1c_sprite(x, y + 2, fm1c_spr_mini(pose, i % 2u, 0), FM1C_SPR_MINI_N, pal, 1);
            fm1c_text(x + 16, y, &FONT_S, FM1C_HELP_WORDS4[i], C_WHITE);
        }
    }
}

static void fm1c_draw4_help(const fm1c_model *m)
{
    uint32_t y0;
    for (y0 = 0; y0 < 206u; y0 += 80u) {        /* 80 + 80 + 46 rows (CV_MAX is 240 x 80) */
        uint32_t h = 206u - y0 < 80u ? 206u - y0 : 80u;
        fm1c_cvb(240, h, C_BLACK);
        fm1c_v4_help_into(m, (int32_t)y0);
        fm1c_cvx(0, 18u + y0);
    }
}

/* ---- the banner: 208 x 128 at (16, 56) in two strips of 64 rows (never dimmed); the ghost floats in it */
#define FM1C_V4_BAN_X 16
#define FM1C_V4_BAN_Y 56
#define FM1C_V4_GHOST_X 96
#define FM1C_V4_GHOST_Y 62

static uint32_t fm1c_v4_banner_pose(const fm1c_model *m)
{
    return m->conn == FM1C_C_INCOMPAT ? FM1C_POSE_HUH : FM1C_POSE_GHOST;
}
static void fm1c_v4_ghost(const fm1c_model *m, int32_t x, int32_t y, uint32_t frame)
{
    uint16_t pal[16];
    uint32_t pose = fm1c_v4_banner_pose(m);
    fm1c_spr_pal(pose == FM1C_POSE_HUH ? FM1C_S_UNKNOWN : FM1C_S_DISCONNECTED, pal);
    fm1c_sprite(x, y, fm1c_spr_hero(pose, 0, frame), FM1C_SPR_HERO_N, pal, 2);
}

static void fm1c_draw4_banner(const fm1c_model *m)
{
    const char *big = "NO COMPANION", *small = "start fm1-console on Mac";
    uint8_t d = fm1c_dim;
    uint32_t s, pose = fm1c_v4_banner_pose(m), frame = fm1c_anim_frame(pose, FM1C_ANIM_HERO, fm1c_now);
    fm1c_dim = 0;
    if (m->conn == FM1C_C_INCOMPAT) {
        big = fm1c_has(m->reason, "old") ? "UPDATE APP" : fm1c_has(m->reason, "new") ? "OLD FIRMWARE" : "INCOMPATIBLE";
        small = m->reason[0] ? m->reason : "no common version";
    }
    for (s = 0; s < 2u; s++) {
        int32_t oy = 64 * (int32_t)s;
        fm1c_cvb(208, 64, FM1C_V4_BANNER_BG);
        fm1c_frame(0, -oy, 208, 128, 2, m->conn == FM1C_C_INCOMPAT ? FM1C_C_RED : C_WHITE);
        fm1c_v4_ghost(m, FM1C_V4_GHOST_X - FM1C_V4_BAN_X, FM1C_V4_GHOST_Y - FM1C_V4_BAN_Y - oy, frame);
        fm1c_text((208 - text_w(&FONT_L, big)) / 2, 56 - oy, &FONT_L, big, C_WHITE);
        fm1c_text((208 - text_w(&FONT_S, small)) / 2, 96 - oy, &FONT_S, small, FM1C_C_TEXT2);
        fm1c_cvx(FM1C_V4_BAN_X, (uint32_t)(FM1C_V4_BAN_Y + oy));
    }
    fm1c_anim_hero(&fm1c_an, pose, fm1c_now, 1);
    fm1c_dim = d;
}

#include "fm1c_draw5.h"                        /* version 5: the LIST layout */
#include "fm1c_draw6.h"                        /* version 6: SPLIT keys, the SETTINGS view */

/* Version 4 draws a region at a time and gives the link a turn between regions: when a host frame came in while a
 * region went out (lcd.c's LCD_IDLE queues it), fm1c_draw4 stops and leaves the rest marked, so the main loop parses
 * and ACKs that frame first and draws the rest on the next pass. A resync's full redraw then never holds an ACK back
 * longer than one region (the largest, the keyboard, is 240 x 40). console.c sets fm1c_yield; 0: never stop (the
 * dimmed screen never stops either: no host is talking, and the banner goes on top of whatever was drawn). */
static int (*fm1c_yield)(void);

/* Draws what changed (version 4); returns the regions drawn, nonzero when anything was. keys_drawn: the keys drawn
 * alone; in DETAILS the text rows. */
static uint32_t fm1c_draw4(fm1c_model *m, uint32_t *keys_drawn)
{
    uint32_t drawn = 0, k, bars_drawn = 0, rows_drawn = 0, banner;
    int voice = m->view == FM1C_VIEW_VOICE, dim = fm1c_dimmed(m), stop = 0;
    *keys_drawn = 0;
    if (m->help) {                              /* only the top bar and the overlay; the rest waits, still marked */
        uint32_t d = m->dirty & (FM1C_D_STATUS | FM1C_D_HELP | FM1C_D_HINT4);
        m->dirty &= ~d;
        fm1c_anim_init(&fm1c_an);               /* (the overlay covers every sprite) */
        if (d & FM1C_D_STATUS) fm1c_draw_status_in(m, 18, 1);
        if (d & FM1C_D_HELP) fm1c_draw4_help(m);
        if (d & (FM1C_D_HELP | FM1C_D_HINT4)) fm1c_draw4_hint(m);
        return d;
    }
    banner = m->dirty & FM1C_D_BANNER;
    m->dirty &= FM1C_D_STATUS | FM1C_D_V4;      /* (the version 1-3 regions and the help's: nothing to draw here) */
    if (!fm1c_split_band(m)) m->dirty &= ~FM1C_D_BAND;   /* (version 6: the black row band only in SPLIT Sessions) */
    fm1c_dim = (uint8_t)dim;
/* a region, then the link's turn: stop here when a host frame is waiting */
#define FM1C_STEP(cond, mark, draw)                                                    \
    if (!stop && (cond)) {                                                             \
        mark;                                                                          \
        draw;                                                                          \
        if (!dim && fm1c_yield && fm1c_yield()) stop = 1;                              \
    }
    FM1C_STEP(m->dirty & FM1C_D_STATUS, (m->dirty &= ~FM1C_D_STATUS, drawn |= FM1C_D_STATUS), fm1c_draw_status_in(m, 18, 1))
    if (fm1c_settings(m)) m->dirty &= ~(FM1C_D_HERO | FM1C_D_LABEL4 | FM1C_D_BUBBLE | FM1C_D_KBD | FM1C_D_ELAPSED);
    FM1C_STEP(m->dirty & FM1C_D_HERO, (m->dirty &= ~FM1C_D_HERO, drawn |= FM1C_D_HERO),
              fm1c_list(m) ? fm1c_draw5_hero(m) : fm1c_draw4_hero(m))
    if (!fm1c_list(m) && !fm1c_settings(m)) {
        m->dirty &= ~FM1C_D_LIST;               /* (the list's own regions: nothing to draw here) */
        m->dirty_lrows = 0;
    }
    if (fm1c_settings(m)) {                     /* version 6: the SETTINGS view (fm1c_draw6.h) */
        m->dirty_keys = 0;
        m->dirty_bars = 0;
        m->dirty_lrows = 0;
        if (m->dirty & FM1C_D_LIST) {           /* (the whole body: the gap here, then every item row and the
                                                 * description as their own regions, so the link gets its turn between
                                                 * them: one 49,440 px blit would hold an ACK back ~66 ms; no sprite) */
            FM1C_STEP(1, (m->dirty &= ~FM1C_D_LIST, m->dirty_rows |= 0x3FFu, drawn |= FM1C_D_LIST,
                      fm1c_anim_forget_keys(&fm1c_an), fm1c_anim_hero(&fm1c_an, FM1C_SPR_NONE, fm1c_now, 0),
                      fm1c_anim_dot(&fm1c_an, 0, fm1c_now)), (fm1c_cvb(240, 4, C_BLACK), fm1c_cvx(0, 18)))
        }
        for (k = 0; k < FM1C_SET_ITEMS; k++)
            FM1C_STEP(m->dirty_rows >> k & 1u, (m->dirty_rows &= ~(1u << k), rows_drawn = 1), fm1c_draw6_item(m, k))
        FM1C_STEP(m->dirty_rows >> 9 & 1u, (m->dirty_rows &= ~(1u << 9), rows_drawn = 1), fm1c_draw6_desc(m))
        if (!stop) m->dirty_rows &= 0x3FFu;     /* (rows 10-11 carry nothing here) */
    } else if (fm1c_list(m)) {                  /* version 5: the LIST layout (fm1c_draw5.h) */
        fm1c_anim_dot(&fm1c_an, 0, fm1c_now);
        m->dirty &= ~(FM1C_D_LABEL4 | FM1C_D_KBD | FM1C_D_ELAPSED);   /* (not in the list) */
        m->dirty_bars = 0;
        m->dirty_rows &= 7u;                    /* (rows 3-11 carry nothing here) */
        if (m->dirty & FM1C_D_BUBBLE) {
            FM1C_STEP(1, (m->dirty &= ~FM1C_D_BUBBLE, m->dirty_rows = 0, drawn |= FM1C_D_BUBBLE), fm1c_v5_head(m, 29, 18, 211, 42))
        }
        FM1C_STEP(m->dirty_rows & 1u, (m->dirty_rows &= ~1u, rows_drawn = 1), fm1c_v5_head(m, 40, 22, 192, 16))
        FM1C_STEP(m->dirty_rows & 2u, (m->dirty_rows &= ~2u, rows_drawn = 1), fm1c_v5_head(m, 40, 38, 192, 16))
        FM1C_STEP(m->dirty_rows & 4u, (m->dirty_rows &= ~4u, rows_drawn = 1), fm1c_v5_head(m, 224, 55, 7, 4))
        if (fm1c_split_band(m)) {               /* version 6 SPLIT: the black row band above the rows */
            if (m->dirty & FM1C_D_BAND) {
                FM1C_STEP(1, (m->dirty &= ~FM1C_D_BAND, m->dirty_keys &= ~FM1C_KEYS_BLACK, drawn |= FM1C_D_BAND), fm1c_draw6_band(m))
            }
            for (k = 0; k < FM1C_NSLOT; k++)    /* (432 px each: no turn between chips) */
                if (!stop && fm1c_key_black(k) && (m->dirty_keys >> k & 1u)) {
                    m->dirty_keys &= ~(1u << k);
                    fm1c_draw6_chip(m, k);
                }
        }
        fm1c_list_check(m);                     /* (the window moved: every row) */
        for (k = 0; k < FM1C_NSLOT; k++)        /* a changed key: its row, when it is in the window */
            if ((m->dirty_keys >> k & 1u) && !fm1c_list_black(m, k)) {
                int32_t r = fm1c_list_row_of(m, k, 0), h = fm1c_list_row_of(m, k, 1);
                if (r >= 0) m->dirty_lrows |= 1u << r;
                if (h >= 0) m->dirty_lrows |= 1u << h;   /* (grouped: its header row too) */
            }
        m->dirty_keys &= fm1c_split_band(m) ? FM1C_KEYS_BLACK : 0u;   /* (a chip a yield left: the next pass) */
        FM1C_STEP(m->dirty & FM1C_D_LIST, (m->dirty &= ~FM1C_D_LIST, m->dirty_lrows = (1u << fm1c_list_rows(m)) - 1u,
                  fm1c_anim_forget_keys(&fm1c_an), fm1c_list_drawn(m), drawn |= FM1C_D_LIST), fm1c_draw5_frame(m))
        for (k = 0; k < fm1c_list_rows(m); k++)
            FM1C_STEP(m->dirty_lrows >> k & 1u, (m->dirty_lrows &= ~(1u << k), *keys_drawn |= 1u << k), fm1c_draw5_row(m, k))
    } else if (fm1c_detail(m)) {
        fm1c_anim_forget_keys(&fm1c_an);
        fm1c_anim_dot(&fm1c_an, 0, fm1c_now);
        m->dirty &= ~(FM1C_D_LABEL4 | FM1C_D_BUBBLE | FM1C_D_KBD | FM1C_D_ELAPSED);   /* (not in DETAILS) */
        m->dirty_keys = 0;
        m->dirty_bars = 0;
        for (k = 0; k < FM1C_TEXT_ROWS; k++)
            FM1C_STEP(m->dirty_rows >> k & 1u, (m->dirty_rows &= ~(1u << k), *keys_drawn |= 1u << k, rows_drawn = 1),
                      fm1c_draw4_detail_row(m, k))
    } else {
        int live = voice && fm1c_voice_live(m), sp = fm1c_split_buddy(m);   /* sp: version 6 SPLIT (fm1c_draw6.h) */
        uint32_t wedge = sp ? 0x20u : 0x40u;    /* (the "more" row: 6, SPLIT 5) */
        FM1C_STEP(m->dirty & FM1C_D_LABEL4, (m->dirty &= ~FM1C_D_LABEL4, drawn |= FM1C_D_LABEL4), fm1c_draw4_label(m))
        if (m->dirty & FM1C_D_BUBBLE) {
            FM1C_STEP(1, (m->dirty &= ~FM1C_D_BUBBLE, m->dirty_rows &= ~wedge, drawn |= FM1C_D_BUBBLE),
                      sp ? fm1c_draw6_bubble(m) : fm1c_draw4_bubble(m))
        } else {
            FM1C_STEP(m->dirty_rows & wedge, (m->dirty_rows &= ~wedge, rows_drawn = 1),
                      fm1c_v4_strip(m, 0, sp ? 160 : 176, 240, 8))   /* (the wedge comes or goes) */
        }
        FM1C_STEP(m->dirty_rows & 1u, (m->dirty_rows &= ~1u, rows_drawn = 1), fm1c_draw4_caption(m))
        if (voice) {
            FM1C_STEP(m->dirty & FM1C_D_ELAPSED, (m->dirty &= ~FM1C_D_ELAPSED, drawn |= FM1C_D_ELAPSED), fm1c_draw4_elapsed(m))
        } else {
            m->dirty &= ~FM1C_D_ELAPSED;
        }
        if (live) {
            m->dirty_rows &= ~0x3Eu;            /* (the meter covers the body rows) */
            for (k = 0; k < FM1C_BARS; k++)     /* (8 x 80 each: no turn between bars) */
                if (!stop && (m->dirty_bars >> k & 1u)) { m->dirty_bars &= ~(1u << k); bars_drawn = 1; fm1c_draw4_bar(m, k); }
            if (bars_drawn && !dim && fm1c_yield && fm1c_yield()) stop = 1;
        } else {
            for (k = 1; k < (sp ? 5u : 6u); k++)
                FM1C_STEP(m->dirty_rows >> k & 1u, (m->dirty_rows &= ~(1u << k), rows_drawn = 1), fm1c_draw4_body(m, k))
            m->dirty_bars = 0;
        }
        if (!stop) m->dirty_rows &= 0x3Fu;      /* (rows 7-11 carry nothing in the base views) */
        if (sp) {                               /* the black row band, the white row, a chip or a white key alone */
            if (m->dirty & FM1C_D_BAND) {
                FM1C_STEP(1, (m->dirty &= ~FM1C_D_BAND, m->dirty_keys &= ~FM1C_KEYS_BLACK, drawn |= FM1C_D_BAND), fm1c_draw6_band(m))
            }
            if (m->dirty & FM1C_D_KBD) {
                FM1C_STEP(1, (m->dirty &= ~FM1C_D_KBD, m->dirty_keys &= FM1C_KEYS_BLACK, drawn |= FM1C_D_KBD), fm1c_draw6_white(m))
            }
            for (k = 0; k < FM1C_NSLOT; k++)    /* (no turn between keys) */
                if (!stop && (m->dirty_keys >> k & 1u)) {
                    m->dirty_keys &= ~(1u << k);
                    *keys_drawn |= 1u << k;
                    if (fm1c_key_black(k)) fm1c_draw6_chip(m, k);
                    else fm1c_draw4_key(m, k);
                }
        } else if (m->dirty & FM1C_D_KBD) {
            FM1C_STEP(1, (m->dirty &= ~FM1C_D_KBD, m->dirty_keys = 0, drawn |= FM1C_D_KBD), fm1c_draw4_keyboard(m))
        } else {
            for (k = 0; k < FM1C_NSLOT; k++)    /* (14 x 14 each: no turn between keys) */
                if (!stop && (m->dirty_keys >> k & 1u)) { m->dirty_keys &= ~(1u << k); *keys_drawn |= 1u << k; fm1c_draw4_key(m, k); }
        }
    }
    FM1C_STEP(m->dirty & FM1C_D_HINT4, (m->dirty &= ~FM1C_D_HINT4, drawn |= FM1C_D_HINT4), fm1c_draw4_hint(m))
#undef FM1C_STEP
    drawn |= rows_drawn || bars_drawn ? FM1C_D_BUBBLE : 0u;
    if (dim && (drawn || *keys_drawn || banner)) {        /* anything under it was drawn: the banner again on top */
        fm1c_draw4_banner(m);
        drawn |= FM1C_D_BANNER;
    } else if (!dim && fm1c_an.hero_banner) {
        fm1c_an.hero_banner = 0;                /* (lit again: the banner's ghost is gone) */
        if (!(drawn & FM1C_D_HERO)) fm1c_an.hero_pose = FM1C_SPR_NONE;
    }
    fm1c_dim = 0;
    return drawn;
}

/* One animation pass (console.c: a pass that drew no content, the link quiet): the sprite boxes whose frame changed,
 * within budget_px. Returns the pixels drawn. */
static uint32_t fm1c_draw_anim(fm1c_model *m, uint32_t now, uint32_t budget_px)
{
    uint32_t hero, dot, keys, px, k;
    if (!fm1c_v4(m) || m->help || fm1c_settings(m)) return 0;   /* (version 6 settings: no sprite) */
    fm1c_now = now;
    px = fm1c_anim_due(&fm1c_an, now, budget_px, &hero, &dot, &keys);
    if (!px) return 0;
    fm1c_dim = 0;
    if (hero && fm1c_an.hero_banner) {
        fm1c_cvb(48, 48, FM1C_V4_BANNER_BG);
        fm1c_v4_ghost(m, 0, 0, fm1c_an.hero_frame);
        fm1c_cvx(FM1C_V4_GHOST_X, FM1C_V4_GHOST_Y);
    } else if (hero && fm1c_an.hero_small) {   /* version 5 list: 24 x 24 at 1x */
        uint16_t pal[16];
        fm1c_cvb(24, 24, C_BLACK);
        fm1c_spr_pal(fm1c_v4_state(m), pal);
        fm1c_sprite(0, 0, fm1c_spr_hero(fm1c_an.hero_pose, (uint32_t)fm1c_v4_codex(m), fm1c_an.hero_frame), FM1C_SPR_HERO_N, pal, 1);
        fm1c_cvx(FM1C_V5_HERO_X, FM1C_V5_HERO_Y);
    } else if (hero) {
        fm1c_cvb(48, 48, C_BLACK);
        fm1c_v4_hero_sprite(m, 0, 0, fm1c_an.hero_pose, fm1c_an.hero_frame);
        fm1c_cvx(FM1C_V4_HERO_X, FM1C_V4_HERO_Y);
    }
    if (dot) {
        fm1c_cvb(8, 8, C_BLACK);
        fm1c_v4_dot(fm1c_an.dot, 0, 0);
        fm1c_cvx(FM1C_V4_ROW_X + 2, FM1C_V4_CAP_Y + 6);
    }
    for (k = 0; k < FM1C_NSLOT; k++) {
        int32_t x, y, w, h;
        if (!(keys >> k & 1u)) continue;
        if (fm1c_key_black(k) && (fm1c_split_band(m) || fm1c_compact(m))) continue;   /* (version 6: chips never move) */
        if (fm1c_list(m)) {                     /* version 5 list: the mini in its row, on the row's colour */
            int32_t r = fm1c_list_row(m, k);
            if (r < 0) continue;
            fm1c_cvb(12, 12, (m->slot[k].flags & FM1C_F_SELECTED) ? FM1C_C_OUTLINE : C_BLACK);
            fm1c_v4_mini(m, k, 0, 0, fm1c_an.key_pose[k], fm1c_an.key_frame[k]);
            if (m->slot[k].flags & FM1C_F_PINNED) cv_pset(11, 0, C_WHITE);
            fm1c_cvx(FM1C_V5_MINI_X + (fm1c_grouped(m) ? 8u * (m->slot[k].row & FM1C_ROW_INDENT) : 0u),
                     fm1c_list_y(m) + 16u * (uint32_t)r + FM1C_V5_MINI_Y);   /* (grouped: shifted by the indent) */
            continue;
        }
        fm1c_key_box(m, k, &x, &y, &w, &h);
        fm1c_cvb(12, 12, C_BLACK);
        fm1c_v4_mini(m, k, 0, 0, fm1c_an.key_pose[k], fm1c_an.key_frame[k]);
        if (m->slot[k].flags & FM1C_F_PINNED) cv_pset(11, 0, C_WHITE);   /* (the pin's one pixel inside the box) */
        fm1c_cvx((uint32_t)x + 1u, (uint32_t)y + 1u);
    }
    return px;
}

#include "fm1c_trans.h"                        /* version 5: the transitions (docs/ui-v3.md section 9.10) */
