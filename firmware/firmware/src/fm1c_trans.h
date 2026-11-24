/* SPDX-License-Identifier: GPL-3.0-only */
/* Version 5 transitions (docs/ui-v3.md section 9.10): short animated changes of small regions, <= 120 ms, 3-4 steps
 * eased out by timing (T = 0, 30, 70 ms or 0, 20, 50, 90 ms), each step drawn in passes of <= FM1C_ANIM_PX_PASS
 * pixels with the link served between passes, never more than FM1C_TR_PX_STEP pixels a step. Included by
 * fm1c_draw4.h after the version 4/5 drawers it reuses; console.c drives it:
 *
 *   fm1c_trans_detect   a pass that would draw content: compares the model with what was last drawn (fm1c_scr) and
 *                       starts the transition its change calls for (only with the link quiet: no host frame waiting,
 *                       no device frame awaiting its ACK); 0: draw as usual
 *   fm1c_trans_run      every pass while one runs: the next slice of the due step, when the link is quiet
 *   fm1c_trans_finish   device input (or a step later than 40 ms): the final content at once, nothing queued
 *   fm1c_trans_input    a panel edge (read_panel): finishes the running transition; a press closer than
 *                       FM1C_TR_FAST_MS to the previous press turns the transitions off for FM1C_TR_FAST_MS
 *   fm1c_trans_host     a host frame applied: one that changes the model while a transition runs makes its end
 *                       redraw every region it touched (as an interrupted one does)
 *   fm1c_trans_drawn    after a usual draw: a transition starts again only once what an interrupted (or overtaken)
 *                       transition left to redraw is drawn
 *
 * Section 9.10.1 (fast input, operator report 2026-11-19: fast SELECT turns left blank rows and a second highlight):
 * a transition draws each step from the model of that moment and leaves the rest of what it touched to the usual
 * drawing, so it must never end with what is on the panel and what the model says apart. Two rules keep them equal:
 * (1) a SELECT step or a key press within FM1C_TR_FAST_MS of the previous one (a fast scroll) starts no transition
 * for FM1C_TR_FAST_MS: the change is drawn at once; (2) an end that is not the plain one (input, a late step, or a
 * host frame that changed the model while it ran: the list window can then move under it) marks every region the
 * transition touched, in full (the whole list for the window scroll, the page and layout wipes; the rows under the
 * frames for the slide; the keyboard for the Buddy slide), and no transition starts before those are drawn.
 *
 * While a transition runs nothing else is drawn and the sprites stand still: host frames only mark the model, and
 * what they marked is drawn after the end. New content is drawn clipped to the step's slice (fm1c_scene: every region
 * of the screen that meets it, through fm1c_cvx's clip). The reader's page turn and the list window scroll use the
 * ST7789V's vertical scroll (VSCRDEF 0x33, VSCRSADD 0x37; FM1C_VSCROLL_HW 0 draws them at once instead); every scroll
 * moves the whole scroll area, so its last step lands on the identity mapping and nothing outside a transition ever
 * sees an offset. Host mode models the scroll on the screen buffer (fm1c_vs_*). */
#pragma once

#ifndef FM1C_VSCROLL_HW
#define FM1C_VSCROLL_HW 1
#endif
#define FM1C_TR_PX_STEP 18000u                  /* a step's pixel ceiling (24 ms of SPI) */
#define FM1C_TR_LATE_MS 40u                     /* a step that cannot start this late: the end at once */
#define FM1C_TR_END_MS 120u                     /* the transition ends at t0 + 120 ms: what it held back is drawn then */
#ifndef FM1C_TR_FAST_MS
#define FM1C_TR_FAST_MS 150u                    /* section 9.10.1: presses closer than this are a fast scroll: no transition */
#endif

enum {
    FM1C_TR_NONE = 0, FM1C_TR_SEL_LIST, FM1C_TR_SEL_BUDDY, FM1C_TR_HERO, FM1C_TR_PAGE, FM1C_TR_LAYOUT,
    FM1C_TR_READER_OPEN, FM1C_TR_READER_CLOSE, FM1C_TR_READER_PAGE, FM1C_TR_WINDOW, FM1C_TR_TOAST_IN, FM1C_TR_TOAST_OUT,
    FM1C_TR_KNOB_IN, FM1C_TR_KNOB_OUT, FM1C_TR_VOICE, FM1C_TR_TASK, FM1C_TR_KINDS
};
#ifdef DINGHY_HOST
static const char *const FM1C_TR_NAME[FM1C_TR_KINDS] = {"none", "select-list", "select-buddy", "hero", "page",
    "layout", "reader-open", "reader-close", "reader-page", "window", "toast-in", "toast-out", "knob-in", "knob-out",
    "voice", "task"};
#endif

typedef struct {
    uint8_t kind, step, nsteps, started, op, dir, fin;   /* dir: 1 forward / left to right; fin: the last step drew
                                                          * (the end waits for t0 + FM1C_TR_END_MS) */
    uint8_t mod;                                /* a host frame changed the model while it ran: the end redraws in full */
    uint16_t sub;                               /* rows of the current op already drawn */
    uint32_t t0;
    int16_t a, b, prev;                         /* selection: old and new row y (list) or key (Buddy); prev frame y */
    int16_t bx, by, bw, bh;                     /* the reader's bubble rectangle */
#ifdef DINGHY_HOST
    uint64_t px0, step_px0;
    uint32_t px_max;
#endif
} fm1c_trans;

/* what the screen shows as last drawn (the trigger of a transition is a difference to it) */
typedef struct {
    uint8_t valid, view, layout, page, toast, knob, dstate, provider;   /* layout: fm1c_shape (version 6: + SPLIT, settings) */
    uint8_t task_page, task_pages;              /* version 6 SPLIT: the task page as drawn (the task wipe) */
    int8_t sel;
    uint8_t vstyle[7];                          /* voice: rows 1-6 of the transcript as drawn (the text scroll) */
    char vrow[7][FM1C_L_TEXT_WIRE + 1];
} fm1c_scr;

static fm1c_trans fm1c_tr;
static fm1c_scr fm1c_sn;
/* section 9.10.1: an end that marked regions to redraw, not drawn yet (no transition starts meanwhile); the last
 * press (a key down, an encoder step) and the end of the fast scroll it started */
static uint8_t fm1c_tr_owed, fm1c_tr_pressed;
static uint32_t fm1c_tr_press_t, fm1c_tr_fast_until;

