#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
"""fixtures/device/vectors.json (written by packages/device-protocol) -> a C header for vectors_test.c.

  python3 tests/console/gen_vectors.py ../fixtures/device/vectors.json build/console/vectors.h

Each valid case becomes its payload, its MIDI and the fm1c_msg the C codec must decode it to (the "decoded" value
where the sender sanitised a string, else "message"). Each invalid case keeps its payload and expected error. Each negotiation case: the two version ranges and the
version the host must pick (docs/ux-v2.md section 4)."""
import json
import sys

BUTTONS = ["OCT_DOWN", "OCT_UP", "FX", "SEL", "ENV", "LFO", "EDIT", "GLO", "HOME", "SAVE", "ARP", "SEQ", "PLAY", "REC"]
EDGES = ["up", "down"]
GESTURES = ["single", "double", "long", "down", "up"]          # wire 1..5
ENCODERS = ["SELECT", "ALGORITHM", "K1", "K2", "K3", "K4", "PRESETS"]
POTS = ["MASTER"]
ACKS = ["ok", "unknown_type", "bad_body", "busy"]
VIEWS = ["sessions", "tasks", "inbox", "voice", "confirm", "detail", "settings"]   # settings: version 6
LAYOUTS = ["buddy", "list", "grouped"]                                    # SET_VIEW.layout (version 5)
KEYS = ["ranked", "split"]                                                # SET_VIEW.keys (version 6)
STYLES = ["body", "heading", "muted"]                         # SET_TEXT row styles (version 3)
STATES = ["empty", "disconnected", "idle", "working", "waiting_input", "approval_required", "completed_unread",
          "completed_read", "failed", "unknown"]
PROVIDERS = ["none", "claude", "codex", "other"]
VOICES = ["ready", "recording", "transcribing", "reviewing", "submitting", "delivered", "cancelled", "failed",
          "target_unavailable"]
LINKS = ["ok", "backend_degraded", "backend_down"]
RESULTS = ["accepted_locally", "sent", "acknowledged", "completed", "failed", "unsupported", "target_unavailable"]
ERRORS = {"bad_length": "FM1C_E_BAD_LENGTH", "not_7bit": "FM1C_E_NOT_7BIT", "len_too_large": "FM1C_E_LEN_TOO_LARGE",
          "bad_checksum": "FM1C_E_BAD_CHECKSUM", "unknown_type": "FM1C_E_UNKNOWN_TYPE", "bad_body": "FM1C_E_BAD_BODY"}


def cstr(s):
    """a C string literal; anything outside printable ASCII as a 3-digit octal escape (UTF-8 bytes)"""
    out = []
    for b in s.encode("utf-8"):
        c = chr(b)
        if c in '\\"':
            out.append("\\" + c)
        elif 0x20 <= b <= 0x7E:
            out.append(c)
        else:
            out.append("\\%03o" % b)
    return '"' + "".join(out) + '"'


def ascii_only(s):
    return all(0x20 <= ord(c) <= 0x7E for c in s)


def text_row_ok(s):
    """a SET_TEXT row the C encoder sends unchanged (version 7): printable ASCII or 0x01-0x04, <= 29 visible
    (printable or 0x04), <= 8 style bytes"""
    vis = sum(1 for c in s if 0x20 <= ord(c) <= 0x7E or ord(c) == 4)
    marks = sum(1 for c in s if 1 <= ord(c) <= 3)
    return all(0x20 <= ord(c) <= 0x7E or 1 <= ord(c) <= 4 for c in s) and vis <= 29 and marks <= 8


