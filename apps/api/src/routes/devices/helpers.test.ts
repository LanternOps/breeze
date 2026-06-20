import { describe, it, expect } from 'vitest';
import { stripSensitiveDeviceFields, canAccessDeviceSite } from './helpers';
import type { UserPermissions } from '../../services/permissions';

// SR-008 (systemic twin): GET /devices/:id spreads the full device row to the
// client. Credential verifiers + mTLS material must never reach any client,
// even an authenticated same-tenant dashboard user.

describe('stripSensitiveDeviceFields (SR-008)', () => {
  const sensitive = {
    agentTokenHash: 'a'.repeat(64),
    previousTokenHash: 'b'.repeat(64),
    watchdogTokenHash: 'c'.repeat(64),
    previousWatchdogTokenHash: 'd'.repeat(64),
    helperTokenHash: 'e'.repeat(64),
    previousHelperTokenHash: 'f'.repeat(64),
    tokenIssuedAt: new Date(),
    watchdogTokenIssuedAt: new Date(),
    helperTokenIssuedAt: new Date(),
    previousTokenExpiresAt: new Date(),
    previousWatchdogTokenExpiresAt: new Date(),
    previousHelperTokenExpiresAt: new Date(),
    mtlsCertSerialNumber: 'SERIAL123',
    mtlsCertCfId: 'cf-cert-id',
    mtlsCertExpiresAt: new Date(),
    mtlsCertIssuedAt: new Date(),
  };
  const safe = {
    id: 'dev-1',
    orgId: 'org-1',
    hostname: 'host-1',
    status: 'online',
    osType: 'linux',
    customFields: { k: 'v' },
  };

  it('removes every credential verifier and mTLS field', () => {
    const out = stripSensitiveDeviceFields({ ...safe, ...sensitive }) as Record<string, unknown>;
    for (const key of Object.keys(sensitive)) {
      expect(out).not.toHaveProperty(key);
    }
  });

  it('preserves all non-sensitive operational fields', () => {
    const out = stripSensitiveDeviceFields({ ...safe, ...sensitive }) as Record<string, unknown>;
    expect(out).toEqual(safe);
  });

  it('does not mutate the input object (internal logic still needs the full row)', () => {
    const input = { ...safe, ...sensitive };
    stripSensitiveDeviceFields(input);
    expect(input.agentTokenHash).toBe('a'.repeat(64));
  });
});

// T10 (defense-in-depth): the per-device site check must FAIL CLOSED when the
// permissions context is entirely absent. A missing permissions object means
// requirePermission did not run (a dropped/reordered gate) — in that state we
// must deny, not silently grant cross-site access. This mirrors the fail-loud
// behavior of getDeviceWithOrgAndSiteCheck.
describe('canAccessDeviceSite (T10 fail-closed)', () => {
  const restricted = {
    permissions: [],
    partnerId: null,
    orgId: 'org-1',
    roleId: 'role-1',
    scope: 'organization',
    allowedSiteIds: ['site-a', 'site-b'],
  } satisfies UserPermissions;
  const unrestricted = {
    permissions: [],
    partnerId: null,
    orgId: 'org-1',
    roleId: 'role-1',
    scope: 'organization',
  } satisfies UserPermissions;

  it('DENIES when permissions context is absent (undefined) — fail closed', () => {
    expect(canAccessDeviceSite({ siteId: 'site-a' }, undefined)).toBe(false);
  });

  it('allows when permissions are present but unrestricted (allowedSiteIds undefined)', () => {
    expect(canAccessDeviceSite({ siteId: 'site-a' }, unrestricted)).toBe(true);
    expect(canAccessDeviceSite({ siteId: null }, unrestricted)).toBe(true);
  });

  it('allows a restricted user when the device is in an allowed site', () => {
    expect(canAccessDeviceSite({ siteId: 'site-b' }, restricted)).toBe(true);
  });

  it('denies a restricted user when the device is out of the allowed sites', () => {
    expect(canAccessDeviceSite({ siteId: 'site-z' }, restricted)).toBe(false);
  });

  it('denies a restricted user when the device has no site', () => {
    expect(canAccessDeviceSite({ siteId: null }, restricted)).toBe(false);
    expect(canAccessDeviceSite({}, restricted)).toBe(false);
  });
});
