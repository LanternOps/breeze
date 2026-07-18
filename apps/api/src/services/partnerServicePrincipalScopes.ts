export const PARTNER_SERVICE_PRINCIPAL_SCOPES = Object.freeze([
  'organizations:read',
  'sites:read',
  'devices:read',
  'inventory:read',
  'configuration:read',
  'scripts:read',
  'backup-configuration:read',
  'custom-fields:read',
] as const);

export type PartnerServicePrincipalScope =
  (typeof PARTNER_SERVICE_PRINCIPAL_SCOPES)[number];

export const DEFAULT_WEAVESTREAM_PARTNER_SERVICE_PRINCIPAL_SCOPES = Object.freeze(
  [...PARTNER_SERVICE_PRINCIPAL_SCOPES] as PartnerServicePrincipalScope[],
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
