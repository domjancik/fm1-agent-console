/** Channel access on interleaved 16-bit PCM (per-channel diagnostics and offline experiments). */
import { toMono } from "./resample";

/** Raw capture as the input device delivered it: interleaved, all channels, input sample rate. */
export interface RawAudio {
  samples: Int16Array;
  sampleRate: number;
  channels: number;
}

/** One channel of interleaved PCM (0-based). */
export function channelOf(interleaved: Int16Array, channels: number, index: number): Int16Array {
  if (!Number.isInteger(channels) || channels < 1) throw new RangeError(`invalid channel count: ${channels}`);
  if (index < 0 || index >= channels) throw new RangeError(`channel ${index} out of range (${channels} channels)`);
  if (channels === 1) return interleaved;
  const frames = Math.floor(interleaved.length / channels);
  const out = new Int16Array(frames);
  for (let f = 0; f < frames; f++) out[f] = interleaved[f * channels + index] ?? 0;
  return out;
}

/** "L" = channel 1, "R" = channel 2, "mix" = the average of all channels (toMono). */
export type ChannelPick = "L" | "R" | "mix";

export function isChannelPick(v: unknown): v is ChannelPick {
  return v === "L" || v === "R" || v === "mix";
}

export function pickChannel(interleaved: Int16Array, channels: number, pick: ChannelPick): Int16Array {
  if (pick === "mix") return toMono(interleaved, channels);
  const index = pick === "L" ? 0 : 1;
  if (index >= channels) throw new RangeError(`channel ${pick} needs at least ${index + 1} channels; the audio has ${channels}`);
  return channelOf(interleaved, channels, index);
}

/** "L"/"R" for stereo, "M" for mono, "ch1".."chN" otherwise. */
export function channelLabel(index: number, channels: number): string {
  if (channels === 1) return "M";
  if (channels === 2) return index === 0 ? "L" : "R";
  return `ch${index + 1}`;
}
