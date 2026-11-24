/* SPDX-License-Identifier: GPL-3.0-only */
/* The console's screen (docs/firmware-ui.md), drawn region by region from fm1c_model's dirty bits with the
 * platform's canvas (gfx.c: cv_begin / cv_rect / cv_text / cv_blit). Included by console.c after platform.c.
 *
 *   y   0- 23  status bar: view title | page, link (a green dot when ok; LIMITED OFFLINE NO REPLY CONNECTING VERSION
 *               NO LINK), attention badge
 *   y  24-135  panel in four bands: head 24-39, label 40-71, lines 72-135 (4 x 16); version 2: line 4 is a hint bar
 *   y 136-199  key strip. Version 1: 27 cells, key 0 left. Version 2: the keyboard, 11 black keys above 16 white
 *   y 200-239  legend: four cells of 60 px; version 2: each knob's name above its label
 *   DETAILS (view 5, version 3; docs/ux-v2.md section 7.4): the status bar, then 12 SET_TEXT rows of 16 px from y 24
 *               (styles body white, heading amber, muted grey) and a hint band at 216-239; no panel, keys or legend
 *   NO COMPANION / UPDATE APP: everything dimmed to a quarter, a banner at (16, 80) 208 x 80 on top.
 * The words are docs/ux-v2.md section 1.2's in every version; the layout of section 2.4 needs version 2. */
#pragma once
#include "fm1c_model.h"

#define FM1C_C_OUTLINE RGB(48, 48, 48)
#define FM1C_C_BADGE RGB(48, 48, 48)
#define FM1C_C_TEXT2 RGB(192, 192, 192)
#define FM1C_C_GREY RGB(128, 128, 128)
#define FM1C_C_GREEN RGB(32, 192, 96)
#define FM1C_C_AMBER RGB(255, 176, 0)
#define FM1C_C_RED RGB(240, 48, 48)
#define FM1C_C_BLUE RGB(47, 125, 246)
#define FM1C_C_HINT_BG RGB(32, 32, 32)
#define FM1C_C_HINT RGB(160, 160, 160)
#define FM1C_C_KEY_EDGE RGB(48, 48, 48)
#define FM1C_C_MUTED RGB(160, 160, 160)
#define FM1C_C_CODE RGB(128, 208, 255)          /* version 7: inline code (docs/ui-v3.md section 13.5) */

static const uint16_t FM1C_STYLE_RGB[FM1C_N_STYLE] = {RGB(255, 255, 255), RGB(255, 176, 0), RGB(160, 160, 160)};
static const char FM1C_DETAIL_HINT[] = "PRESETS page  LFO close";   /* the DETAILS hint band's fixed words */

static const uint16_t FM1C_STATE_RGB[FM1C_N_STATE] = {
    RGB(0, 0, 0), RGB(32, 32, 32), RGB(96, 96, 96), RGB(47, 125, 246), RGB(160, 80, 240),
    RGB(255, 176, 0), RGB(32, 192, 96), RGB(42, 90, 58), RGB(240, 48, 48), RGB(64, 64, 64)};
static const char *const FM1C_STATE_NAME[FM1C_N_STATE] = {   /* (empty: no chip) */
    "", "OFFLINE", "IDLE", "WORKING", "NEEDS ANSWER", "NEEDS APPROVAL", "DONE, UNREAD", "DONE", "FAILED", "NO STATUS"};
static const char *const FM1C_PROVIDER_NAME[FM1C_N_PROVIDER] = {"", "CLAUDE", "CODEX", "OTHER"};   /* (none: no chip) */
static const char *const FM1C_VOICE_NAME[FM1C_N_VOICE] = {
    "READY", "RECORDING", "TRANSCRIBING", "READY TO SEND", "SENDING", "DELIVERED", "CANCELLED", "SEND FAILED",
    "TARGET GONE"};
static const uint16_t FM1C_VOICE_RGB[FM1C_N_VOICE] = {
    RGB(192, 192, 192), RGB(240, 48, 48), RGB(47, 125, 246), RGB(255, 176, 0), RGB(47, 125, 246),
    RGB(32, 192, 96), RGB(128, 128, 128), RGB(240, 48, 48), RGB(240, 48, 48)};
