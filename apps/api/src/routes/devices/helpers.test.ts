import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  stripSensitiveDeviceFields,
  canAccessDeviceSite,
  getDeviceWithOrgCheck,
  getDeviceWithOrgAndSiteCheck,
} from './helpers';
import { db } from '../../db';
import type { UserPermissions } from '../../services/permissions';

// The unit runner has no database (see the "no DB" exclusions in
// vitest.config.ts), so `db` must be mocked rather than reached. Without this,
// the #2968 guard tests below would infer "the guard let this through" from a
// connection error — which silently inverts into a failure on any machine that
// happens to have the dev Postgres up on 5432.
vi.mock('../../db', () => ({
  db: { select: vi.fn() },
}));

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

  /** Make `db.select()` resolve to `rows`, so a query that IS issued succeeds. */
  function mockSelect(rows: unknown[]) {
    vi.mocked(db.select).mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
    } as unknown as ReturnType<typeof db.select>);
  }

  beforeEach(() => {
    vi.mocked(db.select).mockReset();
    mockSelect([]);
  });

  const malformed = [
    'not-a-uuid',
    '123',
    '',
    "'; DROP TABLE devices;--",
    'ffffffff-ffff-ffff-ffff-fffffffffffg',
    '9f6d5f4e-1b2a-4c3d-8e9f',
  ];

  // Asserting `db.select` was never called is the point of these tests: returning
  // null alone would also be satisfied by querying and translating the 22P02, which
  // is the exact behaviour (a wasted round-trip + a Sentry event) the fix removes.
  it.each(malformed)('getDeviceWithOrgCheck returns null for %j without querying', async (id) => {
    await expect(getDeviceWithOrgCheck(id, auth)).resolves.toBeNull();
    expect(db.select).not.toHaveBeenCalled();
  });

  it.each(malformed)('getDeviceWithOrgAndSiteCheck returns null for %j without querying', async (id) => {
    const c = {} as Parameters<typeof getDeviceWithOrgAndSiteCheck>[0];
    await expect(getDeviceWithOrgAndSiteCheck(c, id, auth)).resolves.toBeNull();
    expect(db.select).not.toHaveBeenCalled();
  });

  // Regression guard for the trap this fix walked into: `UUID_REGEX` also
  // requires an RFC-4122 version (1-5) and variant (8/9/a/b) nibble, but Postgres
  // accepts any 8-4-4-4-12 hex for a uuid column. Guarding with the strict pattern
  // would 404 a real device whose id does not set those bits.
  //
  // The uppercase case additionally pins the regex's `i` flag: dropping it would
  // silently 404 every device addressed by an upper- or mixed-case uuid.
  const acceptedByPostgres = [
    '33333333-3333-3333-3333-333333333333',
    '00000000-0000-0000-0000-000000000000',
    'ffffffff-ffff-ffff-ffff-ffffffffffff',
    '9F6D5F4E-1B2A-4C3D-8E9F-0A1B2C3D4E5F',
    '9f6d5f4e-1b2a-4c3d-8e9f-0a1b2c3d4e5f',
  ];

  it.each(acceptedByPostgres)('getDeviceWithOrgCheck queries for %j', async (id) => {
    await getDeviceWithOrgCheck(id, auth);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it.each(acceptedByPostgres)('getDeviceWithOrgAndSiteCheck queries for %j', async (id) => {
    const c = {} as Parameters<typeof getDeviceWithOrgAndSiteCheck>[0];
    await getDeviceWithOrgAndSiteCheck(c, id, auth);
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('returns the row for a well-formed uuid that exists', async () => {
    // The guard must not mask a real lookup: a valid id whose row exists still
    // resolves to that row, not null.
    const device = { id: '9f6d5f4e-1b2a-4c3d-8e9f-0a1b2c3d4e5f', orgId: 'org-1', siteId: null };
    mockSelect([device]);
    await expect(getDeviceWithOrgCheck(device.id, auth)).resolves.toEqual(device);
  });
});
