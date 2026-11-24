// Forwards prompt delivery stages to the device as COMMAND_RESULTs tied to the SAVE frame that started them.
import { DEFAULT_BACKEND, toastFor, type ComposerState, type DeliveryStage } from "@fm1/agent-core";

export interface StageRecord {
  stage: DeliveryStage;
  at: number;
  message: string | null;
}

export type StageSink = (reqSeq: number, stage: DeliveryStage, text: string) => void;

/**
 * Voice delivery toast: Queued / Sent / Delivered / Done, `Queued, undelivered` for `sent` with a reason (delivery not
 * observed), or the failure reason (docs/ux-v2.md section 1.5). `backend` names the backend in `<name> offline`.
 */
export const stageText = (stage: DeliveryStage, message: string | null, backend: string = DEFAULT_BACKEND): string => toastFor(stage, message, "voice", backend);

interface RequestTrack {
  stages: StageRecord[];
  /** SEQ of the device frame the stages are reported against (undefined until bound). */
  reqSeq?: number;
  /** How many stages have been reported to the device. */
  reported: number;
}

export class StageRelay {
  private tracks = new Map<string, RequestTrack>();
  private lastRequest: string | null = null;

  constructor(
    private readonly sink: StageSink,
    private readonly now: () => number,
    private readonly backend: string = DEFAULT_BACKEND,
  ) {}

  /** Feed every composer state change. */
  observe(s: ComposerState): void {
    if (s.requestId === null || s.stage === null) return;
    this.lastRequest = s.requestId;
    const t = this.track(s.requestId);
    if (t.stages.at(-1)?.stage === s.stage) return;
    t.stages.push({ stage: s.stage, at: this.now(), message: s.error });
    this.flush(t);
  }

  /** Ties a request to the device frame that submitted it and reports stages not yet reported. */
  bind(requestId: string, reqSeq: number): void {
    const t = this.track(requestId);
    t.reqSeq = reqSeq;
    this.flush(t);
  }

  stages(requestId: string | null = this.lastRequest): StageRecord[] {
    return requestId === null ? [] : [...(this.tracks.get(requestId)?.stages ?? [])];
  }

  get currentRequest(): string | null {
    return this.lastRequest;
  }

  private track(id: string): RequestTrack {
    let t = this.tracks.get(id);
    if (!t) {
      t = { stages: [], reported: 0 };
      this.tracks.set(id, t);
    }
    return t;
  }

  private flush(t: RequestTrack): void {
    if (t.reqSeq === undefined) return;
    for (const r of t.stages.slice(t.reported)) this.sink(t.reqSeq, r.stage, stageText(r.stage, r.message, this.backend));
    t.reported = t.stages.length;
  }
}
