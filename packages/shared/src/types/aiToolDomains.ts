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