static const uint8_t FM1C_TR_T3[3] = {0, 30, 70}, FM1C_TR_T4[4] = {0, 20, 50, 90}, FM1C_TR_TR[4] = {0, 30, 70, 110};

/* ---- the panel's vertical scroll (section 9.10) */
static uint32_t fm1c_vs_tfa, fm1c_vs_vsa = 0, fm1c_vs_off;   /* the area and its offset (start - TFA) */
#ifdef DINGHY_HOST
/* Host mode: fb[] is what the panel shows. A new offset rotates the area's rows; a blit to frame-memory row y lands
 * on panel row TFA + ((y - TFA) - off) mod VSA (scanout row d shows memory row TFA + ((d - TFA) + off) mod VSA). */
static uint16_t fm1c_vs_tmp[240u * 240u];
static uint32_t fm1c_vs_cmds;                   /* VSCRDEF / VSCRSADD sent (the scenarios count them) */
static void fm1c_vs_def(uint32_t tfa, uint32_t vsa)
{
    fm1c_vs_tfa = tfa;
    fm1c_vs_vsa = vsa;
    fm1c_vs_off = 0;
    fm1c_vs_cmds++;
}
static void fm1c_vs_start(uint32_t start)
{
    uint32_t o = (start - fm1c_vs_tfa) % fm1c_vs_vsa, d, sh = (o + fm1c_vs_vsa - fm1c_vs_off) % fm1c_vs_vsa, i;
    for (d = 0; d < fm1c_vs_vsa; d++)
        for (i = 0; i < 240u; i++)
            fm1c_vs_tmp[d * 240u + i] = fb[(fm1c_vs_tfa + (d + sh) % fm1c_vs_vsa) * 240u + i];
    for (d = 0; d < fm1c_vs_vsa * 240u; d++) fb[fm1c_vs_tfa * 240u + d] = fm1c_vs_tmp[d];
    fm1c_vs_off = o;
    fm1c_vs_cmds++;
}
static void fm1c_lcd_blit(uint32_t x, uint32_t y, uint32_t w, uint32_t h, const uint16_t *px)
{
    uint32_t r;
    if (!fm1c_vs_off || y + h <= fm1c_vs_tfa || y >= fm1c_vs_tfa + fm1c_vs_vsa) { lcd_blit(x, y, w, h, px); return; }
    for (r = 0; r < h; r++) {
        uint32_t my = y + r, d = my;
        if (my >= fm1c_vs_tfa && my < fm1c_vs_tfa + fm1c_vs_vsa)
            d = fm1c_vs_tfa + (my - fm1c_vs_tfa + fm1c_vs_vsa - fm1c_vs_off) % fm1c_vs_vsa;
        lcd_blit(x, d, w, 1, px + r * w);
    }
}
#else
static uint8_t fm1c_vs_buf[6];
static void fm1c_vs_send(uint32_t cmd, uint32_t a, uint32_t b, uint32_t c, uint32_t n)
{
    lcd_window(0, 319, 0, 319);                 /* the RAM pointer off the visible 240 lines first: a panel model that
                                                 * does not know the command takes its parameters as pixels (fm1-emu
                                                 * 0.5.1 does), and they then land where nothing shows */
    lcd_cmd((uint8_t)cmd);                      /* (lcd.c: waits for the running transfer first, so the buffer is free) */
    fm1c_vs_buf[0] = (uint8_t)(a >> 8); fm1c_vs_buf[1] = (uint8_t)a;
    fm1c_vs_buf[2] = (uint8_t)(b >> 8); fm1c_vs_buf[3] = (uint8_t)b;
    fm1c_vs_buf[4] = (uint8_t)(c >> 8); fm1c_vs_buf[5] = (uint8_t)c;
    lcd_data(fm1c_vs_buf, n);
    lcd_sync();
}
static void fm1c_vs_def(uint32_t tfa, uint32_t vsa)
{
    fm1c_vs_tfa = tfa;
    fm1c_vs_vsa = vsa;
    fm1c_vs_off = 0;
    fm1c_vs_send(0x33u, tfa, vsa, 320u - tfa - vsa, 6u);   /* VSCRDEF: TFA + VSA + BFA = 320 (the frame memory) */
    fm1c_vs_send(0x37u, tfa, 0, 0, 2u);                    /* VSCRSADD: the identity */
}
static void fm1c_vs_start(uint32_t start)
{
    fm1c_vs_off = (start - fm1c_vs_tfa) % fm1c_vs_vsa;
    fm1c_vs_send(0x37u, start, 0, 0, 2u);
}
static void fm1c_lcd_blit(uint32_t x, uint32_t y, uint32_t w, uint32_t h, const uint16_t *px) { lcd_blit(x, y, w, h, px); }
#endif
static void fm1c_vs_identity(void)
{
    if (fm1c_vs_vsa && fm1c_vs_off) fm1c_vs_start(fm1c_vs_tfa);
}

