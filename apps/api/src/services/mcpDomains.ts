/**
 * Per-grant MCP tool domains (B-W02 #6156) — the ONE predicate.
 *
 * An API key or OAuth grant may be limited to a set of tool domains
 * (`mcp_domains`). This module turns the stored value into a grant and
 * answers "may this principal see/use something in domain D?". Every MCP
 * tool and resource path in `routes/mcpServer.ts` calls it IN ADDITION TO the
 * scope tier, approval, MFA, allowlist and RBAC gates — never instead of
 * them. In `tools/call` it runs first (a denied principal learns nothing about
 * the tool's tiers); it only ever adds a denial, so every later gate still
 * runs for anything it lets through. Domain eligibility is not authority.
 *
 * Fail-closed rules:
 *  - Only `null` means unrestricted. `undefined` (a middleware forgot the
 *    field) and any non-array value collapse to core-only and are logged.
 *  - Unknown stored values grant nothing and never widen.
 *  - `core` is always granted; an unclassified tool/resource (`undefined`
 *    domain: extension, bootstrap) is granted only when unrestricted.
 *
 * Pure apart from the `getToolDomain` registry read; no DB access.
 */
import { MCP_GRANTABLE_DOMAINS, type AiToolDomain, type McpGrantableDomain } from '@breeze/shared';
import { getToolDomain } from './aiTools';
import { MCP_WHOAMI_TOOL_NAME } from './aiToolNames';

export type McpDomainGrant =
  | { restricted: false }
  | { restricted: true; domains: ReadonlySet<McpGrantableDomain> };

const GRANTABLE = new Set<string>(MCP_GRANTABLE_DOMAINS);

export function parseStoredMcpDomains(raw: unknown): McpDomainGrant {
  if (raw === null) return { restricted: false };
  if (raw === undefined) {
    console.error('[MCP] principal context missing mcpDomains');
    return { restricted: true, domains: new Set() };
  }
  if (!Array.isArray(raw)) {
    console.error('[MCP] principal context has a non-array mcpDomains; treating as core-only');
    return { restricted: true, domains: new Set() };
  }
  const domains = new Set<McpGrantableDomain>();
  let dropped = 0;
  for (const value of raw) {
    if (typeof value === 'string' && GRANTABLE.has(value)) domains.add(value as McpGrantableDomain);
    else dropped += 1;
  }
  if (dropped > 0) {
    // Fail closed, but loudly: the support symptom is "my key lost its tools".
    console.warn('[MCP] ignored unknown stored mcpDomains values', { dropped, kept: domains.size });
  }
  return { restricted: true, domains };
}

export function isDomainGranted(grant: McpDomainGrant, domain: AiToolDomain | undefined): boolean {
  if (domain === 'core') return true;
  if (!grant.restricted) return true;
  if (domain === undefined) return false;
  return grant.domains.has(domain);
}

/** Domain of an MCP tool by canonical name. `whoami` is core; unknown names are unclassified. */
export function mcpToolDomain(toolName: string): AiToolDomain | undefined {
  if (toolName === MCP_WHOAMI_TOOL_NAME) return 'core';
  return getToolDomain(toolName);
}

/** Tenant (BYO MCP) tools are third-party integrations. */
export const MCP_TENANT_TOOL_DOMAIN: AiToolDomain = 'integrations';

/**
 * MCP resource URI → domain. The patterns mirror `MCP_RESOURCE_PERMISSIONS`
 * in `routes/mcpServer.ts`. The device LIST is core (the same data as the
 * core `query_devices` tool); device DETAIL is `devices`.
 */
const MCP_RESOURCE_DOMAINS: Array<{ pattern: RegExp; domain: AiToolDomain }> = [
  { pattern: /^breeze:\/\/devices$/, domain: 'core' },
  { pattern: /^breeze:\/\/devices\/[0-9a-f-]+$/, domain: 'devices' },
  { pattern: /^breeze:\/\/alerts$/, domain: 'monitoring' },
  { pattern: /^breeze:\/\/scripts$/, domain: 'scripts' },
  { pattern: /^breeze:\/\/automations$/, domain: 'scripts' },
];

export function mcpResourceDomain(uri: string): AiToolDomain | undefined {
  return MCP_RESOURCE_DOMAINS.find((entry) => entry.pattern.test(uri))?.domain;
}

export type DomainNotGrantedError = {
  code: -32003;
  message: string;
  data: { reason: 'domain_not_granted'; domain: AiToolDomain | 'unclassified'; hint: string };
};

/**
 * A denied name can be caller-controlled (a tenant tool is denied on its
 * `<slug>__<name>` shape alone), so it is bounded before it is echoed or
 * written to the audit row.
 */
export const MCP_DENIED_NAME_MAX_CHARS = 128;

export function boundDeniedName(name: string): string {
  return name.length > MCP_DENIED_NAME_MAX_CHARS ? `${name.slice(0, MCP_DENIED_NAME_MAX_CHARS)}…` : name;
}

const DOMAIN_NOT_GRANTED_HINT = 'Call whoami to see granted domains; reconnect or edit the API key to add it.';

export function buildDomainNotGrantedError(
  toolOrUri: string,
  domain: AiToolDomain | undefined,
): DomainNotGrantedError {
  const label = domain ?? 'unclassified';
  return {
    code: -32003,
    message: `Tool "${boundDeniedName(toolOrUri)}" is in the "${label}" domain, which this connection was not granted. ${DOMAIN_NOT_GRANTED_HINT}`,
    data: { reason: 'domain_not_granted', domain: label, hint: DOMAIN_NOT_GRANTED_HINT },
  };
}

/**
 * Lazy form of `isDomainGranted(grant, mcpToolDomain(name))`: an unrestricted
 * grant never consults the registry, so the unrestricted path does exactly
 * the work it did before B-W02.
 */
export function isMcpToolGranted(grant: McpDomainGrant, toolName: string): boolean {
  return !grant.restricted || isDomainGranted(grant, mcpToolDomain(toolName));
}
