import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type NativeHelper = "fm1-mic" | "fm1-dictate";

const ENV_OVERRIDE: Record<NativeHelper, string> = { "fm1-mic": "FM1_MIC_BIN", "fm1-dictate": "FM1_DICTATE_BIN" };

/** Path of a Swift helper built by scripts/build-native.sh; env FM1_MIC_BIN / FM1_DICTATE_BIN override it. */
export function nativeHelperPath(name: NativeHelper): string {
  return process.env[ENV_OVERRIDE[name]] ?? fileURLToPath(new URL(`../bin/${name}`, import.meta.url));
}

export function nativeHelperExists(path: string): boolean {
  return existsSync(path);
}

export const BUILD_HINT = "build it with: bun run --cwd packages/speech build:native";
