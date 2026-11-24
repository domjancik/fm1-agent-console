export const PAGE_SIZE = 27;

/**
 * Stable slot allocation. A key keeps its index until released; new keys take the lowest free index.
 * Trailing empty slots are trimmed so page count shrinks when the tail empties.
 */
export class SlotTable {
  private slots: (string | null)[] = [];
  private index = new Map<string, number>();

  positionOf(key: string): number | undefined {
    return this.index.get(key);
  }

  /** Assigns in the given order; callers sort for determinism. Already-placed keys are left alone. */
  assign(keys: readonly string[]): void {
    let cursor = 0;
    for (const key of keys) {
      if (this.index.has(key)) continue;
      while (cursor < this.slots.length && this.slots[cursor] !== null) cursor++;
      if (cursor === this.slots.length) this.slots.push(null);
      this.slots[cursor] = key;
      this.index.set(key, cursor);
    }
  }

  release(key: string): void {
    const pos = this.index.get(key);
    if (pos === undefined) return;
    this.slots[pos] = null;
    this.index.delete(key);
    while (this.slots.length > 0 && this.slots[this.slots.length - 1] === null) this.slots.pop();
  }

  keys(): readonly (string | null)[] {
    return this.slots;
  }

  pageCount(): number {
    return Math.max(1, Math.ceil(this.slots.length / PAGE_SIZE));
  }

  page(n: number): (string | null)[] {
    const start = n * PAGE_SIZE;
    return Array.from({ length: PAGE_SIZE }, (_, i) => this.slots[start + i] ?? null);
  }
}
