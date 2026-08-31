import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// DB mock — generic, table-name-keyed FIFO (mirrors policyDecide.test.ts's
// own pattern exactly, since `computeExposureBudget` is extracted straight
// out of that file's transaction and must keep hitting the SAME `../../db`
// module those tests already mock). `where()` conditions are REAL drizzle-orm
// SQL objects (only `db` itself is mocked, not `and`/`eq`/`gt`/`sql`), so they
// are captured per-table and rendered via `PgDialect` below to assert the
// actual compiled predicates rather than just the row-shape the query returns.
// ---------------------------------------------------------------------------

const dbMockState = vi.hoisted(() => ({
  rowQueues: {} as Record<string, unknown[][]>,
  whereConds: {} as Record<string, unknown[]>,
}));

const dialect = new PgDialect();
const render = (cond: unknown) => dialect.sqlToQuery(cond as SQL);

function tableNameOf(table: unknown): string {
  return String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')]);
}

function nextRows(table: string): unknown[] {
  const queue = dbMockState.rowQueues[table];
  if (!queue || queue.length === 0) {
    throw new Error(`No queued rows for table ${table}`);
  }
  return queue.shift() as unknown[];
}

function pushRows(table: string, rows: unknown[]): void {
  (dbMockState.rowQueues[table] ??= []).push(rows);
}

function resetDbMock(): void {
  dbMockState.rowQueues = {};
  dbMockState.whereConds = {};
}

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const tableName = tableNameOf(table);
        const builder: Record<string, unknown> = {
          where: vi.fn((cond: unknown) => {
            (dbMockState.whereConds[tableName] ??= []).push(cond);
            return builder;
          }),
          then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            Promise.resolve().then(() => nextRows(tableName)).then(resolve, reject),
        };
        return builder;
      }),
    })),
  },
}));

const contractMock = vi.hoisted(() => ({ countContractDevices: vi.fn(async () => 100) }));
vi.mock('../contractQuantities', () => ({ countContractDevices: contractMock.countContractDevices }));

import { computeExposureBudget } from './exposureBudget';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = '66666666-6666-4666-8666-666666666666';
const DEVICE_ID = '99999999-9999-4999-8999-999999999999';

beforeEach(() => {
  resetDbMock();
  vi.clearAllMocks();
  contractMock.countContractDevices.mockResolvedValue(100);
});