/* ---- the screen as the model says, clipped to (x, y, w, h): every region that meets it */
static void fm1c_scene(const fm1c_model *m, int32_t x, int32_t y, int32_t w, int32_t h)
{
    uint32_t n;
    fm1c_clip_on = 1;
    fm1c_clip_x0 = x; fm1c_clip_y0 = y; fm1c_clip_x1 = x + w; fm1c_clip_y1 = y + h;
    if (fm1c_settings(m)) {                     /* version 6 settings (no transition draws it today; for completeness) */
        if (fm1c_clip_hit(0, 18, 240, 206)) fm1c_draw6_settings(m);
    } else if (fm1c_list(m)) {
        uint32_t ly = fm1c_list_y(m);
        if (fm1c_clip_hit(0, 18, 29, 42)) fm1c_draw5_hero(m);
        if (fm1c_clip_hit(29, 18, 211, 42)) fm1c_v5_head(m, 29, 18, 211, 42);
        if (fm1c_split_band(m) && fm1c_clip_hit(0, FM1C_V6_LBAND_Y, 240, 32)) fm1c_draw6_band(m);
        if (fm1c_clip_hit(0, (int32_t)ly - 2, 240, 226 - (int32_t)ly)) fm1c_draw5_frame(m);
        for (n = 0; n < fm1c_list_rows(m); n++)
            if (fm1c_clip_hit(0, (int32_t)ly + 16 * (int32_t)n, FM1C_V5_ROW_W, 16)) fm1c_draw5_row(m, n);
    } else if (fm1c_split_buddy(m)) {           /* version 6 SPLIT Buddy: the 4-row bubble, the band, the white row */
        if (fm1c_clip_hit(0, 18, 52, 50)) fm1c_draw4_hero(m);
        if (fm1c_clip_hit(52, 18, 188, 50)) fm1c_draw4_label(m);
        if (fm1c_clip_hit(0, 68, 240, 100)) fm1c_draw6_bubble(m);
        if (fm1c_clip_hit(8, 78, 224, 16)) fm1c_draw4_caption(m);
        for (n = 1; n < 5u; n++)
            if (fm1c_clip_hit(8, 96 + 16 * ((int32_t)n - 1), 224, 16)) fm1c_draw4_body(m, n);
        if (fm1c_clip_hit(0, FM1C_V6_BAND_Y, 240, 32)) fm1c_draw6_band(m);
        if (fm1c_clip_hit(0, FM1C_V6_WHITE_Y, 240, 24)) fm1c_draw6_white(m);
    } else if (fm1c_detail(m)) {
        static const uint8_t Y0[3] = {18, 36, 52}, H[3] = {18, 16, 20};
        if (fm1c_clip_hit(0, 18, 52, 54)) fm1c_draw4_hero(m);
        for (n = 0; n < FM1C_TEXT_ROWS; n++) {
            int32_t ry = n < 3u ? Y0[n] : 72 + 16 * ((int32_t)n - 3), rh = n < 3u ? H[n] : n == 11u ? 24 : 16;
            if (fm1c_clip_hit(n < 3u ? 52 : 0, ry, n < 3u ? 188 : 240, rh)) fm1c_draw4_detail_row(m, n);
        }
    } else {
        if (fm1c_clip_hit(0, 18, 52, 50)) fm1c_draw4_hero(m);
        if (fm1c_clip_hit(52, 18, 188, 50)) fm1c_draw4_label(m);
        if (fm1c_clip_hit(0, 68, 240, 116)) fm1c_draw4_bubble(m);
        if (fm1c_clip_hit(8, 78, 224, 16)) fm1c_draw4_caption(m);
        for (n = 1; n < 6u; n++)
            if (fm1c_clip_hit(8, 96 + 16 * ((int32_t)n - 1), 224, 16)) fm1c_draw4_body(m, n);
        if (fm1c_clip_hit(0, FM1C_V4_KBD_Y, 240, 40)) fm1c_draw4_keyboard(m);
    }
    if (fm1c_clip_hit(0, FM1C_V4_HINT_Y, 240, 16)) fm1c_draw4_hint(m);
    fm1c_clip_on = 0;
}

/* ---- one step's operations */
enum { FM1C_OP_SCENE = 0, FM1C_OP_SCENE_NOSEL, FM1C_OP_FRAME, FM1C_OP_KEYFRAME, FM1C_OP_OUTLINE, FM1C_OP_HERO,
       FM1C_OP_HINT, FM1C_OP_VOICE, FM1C_OP_VSTART };
typedef struct {
    uint8_t kind, arg;                          /* HERO: 0 squash, 1 pop; HINT: the fm1c_hint_bar mode; VSTART: step i */
    int16_t x, y, w, h, oy;
} fm1c_op;

static void fm1c_op_set(fm1c_op *o, uint32_t kind, int32_t x, int32_t y, int32_t w, int32_t h)
{
    o->kind = (uint8_t)kind; o->arg = 0; o->oy = 0;
    o->x = (int16_t)x; o->y = (int16_t)y; o->w = (int16_t)w; o->h = (int16_t)h;
}
static int32_t fm1c_lerp(int32_t a, int32_t b, uint32_t i, uint32_t n) { return a + (b - a) * (int32_t)i / (int32_t)n; }

/* the hero box of the pop: Buddy 48 x 50 at (4, 18), List/Grouped 24 x 25 at (4, 25) */
static void fm1c_hero_box(const fm1c_model *m, int32_t *x, int32_t *y, int32_t *w, int32_t *h, uint32_t *sc)
{
    if (fm1c_list(m)) { *x = 4; *y = 25; *w = 24; *h = 25; *sc = 1; }
    else { *x = 4; *y = 18; *w = 48; *h = 50; *sc = 2; }
}

