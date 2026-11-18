import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ select: vi.fn(), transaction: vi.fn(), grants: vi.fn() }));
vi.mock('../db', () => ({
  db: { select: h.select, transaction: h.transaction },
  runOutsideDbContext: vi.fn(async (fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
}));
vi.mock('./roleInheritance', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getRolesPermissionGrants: h.grants,
}));

import {
  MIGRATION_WINDOW_OPENER_PERMISSIONS,
  closingReason,
  openersHoldingOpenPermissions,
  resolveWritesPerHour,
  sweepMigrationWindows,
  validateWindowSpan,
} from './migrationWindows';
import { migrationWindowLimits } from './migrationWindowLimits';

const NOW = new Date('2030-01-01T12:00:00.000Z');
const DAY = 86_400_000;

const healthy = {
  id: 'w-1',
  endsAt: new Date(NOW.getTime() + DAY),
  principalStatus: 'active',
  principalExpiresAt: null as Date | null,
  principalScopes: ['tickets:read', 'tickets:write'],
  openerStatus: 'active',
  openerCredentialEpoch: 7,
  openerMfaEpoch: 2,
  snapshotCredentialEpoch: 7,
  snapshotMfaEpoch: 2,
  openerIsPartnerWideAdmin: true,
  openerHoldsOpenPermissions: true,
};

describe('closingReason — every condition that ends a window (spec §3.1)', () => {
  it('keeps a healthy window open', () => {
    expect(closingReason(healthy, NOW)).toBeNull();
  });

  it('expires at ends_at, inclusive', () => {
    expect(closingReason({ ...healthy, endsAt: NOW }, NOW)).toBe('expired');
    expect(closingReason({ ...healthy, endsAt: new Date(NOW.getTime() - 1) }, NOW)).toBe('expired');
  });

  it.each([
    ['disabled', { principalStatus: 'disabled' }],
    ['deleted (no principal row)', { principalStatus: null, principalScopes: null }],
    ['expired', { principalExpiresAt: new Date(NOW.getTime() - 1) }],
    ['without tickets:write', { principalScopes: ['tickets:read'] }],
  ])('closes when the principal is %s', (_label, patch) => {
    expect(closingReason({ ...healthy, ...patch }, NOW)).toBe('principal_inactive');
  });

  it.each([
    ['no longer active', { openerStatus: 'disabled' }],
    ['deleted (no user row)', { openerStatus: null, openerCredentialEpoch: null, openerMfaEpoch: null }],
    ['no longer a partner-wide admin', { openerIsPartnerWideAdmin: false }],
    // #8486 review: a role downgrade that drops what opening needs.
    ['downgraded to a role without the open permissions', { openerHoldsOpenPermissions: false }],
    ['past a password change (credential_epoch moved)', { openerCredentialEpoch: 8 }],
    ['past an MFA change (mfa_epoch moved)', { openerMfaEpoch: 3 }],
  ])('closes when the opener is %s', (_label, patch) => {
    expect(closingReason({ ...healthy, ...patch }, NOW)).toBe('opener_inactive');
  });

  it('reports expiry first when several conditions hold', () => {
    expect(closingReason({ ...healthy, endsAt: NOW, principalStatus: 'disabled', openerStatus: 'disabled' }, NOW)).toBe('expired');
  });
});

describe('the permissions an opener needs and keeps needing (spec §3.1, §3.3)', () => {
  it('are organizations.write (the route gate) and what the delegation table requires for tickets:write', () => {
    expect([...MIGRATION_WINDOW_OPENER_PERMISSIONS]).toEqual([
      { resource: 'organizations', action: 'write' },
      { resource: 'tickets', action: 'write' },
    ]);
  });
});

