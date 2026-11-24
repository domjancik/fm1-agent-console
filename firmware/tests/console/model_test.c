/* SPDX-License-Identifier: GPL-3.0-only */
/* What the model marks for redraw (firmware/src/fm1c_model.h): only the regions a change touches, nothing for a
 * repeat (a resync or a retransmission), the whole screen when the host comes or goes. */
#include "t.h"
#include "fm1c_model.h"

static fm1c_msg mk(uint32_t type)
{
    fm1c_msg m;
    memset(&m, 0, sizeof m);
    m.type = (uint8_t)type;
    return m;
}
static void apply(fm1c_model *m, const fm1c_msg *x) { fm1c_model_apply(m, x, 1000); }
static void clean(fm1c_model *m) { m->dirty = 0; m->dirty_keys = 0; }

static int disjoint(int32_t ax, int32_t ay, int32_t aw, int32_t ah, int32_t bx, int32_t by, int32_t bw, int32_t bh)
{
    return ax + aw <= bx || bx + bw <= ax || ay + ah <= by || by + bh <= ay;
}

/* docs/ux-v2.md sections 2.4 and 2.5: the keyboard boxes, one key's redraw, the pinned flag, the help overlay */
/* docs/ux-v2.md section 7.4: the DETAILS page (view 5, version 3) */
static fm1c_msg text(uint32_t row, uint32_t count, uint32_t style, const char *t)
{
    fm1c_msg x = mk(FM1C_T_SET_TEXT);
    uint32_t i;
    x.u.text.row = (uint8_t)row;
    x.u.text.count = (uint8_t)count;
    for (i = 0; i < count; i++) { x.u.text.style[i] = (uint8_t)style; strcpy(x.u.text.text[i], t); }
    return x;
}
static fm1c_msg view(uint32_t v, uint32_t page)
{
    fm1c_msg x = mk(FM1C_T_SET_VIEW);
    x.u.view.view = (uint8_t)v;
    x.u.view.page = (uint8_t)page;
    x.u.view.pages = 3;
    strcpy(x.u.view.title, "DETAILS x");
    return x;
}
static void details(fm1c_model *m)
{
    fm1c_msg x;
    fm1c_model_init(m);
    fm1c_model_conn(m, FM1C_C_OK, 0);
    fm1c_model_proto(m, 3);
    CHECK(fm1c_v2(m) && m->dirty_rows == FM1C_ROWS_ALL, "version 3 includes version 2; all rows marked");
    clean(m);
    m->dirty_rows = 0;
    x = text(3, 3, FM1C_TS_MUTED, "Task: x");
    apply(m, &x);
    CHECK(m->dirty == 0 && m->dirty_rows == (7u << 3) && m->tstyle[4] == FM1C_TS_MUTED && !strcmp(m->text[5], "Task: x"),
          "SET_TEXT in the sessions view: stored, rows 3-5 marked, no region");
    m->dirty_rows = 0;
    apply(m, &x);
    CHECK(m->dirty_rows == 0, "the same rows again: nothing");
    x = text(4, 1, FM1C_TS_BODY, "Task: x");
    apply(m, &x);
    CHECK(m->dirty_rows == (1u << 4), "only the style changed: that row");
    m->dirty_rows = 0;
    x = view(FM1C_VIEW_DETAIL, 0);
    apply(m, &x);
    CHECK(m->dirty == FM1C_D_ALL && m->dirty_keys == FM1C_KEYS_ALL && m->dirty_rows == FM1C_ROWS_ALL && fm1c_detail(m),
          "into DETAILS: everything");
    clean(m);
    m->dirty_rows = 0;
    x = view(FM1C_VIEW_DETAIL, 1);
    apply(m, &x);
    CHECK(m->dirty == FM1C_D_STATUS && m->dirty_rows == 0, "another page: the status bar (its rows come as SET_TEXT)");
    clean(m);
    x = mk(FM1C_T_CMD_RESULT);
    x.u.result.result = FM1C_R_FAILED;
    fm1c_model_apply(m, &x, 5000);
    CHECK(m->dirty == FM1C_D_FOOT, "a toast in DETAILS: the hint band");
    clean(m);
    fm1c_model_tick(m, 9000);
    CHECK(m->dirty == FM1C_D_FOOT && !m->toast_on, "toast over (4 s, failed): the hint band again");
    clean(m);
    fm1c_model_help(m, 1);
    CHECK(m->dirty == FM1C_D_HELP, "help in DETAILS");
    fm1c_model_help(m, 0);
    CHECK(m->dirty == FM1C_D_ALL && m->dirty_rows == FM1C_ROWS_ALL, "help closed: every region and row");
    clean(m);
    m->dirty_rows = 0;
    x = view(FM1C_VIEW_SESSIONS, 0);
    apply(m, &x);
    CHECK(m->dirty == FM1C_D_ALL && m->dirty_keys == FM1C_KEYS_ALL, "out of DETAILS: everything");
    fm1c_model_clear(m);
    CHECK(!m->text[5][0] && m->tstyle[4] == FM1C_TS_BODY && m->dirty_rows == FM1C_ROWS_ALL, "a new host session: rows empty body");
}