/* op number `op` of step `st` of the running transition; 0 when the step has no more */
static int fm1c_tr_op(const fm1c_model *m, const fm1c_trans *t, uint32_t st, uint32_t op, fm1c_op *o)
{
    uint32_t i = st + 1u;
    switch (t->kind) {
    case FM1C_TR_SEL_LIST:                      /* 1, 2: the frame slides; 3: the rows as they are */
        if (st == 2u) {                         /* the rows under the last frame, the old and the new row: final */
            if (op > 2u) return 0;
            fm1c_op_set(o, FM1C_OP_SCENE, 0, op == 0u ? t->prev : op == 1u ? t->a : t->b, FM1C_V5_ROW_W, 16);
            return 1;
        }
        if (st > 2u) return 0;
        if (op == 0u) { fm1c_op_set(o, FM1C_OP_SCENE_NOSEL, 0, st ? t->prev : t->a, FM1C_V5_ROW_W, 16); return 1; }
        if (op == 1u) {
            fm1c_op_set(o, FM1C_OP_SCENE_NOSEL, 0, fm1c_lerp(t->a, t->b, i, 3u), FM1C_V5_ROW_W, 16);
            return 1;
        }
        if (op == 2u) { fm1c_op_set(o, FM1C_OP_FRAME, 0, fm1c_lerp(t->a, t->b, i, 3u), FM1C_V5_ROW_W, 16); return 1; }
        return 0;
    case FM1C_TR_SEL_BUDDY: {                   /* a white 14 x 14 frame between the two key boxes */
        int32_t x0, y0, x1, y1, w, h, px, py;
        if (st > 2u) return 0;
        fm1c_key_box(m, (uint32_t)t->a, &x0, &y0, &w, &h);
        fm1c_key_box(m, (uint32_t)t->b, &x1, &y1, &w, &h);
        if (st == 2u) {                         /* 3: the keyboard under the last frame, the old and the new key: final */
            if (op > 2u) return 0;
            if (op == 0u) fm1c_op_set(o, FM1C_OP_SCENE, fm1c_lerp(x0, x1, 2u, 3u), fm1c_lerp(y0, y1, 2u, 3u), 14, 14);
            else fm1c_op_set(o, FM1C_OP_SCENE, op == 1u ? x0 : x1, op == 1u ? y0 : y1, w, h);
            return 1;
        }
        if (op == 0u) {                         /* the keyboard under the previous frame (or the old key), unselected */
            px = st ? fm1c_lerp(x0, x1, st, 3u) : x0;
            py = st ? fm1c_lerp(y0, y1, st, 3u) : y0;
            fm1c_op_set(o, FM1C_OP_SCENE_NOSEL, px, py, 14, 14);
            return 1;
        }
        if (op == 1u) {
            fm1c_op_set(o, FM1C_OP_KEYFRAME, fm1c_lerp(x0, x1, i, 3u), fm1c_lerp(y0, y1, i, 3u), 14, 14);
            return 1;
        }
        return 0;
    }
    case FM1C_TR_HERO: {
        int32_t x, y, w, h;
        uint32_t sc;
        if (st > 2u || op) return 0;
        fm1c_hero_box(m, &x, &y, &w, &h, &sc);
        if (st == 2u) { fm1c_op_set(o, FM1C_OP_SCENE, x, y, w, h); return 1; }   /* 3: normal */
        fm1c_op_set(o, FM1C_OP_HERO, x, y, w, h);
        o->arg = (uint8_t)st;
        return 1;
    }
    case FM1C_TR_PAGE: {                        /* columns of the list band (or the keyboard band) */
        int32_t bx = 0, by = 60, bw = FM1C_V5_ROW_W, bh = 164, c0, c1;
        if (op) return 0;
        if (!fm1c_list(m)) { by = 182; bw = 240; bh = 40; }
        if (fm1c_split_list(m)) { by = 92; bh = 132; }   /* (version 6 SPLIT: below the band; Buddy: the white row) */
        else if (fm1c_split_buddy(m)) { by = FM1C_V6_WHITE_Y; bh = 24; }
        c0 = bw * (int32_t)st / 3;
        c1 = bw * (int32_t)i / 3;
        if (!t->dir) { int32_t a = bw - c1; c1 = bw - c0; c0 = a; }
        fm1c_op_set(o, FM1C_OP_SCENE, bx + c0, by, c1 - c0, bh);
        return 1;
    }
    case FM1C_TR_TASK: {                        /* version 6: columns of the black row band (7,680 px in 3 steps) */
        int32_t c0 = 240 * (int32_t)st / 3, c1 = 240 * (int32_t)i / 3;
        if (op) return 0;
        if (!t->dir) { int32_t a = 240 - c1; c1 = 240 - c0; c0 = a; }
        fm1c_op_set(o, FM1C_OP_SCENE, c0, (int32_t)fm1c_band_y(m), c1 - c0, 32);
        return 1;
    }
    case FM1C_TR_LAYOUT: {                      /* rows of the body band, top to bottom */
        int32_t r0 = 18 + 206 * (int32_t)st / 4, r1 = 18 + 206 * (int32_t)i / 4;
        if (op) return 0;
        fm1c_op_set(o, FM1C_OP_SCENE, 0, r0, 240, r1 - r0);
        return 1;
    }
    case FM1C_TR_READER_OPEN:
    case FM1C_TR_READER_CLOSE: {                /* outlines between the bubble B and the full body F */
        uint32_t k = t->kind == FM1C_TR_READER_OPEN ? i : 3u - i;
        if (st >= 3u || op) return 0;
        fm1c_op_set(o, FM1C_OP_OUTLINE, fm1c_lerp(t->bx, 0, k, 3u), fm1c_lerp(t->by, 18, k, 3u),
                    fm1c_lerp(t->bw, 240, k, 3u), fm1c_lerp(t->bh, 206, k, 3u));
        return 1;
    }
    case FM1C_TR_READER_PAGE:
    case FM1C_TR_WINDOW: {                      /* set the scroll start, then the rows it exposes */
        int32_t tfa = t->kind == FM1C_TR_WINDOW ? (int32_t)fm1c_list_y(m) : 72, vsa = t->kind == FM1C_TR_WINDOW ?
                      16 * (int32_t)fm1c_list_rows(m) : 152, s = vsa / 4;   /* (window: 62 / 160, SPLIT 94 / 128) */
        if (op == 0u) { fm1c_op_set(o, FM1C_OP_VSTART, 0, 0, 0, 0); o->arg = (uint8_t)i; return 1; }
        if (op == 1u) {
            fm1c_op_set(o, FM1C_OP_SCENE, 0, t->dir ? tfa + s * (int32_t)st : tfa + vsa - s * (int32_t)i, 240, s);
            return 1;
        }
        return 0;
    }
    case FM1C_TR_TOAST_IN:
    case FM1C_TR_KNOB_IN: {
        static const int8_t OY[3] = {11, 5, 0};
        if (op) return 0;
        fm1c_op_set(o, FM1C_OP_HINT, 0, FM1C_V4_HINT_Y, 240, 16);
        o->arg = t->kind == FM1C_TR_TOAST_IN ? FM1C_HB_TOAST : FM1C_HB_KNOBS;
        o->oy = OY[st];
        return 1;
    }
    case FM1C_TR_TOAST_OUT:
    case FM1C_TR_KNOB_OUT: {
        static const int8_t OY[3] = {5, 11, 0};
        if (op) return 0;
        fm1c_op_set(o, FM1C_OP_HINT, 0, FM1C_V4_HINT_Y, 240, 16);
        o->arg = st == 2u ? FM1C_HB_MODEL : t->kind == FM1C_TR_TOAST_OUT ? FM1C_HB_TOAST : FM1C_HB_KNOBS;
        o->oy = OY[st];
        return 1;
    }
    case FM1C_TR_VOICE:
        if (op) return 0;
        fm1c_op_set(o, FM1C_OP_VOICE, FM1C_V4_ROW_X, FM1C_V4_BODY_Y, FM1C_V4_ROW_W, 80);
        o->oy = (int16_t)(20 * (int32_t)i);
        return 1;
    }
    return 0;
}

