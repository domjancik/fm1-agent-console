// Writes a 3 s, 16 kHz "silent" fixture: low-level deterministic noise around -60 dBFS
// with two brief clicks, like a real recording where nobody spoke.
import { encodeWav } from "../src/audio/wav.ts";

const [out] = Bun.argv.slice(2);
if (!out) throw new Error("usage: make-silent.ts <out.wav>");

const rate = 16000;
const samples = new Int16Array(rate * 3);
let seed = 12345;
const random = (): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff - 0.5;
};
for (let i = 0; i < samples.length; i++) samples[i] = Math.round(random() * 60);
for (const at of [8000, 30000]) {
  for (let i = 0; i < 160; i++) samples[at + i] = Math.round(Math.sin(i / 3) * 3000 * (1 - i / 160));
}
await Bun.write(out, encodeWav(samples, rate));
