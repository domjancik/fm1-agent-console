/** Channel downmix and band-limited resampling for 16-bit PCM. */

export function toMono(interleaved: Int16Array, channels: number): Int16Array {
  if (channels === 1) return interleaved;
  const frames = Math.floor(interleaved.length / channels);
  const out = new Int16Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += interleaved[f * channels + c] ?? 0;
    out[f] = Math.round(sum / channels);
  }
  return out;
}

const HALF_TAPS = 16;

function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/** Windowed-sinc (Blackman) resampler. The cutoff follows the lower of the two rates, so downsampling does not alias. */
export function resample(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = toRate / fromRate;
  const cutoff = Math.min(1, ratio);
  const outLength = Math.floor(input.length * ratio);
  const out = new Int16Array(outLength);
  const span = Math.ceil(HALF_TAPS / cutoff);
  for (let i = 0; i < outLength; i++) {
    const center = i / ratio;
    const first = Math.max(0, Math.ceil(center - span));
    const last = Math.min(input.length - 1, Math.floor(center + span));
    let acc = 0;
    let norm = 0;
    for (let j = first; j <= last; j++) {
      const d = j - center;
      const w = 0.42 + 0.5 * Math.cos((Math.PI * d) / span) + 0.08 * Math.cos((2 * Math.PI * d) / span);
      const k = cutoff * sinc(cutoff * d) * w;
      acc += (input[j] ?? 0) * k;
      norm += k;
    }
    const v = norm === 0 ? 0 : acc / norm;
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
  }
  return out;
}
