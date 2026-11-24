/* SPDX-License-Identifier: GPL-3.0-only */
/* What the console shows: the host's last SET_* of each element plus the link state, and which screen regions
 * changed since they were drawn. A SET_* that repeats what is there marks nothing (a resync or a retransmission
 * costs no redraw); a heartbeat never touches it. Pure: fm1c_draw.h reads it. */
#pragma once
#include "fm1c_proto.h"

/* screen regions (docs/firmware-ui.md) */
#define FM1C_D_STATUS 0x001u                    /* y 0-23 */
#define FM1C_D_HEAD 0x002u                      /* y 24-39: provider badge, state chip */
#define FM1C_D_LABEL 0x004u                     /* y 40-71: the big line */
#define FM1C_D_LINE(i) (0x008u << (i))          /* y 72 + 16 i: four small lines (0x008..0x040) */
#define FM1C_D_LEGEND 0x080u                    /* y 200-239 (not in DETAILS) */
#define FM1C_D_STRIP 0x100u                     /* y 140-199: the whole key strip, background too */
#define FM1C_D_BANNER 0x200u                    /* NO COMPANION / UPDATE APP over the dimmed screen */
#define FM1C_D_HELP 0x400u                      /* y 24-199 (DETAILS: 24-215): the help overlay (proto >= 2, SCL held);
                                                 * not in FM1C_D_ALL */
#define FM1C_D_FOOT 0x800u                      /* y 216-239 in DETAILS (view 5): the hint band or the toast */
#define FM1C_D_PANEL (FM1C_D_HEAD | FM1C_D_LABEL | FM1C_D_LINE(0) | FM1C_D_LINE(1) | FM1C_D_LINE(2) | FM1C_D_LINE(3))
/* version 4 (docs/ui-v3.md section 3.A): the regions tile the screen; the bubble's text rows are dirty_rows (base
 * views: rows 0-6, row 6 is the "more" wedge on the bubble's bottom edge; DETAILS: rows 0-11), the keys dirty_keys,
 * the voice meter's bars dirty_bars */
#define FM1C_D_HERO 0x1000u                     /* x 0-51, y 18-67 (DETAILS: 18-71): the character, 48 x 48 at (4, 20) */
#define FM1C_D_LABEL4 0x2000u                   /* x 52-239, y 18-67: the label (FONT_L at x 60) and line 1 */
#define FM1C_D_BUBBLE 0x4000u                   /* the bubble's frame and tail, in strips around its rows */
#define FM1C_D_HINT4 0x8000u                    /* y 224-239: the hint bar, the toast or the knob row */
#define FM1C_D_KBD (1u << 16)                   /* y 184-223: the critter keyboard, every key and the gaps */
#define FM1C_D_ELAPSED (1u << 17)               /* voice: the elapsed time at the caption's right end */
/* version 5, the LIST layout (docs/ui-v3.md section 8.2; views 0 and 2 with SET_VIEW.layout 1): FM1C_D_HERO is the
 * 24 x 24 hero's 29 x 42 box, FM1C_D_BUBBLE the header bubble (211 x 42), dirty_rows 0-2 its caption, message line
 * and wedge, dirty_keys a key's list row (when it is in the window), FM1C_D_LIST every row, the gaps and the scroll
 * column; LABEL4, KBD and ELAPSED are not drawn there */
#define FM1C_D_LIST (1u << 18)                  /* y 60-223: the 10 rows, the gaps above and below, the scroll column */
/* version 6 (docs/ui-v3.md section 10.7), SPLIT keys in Sessions: FM1C_D_BAND the black row band (Buddy y 168-199, List /
 * Grouped y 60-91: the 11 chips, their stems, the task page dots); dirty_keys of a black key its chip. Buddy: FM1C_D_KBD
 * the white row (y 200-223), FM1C_D_BUBBLE the 4-row bubble. List / Grouped: FM1C_D_LIST rows 92-223 (8 rows, the gaps,
 * the scroll column). The SETTINGS view (view 6, section 10.2): FM1C_D_LIST its body (y 18-223: the gap, the 9 item
 * rows, the description), dirty_rows 0-8 an item row, 9 the description. */
#define FM1C_D_BAND (1u << 19)
#define FM1C_D_V4 (FM1C_D_HERO | FM1C_D_LABEL4 | FM1C_D_BUBBLE | FM1C_D_HINT4 | FM1C_D_KBD | FM1C_D_ELAPSED | FM1C_D_LIST | \
                   FM1C_D_BAND)
#define FM1C_D_ALL (0x3FFu | FM1C_D_FOOT | FM1C_D_V4)
#define FM1C_KEYS_ALL 0x7FFFFFFu                /* 27 bits */
#define FM1C_KEYS_BLACK 0x252A52Au              /* the 11 black keys: 1 3 5 8 10 13 15 17 20 22 25 */
#define FM1C_ROWS_ALL 0xFFFu                    /* the 12 DETAILS text rows (y 24 + 16 n), dirty_rows */
#define FM1C_BARS 28u                           /* version 4 voice: the level meter's bars */
#define FM1C_BARS_ALL 0xFFFFFFFu

