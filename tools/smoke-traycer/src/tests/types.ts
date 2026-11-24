import type { SmokeContext } from "../context";
import type { SmokeRecord } from "../record";

export interface SmokeTest {
  id: string;
  title: string;
  /** Needs --live (state-changing or paid inference). */
  live: boolean;
  run(ctx: SmokeContext): Promise<SmokeRecord>;
}
