/* SPDX-License-Identifier: GPL-3.0-only */
/* FM1C CC framing (docs/protocol.md section 1): the receiving assembler and the sender's CC stream.
 * Anything that is not a channel-16 CC on the sender's two controllers is ignored. */
#pragma once
#include "fm1c_proto.h"

typedef struct {
    uint8_t buf[FM1C_MAX_FRAME];
    uint8_t ctl, data;                          /* the sender's controllers */
    uint8_t open, overflow;
    uint32_t n;
    uint32_t frames, aborted, overflowed, restarted, stray;
} fm1c_asm;

static void fm1c_asm_init(fm1c_asm *a, uint32_t ctl_cc, uint32_t data_cc)
{
    fm1c_zero(a, sizeof *a);
    a->ctl = (uint8_t)ctl_cc;
    a->data = (uint8_t)data_cc;
}

/* One MIDI message in. Returns the payload length when it closes a frame (a.buf holds it; 0 bytes is possible and
 * decodes as bad_length), else -1. A frame longer than FM1C_MAX_FRAME is dropped at its END. */
static int32_t fm1c_asm_push(fm1c_asm *a, uint32_t st, uint32_t d1, uint32_t d2)
{
    if (st != FM1C_CC_STATUS || d2 > 0x7Fu) return -1;
    if (d1 == a->data) {
        if (!a->open) { a->stray++; return -1; }
        if (a->overflow) return -1;
        if (a->n >= FM1C_MAX_FRAME) { a->overflow = 1; a->overflowed++; return -1; }
        a->buf[a->n++] = (uint8_t)d2;
        return -1;
    }
    if (d1 != a->ctl) return -1;
    if (d2 == FM1C_CTL_START) {
        if (a->open) a->restarted++;
        a->open = 1;
        a->overflow = 0;
        a->n = 0;
    } else if (d2 == FM1C_CTL_END) {
        int32_t done = a->open && !a->overflow ? (int32_t)a->n : -1;
        a->open = 0;
        a->overflow = 0;
        if (done >= 0) a->frames++;
        return done;
    } else if (d2 == FM1C_CTL_ABORT) {
        if (a->open) a->aborted++;
        a->open = 0;
        a->overflow = 0;
    }
    return -1;
}

/* The CC stream of one frame as (controller << 8 | value) words: START, the bytes, END. Returns the count
 * (n + 2); out holds at least FM1C_MAX_FRAME + 2 words. */
static uint32_t fm1c_frame_ccs(const uint8_t *payload, uint32_t n, uint32_t ctl_cc, uint32_t data_cc, uint16_t *out)
{
    uint32_t i, k = 0;
    out[k++] = (uint16_t)(ctl_cc << 8 | FM1C_CTL_START);
    for (i = 0; i < n; i++) out[k++] = (uint16_t)(data_cc << 8 | (payload[i] & 0x7Fu));
    out[k++] = (uint16_t)(ctl_cc << 8 | FM1C_CTL_END);
    return k;
}
