#!/usr/bin/env bash
# Regenerates fixtures/audio with macOS `say` and `afconvert`. No microphone is used.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$(cd "$here/../.." && pwd)/fixtures/audio"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$out"

voice="${FM1_FIXTURE_VOICE:-Samantha}"

speak() { # name rate-hz text
  local name="$1" rate="$2" text="$3"
  say -v "$voice" -o "$tmp/$name.aiff" "$text"
  afconvert -f WAVE -d "LEI16@$rate" -c 1 "$tmp/$name.aiff" "$out/$name.wav"
}

smoke="Open the fm1 agent console repository and rename parse device frame to decode frame comma then run the tests period"
speak smoke-16k 16000 "$smoke"
speak smoke-48k 48000 "$smoke"
speak traycer-16k 16000 "In the tracer adapter add a retry to send message comma and log the session ID period"
speak question-16k 16000 "Can you ask cloud code to fix the null pointer in the voice composer question mark"

bun "$here/scripts/make-silent.ts" "$out/silent-16k.wav"
echo "fixtures written to $out" >&2
ls -l "$out" >&2
