/**
 * Connection kinds of `partner_ai_connections.kind` (AI model registry, spec §4/§5.2).
 * Mirrors the DB CHECK `partner_ai_connections_kind_chk` and the Drizzle
 * `PARTNER_AI_CONNECTION_KINDS`; W07 (#7605) appends 'bedrock' | 'vertex' | 'foundry'
 * to BOTH arrays here and to the CHECK in its migration.
 *
 * "Gateway" kinds are dispatched through the loopback model gateway
 * (apps/api/src/services/aiModels/gateway): their credentials never leave it.
 * The Anthropic-dialect kinds (anthropic_byok, catalog) keep their direct path.
 */
export const AI_CONNECTION_ROW_KINDS = ['anthropic_byok', 'catalog', 'openai_compatible'] as const;
export type AiConnectionRowKind = (typeof AI_CONNECTION_ROW_KINDS)[number];

export const GATEWAY_CONNECTION_KINDS = ['openai_compatible'] as const;
export type GatewayConnectionKind = (typeof GATEWAY_CONNECTION_KINDS)[number];

const GATEWAY_SET: ReadonlySet<string> = new Set(GATEWAY_CONNECTION_KINDS);
export function isGatewayConnectionKind(kind: string): kind is GatewayConnectionKind {
  return GATEWAY_SET.has(kind);
}

/**
 * Connection kinds reached with a stored Anthropic API key through the Messages
 * API dialect: a direct BYOK key, or the same key through a platform-catalog
 * gateway (AI model registry W08, #7606). These are the kinds the Anthropic
 * connection writes own; cloud kinds (W07) and gateway kinds (W06) have their
 * own write services.
 */
export const ANTHROPIC_API_CONNECTION_KINDS = ['anthropic_byok', 'catalog'] as const;
export type AnthropicApiConnectionKind = (typeof ANTHROPIC_API_CONNECTION_KINDS)[number];

const ANTHROPIC_API_SET: ReadonlySet<string> = new Set(ANTHROPIC_API_CONNECTION_KINDS);
export function isAnthropicApiConnectionKind(kind: string): kind is AnthropicApiConnectionKind {
  return ANTHROPIC_API_SET.has(kind);
}

/**
 * Every connection a partner can see: the implicit platform connection (no row)
 * plus every stored row kind. The `AiConnectionDto.kind` domain.
 */
export const AI_CONNECTION_KINDS = ['platform', ...AI_CONNECTION_ROW_KINDS] as const;
export type AiConnectionKind = (typeof AI_CONNECTION_KINDS)[number];

/**
 * Kinds a turn can dispatch through (eligibility, turn binding): platform, the
 * Anthropic-dialect kinds and the gateway kinds. Today equal to AI_CONNECTION_KINDS;
 * kept separate so a future non-dispatchable row kind stays one edit.
 */
export const AI_DISPATCHABLE_CONNECTION_KINDS = [
  'platform', ...ANTHROPIC_API_CONNECTION_KINDS, ...GATEWAY_CONNECTION_KINDS,
] as const;
export type AiDispatchableConnectionKind = (typeof AI_DISPATCHABLE_CONNECTION_KINDS)[number];

/**
 * Env-bootstrap ownership of a gateway connection (`provider_config`):
 *  - 'managed': kept in sync with MCP_LLM_* (managedBy = 'env');
 *  - 'released': the variables were unset (envReleasedAt set). It still holds
 *    the operator's endpoint and key, so it stays read-only for the partner —
 *    who may only disconnect it — until the bootstrap re-adopts it.
 */
export type EnvManagementState = 'managed' | 'released' | null;

export function envManagementState(providerConfig: Record<string, unknown> | null | undefined): EnvManagementState {
  const cfg = providerConfig as { managedBy?: unknown; envReleasedAt?: unknown } | null | undefined;
  if (cfg?.managedBy !== 'env') return null;
  return typeof cfg.envReleasedAt === 'string' ? 'released' : 'managed';
}

/** The env-state fields of `AiConnectionDto`, derived from an {@link EnvManagementState}. */
export interface AiConnectionEnvFields {
  /** 'env' = bootstrapped from MCP_LLM_*. Read-only for partners (409 managed_by_env). */
  managedBy: 'env' | null;
  /** Env-managed but no longer synced; the partner may only disconnect it. False unless managedBy is 'env'. */
  envReleased: boolean;
}

export function envStateDtoFields(state: EnvManagementState): AiConnectionEnvFields {
  return { managedBy: state === null ? null : 'env', envReleased: state === 'released' };
}

/**
 * A model id on a BYO endpoint: what the provider's /models returns, or what an
 * admin types. Printable, no whitespace, no markup, ≤ 200 chars. Covers Ollama
 * tags (`qwen2.5:7b`), HF paths (`org/model`), OpenRouter (`a/b/c`) and
 * `@version` suffixes.
 */
export const BYO_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
