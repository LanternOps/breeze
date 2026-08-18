import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEAVESTREAM_PARTNER_SERVICE_PRINCIPAL_SCOPES,
  PARTNER_SERVICE_PRINCIPAL_SCOPES,
  hasPartnerServicePrincipalScope,
  validatePartnerServicePrincipalScopes,
} from './partnerServicePrincipalScopes';

describe('partner partner-service-principal scopes', () => {
  it('accepts the exact eight supported read scopes', () => {
    expect(validatePartnerServicePrincipalScopes([...PARTNER_SERVICE_PRINCIPAL_SCOPES])).toEqual({
      ok: true,
      scopes: [...PARTNER_SERVICE_PRINCIPAL_SCOPES],
    });
  });

  it('rejects an unsupported scope', () => {
    expect(validatePartnerServicePrincipalScopes(['organizations:read', 'alerts:read'])).toEqual({
      ok: false,
      status: 400,
      error: 'Unsupported partner service principal scope: alerts:read',
      details: { supportedScopes: PARTNER_SERVICE_PRINCIPAL_SCOPES },
    });
  });

  it('rejects duplicate scopes instead of silently widening or normalizing delegation', () => {
    expect(validatePartnerServicePrincipalScopes(['devices:read', 'devices:read'])).toEqual({
      ok: false,
      status: 400,
      error: 'Partner service principal scopes must not contain duplicates',
      details: { duplicateScopes: ['devices:read'] },
    });
  });

  it('rejects an empty scope set', () => {
    expect(validatePartnerServicePrincipalScopes([])).toEqual({
      ok: false,
      status: 400,
      error: 'At least one partner service principal scope is required',
    });
  });

  it('checks delegated scopes by exact membership only', () => {
    const delegated = ['devices:read', 'inventory:read'] as const;

    expect(hasPartnerServicePrincipalScope(delegated, 'devices:read')).toBe(true);
    expect(hasPartnerServicePrincipalScope(delegated, 'organizations:read')).toBe(false);
    expect(hasPartnerServicePrincipalScope(['*'], 'devices:read')).toBe(false);
    expect(hasPartnerServicePrincipalScope(['devices'], 'devices:read')).toBe(false);
  });

  it('publishes a frozen default Weavestream delegation of exactly the eight read scopes', () => {
    // Named explicitly on purpose — NOT derived from PARTNER_SERVICE_PRINCIPAL_SCOPES.
    // Since #3243 the full scope list also contains tenancy WRITE scopes, and the
    // default delegation must never absorb a new scope implicitly: adding one
    // here has to be a deliberate human decision, because every default-scoped
    // principal inherits it.
    expect(DEFAULT_WEAVESTREAM_PARTNER_SERVICE_PRINCIPAL_SCOPES).toEqual([
      'organizations:read',
      'sites:read',
      'devices:read',
      'inventory:read',
      'configuration:read',
      'scripts:read',
      'backup-configuration:read',
      'custom-fields:read',
    ]);
    // SECURITY: enrollment-keys:write mints device-join credentials. Asserted
    // explicitly in addition to the list above so that a future edit to the
    // enumeration cannot quietly hand credential minting to every
    // default-scoped principal.
    expect(DEFAULT_WEAVESTREAM_PARTNER_SERVICE_PRINCIPAL_SCOPES).not.toContain(
      'enrollment-keys:write',
    );
    expect(Object.isFrozen(DEFAULT_WEAVESTREAM_PARTNER_SERVICE_PRINCIPAL_SCOPES)).toBe(true);
  });

  it('never includes a write scope in the default delegation', () => {
    // Provisioning writes (#3243) are opt-in at principal creation only.
    for (const scope of DEFAULT_WEAVESTREAM_PARTNER_SERVICE_PRINCIPAL_SCOPES) {
      expect(scope.endsWith(':read')).toBe(true);
    }
  });
});