static const char *const FM1C_RESULT_NAME[FM1C_N_RESULT] = {   /* a toast whose text came empty */
    "OK", "Sent", "Received", "Done", "Failed", "Not supported", "Target gone"};
static const uint16_t FM1C_RESULT_RGB[FM1C_N_RESULT] = {
    RGB(128, 128, 128), RGB(47, 125, 246), RGB(47, 125, 246), RGB(32, 192, 96), RGB(240, 48, 48),
    RGB(255, 176, 0), RGB(240, 48, 48)};

static uint8_t fm1c_dim;                        /* set while a dimmed frame is drawn */

static uint16_t fm1c_c(uint16_t c)              /* a colour as drawn now: a quarter of it when dimmed */
{
    if (!fm1c_dim) return c;
    return (uint16_t)(((c >> 13) << 11) | (((c >> 7) & 15u) << 5) | ((c & 31u) >> 2));
}
static int fm1c_dark(uint16_t c) { return ((c >> 11) * 2u + ((c >> 5) & 63u) + (c & 31u) * 2u) < 140u; }   /* text in white on it */

static void fm1c_rect(int32_t x, int32_t y, int32_t w, int32_t h, uint16_t c) { cv_rect(x, y, w, h, fm1c_c(c)); }
static void fm1c_frame(int32_t x, int32_t y, int32_t w, int32_t h, int32_t t, uint16_t c)
{
    fm1c_rect(x, y, w, t, c);
    fm1c_rect(x, y + h - t, w, t, c);
    fm1c_rect(x, y, t, h, c);
    fm1c_rect(x + w - t, y, t, h, c);
}
static int32_t fm1c_text(int32_t x, int32_t y, const felucca_font_t *f, const char *s, uint16_t c)
{
    return cv_text(x, y, f, s, fm1c_c(c));
}
/* One SET_TEXT row (FONT_S) in the row colour c, with the version 7 control bytes (docs/ui-v3.md section 13.5):
 * 0x01 bold (white when the row's style is heading, else the heading amber), 0x02 code (FM1C_C_CODE), 0x03 back to
 * c, none taking a column; 0x04 one 8 px cell with a 1 px grey rule at x + 3, 16 px from y. At most max_cols visible
 * cells are drawn. Glyphs go out in runs of one colour (the pixels of fm1c_text, one ramp per run). Returns the x. */
static int32_t fm1c_rich(int32_t x, int32_t y, const char *s, uint32_t max_cols, uint16_t c, uint32_t style)
{
    char run[FM1C_L_TEXT + 1];
    uint32_t n = 0, cols = 0;
    uint16_t cur = c, bold = style == FM1C_TS_HEADING ? C_WHITE : FM1C_STYLE_RGB[FM1C_TS_HEADING];
    if (max_cols > FM1C_L_TEXT) max_cols = FM1C_L_TEXT;
    for (;; s++) {
        uint32_t b = (uint8_t)*s;
        int glyph = b >= 0x20u, vis = glyph || b == FM1C_TM_RULE;
        if (n && (!glyph || cols >= max_cols)) {   /* a mark, a rule, the cut or the end: the run so far */
            run[n] = 0;
            x = fm1c_text(x, y, &FONT_S, run, cur);
            n = 0;
        }
        if (!b || (vis && cols >= max_cols)) break;
        if (b == FM1C_TM_BOLD) cur = bold;
        else if (b == FM1C_TM_CODE) cur = FM1C_C_CODE;
        else if (b == FM1C_TM_OFF) cur = c;
        else if (b == FM1C_TM_RULE) { fm1c_rect(x + 3, y, 1, 16, FM1C_C_GREY); x += 8; cols++; }
        else if (glyph) { run[n++] = (char)b; cols++; }
    }
    return x;
}
static uint32_t fm1c_tst(const fm1c_model *m, uint32_t r) { return m->tstyle[r] < FM1C_N_STYLE ? m->tstyle[r] : FM1C_TS_BODY; }

/* a filled chip with its text (FONT_S); returns its width */
static int32_t fm1c_chip(int32_t x, int32_t y, const char *s, uint16_t bg)
{
    int32_t w = text_w(&FONT_S, s) + 8;
    fm1c_rect(x, y, w, 16, bg);
    fm1c_text(x + 4, y, &FONT_S, s, fm1c_dark(bg) ? C_WHITE : C_BLACK);
    return w;
}

