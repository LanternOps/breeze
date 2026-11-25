/**
 * Closed set of AI tool domains (spec 2026-09-17 "Domains"). A tool has
 * exactly ONE domain. Adding a value here is a reviewed spec change: the
 * system-prompt index, Agent SDK tool search hints, MCP `_meta`, and (B-W02)
 * per-grant `mcp_domains` all key on it.
 *
 * `core` is not a subject area: it marks the always-loaded context tools that
 * every surface and every grant includes. `psa` was rejected as a name —
 * `query_psa_status` already uses "PSA" for external ConnectWise-style sync.
 */
export const AI_TOOL_DOMAINS = [
  'core', 'devices', 'scripts', 'patching', 'monitoring', 'network', 'security',
  'backup', 'tickets', 'billing', 'accounts', 'integrations', 'admin', 'ai',
] as const;

export type AiToolDomain = (typeof AI_TOOL_DOMAINS)[number];

export const AI_TOOL_DOMAIN_LABELS: Readonly<Record<AiToolDomain, string>> = {
  core: 'Core',
  devices: 'Devices',
  scripts: 'Scripts & automation',
  patching: 'Patching & software',
  monitoring: 'Monitoring & alerts',
  network: 'Network',
  security: 'Security & compliance',
  backup: 'Backup & recovery',
  tickets: 'Tickets & time',
  billing: 'Billing',
  accounts: 'Accounts',
  integrations: 'Integrations',
  admin: 'Administration',
  ai: 'AI agents',
};

/** Upper bound for `AiTool.searchHint` — one line the model sees in tool search results. */
export const AI_TOOL_SEARCH_HINT_MAX_CHARS = 120;

export function isAiToolDomain(value: unknown): value is AiToolDomain {
  return typeof value === 'string' && (AI_TOOL_DOMAINS as readonly string[]).includes(value);
}

/** A domain a principal can be granted (B-W02 #6156). `core` is never stored: every grant includes it. */
export type McpGrantableDomain = Exclude<AiToolDomain, 'core'>;

/** The 13 non-core domains, in `AI_TOOL_DOMAINS` order. */
export const MCP_GRANTABLE_DOMAINS: readonly McpGrantableDomain[] = AI_TOOL_DOMAINS.filter(
  (d): d is McpGrantableDomain => d !== 'core',
);

/**
 * Which tool list an external MCP client is shown (#12427). `full` is every
 * tool the caller may call; `progressive` is a small core plus the discovery
 * tools. Presentation only: the mode never changes what a call may do.
 */
export const MCP_TOOL_LIST_MODES = ['full', 'progressive'] as const;
export type McpToolListMode = (typeof MCP_TOOL_LIST_MODES)[number];

/** Where a resolved mode came from, most specific first. */
export type McpToolListModeSource = 'request' | 'credential' | 'deployment_default';
export type ResolvedMcpToolListMode = { mode: McpToolListMode; source: McpToolListModeSource };

/**
 * The mode of one user's active connections to one OAuth client. `mixed` when
 * the STORED values differ (an explicit `full` and an inherited `full` are
 * different settings); it is never collapsed into one of them.
 */
export type McpConnectionToolListMode =
  | { kind: 'uniform'; stored: McpToolListMode | null; effective: ResolvedMcpToolListMode; grantCount: number }
  | { kind: 'mixed'; grantCount: number }
  | { kind: 'none'; grantCount: 0 };

/** A partner's read-only summary of one OAuth client; `null` = no active connection. */
export type McpPartnerClientToolListMode = McpToolListMode | 'default' | 'mixed' | null;
