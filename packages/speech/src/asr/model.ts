import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AsrError } from "./engine";

export const PARAKEET_REPO = "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";

export interface ParakeetModelFiles {
  dir: string;
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
}

function hubCacheDir(env: NodeJS.ProcessEnv): string {
  if (env.HF_HUB_CACHE) return env.HF_HUB_CACHE;
  if (env.HF_HOME) return join(env.HF_HOME, "hub");
  return join(homedir(), ".cache", "huggingface", "hub");
}

/** Resolves the snapshot directory through refs/main, so no snapshot hash is hard-coded. */
function snapshotDir(env: NodeJS.ProcessEnv): string | undefined {
  const repoDir = join(hubCacheDir(env), `models--${PARAKEET_REPO.replace("/", "--")}`);
  const ref = join(repoDir, "refs", "main");
  if (!existsSync(ref)) return undefined;
  return join(repoDir, "snapshots", readFileSync(ref, "utf8").trim());
}

function pick(dir: string, names: readonly string[]): string | undefined {
  return names.map((n) => join(dir, n)).find((p) => existsSync(p));
}

/** Finds the Parakeet v3 files. `FM1_ASR_MODEL_DIR` overrides the Hugging Face cache lookup. */
export function locateParakeetModel(env: NodeJS.ProcessEnv = process.env): ParakeetModelFiles {
  const dir = env.FM1_ASR_MODEL_DIR ?? snapshotDir(env);
  const hint =
    `download it with: hf download ${PARAKEET_REPO} ` +
    `(or set FM1_ASR_MODEL_DIR to a directory with encoder/decoder/joiner .onnx and tokens.txt)`;
  if (!dir || !existsSync(dir)) throw new AsrError("model_missing", `Parakeet model not found; ${hint}`);
  const encoder = pick(dir, ["encoder.int8.onnx", "encoder.onnx"]);
  const decoder = pick(dir, ["decoder.int8.onnx", "decoder.onnx"]);
  const joiner = pick(dir, ["joiner.int8.onnx", "joiner.onnx"]);
  const tokens = pick(dir, ["tokens.txt"]);
  if (!encoder || !decoder || !joiner || !tokens) {
    throw new AsrError("model_missing", `incomplete Parakeet model in ${dir}; ${hint}`);
  }
  return { dir, encoder, decoder, joiner, tokens };
}