def body(m):
    """(type constant, union initializer, the strings in it) for a message object"""
    k = m["kind"]
    if k == "HELLO":
        return "FM1C_T_HELLO", ".hello = {%d, %d, %d, %d, %d, %d}" % (
            m["protoMin"], m["protoMax"], m["fwMajor"], m["fwMinor"], m["fwPatch"], m["bootId"]), []
    if k == "BUTTON":
        return "FM1C_T_BUTTON", ".button = {%d, %d}" % (BUTTONS.index(m["button"]), EDGES.index(m["edge"])), []
    if k == "KEY":
        return "FM1C_T_KEY", ".key = {%d, %d}" % (m["key"], GESTURES.index(m["gesture"]) + 1), []
    if k == "ENCODER":
        return "FM1C_T_ENCODER", ".enc = {%d, %d}" % (ENCODERS.index(m["encoder"]), m["delta"]), []
    if k == "POT":
        return "FM1C_T_POT", ".pot = {%d, %d}" % (POTS.index(m["pot"]), m["value"]), []
    if k == "HEARTBEAT":
        if m["from"] == "device":
            return "FM1C_T_DEV_HB", ".dhb = {%d, %d}" % (m["uptimeS"], m["rxErrors"]), []
        return "FM1C_T_HOST_HB", ".hhb = {%d}" % m["hostUptimeS"], []
    if k == "ACK":
        t = "FM1C_T_DEV_ACK" if m["from"] == "device" else "FM1C_T_HOST_ACK"
        return t, ".ack = {%d, %d}" % (m["ackedSeq"], ACKS.index(m["status"])), []
    if k == "HELLO_ACK":
        return "FM1C_T_HELLO_ACK", ".hello_ack = {%d, %d, %s}" % (m["proto"], m["hostSession"], cstr(m["reason"])), [m["reason"]]
    if k == "SET_VIEW":
        v5 = ", %d, 1" % LAYOUTS.index(m["layout"]) if "layout" in m else ", 0, 0"   # version 5: the layout byte
        if "keys" in m:                         # version 6: the keys byte, with split the task page and the count
            v6 = ", %d, %d, %d, 1" % (KEYS.index(m["keys"]), m.get("taskPage", 0), m.get("taskPages", 0))
        else:
            v6 = ", 0, 0, 0, 0"
        return "FM1C_T_SET_VIEW", ".view = {%d, %d, %d, %s%s%s}" % (
            VIEWS.index(m["view"]), m["page"], m["pages"], cstr(m["title"]), v5, v6), [m["title"]]
    if k == "SET_SLOT":
        f = m["flags"]
        bits = (1 if f["selected"] else 0) | (2 if f["codex"] else 0) | (4 if f["stale"] else 0) | (8 if f["pinned"] else 0) \
            | (16 if f.get("chosen") else 0)        # bit 4 chosen: version 6
        if "title" in m:                        # version 5: the row's title and age
            g, gs = "", []
            if "row" in m:                      # version 5 grouped: the row byte and the group's header
                r = m["row"]
                rb = r["indent"] | (4 if r["start"] else 0) | (8 if r["task"] else 0)
                h = m.get("head")
                if h:
                    g = ", %d, %d, %d, %s, %s, 1" % (rb, STATES.index(h["state"]), 1 if h["pinned"] else 0,
                                                    cstr(h["title"]), cstr(h["count"]))
                    gs = [h["title"], h["count"]]
                else:
                    g = ", %d, 0, 0, \"\", \"\", 1" % rb
            g = g or ', 0, 0, 0, "", "", 0'
            return "FM1C_T_SET_SLOT", ".slot = {%d, %d, %d, %s, %s, %s, 1%s}" % (
                m["key"], STATES.index(m["state"]), bits, cstr(m["label"]), cstr(m["title"]), cstr(m["age"]), g), \
                [m["label"], m["title"], m["age"]] + gs
        return "FM1C_T_SET_SLOT", ".slot = {%d, %d, %d, %s, \"\", \"\", 0, 0, 0, 0, \"\", \"\", 0}" % (
            m["key"], STATES.index(m["state"]), bits, cstr(m["label"])), [m["label"]]
    if k == "SET_DETAIL":
        return "FM1C_T_SET_DETAIL", ".detail = {%d, %d, {%s}}" % (
            PROVIDERS.index(m["provider"]), STATES.index(m["state"]), ", ".join(cstr(x) for x in m["lines"])), m["lines"]
    if k == "SET_VOICE":
        return "FM1C_T_SET_VOICE", ".voice = {%d, %d, %d, %s}" % (
            VOICES.index(m["voice"]), m["level"], m["elapsedDs"], cstr(m["target"])), [m["target"]]
    if k == "SET_LEGEND":
        return "FM1C_T_SET_LEGEND", ".legend = {{%s}}" % ", ".join(cstr(x) for x in m["labels"]), m["labels"]
    if k == "SET_STATUS":
        return "FM1C_T_SET_STATUS", ".status = {%d, %d, %s}" % (
            LINKS.index(m["link"]), m["attentionCount"], cstr(m["text"])), [m["text"]]
    if k == "COMMAND_RESULT":
        return "FM1C_T_CMD_RESULT", ".result = {%d, %d, %s}" % (
            m["reqSeq"], RESULTS.index(m["result"]), cstr(m["text"])), [m["text"]]
    if k == "SET_TEXT":
        ls = m["lines"]
        styles = ", ".join(str(STYLES.index(x["style"])) for x in ls) or "0"
        texts = ", ".join(cstr(x["text"]) for x in ls) or '""'
        return "FM1C_T_SET_TEXT", ".text = {%d, %d, {%s}, {%s}}" % (m["row"], len(ls), styles, texts), \
            [x["text"] for x in ls]
    if k == "CLEAR_SLOTS":
        return "FM1C_T_CLEAR_SLOTS", ".hhb = {0}", []
    raise SystemExit("unknown kind " + k)