/* the hero, squashed (18 rows, bottom-aligned) or popped (1 * scale higher) */
static void fm1c_tr_hero(const fm1c_model *m, uint32_t pop)
{
    int32_t x, y, w, h, r;
    uint32_t sc, pose = fm1c_anim_pose(fm1c_v4_state(m), 0), frame = fm1c_anim_frame(pose, FM1C_ANIM_HERO, fm1c_now);
    uint16_t pal[16];
    fm1c_hero_box(m, &x, &y, &w, &h, &sc);
    fm1c_cvb((uint32_t)w, (uint32_t)h, C_BLACK);
    if (pose != FM1C_SPR_NONE) {
        fm1c_spr_pal(fm1c_v4_state(m), pal);
        fm1c_sprite(0, pop ? 0 : (int32_t)sc, fm1c_spr_hero(pose, (uint32_t)fm1c_v4_codex(m), frame), FM1C_SPR_HERO_N, pal, sc);
    }
    if (!pop) {                                 /* squash: destination row d shows source row floor(4 d / 3) */
        for (r = 17 * (int32_t)sc + (int32_t)sc - 1; r >= 0; r--) {
            int32_t d = r / (int32_t)sc, src = (d * 4 / 3) * (int32_t)sc + r % (int32_t)sc, dst = 6 * (int32_t)sc + r, c;
            for (c = 0; c < w; c++) cv_px[(uint32_t)(dst + (int32_t)sc) * (uint32_t)w + (uint32_t)c] =
                cv_px[(uint32_t)(src + (int32_t)sc) * (uint32_t)w + (uint32_t)c];
        }
        /* rows above the squashed sprite: black, after the copy (the copy of rows d 0-4 reads source rows up to
         * 6 * sc + sc - 1, which this clears) */
        for (r = 0; r < 6 * (int32_t)sc * w; r++) cv_px[(uint32_t)((int32_t)sc * w + r)] = 0;
    }
    fm1c_cvx((uint32_t)x, (uint32_t)y);
}

/* the voice transcript moved: rows 1-5 as drawn and as they are now, one above the other, a window of 80 px at oy */
static void fm1c_tr_voice(const fm1c_model *m, const fm1c_trans *t, int32_t oy, int32_t r0, int32_t rn)
{
    uint32_t r;
    int32_t base = t->dir ? oy : 80 - oy;       /* (the window's top in the 160 px column) */
    fm1c_cvb(FM1C_V4_ROW_W, (uint32_t)rn, C_BLACK);
    cv_oy = -r0 - base;
    for (r = 1; r < 6u; r++) {
        int32_t yo = 16 * ((int32_t)r - 1), yn = yo + 80;
        const char *older = fm1c_sn.vrow[r], *newer = m->text[r];
        uint8_t so = fm1c_sn.vstyle[r], sn = m->tstyle[r];
        if (!t->dir) { yn = yo; yo += 80; }     /* back: the new rows above the old */
        if (so >= FM1C_N_STYLE) so = FM1C_TS_BODY;
        if (sn >= FM1C_N_STYLE) sn = FM1C_TS_BODY;
        fm1c_rich(0, yo, older, FM1C_L_TEXT, FM1C_STYLE_RGB[so], so);
        fm1c_rich(0, yn, newer, FM1C_L_TEXT, FM1C_STYLE_RGB[sn], sn);
    }
    cv_oy = 0;
    fm1c_cvx(FM1C_V4_ROW_X, (uint32_t)(FM1C_V4_BODY_Y + r0));
}

static void fm1c_outline(int32_t x, int32_t y, int32_t w, int32_t h, uint16_t c)
{
    lcd_fill((uint32_t)x, (uint32_t)y, (uint32_t)w, 1, c);
    lcd_fill((uint32_t)x, (uint32_t)(y + h - 1), (uint32_t)w, 1, c);
    lcd_fill((uint32_t)x, (uint32_t)(y + 1), 1, (uint32_t)(h - 2), c);
    lcd_fill((uint32_t)(x + w - 1), (uint32_t)(y + 1), 1, (uint32_t)(h - 2), c);
}

/* draws (part of) one op: at most budget px; returns 1 when the op is done */
static int fm1c_tr_draw(fm1c_model *m, fm1c_trans *t, const fm1c_op *o, uint32_t budget)
{
    uint32_t rows;
    switch (o->kind) {
    case FM1C_OP_SCENE:
    case FM1C_OP_SCENE_NOSEL:
        if (o->w <= 0 || o->h <= 0) return 1;
        rows = budget / (uint32_t)o->w;
        if (!rows) rows = 1;
        if (rows > (uint32_t)o->h - t->sub) rows = (uint32_t)o->h - t->sub;
        fm1c_sel_hide = o->kind == FM1C_OP_SCENE_NOSEL;
        fm1c_scene(m, o->x, o->y + (int32_t)t->sub, o->w, (int32_t)rows);
        fm1c_sel_hide = 0;
        t->sub = (uint16_t)(t->sub + rows);
        if (t->sub < (uint16_t)o->h) return 0;
        t->sub = 0;
        return 1;
    case FM1C_OP_FRAME:
        fm1c_outline(o->x, o->y, o->w, o->h, FM1C_C_GREY);
        t->prev = o->y;
        return 1;
    case FM1C_OP_KEYFRAME:
        fm1c_outline(o->x, o->y, o->w, o->h, C_WHITE);
        return 1;
    case FM1C_OP_OUTLINE:
        fm1c_outline(o->x, o->y, o->w, o->h, fm1c_v4_bubble_col(m));
        return 1;
    case FM1C_OP_HERO:
        fm1c_tr_hero(m, o->arg);
        return 1;
    case FM1C_OP_HINT:                          /* (3,840 px: in two slices, through the clip) */
        rows = budget / 240u;
        if (!rows) rows = 1;
        if (rows > 16u - t->sub) rows = 16u - t->sub;
        fm1c_clip_on = 1;
        fm1c_clip_x0 = 0; fm1c_clip_x1 = 240;
        fm1c_clip_y0 = FM1C_V4_HINT_Y + (int32_t)t->sub; fm1c_clip_y1 = fm1c_clip_y0 + (int32_t)rows;
        fm1c_hint_bar(m, o->arg, o->oy);
        fm1c_clip_on = 0;
        t->sub = (uint16_t)(t->sub + rows);
        if (t->sub < 16u) return 0;
        t->sub = 0;
        return 1;
    case FM1C_OP_VOICE:
        rows = budget / (uint32_t)o->w;
        if (rows > 80u - t->sub) rows = 80u - t->sub;
        fm1c_tr_voice(m, t, o->oy, t->sub, (int32_t)rows);
        t->sub = (uint16_t)(t->sub + rows);
        if (t->sub < 80u) return 0;
        t->sub = 0;
        return 1;
    case FM1C_OP_VSTART: {
        uint32_t s = fm1c_vs_vsa / 4u * o->arg;
        fm1c_vs_start(t->dir ? fm1c_vs_tfa + s % fm1c_vs_vsa : fm1c_vs_tfa + (fm1c_vs_vsa - s % fm1c_vs_vsa) % fm1c_vs_vsa);
        return 1;
    }
    }
    return 1;
}

