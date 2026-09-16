import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    insertedRows: [] as Record<string, unknown>[],
    conflictSet: {} as Record<string, unknown>,
    deletedTables: [] as string[],
    updateSet: {} as Record<string, unknown>,
    rearmed: [] as Array<{ domain: string }>,
    insertThrows: false,
    deleteThrows: false,
    systemContext: vi.fn(),
    outside: vi.fn(),
    outsideDepth: 0,
    claimedOutsideContext: [] as boolean[],
    claim: vi.fn(async () => undefined),
    flag: vi.fn(() => true),
  },
}));

vi.mock('../../db', () => ({
  db: {
    insert: () => {
      if (mocks.insertThrows) throw new Error('boom');
      return {
        values: (rows: Record<string, unknown>[]) => {
          mocks.insertedRows.push(...rows);
          return { onConflictDoUpdate: (a: { set: Record<string, unknown> }) => { mocks.conflictSet = a.set; return Promise.resolve(); } };
        },
      };
    },
    delete: (table: unknown) => {
      if (mocks.deleteThrows) throw new Error('boom');
      mocks.deletedTables.push(getTableName(table as never));
      return { where: async () => undefined };
    },
    update: () => ({
      set: (payload: Record<string, unknown>) => {
        mocks.updateSet = payload;
        return { where: () => ({ returning: async () => mocks.rearmed }) };
      },
    }),
  },
  withSystemDbAccessContext: async (fn: () => Promise<unknown>) => { mocks.systemContext(); return fn(); },
  runOutsideDbContext: (fn: () => unknown) => {
    mocks.outside();
    mocks.outsideDepth += 1;
    try { return fn(); } finally { mocks.outsideDepth -= 1; }
  },
}));
vi.mock('../../config/env', () => ({ isM365TenantSyncEnabled: mocks.flag }));
vi.mock('./claim', () => ({ claimAndEnqueue: mocks.claim }));

import {
  ON_DEMAND_SYNC_DOMAINS,
  onConnectionConsented,
  onConnectionDisconnected,
  onConnectionUpgraded,
  requestOnDemandSync,
} from './lifecycle';

const ORG = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const CONNECTION = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.insertedRows = []; mocks.conflictSet = {}; mocks.deletedTables = []; mocks.updateSet = {};
  mocks.rearmed = [{ domain: 'users' }, { domain: 'ca_policies' }];
  mocks.insertThrows = false; mocks.deleteThrows = false;
  mocks.flag.mockReturnValue(true);
  mocks.outsideDepth = 0;
  mocks.claimedOutsideContext = [];
  mocks.claim.mockImplementation(async () => { mocks.claimedOutsideContext.push(mocks.outsideDepth > 0); });
});

describe('every claim escapes the ambient DB context first', () => {
  // Nested in a request transaction, the claim's generation bump would not
  // commit before the job is in Redis, and the worker would fence itself.
  it.each([
    ['onConnectionConsented', () => onConnectionConsented({ id: CONNECTION, orgId: ORG, tenantId: TENANT, status: 'active' })],
    ['onConnectionUpgraded', () => onConnectionUpgraded({ id: CONNECTION, orgId: ORG })],
    ['requestOnDemandSync', () => requestOnDemandSync({ orgId: ORG, connectionId: CONNECTION })],
  ] as const)('%s', async (_name, call) => {
    await call();
    expect(mocks.claimedOutsideContext).toEqual([true]);
  });
});

