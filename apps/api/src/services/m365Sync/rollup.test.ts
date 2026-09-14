import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    stateRows: [] as unknown[],
    values: [] as Record<string, unknown>[],
    set: {} as Record<string, unknown>,
    target: [] as unknown[],
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => {
      mocks.select(...args);
      return { from: () => ({ where: async () => mocks.stateRows }) };
    },
    insert: (...args: unknown[]) => {
      mocks.insert(...args);
      return {
        values: (row: Record<string, unknown>) => {
          mocks.values.push(row);
          return {
            onConflictDoUpdate: (arg: { target: unknown[]; set: Record<string, unknown> }) => {
              mocks.set = arg.set; mocks.target = arg.target;
              return Promise.resolve();
            },
          };
        },
      };
    },
  },
}));

import { getTableColumns } from 'drizzle-orm';
import { M365_SYNC_DOMAINS } from '@breeze/shared/m365';
import { m365PostureRollups } from '../../db/schema';
import { ROLLUP_COUNTER_SOURCES, upsertPostureRollup } from './rollup';

const ORG = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';

function state(domain: string, counts: Record<string, number> | null, completeAt: Date | null) {
  return { domain, lastCounts: counts, lastCompleteSnapshotAt: completeAt };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stateRows = []; mocks.values = []; mocks.set = {}; mocks.target = [];
});

describe('upsertPostureRollup (spec §5.9)', () => {
  it('assembles every counter from the six last_counts with ONE read and ONE upsert', async () => {
    mocks.stateRows = [
      state('users', {
        users_total: 120, users_enabled: 118, users_mfa_registered: 100,
        users_mfa_unknown: 5, users_admin: 4, admins_without_mfa: 1, admins_mfa_unknown: 0,
      }, new Date('2026-09-08T06:00:00.000Z')),
      state('intune_devices', {
        devices_total: 90, devices_compliant: 80, devices_noncompliant: 6, devices_in_grace: 2, devices_unknown: 2,
      }, new Date('2026-09-08T05:00:00.000Z')),
      state('ca_policies', { ca_policies_enabled: 7, ca_policies_report_only: 2, ca_policies_disabled: 1 }, new Date('2026-09-08T04:00:00.000Z')),
      state('skus', { seats_purchased: 150, seats_consumed: 120 }, new Date('2026-09-08T03:00:00.000Z')),
      state('secure_score', { secure_score: 412.5, secure_score_max: 600 }, new Date('2026-09-08T02:00:00.000Z')),
      state('signin_activity', {}, new Date('2026-09-07T02:00:00.000Z')),
    ];

    await upsertPostureRollup(ORG, TENANT, '2026-09-08');

    expect(mocks.select).toHaveBeenCalledOnce();
    expect(mocks.insert).toHaveBeenCalledOnce();
    expect(mocks.values[0]).toMatchObject({
      orgId: ORG, tenantId: TENANT, rollupDate: '2026-09-08',
      usersTotal: 120, usersEnabled: 118, usersMfaRegistered: 100, usersMfaUnknown: 5,
      usersAdmin: 4, adminsWithoutMfa: 1, adminsMfaUnknown: 0,
      devicesTotal: 90, devicesCompliant: 80, devicesNoncompliant: 6, devicesInGrace: 2, devicesUnknown: 2,
      caPoliciesEnabled: 7, caPoliciesReportOnly: 2, caPoliciesDisabled: 1,
      seatsPurchased: 150, seatsConsumed: 120,
      // numeric(8,2) columns are bound as strings by drizzle
      secureScore: '412.5', secureScoreMax: '600',
    });
  });

  it('writes NULL — never 0 — for a counter whose source never reported it', async () => {
    mocks.stateRows = [state('users', { users_total: 10, users_enabled: 10 }, new Date('2026-09-08T06:00:00.000Z'))];
    await upsertPostureRollup(ORG, TENANT, '2026-09-08');
    const row = mocks.values[0]!;
    expect(row.usersTotal).toBe(10);
    for (const column of ['usersMfaRegistered', 'usersMfaUnknown', 'adminsWithoutMfa', 'devicesTotal', 'secureScore', 'seatsPurchased']) {
      expect(row[column]).toBeNull();
    }
  });

  it('ignores a non-numeric counter value rather than writing garbage', async () => {
    mocks.stateRows = [state('users', { users_total: 'many' as unknown as number }, null)];
    await upsertPostureRollup(ORG, TENANT, '2026-09-08');
    expect(mocks.values[0]!.usersTotal).toBeNull();
  });

  it('records domains_fresh for all six domains from last_complete_snapshot_at', async () => {
    mocks.stateRows = [
      state('users', { users_total: 1 }, new Date('2026-09-08T06:00:00.000Z')),
      state('skus', null, null),
    ];
    await upsertPostureRollup(ORG, TENANT, '2026-09-08');
    const fresh = mocks.values[0]!.domainsFresh as Record<string, unknown>;
    expect(fresh.users).toEqual({ asOf: '2026-09-08T06:00:00.000Z', complete: true });
    expect(fresh.skus).toEqual({ asOf: null, complete: false });
    expect(fresh.secure_score).toEqual({ asOf: null, complete: false });
    expect(Object.keys(fresh).sort()).toEqual([...M365_SYNC_DOMAINS].sort());
  });

  it('upserts on (org_id, rollup_date) and refreshes the tenant, counters and freshness', async () => {
    mocks.stateRows = [state('users', { users_total: 1 }, new Date())];
    await upsertPostureRollup(ORG, TENANT, '2026-09-08');
    expect(mocks.target).toEqual([m365PostureRollups.orgId, m365PostureRollups.rollupDate]);
    expect(mocks.set).toMatchObject({ tenantId: TENANT, usersTotal: 1 });
    expect(Object.keys(mocks.set)).toEqual(expect.arrayContaining(['computedAt', 'domainsFresh', 'secureScore']));
    expect(mocks.set).not.toHaveProperty('orgId');
    expect(mocks.set).not.toHaveProperty('rollupDate');
  });

  it('maps every counter column of m365_posture_rollups exactly once', () => {
    const mapped = Object.values(ROLLUP_COUNTER_SOURCES).flatMap((map) => Object.values(map));
    expect(new Set(mapped).size).toBe(mapped.length);
    const tableCounterColumns = Object.keys(getTableColumns(m365PostureRollups))
      .filter((key) => !['id', 'orgId', 'tenantId', 'rollupDate', 'domainsFresh', 'computedAt'].includes(key));
    expect([...mapped].sort()).toEqual(tableCounterColumns.sort());
  });
});