#define FM1C_TOAST_MS 2500u
#define FM1C_TOAST_FAIL_MS 4000u
#define FM1C_TOAST5_MS 2000u                    /* version 5: the toast slides out 2 s after it came (section 9.10) */
#define FM1C_PROTO_V2 2u                        /* the agreed version from which docs/ux-v2.md section 2.4 draws */
#define FM1C_KNOB_MS 2000u                      /* version 4: the knob row after a K1-K4 turn */
#define FM1C_LIST_ROWS 10u                      /* version 5: rows in the list window */
#define FM1C_LIST_ROWS6 8u                      /* version 6, SPLIT keys: rows in the list window (below the black row band) */
#define FM1C_SET_ITEMS 9u                       /* version 6 settings: item rows (SET_TEXT rows 0-8; row 9 the description) */

enum { FM1C_C_NOHOST = 0, FM1C_C_WAIT, FM1C_C_OK, FM1C_C_INCOMPAT };

typedef struct {
    uint8_t state, flags;
    char label[FM1C_L_LABEL + 1];
    char title[FM1C_L_ROW + 1], age[FM1C_L_AGE + 1];   /* version 5: the list row */
    uint8_t row, head_state, head_flags;        /* version 5 grouped (docs/ui-v3.md section 9.5): indent, start, task */
    char head_title[FM1C_L_HEAD + 1], head_count[FM1C_L_COUNT + 1];
} fm1c_slot;

typedef struct {
    uint8_t view, page, pages, layout;          /* layout: SET_VIEW's (version 5), 0 buddy, 1 list, 2 grouped */
    char title[FM1C_L_TITLE + 1];
    fm1c_slot slot[FM1C_NSLOT];
    uint8_t provider, dstate;
    char line[4][FM1C_L_LINE + 1];
    uint8_t voice, level;
    uint16_t elapsed_ds;
    char target[FM1C_L_LINE + 1];
    char legend[4][FM1C_L_LEGEND + 1];
    uint8_t link, attention;
    char status[FM1C_L_LINE + 1];
    uint8_t toast_on, toast_result;
    uint32_t toast_until;
    char toast[FM1C_L_LINE + 1];
    uint8_t conn, fault;
    char reason[FM1C_L_REASON + 1];
    uint8_t proto, help;                        /* the agreed version (0: none); 1 while the help overlay is up */
    uint8_t tstyle[FM1C_TEXT_ROWS];             /* the DETAILS text (SET_TEXT, version 3): kept in every view */
    char text[FM1C_TEXT_ROWS][FM1C_L_TEXT_WIRE + 1];   /* (version 7: with its control bytes) */
    uint8_t look;                               /* the layout: the agreed version, kept while none is (the dimmed screen);
                                                 * FM1C_PROTO_MAX before the first host */
    uint8_t knob_on, knob_lit;                  /* version 4: the knob row is up, the knob turned (0..3) */
    uint32_t knob_until;
    uint8_t bar[FM1C_BARS], bar_n;              /* version 4 voice: the meter's levels, the next bar to write */
    uint32_t dirty, dirty_keys, dirty_rows, dirty_bars;
    uint32_t dirty_lrows;                       /* version 5 list: the rows (0-9) to draw again */
    uint32_t list_occ;                          /* version 5 list: the non-empty keys as last drawn (fm1c_list_check) */
    uint32_t list_hdr;                          /* version 5 grouped: the keys with a header row as last drawn */
    uint32_t list_tsk;                          /* version 5 grouped: the folded task rows as last drawn */
    uint8_t list_top;                           /* version 5 list: the window's first entry as last drawn */
    uint8_t keys, task_page, task_pages;        /* version 6: SET_VIEW's keys (0 ranked, 1 split) and the task page */
} fm1c_model;

static uint32_t fm1c_len(const char *s)
{
    uint32_t n = 0;
    while (s[n]) n++;
    return n;
}
static int fm1c_has(const char *s, const char *sub)   /* sub in s, ASCII case ignored */
{
    uint32_t i, j;
    for (i = 0; s[i]; i++) {
        for (j = 0; sub[j]; j++) {
            uint32_t a = (uint8_t)s[i + j], b = (uint8_t)sub[j];
            if (a >= 'A' && a <= 'Z') a += 32u;
            if (b >= 'A' && b <= 'Z') b += 32u;
            if (!a || a != b) break;
        }
        if (!sub[j]) return 1;
    }
    return 0;
}
static int fm1c_str_eq(const char *a, const char *b)
{
    while (*a && *a == *b) a++, b++;
    return *a == *b;
}
/* copies b into a (max chars + NUL); returns 1 when that changed a */
static int fm1c_str_set(char *a, const char *b, uint32_t max)
{
    uint32_t i;
    if (fm1c_str_eq(a, b)) return 0;
    for (i = 0; i < max && b[i]; i++) a[i] = b[i];
    a[i] = 0;
    return 1;
}

static int32_t fm1c_selected(const fm1c_model *m)   /* the first slot flagged selected, -1: none */
{
    uint32_t k;
    for (k = 0; k < FM1C_NSLOT; k++)
        if (m->slot[k].flags & FM1C_F_SELECTED) return (int32_t)k;
    return -1;
}

