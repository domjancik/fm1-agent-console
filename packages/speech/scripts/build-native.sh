#!/usr/bin/env bash
# Builds the Swift helpers into packages/speech/bin/. Needs Command Line Tools (swiftc) only.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$here/bin"
mkdir -p "$out"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found: install Xcode Command Line Tools (xcode-select --install)" >&2
  exit 1
fi

build() {
  local name="$1"
  shift
  echo "building $name" >&2
  swiftc -O -swift-version 5 -target "$(uname -m)-apple-macos26.0" "$@" -o "$out/$name" "$here/native/$name/main.swift"
}

build fm1-mic
build fm1-dictate -parse-as-library

echo "built: $(ls "$out" | tr '\n' ' ')" >&2
