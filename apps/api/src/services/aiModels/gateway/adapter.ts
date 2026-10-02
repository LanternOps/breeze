import type { GatewayConnectionKind } from '@breeze/shared';
import {
  GatewayError,
  type GatewayConnectionConfig,
  type GatewayDialect,
  type GatewayGrantRecord,
  type GatewayIncomingRequest,
  type GatewayResponse,
} from './types';

/**
 * One adapter per gateway connection kind (W06: openai_compatible; W07: bedrock,
 * vertex, foundry). An adapter speaks its caller-facing dialect (what the Agent
 * SDK child / in-process client sends) and owns the upstream wire format. It must
 * dial ONLY through forwardUpstream (gateway/forward.ts) and must call
 * assertBoundModel on every model the request names before dialling. (For the
 * `anthropic` dialect the server also checks a JSON body's top-level `model`
 * before the adapter runs — defence in depth, not a substitute.)
 */
export interface GatewayAdapter {
  readonly kind: GatewayConnectionKind;
  readonly dialect: GatewayDialect;
  handle(req: GatewayIncomingRequest, grant: GatewayGrantRecord): Promise<GatewayResponse>;
  /** Env for an Agent SDK child that must talk to this connection through `gatewayBaseUrl`. No secrets. */
  sdkChildEnv(input: { gatewayBaseUrl: string; config: GatewayConnectionConfig; wireModel: string }): Record<string, string>;
}

const adapters = new Map<string, GatewayAdapter>();

export function registerGatewayAdapter(adapter: GatewayAdapter): void {
  adapters.set(adapter.kind, adapter);
}

export function getGatewayAdapter(kind: GatewayConnectionKind): GatewayAdapter {
  const a = adapters.get(kind);
  if (!a) throw new Error(`No gateway adapter registered for connection kind ${kind}`);
  return a;
}

export function __resetGatewayAdaptersForTests(): void {
  adapters.clear();
}

/**
 * The bound-model rule: the upstream may only be asked for a
 * model the resolver priced for this dispatch (primary + its refusal fallback).
 */
export function assertBoundModel(grant: GatewayGrantRecord, model: unknown): string {
  if (typeof model !== 'string' || !grant.wireModels.has(model)) {
    throw new GatewayError(403, 'permission_error', 'gateway_model_mismatch',
      'This connection is not authorised for the requested model.');
  }
  return model;
}