static int fm1c_dimmed(const fm1c_model *m) { return m->conn == FM1C_C_NOHOST || m->conn == FM1C_C_INCOMPAT; }
static int fm1c_v2(const fm1c_model *m) { return m->look >= FM1C_PROTO_V2; }   /* (version 3 includes version 2) */
static int fm1c_v4(const fm1c_model *m) { return m->look >= FM1C_PROTO_V4; }    /* the characters, docs/ui-v3.md */
static int fm1c_detail(const fm1c_model *m) { return m->view == FM1C_VIEW_DETAIL; }
/* version 5: the LIST layout is drawn (docs/ui-v3.md section 8): sessions or TO DO with layout 1 */
static int fm1c_list_on(const fm1c_model *m, uint32_t view, uint32_t layout)
{
    return m->look >= FM1C_PROTO_V5 && (view == FM1C_VIEW_SESSIONS || view == FM1C_VIEW_INBOX) &&
           (layout == FM1C_LAYOUT_LIST || layout == FM1C_LAYOUT_GROUPED);   /* (layout 2 in TO DO: the list) */
}
static int fm1c_list(const fm1c_model *m) { return fm1c_list_on(m, m->view, m->layout); }
/* version 5: the GROUPED list (docs/ui-v3.md section 9.3): Sessions with layout 2 */
static int fm1c_grouped(const fm1c_model *m)
{
    return m->look >= FM1C_PROTO_V5 && m->view == FM1C_VIEW_SESSIONS && m->layout == FM1C_LAYOUT_GROUPED;
}
/* the layout as drawn: 0 buddy, 1 list, 2 grouped */
static uint32_t fm1c_shown_layout(const fm1c_model *m) { return fm1c_grouped(m) ? 2u : fm1c_list(m) ? 1u : 0u; }

/* Version 6 (docs/ui-v3.md section 10). The keys as the keyboard lies: key -> white index, or 0x80 | the white key it
 * follows (version 2 and later draw them so, docs/ux-v2.md section 2.4). */
static const uint8_t FM1C_WHITE_OF[FM1C_NSLOT] = {
    0, 0x80, 1, 0x81, 2, 0x82, 3, 4, 0x84, 5, 0x85, 6, 7, 0x87, 8, 0x88, 9, 0x89, 10, 11, 0x8B, 12, 0x8C, 13, 14, 0x8E, 15};
static int fm1c_key_black(uint32_t k) { return (FM1C_WHITE_OF[k] & 0x80u) != 0; }
/* the 27 slots hold the SPLIT assignment (SET_VIEW keys 1, version 6): black keys filters and tasks, white sessions */
static int fm1c_split_on(const fm1c_model *m) { return m->look >= FM1C_PROTO_V6 && m->keys == FM1C_KEYS_SPLIT; }
/* Sessions with SPLIT keys: the black row band is drawn (Buddy above the white minis, List / Grouped above the rows) */
static int fm1c_split_band(const fm1c_model *m) { return fm1c_split_on(m) && m->view == FM1C_VIEW_SESSIONS; }
static int fm1c_split_list(const fm1c_model *m) { return fm1c_split_band(m) && fm1c_list(m); }
static int fm1c_split_buddy(const fm1c_model *m) { return fm1c_split_band(m) && !fm1c_list(m); }
/* voice / confirm over SPLIT Sessions: the version 4 strip with compact black boxes */
static int fm1c_compact(const fm1c_model *m)
{
    return fm1c_split_on(m) && (m->view == FM1C_VIEW_VOICE || m->view == FM1C_VIEW_CONFIRM);
}
static int fm1c_settings(const fm1c_model *m) { return m->look >= FM1C_PROTO_V6 && m->view == FM1C_VIEW_SETTINGS; }
/* the screen's geometry as drawn: the layout (0-2), + 4 the SPLIT band, + 8 settings, + 16 compact boxes; a change
 * redraws everything (version 1-5: the layout alone) */
static uint32_t fm1c_shape(const fm1c_model *m)
{
    if (fm1c_settings(m)) return 8u;
    return fm1c_shown_layout(m) | (fm1c_split_band(m) ? 4u : 0u) | (fm1c_compact(m) ? 16u : 0u);
}
/* the list's rows in the window: 10, or 8 under the SPLIT band */
static uint32_t fm1c_list_rows(const fm1c_model *m) { return fm1c_split_list(m) ? FM1C_LIST_ROWS6 : FM1C_LIST_ROWS; }
/* key k has no list entry: empty, or a black key under the SPLIT band (black keys are never rows, section 10.7) */
static int fm1c_list_black(const fm1c_model *m, uint32_t k) { return fm1c_key_black(k) && fm1c_split_list(m); }
static int fm1c_list_skip(const fm1c_model *m, uint32_t k) { return m->slot[k].state == FM1C_S_EMPTY || fm1c_list_black(m, k); }

/* The list's entries (section 8.3; grouped: section 9.3). List: the non-empty keys in key order, one session entry
 * each. Grouped: for each non-empty key, a header entry when row.start is set, then a session entry unless row.task.
 * An entry is coded k << 1 | header. */
static int fm1c_ent_hdr(const fm1c_model *m, uint32_t k)
{
    return fm1c_grouped(m) && (m->slot[k].row & FM1C_ROW_START) != 0u;
}
static int fm1c_ent_ses(const fm1c_model *m, uint32_t k)
{
    return !fm1c_grouped(m) || (m->slot[k].row & FM1C_ROW_TASK) == 0u;
}
/* L, the number of entries; *top the first entry shown (10 * floor(s / 10) for the selected key's session entry s,
 * else 0), *sel_at s (-1: none) */
