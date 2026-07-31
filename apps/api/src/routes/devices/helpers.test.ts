import { describe, it, expect } from 'vitest';
import {
  stripSensitiveDeviceFields,
  canAccessDeviceSite,
  getDeviceWithOrgCheck,
  getDeviceWithOrgAndSiteCheck,
} from './helpers';
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

// #2968 (authenticated twin of #2914): `devices.id` is uuid-typed, so a malformed
// path param used to reach Postgres as a 22P02 and surface as a 500 + Sentry event
// instead of a 404. Both device helpers must reject it on the not-found path,
// before any query is issued.
describe('device helpers reject a malformed uuid before querying (#2968)', () => {
  const auth = {
    scope: 'system' as const,
    orgId: 'org-1',
    accessibleOrgIds: ['org-1'],
    canAccessOrg: () => true,
  };

  const malformed = [
    'not-a-uuid',
    '123',
    '',
    "'; DROP TABLE devices;--",
    'ffffffff-ffff-ffff-ffff-fffffffffffg',
    '9f6d5f4e-1b2a-4c3d-8e9f',
  ];

  it.each(malformed)('getDeviceWithOrgCheck returns null for %j', async (id) => {
    await expect(getDeviceWithOrgCheck(id, auth)).resolves.toBeNull();
  });

  it.each(malformed)('getDeviceWithOrgAndSiteCheck returns null for %j', async (id) => {
    const c = {} as Parameters<typeof getDeviceWithOrgAndSiteCheck>[0];
    await expect(getDeviceWithOrgAndSiteCheck(c, id, auth)).resolves.toBeNull();
  });

  // Regression guard for the trap this fix walked into: `UUID_REGEX` also
  // requires an RFC-4122 version (1-5) and variant (8/9/a/b) nibble, but Postgres
  // accepts any 8-4-4-4-12 hex for a uuid column. Guarding with the strict pattern
  // would 404 a real device whose id does not set those bits.
  it.each([
    '33333333-3333-3333-3333-333333333333',
    '00000000-0000-0000-0000-000000000000',
    'ffffffff-ffff-ffff-ffff-ffffffffffff',
  ])('accepts %j, which Postgres stores but RFC-4122 would reject', async (id) => {
    const c = {} as Parameters<typeof getDeviceWithOrgAndSiteCheck>[0];
    const out = await getDeviceWithOrgAndSiteCheck(c, id, auth).catch(() => 'reached-db');
    expect(out).not.toBeNull();
  });

  it('does not reject a well-formed uuid at the guard', async () => {
    // A valid uuid must fall through to the query rather than short-circuit, so
    // the guard cannot mask real lookups. Reaching the db layer (which is not
    // mocked here) is proof it passed the guard.
    const c = {} as Parameters<typeof getDeviceWithOrgAndSiteCheck>[0];
    const valid = '9f6d5f4e-1b2a-4c3d-8e9f-0a1b2c3d4e5f';
    const viaGuard = await getDeviceWithOrgAndSiteCheck(c, valid, auth).catch(() => 'reached-db');
    expect(viaGuard).not.toBeNull();
  });
});
