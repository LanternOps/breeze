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

  it('publishes a frozen default Weavestream delegation containing all eight scopes', () => {
    expect(DEFAULT_WEAVESTREAM_PARTNER_SERVICE_PRINCIPAL_SCOPES).toEqual(
      PARTNER_SERVICE_PRINCIPAL_SCOPES,
    );
    expect(Object.isFrozen(DEFAULT_WEAVESTREAM_PARTNER_SERVICE_PRINCIPAL_SCOPES)).toBe(true);
  });
});