static uint32_t fm1c_list_win(const fm1c_model *m, uint32_t *top, int32_t *sel_at)
{
    uint32_t k, n = 0, rows = fm1c_list_rows(m);
    int32_t s = -1;
    for (k = 0; k < FM1C_NSLOT; k++) {
        if (fm1c_list_skip(m, k)) continue;
        n += (uint32_t)fm1c_ent_hdr(m, k);
        if (!fm1c_ent_ses(m, k)) continue;
        if (s < 0 && (m->slot[k].flags & FM1C_F_SELECTED)) s = (int32_t)n;
        n++;
    }
    *top = s < 0 ? 0u : (uint32_t)s / rows * rows;
    if (sel_at) *sel_at = s;
    return n;
}
/* the non-empty keys as a mask (bit k: key k); the keys with a header row; the folded task rows */
static uint32_t fm1c_list_occ(const fm1c_model *m)
{
    uint32_t k, o = 0;
    for (k = 0; k < FM1C_NSLOT; k++) o |= (uint32_t)!fm1c_list_skip(m, k) << k;
    return o;
}
static uint32_t fm1c_list_hdr(const fm1c_model *m)
{
    uint32_t k, o = 0;
    for (k = 0; k < FM1C_NSLOT; k++) o |= (uint32_t)(fm1c_ent_hdr(m, k) && !fm1c_list_black(m, k)) << k;
    return o;
}
static uint32_t fm1c_list_tsk(const fm1c_model *m)
{
    uint32_t k, o = 0;
    for (k = 0; k < FM1C_NSLOT; k++) o |= (uint32_t)(!fm1c_ent_ses(m, k) && !fm1c_list_black(m, k)) << k;
    return o;
}
/* The window moved or the entries changed since the list was last drawn: every row and the scroll column. Checked
 * when drawing, not per SET_SLOT, so the deselect-then-select of one selection change (a burst) costs two rows, not
 * the whole list. The occupancy is compared as a mask, not a count: a burst that empties one key and fills another
 * keeps the count but shifts the rows between them. */
static int fm1c_list_moved(const fm1c_model *m)
{
    uint32_t top;
    fm1c_list_win(m, &top, 0);
    return top != m->list_top || fm1c_list_occ(m) != m->list_occ || fm1c_list_hdr(m) != m->list_hdr ||
           fm1c_list_tsk(m) != m->list_tsk;
}
static void fm1c_list_check(fm1c_model *m)
{
    if (fm1c_list_moved(m)) m->dirty |= FM1C_D_LIST;
}
static void fm1c_list_drawn(fm1c_model *m)
{
    uint32_t top;
    fm1c_list_win(m, &top, 0);
    m->list_occ = fm1c_list_occ(m);
    m->list_hdr = fm1c_list_hdr(m);
    m->list_tsk = fm1c_list_tsk(m);
    m->list_top = (uint8_t)top;
}

/* the window row (0..9) of key k's entry (hdr 1: its header entry), or -1 when it has none or it is outside */
static int32_t fm1c_list_row_of(const fm1c_model *m, uint32_t k, uint32_t hdr)
{
    uint32_t top, i, n = 0;
    fm1c_list_win(m, &top, 0);
    if (k >= FM1C_NSLOT || fm1c_list_skip(m, k)) return -1;
    if (hdr ? !fm1c_ent_hdr(m, k) : !fm1c_ent_ses(m, k)) return -1;
    for (i = 0; i < k; i++)
        if (!fm1c_list_skip(m, i)) n += (uint32_t)fm1c_ent_hdr(m, i) + (uint32_t)fm1c_ent_ses(m, i);
    if (!hdr) n += (uint32_t)fm1c_ent_hdr(m, k);
    return n >= top && n < top + fm1c_list_rows(m) ? (int32_t)(n - top) : -1;
}
/* the list row of key k's session entry (the list's minis animate there), or -1 */
static int32_t fm1c_list_row(const fm1c_model *m, uint32_t k) { return fm1c_list_row_of(m, k, 0); }
/* the entry on list row r: k << 1 | header, or -1 */
static int32_t fm1c_list_ent(const fm1c_model *m, uint32_t r)
{
    uint32_t top, k, n = 0;
    fm1c_list_win(m, &top, 0);
    for (k = 0; k < FM1C_NSLOT; k++) {
        if (fm1c_list_skip(m, k)) continue;
        if (fm1c_ent_hdr(m, k) && n++ == top + r) return (int32_t)(k << 1 | 1u);
        if (fm1c_ent_ses(m, k) && n++ == top + r) return (int32_t)(k << 1);
    }
    return -1;
}

/* the key whose session entry is on list row r, or -1 (none, or a header entry) */
static int32_t fm1c_list_key(const fm1c_model *m, uint32_t r)
{
    int32_t e = fm1c_list_ent(m, r);
    return e < 0 || (e & 1) ? -1 : e >> 1;
}

/* every region, key and text row to be drawn again */
static void fm1c_model_all(fm1c_model *m)
{
    m->dirty |= FM1C_D_ALL;
    m->dirty_keys = FM1C_KEYS_ALL;
    m->dirty_rows = FM1C_ROWS_ALL;
    m->dirty_bars = FM1C_BARS_ALL;
}

/* A key's box on the screen, which is also its redraw rectangle. Version 2 draws the keys as the keyboard lies:
 * 16 white keys (F3 .. G5) in a row at the bottom, 11 black keys above the gaps (docs/ux-v2.md section 2.4).
 * Version 1: the old strip, 27 cells of 8 x 64 in three groups of 9. */