describe('window span and throughput (spec §3.2)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts a window that ends in the future within the cap', () => {
    expect(() => validateWindowSpan(new Date(NOW.getTime() + 14 * DAY), NOW, 14)).not.toThrow();
  });

  it('refuses a window that has already ended or outlasts the cap', () => {
    expect(() => validateWindowSpan(NOW, NOW, 14)).toThrow(expect.objectContaining({ code: 'MIGRATION_WINDOW_INVALID_SPAN', status: 400 }));
    expect(() => validateWindowSpan(new Date(NOW.getTime() + 14 * DAY + 1), NOW, 14))
      .toThrow(expect.objectContaining({ code: 'MIGRATION_WINDOW_INVALID_SPAN' }));
    expect(() => validateWindowSpan(new Date('not a date'), NOW, 14)).toThrow(expect.objectContaining({ code: 'MIGRATION_WINDOW_INVALID_SPAN' }));
  });

  it('defaults the throughput and bounds it to [600, ceiling]', () => {
    expect(resolveWritesPerHour(undefined)).toBe(6000);
    expect(resolveWritesPerHour(600)).toBe(600);
    expect(resolveWritesPerHour(20000)).toBe(20000);
    for (const bad of [599, 20001, 1.5]) {
      expect(() => resolveWritesPerHour(bad)).toThrow(expect.objectContaining({ code: 'MIGRATION_WINDOW_INVALID_WRITES_PER_HOUR', status: 400 }));
    }
  });

  it('reads the limits from env and clamps them into what the table accepts', () => {
    expect(migrationWindowLimits()).toEqual({ maxDays: 14, defaultWritesPerHour: 6000, maxWritesPerHour: 20000 });
    vi.stubEnv('MIGRATION_WINDOW_MAX_DAYS', '7');
    vi.stubEnv('MIGRATION_WINDOW_MAX_WRITES_PER_HOUR', '500000');
    vi.stubEnv('MIGRATION_WINDOW_DEFAULT_WRITES_PER_HOUR', '100');
    expect(migrationWindowLimits()).toEqual({ maxDays: 7, defaultWritesPerHour: 600, maxWritesPerHour: 100000 });
    vi.stubEnv('MIGRATION_WINDOW_MAX_WRITES_PER_HOUR', '1000');
    vi.stubEnv('MIGRATION_WINDOW_DEFAULT_WRITES_PER_HOUR', '6000');
    expect(migrationWindowLimits().defaultWritesPerHour).toBe(1000);
    vi.stubEnv('MIGRATION_WINDOW_MAX_DAYS', 'zero');
    expect(migrationWindowLimits().maxDays).toBe(14);
  });
});

/** A chainable, awaitable Drizzle stand-in: every builder method returns the chain; awaiting it yields `rows`. */
function chain(rows: unknown[]): unknown {
  const proxy: unknown = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(rows);
      return () => proxy;
    },
  });
  return proxy;
}

const OPENER = 'u-opener';
const PARTNER = 'p-1';
const BOTH = [
  { resource: 'organizations', action: 'write' },
  { resource: 'tickets', action: 'write' },
];

