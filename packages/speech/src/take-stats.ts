/**
 * Per-take level statistics for diagnostics: every channel of the raw capture, plus the mono stream that
 * goes to the gate and the ASR engine. Measures only; it never changes the audio.
 */
import { channelLabel, channelOf, type RawAudio } from "./audio/channels";
import { DEFAULT_GATE, measure, type AudioStats } from "./gate";

export interface ChannelStats extends AudioStats {
  label: string;
}

export interface TakeStats {
  durationMs: number;
  /** Raw capture rate and channel count when the raw capture is known, else those of the mono stream. */
  sampleRate: number;
  channels: number;
  /** One entry per raw channel; empty when only the mono stream is known. */
  perChannel: ChannelStats[];
  /** The mono stream as captured for ASR (before the 16 kHz resample). */
  mono: AudioStats & { sampleRate: number };
}

export function takeStats(mono: Int16Array, monoRate: number, raw?: RawAudio, voicedFrameDbfs = DEFAULT_GATE.voicedFrameDbfs): TakeStats {
  const monoStats = { ...measure(mono, monoRate, voicedFrameDbfs), sampleRate: monoRate };
  if (!raw || !Number.isInteger(raw.channels) || raw.channels < 1 || !(raw.sampleRate >= 1)) {
    return { durationMs: monoStats.durationMs, sampleRate: monoRate, channels: 1, perChannel: [], mono: monoStats };
  }
  const perChannel: ChannelStats[] = [];
  for (let c = 0; c < raw.channels; c++) {
    perChannel.push({ label: channelLabel(c, raw.channels), ...measure(channelOf(raw.samples, raw.channels, c), raw.sampleRate, voicedFrameDbfs) });
  }
  const frames = Math.floor(raw.samples.length / raw.channels);
  return { durationMs: (frames / raw.sampleRate) * 1000, sampleRate: raw.sampleRate, channels: raw.channels, perChannel, mono: monoStats };
}