static void version2(fm1c_model *m)
{
    fm1c_msg x;
    int32_t bx[FM1C_NSLOT], by[FM1C_NSLOT], bw[FM1C_NSLOT], bh[FM1C_NSLOT], a = 0;
    uint32_t k, j, bad = 0, whites = 0, area = 0;
    fm1c_model_init(m);
    fm1c_model_conn(m, FM1C_C_OK, 0);
    fm1c_model_proto(m, 1);
    clean(m);
    fm1c_key_box(m, 0, &bx[0], &by[0], &bw[0], &bh[0]);
    fm1c_key_box(m, 26, &bx[1], &by[1], &bw[1], &bh[1]);
    CHECK(bx[0] == 8 && by[0] == 136 && bw[0] == 8 && bh[0] == 64 && bx[1] == 224 && bw[1] * bh[1] == 512,
          "version 1: the old 8 x 64 cells in groups of 9 (%d,%d %dx%d; %d)", bx[0], by[0], bw[0], bh[0], bx[1]);
    fm1c_model_proto(m, 2);
    CHECK(m->dirty == FM1C_D_ALL && m->dirty_keys == FM1C_KEYS_ALL && fm1c_v2(m), "version 2 agreed: everything again");
    clean(m);
    fm1c_model_proto(m, 2);
    CHECK(m->dirty == 0, "the same version again: nothing");
    for (k = 0; k < FM1C_NSLOT; k++) fm1c_key_box(m, k, &bx[k], &by[k], &bw[k], &bh[k]);
    CHECK(bx[0] == 8 && by[0] == 166 && bw[0] == 14 && bh[0] == 34, "key 0 (F3): white box x 8, rows 166-199, 14 x 34");
    CHECK(bx[1] == 16 && by[1] == 136 && bw[1] == 12 && bh[1] == 30, "key 1 (F#3): black box centred on x 22, rows 136-165");
    CHECK(bx[26] == 218 && by[26] == 166 && bw[26] == 14 && bh[26] == 34, "key 26 (G5): white key 15 at x 218");
    CHECK(bx[25] == 8 + 14 * 15 - 6 && by[25] == 136, "key 25 (F#5): over the boundary after white key 14");
    for (k = 0; k < FM1C_NSLOT; k++) {
        whites += !fm1c_key_black(k);
        area += (uint32_t)(bw[k] * bh[k]);
        if (bx[k] < 0 || bx[k] + bw[k] > 240 || by[k] < 136 || by[k] + bh[k] > 200) bad++;
        for (j = k + 1; j < FM1C_NSLOT; j++)
            if (!disjoint(bx[k], by[k], bw[k], bh[k], bx[j], by[j], bw[j], bh[j])) bad++;
    }
    CHECK(bad == 0 && whites == 16 && area == 16u * 476u + 11u * 360u,
          "all 27 boxes inside rows 136-199 and disjoint; 16 white, 11 black (%u overlaps)", bad);

    x = mk(FM1C_T_SET_SLOT);
    x.u.slot.key = 7;
    x.u.slot.state = FM1C_S_FAILED;
    strcpy(x.u.slot.label, "ci");
    apply(m, &x);
    CHECK(m->dirty_keys == 1u << 7 && m->dirty == 0, "version 2: a slot change dirties that key only");
    clean(m);
    x.u.slot.flags = FM1C_F_PINNED;
    apply(m, &x);
    CHECK(m->dirty_keys == 1u << 7 && m->dirty == 0, "pinning dirties the key");
    clean(m);
    apply(m, &x);
    CHECK(m->dirty_keys == 0, "the same pin again: nothing");
    x.u.slot.flags = 0;
    apply(m, &x);
    CHECK(m->dirty_keys == 1u << 7, "unpinning dirties the key");
    clean(m);

    x = mk(FM1C_T_SET_VIEW);
    x.u.view.view = FM1C_VIEW_VOICE;
    x.u.view.pages = 1;
    apply(m, &x);
    clean(m);
    x = mk(FM1C_T_SET_DETAIL);
    strcpy(x.u.detail.line[0], "run the tests");
    strcpy(x.u.detail.line[2], "ignored");
    strcpy(x.u.detail.line[3], "SAVE send  FX cancel");
    apply(m, &x);
    CHECK(m->dirty == (FM1C_D_LINE(0) | FM1C_D_LINE(3)), "version 2 voice view: transcript and hint lines drawn (%x)", m->dirty);
    clean(m);
    x = mk(FM1C_T_SET_VOICE);
    x.u.voice.voice = FM1C_V_REVIEWING;
    apply(m, &x);
    CHECK(m->dirty == (FM1C_D_HEAD | FM1C_D_LABEL | FM1C_D_LINE(0) | FM1C_D_LINE(1)),
          "version 2 voice state: the word and lines 1-2 (bar or transcript) (%x)", m->dirty);
    clean(m);

    fm1c_model_help(m, 1);
    CHECK(m->help && m->dirty == FM1C_D_HELP && m->dirty_keys == 0, "help up: the overlay only");
    clean(m);
    x = mk(FM1C_T_SET_LEGEND);
    strcpy(x.u.legend.label[3], "TALK");
    apply(m, &x);
    CHECK(m->dirty == FM1C_D_LEGEND, "host frames still update the model under the help");
    clean(m);
    fm1c_model_help(m, 0);
    CHECK(!m->help && m->dirty == FM1C_D_ALL && m->dirty_keys == FM1C_KEYS_ALL, "help closed: every region dirty");
    clean(m);
    fm1c_model_help(m, 1);
    fm1c_model_proto(m, 1);
    CHECK(!m->help && m->dirty == FM1C_D_ALL, "version 1 (an old companion): the help closes, all redrawn");
    a = fm1c_v2(m);
    CHECK(!a, "version 1 draws the old layout");
}

