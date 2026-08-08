import { beforeEach, describe, expect, it, vi } from 'vitest';

// Tag-based eq/and/inArray/isNull spies: reconcile.ts never executes real SQL in
// these unit tests (the mocked `db` below never touches Postgres), so replacing
// the drizzle-orm condition builders with plain tagged objects lets tests assert
// exactly which column/value a where-clause was built from without decoding a
// real SQL AST. Mirrors the pattern in services/binarySync.test.ts.
const drizzleSpies = vi.hoisted(() => ({
  eq: vi.fn((column: unknown, value: unknown) => ({ __op: 'eq', column, value })),
  and: vi.fn((...clauses: unknown[]) => ({ __op: 'and', clauses })),
  inArray: vi.fn((column: unknown, values: unknown[]) => ({ __op: 'inArray', column, values })),
  isNull: vi.fn((column: unknown) => ({ __op: 'isNull', column })),
}));

vi.mock('drizzle-orm', async (importActual) => {
  const actual = await importActual<typeof import('drizzle-orm')>();
  return { ...actual, eq: drizzleSpies.eq, and: drizzleSpies.and, inArray: drizzleSpies.inArray, isNull: drizzleSpies.isNull };
});

const dbMocks = vi.hoisted(() => {
  const state: {
    selectQueue: unknown[][];
    insertReturningQueue: unknown[][];
    insertCalls: Array<{ table: unknown; values: unknown }>;
    updateCalls: Array<{ table: unknown; values: unknown; where: unknown }>;
    deleteCalls: Array<{ table: unknown; where: unknown }>;
  } = {
    selectQueue: [],
    insertReturningQueue: [],
    insertCalls: [],
    updateCalls: [],
    deleteCalls: [],
  };

  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve(state.selectQueue.shift() ?? [])),
    })),
  }));

  const insert = vi.fn((table: unknown) => ({
    values: vi.fn((values: unknown) => {
      state.insertCalls.push({ table, values });
      const p = Promise.resolve(undefined) as Promise<undefined> & { returning?: () => Promise<unknown[]> };
      p.returning = vi.fn(() => Promise.resolve(state.insertReturningQueue.shift() ?? []));
      return p;
    }),
  }));

  const update = vi.fn((table: unknown) => ({
    set: vi.fn((values: unknown) => ({
      where: vi.fn((where: unknown) => {
        state.updateCalls.push({ table, values, where });
        return Promise.resolve(undefined);
      }),
    })),
  }));

  const del = vi.fn((table: unknown) => ({
    where: vi.fn((where: unknown) => {
      state.deleteCalls.push({ table, where });
      return Promise.resolve(undefined);
    }),
  }));

  const dbLike = { select, insert, update, delete: del };
  const transaction = vi.fn(async (fn: (tx: typeof dbLike) => Promise<unknown>) => fn(dbLike));

  return { state, select, insert, update, delete: del, transaction, dbLike };
});

vi.mock('../../db', () => ({
  db: {
    select: dbMocks.select,
    insert: dbMocks.insert,
    update: dbMocks.update,
    delete: dbMocks.delete,
    transaction: dbMocks.transaction,
  },
}));

import { fleetFindings, fleetFindingDevices } from '../../db/schema/fleetFindings';
import { FLEET_FINDINGS_ALGORITHM_VERSION, reconcileOrgFindings } from './reconcile';
import type { CandidateFinding } from './types';

const ORG_ID = '11111111-1111-1111-1111-111111111111';

function baseFindingRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'finding-1',
    orgId: ORG_ID,
    kind: 'metric_anomaly_pattern',
    semanticKey: 'metric:cpu_percent:spike',
    algorithmVersion: FLEET_FINDINGS_ALGORITHM_VERSION,
    status: 'open',
    severity: 'warning',
    title: 'CPU spike pattern: cpu_percent on 2 devices',
    summary: 'summary',
    evidence: { totalAffected: 2 },
    deviceCount: 2,
    revision: 1,
    firstSeenAt: new Date('2026-08-01T00:00:00Z'),
    lastSeenAt: new Date('2026-08-01T00:00:00Z'),
    lastReconciledAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    dismissedAt: null,
    dismissedBy: null,
    dismissNotes: null,
    resolvedAt: null,
    resolutionReason: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  };
}

