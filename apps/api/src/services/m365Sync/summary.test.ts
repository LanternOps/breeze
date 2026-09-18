import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const { mocks } = vi.hoisted(() => ({
  mocks: {
    flag: vi.fn(() => true),
    selectCalls: 0,
    stateRows: [] as unknown[],
    rollupRows: [] as unknown[],
    rollupWhere: null as unknown,
  },
}));

vi.mock('../../config/env', () => ({ isM365TenantSyncEnabled: mocks.flag }));
vi.mock('../../db', () => ({
  db: {
    select: () => {
      mocks.selectCalls += 1;
      const call = mocks.selectCalls;
      return {
        from: () => ({
          where: (condition: unknown) => {
            if (call === 1) return Promise.resolve(mocks.stateRows);
            mocks.rollupWhere = condition;
            return { orderBy: () => ({ limit: async () => mocks.rollupRows }) };
          },
        }),
      };
    },
  },
}));

import { loadDomainFreshness, loadSyncSummary } from './summary';

const ORG = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';

function state(overrides: Record<string, unknown>) {
  return {
    domain: 'users',
    lastStatus: 'success',
    lastSuccessAt: new Date('2026-09-08T06:00:00.000Z'),
    lastCompleteSnapshotAt: new Date('2026-09-08T06:00:00.000Z'),
    truncated: false,
    sources: { users: 'ok' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.flag.mockReturnValue(true);
  mocks.selectCalls = 0; mocks.stateRows = []; mocks.rollupRows = []; mocks.rollupWhere = null;
});

describe('loadSyncSummary', () => {
  it('returns null and issues NO query when the flag is off', async () => {
    mocks.flag.mockReturnValue(false);
    await expect(loadSyncSummary(ORG, TENANT)).resolves.toBeNull();
    expect(mocks.selectCalls).toBe(0);
  });

  it('returns null, and never reads the rollup, when the org has no state rows', async () => {
    await expect(loadSyncSummary(ORG, TENANT)).resolves.toBeNull();
    expect(mocks.selectCalls).toBe(1);
  });

  it('lists all seven domains in canonical order, filling gaps as never-synced', async () => {
    mocks.stateRows = [state({})];
    const summary = (await loadSyncSummary(ORG, TENANT))!;
    expect(summary.domains.map((d) => d.domain)).toEqual([
      'users', 'signin_activity', 'intune_devices', 'ca_policies', 'skus', 'secure_score',
      'signin_events',
    ]);
    expect(summary.domains[0]).toEqual({
      domain: 'users', status: 'success', asOf: '2026-09-08T06:00:00.000Z', truncated: false, unlicensed: false,
    });
    expect(summary.domains[1]).toEqual({
      domain: 'signin_activity', status: 'never', asOf: null, truncated: false, unlicensed: false,
    });
  });

  it("reports 'never' for a NULL last_status and asOf from last_complete_snapshot_at, not last_success_at", async () => {
    mocks.stateRows = [
      state({ lastStatus: null, lastSuccessAt: null, lastCompleteSnapshotAt: null }),
      state({
        domain: 'skus', lastStatus: 'partial',
        lastSuccessAt: new Date('2026-09-08T09:00:00.000Z'),
        lastCompleteSnapshotAt: new Date('2026-09-08T06:00:00.000Z'),
      }),
    ];
    const summary = (await loadSyncSummary(ORG, TENANT))!;
    const byDomain = Object.fromEntries(summary.domains.map((d) => [d.domain, d]));
    expect(byDomain.users).toMatchObject({ status: 'never', asOf: null });
    expect(byDomain.skus).toMatchObject({ status: 'partial', asOf: '2026-09-08T06:00:00.000Z' });
  });

  it('reports the NEWEST successful domain as lastSuccessAt', async () => {
    mocks.stateRows = [
      state({ domain: 'users', lastSuccessAt: new Date('2026-09-08T06:00:00.000Z') }),
      state({ domain: 'skus', lastSuccessAt: new Date('2026-09-08T09:00:00.000Z') }),
      state({ domain: 'ca_policies', lastStatus: 'needs_consent', lastSuccessAt: null, lastCompleteSnapshotAt: null }),
    ];
    expect((await loadSyncSummary(ORG, TENANT))!.lastSuccessAt).toBe('2026-09-08T09:00:00.000Z');
  });

  it('carries needs_consent, throttled and error through as statuses, never as a second boolean', async () => {
    mocks.stateRows = [
      state({ domain: 'ca_policies', lastStatus: 'needs_consent' }),
      state({ domain: 'skus', lastStatus: 'throttled' }),
      state({ domain: 'secure_score', lastStatus: 'error' }),
    ];
    const byDomain = Object.fromEntries((await loadSyncSummary(ORG, TENANT))!.domains.map((d) => [d.domain, d]));
    expect(byDomain.ca_policies!.status).toBe('needs_consent');
    expect(byDomain.skus!.status).toBe('throttled');
    expect(byDomain.secure_score!.status).toBe('error');
    expect(byDomain.ca_policies).not.toHaveProperty('needsConsent');
  });

  it("flags truncated per domain and unlicensed from the domain's OWN primary source", async () => {
    // #5784 W05: this used to read the literal `signInActivity` key for every
    // domain, so a seventh domain with its own primary source could never be
    // flagged. It now keys off M365_SYNC_PRIMARY_SOURCE_KEY — a secondary
    // source reporting 'unlicensed' still must NOT flag the domain.
    mocks.stateRows = [
      state({ domain: 'users', lastStatus: 'partial', truncated: true }),
      state({ domain: 'signin_activity', sources: { signInActivity: 'unlicensed' } }),
      state({ domain: 'signin_events', sources: { signinEvents: 'unlicensed' } }),
      state({ domain: 'skus', sources: { subscribedSkus: 'unlicensed' } }),
      // secureScores is the PRIMARY for secure_score; controlProfiles is not.
      state({ domain: 'secure_score', sources: { secureScores: 'ok', controlProfiles: 'unlicensed' } }),
    ];
    const byDomain = Object.fromEntries((await loadSyncSummary(ORG, TENANT))!.domains.map((d) => [d.domain, d]));
    expect(byDomain.users!.truncated).toBe(true);
    expect(byDomain.signin_activity!.unlicensed).toBe(true);
    expect(byDomain.signin_events!.unlicensed).toBe(true);
    expect(byDomain.skus!.unlicensed).toBe(true);
    expect(byDomain.secure_score!.unlicensed).toBe(false);
    // A domain with no state row at all is not "unlicensed", just never synced.
    expect(byDomain.ca_policies!.unlicensed).toBe(false);
  });

  it("takes users and devices from the newest rollup of the CURRENT connection's tenant", async () => {
    mocks.stateRows = [state({})];
    mocks.rollupRows = [{ users: 128, devices: 96 }];
    const summary = (await loadSyncSummary(ORG, TENANT))!;
    expect(summary).toMatchObject({ users: 128, devices: 96 });
    // history survives a rebind, so the read must be filtered to this tenant
    const { params } = new PgDialect().sqlToQuery(mocks.rollupWhere as never);
    expect(params).toEqual(expect.arrayContaining([ORG, TENANT]));
  });

  it('reports users and devices as null with no rollup, a NULL counter, or no verified tenant', async () => {
    mocks.stateRows = [state({})];
    await expect(loadSyncSummary(ORG, TENANT)).resolves.toMatchObject({ users: null, devices: null });

    mocks.selectCalls = 0;
    mocks.rollupRows = [{ users: 10, devices: null }];
    await expect(loadSyncSummary(ORG, TENANT)).resolves.toMatchObject({ users: 10, devices: null });

    mocks.selectCalls = 0;
    await expect(loadSyncSummary(ORG, null)).resolves.toMatchObject({ users: null, devices: null });
    expect(mocks.selectCalls).toBe(1);
  });

  it("is null-safe on an unknown stored status, reporting 'never' rather than leaking it", async () => {
    mocks.stateRows = [state({ lastStatus: 'weird' })];
    expect((await loadSyncSummary(ORG, TENANT))!.domains[0]!.status).toBe('never');
  });
});

// #5784 W03/W06 — the per-domain freshness reader the report generators use.
// Same name and shape in both waves so they converge rather than fork.
describe('loadDomainFreshness', () => {
  it('reads asOf from last_complete_snapshot_at, never last_success_at', async () => {
    mocks.stateRows = [state({
      domain: 'intune_devices',
      lastStatus: 'partial',
      lastSuccessAt: new Date('2026-09-30T04:00:00Z'),
      lastCompleteSnapshotAt: new Date('2026-09-02T04:00:00Z'),
      truncated: true,
      sources: { intuneDevices: 'ok' },
    })];
    const got = await loadDomainFreshness(ORG, ['intune_devices']);
    // A partial run advances last_success_at without enumerating the tenant.
    // Using it would claim a freshness the data does not have (summary.ts).
    expect(got.intune_devices.asOf).toBe('2026-09-02T04:00:00.000Z');
    expect(got.intune_devices.lastStatus).toBe('partial');
    expect(got.intune_devices.truncated).toBe(true);
    expect(got.intune_devices.sources).toEqual({ intuneDevices: 'ok' });
  });

  it('reports a never-scheduled domain as asOf null rather than omitting it', async () => {
    const got = await loadDomainFreshness(ORG, ['intune_devices']);
    expect(got.intune_devices).toEqual({
      asOf: null, lastStatus: null, truncated: false, sources: null, unlicensed: false,
    });
  });

  it('flags the domain as unlicensed from its OWN primary source key', async () => {
    mocks.stateRows = [state({ domain: 'skus', lastStatus: 'success', sources: { subscribedSkus: 'unlicensed' } })];
    const got = await loadDomainFreshness(ORG, ['skus']);
    expect(got.skus.unlicensed).toBe(true);
  });

  it('issues exactly one query for several domains', async () => {
    const got = await loadDomainFreshness(ORG, ['intune_devices', 'skus']);
    expect(mocks.selectCalls).toBe(1);
    expect(Object.keys(got).sort()).toEqual(['intune_devices', 'skus']);
  });

  it('reads asOf from last_complete_snapshot_at for signin_events, never last_success_at', async () => {
    mocks.stateRows = [state({
      domain: 'signin_events',
      lastStatus: 'partial',
      lastSuccessAt: new Date('2026-09-30T04:00:00.000Z'),
      lastCompleteSnapshotAt: new Date('2026-09-02T04:00:00.000Z'),
      truncated: true,
      sources: { signinEvents: 'ok' },
    })];
    const got = await loadDomainFreshness(ORG, ['signin_events']);
    // A partial run advances last_success_at without enumerating the tenant.
    // Using it would claim a freshness the data does not have (summary.ts).
    expect(got.signin_events.asOf).toBe('2026-09-02T04:00:00.000Z');
    expect(got.signin_events.lastStatus).toBe('partial');
    expect(got.signin_events.truncated).toBe(true);
    expect(got.signin_events.unlicensed).toBe(false);
  });

  it('reports a never-scheduled signin_events domain as asOf null rather than omitting it', async () => {
    const got = await loadDomainFreshness(ORG, ['signin_events']);
    expect(got.signin_events).toEqual({
      asOf: null, lastStatus: null, truncated: false, sources: null, unlicensed: false,
    });
  });

  it('flags signin_events unlicensed from ITS OWN primary source key', async () => {
    mocks.stateRows = [state({
      domain: 'signin_events',
      sources: { signinEvents: 'unlicensed' },
    })];
    const got = await loadDomainFreshness(ORG, ['signin_events']);
    expect(got.signin_events.unlicensed).toBe(true);
  });

  it('issues exactly one query for several domains including signin_events', async () => {
    await loadDomainFreshness(ORG, ['signin_events', 'ca_policies', 'users']);
    expect(mocks.selectCalls).toBe(1);
  });
});