/* ---- start, end */
static void fm1c_tr_report(const char *how)
{
#ifdef DINGHY_HOST
    printf("%6u ms  TRANS %s %s px %llu maxstep %u\n", fm1_ms, FM1C_TR_NAME[fm1c_tr.kind], how,
           (unsigned long long)(host_px - fm1c_tr.px0), fm1c_tr.px_max);
#else
    (void)how;
#endif
}

/* what the screen shows from now on: taken when a transition ends (it ran on the snapshot of its start: the voice
 * scroll draws the rows as they were from it) and after each usual draw (console.c) */
static void fm1c_seen_take(const fm1c_model *m)
{
    uint32_t r;
    fm1c_sn.valid = 1;
    fm1c_sn.view = m->view;
    fm1c_sn.layout = (uint8_t)fm1c_shape(m);
    fm1c_sn.page = m->page;
    fm1c_sn.task_page = m->task_page;
    fm1c_sn.task_pages = m->task_pages;
    fm1c_sn.toast = m->toast_on;
    fm1c_sn.knob = m->knob_on;
    fm1c_sn.dstate = m->dstate;
    fm1c_sn.provider = m->provider;
    fm1c_sn.sel = (int8_t)fm1c_selected(m);
    if (m->view == FM1C_VIEW_VOICE)
        for (r = 1; r < 7u; r++) {
            fm1c_sn.vstyle[r] = m->tstyle[r];
            fm1c_str_set(fm1c_sn.vrow[r], m->text[r], FM1C_L_TEXT_WIRE);
        }
}

/* the end: what the transition left to the usual drawing, marked; what it drew in its final form, not. Interrupted
 * (at_once) or overtaken by a host frame that changed the model while it ran (t->mod: its steps drew from different
 * models, and the list window may have moved under it): every region it touched, in full, from the model as it is
 * now (section 9.10.1) */
static void fm1c_tr_end(fm1c_model *m, int at_once)
{
    fm1c_trans *t = &fm1c_tr;
    uint32_t k = t->kind;
    fm1c_vs_identity();
    fm1c_tr_report(at_once ? "at-once" : "done");
    t->kind = FM1C_TR_NONE;
    fm1c_seen_take(m);                          /* (no second start for the same change) */
    at_once = at_once || t->mod;
    if (at_once) fm1c_tr_owed = 1;
    switch (k) {
    case FM1C_TR_SEL_LIST: {                    /* at once: the rows under the frames, as they are */
        int32_t ly = (int32_t)fm1c_list_y(m);
        if (!at_once) break;
        m->dirty_lrows |= 1u << ((t->a - ly) / 16) | 1u << ((t->b - ly) / 16);
        if (t->prev >= ly) {
            m->dirty_lrows |= 1u << ((t->prev - ly) / 16);
            if ((t->prev - ly) % 16 && (t->prev - ly) / 16 + 1 < (int32_t)fm1c_list_rows(m))
                m->dirty_lrows |= 1u << ((t->prev - ly) / 16 + 1);
        }
        break;
    }
    case FM1C_TR_SEL_BUDDY:
        if (at_once) m->dirty |= FM1C_D_KBD;    /* (the frame passed between keys: the keyboard, 9,600 px) */
        break;
    case FM1C_TR_HERO:
        if (at_once) m->dirty |= FM1C_D_HERO;
        break;
    case FM1C_TR_PAGE:
        if (at_once) { m->dirty |= fm1c_list(m) ? FM1C_D_LIST : FM1C_D_KBD; break; }
        if (fm1c_list(m)) { fm1c_list_drawn(m); fm1c_draw5_frame(m); }
        break;
    case FM1C_TR_TASK:
        if (at_once) m->dirty |= FM1C_D_BAND;
        break;
    case FM1C_TR_LAYOUT:
        if (at_once) {
            m->dirty |= FM1C_D_HERO | FM1C_D_LABEL4 | FM1C_D_BUBBLE | FM1C_D_KBD | FM1C_D_LIST | FM1C_D_ELAPSED;
            m->dirty_rows = FM1C_ROWS_ALL;
            m->dirty_keys = FM1C_KEYS_ALL;
            break;
        }
        if (fm1c_list(m)) fm1c_list_drawn(m);
        break;
    case FM1C_TR_READER_PAGE:
        if (at_once) m->dirty_rows |= 0xFF8u;
        break;
    case FM1C_TR_WINDOW:
        if (at_once) { m->dirty |= FM1C_D_LIST; break; }
        fm1c_list_drawn(m);
        fm1c_draw5_frame(m);                    /* (the scroll column at its new place) */
        break;
    case FM1C_TR_TOAST_IN: case FM1C_TR_TOAST_OUT: case FM1C_TR_KNOB_IN: case FM1C_TR_KNOB_OUT:
        if (at_once) m->dirty |= FM1C_D_HINT4;
        break;
    case FM1C_TR_VOICE:
        if (at_once) m->dirty_rows |= 0x3Eu;
        break;
    default:                                    /* reader open / close: drawn as usual now */
        break;
    }
}

static void fm1c_trans_finish(fm1c_model *m)
{
    if (fm1c_tr.kind) fm1c_tr_end(m, 1);
}

/* section 9.10.1: a panel edge (every edge finishes the running transition); a press, a key down or an encoder step,
 * within FM1C_TR_FAST_MS of the previous press is a fast scroll: no transition starts until FM1C_TR_FAST_MS after it,
 * so the host's answers to it are drawn at once. (Buttons are not counted: a double press of OCT is one gesture, its
 * task wipe the answer.) */
static void fm1c_trans_input(fm1c_model *m, uint32_t now, int press)
{
    fm1c_trans_finish(m);
    if (!press) return;
    if (fm1c_tr_pressed && now - fm1c_tr_press_t < FM1C_TR_FAST_MS) fm1c_tr_fast_until = now + FM1C_TR_FAST_MS;
    fm1c_tr_pressed = 1;
    fm1c_tr_press_t = now;
}

