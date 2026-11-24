import {
  CURRENT_CLIENT_COMPATIBILITY_EPOCH,
  type FirstPartyClientIdentity,
} from "@traycer/protocol/framework/client-identity";

export const ADAPTER_VERSION = "0.1.0";

/** The kind FM-1 prefers to announce on every `open` frame. */
export const FM1_CLIENT_KIND = "fm1-console";
/** First-party fallback if a host ever refuses an unknown kind. */
export const FALLBACK_CLIENT_KIND = "cli";

/**
 * Builds the identity sent on `open`.
 *
 * Upstream types `kind` as the closed first-party union, but the wire schema
 * (`clientHandshakeIdentitySchema`) is an open string and its doc says the kind
 * "never gates admission" - only `compatibilityEpoch` does. The cast is the one
 * place we step outside the upstream type; live-verified against host 1.5.4
 * (see reports/traycer-smoke.md).
 */
export function makeClientIdentity(kind: string): FirstPartyClientIdentity {
  return {
    kind,
    compatibilityEpoch: CURRENT_CLIENT_COMPATIBILITY_EPOCH,
    appVersion: ADAPTER_VERSION,
  } as unknown as FirstPartyClientIdentity;
}
