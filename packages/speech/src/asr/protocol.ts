/** NDJSON messages between SherpaParakeetEngine (client) and the ASR worker process. */

export type WorkerRequest =
  | { id: number; op: "load"; modelDir?: string; numThreads?: number }
  | { id: number; op: "transcribe"; pcm: string; sampleRate: number }
  | { id: number; op: "shutdown" };

export interface WorkerStats {
  rssBytes: number;
}

export type WorkerResult =
  | { op: "load"; loadMs: number; alreadyLoaded: boolean }
  | { op: "transcribe"; text: string; ms: number }
  | { op: "shutdown" };

export type WorkerResponse =
  | { id: number; ok: true; result: WorkerResult; stats: WorkerStats }
  | { id: number; ok: false; error: { code: string; message: string } };

export function encodePcm(pcm: Int16Array): string {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");
}

export function decodePcm(b64: string): Int16Array {
  const bytes = Buffer.from(b64, "base64");
  const copy = new Uint8Array(bytes.byteLength - (bytes.byteLength % 2));
  copy.set(bytes.subarray(0, copy.byteLength));
  return new Int16Array(copy.buffer);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function parseRequest(line: string): WorkerRequest {
  const v: unknown = JSON.parse(line);
  if (!isRecord(v) || typeof v.id !== "number") throw new Error("request needs a numeric id");
  switch (v.op) {
    case "load":
      return {
        id: v.id,
        op: "load",
        modelDir: typeof v.modelDir === "string" ? v.modelDir : undefined,
        numThreads: typeof v.numThreads === "number" ? v.numThreads : undefined,
      };
    case "transcribe":
      if (typeof v.pcm !== "string" || typeof v.sampleRate !== "number") throw new Error("transcribe needs pcm and sampleRate");
      return { id: v.id, op: "transcribe", pcm: v.pcm, sampleRate: v.sampleRate };
    case "shutdown":
      return { id: v.id, op: "shutdown" };
    default:
      throw new Error(`unknown op ${String(v.op)}`);
  }
}

export function parseResponse(line: string): WorkerResponse {
  const v: unknown = JSON.parse(line);
  if (!isRecord(v) || typeof v.id !== "number" || typeof v.ok !== "boolean") throw new Error("malformed worker response");
  return v as unknown as WorkerResponse;
}