/* docs/ui-v3.md sections 3.A, 5 and 6.5: version 4, the characters. The same frames, marked for the new regions. */
static void version4(fm1c_model *m)
{
    int32_t bx[FM1C_NSLOT], by[FM1C_NSLOT], bw[FM1C_NSLOT], bh[FM1C_NSLOT];
    uint32_t k, j, ok;
    fm1c_msg x;
    fm1c_model_init(m);
    fm1c_model_conn(m, FM1C_C_OK, 0);
    fm1c_model_proto(m, 4);
    CHECK(fm1c_v4(m) && fm1c_v2(m) && m->dirty == FM1C_D_ALL && (m->dirty & FM1C_D_V4) == FM1C_D_V4 &&
          m->dirty_bars == FM1C_BARS_ALL, "version 4 agreed: every region, the version 4 ones too");
    clean(m);
    m->dirty_rows = m->dirty_bars = 0;
    /* the keyboard: 14 x 14 mini boxes, white keys at y 202 (x 8 + 14 w), black at y 184 over the boundary */
    for (k = 0; k < FM1C_NSLOT; k++) fm1c_key_box(m, k, &bx[k], &by[k], &bw[k], &bh[k]);
    CHECK(bx[0] == 8 && by[0] == 202 && bw[0] == 14 && bh[0] == 14, "key 0 (F3): (8, 202) 14 x 14");
    CHECK(bx[1] == 15 && by[1] == 184 && bw[1] == 14 && bh[1] == 14, "key 1 (F#3): (15, 184) 14 x 14");
    CHECK(bx[26] == 218 && by[26] == 202, "key 26 (G5): (218, 202)");
    for (ok = 1, k = 0; k < FM1C_NSLOT; k++) {
        if (bx[k] < 0 || bx[k] + bw[k] > 240 || by[k] < 184 || by[k] + bh[k] > 224) ok = 0;
        for (j = k + 1; j < FM1C_NSLOT; j++)
            if (!disjoint(bx[k], by[k], bw[k], bh[k], bx[j], by[j], bw[j], bh[j])) ok = 0;
    }
    CHECK(ok, "the 27 boxes are disjoint and inside the keyboard band (y 184-223)");
    /* a slot: its box only; selecting it: the label beside the hero and the caption (the key name) */
    x = mk(FM1C_T_SET_SLOT);
    x.u.slot.key = 3;
    x.u.slot.state = FM1C_S_DONE_UNREAD;
    strcpy(x.u.slot.label, "voice tests");
    apply(m, &x);
    CHECK(m->dirty_keys == 1u << 3 && m->dirty == 0 && m->dirty_rows == 0, "one SET_SLOT: its box only");
    clean(m);
    x.u.slot.flags = FM1C_F_SELECTED;
    apply(m, &x);
    CHECK(m->dirty_keys == 1u << 3 && m->dirty == FM1C_D_LABEL4 && m->dirty_rows == 1u, "selected: its box, the label, the caption");
    clean(m);
    m->dirty_rows = 0;
    /* the bubble: SET_TEXT rows 0-6 in a base view, a changed row alone, a repeat nothing */
    x = text(0, 3, FM1C_TS_BODY, "Done, unread, 2m");
    apply(m, &x);
    CHECK(m->dirty_rows == 0x7u && m->dirty == 0, "SET_TEXT rows 0-2 in sessions: those rows");
    m->dirty_rows = 0;
    apply(m, &x);
    CHECK(m->dirty_rows == 0 && m->dirty == 0, "the same rows again: nothing");
    x = text(3, 3, FM1C_TS_BODY, "");
    strcpy(x.u.text.text[0], "ACK marked a cancelled send");
    apply(m, &x);
    CHECK(m->dirty_rows == 1u << 3, "one changed row of three: that row (%x)", m->dirty_rows);
    m->dirty_rows = 0;
    x = text(6, 1, FM1C_TS_BODY, "tests for it. Nothing else");
    apply(m, &x);
    CHECK(m->dirty_rows == 1u << 6, "row 6 becomes non-empty: row 6 (the more wedge)");
    m->dirty_rows = 0;
    /* SET_DETAIL: the state marks the hero, the bubble's colour and the caption; line 1 the label; line 4 the hint */
    x = mk(FM1C_T_SET_DETAIL);
    x.u.detail.provider = 1;
    x.u.detail.state = FM1C_S_DONE_UNREAD;
    apply(m, &x);
    CHECK(m->dirty == (FM1C_D_HERO | FM1C_D_BUBBLE) && m->dirty_rows == 1u, "SET_DETAIL state: hero, bubble frame, caption");
    clean(m);
    m->dirty_rows = 0;
    strcpy(x.u.detail.line[0], "for the push-to-talk");
    strcpy(x.u.detail.line[3], "REC reply  PLAY open");
    apply(m, &x);
    CHECK(m->dirty == (FM1C_D_LABEL4 | FM1C_D_HINT4) && m->dirty_rows == 0, "line 1: the label region; line 4: the hint bar");
    clean(m);
    apply(m, &x);
    CHECK(m->dirty == 0 && m->dirty_rows == 0, "SET_DETAIL repeated: nothing");
    /* the knob row: 2 s after a K1-K4 turn, then gone; SELECT / ALGORITHM / PRESETS are not knobs */
    fm1c_model_knob(m, 0, 1000);
    fm1c_model_knob(m, 6, 1000);
    CHECK(m->dirty == 0 && !m->knob_on, "SELECT and PRESETS turns: no knob row");
    fm1c_model_knob(m, 3, 1000);
    CHECK(m->dirty == FM1C_D_HINT4 && m->knob_on && m->knob_lit == 1, "K2 turned: the knob row, K2 lit");
    clean(m);
    fm1c_model_tick(m, 2999);
    CHECK(m->dirty == 0 && m->knob_on, "still up at 1,999 ms");
    fm1c_model_tick(m, 3000);
    CHECK(m->dirty == FM1C_D_HINT4 && !m->knob_on, "gone at 2,000 ms: the hint bar again");
    clean(m);
    /* the toast: the hint bar in every view */
    x = mk(FM1C_T_CMD_RESULT);
    x.u.result.result = FM1C_R_COMPLETED;
    fm1c_model_apply(m, &x, 5000);
    CHECK(m->dirty == FM1C_D_HINT4 && m->toast_on, "COMMAND_RESULT: the hint bar");
    clean(m);
    fm1c_model_tick(m, 7500);
    CHECK(m->dirty == FM1C_D_HINT4 && !m->toast_on, "toast gone: the hint bar");
    clean(m);
    /* no legend in version 4 */
    x = mk(FM1C_T_SET_LEGEND);
    strcpy(x.u.legend.label[0], "SHOW");
    apply(m, &x);
    CHECK(m->dirty == 0 && !strcmp(m->legend[0], "SHOW"), "SET_LEGEND: kept for the knob row and the help, nothing drawn");
    /* voice: a meter bar per elapsed step */
    x = view(FM1C_VIEW_VOICE, 0);
    apply(m, &x);
    CHECK((m->dirty & (FM1C_D_HERO | FM1C_D_LABEL4 | FM1C_D_BUBBLE | FM1C_D_HINT4)) ==
          (FM1C_D_HERO | FM1C_D_LABEL4 | FM1C_D_BUBBLE | FM1C_D_HINT4) && !(m->dirty & FM1C_D_KBD),
          "to the voice view: everything but the keyboard");
    clean(m);
    m->dirty_rows = m->dirty_bars = 0;
    x = mk(FM1C_T_SET_VOICE);
    x.u.voice.voice = FM1C_V_RECORDING;
    x.u.voice.level = 60;
    x.u.voice.elapsed_ds = 1;
    apply(m, &x);
    CHECK(m->bar[0] == 60 && m->bar_n == 1 && (m->dirty & FM1C_D_BUBBLE) && (m->dirty & FM1C_D_ELAPSED),
          "recording starts: the bubble turns into the meter, bar 0 = 60");
    clean(m);
    m->dirty_rows = m->dirty_bars = 0;
    x.u.voice.level = 85;
    x.u.voice.elapsed_ds = 2;
    apply(m, &x);
    CHECK(m->dirty == FM1C_D_ELAPSED && m->dirty_bars == 0x6u && m->bar[1] == 85, "an elapsed step: the time, bar 1 and the gap after it");
    clean(m);
    m->dirty_bars = 0;
    apply(m, &x);
    CHECK(m->dirty == 0 && m->dirty_bars == 0, "the same SET_VOICE again: nothing");
    /* the layout survives the host: lost, the dimmed screen keeps version 4; a version 3 companion: version 3 */
    fm1c_model_conn(m, FM1C_C_NOHOST, 0);
    fm1c_model_proto(m, 0);
    CHECK(fm1c_v4(m) && m->proto == 0 && fm1c_dimmed(m), "host lost: dimmed, still the version 4 layout");
    fm1c_model_clear(m);
    CHECK(m->look == 4, "a new companion run: the content cleared, the layout kept");
    fm1c_model_proto(m, 3);
    CHECK(!fm1c_v4(m) && fm1c_v2(m) && m->look == 3, "a version 3 companion: the version 3 layout");
    fm1c_model_knob(m, 2, 9000);
    CHECK(!m->knob_on, "version 3: no knob row");
    for (k = 0; k < FM1C_NSLOT; k++) fm1c_key_box(m, k, &bx[k], &by[k], &bw[k], &bh[k]);
    CHECK(bx[0] == 8 && by[0] == 166 && bw[0] == 14 && bh[0] == 34 && by[1] == 136 && bw[1] == 12,
          "version 3: today's keyboard boxes");
}

