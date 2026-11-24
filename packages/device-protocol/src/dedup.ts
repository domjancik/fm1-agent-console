import { TIMING } from "./constants";
import type { AckStatus } from "./enums";

interface Entry {
  seq: number;
  checksum: number;
  status: AckStatus;
}

/**
 * The last N received (SEQ, checksum) pairs. A frame matching an entry is a
 * retransmission: re-ACK it with the stored status and do not process it again.
 */
export class DedupWindow {
  private entries: Entry[] = [];

  constructor(private readonly size: number = TIMING.dedupWindow) {}

  lookup(seq: number, checksum: number): AckStatus | undefined {
    return this.entries.find((e) => e.seq === seq && e.checksum === checksum)?.status;
  }

  record(seq: number, checksum: number, status: AckStatus): void {
    this.entries = this.entries.filter((e) => e.seq !== seq);
    this.entries.push({ seq, checksum, status });
    if (this.entries.length > this.size) this.entries.shift();
  }

  clear(): void {
    this.entries = [];
  }
}