describe('openersHoldingOpenPermissions — grants resolve through role inheritance (#11702)', () => {
  it('holds when one partner-wide membership\'s role grants every opener permission, inherited or not', async () => {
    h.select.mockReturnValueOnce(chain([{ userId: OPENER, partnerId: PARTNER, roleId: 'r-child' }]));
    h.grants.mockResolvedValueOnce(new Map([['r-child', BOTH]]));
    const held = await openersHoldingOpenPermissions([{ userId: OPENER, partnerId: PARTNER }]);
    expect(held.has(`${OPENER}:${PARTNER}`)).toBe(true);
  });

  it('does not hold when a required permission is missing', async () => {
    h.select.mockReturnValueOnce(chain([{ userId: OPENER, partnerId: PARTNER, roleId: 'r-half' }]));
    h.grants.mockResolvedValueOnce(new Map([['r-half', [BOTH[0]!]]]));
    expect((await openersHoldingOpenPermissions([{ userId: OPENER, partnerId: PARTNER }])).size).toBe(0);
  });

  it('is wildcard-aware', async () => {
    h.select.mockReturnValueOnce(chain([{ userId: OPENER, partnerId: PARTNER, roleId: 'r-admin' }]));
    h.grants.mockResolvedValueOnce(new Map([['r-admin', [{ resource: '*', action: '*' }]]]));
    expect((await openersHoldingOpenPermissions([{ userId: OPENER, partnerId: PARTNER }])).size).toBe(1);
  });

  it('needs ONE membership to carry every permission (grants of two memberships are not pooled)', async () => {
    h.select.mockReturnValueOnce(chain([
      { userId: OPENER, partnerId: PARTNER, roleId: 'r-a' },
      { userId: OPENER, partnerId: PARTNER, roleId: 'r-b' },
    ]));
    h.grants.mockResolvedValueOnce(new Map([['r-a', [BOTH[0]!]], ['r-b', [BOTH[1]!]]]));
    expect((await openersHoldingOpenPermissions([{ userId: OPENER, partnerId: PARTNER }])).size).toBe(0);
  });

  it('reads nothing for an empty pair list', async () => {
    h.select.mockClear();
    expect((await openersHoldingOpenPermissions([])).size).toBe(0);
    expect(h.select).not.toHaveBeenCalled();
  });

  it('passes the supplied executor to both reads', async () => {
    const exec = { select: vi.fn().mockReturnValueOnce(chain([{ userId: OPENER, partnerId: PARTNER, roleId: 'r1' }])) };
    h.grants.mockResolvedValueOnce(new Map([['r1', BOTH]]));
    await openersHoldingOpenPermissions([{ userId: OPENER, partnerId: PARTNER }], exec as never);
    expect(exec.select).toHaveBeenCalledTimes(1);
    expect(h.grants.mock.calls.at(-1)![1]).toBe(exec);
  });
});

describe('sweepMigrationWindows — opener permission check', () => {
  const candidateRow = (over: Record<string, unknown> = {}) => ({
    id: 'w-1', openedBy: OPENER, partnerId: PARTNER,
    endsAt: new Date(Date.now() + DAY),
    principalStatus: 'active', principalExpiresAt: null, principalScopes: ['tickets:write'],
    openerStatus: 'active', openerCredentialEpoch: 7, openerMfaEpoch: 2,
    snapshotCredentialEpoch: 7, snapshotMfaEpoch: 2,
    openerIsPartnerWideAdmin: true,
    // What the old SQL EXISTS computed for an inherited-only role: false.
    openerHoldsOpenPermissions: false,
    ...over,
  });

  function arrange(roleGrants: Map<string, Array<{ resource: string; action: string }>>) {
    h.select.mockReset();
    h.transaction.mockReset();
    h.transaction.mockResolvedValue({ alreadyClosed: false });
    h.select
      .mockReturnValueOnce(chain([candidateRow()]))                       // candidates
      .mockReturnValueOnce(chain([{ userId: OPENER, partnerId: PARTNER, roleId: 'r-child' }])) // memberships
      .mockReturnValue(chain([]));                                        // pending summaries
    h.grants.mockReset();
    h.grants.mockResolvedValueOnce(roleGrants);
  }

  it('keeps a window open when the opener\'s role holds the permissions only by inheritance', async () => {
    arrange(new Map([['r-child', BOTH]]));
    const out = await sweepMigrationWindows(new Date());
    expect(out.closed).toBe(0);
    expect(h.transaction).not.toHaveBeenCalled();
  });

  it('closes the window when the opener\'s resolved grants no longer cover the permissions (downgrade)', async () => {
    arrange(new Map([['r-child', [BOTH[0]!]]]));
    const out = await sweepMigrationWindows(new Date());
    expect(out.closed).toBe(1);
    expect(h.transaction).toHaveBeenCalledTimes(1);
  });
});