/* docs/ui-v3.md section 8: version 5, the LIST layout (SET_VIEW.layout, SET_SLOT.title / age) */
static fm1c_msg slot5(uint32_t k, uint32_t state, uint32_t flags, const char *title, const char *age)
{
    fm1c_msg x = mk(FM1C_T_SET_SLOT);
    x.u.slot.key = (uint8_t)k;
    x.u.slot.state = (uint8_t)state;
    x.u.slot.flags = (uint8_t)flags;
    strcpy(x.u.slot.label, "lbl");
    strcpy(x.u.slot.title, title);
    strcpy(x.u.slot.age, age);
    x.u.slot.v5 = 1;
    return x;
}
static fm1c_msg view5(uint32_t v, uint32_t layout)
{
    fm1c_msg x = view(v, 0);
    strcpy(x.u.view.title, "ACTIVE 14");
    x.u.view.layout = (uint8_t)layout;
    x.u.view.v5 = 1;
    return x;
}
static void clean5(fm1c_model *m) { m->dirty = 0; m->dirty_keys = 0; m->dirty_rows = 0; m->dirty_bars = 0; m->dirty_lrows = 0; }
static void version5(fm1c_model *m)
{
    fm1c_msg x;
    uint32_t k, top, i;
    int32_t s;
    fm1c_model_init(m);
    fm1c_model_conn(m, FM1C_C_OK, 0);
    fm1c_model_proto(m, 5);
    CHECK(fm1c_v4(m) && m->look == 5 && !fm1c_list(m), "version 5 agreed: the version 4 rules, buddy until a layout says list");
    for (k = 0; k < 14u; k++) { x = slot5(k, FM1C_S_IDLE, k == 11u ? FM1C_F_SELECTED : 0u, "a title", "2m"); apply(m, &x); }
    x = view5(FM1C_VIEW_SESSIONS, FM1C_LAYOUT_BUDDY);
    apply(m, &x);
    clean5(m);
    x = slot5(5, FM1C_S_IDLE, 0, "another title", "3m");
    apply(m, &x);
    CHECK(m->dirty == 0 && m->dirty_keys == 0 && !strcmp(m->slot[5].title, "another title") && !strcmp(m->slot[5].age, "3m"),
          "buddy: a change of only title or age is stored and marks nothing");
    /* the toggle: SET_VIEW with layout list marks every band; the selection, order and page stay */
    x = view5(FM1C_VIEW_SESSIONS, FM1C_LAYOUT_LIST);
    apply(m, &x);
    CHECK(fm1c_list(m) && (m->dirty & FM1C_D_LIST) && (m->dirty & FM1C_D_HERO) && (m->dirty & FM1C_D_BUBBLE) &&
          (m->dirty & FM1C_D_HINT4) && m->dirty_rows == FM1C_ROWS_ALL, "layout list: every band from row 18");
    CHECK(fm1c_selected(m) == 11 && m->page == 0, "the toggle keeps the selection and the page");
    CHECK(fm1c_list_win(m, &top, &s) == 14u && s == 11 && top == 10u, "14 entries, the 12th selected: the window starts at 10");
    fm1c_list_drawn(m);                         /* (as fm1c_draw4 does once it drew the list) */
    CHECK(fm1c_list_row(m, 11) == 1 && fm1c_list_row(m, 9) == -1 && fm1c_list_key(m, 0) == 10 && fm1c_list_key(m, 3) == 13 &&
          fm1c_list_key(m, 4) == -1, "rows follow the keys: row 0 = key 10, key 9 outside the window, row 4 empty");
    clean5(m);
    x = slot5(12, FM1C_S_WORKING, 0, "a title", "2m");
    apply(m, &x);
    fm1c_list_check(m);
    CHECK(m->dirty == 0 && m->dirty_keys == 1u << 12, "list: a state change marks its key's row only");
    clean5(m);
    x = slot5(12, FM1C_S_WORKING, 0, "a title", "now");
    apply(m, &x);
    CHECK(m->dirty == 0 && m->dirty_keys == 1u << 12, "list: an age change marks its row");
    clean5(m);
    apply(m, &x);
    CHECK(m->dirty == 0 && m->dirty_keys == 0, "list: the same SET_SLOT again marks nothing");
    x = slot5(11, FM1C_S_IDLE, 0, "a title", "2m");   /* the selection moves inside the window: old row, new row */
    apply(m, &x);
    x = slot5(12, FM1C_S_WORKING, FM1C_F_SELECTED, "a title", "now");
    apply(m, &x);
    fm1c_list_check(m);
    CHECK((m->dirty_keys & ((1u << 11) | (1u << 12))) == ((1u << 11) | (1u << 12)) && (m->dirty_rows & 1u) &&
          !(m->dirty & FM1C_D_LIST) && fm1c_list_row(m, 12) == 2,
          "a selection change inside the window (deselect, select): the two rows, the caption's key name, not the list");
    clean5(m);
    x = slot5(12, FM1C_S_WORKING, 0, "a title", "now");
    apply(m, &x);
    x = slot5(3, FM1C_S_IDLE, FM1C_F_SELECTED, "a title", "2m");   /* the window moves: everything in the list */
    apply(m, &x);
    fm1c_list_check(m);
    CHECK((m->dirty & FM1C_D_LIST) && fm1c_list_win(m, &top, &s) == 14u && top == 0u, "a selection that moves the window: every row");
    fm1c_list_drawn(m);
    clean5(m);
    x = slot5(20, FM1C_S_FAILED, 0, "new one", "now");
    apply(m, &x);
    fm1c_list_check(m);
    CHECK((m->dirty & FM1C_D_LIST) && fm1c_list_win(m, &top, &s) == 15u, "a slot becomes occupied: every row and the scroll column");
    fm1c_list_drawn(m);
    clean5(m);
    x = text(1, 2, 0, "the message line at 24 ch");
    apply(m, &x);
    CHECK(m->dirty_rows == 6u, "SET_TEXT rows 1-2: the message line and the wedge");
    clean5(m);
    /* one burst empties a key in the window and fills another (same count, same window): the rows shift, so every
     * row (section 8.5: a change of occupancy marks every row) */
    x = slot5(2, FM1C_S_EMPTY, 0, "", "");
    apply(m, &x);
    x = slot5(25, FM1C_S_IDLE, 0, "late one", "now");
    apply(m, &x);
    fm1c_list_check(m);
    CHECK((m->dirty & FM1C_D_LIST) && fm1c_list_win(m, &top, &s) == 15u && top == 0u && fm1c_list_key(m, 2) == 3,
          "an occupancy swap in one burst (count and window unchanged): every row");
    fm1c_list_drawn(m);
    clean5(m);
    /* TO DO list, then the voice view (version 4 drawing), then back */
    x = view5(FM1C_VIEW_INBOX, FM1C_LAYOUT_LIST);
    apply(m, &x);
    CHECK(fm1c_list(m) && (m->dirty & FM1C_D_LIST) && !(m->dirty & FM1C_D_KBD), "sessions list -> TO DO list: the rows, no keyboard");
    clean5(m);
    x = view5(FM1C_VIEW_VOICE, FM1C_LAYOUT_BUDDY);
    apply(m, &x);
    CHECK(!fm1c_list(m) && (m->dirty & FM1C_D_KBD) && m->dirty_keys == FM1C_KEYS_ALL, "list -> voice: everything, the keyboard too");
    clean5(m);
    x = view5(FM1C_VIEW_TASKS, FM1C_LAYOUT_LIST);
    apply(m, &x);
    CHECK(!fm1c_list(m) && m->layout == 1, "Tasks has no list: drawn as buddy whatever the layout");
    x = view5(FM1C_VIEW_DETAIL, FM1C_LAYOUT_BUDDY);
    apply(m, &x);
    CHECK(!fm1c_list(m), "DETAILS: the version 4 page");
    /* a version 4 body (no layout byte) is buddy; CLEAR_SLOTS empties the rows */
    x = view5(FM1C_VIEW_SESSIONS, FM1C_LAYOUT_LIST);
    apply(m, &x);
    x = view(FM1C_VIEW_SESSIONS, 0);
    apply(m, &x);
    CHECK(!fm1c_list(m) && m->layout == 0, "SET_VIEW without the layout byte: buddy");
    x = mk(FM1C_T_CLEAR_SLOTS);
    apply(m, &x);
    for (i = 0, k = 0; k < FM1C_NSLOT; k++) i += m->slot[k].title[0] || m->slot[k].age[0];
    CHECK(i == 0u && fm1c_list_win(m, &top, &s) == 0u && s == -1 && top == 0u, "CLEAR_SLOTS: no rows, no titles");
    /* version 4 agreed: a layout byte (never sent then) draws nothing new */
    fm1c_model_proto(m, 4);
    x = view5(FM1C_VIEW_SESSIONS, FM1C_LAYOUT_LIST);
    apply(m, &x);
    CHECK(!fm1c_list(m), "version 4 agreed: no list");
}