/* a host frame applied (console.c): one that can change what a running transition draws marks it overtaken */
static void fm1c_trans_host(uint32_t type)
{
    if (fm1c_tr.kind && type != FM1C_T_HOST_HB && type != FM1C_T_HOST_ACK) fm1c_tr.mod = 1;
}

/* after a usual draw: what an interrupted or overtaken transition marked is drawn once nothing is left to draw */
static void fm1c_trans_drawn(const fm1c_model *m)
{
    if (fm1c_tr_owed && !(m->dirty & ~FM1C_D_ELAPSED) && !m->dirty_keys && !m->dirty_rows && !m->dirty_lrows) fm1c_tr_owed = 0;
}

static void fm1c_tr_begin(fm1c_model *m, uint32_t kind, uint32_t t0)
{
    fm1c_trans *t = &fm1c_tr;
    t->kind = (uint8_t)kind;
    t->step = 0;
    t->started = 0;
    t->op = 0;
    t->sub = 0;
    t->fin = 0;
    t->mod = 0;
    t->t0 = t0;
    t->prev = -1;
    t->nsteps = kind == FM1C_TR_LAYOUT || kind == FM1C_TR_READER_PAGE || kind == FM1C_TR_WINDOW ||
                kind == FM1C_TR_VOICE || kind == FM1C_TR_READER_OPEN || kind == FM1C_TR_READER_CLOSE ? 4u : 3u;
#ifdef DINGHY_HOST
    t->px0 = host_px;
    t->px_max = 0;
#endif
    switch (kind) {                             /* what the transition draws itself: not drawn as usual */
    case FM1C_TR_SEL_LIST:                      /* (the two keys' rows: step 3; the caller sets a and b after) */
    case FM1C_TR_SEL_BUDDY:
        break;
    case FM1C_TR_HERO:
        m->dirty &= ~FM1C_D_HERO;
        break;
    case FM1C_TR_PAGE:
        if (fm1c_list(m)) { m->dirty &= ~FM1C_D_LIST; m->dirty_lrows = 0; } else m->dirty &= ~FM1C_D_KBD;
        m->dirty_keys &= fm1c_split_band(m) ? FM1C_KEYS_BLACK : 0u;   /* (version 6 SPLIT: the chips are not in the wipe) */
        break;
    case FM1C_TR_TASK:                          /* (the band: the chips, stems and dots) */
        m->dirty &= ~FM1C_D_BAND;
        m->dirty_keys &= ~FM1C_KEYS_BLACK;
        break;
    case FM1C_TR_LAYOUT:
        m->dirty &= ~(FM1C_D_HERO | FM1C_D_LABEL4 | FM1C_D_BUBBLE | FM1C_D_KBD | FM1C_D_LIST | FM1C_D_ELAPSED);
        m->dirty_rows = m->dirty_keys = m->dirty_lrows = m->dirty_bars = 0;
        break;
    case FM1C_TR_READER_PAGE:
        fm1c_vs_def(72, 152);
        m->dirty_rows &= ~0xFF8u;
        break;
    case FM1C_TR_WINDOW:
        fm1c_vs_def(fm1c_list_y(m), 16u * fm1c_list_rows(m));   /* (TFA 62 VSA 160; version 6 SPLIT: TFA 94 VSA 128) */
        m->dirty &= ~FM1C_D_LIST;
        m->dirty_lrows = m->dirty_keys = 0;
        break;
    case FM1C_TR_TOAST_IN: case FM1C_TR_TOAST_OUT: case FM1C_TR_KNOB_IN: case FM1C_TR_KNOB_OUT:
        m->dirty &= ~FM1C_D_HINT4;
        break;
    case FM1C_TR_VOICE:
        m->dirty_rows &= ~0x3Eu;
        break;
    default:
        break;
    }
}