describe('computeExposureBudget', () => {
  it('reports the raw recorded exposure counts with no deviceId projection', async () => {
    pushRows('ai_unattended_exposure', [{ deviceId: 'a' }, { deviceId: 'b' }]); // exposedDeviceRows
    pushRows('ai_unattended_exposure', [{ n: 3 }]); // dayCountRow

    const result = await computeExposureBudget({
      orgId: ORG_ID,
      agentId: AGENT_ID,
      maxFleetPercentPerDay: 5,
      maxPolicyDecisionsPerDay: 10,
    });

    expect(contractMock.countContractDevices).toHaveBeenCalledWith(ORG_ID, null);
    expect(result).toEqual({
      distinctDevices: 2,
      allowance: 5, // floor(100 * 5 / 100)
      contractDeviceCount: 100,
      maxFleetPercentPerDay: 5,
      policyDecisionsToday: 3,
      maxPolicyDecisionsPerDay: 10,
      windowHours: 24,
    });
  });

  it('projects the candidate deviceId into distinctDevices when it is not already exposed (matches runAuthorizeTransaction)', async () => {
    pushRows('ai_unattended_exposure', [{ deviceId: 'a' }, { deviceId: 'b' }]);
    pushRows('ai_unattended_exposure', [{ n: 0 }]);

    const result = await computeExposureBudget({
      orgId: ORG_ID,
      agentId: AGENT_ID,
      maxFleetPercentPerDay: 5,
      maxPolicyDecisionsPerDay: 10,
      deviceId: DEVICE_ID,
    });

    expect(result.distinctDevices).toBe(3); // 2 already-exposed + the new candidate
  });

  it('does not double-count a candidate deviceId that is already exposed', async () => {
    pushRows('ai_unattended_exposure', [{ deviceId: DEVICE_ID }, { deviceId: 'b' }]);
    pushRows('ai_unattended_exposure', [{ n: 0 }]);

    const result = await computeExposureBudget({
      orgId: ORG_ID,
      agentId: AGENT_ID,
      maxFleetPercentPerDay: 5,
      maxPolicyDecisionsPerDay: 10,
      deviceId: DEVICE_ID,
    });

    expect(result.distinctDevices).toBe(2);
  });

  it('floors a fractional allowance rather than rounding up (locked quorum decision — no max(1, ·))', async () => {
    pushRows('ai_unattended_exposure', []);
    pushRows('ai_unattended_exposure', [{ n: 0 }]);
    contractMock.countContractDevices.mockResolvedValue(3);

    const result = await computeExposureBudget({
      orgId: ORG_ID,
      agentId: AGENT_ID,
      maxFleetPercentPerDay: 5, // floor(3 * 5 / 100) = floor(0.15) = 0
      maxPolicyDecisionsPerDay: 10,
    });

    expect(result.allowance).toBe(0);
  });

  it('scopes policyDecisionsToday to this agentId + source: \'policy_intent\' (never a different agent\'s decisions or act-lane exposures)', async () => {
    pushRows('ai_unattended_exposure', []);
    pushRows('ai_unattended_exposure', [{ n: 7 }]);

    const result = await computeExposureBudget({
      orgId: ORG_ID,
      agentId: AGENT_ID,
      maxFleetPercentPerDay: 5,
      maxPolicyDecisionsPerDay: 10,
    });

    expect(result.policyDecisionsToday).toBe(7);

    const conds = dbMockState.whereConds['ai_unattended_exposure'] ?? [];
    expect(conds).toHaveLength(2);

    // First query (fleet-cap exposed-device scan): org + window ONLY —
    // deliberately fleet-wide across every agent and source.
    const fleetCapQuery = render(conds[0]);
    expect(fleetCapQuery.sql).toContain('"org_id" = ');
    expect(fleetCapQuery.sql).toContain("now() - interval '24 hours'");
    expect(fleetCapQuery.sql).not.toContain('"agent_id"');
    expect(fleetCapQuery.sql).not.toContain('"source"');
    expect(fleetCapQuery.params).toContain(ORG_ID);

    // Second query (day-cap count): org + agent + source: 'policy_intent' +
    // window — the four predicates that ARE the enforcement semantics.
    const dayCountQuery = render(conds[1]);
    expect(dayCountQuery.sql).toContain('"org_id" = ');
    expect(dayCountQuery.sql).toContain('"agent_id" = ');
    expect(dayCountQuery.sql).toContain('"source" = ');
    expect(dayCountQuery.sql).toContain("now() - interval '24 hours'");
    expect(dayCountQuery.params).toContain(ORG_ID);
    expect(dayCountQuery.params).toContain(AGENT_ID);
    expect(dayCountQuery.params).toContain('policy_intent');
  });

  describe('shortCircuitOnFleetCapExceeded', () => {
    it('skips the day-count query entirely when the fleet cap already failed (matches runAuthorizeTransaction)', async () => {
      // allowance = floor(100 * 5 / 100) = 5; 6 already exposed -> fails.
      pushRows('ai_unattended_exposure', [
        { deviceId: 'd1' }, { deviceId: 'd2' }, { deviceId: 'd3' },
        { deviceId: 'd4' }, { deviceId: 'd5' }, { deviceId: 'd6' },
      ]);
      // Deliberately NO second pushRows — if the implementation ran the
      // day-count query anyway, nextRows() would throw "No queued rows".

      const result = await computeExposureBudget({
        orgId: ORG_ID,
        agentId: AGENT_ID,
        maxFleetPercentPerDay: 5,
        maxPolicyDecisionsPerDay: 10,
        shortCircuitOnFleetCapExceeded: true,
      });

      expect(result.distinctDevices).toBe(6);
      expect(result.allowance).toBe(5);
      expect(result.policyDecisionsToday).toBeNull();
    });

    it('still runs the day-count query when the fleet cap passes', async () => {
      pushRows('ai_unattended_exposure', [{ deviceId: 'd1' }]);
      pushRows('ai_unattended_exposure', [{ n: 4 }]);

      const result = await computeExposureBudget({
        orgId: ORG_ID,
        agentId: AGENT_ID,
        maxFleetPercentPerDay: 5,
        maxPolicyDecisionsPerDay: 10,
        shortCircuitOnFleetCapExceeded: true,
      });

      expect(result.policyDecisionsToday).toBe(4);
    });
  });
});