describe('onConnectionConsented (spec §5.8)', () => {
  it('seeds all seven domains due now, bound to the org and connection, and claims them at priority 1', async () => {
    await onConnectionConsented({ id: CONNECTION, orgId: ORG, tenantId: TENANT, status: 'active' });
    expect(mocks.insertedRows.map((r) => r.domain).sort()).toEqual([
      'ca_policies', 'intune_devices', 'secure_score', 'signin_activity', 'signin_events', 'skus', 'users',
    ]);
    for (const row of mocks.insertedRows) {
      expect(row).toMatchObject({ orgId: ORG, connectionId: CONNECTION });
      expect(row.nextSyncAt).toBeInstanceOf(Date);
      expect(typeof row.intervalSeconds).toBe('number');
    }
    expect(mocks.claim).toHaveBeenCalledWith(ORG, expect.arrayContaining(['users', 'signin_activity', 'secure_score']), 1);
  });

  it('opens its own system context — the consent callback holds none', async () => {
    await onConnectionConsented({ id: CONNECTION, orgId: ORG, tenantId: TENANT, status: 'active' });
    expect(mocks.outside).toHaveBeenCalled();
    expect(mocks.systemContext).toHaveBeenCalled();
  });

  it('seeds a DEGRADED connection too', async () => {
    await onConnectionConsented({ id: CONNECTION, orgId: ORG, tenantId: TENANT, status: 'degraded' });
    expect(mocks.insertedRows).toHaveLength(7);
    expect(mocks.claim).toHaveBeenCalledOnce();
  });

  it('re-points and re-arms existing rows on conflict without resetting their history', async () => {
    await onConnectionConsented({ id: CONNECTION, orgId: ORG, tenantId: TENANT, status: 'active' });
    expect(Object.keys(mocks.conflictSet).sort()).toEqual(['connectionId', 'nextSyncAt', 'updatedAt']);
  });

  it('does nothing when the flag is off', async () => {
    mocks.flag.mockReturnValue(false);
    await onConnectionConsented({ id: CONNECTION, orgId: ORG, tenantId: TENANT, status: 'active' });
    expect(mocks.insertedRows).toEqual([]);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('never throws — a seeding fault must not fail a successful consent', async () => {
    mocks.insertThrows = true;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(onConnectionConsented({ id: CONNECTION, orgId: ORG, tenantId: TENANT, status: 'active' }))
        .resolves.toBeUndefined();
      expect(spy).toHaveBeenCalled();
    } finally { spy.mockRestore(); }
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('never throws when the claim/enqueue fails after seeding committed', async () => {
    mocks.claim.mockRejectedValueOnce(new Error('redis down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(onConnectionConsented({ id: CONNECTION, orgId: ORG, tenantId: TENANT, status: 'active' }))
        .resolves.toBeUndefined();
    } finally { spy.mockRestore(); }
    expect(mocks.insertedRows).toHaveLength(7);
  });
});

describe('onConnectionDisconnected (spec §5.8)', () => {
  it('deletes the four entity tables and the state rows, keeping the tenant-stamped history', async () => {
    await onConnectionDisconnected({ id: CONNECTION, orgId: ORG });
    expect(mocks.deletedTables.sort()).toEqual([
      'm365_ca_policies', 'm365_intune_devices', 'm365_license_skus', 'm365_sync_state', 'm365_users',
    ]);
    expect(mocks.deletedTables).not.toContain('m365_secure_score_snapshots');
    expect(mocks.deletedTables).not.toContain('m365_posture_rollups');
    // #5784 W05: sign-in events are history too. Graph keeps ~30 days, so a
    // disconnect that dropped them would destroy evidence nothing can reproduce.
    expect(mocks.deletedTables).not.toContain('m365_signin_events');
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('deletes the state rows FIRST, so in-flight persist chunks are waited on and later ones fence', async () => {
    await onConnectionDisconnected({ id: CONNECTION, orgId: ORG });
    expect(mocks.deletedTables[0]).toBe('m365_sync_state');
  });

  it('runs on the AMBIENT context — it never opens its own', async () => {
    await onConnectionDisconnected({ id: CONNECTION, orgId: ORG });
    expect(mocks.systemContext).not.toHaveBeenCalled();
    expect(mocks.outside).not.toHaveBeenCalled();
  });

  it('THROWS on failure so the caller transaction rolls back', async () => {
    mocks.deleteThrows = true;
    await expect(onConnectionDisconnected({ id: CONNECTION, orgId: ORG })).rejects.toThrow('boom');
  });

  it('erases regardless of the flag — a disconnect must not leave data behind', async () => {
    mocks.flag.mockReturnValue(false);
    await onConnectionDisconnected({ id: CONNECTION, orgId: ORG });
    expect(mocks.deletedTables).toHaveLength(5);
  });
});

describe('onConnectionUpgraded (spec §5.7, §5.8)', () => {
  it('re-arms only unscheduled needs_consent rows and claims exactly the ones it armed', async () => {
    await onConnectionUpgraded({ id: CONNECTION, orgId: ORG });
    expect(Object.keys(mocks.updateSet)).toEqual(expect.arrayContaining(['nextSyncAt', 'updatedAt']));
    expect(mocks.claim).toHaveBeenCalledWith(ORG, ['users', 'ca_policies'], 1);
  });

  it('claims nothing when no row was re-armed', async () => {
    mocks.rearmed = [];
    await onConnectionUpgraded({ id: CONNECTION, orgId: ORG });
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('does nothing when the flag is off, and never throws', async () => {
    mocks.flag.mockReturnValue(false);
    await expect(onConnectionUpgraded({ id: CONNECTION, orgId: ORG })).resolves.toBeUndefined();
    expect(mocks.updateSet).toEqual({});
  });

  it('swallows and logs a failure', async () => {
    mocks.claim.mockRejectedValueOnce(new Error('redis down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(onConnectionUpgraded({ id: CONNECTION, orgId: ORG })).resolves.toBeUndefined();
      expect(spy).toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
});

describe('requestOnDemandSync (spec §5.2)', () => {
  it('claims the five non-sign-in domains at priority 1', async () => {
    // #5784 W05: BOTH sign-in domains are excluded — signin_events hits
    // /auditLogs/signIns with its own app-wide bucket, so one technician
    // pressing "Sync now" must not be able to spend the region's budget.
    expect(ON_DEMAND_SYNC_DOMAINS).not.toContain('signin_activity');
    expect(ON_DEMAND_SYNC_DOMAINS).not.toContain('signin_events');
    expect(ON_DEMAND_SYNC_DOMAINS).toHaveLength(5);
    await requestOnDemandSync({ orgId: ORG, connectionId: CONNECTION });
    expect(mocks.claim).toHaveBeenCalledWith(ORG, [...ON_DEMAND_SYNC_DOMAINS], 1);
  });

  it('does nothing when the flag is off', async () => {
    mocks.flag.mockReturnValue(false);
    await requestOnDemandSync({ orgId: ORG, connectionId: CONNECTION });
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('propagates a claim failure — the route reports it', async () => {
    mocks.claim.mockRejectedValueOnce(new Error('redis down'));
    await expect(requestOnDemandSync({ orgId: ORG, connectionId: CONNECTION })).rejects.toThrow('redis down');
  });
});