/* (FM1C_WHITE_OF, fm1c_key_black: above) */
static void fm1c_key_box(const fm1c_model *m, uint32_t k, int32_t *x, int32_t *y, int32_t *w, int32_t *h)
{
    uint32_t a = FM1C_WHITE_OF[k] & 0x7Fu;
    if (fm1c_v4(m)) {                           /* version 4: 14 x 14 mini boxes, black keys at y 184, white at 202 */
        *x = fm1c_key_black(k) ? 8 + 14 * ((int32_t)a + 1) - 7 : 8 + 14 * (int32_t)a;
        *y = fm1c_key_black(k) ? 184 : 202; *w = 14; *h = 14;
    } else if (!fm1c_v2(m)) {
        *x = 8 + (int32_t)k * 8 + (int32_t)(k / 9u) * 4;
        *y = 136; *w = 8; *h = 64;
    } else if (fm1c_key_black(k)) {
        *x = 8 + 14 * ((int32_t)a + 1) - 6;     /* centred on the boundary after white key a */
        *y = 136; *w = 12; *h = 30;
    } else {
        *x = 8 + 14 * (int32_t)a;
        *y = 166; *w = 14; *h = 34;
    }
}

/* the help overlay up (1) or down (0); down redraws everything it covered */
static void fm1c_model_help(fm1c_model *m, uint32_t on)
{
    if (m->help == (on ? 1u : 0u)) return;
    m->help = (uint8_t)(on ? 1u : 0u);
    if (on) m->dirty |= FM1C_D_HELP;
    else {
        m->dirty &= ~FM1C_D_HELP;
        fm1c_model_all(m);
    }
}

/* the version the link agreed (0: none). It changes how the legend, line 4, the voice view and the strip are drawn,
 * so a change redraws everything; losing version 2 closes the help. With none agreed the layout stays the last
 * agreed one (the dimmed screen behind the banner); before the first host it is this firmware's newest. */
static void fm1c_model_proto(fm1c_model *m, uint32_t proto)
{
    uint32_t look = proto ? proto : m->look;
    if (m->proto == proto && m->look == look) return;
    m->proto = (uint8_t)proto;
    m->look = (uint8_t)look;
    if (!proto || !fm1c_v2(m)) fm1c_model_help(m, 0);
    if (!fm1c_v4(m)) m->knob_on = 0;
    fm1c_model_all(m);
}

/* the host's content back to nothing (a new companion run resyncs it); the link state stays */
static void fm1c_model_clear(fm1c_model *m)
{
    uint8_t conn = m->conn, fault = m->fault, look = m->look;
    char reason[FM1C_L_REASON + 1];
    uint32_t i;
    for (i = 0; i <= FM1C_L_REASON; i++) reason[i] = m->reason[i];
    fm1c_zero(m, sizeof *m);
    m->conn = conn;
    m->fault = fault;
    m->look = look;
    for (i = 0; i <= FM1C_L_REASON; i++) m->reason[i] = reason[i];
    m->pages = 1;
    fm1c_model_all(m);                          /* (the DETAILS rows: empty body) */
}

static void fm1c_model_init(fm1c_model *m)
{
    fm1c_zero(m, sizeof *m);
    m->conn = FM1C_C_NOHOST;
    m->look = FM1C_PROTO_MAX;
    fm1c_model_clear(m);
}

static void fm1c_model_conn(fm1c_model *m, uint32_t conn, uint32_t fault)
{
    int was = fm1c_dimmed(m);
    if (m->conn == conn && m->fault == fault) return;
    m->conn = (uint8_t)conn;
    m->fault = (uint8_t)fault;
    m->dirty |= FM1C_D_STATUS;
    if (was != fm1c_dimmed(m)) {                /* dimmed <-> lit: everything again (the banner on top) */
        m->dirty = 0;
        fm1c_model_all(m);
    }
}

/* the grouped fields of a SET_SLOT (absent: row 0, no head); returns 1 when they changed */
static int fm1c_model_group(fm1c_slot *s, uint32_t row, uint32_t hstate, uint32_t hflags, const char *htitle,
                            const char *hcount)
{
    int changed = s->row != row || s->head_state != hstate || s->head_flags != hflags;
    s->row = (uint8_t)row;
    s->head_state = (uint8_t)hstate;
    s->head_flags = (uint8_t)hflags;
    changed |= fm1c_str_set(s->head_title, htitle, FM1C_L_HEAD);
    changed |= fm1c_str_set(s->head_count, hcount, FM1C_L_COUNT);
    return changed;
}

static void fm1c_model_slot5(fm1c_model *m, uint32_t k, uint32_t state, uint32_t flags, const char *label,
                             const char *title, const char *age)
{
    fm1c_slot *s = &m->slot[k];
    int32_t sel0 = fm1c_selected(m), sel1;
    int changed = s->state != state || s->flags != flags, row;
    s->state = (uint8_t)state;
    s->flags = (uint8_t)flags;
    changed |= fm1c_str_set(s->label, label, FM1C_L_LABEL);
    row = fm1c_str_set(s->title, title, FM1C_L_ROW);   /* (drawn only in the list: in the buddy layout no mark) */
    row |= fm1c_str_set(s->age, age, FM1C_L_AGE);
    if (fm1c_list(m)) {                         /* the list: this key's row (a moved window: fm1c_list_check) */
        if (!changed && !row) return;
        m->dirty_keys |= 1u << k;
        sel1 = fm1c_selected(m);
        if (sel0 != sel1) m->dirty_rows |= 1u;  /* (the caption names the selected key) */
        return;
    }
    if (!changed) return;
    m->dirty_keys |= 1u << k;
    sel1 = fm1c_selected(m);
    if (fm1c_v4(m)) {                           /* the label beside the hero; the caption names the selected key */
        if (sel0 != sel1 || sel1 == (int32_t)k) m->dirty |= FM1C_D_LABEL4;
        if (sel0 != sel1) m->dirty_rows |= 1u;
        return;
    }
    if (sel0 != sel1 || sel1 == (int32_t)k) m->dirty |= FM1C_D_LABEL;   /* the panel shows the selected slot's label */
}

