/**
 * `whoami` — the MCP server-intrinsic capability tool (B-W02 #6156, #2550).
 *
 * Tells an MCP client what THIS connection is: who it acts as, its tenant
 * scope, its effective scopes, its tool domains, and which kinds of action
 * need the Breeze web app. Server-intrinsic because it needs the MCP principal
 * context, which registry tool handlers never receive. Tier 1, domain `core`:
 * listed for every principal, including a core-only grant.
 *
 * Pure: the route passes in everything it already computed. No DB read, and
 * never a secret — no key hash, raw key, JWT, refresh-token id or grant
 * payload. Ids and names are ones the user already sees in the API-key list or
 * Connected apps.
 */
import { AI_TOOL_DOMAINS, type AiToolDomain } from '@breeze/shared';
import { MCP_WHOAMI_TOOL_NAME } from './aiToolNames';
import type { McpDomainGrant } from './mcpDomains';

export const MCP_WHOAMI_TOOL_DEFINITION = {
  name: MCP_WHOAMI_TOOL_NAME,
  description:
    "Describe this connection's Breeze access: who it acts as, tenant scope, granted scopes and tool domains, and which actions need the Breeze web app. Call it before assuming a tool is missing.",
  input_schema: { type: 'object' as const, properties: {}, additionalProperties: false },
};

/**
 * The `tools/list` entry. Static rather than built per request: whoami is a
 * fixed tier-1, read-only, closed-world core tool, so its presentation never
 * varies. `mcpWhoami.test.ts` pins it to `buildMcpToolPresentation(def, 1,
 * 'core')` so it cannot drift from the shared presentation rules.
 */
export const MCP_WHOAMI_TOOL_LIST_ENTRY = {
  title: 'Whoami',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: { 'app.breeze/domain': 'core' },
  name: MCP_WHOAMI_TOOL_DEFINITION.name,
  description: MCP_WHOAMI_TOOL_DEFINITION.description,
  inputSchema: MCP_WHOAMI_TOOL_DEFINITION.input_schema,
};

export type WhoamiInput = {
  principal: {
    kind: 'api_key' | 'oauth' | 'partner_service_principal';
    id: string;
    name: string | null;
    clientId: string | null;
  };
  tenant: { scope: 'organization' | 'partner'; partnerId: string | null; orgId: string | null };
  /** Effective ai:* scopes as the server enforces them. */
  scopes: string[];
  domainGrant: McpDomainGrant;
  approvalGate: { tier3RequiresWebApp: boolean; unattendedPrincipal: boolean };
  mfaGatedActionsUnavailable: boolean;
};

export type WhoamiResult = WhoamiInput['principal'] & {
  tenant: WhoamiInput['tenant'];
  capability: 'read' | 'write' | 'execute';
  scopes: string[];
  domains: { restricted: boolean; granted: AiToolDomain[]; available: AiToolDomain[] };
  notes: string[];
};

export function buildWhoamiResult(input: WhoamiInput): WhoamiResult {
  const capability = input.scopes.includes('ai:execute')
    ? 'execute'
    : input.scopes.includes('ai:write')
      ? 'write'
      : 'read';

  const { domainGrant } = input;
  const granted: AiToolDomain[] = domainGrant.restricted
    ? AI_TOOL_DOMAINS.filter((d) => d === 'core' || (domainGrant.domains as ReadonlySet<string>).has(d))
    : [...AI_TOOL_DOMAINS];

  const notes: string[] = [];
  if (domainGrant.restricted) {
    notes.push(
      'This connection is limited to the tool domains in domains.granted. domains.available lists areas you can ask to be granted, not permissions you hold. To widen access, reconnect the app (OAuth) or edit the API key.',
    );
  } else {
    notes.push('This connection may use tools in every domain, including areas added later. Scopes, roles and approvals still apply.');
  }
  if (input.approvalGate.tier3RequiresWebApp) {
    notes.push(
      'Actions that require interactive approval (tier 3) are not available over MCP. Run them from the Breeze web app AI assistant.',
    );
  }
  if (input.mfaGatedActionsUnavailable) {
    notes.push(
      'Actions that require a multi-factor-authenticated session are not available over MCP. Use the Breeze web app AI assistant, signed in with MFA.',
    );
  }
  if (capability === 'read') {
    notes.push('This connection can only read. Changes need the ai:write scope (mcp:write over OAuth).');
  }

  return {
    ...input.principal,
    tenant: input.tenant,
    capability,
    scopes: [...input.scopes],
    domains: { restricted: domainGrant.restricted, granted, available: [...AI_TOOL_DOMAINS] },
    notes,
  };
}
