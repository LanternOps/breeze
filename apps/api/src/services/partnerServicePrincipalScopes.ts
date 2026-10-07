export const PARTNER_SERVICE_PRINCIPAL_READ_SCOPES = Object.freeze([
  'organizations:read',
  'sites:read',
  'devices:read',
  'inventory:read',
  'configuration:read',
  'scripts:read',
  'backup-configuration:read',
  'custom-fields:read',
] as const);

// Provisioning write scopes (#3243). Create/update only by design — deletion
// of tenancy stays a human + MFA action on the main API and must never grow a
// scope here. These are opt-in at principal creation and are deliberately NOT
// part of any default scope set.
export const PARTNER_SERVICE_PRINCIPAL_WRITE_SCOPES = Object.freeze([
  'organizations:write',
  'sites:write',
  'enrollment-keys:write',
  // Contract header + line mutations on the Partner API. Opt-in; never part of
  // the Weavestream default. Does not grant lifecycle (activate/pause/cancel)
  // or the human JWT `/api/v1/contracts` surface.
  'contracts:write',
  // Partner API tickets surface: create / update / status / assign / comment.
  // Opt-in; never part of the Weavestream default. No delete, restore,
  // move-org, bulk, attachments, time entries or mailbox — those stay human,
  // MFA-gated actions on the main API. A principal acts as ITSELF here (no
  // human owner is credited — see 2026-12-04-101100-ticket-comments-
  // service-principal-origin.sql); it is not site-restricted.
  'tickets:write',
] as const);

// Opt-in read scopes: grantable, but deliberately NOT in any default scope set.
// alerts:read exposes operational alert titles/messages across every org the
// principal can reach, so it must be requested explicitly.
export const PARTNER_SERVICE_PRINCIPAL_OPT_IN_READ_SCOPES = Object.freeze([
  'alerts:read',
  // tickets:read exposes ticket subjects, descriptions and comments —
  // customer-authored data — across every org the principal can reach.
  'tickets:read',
] as const);

// Opt-in MCP scopes: admit the principal to the MCP endpoint (/api/v1/mcp)
// with PARTNER scope — every org of the partner its owner can reach. They are
// the same ai:* transport gates an org API key carries and grant NOTHING on
// /api/v1/partner-api. Never part of any default scope set. Per-tool RBAC,
// the Tier 3 approval gate (MCP_UNATTENDED_TIER3_PRINCIPALS `partner_sp:<id>`),
// rate limits, the execution ledger and the audit log still apply over MCP;
// see middleware/partnerServicePrincipalMcpAuth.ts.
export const PARTNER_SERVICE_PRINCIPAL_MCP_SCOPES = Object.freeze([
  'ai:read',
  'ai:write',
  'ai:execute',
  'ai:execute_admin',
] as const);

export const PARTNER_SERVICE_PRINCIPAL_SCOPES = Object.freeze([
  ...PARTNER_SERVICE_PRINCIPAL_READ_SCOPES,
  ...PARTNER_SERVICE_PRINCIPAL_OPT_IN_READ_SCOPES,
  ...PARTNER_SERVICE_PRINCIPAL_WRITE_SCOPES,
  ...PARTNER_SERVICE_PRINCIPAL_MCP_SCOPES,
] as const);

export type PartnerServicePrincipalMcpScope =
  (typeof PARTNER_SERVICE_PRINCIPAL_MCP_SCOPES)[number];

const PARTNER_SERVICE_PRINCIPAL_MCP_SCOPE_SET = new Set<string>(
  PARTNER_SERVICE_PRINCIPAL_MCP_SCOPES,
);

export const PARTNER_SERVICE_PRINCIPAL_MCP_READ_REQUIRED_ERROR =
  'MCP scopes ai:write, ai:execute and ai:execute_admin require ai:read: every MCP request needs ai:read';

/**
 * Every MCP request requires ai:read (mcpServer.ts preflight), so a principal
 * holding a higher MCP scope without it could authenticate but never make a
 * request. Rejected at create/update and at MCP authentication.
 */
export function partnerServicePrincipalMcpScopesMissingRead(scopes: readonly string[]): boolean {
  const mcp = partnerServicePrincipalMcpScopes(scopes);
  return mcp.length > 0 && !mcp.includes('ai:read');
}

/** The MCP (ai:*) subset of a principal's scopes, in their stored order. */
export function partnerServicePrincipalMcpScopes(
  scopes: readonly string[],
): PartnerServicePrincipalMcpScope[] {
  return scopes.filter((scope): scope is PartnerServicePrincipalMcpScope =>
    PARTNER_SERVICE_PRINCIPAL_MCP_SCOPE_SET.has(scope));
}

export type PartnerServicePrincipalScope =
  (typeof PARTNER_SERVICE_PRINCIPAL_SCOPES)[number];

// Read-only on purpose: the Weavestream default existed before the write
// scopes did, and silently widening a DEFAULT to include tenancy writes would
// grant every default-scoped principal provisioning power. Write scopes are
// opt-in per principal, never implicit (#3243).
export const DEFAULT_WEAVESTREAM_PARTNER_SERVICE_PRINCIPAL_SCOPES = Object.freeze(
  [...PARTNER_SERVICE_PRINCIPAL_READ_SCOPES] as PartnerServicePrincipalScope[],
);

const PARTNER_SERVICE_PRINCIPAL_SCOPE_SET = new Set<string>(
  PARTNER_SERVICE_PRINCIPAL_SCOPES,
);

export type PartnerServicePrincipalScopeValidationResult =
  | { ok: true; scopes: PartnerServicePrincipalScope[] }
  | {
      ok: false;
      status: 400;
      error: string;
      details?: Record<string, unknown>;
    };

export function validatePartnerServicePrincipalScopes(
  requestedScopes: readonly string[],
): PartnerServicePrincipalScopeValidationResult {
  if (requestedScopes.length === 0) {
    return {
      ok: false,
      status: 400,
      error: 'At least one partner service principal scope is required',
    };
  }

  const seen = new Set<string>();
  const duplicateScopes: string[] = [];
  for (const scope of requestedScopes) {
    if (seen.has(scope) && !duplicateScopes.includes(scope)) {
      duplicateScopes.push(scope);
    }
    seen.add(scope);
  }

  if (duplicateScopes.length > 0) {
    return {
      ok: false,
      status: 400,
      error: 'Partner service principal scopes must not contain duplicates',
      details: { duplicateScopes },
    };
  }

  for (const scope of requestedScopes) {
    if (!PARTNER_SERVICE_PRINCIPAL_SCOPE_SET.has(scope)) {
      return {
        ok: false,
        status: 400,
        error: `Unsupported partner service principal scope: ${scope}`,
        details: { supportedScopes: PARTNER_SERVICE_PRINCIPAL_SCOPES },
      };
    }
  }

  return {
    ok: true,
    scopes: [...requestedScopes] as PartnerServicePrincipalScope[],
  };
}

export function hasPartnerServicePrincipalScope(
  delegatedScopes: readonly string[],
  requiredScope: PartnerServicePrincipalScope,
): boolean {
  return delegatedScopes.includes(requiredScope);
}
