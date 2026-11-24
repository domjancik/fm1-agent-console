// .fwsc interleave: the first N blocks of 0x2F data bytes are each followed by one marker byte that
// spells the package identity (char i = marker_i - i - 1; 0x7D = no character). Port of
// fm1_install.py identity_blocks / block_count / logical_image / deinterleave / product_of.
import { ufwDamage } from "./ufw";

export const BLOCKS = 20;
export const BLK = 0x30;
export const KEEP = 0x2f;
const MAX_BLOCKS = 64;
const NO_CHAR = 0x7d;

export class FwscError extends Error {}

const marker = (raw: Uint8Array, k: number): number | undefined =>
  (k + 1) * BLK <= raw.length ? raw[k * BLK + KEEP] : undefined;

const idChar = (m: number, i: number): boolean => {
  const c = (m - i - 1) & 0xff;
  return c >= 0x20 && c < 0x7f;
};

function identityBlocks(raw: Uint8Array): number {
  let n = BLOCKS;
  for (let m = marker(raw, n); n < MAX_BLOCKS && m !== undefined && m !== NO_CHAR && idChar(m, n); m = marker(raw, n)) n++;
  return n > BLOCKS && marker(raw, n) === NO_CHAR ? n : BLOCKS;
}

function blockCount(raw: Uint8Array): number {
  let n = identityBlocks(raw);
  while (n < MAX_BLOCKS && (n + 1) * BLK <= raw.length && raw[n * BLK + KEEP] === NO_CHAR) n++;
  return n;
}

export function logicalImage(raw: Uint8Array, blocks = BLOCKS): Uint8Array {
  const out = new Uint8Array(raw.length - blocks);
  for (let i = 0; i < blocks; i++) out.set(raw.subarray(i * BLK, i * BLK + KEEP), i * KEEP);
  out.set(raw.subarray(blocks * BLK), blocks * KEEP);
  return out;
}

export interface Deinterleaved {
  image: Uint8Array;
  blocks: number;
  identity: string;
}

export function deinterleave(raw: Uint8Array): Deinterleaved {
  if (raw.length < BLOCKS * BLK) throw new FwscError(`not an FM-1 package: ${raw.length} B, shorter than ${BLOCKS * BLK} B`);
  let blocks = blockCount(raw);
  let image = logicalImage(raw, blocks);
  if (blocks !== BLOCKS && ufwDamage(image)) {
    const alt = logicalImage(raw, BLOCKS);
    if (!ufwDamage(alt)) {
      image = alt;
      blocks = BLOCKS;
    }
  }
  const ib = identityBlocks(raw);
  const n = ib === BLOCKS ? BLOCKS : Math.min(ib, blocks);
  let identity = "";
  for (let i = 0; i < n; i++) {
    const m = raw[i * BLK + KEEP];
    if (m !== undefined && m !== NO_CHAR) identity += String.fromCharCode((m - i - 1) & 0xff);
  }
  return { image, blocks, identity };
}

export interface IdentityParts {
  model: string;
  number: number;
}

export function parseIdentity(text: string): IdentityParts | null {
  const m = /^([^_]+)_(\d+)$/.exec(text);
  return m?.[1] && m[2] ? { model: m[1], number: Number(m[2]) } : null;
}
