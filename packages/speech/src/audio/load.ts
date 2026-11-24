import { resample, toMono } from "./resample";
import { decodeWav } from "./wav";

export const ASR_SAMPLE_RATE = 16000;

export interface LoadedAudio {
  pcm: Int16Array;
  sampleRate: number;
  sourceSampleRate: number;
  sourceChannels: number;
}

/** Reads a WAV file and returns 16 kHz mono PCM ready for the gate and the ASR engine. */
export async function loadWavFor16k(path: string): Promise<LoadedAudio> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const wav = decodeWav(bytes);
  const mono = toMono(wav.samples, wav.channels);
  return {
    pcm: resample(mono, wav.sampleRate, ASR_SAMPLE_RATE),
    sampleRate: ASR_SAMPLE_RATE,
    sourceSampleRate: wav.sampleRate,
    sourceChannels: wav.channels,
  };
}