def msg_init(m, seq, ck):
    t, u, strs = body(m)
    init = "{%s, %d, %d, {%s}}" % (t, seq, ck, u)
    return init, strs


def main():
    src, dst = sys.argv[1], sys.argv[2]
    data = json.load(open(src))
    if data.get("protocol") != 1:
        raise SystemExit("vectors.json: protocol %r, this generator knows 1" % data.get("protocol"))
    out = ["/* generated by tests/console/gen_vectors.py from fixtures/device/vectors.json (%s): do not edit */"
           % data.get("checksum", "?"), "#pragma once", ""]
    valid = []
    for i, v in enumerate(data["valid"]):
        p = v["payload"]
        out.append("static const uint8_t VP%d[] = {%s};" % (i, ", ".join(map(str, p))))
        out.append("static const uint8_t VM%d[][3] = {%s};" % (i, ", ".join("{%d, %d, %d}" % tuple(x) for x in v["midi"])))
        expect, _ = msg_init(v.get("decoded", v["message"]), v["seq"], p[-1])
        src_msg, strs = msg_init(v["message"], v["seq"], p[-1])
        # a non-ASCII string (C sanitises bytes, TS characters) or one longer than its C field: encode "decoded" only
        if v["message"]["kind"] == "SET_TEXT":  # version 7: control bytes 0x01-0x04 in a row
            encodable = all(text_row_ok(s) for s in strs) and "decoded" not in v
        else:
            encodable = all(ascii_only(s) and len(s) <= 20 for s in strs) and "decoded" not in v
        if not encodable:
            src_msg = expect
        valid.append('    {"%s", %d, %d, VP%d, %d, VM%d, %d, %s, %s, %d},' % (
            v["name"], 1 if v["direction"] == "device_to_host" else 2, v["seq"], i, len(p), i, len(v["midi"]),
            expect, src_msg, 1 if encodable else 0))
    out += ["", "static const vec_valid VALID[] = {"] + valid + ["};", ""]
    inv = []
    for i, v in enumerate(data["invalid"]):
        p = v["payload"]
        out.append("static const uint8_t IP%d[] = {%s};" % (i, ", ".join(map(str, p)) or "0"))
        sender = {"device": "FM1C_FROM_DEVICE", "host": "FM1C_FROM_HOST"}.get(v.get("sender"), "FM1C_FROM_ANY")
        inv.append('    {"%s", IP%d, %d, %s, %s},' % (v["name"], i, len(p), sender, ERRORS[v["expectedError"]]))
    out += ["", "static const vec_invalid INVALID[] = {"] + inv + ["};", ""]
    neg = ['    {"%s", %d, %d, %d, %d, %d},' % (v["name"], v["device"]["min"], v["device"]["max"], v["host"]["min"],
                                             v["host"]["max"], v["proto"]) for v in data.get("negotiation", [])]
    out += ["", "static const vec_neg NEGOTIATION[] = {"] + (neg or ['    {"none", 1, 1, 1, 1, 1},']) + ["};",
            "#define N_NEGOTIATION %d" % len(neg), ""]
    open(dst, "w").write("\n".join(out))
    print("%s: %d valid, %d invalid, %d negotiation" % (dst, len(valid), len(inv), len(neg)))


if __name__ == "__main__":
    main()
