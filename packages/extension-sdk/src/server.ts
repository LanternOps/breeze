import type { Hono } from 'hono';

export interface ExtensionJobDefinition {
  name: string;
  cron: string;
  handler: () => Promise<void>;
}

export interface ExtensionAiTool {
  definition: { name: string; description: string; input_schema: Record<string, unknown> };
  tier: 1 | 2 | 3 | 4;
  handler: (input: Record<string, unknown>, auth: unknown) => Promise<string>;
  deviceArgs?: readonly string[];
}

export interface ExtensionRegistrar {
  mountRoute(app: Hono): void;
  registerJob(job: ExtensionJobDefinition): void;
  registerAiTool(name: string, tool: ExtensionAiTool): void;
}

/**
 * Outcome codes an extension can branch on. Anything else is an unexpected error.
 *
 * `not_configured` is deliberately distinct from `ai_unavailable`: it means the
 * deployment has no AI provider at all (no platform key, no partner BYOK key) —
 * the normal self-hosted shape — so a feature should DEGRADE (skip the AI step)
 * rather than fail and retry. `ai_unavailable` means a provider was configured
 * but is not usable right now (broken/rejected BYOK key, provider outage), which
 * must stay visible instead of silently falling back to another billing source.
 */
export type ExtensionAiErrorCode =
  | 'ai_unavailable'
  | 'not_configured'
  | 'budget_exceeded'
  | 'rate_limited';

export class ExtensionAiError extends Error {
  constructor(
    public readonly code: ExtensionAiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExtensionAiError';
  }
}

export interface ExtensionAiInvokeInput {
  orgId: string;
  /** Stable surface tag for audit/cost attribution, e.g. 'workspace_enrichment'. */
  surface: string;
  /** Acting principal, for rate limiting + audit. 'system' for host-triggered runs. */
  principal: { type: 'user' | 'agent' | 'system'; id: string | null };
  system?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  maxTokens: number;
  /** Optional model override; must be a platform-priced model id. Host default applies when omitted. */
  model?: string;
}

export interface ExtensionAiInvokeResult {
  text: string; // concatenated text blocks of the response
  model: string;
  billingSource: 'platform' | 'partner_key';
  usage: { inputTokens: number; outputTokens: number };
}

export interface ExtensionAiContext {
  /**
   * Metered LLM call: the host resolves the org's provider (partner BYOK or
   * platform), enforces rate limits and org budget, performs the call, and
   * records usage BEFORE resolving. Throws ExtensionAiError for expected
   * failure modes; never falls back across billing sources.
   */
  invoke(input: ExtensionAiInvokeInput): Promise<ExtensionAiInvokeResult>;
}

export interface ExtensionRuntimeContext {
  db: Record<string, unknown> & { execute(query: unknown): Promise<unknown> };
  secrets: {
    encryptForColumn(table: string, column: string, plaintext: string): string;
    decryptForColumn(table: string, column: string, ciphertext: string): string;
  };
  audit(event: Record<string, unknown>): Promise<void>;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>): void;
  config: Readonly<Record<string, unknown>>;
  tenancy: {
    /**
     * The org ids this extension is currently activated for (enabled installs
     * only) — the set a background sweep should iterate instead of enumerating
     * tenants itself. Fresh host-side read per call, in the HOST's system
     * scope; the extension never self-elevates.
     *
     * Throws for `installScope: "server"` extensions (there is no per-org
     * install set) and on any read failure — an unreadable set must never be
     * mistaken for an empty one. `[]` always means "activated for no orgs".
     */
    installedOrgs(): Promise<string[]>;
  };
  /** Optional metered LLM invocation capability — older hosts may not provide it. */
  ai?: ExtensionAiContext;
}

export interface BreezeExtensionV1 {
  register(registrar: ExtensionRegistrar, context: ExtensionRuntimeContext): void | Promise<void>;
}
