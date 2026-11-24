import { CAPABILITY_NAMES, type AdapterCapabilities, type Capability, type CapabilityName } from "./types";

export function capabilitiesFrom(
  base: Capability,
  overrides: Partial<Record<CapabilityName, Capability>> = {},
): AdapterCapabilities {
  const entries = CAPABILITY_NAMES.map((name) => [name, overrides[name] ?? base] as const);
  return Object.fromEntries(entries) as AdapterCapabilities;
}

export const allSupported = (verified: Capability["verified"] = "code"): AdapterCapabilities =>
  capabilitiesFrom({ supported: true, verified });

export const noneSupported = (reason = "not implemented"): AdapterCapabilities =>
  capabilitiesFrom({ supported: false, reason, verified: "none" });

export function supports(caps: AdapterCapabilities, name: CapabilityName): boolean {
  return caps[name].supported;
}