/* docs/ui-v3.md section 9.3: the GROUPED entries (header rows, folded task rows, indents) and their redraw marks */
static fm1c_msg gslot(uint32_t k, uint32_t state, uint32_t flags, uint32_t row, const char *htitle)
{
    fm1c_msg x = mk(FM1C_T_SET_SLOT);
    x.u.slot.key = (uint8_t)k;
    x.u.slot.state = (uint8_t)state;
    x.u.slot.flags = (uint8_t)flags;
    x.u.slot.v5 = x.u.slot.v5g = 1;
    x.u.slot.row = (uint8_t)row;
    strcpy(x.u.slot.title, "t");
    strcpy(x.u.slot.age, "1m");
    if (row & FM1C_ROW_START) { x.u.slot.head_state = (uint8_t)state; strcpy(x.u.slot.head_title, htitle); strcpy(x.u.slot.head_count, "1 working"); }
    return x;
}
static void grouped(fm1c_model *m)
{
    fm1c_msg x;
    uint32_t top, L;
    int32_t s;
    fm1c_model_init(m);
    fm1c_model_conn(m, FM1C_C_OK, 0);
    fm1c_model_proto(m, 5);
    /* key 0: header + session; 1: session indent 2; 2: folded task; 3: header + session (selected) */
    x = gslot(0, FM1C_S_WORKING, 0, 1u | FM1C_ROW_START, "Task A"); apply(m, &x);
    x = gslot(1, FM1C_S_IDLE, 0, 2u, ""); apply(m, &x);
    x = gslot(2, FM1C_S_IDLE, 0, FM1C_ROW_START | FM1C_ROW_TASK, "Folded"); apply(m, &x);
    x = gslot(3, FM1C_S_FAILED, FM1C_F_SELECTED, 1u | FM1C_ROW_START, "Task B"); apply(m, &x);
    x = mk(FM1C_T_SET_VIEW); x.u.view.view = FM1C_VIEW_SESSIONS; x.u.view.v5 = 1; x.u.view.layout = FM1C_LAYOUT_GROUPED; x.u.view.pages = 1;
    apply(m, &x);
    CHECK(fm1c_grouped(m) && fm1c_list(m) && fm1c_shown_layout(m) == 2u, "layout 2 in Sessions: grouped (a list)");
    L = fm1c_list_win(m, &top, &s);
    CHECK(L == 6u && s == 5 && top == 0u, "entries 0H 0S 1S 2H 3H 3S: L 6, the selection entry 5 (%u, %d)", L, s);
    CHECK(fm1c_list_ent(m, 0) == 1 && fm1c_list_ent(m, 1) == 0 && fm1c_list_ent(m, 2) == 2 && fm1c_list_ent(m, 3) == 5 &&
          fm1c_list_ent(m, 4) == 7 && fm1c_list_ent(m, 5) == 6 && fm1c_list_ent(m, 6) == -1, "the entry of each row");
    CHECK(fm1c_list_row(m, 2) == -1 && fm1c_list_row_of(m, 2, 1) == 3 && fm1c_list_key(m, 3) == -1, "a folded task row: a header entry only");
    CHECK(fm1c_list_row(m, 3) == 5 && fm1c_list_row_of(m, 3, 1) == 4, "key 3: its header on row 4, its session on row 5");
    fm1c_list_drawn(m);
    clean5(m);
    x = gslot(1, FM1C_S_WORKING, 0, 2u, ""); apply(m, &x);
    fm1c_list_check(m);
    CHECK(m->dirty_keys == 2u && !(m->dirty & FM1C_D_LIST), "a state change: its own key, not the list");
    clean5(m);
    x = gslot(1, FM1C_S_WORKING, 0, FM1C_ROW_START | 1u, "New group"); apply(m, &x);
    fm1c_list_check(m);
    CHECK(m->dirty & FM1C_D_LIST, "a new header (row.start): the entries changed, every row");
    clean5(m);
    x = mk(FM1C_T_SET_VIEW); x.u.view.view = FM1C_VIEW_INBOX; x.u.view.v5 = 1; x.u.view.layout = FM1C_LAYOUT_GROUPED; x.u.view.pages = 1;
    apply(m, &x);
    CHECK(!fm1c_grouped(m) && fm1c_list(m) && fm1c_list_win(m, &top, 0) == 4u, "layout 2 in TO DO: the list (one entry a key, no headers)");
    x = mk(FM1C_T_SET_VIEW); x.u.view.view = FM1C_VIEW_TASKS; x.u.view.v5 = 1; x.u.view.layout = FM1C_LAYOUT_GROUPED; x.u.view.pages = 1;
    apply(m, &x);
    CHECK(!fm1c_list(m) && fm1c_shown_layout(m) == 0u, "layout 2 in Tasks: buddy");
    x = mk(FM1C_T_CMD_RESULT); x.u.result.result = FM1C_R_COMPLETED;
    fm1c_model_apply(m, &x, 5000);
    CHECK(m->toast_until == 7000u, "version 5: the toast stays 2 s (section 9.10)");
}

