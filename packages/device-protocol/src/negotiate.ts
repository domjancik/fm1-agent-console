import { PROTOCOL_VERSION } from "./constants";

export interface VersionRange {
  min: number;
  max: number;
}

/** The host still accepts version 1 devices (old firmware draws v2 content as plain text). */
export const HOST_VERSIONS: VersionRange = { min: 1, max: PROTOCOL_VERSION };

export interface Negotiation {
  /** Highest common version, or 0 when the ranges do not overlap. */
  proto: number;
  reason: string;
}

export function negotiate(device: VersionRange, host: VersionRange = HOST_VERSIONS): Negotiation {
  const lo = Math.max(device.min, host.min);
  const hi = Math.min(device.max, host.max);
  if (device.min <= device.max && lo <= hi) return { proto: hi, reason: "" };
  const range = `${host.min}-${host.max}`;
  if (device.min > host.max) return { proto: 0, reason: `host too old (${range})` };
  if (device.max < host.min) return { proto: 0, reason: `host too new (${range})` };
  return { proto: 0, reason: "bad device range" };
}