static void fm1c_utoa(char *b, uint32_t v)
{
    char t[11];
    uint32_t n = 0, i;
    do { t[n++] = (char)('0' + v % 10u); v /= 10u; } while (v && n < 10u);
    for (i = 0; i < n; i++) b[i] = t[n - 1u - i];
    b[n] = 0;
}
static char *fm1c_cat(char *d, const char *s)
{
    while (*s) *d++ = *s++;
    *d = 0;
    return d;
}

/* ---- status bar */
/* the link indicator's words; "" when all is well (then a green dot) */
static void fm1c_link_label(const fm1c_model *m, const char **s, uint16_t *c)
{
    static const char *const LINK[FM1C_N_LINK] = {"", "LIMITED", "OFFLINE"};
    static const uint16_t LINK_C[FM1C_N_LINK] = {FM1C_C_GREEN, FM1C_C_AMBER, FM1C_C_RED};
    *c = FM1C_C_RED;
    if (m->conn == FM1C_C_NOHOST) *s = "NO LINK";
    else if (m->conn == FM1C_C_INCOMPAT) *s = "VERSION";
    else if (m->conn == FM1C_C_WAIT) { *s = "CONNECTING"; *c = FM1C_C_GREY; }
    else if (m->fault) *s = "NO REPLY";
    else { *s = LINK[m->link < FM1C_N_LINK ? m->link : 2u]; *c = LINK_C[m->link < FM1C_N_LINK ? m->link : 2u]; }
}

/* the bar h px high, its words at y ty (version 1-3: 24, 4; version 4: 18, 1) */
static void fm1c_draw_status_in(const fm1c_model *m, int32_t h, int32_t ty)
{
    char num[12], page[24], *p;
    const char *ls, *title = m->title;
    uint16_t lc, tc = C_WHITE;
    int32_t x = 236, w;
    if (m->link != FM1C_LINK_OK && m->status[0]) { title = m->status; tc = FM1C_C_AMBER; }   /* the backend's trouble first */
    else if (!title[0]) title = m->status[0] ? m->status : APP_NAME;
    cv_begin(240, (uint32_t)h, C_BLACK);
    fm1c_text(4, ty, &FONT_S, title, tc);
    fm1c_rect(0, h - 1, 240, 1, FM1C_C_OUTLINE);
    fm1c_link_label(m, &ls, &lc);
    if (m->attention && m->conn == FM1C_C_OK) {
        fm1c_utoa(num, m->attention > 99u ? 99u : m->attention);
        w = text_w(&FONT_S, num) + 8;
        x -= w;
        fm1c_rect(x - 4, 0, w + 8, h - 1, C_BLACK);   /* (cuts a long title) */
        fm1c_chip(x, ty, num, FM1C_C_AMBER);
        x -= 6;
    }
    if (ls[0]) {
        w = text_w(&FONT_S, ls);
        x -= w;
        fm1c_rect(x - 6, 0, w + 6, h - 1, C_BLACK);
        fm1c_text(x, ty, &FONT_S, ls, lc);
    } else {                                    /* ok: a 6 x 6 dot where the words were */
        x -= 6;
        fm1c_rect(x - 6, 0, 12, h - 1, C_BLACK);
        fm1c_rect(x, ty + 5, 6, 6, lc);
    }
    if (m->pages > 1u && m->conn == FM1C_C_OK && m->view != FM1C_VIEW_SETTINGS) {   /* (view 6: page, pages the cursor) */
        fm1c_utoa(page, m->page + 1u);
        p = fm1c_cat(page + fm1c_len(page), "/");
        fm1c_utoa(p, m->pages);
        w = text_w(&FONT_S, page);
        x -= w + 8;
        fm1c_rect(x - 6, 0, w + 14, h - 1, C_BLACK);
        fm1c_text(x, ty, &FONT_S, page, FM1C_C_GREY);
    }
    cv_blit(0, 0);
}
static void fm1c_draw_status(const fm1c_model *m) { fm1c_draw_status_in(m, 24, 4); }

/* ---- the panel, a band at a time */
static void fm1c_band_begin(uint32_t h) { cv_begin(240, h, C_BLACK); }

