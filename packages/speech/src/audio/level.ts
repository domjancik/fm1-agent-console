/** Signal level measurements on 16-bit PCM. Levels are full-scale relative (1.0 = 0 dBFS). */

export const SILENCE_DBFS = -120;

export function rms(samples: Int16Array, start = 0, end = samples.length): number {
  const n = end - start;
  if (n <= 0) return 0;
  let sum = 0;
  for (let i = start; i < end; i++) {
    const s = (samples[i] ?? 0) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

export function toDbfs(level: number): number {
  return level <= 0 ? SILENCE_DBFS : Math.max(SILENCE_DBFS, 20 * Math.log10(level));
}

export function peak(samples: Int16Array): number {
  let max = 0;
  for (const s of samples) max = Math.max(max, Math.abs(s));
  return max / 32768;
}

/** RMS of consecutive frames of `frameMs`, in dBFS. */
export function frameLevelsDbfs(samples: Int16Array, sampleRate: number, frameMs: number): number[] {
  const size = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const levels: number[] = [];
  for (let start = 0; start + size <= samples.length; start += size) {
    levels.push(toDbfs(rms(samples, start, start + size)));
  }
  return levels;
}
