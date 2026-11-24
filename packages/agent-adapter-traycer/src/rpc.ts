import { randomUUID } from "node:crypto";
import type { FirstPartyClientIdentity } from "@traycer/protocol/framework/client-identity";
import { hostRpcRegistry, type HostRpcRegistry } from "@traycer/protocol/host/registry";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import {
  HostRpcError,
  type HostRequestAuthority,
  type HostRequestOptions,
  type RequestOfMethod,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { DEFAULT_DIAL_TIMEOUT_MS } from "@traycer-clients/shared/host-transport/transport-config";
import { createWhatwgWebSocketFactory } from "@traycer-clients/shared/host-transport/whatwg-ws-factory";
import { WsRpcClient } from "@traycer-clients/shared/host-transport/ws-rpc-client";
import type { CredentialSource } from "./credentials";
import type { HostEndpoint } from "./endpoint";

export type HostMethod = keyof HostRpcRegistry & string;
export type HostRequest<M extends HostMethod> = RequestOfMethod<HostRpcRegistry, M>;
export type HostResponse<M extends HostMethod> = ResponseOfMethod<HostRpcRegistry, M>;

/** The narrow surface the adapter needs; a fake host implements it in tests. */
export interface RpcCaller {
  call<M extends HostMethod>(
    method: M,
    params: HostRequest<M>,
    options?: { readonly idempotencyKey?: string | null; readonly timeoutMs?: number },
  ): Promise<HostResponse<M>>;
}

export interface TraycerRpcOptions {
  readonly endpoint: () => Promise<HostEndpoint>;
  readonly credentials: CredentialSource;
  readonly clientIdentity: FirstPartyClientIdentity;
  readonly frameTimeoutMs?: number;
}

/**
 * Unary RPC over the vendored `WsRpcClient` (one socket per call, per-method
 * version negotiation against the host manifest). Adds the one policy the
 * CLI's auth-aware messenger would otherwise add: on UNAUTHORIZED, delegate
 * the refresh to `traycer whoami`, rotate the lease, retry once.
 */
export class TraycerRpc implements RpcCaller {
  private readonly client: WsRpcClient<HostRpcRegistry>;

  constructor(private readonly options: TraycerRpcOptions) {
    this.client = new WsRpcClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => randomUUID(),
      webSocketFactory: createWhatwgWebSocketFactory(),
      dialTimeoutMs: DEFAULT_DIAL_TIMEOUT_MS,
      frameTimeoutMs: options.frameTimeoutMs ?? 15_000,
      // 0 = fail fast: this caller does not act on post-open attestations.
      hostAttestationWindowMs: 0,
      evidence: NO_TRANSPORT_EVIDENCE,
      clientIdentity: options.clientIdentity,
    });
  }

  async call<M extends HostMethod>(
    method: M,
    params: HostRequest<M>,
    callOptions: { readonly idempotencyKey?: string | null; readonly timeoutMs?: number } = {},
  ): Promise<HostResponse<M>> {
    try {
      return await this.once(method, params, callOptions);
    } catch (error) {
      if (error instanceof HostRpcError && error.code === "UNAUTHORIZED") {
        await this.options.credentials.refresh();
        return this.once(method, params, callOptions);
      }
      throw error;
    }
  }

  private async once<M extends HostMethod>(
    method: M,
    params: HostRequest<M>,
    callOptions: { readonly idempotencyKey?: string | null; readonly timeoutMs?: number },
  ): Promise<HostResponse<M>> {
    const endpoint = await this.options.endpoint();
    const lease = await this.options.credentials.getLease();
    const lifetime = new AbortController();
    const authority: HostRequestAuthority = {
      endpoint: { hostId: endpoint.hostId, websocketUrl: endpoint.websocketUrl },
      bearer: lease,
      abortSignal: lifetime.signal,
    };
    const requestOptions: HostRequestOptions = {
      idempotencyKey: callOptions.idempotencyKey ?? null,
      authority,
      replayMustBeKeyed: false,
      requiredHostMethodVersion: null,
    };
    return callOptions.timeoutMs === undefined
      ? this.client.request(method, params, requestOptions)
      : this.client.requestWithResponseTimeout(
          method,
          params,
          callOptions.timeoutMs,
          requestOptions,
        );
  }
}