static void fm1c_model_slot(fm1c_model *m, uint32_t k, uint32_t state, uint32_t flags, const char *label)
{
    fm1c_slot *s = &m->slot[k];
    fm1c_model_slot5(m, k, state, flags, label, s->title, s->age);   /* (a version 1-4 body keeps the row as it is) */
}

static int fm1c_voice_live(const fm1c_model *m) { return m->voice == FM1C_V_RECORDING || m->voice == FM1C_V_TRANSCRIBING; }

/* Version 4 (docs/ui-v3.md sections 3.A and 5): the same messages and fields, marked for the version 4 regions. */
static void fm1c_model_apply4(fm1c_model *m, const fm1c_msg *x, uint32_t now)
{
    uint32_t i;
    int voice_view = m->view == FM1C_VIEW_VOICE, confirm = m->view == FM1C_VIEW_CONFIRM;
    switch (x->type) {
    case FM1C_T_SET_VIEW: {
        uint32_t lay = x->u.view.v5 ? x->u.view.layout : FM1C_LAYOUT_BUDDY;
        uint32_t keys = x->u.view.v6 ? x->u.view.keys : FM1C_KEYS_RANKED;   /* (version 6; absent: ranked) */
        uint32_t tp = keys ? x->u.view.task_page : 0u, tps = keys ? x->u.view.task_pages : 1u;
        uint32_t list0 = fm1c_shape(m), list1;  /* (version 1-5: the layout alone, 0 buddy, 1 list, 2 grouped) */
        uint8_t v0 = m->view, l0 = m->layout, k0 = m->keys;
        m->view = x->u.view.view;
        m->layout = (uint8_t)lay;
        m->keys = (uint8_t)keys;
        list1 = fm1c_shape(m);
        m->view = v0;
        m->layout = l0;
        m->keys = k0;
        if (list0 != list1 ||
            (m->view != x->u.view.view && (m->view == FM1C_VIEW_DETAIL || x->u.view.view == FM1C_VIEW_DETAIL))) {
            fm1c_model_all(m);                  /* into or out of DETAILS, the list, SPLIT or settings: everything */
        } else if (m->view != x->u.view.view) { /* another base view, voice or confirm: all but the keyboard */
            m->dirty |= FM1C_D_STATUS | FM1C_D_HERO | FM1C_D_LABEL4 | FM1C_D_BUBBLE | FM1C_D_HINT4 | FM1C_D_ELAPSED;
            m->dirty |= (list1 & 3u) ? FM1C_D_LIST : 0u;   /* (sessions <-> TO DO, both lists: the rows too) */
            m->dirty_rows = FM1C_ROWS_ALL;
            m->dirty_bars = FM1C_BARS_ALL;
        }
        if (list1 == 8u && list0 == 8u) {       /* version 6 settings: page is the cursor, pages the item count */
            if (m->page != x->u.view.page) m->dirty_rows |= 1u << (m->page < FM1C_SET_ITEMS ? m->page : 0u) |
                                                            1u << (x->u.view.page < FM1C_SET_ITEMS ? x->u.view.page : 0u) | 1u << 9;
            if (m->pages != x->u.view.pages) m->dirty_rows |= (1u << FM1C_SET_ITEMS) - 1u;
        } else if (m->page != x->u.view.page || m->pages != x->u.view.pages) {
            m->dirty |= FM1C_D_STATUS;
        }
        if ((m->task_page != tp || m->task_pages != tps) && (list1 & 4u)) m->dirty |= FM1C_D_BAND;   /* (the dots, the tasks) */
        m->layout = (uint8_t)lay;
        m->view = x->u.view.view;
        m->keys = (uint8_t)keys;
        m->task_page = (uint8_t)tp;
        m->task_pages = (uint8_t)tps;
        m->page = x->u.view.page;
        m->pages = x->u.view.pages;
        if (fm1c_str_set(m->title, x->u.view.title, FM1C_L_TITLE)) m->dirty |= FM1C_D_STATUS;
        break;
    }
    case FM1C_T_SET_SLOT:
        if (fm1c_model_group(&m->slot[x->u.slot.key], x->u.slot.row, x->u.slot.head_state, x->u.slot.head_flags,
                             x->u.slot.head_title, x->u.slot.head_count) && fm1c_grouped(m))
            m->dirty_keys |= 1u << x->u.slot.key;   /* (its header row; a changed entry list: fm1c_list_check) */
        if (x->u.slot.v5)
            fm1c_model_slot5(m, x->u.slot.key, x->u.slot.state, x->u.slot.flags, x->u.slot.label, x->u.slot.title, x->u.slot.age);
        else
            fm1c_model_slot(m, x->u.slot.key, x->u.slot.state, x->u.slot.flags, x->u.slot.label);
        break;
    case FM1C_T_CLEAR_SLOTS:
        for (i = 0; i < FM1C_NSLOT; i++) {
            fm1c_model_group(&m->slot[i], 0, 0, 0, "", "");
            fm1c_model_slot5(m, i, FM1C_S_EMPTY, 0, "", "", "");
        }
        break;
    case FM1C_T_SET_TEXT:                       /* base views: the bubble (rows 0-6); DETAILS: header and body */
        for (i = 0; i < x->u.text.count && i < FM1C_TEXT_PER_FRAME; i++) {
            uint32_t r = x->u.text.row + i;
            int changed;
            if (r >= FM1C_TEXT_ROWS) break;
            changed = m->tstyle[r] != x->u.text.style[i];
            m->tstyle[r] = x->u.text.style[i];
            changed |= fm1c_str_set(m->text[r], x->u.text.text[i], FM1C_L_TEXT_WIRE);
            if (changed) m->dirty_rows |= 1u << r;
        }
        break;
    case FM1C_T_SET_DETAIL:                     /* the character and the bubble's colour; line 1; the hint line */
        if (m->provider != x->u.detail.provider || m->dstate != x->u.detail.state) {
            m->dirty |= FM1C_D_HERO | FM1C_D_BUBBLE;
            m->dirty_rows |= 1u;                /* (the caption, or the DETAILS heading, in the state colour) */
        }
        m->provider = x->u.detail.provider;
        m->dstate = x->u.detail.state;
        for (i = 0; i < 4u; i++) {
            if (!fm1c_str_set(m->line[i], x->u.detail.line[i], FM1C_L_LINE)) continue;
            if (i == 0u) m->dirty |= FM1C_D_LABEL4;                    /* (confirm: the verb is the label) */
            else if (confirm) m->dirty_rows |= 1u << i;                /* (confirm: lines 2-4 in the bubble) */
            else if (i == 3u) m->dirty |= FM1C_D_HINT4;
        }
        break;
    case FM1C_T_SET_VOICE:
        if (m->voice != x->u.voice.voice) {
            if (x->u.voice.voice == FM1C_V_RECORDING) {   /* a new recording: an empty meter */
                for (i = 0; i < FM1C_BARS; i++) m->bar[i] = 0;
                m->bar_n = 0;
                m->dirty_bars = FM1C_BARS_ALL;
            }
            if (voice_view) {
                m->dirty |= FM1C_D_BUBBLE | FM1C_D_ELAPSED;
                m->dirty_rows |= FM1C_ROWS_ALL;
                m->dirty_bars = FM1C_BARS_ALL;
            }
        }
        if (m->elapsed_ds != x->u.voice.elapsed_ds) {
            if (voice_view) m->dirty |= FM1C_D_ELAPSED;
            if (x->u.voice.voice == FM1C_V_RECORDING) {   /* a bar per elapsed step: the meter sweeps left to right */
                m->bar[m->bar_n] = x->u.voice.level > 100u ? 100u : x->u.voice.level;
                m->dirty_bars |= 1u << m->bar_n;
                m->bar_n = (uint8_t)((m->bar_n + 1u) % FM1C_BARS);
                m->dirty_bars |= 1u << m->bar_n;          /* (the gap ahead of the newest bar) */
            }
        }
        m->voice = x->u.voice.voice;
        m->level = x->u.voice.level;
        m->elapsed_ds = x->u.voice.elapsed_ds;
        if (fm1c_str_set(m->target, x->u.voice.target, FM1C_L_LINE) && voice_view) m->dirty |= FM1C_D_LABEL4;
        break;
    case FM1C_T_SET_LEGEND:                     /* no legend: the knob row (2 s after a turn) and the help show it */
        for (i = 0; i < 4u; i++)
            if (fm1c_str_set(m->legend[i], x->u.legend.label[i], FM1C_L_LEGEND) && m->knob_on) m->dirty |= FM1C_D_HINT4;
        break;
    case FM1C_T_SET_STATUS:
        if (m->link != x->u.status.link || m->attention != x->u.status.attention) m->dirty |= FM1C_D_STATUS;
        m->link = x->u.status.link;
        m->attention = x->u.status.attention;
        if (fm1c_str_set(m->status, x->u.status.text, FM1C_L_LINE)) m->dirty |= FM1C_D_STATUS;
        break;
    case FM1C_T_CMD_RESULT:
        m->toast_on = 1;
        m->toast_result = x->u.result.result;
        fm1c_str_set(m->toast, x->u.result.text, FM1C_L_LINE);
        m->toast_until = now + (x->u.result.result == FM1C_R_FAILED || x->u.result.result == FM1C_R_UNAVAILABLE
                                ? FM1C_TOAST_FAIL_MS : m->look >= FM1C_PROTO_V5 ? FM1C_TOAST5_MS : FM1C_TOAST_MS);
        m->dirty |= FM1C_D_HINT4;               /* (every view: the hint bar is at the bottom in all of them) */
        break;
    }
}

