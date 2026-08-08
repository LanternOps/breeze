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
] as const);

export const PARTNER_SERVICE_PRINCIPAL_SCOPES = Object.freeze([
  ...PARTNER_SERVICE_PRINCIPAL_READ_SCOPES,
  ...PARTNER_SERVICE_PRINCIPAL_WRITE_SCOPES,
] as const);

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