static void fm1c_big(const char *s, uint16_t c)   /* FONT_L if it fits in 232 px, else FONT_S */
{
    if (text_w(&FONT_L, s) <= 232) fm1c_text(4, 0, &FONT_L, s, c);
    else fm1c_text(4, 8, &FONT_S, s, c);
}

/* the COMMAND_RESULT toast filling a band h px high, its text at y (line 4: 16, 0; the DETAILS hint band: 24, 4) */
static void fm1c_toast_in(const fm1c_model *m, int32_t h, int32_t y)
{
    uint32_t r = m->toast_result < FM1C_N_RESULT ? m->toast_result : FM1C_R_FAILED;
    uint16_t bg = FM1C_RESULT_RGB[r];
    fm1c_rect(0, 0, 240, h, bg);
    fm1c_text(4, y, &FONT_S, m->toast[0] ? m->toast : FM1C_RESULT_NAME[r], fm1c_dark(bg) ? C_WHITE : C_BLACK);
}
static void fm1c_toast(const fm1c_model *m) { fm1c_toast_in(m, 16, 0); }

/* Version 2's hint bar (band 5): button names (tokens of capitals, digits, + / -) in white, the rest in grey. */
static int fm1c_hint_name(const char *t, uint32_t n)
{
    uint32_t i;
    if (n < 2u || !((t[0] >= 'A' && t[0] <= 'Z') || (t[0] >= '0' && t[0] <= '9'))) return 0;
    for (i = 1; i < n; i++) {
        char ch = t[i];
        if (!((ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '+' || ch == '/' || ch == '-')) return 0;
    }
    return 1;
}
/* a hint bar filling a band h px high, its words at y (line 4: 16, 0; the DETAILS hint band: 24, 4) */
static void fm1c_hint_in(const char *s, int32_t h, int32_t y)
{
    char tok[FM1C_L_TEXT + 1];
    int32_t x = 4;
    fm1c_rect(0, 0, 240, h, FM1C_C_HINT_BG);
    while (*s) {
        uint32_t n = 0;
        if (*s == ' ') { tok[0] = ' '; tok[1] = 0; x = fm1c_text(x, y, &FONT_S, tok, C_WHITE); s++; continue; }
        while (s[n] && s[n] != ' ' && n < FM1C_L_TEXT) { tok[n] = s[n]; n++; }
        tok[n] = 0;
        x = fm1c_text(x, y, &FONT_S, tok, fm1c_hint_name(tok, n) ? C_WHITE : FM1C_C_HINT);
        s += n;
    }
}
static void fm1c_hint(const char *s) { fm1c_hint_in(s, 16, 0); }

static void fm1c_draw_band(const fm1c_model *m, uint32_t band)   /* 0 head, 1 label, 2..5 lines */
{
    int32_t sel = fm1c_selected(m);
    uint32_t v = m->view;
    int v2 = fm1c_v2(m);
    char b[24], *p;
    fm1c_band_begin(band == 1u ? 32u : 16u);
    if (band == 5u && m->toast_on) {
        fm1c_toast(m);
    } else if (v == FM1C_VIEW_VOICE) {
        uint32_t vs = m->voice < FM1C_N_VOICE ? m->voice : FM1C_V_FAILED;
        int live = vs == FM1C_V_RECORDING || vs == FM1C_V_TRANSCRIBING;   /* (version 2: else the transcript) */
        if (band == 0u) fm1c_chip(4, 0, "VOICE", FM1C_C_BADGE);
        else if (band == 1u) fm1c_big(FM1C_VOICE_NAME[vs], FM1C_VOICE_RGB[vs]);
        else if (v2 && !live && band == 2u) fm1c_text(4, 0, &FONT_S, m->line[0], C_WHITE);
        else if (v2 && !live && band == 3u) fm1c_text(4, 0, &FONT_S, m->line[1], FM1C_C_TEXT2);
        else if (v2 && band == 5u) fm1c_hint(m->line[3]);
        else if (band == 2u) {
            uint32_t lv = v2 && vs == FM1C_V_TRANSCRIBING ? 0u : m->level > 100u ? 100u : m->level;
            uint16_t c = lv < 70u ? FM1C_C_GREEN : lv < 90u ? FM1C_C_AMBER : FM1C_C_RED;
            fm1c_frame(4, 2, 232, 12, 1, FM1C_C_GREY);
            fm1c_rect(5, 3, (int32_t)(lv * 230u / 100u), 10, c);
        } else if (band == 3u) {
            fm1c_utoa(b, m->elapsed_ds / 10u);
            p = fm1c_cat(b + fm1c_len(b), ".");
            p[0] = (char)('0' + m->elapsed_ds % 10u);
            p[1] = 0;
            fm1c_cat(p + 1, " s");
            fm1c_text(4, 0, &FONT_S, b, C_WHITE);
        } else if (band == 4u) {
            int32_t x = fm1c_text(4, 0, &FONT_S, "to ", FM1C_C_GREY);
            fm1c_text(x, 0, &FONT_S, m->target[0] ? m->target : "(no target)", m->target[0] ? C_WHITE : FM1C_C_GREY);
        }
    } else if (v == FM1C_VIEW_CONFIRM) {
        if (band == 0u) fm1c_chip(4, 0, "CONFIRM", FM1C_C_AMBER);
        else if (band == 1u) fm1c_big(m->line[0], C_WHITE);
        else if (band < 5u) fm1c_text(4, 0, &FONT_S, m->line[band - 1u], FM1C_C_TEXT2);
        else if (v2) fm1c_hint("SAVE yes   FX no");
        else fm1c_chip(4, 0, "SAVE yes   FX no", FM1C_C_BADGE);
    } else {                                    /* sessions, tasks, inbox */
        if (band == 0u) {
            uint32_t st = m->dstate < FM1C_N_STATE ? m->dstate : FM1C_S_UNKNOWN;
            const char *pv = FM1C_PROVIDER_NAME[m->provider < FM1C_N_PROVIDER ? m->provider : 3u];
            if (pv[0]) fm1c_chip(4, 0, pv, FM1C_C_BADGE);
            if (st != FM1C_S_EMPTY) {
                int32_t w = text_w(&FONT_S, FM1C_STATE_NAME[st]) + 8;
                fm1c_chip(236 - w, 0, FM1C_STATE_NAME[st], FM1C_STATE_RGB[st]);
            }
        } else if (band == 1u) {
            if (sel >= 0 && m->slot[sel].label[0]) fm1c_big(m->slot[sel].label, C_WHITE);
            else fm1c_text(4, 8, &FONT_S, sel >= 0 ? "(untitled)" : "nothing selected", FM1C_C_GREY);
        } else if (band == 5u && v2) {
            fm1c_hint(m->line[3]);
        } else {
            fm1c_text(4, 0, &FONT_S, m->line[band - 2u], band == 2u ? C_WHITE : FM1C_C_TEXT2);
        }
    }
    cv_blit(0, band == 0u ? 24u : band == 1u ? 40u : 72u + (band - 2u) * 16u);
}

/* ---- DETAILS (view 5): one text row (240 x 16 at y 24 + 16 r), the hint band (240 x 24 at y 216) */
#define FM1C_ROWS_Y 24u
#define FM1C_FOOT_Y 216u

static void fm1c_draw_row(const fm1c_model *m, uint32_t r)
{
    uint32_t st = fm1c_tst(m, r);
    cv_begin(240, 16, C_BLACK);
    fm1c_rich(4, 0, m->text[r], FM1C_L_TEXT, FM1C_STYLE_RGB[st], st);
    cv_blit(0, FM1C_ROWS_Y + 16u * r);
}

static void fm1c_draw_foot(const fm1c_model *m)
{
    cv_begin(240, 24, FM1C_C_HINT_BG);
    if (m->toast_on) fm1c_toast_in(m, 24, 4);
    else fm1c_hint_in(FM1C_DETAIL_HINT, 24, 4);
    cv_blit(0, FM1C_FOOT_Y);
}

/* ---- key strip (the boxes: fm1c_key_box in fm1c_model.h) */
#define FM1C_STRIP_Y 136u

/* one key into the canvas, whose top-left is at screen (ox, oy) */
static void fm1c_cell(const fm1c_model *m, uint32_t k, int32_t ox, int32_t oy)
{
    const fm1c_slot *s = &m->slot[k];
    uint32_t st = s->state < FM1C_N_STATE ? s->state : FM1C_S_UNKNOWN, sel = s->flags & FM1C_F_SELECTED;
    uint16_t c = FM1C_STATE_RGB[st];
    int32_t bx, by, bw, bh, x, y, w, h;
    fm1c_key_box(m, k, &bx, &by, &bw, &bh);
    bx -= ox; by -= oy;
    fm1c_rect(bx, by, bw, bh, C_BLACK);
    if (!fm1c_v2(m)) {                          /* version 1: an 8 x 64 cell, the fill 6 x 48 */
        x = bx + 1; y = by + 8; w = 6; h = 48;
        if (sel) { fm1c_rect(bx, by + 4, 8, 56, C_WHITE); x = bx + 2; y = by + 6; w = 4; h = 52; }
    } else if (fm1c_key_black(k)) {             /* box 12 x 30, fill 10 x 24 from (1, 4) */
        x = bx + 1; y = by + 4; w = 10; h = 24;
        if (sel) { fm1c_frame(bx, by + 2, 12, 28, 2, C_WHITE); x = bx + 2; w = 8; }
    } else {                                    /* box 14 x 34, fill 12 x 26 from (1, 4) */
        x = bx + 1; y = by + 4; w = 12; h = 26;
        if (sel) { fm1c_frame(bx, by + 2, 14, 30, 2, C_WHITE); x = bx + 2; w = 10; }
    }
    if (st == FM1C_S_EMPTY) {
        fm1c_rect(x, y, w, h, C_BLACK);
        if (!sel) fm1c_frame(x, y, w, h, 1, FM1C_C_OUTLINE);
    } else {
        fm1c_rect(x, y, w, h, c);
        if (fm1c_v2(m) && (s->flags & FM1C_F_PINNED))   /* pinned: the top 4 rows of the fill */
            fm1c_rect(x, y, w, 4, fm1c_dark(c) ? C_WHITE : C_BLACK);
    }
    if (s->flags & FM1C_F_STALE) {              /* crossed: identity no longer resolves */
        uint16_t xc = fm1c_dark(c) ? C_WHITE : C_BLACK;
        cv_line(x, y, x + w - 1, y + h - 1, fm1c_c(xc));
        cv_line(x + w - 1, y, x, y + h - 1, fm1c_c(xc));
    }
}

static void fm1c_draw_strip(const fm1c_model *m)
{
    uint32_t k;
    cv_begin(240, 64, C_BLACK);
    for (k = 0; k < FM1C_NSLOT; k++) fm1c_cell(m, k, 0, (int32_t)FM1C_STRIP_Y);
    cv_blit(0, FM1C_STRIP_Y);
}

static void fm1c_draw_key(const fm1c_model *m, uint32_t k)   /* one key's box alone */
{
    int32_t x, y, w, h;
    fm1c_key_box(m, k, &x, &y, &w, &h);
    cv_begin((uint32_t)w, (uint32_t)h, C_BLACK);
    fm1c_cell(m, k, x, y);
    cv_blit((uint32_t)x, (uint32_t)y);
}

/* ---- legend */
static void fm1c_draw_legend(const fm1c_model *m)
{
    uint32_t i;
    cv_begin(240, 40, C_BLACK);
    fm1c_rect(0, 0, 240, 1, FM1C_C_OUTLINE);
    for (i = 0; i < 4u; i++) {
        int32_t x = (int32_t)i * 60;
        if (i) fm1c_rect(x, 1, 1, 39, FM1C_C_OUTLINE);
        if (fm1c_v2(m)) {                       /* the knob it belongs to above its label; an empty cell: nothing */
            static const char *const TAG[4] = {"KNOB1", "KNOB2", "KNOB3", "KNOB4"};
            if (!m->legend[i][0]) continue;
            fm1c_text(x + (60 - text_w(&FONT_S, TAG[i])) / 2, 2, &FONT_S, TAG[i], FM1C_C_GREY);
            fm1c_text(x + (60 - text_w(&FONT_S, m->legend[i])) / 2, 20, &FONT_S, m->legend[i], C_WHITE);
        } else {
            fm1c_text(x + (60 - text_w(&FONT_S, m->legend[i])) / 2, 12, &FONT_S, m->legend[i], C_WHITE);
        }
    }
    cv_blit(0, 200);
}

/* ---- the banner (never dimmed) */
static void fm1c_draw_banner(const fm1c_model *m)
{
    const char *big = "NO COMPANION", *small = "start fm1-console on Mac";
    uint8_t d = fm1c_dim;
    fm1c_dim = 0;
    if (m->conn == FM1C_C_INCOMPAT) {
        big = fm1c_has(m->reason, "old") ? "UPDATE APP" : fm1c_has(m->reason, "new") ? "OLD FIRMWARE" : "INCOMPATIBLE";
        small = m->reason[0] ? m->reason : "no common version";
    }
    cv_begin(208, 80, RGB(16, 16, 16));
    fm1c_frame(0, 0, 208, 80, 2, m->conn == FM1C_C_INCOMPAT ? FM1C_C_RED : C_WHITE);
    fm1c_text((208 - text_w(&FONT_L, big)) / 2, 12, &FONT_L, big, C_WHITE);
    fm1c_text((208 - text_w(&FONT_S, small)) / 2, 52, &FONT_S, small, FM1C_C_TEXT2);
    cv_blit(16, 80);
    fm1c_dim = d;
}

#include "fm1c_help.h"
#include "fm1c_draw4.h"

/* Draws what changed; returns the regions drawn (the tests count them). keys_drawn: cells redrawn alone; in DETAILS
 * the text rows drawn instead. Under the help overlay only the status bar and the legend (DETAILS: the hint band) are
 * drawn; the rest waits, still marked, for it to close. In DETAILS the panel, strip and legend marks are dropped
 * undrawn: leaving the view redraws everything. */
static uint32_t fm1c_draw(fm1c_model *m, uint32_t *keys_drawn)
{
    uint32_t d, keys, rows, b, k, drawn = 0;
    int detail = fm1c_detail(m);
    if (fm1c_v4(m)) return fm1c_draw4(m, keys_drawn);   /* docs/ui-v3.md: the characters */
    m->dirty &= ~FM1C_D_V4;                     /* (version 1-3: no such regions) */
    m->dirty_bars = 0;
    m->dirty_lrows = 0;
    d = m->dirty;
    keys = m->dirty_keys;
    rows = m->dirty_rows;
    *keys_drawn = 0;
    if (m->help) {
        d &= FM1C_D_STATUS | FM1C_D_HELP | (detail ? FM1C_D_FOOT : FM1C_D_LEGEND);
        m->dirty &= ~d;
        if (d & FM1C_D_STATUS) fm1c_draw_status(m);
        if (d & FM1C_D_HELP) fm1c_draw_help(m);
        if (d & FM1C_D_LEGEND) fm1c_draw_legend(m);
        if (d & FM1C_D_FOOT) fm1c_draw_foot(m);
        return d;
    }
    d &= ~FM1C_D_HELP;
    m->dirty = 0;
    m->dirty_keys = 0;
    m->dirty_rows = 0;
    fm1c_dim = (uint8_t)fm1c_dimmed(m);
    if (detail) {
        d &= FM1C_D_STATUS | FM1C_D_FOOT | FM1C_D_BANNER;
        if (d & FM1C_D_STATUS) fm1c_draw_status(m);
        for (k = 0; k < FM1C_TEXT_ROWS; k++)
            if (rows >> k & 1u) { fm1c_draw_row(m, k); *keys_drawn |= 1u << k; }
        if (d & FM1C_D_FOOT) fm1c_draw_foot(m);
        drawn = d & ~FM1C_D_BANNER;
        if (fm1c_dim && (d || rows)) { fm1c_draw_banner(m); drawn |= FM1C_D_BANNER; }
        fm1c_dim = 0;
        return drawn;
    }
    d &= ~FM1C_D_FOOT;
    if (d & FM1C_D_STATUS) fm1c_draw_status(m);
    for (b = 0; b < 6u; b++)
        if (d & (FM1C_D_HEAD << b)) fm1c_draw_band(m, b);
    if (d & FM1C_D_STRIP) fm1c_draw_strip(m);
    else
        for (k = 0; k < FM1C_NSLOT; k++)
            if (keys >> k & 1u) { fm1c_draw_key(m, k); *keys_drawn |= 1u << k; }
    if (d & FM1C_D_LEGEND) fm1c_draw_legend(m);
    drawn = d & ~FM1C_D_BANNER;
    if (fm1c_dim && (d || keys)) {              /* anything under it was drawn: the banner again on top */
        fm1c_draw_banner(m);
        drawn |= FM1C_D_BANNER;
    }
    fm1c_dim = 0;
    return drawn;
}