/* docs/ui-v3.md section 10: SPLIT keys and the SETTINGS view (protocol 6) */
static fm1c_msg view6(uint32_t v, uint32_t layout, uint32_t keys, uint32_t tp, uint32_t tps, uint32_t page, uint32_t pages)
{
    fm1c_msg x = mk(FM1C_T_SET_VIEW);
    x.u.view.view = (uint8_t)v;
    x.u.view.page = (uint8_t)page;
    x.u.view.pages = (uint8_t)pages;
    x.u.view.layout = (uint8_t)layout;
    x.u.view.v5 = x.u.view.v6 = 1;
    x.u.view.keys = (uint8_t)keys;
    x.u.view.task_page = (uint8_t)tp;
    x.u.view.task_pages = (uint8_t)tps;
    strcpy(x.u.view.title, "ACTIVE 15");
    return x;
}
static void version6(fm1c_model *m)
{
    fm1c_msg x;
    uint32_t k, top, L;
    int32_t s;
    fm1c_model_init(m);
    fm1c_model_conn(m, FM1C_C_OK, 0);
    fm1c_model_proto(m, 6);
    x = view6(FM1C_VIEW_SESSIONS, FM1C_LAYOUT_BUDDY, 0, 0, 1, 0, 2);
    apply(m, &x);
    CHECK(!fm1c_split_on(m) && fm1c_shape(m) == 0u, "protocol 6, keys 0: RANKED, the version 5 shape");
    m->dirty = m->dirty_keys = m->dirty_rows = 0;
    x = view6(FM1C_VIEW_SESSIONS, FM1C_LAYOUT_BUDDY, 1, 0, 3, 0, 2);
    apply(m, &x);
    CHECK(fm1c_split_buddy(m) && fm1c_shape(m) == 4u && m->dirty == FM1C_D_ALL && m->dirty_keys == FM1C_KEYS_ALL,
          "keys 0 -> 1 in Sessions: a layout change, everything");
    m->dirty = m->dirty_keys = m->dirty_rows = 0;
    x = view6(FM1C_VIEW_SESSIONS, FM1C_LAYOUT_BUDDY, 1, 1, 3, 0, 2);
    apply(m, &x);
    CHECK(m->dirty == FM1C_D_BAND && !m->dirty_keys && m->task_page == 1, "task page 1 -> 2: the band alone");
    m->dirty = 0;
    x = view6(FM1C_VIEW_SESSIONS, FM1C_LAYOUT_BUDDY, 1, 1, 3, 1, 2);
    apply(m, &x);
    CHECK(m->dirty == FM1C_D_STATUS, "white page: the top bar (its number), not the band");
    m->dirty = 0;
    apply(m, &x);
    CHECK(m->dirty == 0, "the same SET_VIEW again: nothing");
    x = view6(FM1C_VIEW_VOICE, FM1C_LAYOUT_BUDDY, 1, 1, 3, 0, 1);
    apply(m, &x);
    CHECK(fm1c_compact(m) && m->dirty == FM1C_D_ALL, "voice over SPLIT Sessions: compact boxes, a new shape, everything");
    m->dirty = m->dirty_keys = m->dirty_rows = 0;
    x = view6(FM1C_VIEW_SESSIONS, FM1C_LAYOUT_LIST, 1, 0, 1, 0, 1);
    apply(m, &x);
    CHECK(fm1c_split_list(m) && fm1c_list_rows(m) == 8u && fm1c_shape(m) == 5u, "SPLIT list: 8 rows");
    for (k = 0; k < FM1C_NSLOT; k++) {          /* every key occupied; the selection on white key 21 (E5) */
        fm1c_msg y = slot5(k, FM1C_S_IDLE, k == 21u ? FM1C_F_SELECTED : 0u, "t", "1m");
        apply(m, &y);
    }
    L = fm1c_list_win(m, &top, &s);
    CHECK(L == 16u && s == 12 && top == 8u, "black keys are never rows: 16 entries, E5 is entry 12, window 8-15 (%u %d %u)", L, s, top);
    CHECK(fm1c_list_row(m, 1) < 0 && fm1c_list_row(m, 21) == 4 && fm1c_list_key(m, 0) == 14, "k 1 has no row; k 21 on row 4; row 0 is k 14");
    CHECK(fm1c_list_occ(m) == (FM1C_KEYS_ALL & ~FM1C_KEYS_BLACK), "the occupancy: white keys only");
    m->dirty = m->dirty_keys = m->dirty_rows = 0;
    fm1c_list_drawn(m);
    x = slot5(3, FM1C_S_WORKING, 0, "t", "1m");
    apply(m, &x);
    fm1c_list_check(m);
    CHECK(m->dirty_keys == 1u << 3 && !(m->dirty & FM1C_D_LIST), "a black key's change: its chip, the list rows stay");
    x = slot5(3, FM1C_S_EMPTY, 0, "", "");
    apply(m, &x);
    fm1c_list_check(m);
    CHECK(!(m->dirty & FM1C_D_LIST), "a black key emptied: the list's entries do not move");
    /* SETTINGS: page is the cursor, pages the item count */
    m->dirty = m->dirty_keys = m->dirty_rows = 0;
    x = view6(FM1C_VIEW_SETTINGS, FM1C_LAYOUT_BUDDY, 1, 0, 1, 0, 3);
    apply(m, &x);
    CHECK(fm1c_settings(m) && fm1c_shape(m) == 8u && m->dirty == FM1C_D_ALL, "into settings: everything");
    m->dirty = m->dirty_keys = m->dirty_rows = 0;
    x = view6(FM1C_VIEW_SETTINGS, FM1C_LAYOUT_BUDDY, 1, 0, 1, 2, 3);
    apply(m, &x);
    CHECK(m->dirty == 0 && m->dirty_rows == (1u << 0 | 1u << 2 | 1u << 9), "the cursor 0 -> 2: rows 0 and 2 and the description, no top bar");
    m->dirty_rows = 0;
    x = view6(FM1C_VIEW_SETTINGS, FM1C_LAYOUT_BUDDY, 1, 0, 1, 2, 4);
    apply(m, &x);
    CHECK(m->dirty_rows == 0x1FFu, "a new item count: every item row");
    m->dirty_rows = 0;
    x = view6(FM1C_VIEW_SETTINGS, FM1C_LAYOUT_BUDDY, 1, 0, 1, 99, 4);
    apply(m, &x);
    CHECK(m->dirty_rows == (1u << 2 | 1u << 0 | 1u << 9), "a cursor past the rows marks row 0 (nothing past row 8)");
    x = view6(FM1C_VIEW_SESSIONS, FM1C_LAYOUT_BUDDY, 1, 0, 1, 0, 1);
    apply(m, &x);
    CHECK(m->dirty == FM1C_D_ALL, "out of settings: everything");
    /* protocol 5 agreed: a keys byte or view 6 draws nothing new (the host never sends them; the device stays RANKED) */
    fm1c_model_proto(m, 5);
    CHECK(!fm1c_split_on(m) && !fm1c_settings(m) && fm1c_shape(m) == 0u, "protocol 5: no SPLIT, no settings");
}