function candidate(overrides: Partial<CandidateFinding> = {}): CandidateFinding {
  return {
    kind: 'metric_anomaly_pattern',
    semanticKey: 'metric:cpu_percent:spike',
    severity: 'warning',
    title: 'CPU spike pattern: cpu_percent on 2 devices',
    summary: 'summary',
    evidence: { totalAffected: 2 },
    members: [
      { deviceId: 'device-a', sourceKind: 'metric_anomaly', sourceRowId: 'anomaly-a', memberEvidence: { score: 3 } },
      { deviceId: 'device-b', sourceKind: 'metric_anomaly', sourceRowId: 'anomaly-b', memberEvidence: { score: 3.2 } },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  dbMocks.state.selectQueue = [];
  dbMocks.state.insertReturningQueue = [];
  dbMocks.state.insertCalls = [];
  dbMocks.state.updateCalls = [];
  dbMocks.state.deleteCalls = [];
  dbMocks.select.mockClear();
  dbMocks.insert.mockClear();
  dbMocks.update.mockClear();
  dbMocks.delete.mockClear();
  dbMocks.transaction.mockClear();
  drizzleSpies.eq.mockClear();
  drizzleSpies.and.mockClear();
  drizzleSpies.inArray.mockClear();
  drizzleSpies.isNull.mockClear();
});

describe('reconcileOrgFindings', () => {
  it('1. opens a new live episode for a candidate with no existing row (upsert by org/kind/semanticKey/algorithmVersion)', async () => {
    dbMocks.state.selectQueue = [[]]; // no live rows
    dbMocks.state.insertReturningQueue = [[{ id: 'new-finding-id' }]];

    const result = await reconcileOrgFindings(ORG_ID, [candidate()]);

    expect(result).toEqual({ opened: 1, updated: 0, resolved: 0 });
    // First insert call is the finding row itself.
    const findingInsert = dbMocks.state.insertCalls.find((c) => c.table === fleetFindings);
    expect(findingInsert).toBeDefined();
    expect(findingInsert!.values).toMatchObject({
      orgId: ORG_ID,
      kind: 'metric_anomaly_pattern',
      semanticKey: 'metric:cpu_percent:spike',
      algorithmVersion: FLEET_FINDINGS_ALGORITHM_VERSION,
      status: 'open',
      severity: 'warning',
      deviceCount: 2,
      revision: 1,
    });
    const memberInsert = dbMocks.state.insertCalls.find((c) => c.table === fleetFindingDevices);
    expect(memberInsert).toBeDefined();
    expect(memberInsert!.values).toEqual([
      expect.objectContaining({ findingId: 'new-finding-id', deviceId: 'device-a' }),
      expect.objectContaining({ findingId: 'new-finding-id', deviceId: 'device-b' }),
    ]);
  });

  it('2. inserts new members, updates last_seen_at on kept members, and deletes members absent from candidates', async () => {
    const liveRow = baseFindingRow();
    dbMocks.state.selectQueue = [
      [liveRow], // live episodes for org
      [
        { findingId: 'finding-1', orgId: ORG_ID, deviceId: 'device-a', sourceKind: 'metric_anomaly', sourceRowId: 'anomaly-a', memberEvidence: {}, firstSeenAt: new Date(), lastSeenAt: new Date() },
        { findingId: 'finding-1', orgId: ORG_ID, deviceId: 'device-b', sourceKind: 'metric_anomaly', sourceRowId: 'anomaly-b', memberEvidence: {}, firstSeenAt: new Date(), lastSeenAt: new Date() },
      ], // existing members for finding-1
    ];

    const cand = candidate({
      members: [
        { deviceId: 'device-a', sourceKind: 'metric_anomaly', sourceRowId: 'anomaly-a', memberEvidence: { score: 3 } },
        { deviceId: 'device-c', sourceKind: 'metric_anomaly', sourceRowId: 'anomaly-c', memberEvidence: { score: 5 } },
      ],
    });

    await reconcileOrgFindings(ORG_ID, [cand]);

    const memberInsert = dbMocks.state.insertCalls.find((c) => c.table === fleetFindingDevices);
    expect(memberInsert!.values).toEqual([
      expect.objectContaining({ findingId: 'finding-1', deviceId: 'device-c' }),
    ]);

    const memberDelete = dbMocks.state.deleteCalls.find((c) => c.table === fleetFindingDevices);
    expect(memberDelete).toBeDefined();
    expect(memberDelete!.where).toEqual({
      __op: 'and',
      clauses: [
        { __op: 'eq', column: fleetFindingDevices.findingId, value: 'finding-1' },
        { __op: 'inArray', column: fleetFindingDevices.deviceId, values: ['device-b'] },
      ],
    });

    const memberUpdate = dbMocks.state.updateCalls.find(
      (c) => c.table === fleetFindingDevices && (c.values as Record<string, unknown>).lastSeenAt,
    );
    expect(memberUpdate).toBeDefined();
    expect(memberUpdate!.where).toEqual({
      __op: 'and',
      clauses: [
        { __op: 'eq', column: fleetFindingDevices.findingId, value: 'finding-1' },
        { __op: 'eq', column: fleetFindingDevices.deviceId, value: 'device-a' },
      ],
    });
  });

  it('3. bumps revision, lastSeenAt, and deviceCount only when membership or evidence changed', async () => {
    const liveRow = baseFindingRow({ revision: 1, deviceCount: 2 });
    const existingMembers = [
      { findingId: 'finding-1', orgId: ORG_ID, deviceId: 'device-a', sourceKind: 'metric_anomaly', sourceRowId: 'anomaly-a', memberEvidence: {}, firstSeenAt: new Date(), lastSeenAt: new Date() },
      { findingId: 'finding-1', orgId: ORG_ID, deviceId: 'device-b', sourceKind: 'metric_anomaly', sourceRowId: 'anomaly-b', memberEvidence: {}, firstSeenAt: new Date(), lastSeenAt: new Date() },
    ];

    // Case A: identical membership + identical evidence -> no finding-level bump.
    dbMocks.state.selectQueue = [[liveRow], existingMembers];
    const unchangedCandidate = candidate({ evidence: { totalAffected: 2 } });
    let result = await reconcileOrgFindings(ORG_ID, [unchangedCandidate]);
    expect(result).toEqual({ opened: 0, updated: 0, resolved: 0 });
    expect(dbMocks.state.updateCalls.find((c) => c.table === fleetFindings)).toBeUndefined();

    dbMocks.state.updateCalls = [];
    dbMocks.state.deleteCalls = [];
    dbMocks.state.insertCalls = [];

    // Case B: evidence changed (membership identical) -> bump.
    dbMocks.state.selectQueue = [[liveRow], existingMembers];
    const evidenceChangedCandidate = candidate({ evidence: { totalAffected: 2, maxScore: 4.5 } });
    result = await reconcileOrgFindings(ORG_ID, [evidenceChangedCandidate]);
    expect(result).toEqual({ opened: 0, updated: 1, resolved: 0 });
    const findingUpdate = dbMocks.state.updateCalls.find((c) => c.table === fleetFindings);
    expect(findingUpdate).toBeDefined();
    expect(findingUpdate!.values).toMatchObject({
      revision: 2,
      deviceCount: 2,
      evidence: { totalAffected: 2, maxScore: 4.5 },
    });
  });

  it('4. resolves a live episode with resolutionReason=source_cleared when its candidate disappears', async () => {
    const liveRow = baseFindingRow({ id: 'finding-gone', semanticKey: 'metric:disk_io:spike' });
    dbMocks.state.selectQueue = [[liveRow]];

    const result = await reconcileOrgFindings(ORG_ID, []); // no candidates this pass

    expect(result).toEqual({ opened: 0, updated: 0, resolved: 1 });
    const findingUpdate = dbMocks.state.updateCalls.find((c) => c.table === fleetFindings);
    expect(findingUpdate).toBeDefined();
    expect(findingUpdate!.values).toMatchObject({
      status: 'resolved',
      resolutionReason: 'source_cleared',
    });
    expect((findingUpdate!.values as Record<string, unknown>).resolvedAt).toBeInstanceOf(Date);
    expect(findingUpdate!.where).toEqual({ __op: 'eq', column: fleetFindings.id, value: 'finding-gone' });
  });

  it('5. does not reopen a dismissed episode (membership still syncs, status/revision untouched)', async () => {
    const liveRow = baseFindingRow({ status: 'dismissed', dismissedAt: new Date('2026-08-02T00:00:00Z') });
    const existingMembers = [
      { findingId: 'finding-1', orgId: ORG_ID, deviceId: 'device-a', sourceKind: 'metric_anomaly', sourceRowId: 'anomaly-a', memberEvidence: {}, firstSeenAt: new Date(), lastSeenAt: new Date() },
    ];
    dbMocks.state.selectQueue = [[liveRow], existingMembers];

    const cand = candidate({
      members: [
        { deviceId: 'device-a', sourceKind: 'metric_anomaly', sourceRowId: 'anomaly-a', memberEvidence: { score: 3 } },
        { deviceId: 'device-z', sourceKind: 'metric_anomaly', sourceRowId: 'anomaly-z', memberEvidence: { score: 6 } },
      ],
    });

    const result = await reconcileOrgFindings(ORG_ID, [cand]);

    expect(result).toEqual({ opened: 0, updated: 0, resolved: 0 });
    // Membership sync still happened (new member inserted).
    const memberInsert = dbMocks.state.insertCalls.find((c) => c.table === fleetFindingDevices);
    expect(memberInsert!.values).toEqual([
      expect.objectContaining({ findingId: 'finding-1', deviceId: 'device-z' }),
    ]);
    // But the finding row itself (status, revision) was never touched.
    expect(dbMocks.state.updateCalls.find((c) => c.table === fleetFindings)).toBeUndefined();
  });

  it('6. creates a NEW row when a candidate reappears after its prior episode resolved', async () => {
    // No LIVE row matches (the resolved episode is excluded from the live query
    // by construction — reconcile only ever selects resolvedAt IS NULL rows).
    dbMocks.state.selectQueue = [[]];
    dbMocks.state.insertReturningQueue = [[{ id: 'finding-reopened' }]];

    const result = await reconcileOrgFindings(ORG_ID, [candidate()]);

    expect(result).toEqual({ opened: 1, updated: 0, resolved: 0 });
    const findingInsert = dbMocks.state.insertCalls.find((c) => c.table === fleetFindings);
    expect(findingInsert!.values).toMatchObject({ status: 'open', revision: 1 });
    // The live-episode select itself must be scoped to resolvedAt IS NULL so a
    // resolved row never blocks a fresh insert (partial unique index parity).
    expect(drizzleSpies.isNull).toHaveBeenCalledWith(fleetFindings.resolvedAt);
  });
});
