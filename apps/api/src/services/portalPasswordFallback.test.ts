import { describe, expect, it } from 'vitest';
import type { PortalAccessPolicyRowValues, PortalSignInCapabilities } from '@breeze/shared';
import {
  AUDIT_PORTAL_PASSWORD_FALLBACK,
  AUDIT_PORTAL_PASSWORD_FALLBACK_DISMISSED,
  passwordFallbackImpactFrom,
  passwordFallbackNoticeFrom,
  portalPasswordFallbackAuditEvent,
} from './portalPasswordFallback';

/**
 * The pure halves of the password-fallback visibility (#11582): whether losing
 * the tenant proof changes what an org's portal users can do, and whether the
 * newest fallback / dismissal audit row still asks for the admin notice. The DB
 * halves are exercised in portalPasswordFallback.integration.test.ts.
 */

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';
const TID = 'a1a1a1a1-b2b2-4c3c-8d4d-e5e5e5e5e5e5';
const ALL_CAPS: PortalSignInCapabilities = { entra: true, google: true, selfRegistration: true };
const NO_ENTRA: PortalSignInCapabilities = { entra: false, google: true, selfRegistration: true };

const row = (over: Partial<PortalAccessPolicyRowValues> = {}): PortalAccessPolicyRowValues => ({
  entraEnabled: null,
  googleEnabled: null,
  passwordMode: null,
  selfRegistrationMode: null,
  ssoNewPersonMode: null,
  ssoSessionMaxHours: null,
  ...over,
});

describe('passwordFallbackImpactFrom', () => {
  it('Microsoft on through the partner default: the fallback takes effect, password was already allowed', () => {
    expect(passwordFallbackImpactFrom({ org: null, partner: row({ entraEnabled: true }) }, ALL_CAPS))
      .toEqual({ passwordModeFallback: false });
  });

  it('Microsoft on through an org override with sso_only: password sign-in comes back (passwordModeFallback)', () => {
    expect(passwordFallbackImpactFrom(
      { org: row({ entraEnabled: true, passwordMode: 'sso_only' }), partner: null },
      ALL_CAPS,
    )).toEqual({ passwordModeFallback: true });
  });

  it('sso_only held up by Google too: Microsoft falls back but password stays off', () => {
    expect(passwordFallbackImpactFrom(
      { org: row({ entraEnabled: true, googleEnabled: true, passwordMode: 'sso_only' }), partner: null },
      ALL_CAPS,
    )).toEqual({ passwordModeFallback: false });
  });

  it('Microsoft off (default, or an org false beating a partner true): losing the proof changes nothing → null', () => {
    expect(passwordFallbackImpactFrom({ org: null, partner: null }, ALL_CAPS)).toBeNull();
    expect(passwordFallbackImpactFrom(
      { org: row({ entraEnabled: false }), partner: row({ entraEnabled: true }) },
      ALL_CAPS,
    )).toBeNull();
  });

  it('a deployment without the portal Entra app never had Microsoft on → null', () => {
    expect(passwordFallbackImpactFrom({ org: row({ entraEnabled: true }), partner: null }, NO_ENTRA)).toBeNull();
  });
});

describe('portalPasswordFallbackAuditEvent', () => {
  it('is one organization-typed row on the org, naming the lost tenant, the cause and the sso_only fallback', () => {
    expect(portalPasswordFallbackAuditEvent(ORG_ID, TID, 'tenant_removed', { passwordModeFallback: true })).toEqual({
      orgId: ORG_ID,
      action: 'organization.portal_sign_in.password_fallback',
      resourceType: 'organization',
      resourceId: ORG_ID,
      resourceName: TID,
      details: { tenantId: TID, cause: 'tenant_removed', ssoOnlyLifted: true },
    });
  });
});

describe('passwordFallbackNoticeFrom', () => {
  const at = new Date('2027-02-03T04:05:06.000Z');

  it('no fallback row → no notice', () => {
    expect(passwordFallbackNoticeFrom(undefined)).toBeNull();
  });

  it('newest row is a fallback → notice with when, the lost tenant and the cause', () => {
    expect(passwordFallbackNoticeFrom({
      action: AUDIT_PORTAL_PASSWORD_FALLBACK,
      timestamp: at,
      details: { tenantId: TID, cause: 'tenant_displaced', ssoOnlyLifted: false },
    })).toEqual({ since: at.toISOString(), tenantId: TID, cause: 'tenant_displaced' });
  });

  it('newest row is a dismissal → no notice', () => {
    expect(passwordFallbackNoticeFrom({ action: AUDIT_PORTAL_PASSWORD_FALLBACK_DISMISSED, timestamp: at, details: {} })).toBeNull();
  });

  it('a fallback row with malformed details still raises the notice, without a tenant or cause', () => {
    expect(passwordFallbackNoticeFrom({ action: AUDIT_PORTAL_PASSWORD_FALLBACK, timestamp: at, details: null }))
      .toEqual({ since: at.toISOString(), tenantId: null, cause: null });
    expect(passwordFallbackNoticeFrom({
      action: AUDIT_PORTAL_PASSWORD_FALLBACK,
      timestamp: at,
      details: { tenantId: 42, cause: 'something_else' },
    })).toEqual({ since: at.toISOString(), tenantId: null, cause: null });
  });
});