/* version 4: the device sent an ENCODER frame for K1-K4 (encoders 2-5): the knob row for 2 s, that knob lit */
static void fm1c_model_knob(fm1c_model *m, uint32_t enc, uint32_t now)
{
    if (!fm1c_v4(m) || enc < 2u || enc > 5u) return;
    m->knob_on = 1;
    m->knob_lit = (uint8_t)(enc - 2u);
    m->knob_until = now + FM1C_KNOB_MS;
    m->dirty |= FM1C_D_HINT4;
}

/* Applies one host message (fm1c_link_rx returned it). now: for the COMMAND_RESULT toast. */
static void fm1c_model_apply(fm1c_model *m, const fm1c_msg *x, uint32_t now)
{
    uint32_t i;
    int voice_view = m->view == FM1C_VIEW_VOICE;
    if (fm1c_v4(m)) { fm1c_model_apply4(m, x, now); return; }
    switch (x->type) {
    case FM1C_T_SET_VIEW:
        if (m->view != x->u.view.view && (m->view == FM1C_VIEW_DETAIL || x->u.view.view == FM1C_VIEW_DETAIL))
            fm1c_model_all(m);                  /* into or out of DETAILS: everything below the status bar too */
        else if (m->view != x->u.view.view) m->dirty |= FM1C_D_STATUS | FM1C_D_PANEL;
        if (m->page != x->u.view.page || m->pages != x->u.view.pages) m->dirty |= FM1C_D_STATUS;
        m->view = x->u.view.view;
        m->page = x->u.view.page;
        m->pages = x->u.view.pages;
        if (fm1c_str_set(m->title, x->u.view.title, FM1C_L_TITLE)) m->dirty |= FM1C_D_STATUS;
        break;
    case FM1C_T_SET_SLOT:
        fm1c_model_slot(m, x->u.slot.key, x->u.slot.state, x->u.slot.flags, x->u.slot.label);
        break;
    case FM1C_T_CLEAR_SLOTS:
        for (i = 0; i < FM1C_NSLOT; i++) fm1c_model_slot(m, i, FM1C_S_EMPTY, 0, "");
        break;
    case FM1C_T_SET_TEXT:                       /* stored in every view, drawn in DETAILS: a changed row alone */
        for (i = 0; i < x->u.text.count && i < FM1C_TEXT_PER_FRAME; i++) {
            uint32_t r = x->u.text.row + i;
            int changed;
            if (r >= FM1C_TEXT_ROWS) break;
            changed = m->tstyle[r] != x->u.text.style[i];
            m->tstyle[r] = x->u.text.style[i];
            changed |= fm1c_str_set(m->text[r], x->u.text.text[i], FM1C_L_TEXT_WIRE);
            if (changed) m->dirty_rows |= 1u << r;
        }
        break;
    case FM1C_T_SET_DETAIL:
        if (m->provider != x->u.detail.provider || m->dstate != x->u.detail.state) m->dirty |= FM1C_D_HEAD;
        m->provider = x->u.detail.provider;
        m->dstate = x->u.detail.state;
        for (i = 0; i < 4u; i++)
            if (fm1c_str_set(m->line[i], x->u.detail.line[i], FM1C_L_LINE) && (!voice_view || fm1c_v2(m)))
                m->dirty |= m->view == FM1C_VIEW_CONFIRM ? FM1C_D_PANEL   /* (confirm: shifted up) */
                            : voice_view && i == 2u ? 0u                  /* (voice: band 4 is the target) */
                            : FM1C_D_LINE(i);
        break;
    case FM1C_T_SET_VOICE:
        if (m->voice != x->u.voice.voice && voice_view)   /* (version 2: lines 1-2 are the bar or the transcript) */
            m->dirty |= FM1C_D_HEAD | FM1C_D_LABEL | (fm1c_v2(m) ? FM1C_D_LINE(0) | FM1C_D_LINE(1) : 0u);
        if (m->level != x->u.voice.level && voice_view) m->dirty |= FM1C_D_LINE(0);
        if (m->elapsed_ds != x->u.voice.elapsed_ds && voice_view) m->dirty |= FM1C_D_LINE(1);
        m->voice = x->u.voice.voice;
        m->level = x->u.voice.level;
        m->elapsed_ds = x->u.voice.elapsed_ds;
        if (fm1c_str_set(m->target, x->u.voice.target, FM1C_L_LINE) && voice_view) m->dirty |= FM1C_D_LINE(2);
        break;
    case FM1C_T_SET_LEGEND:
        for (i = 0; i < 4u; i++)
            if (fm1c_str_set(m->legend[i], x->u.legend.label[i], FM1C_L_LEGEND)) m->dirty |= FM1C_D_LEGEND;
        break;
    case FM1C_T_SET_STATUS:
        if (m->link != x->u.status.link || m->attention != x->u.status.attention) m->dirty |= FM1C_D_STATUS;
        m->link = x->u.status.link;
        m->attention = x->u.status.attention;
        if (fm1c_str_set(m->status, x->u.status.text, FM1C_L_LINE)) m->dirty |= FM1C_D_STATUS;
        break;
    case FM1C_T_CMD_RESULT:
        m->toast_on = 1;
        m->toast_result = x->u.result.result;
        fm1c_str_set(m->toast, x->u.result.text, FM1C_L_LINE);
        m->toast_until = now + (x->u.result.result == FM1C_R_FAILED || x->u.result.result == FM1C_R_UNAVAILABLE
                                ? FM1C_TOAST_FAIL_MS : FM1C_TOAST_MS);
        m->dirty |= fm1c_detail(m) ? FM1C_D_FOOT : FM1C_D_LINE(3);   /* (DETAILS: over the hint band) */
        break;
    }
}

static void fm1c_model_tick(fm1c_model *m, uint32_t now)
{
    if (m->toast_on && (int32_t)(now - m->toast_until) >= 0) {
        m->toast_on = 0;
        m->dirty |= fm1c_v4(m) ? FM1C_D_HINT4 : fm1c_detail(m) ? FM1C_D_FOOT : FM1C_D_LINE(3);
    }
    if (m->knob_on && (int32_t)(now - m->knob_until) >= 0) {
        m->knob_on = 0;
        m->dirty |= FM1C_D_HINT4;
    }
}