/* ---- the trigger: a change between what was drawn (fm1c_sn) and the model; starts the transition, 1 */
static int fm1c_trans_detect(fm1c_model *m, uint32_t t0)
{
    const fm1c_scr *s = &fm1c_sn;
    uint32_t lay = fm1c_shape(m), base = m->view <= FM1C_VIEW_INBOX, k;   /* (lay: version 1-5 the layout alone) */
    int32_t sel = fm1c_selected(m);
    if (!s->valid || m->look < FM1C_PROTO_V5 || m->conn != FM1C_C_OK || m->help) return 0;
    if (fm1c_tr_owed || (int32_t)(fm1c_tr_fast_until - fm1c_now) > 0) return 0;   /* (section 9.10.1: drawn at once) */
    if (m->view != s->view) {
        int from_base = s->view == FM1C_VIEW_SESSIONS || s->view == FM1C_VIEW_INBOX;
        int to_base = m->view == FM1C_VIEW_SESSIONS || m->view == FM1C_VIEW_INBOX;
        uint32_t bl = m->view == FM1C_VIEW_DETAIL ? s->layout : lay;
        if (!(from_base && m->view == FM1C_VIEW_DETAIL) && !(s->view == FM1C_VIEW_DETAIL && to_base)) return 0;
        fm1c_tr_begin(m, from_base ? FM1C_TR_READER_OPEN : FM1C_TR_READER_CLOSE, t0);
        if (bl & 3u) { fm1c_tr.bx = 34; fm1c_tr.by = 19; fm1c_tr.bw = 204; fm1c_tr.bh = 40; }
        else { fm1c_tr.bx = 2; fm1c_tr.by = 74; fm1c_tr.bw = 236; fm1c_tr.bh = (bl & 4u) ? 92 : 108; }   /* (SPLIT: 4 rows) */
        return 1;
    }
    if (lay != s->layout) {
        if (!base) return 0;
        fm1c_tr_begin(m, FM1C_TR_LAYOUT, t0);
        return 1;
    }
    if (m->page != s->page) {
        if (m->view == FM1C_VIEW_DETAIL) {
            if (!FM1C_VSCROLL_HW || (m->page != s->page + 1u && m->page + 1u != s->page)) return 0;
            fm1c_tr_begin(m, FM1C_TR_READER_PAGE, t0);
            fm1c_tr.dir = m->page > s->page;
            return 1;
        }
        if (!base) return 0;
        fm1c_tr_begin(m, FM1C_TR_PAGE, t0);
        fm1c_tr.dir = m->page > s->page;
        return 1;
    }
    if (fm1c_split_band(m) && (m->task_page != s->task_page || m->task_pages != s->task_pages) && m->task_pages) {
        fm1c_tr_begin(m, FM1C_TR_TASK, t0);     /* version 6: the task wipe, left to right for the next task page */
        fm1c_tr.dir = m->task_page == (s->task_page + 1u) % m->task_pages;
        return 1;
    }
    if (base && sel >= 0 && s->sel >= 0 && sel != s->sel) {
        if (fm1c_list(m)) {
            uint32_t top;
            int32_t ro, rn;
            fm1c_list_win(m, &top, 0);
            if (fm1c_list_occ(m) != m->list_occ || fm1c_list_hdr(m) != m->list_hdr || fm1c_list_tsk(m) != m->list_tsk)
                return 0;                       /* (the entries changed too: drawn at once) */
            if (top != m->list_top) {
                if (!FM1C_VSCROLL_HW) return 0;
                fm1c_tr_begin(m, FM1C_TR_WINDOW, t0);
                fm1c_tr.dir = top > m->list_top;
                return 1;
            }
            ro = fm1c_list_row(m, (uint32_t)s->sel);
            rn = fm1c_list_row(m, (uint32_t)sel);
            if (ro < 0 || rn < 0) return 0;
            fm1c_tr_begin(m, FM1C_TR_SEL_LIST, t0);
            fm1c_tr.a = (int16_t)((int32_t)fm1c_list_y(m) + 16 * ro);
            fm1c_tr.b = (int16_t)((int32_t)fm1c_list_y(m) + 16 * rn);
            {                                   /* grouped: a marked key's header row is not the slide's: after it */
                int32_t ho = fm1c_list_row_of(m, (uint32_t)s->sel, 1), hn = fm1c_list_row_of(m, (uint32_t)sel, 1);
                if (ho >= 0 && (m->dirty_keys >> s->sel & 1u)) m->dirty_lrows |= 1u << ho;
                if (hn >= 0 && (m->dirty_keys >> sel & 1u)) m->dirty_lrows |= 1u << hn;
            }
            m->dirty_keys &= ~(1u << s->sel | 1u << sel);   /* (their session rows: the slide's step 3) */
            return 1;
        }
        fm1c_tr_begin(m, FM1C_TR_SEL_BUDDY, t0);
        fm1c_tr.a = s->sel;
        fm1c_tr.b = (int16_t)sel;
        m->dirty_keys &= ~(1u << s->sel | 1u << sel);   /* (their boxes: the slide's step 3) */
        return 1;
    }
    if (base && sel == s->sel && (m->dstate != s->dstate || m->provider != s->provider)) {
        fm1c_tr_begin(m, FM1C_TR_HERO, t0);
        return 1;
    }
    if (m->view == FM1C_VIEW_VOICE && !fm1c_voice_live(m) && (m->dirty_rows & 0x3Eu)) {
        int fwd = s->vrow[6][0] && fm1c_str_eq(m->text[1], s->vrow[6]);
        int back = m->text[6][0] && fm1c_str_eq(s->vrow[1], m->text[6]);
        if (fwd || back) {
            fm1c_tr_begin(m, FM1C_TR_VOICE, t0);
            fm1c_tr.dir = (uint8_t)fwd;
            return 1;
        }
    }
    if (m->toast_on != s->toast) {
        fm1c_tr_begin(m, m->toast_on ? FM1C_TR_TOAST_IN : FM1C_TR_TOAST_OUT, t0);
        return 1;
    }
    if (!m->toast_on && m->knob_on != s->knob) {
        fm1c_tr_begin(m, m->knob_on ? FM1C_TR_KNOB_IN : FM1C_TR_KNOB_OUT, t0);
        return 1;
    }
    (void)k;
    return 0;
}

/* ---- one pass of the running transition: the next slice of the due step, when quiet; 1 while it runs */
static int fm1c_trans_run(fm1c_model *m, uint32_t now, int quiet)
{
    fm1c_trans *t = &fm1c_tr;
    const uint8_t *T = t->kind == FM1C_TR_READER_OPEN || t->kind == FM1C_TR_READER_CLOSE ? FM1C_TR_TR
                     : t->nsteps == 4u ? FM1C_TR_T4 : FM1C_TR_T3;
    fm1c_op o;
    uint32_t budget = FM1C_ANIM_PX_PASS;
    if (!t->kind) return 0;
    if (t->fin) {                               /* every step drawn: the rest waits for the end at t0 + 120 ms */
        if ((int32_t)(now - (t->t0 + FM1C_TR_END_MS)) < 0) return 1;
        fm1c_tr_end(m, 0);
        return 0;
    }
    if (!t->started) {
        uint32_t due = t->t0 + T[t->step];
        if ((int32_t)(now - due) < 0) return 1;
        if (now - due > FM1C_TR_LATE_MS) { fm1c_tr_end(m, 1); return 0; }
        if (!quiet) return 1;
        t->started = 1;
        t->op = 0;
        t->sub = 0;
#ifdef DINGHY_HOST
        t->step_px0 = host_px;
#endif
    }
    if (!quiet) return 1;
    fm1c_now = now;
    while (budget) {                            /* small ops share a pass; a slice of a big one fills it */
        int done;
#ifdef DINGHY_HOST
        uint64_t p0 = host_px;
#endif
        if (!fm1c_tr_op(m, t, t->step, t->op, &o)) {
#ifdef DINGHY_HOST
            if (host_px - t->step_px0 > t->px_max) t->px_max = (uint32_t)(host_px - t->step_px0);
#endif
            t->step++;
            t->started = 0;
            if (t->step >= t->nsteps) {         /* (the reader: its screen draws as usual from t0 + 110) */
                if (t->kind == FM1C_TR_READER_OPEN || t->kind == FM1C_TR_READER_CLOSE) { fm1c_tr_end(m, 0); return 0; }
                t->fin = 1;
            }
            return 1;
        }
        done = fm1c_tr_draw(m, t, &o, budget);
#ifdef DINGHY_HOST
        budget = host_px - p0 >= budget ? 0u : budget - (uint32_t)(host_px - p0);
#else
        (void)0;                                /* (the device does not count: a big op ends the pass, below) */
#endif
        if (done) t->op++;
        else break;
        if (o.kind != FM1C_OP_FRAME && o.kind != FM1C_OP_KEYFRAME && o.kind != FM1C_OP_OUTLINE && o.kind != FM1C_OP_VSTART)
            break;                              /* (one slice of new content a pass: the link's turn) */
    }
    return 1;
}
