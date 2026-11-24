/* SPDX-License-Identifier: GPL-3.0-only */
/* The help overlay (docs/ux-v2.md sections 2.5 and 7.6): what each control does, shown while SCL is held with
 * version 2 or 3 agreed. Rows 24-199 (DETAILS: 24-215), black, one FONT_S line every 16 px from y 26; line 0 amber, the rest white. The status bar and
 * the legend stay visible. The text is picked by the view.
 *
 * The four version 2/3 tables below are also agent-core's HELP_TEXT (packages/agent-core/src/control-map.ts); a host test parses
 * the string literals of FM1C_HELP_BASE / _VOICE / _DETAIL / _CONFIRM from this file and requires them equal, so keep one
 * literal per line and nothing else inside the braces. Every line is at most 29 characters (232 px).
 * Included by fm1c_draw.h. */
#pragma once

static const char *const FM1C_HELP_BASE[11] = {
    "HELP - let go of SCL",
    "key tap   select / open task",
    "key 2x    open on Mac",
    "key hold  pin or unpin",
    "SELECT move  PRESETS scroll",
    "ALGORITHM next needing you",
    "OCT-/OCT+ page  LFO details",
    "SAVE approve  FX deny/dismiss",
    "PLAY open/new chat  ENV stop",
    "REC hold to talk  HOME sort",
    "EDIT tasks  GLO to do",
};

static const char *const FM1C_HELP_VOICE[7] = {
    "HELP - let go of SCL",
    "REC hold    record",
    "REC let go  stop, transcribe",
    "SAVE        send",
    "FX          cancel",
    "PLAY        retry after fail",
    "PRESETS     scroll text",
};

static const char *const FM1C_HELP_DETAIL[10] = {
    "HELP - let go of SCL",
    "PRESETS   next/prev page",
    "OCT-/OCT+ next/prev page",
    "SELECT    next/prev chat",
    "ALGORITHM next needing you",
    "key tap   show that chat",
    "LFO/HOME  close details",
    "SAVE approve  FX deny",
    "ENV stop  PLAY open on Mac",
    "REC hold to talk",
};

static const char *const FM1C_HELP_CONFIRM[4] = {
    "HELP - let go of SCL",
    "SAVE  yes, do it",
    "FX    no, go back",
    "Nothing else acts here.",
};

/* Version 4 (docs/ui-v3.md section 3.A): no legend on the screen any more. The base help is these six lines, then
 * the two knob lines built from SET_LEGEND ("KNOB1 SHOW  KNOB2 REPO", so they name what the knobs do in this view),
 * then the who-is-who grid: each character with FM1C_HELP_WORDS4 (working, waiting, approval, failed, done unread,
 * asleep, no status, offline). DETAILS: FM1C_HELP_DETAIL4. Rows 18-223; the hint bar says FM1C_HELP_HINT4. */
static const char *const FM1C_HELP_BASE4[6] = {
    "HELP - let go of SCL",
    "SELECT move  PRESETS scroll",
    "key tap select  2x open",
    "LFO details  ALGORITHM next",
    "SAVE approve  FX deny",
    "REC hold to talk  ENV stop",
};

/* Version 5 (docs/ui-v3.md section 9.11, replacing section 8.8's table): the base help in every base view, its first
 * line names the SEQ cycle (Buddy -> List -> Grouped); the knob lines and who is who follow as in version 4. */
static const char *const FM1C_HELP_BASE5[6] = {
    "HELP - SEQ buddy/list/group",
    "SELECT move  PRESETS read",
    "key tap sel 2x open hold pin",
    "LFO details  ALGORITHM next",
    "SAVE approve  FX deny",
    "REC hold to talk  ENV stop",
};

/* Version 6 (docs/ui-v3.md section 10.11; agent-core HELP_TEXT.base6 / .split6 / .settings6, byte-equal): BASE6 in the
 * base views while the keys are RANKED (and in TO DO and Tasks), its first line names the settings entry; SPLIT6 in
 * Sessions with SPLIT keys; both followed by the knob lines and who is who as in version 4. SETTINGS6 in view 6 alone
 * (no knob lines, no grid). */
static const char *const FM1C_HELP_BASE6[6] = {
    "HELP - SEQ view  ARP settings",
    "SELECT move  PRESETS read",
    "key tap sel 2x open hold pin",
    "LFO details  ALGORITHM next",
    "SAVE approve  FX deny",
    "REC hold to talk  ENV stop",
};

static const char *const FM1C_HELP_SPLIT6[6] = {
    "HELP - SEQ view  ARP settings",
    "white sel 2x open hold pin",
    "black filter/task hold pin",
    "OCT page/2x task  REC talk",
    "SELECT move  PRESETS read",
    "LFO details  ALGORITHM next",
};

static const char *const FM1C_HELP_SETTINGS6[4] = {
    "HELP - let go of SCL",
    "SELECT    move",
    "SAVE      change",
    "HOME/LFO/ARP  close",
};

static const char *const FM1C_HELP_DETAIL4[10] = {
    "HELP - let go of SCL",
    "PRESETS   older/newer page",
    "OCT-/OCT+ next/prev page",
    "SELECT    next/prev chat",
    "ALGORITHM next needing you",
    "key tap   show that chat",
    "LFO/HOME  close details",
    "SAVE approve  FX deny",
    "ENV stop  PLAY open on Mac",
    "REC hold to talk",
};

static const char *const FM1C_HELP_WORDS4[8] = {
    "Working",
    "Needs answer",
    "Approve?",
    "Failed",
    "Done, unread",
    "Asleep",
    "No status",
    "Offline",
};

static const char FM1C_HELP_HINT4[] = "let go of SCL to close";

#define FM1C_HELP_Y 24u
#define FM1C_HELP_H 176u                        /* rows 24-199 */
#define FM1C_HELP_H_DETAIL 192u                 /* DETAILS: rows 24-215 (the hint band stays) */
#define FM1C_HELP_CHUNK 80u                     /* rows per canvas (CV_MAX is 240 x 80): 80 + 80 + 16 (DETAILS: + 32) */

static void fm1c_draw_help(const fm1c_model *m)
{
    const char *const *t = FM1C_HELP_BASE;
    uint32_t n = 11, y0, i, hh = FM1C_HELP_H;
    if (m->view == FM1C_VIEW_VOICE) { t = FM1C_HELP_VOICE; n = 7; }
    else if (m->view == FM1C_VIEW_CONFIRM) { t = FM1C_HELP_CONFIRM; n = 4; }
    else if (m->view == FM1C_VIEW_DETAIL) { t = FM1C_HELP_DETAIL; n = 10; hh = FM1C_HELP_H_DETAIL; }
    for (y0 = 0; y0 < hh; y0 += FM1C_HELP_CHUNK) {
        uint32_t h = hh - y0 < FM1C_HELP_CHUNK ? hh - y0 : FM1C_HELP_CHUNK;
        cv_begin(240, h, C_BLACK);
        for (i = 0; i < n; i++)                 /* (the canvas clips: a line across two chunks is drawn in both) */
            fm1c_text(4, 2 + 16 * (int32_t)i - (int32_t)y0, &FONT_S, t[i], i ? C_WHITE : FM1C_C_AMBER);
        cv_blit(0, FM1C_HELP_Y + y0);
    }
}