int main(void)
{
    static fm1c_model m;
    fm1c_msg x;
    fm1c_model_init(&m);
    CHECK(m.dirty == FM1C_D_ALL && m.dirty_keys == FM1C_KEYS_ALL && m.conn == FM1C_C_NOHOST && fm1c_dimmed(&m),
          "boot: everything to draw, dimmed, no host");
    clean(&m);
    fm1c_model_conn(&m, FM1C_C_WAIT, 0);
    CHECK(m.dirty == FM1C_D_ALL && !fm1c_dimmed(&m), "host appears: the whole screen, lit");
    clean(&m);
    fm1c_model_conn(&m, FM1C_C_OK, 0);
    CHECK(m.dirty == FM1C_D_STATUS, "negotiated: the status bar only");
    clean(&m);
    fm1c_model_conn(&m, FM1C_C_OK, 1);
    CHECK(m.dirty == FM1C_D_STATUS, "link fault: the status bar");
    fm1c_model_conn(&m, FM1C_C_OK, 0);
    clean(&m);
    CHECK(m.look == FM1C_PROTO_MAX && fm1c_v4(&m), "before the first host the layout is this firmware's newest");
    fm1c_model_proto(&m, 1);                    /* the checks below: an old companion's version 1 marks */
    CHECK(m.look == 1 && !fm1c_v2(&m) && m.dirty == FM1C_D_ALL, "version 1 agreed: the version 1 layout, all again");
    clean(&m);

    x = mk(FM1C_T_SET_SLOT);
    x.u.slot.key = 4;
    x.u.slot.state = FM1C_S_WORKING;
    strcpy(x.u.slot.label, "api");
    apply(&m, &x);
    CHECK(m.dirty_keys == 1u << 4 && m.dirty == 0, "a slot: its cell only");
    clean(&m);
    apply(&m, &x);
    CHECK(m.dirty_keys == 0 && m.dirty == 0, "the same slot again: nothing");
    x.u.slot.flags = FM1C_F_SELECTED;
    apply(&m, &x);
    CHECK(m.dirty_keys == 1u << 4 && m.dirty == FM1C_D_LABEL && fm1c_selected(&m) == 4, "selected: its cell and the label");
    clean(&m);
    x.u.slot.state = FM1C_S_APPROVAL;
    apply(&m, &x);
    CHECK(m.dirty_keys == 1u << 4 && m.dirty == FM1C_D_LABEL, "the selected slot changes: cell and label");
    clean(&m);
    x.u.slot.key = 9;
    x.u.slot.flags = 0;
    apply(&m, &x);
    CHECK(m.dirty_keys == 1u << 9 && m.dirty == 0 && fm1c_selected(&m) == 4, "another agent changes: the selection stays");
    clean(&m);

    x = mk(FM1C_T_SET_VIEW);
    x.u.view.view = FM1C_VIEW_SESSIONS;
    x.u.view.pages = 1;
    strcpy(x.u.view.title, "Sessions");
    apply(&m, &x);
    CHECK(m.dirty == FM1C_D_STATUS, "a title: the status bar");
    clean(&m);
    apply(&m, &x);
    CHECK(m.dirty == 0, "the same view again: nothing");

    x = mk(FM1C_T_SET_DETAIL);
    x.u.detail.provider = 1;
    x.u.detail.state = FM1C_S_WORKING;
    strcpy(x.u.detail.line[2], "tests running");
    apply(&m, &x);
    CHECK(m.dirty == (FM1C_D_HEAD | FM1C_D_LINE(2)), "detail: the head and the changed line (%x)", m.dirty);
    clean(&m);
    strcpy(x.u.detail.line[2], "tests passed");
    apply(&m, &x);
    CHECK(m.dirty == FM1C_D_LINE(2), "one line changes: that line");
    clean(&m);

    x = mk(FM1C_T_SET_VOICE);
    x.u.voice.voice = FM1C_V_RECORDING;
    x.u.voice.level = 40;
    apply(&m, &x);
    CHECK(m.dirty == 0 && m.voice == FM1C_V_RECORDING, "voice outside the voice view: kept, not drawn");
    {
        fm1c_msg v = mk(FM1C_T_SET_VIEW);
        v.u.view.view = FM1C_VIEW_VOICE;
        strcpy(v.u.view.title, "Sessions");
        v.u.view.pages = 1;
        apply(&m, &v);
        CHECK(m.dirty == (FM1C_D_STATUS | FM1C_D_PANEL), "to the voice view: status and panel");
        clean(&m);
    }
    x.u.voice.level = 55;
    apply(&m, &x);
    CHECK(m.dirty == FM1C_D_LINE(0), "level: the bar only");
    clean(&m);
    x.u.voice.elapsed_ds = 12;
    apply(&m, &x);
    CHECK(m.dirty == FM1C_D_LINE(1), "elapsed: its line only");
    clean(&m);
    x.u.voice.voice = FM1C_V_TRANSCRIBING;
    apply(&m, &x);
    CHECK(m.dirty == (FM1C_D_HEAD | FM1C_D_LABEL), "state: the word");
    clean(&m);

    x = mk(FM1C_T_CMD_RESULT);
    x.u.result.result = FM1C_R_COMPLETED;
    strcpy(x.u.result.text, "prompt sent");
    fm1c_model_apply(&m, &x, 5000);
    CHECK(m.dirty == FM1C_D_LINE(3) && m.toast_on, "command result: the toast line");
    clean(&m);
    fm1c_model_tick(&m, 7499);
    CHECK(m.dirty == 0 && m.toast_on, "shown 2.5 s");
    fm1c_model_tick(&m, 7500);
    CHECK(m.dirty == FM1C_D_LINE(3) && !m.toast_on, "then gone");
    clean(&m);

    x = mk(FM1C_T_SET_LEGEND);
    strcpy(x.u.legend.label[0], "PAGE");
    apply(&m, &x);
    CHECK(m.dirty == FM1C_D_LEGEND, "legend");
    clean(&m);
    x = mk(FM1C_T_SET_STATUS);
    x.u.status.attention = 2;
    apply(&m, &x);
    CHECK(m.dirty == FM1C_D_STATUS, "attention: the status bar");
    clean(&m);

    x = mk(FM1C_T_CLEAR_SLOTS);
    apply(&m, &x);
    CHECK(m.dirty_keys == (1u << 4 | 1u << 9) && m.dirty == FM1C_D_LABEL && fm1c_selected(&m) < 0,
          "clear: the two slots that held something, and the label");
    clean(&m);

    fm1c_model_conn(&m, FM1C_C_NOHOST, 0);
    CHECK(m.dirty == FM1C_D_ALL && m.dirty_keys == FM1C_KEYS_ALL && fm1c_dimmed(&m), "host lost: all again, dimmed");
    clean(&m);
    m.slot[3].flags = FM1C_F_SELECTED;
    fm1c_model_conn(&m, FM1C_C_OK, 0);
    CHECK(fm1c_selected(&m) == 3, "the selection survives the host going away");
    fm1c_model_clear(&m);
    CHECK(fm1c_selected(&m) < 0 && m.conn == FM1C_C_OK && m.dirty == FM1C_D_ALL, "a new companion: content cleared, link kept");
    CHECK(fm1c_has("host too OLD (1-1)", "old") && !fm1c_has("host too new", "old"), "reason matching");
    version2(&m);
    details(&m);
    version4(&m);
    version5(&m);
    grouped(&m);
    version6(&m);
    T_DONE("model_test");
}
