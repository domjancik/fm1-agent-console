/* SPDX-License-Identifier: GPL-3.0-only */
/* A tiny check harness for the console's host tests: CHECK counts, prints failures, T_DONE sets the exit code. */
#pragma once
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static int t_pass, t_fail;
#define CHECK(c, ...)                                                       \
    do {                                                                    \
        if (c) t_pass++;                                                    \
        else {                                                              \
            t_fail++;                                                       \
            printf("FAIL %s:%d: ", __FILE__, __LINE__);                     \
            printf(__VA_ARGS__);                                            \
            printf("\n");                                                   \
        }                                                                   \
    } while (0)
#define T_DONE(name)                                                        \
    do {                                                                    \
        printf("%s: %d checks passed, %d failed\n", name, t_pass, t_fail); \
        return t_fail ? 1 : 0;                                              \
    } while (0)
