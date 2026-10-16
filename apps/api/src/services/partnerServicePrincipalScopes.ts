import {
  PARTNER_SERVICE_PRINCIPAL_MCP_SCOPES,
  PARTNER_SERVICE_PRINCIPAL_OPT_IN_READ_SCOPES,
  PARTNER_SERVICE_PRINCIPAL_READ_SCOPES,
  PARTNER_SERVICE_PRINCIPAL_SCOPES,
  PARTNER_SERVICE_PRINCIPAL_WRITE_SCOPES,
  type PartnerServicePrincipalScope,
} from '@breeze/shared';

// The scope lists (and their rationale comments) live in
// packages/shared/src/constants/partnerServicePrincipalScopes.ts (#8173) so the
// web create dialog and its presets read the exact same registry. Re-exported
// here so every API import site keeps its existing path.
export {
  PARTNER_SERVICE_PRINCIPAL_MCP_SCOPES,
  PARTNER_SERVICE_PRINCIPAL_OPT_IN_READ_SCOPES,
  PARTNER_SERVICE_PRINCIPAL_READ_SCOPES,
  PARTNER_SERVICE_PRINCIPAL_SCOPES,
  PARTNER_SERVICE_PRINCIPAL_WRITE_SCOPES,
};
export type { PartnerServicePrincipalScope };

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
