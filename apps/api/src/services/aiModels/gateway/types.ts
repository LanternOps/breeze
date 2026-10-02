import type { GatewayConnectionKind } from '@breeze/shared';

export type GatewayDialect = 'anthropic' | 'bedrock' | 'vertex' | 'foundry';

/** The `source: 'gateway'` arm of a resolved connection's config. W07 appends cloud arms. */
export type GatewayConnectionConfig = {
  source: 'gateway';
  kind: GatewayConnectionKind;
  partnerId: string;
  connectionId: string;
  configVersion: number;
  baseUrl: string;
};

export interface GatewayCredential {
  /** Decrypted secret, or null for a keyless endpoint. Never serialised, logged or returned. */
  secret: string | null;
}

/** One model a gateway connection's provider listed, already sanitised (openai/discovery.ts). */
export interface DiscoveredConnectionModel {
  modelId: string;
  displayName: string | null;
}

export type GatewayGrantPurpose = 'dispatch' | 'verification' | 'discovery';

interface GatewayGrantInputBase {
  config: GatewayConnectionConfig;
  credential: GatewayCredential;
  /** Exact ids the upstream may be asked for (primary + refusal fallback). */
  wireModels: readonly string[];
  aiSessionId: string | null;
  /** Default GRANT_DEFAULT_TTL_MS; clamped to GRANT_SESSION_TTL_MS. */
  ttlMs?: number;
}

/**
 * A dispatch grant always carries an org: the per-request egress audit row is
 * org-keyed. orgId is null only for partner-level verification/discovery (no
 * egress audit row is written then). grants.ts re-checks this at runtime.
 */
export type GatewayGrantInput = GatewayGrantInputBase & (
  | { purpose: 'dispatch'; orgId: string }
  | { purpose: Exclude<GatewayGrantPurpose, 'dispatch'>; orgId: string | null }
);

export interface GatewayGrant { token: string; baseUrl: string; revoke: () => void }

export interface GatewayGrantRecord {
  id: string;
  config: GatewayConnectionConfig;
  credential: GatewayCredential;
  wireModels: ReadonlySet<string>;
  orgId: string | null;
  aiSessionId: string | null;
  purpose: GatewayGrantPurpose;
  expiresAt: number;
  inFlight: Set<AbortController>;
}

export interface GatewayIncomingRequest {
  method: string;
  /** Path AFTER `/g/<token>`, always starts with '/', query string removed. */
  path: string;
  headers: Readonly<Record<string, string>>;
  body: Buffer;
  signal: AbortSignal;
}

export interface GatewayResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer | AsyncIterable<Uint8Array>;
}

export type AnthropicErrorType =
  | 'invalid_request_error' | 'authentication_error' | 'permission_error' | 'not_found_error'
  | 'request_too_large' | 'rate_limit_error' | 'api_error' | 'overloaded_error';

/** An error the gateway answers with, in the Anthropic error envelope the SDK/CLI understand. */
export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly errorType: AnthropicErrorType,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export function gatewayErrorBody(type: AnthropicErrorType, message: string): string {
  return JSON.stringify({ type: 'error', error: { type, message } });
}
