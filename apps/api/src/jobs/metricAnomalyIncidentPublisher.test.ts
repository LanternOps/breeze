import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeMock, updateMock, publishEventMock, closeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  updateMock: vi.fn(),
  publishEventMock: vi.fn(),
  closeMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {},
  Job: class {},
}));

// Real AsyncLocalStorage-backed context tracking — NOT a bare identity
// pass-through. Same #1105 regression pattern as ticketOutboxPublisher.test.ts:
// an identity `withSystemDbAccessContext: fn => fn()` mock would make
// `hasDbAccessContext()` always report false and could never prove the
// publish loop runs outside a held DB context.
vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const contextStorage = new AsyncLocalStorage<true>();

  const hasDbAccessContext = (): boolean => contextStorage.getStore() !== undefined;

  const withSystemDbAccessContext = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (contextStorage.getStore()) return fn();
    return contextStorage.run(true, fn);
  };

  const runOutsideDbContext = <T>(fn: () => T): T => contextStorage.exit(fn);

  return {
    ...actual,
    db: {
      ...actual.db,
      execute: (...args: unknown[]) => executeMock(...(args as [])),
      update: (...args: unknown[]) => updateMock(...(args as [])),
    },
    hasDbAccessContext,
    withSystemDbAccessContext,
    runOutsideDbContext,
  };
});

vi.mock('../db/schema/metricAnomalyIncidents', () => ({
  metricAnomalyIncidents: {
    id: 'id',
    orgId: 'org_id',
    deviceId: 'device_id',
    dispatchedAt: 'dispatched_at',
    dispatchAttempts: 'dispatch_attempts',
  },
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/eventBus', () => ({
  publishEvent: publishEventMock,
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

import { publishPendingIncidents } from './metricAnomalyIncidentPublisher';
import { captureException } from '../services/sentry';
import * as dbModule from '../db';
import * as fs from 'node:fs';
import * as path from 'node:path';

function makeUpdateChain(returningValue: unknown = undefined) {
  const where = vi.fn(() => Promise.resolve(returningValue));
  const set = vi.fn(() => ({ where }));
  return { set, where };
}

function claimedRow(overrides: Partial<{
  id: string;
  org_id: string;
  device_id: string;
  dispatch_attempts: number;
}> = {}) {
  return {
    id: 'incident-1',
    org_id: 'org-1',
    device_id: 'device-1',
    dispatch_attempts: 1,
    ...overrides,
  };
}

describe('metricAnomalyIncidentPublisher.publishPendingIncidents', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    publishEventMock.mockResolvedValue('event-id-1');
    closeMock.mockResolvedValue(undefined);
  });

  it('publishes a claimed incident onto the eventBus, id-only payload, marks dispatched', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] }); // stuck scan
    executeMock.mockResolvedValueOnce({ rows: [claimedRow()] }); // claim

    const chain = makeUpdateChain();
    updateMock.mockReturnValue({ set: chain.set });

    const result = await publishPendingIncidents();

    expect(result).toEqual({ published: 1, skipped: 0 });
    expect(publishEventMock).toHaveBeenCalledTimes(1);
    expect(publishEventMock).toHaveBeenCalledWith(
      'anomaly.incident_opened',
      'org-1',
      { incidentId: 'incident-1', deviceId: 'device-1' },
      'metric-anomaly-incident-publisher',
    );

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(chain.set).toHaveBeenCalledTimes(1);
    expect(chain.where).toHaveBeenCalledTimes(1);
  });

  it('payload is id-only: never forwards anomalyType/metricNames/peakScore/evidence', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });
    executeMock.mockResolvedValueOnce({ rows: [claimedRow({ id: 'incident-2' })] });
    updateMock.mockReturnValue({ set: makeUpdateChain().set });

    await publishPendingIncidents();

    const [, , payloadArg] = publishEventMock.mock.calls[0] as [string, string, Record<string, unknown>, string];
    expect(payloadArg).toEqual({ incidentId: 'incident-2', deviceId: 'device-1' });
    for (const forbidden of ['anomalyType', 'metricNames', 'peakScore', 'evidence', 'rowCount']) {
      expect(payloadArg).not.toHaveProperty(forbidden);
    }
  });

  it('skips rows with dispatch_attempts > 5: logs, captures, does not publish', async () => {
    executeMock.mockResolvedValueOnce({
      rows: [{ id: 'incident-7', device_id: 'device-7', dispatch_attempts: 6 }],
    });
    executeMock.mockResolvedValueOnce({ rows: [] });

    const result = await publishPendingIncidents();

    expect(result).toEqual({ published: 0, skipped: 1 });
    expect(publishEventMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledTimes(1);
    const captured = (captureException as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Error;
    expect(captured.message).toContain('incident-7');
    expect(captured.message).toContain('6 dispatch attempts');
  });

  // NOTE: this exercises publishPendingIncidents' empty-claim early return
  // (result driven entirely by executeMock's programmed `{ rows: [] }`
  // return value), NOT the actual dispatched_at IS NULL claim predicate —
  // this mock can't observe SQL WHERE-clause contents at all. The real
  // idempotency guarantee (an already-dispatched row is never re-claimed) is
  // asserted at the source level below, in the "claim predicate" describe
  // block, since it's the CTE's `WHERE dispatched_at IS NULL` that a real
  // Postgres instance would enforce — no mock here can substitute for that.
  it('empty-claim early return: a claim pass with no rows publishes and marks-dispatched nothing', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });
    executeMock.mockResolvedValueOnce({ rows: [claimedRow({ id: 'incident-8' })] });
    updateMock.mockReturnValue({ set: makeUpdateChain().set });

    const first = await publishPendingIncidents();
    expect(first.published).toBe(1);
    expect(publishEventMock).toHaveBeenCalledTimes(1);

    // Second pass: claim scan returns no rows (whatever the reason in
    // production — the row already having dispatched_at set is exactly one
    // such reason, enforced by Postgres via the WHERE clause asserted below,
    // not by this mock).
    executeMock.mockResolvedValueOnce({ rows: [] });
    executeMock.mockResolvedValueOnce({ rows: [] });

    const second = await publishPendingIncidents();
    expect(second).toEqual({ published: 0, skipped: 0 });
    expect(publishEventMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledTimes(1); // only from the first pass
  });

  it('leaves dispatched_at unset and does not crash when publishEvent rejects', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });
    executeMock.mockResolvedValueOnce({ rows: [claimedRow({ id: 'incident-9' })] });
    publishEventMock.mockRejectedValueOnce(new Error('redis unavailable'));

    const result = await publishPendingIncidents();

    expect(result).toEqual({ published: 0, skipped: 0 });
    expect(updateMock).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  // #1105 regression: publishPendingIncidents must release its DB access
  // context before calling publishEvent(). Same rationale as
  // ticketOutboxPublisher.test.ts's identical assertion.
  it('releases the DB access context before publishing — #1105', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });
    executeMock.mockResolvedValueOnce({ rows: [claimedRow({ id: 'incident-10' })] });
    updateMock.mockReturnValue({ set: makeUpdateChain().set });

    let sawContextDuringPublish: boolean | undefined;
    publishEventMock.mockImplementation(async () => {
      sawContextDuringPublish = dbModule.hasDbAccessContext();
      return 'event-id';
    });

    const result = await publishPendingIncidents();

    expect(result).toEqual({ published: 1, skipped: 0 });
    expect(publishEventMock).toHaveBeenCalledTimes(1);
    expect(sawContextDuringPublish).toBe(false);
    expect(dbModule.hasDbAccessContext()).toBe(false);
  });
});

// #3828 wave-6-4 task 2 plan bullet: payload is id-only ({ incidentId,
// deviceId }). Source-level guard alongside the runtime assertion above — a
// future edit that starts threading anomaly detail (score, metric names,
// evidence excerpts) onto the bus fails here before it fails anywhere else.
describe('metricAnomalyIncidentPublisher — source-level id-only guard', () => {
  it('never references anomalyType/metricNames/peakScore/evidence/rowCount in its payload construction', () => {
    const src = fs.readFileSync(path.join(__dirname, 'metricAnomalyIncidentPublisher.ts'), 'utf8');
    for (const forbidden of ['.anomaly_type', '.anomalyType', '.metric_names', '.metricNames', '.peak_score', '.peakScore', '.evidence', 'row.row_count']) {
      expect(src).not.toContain(forbidden);
    }
  });
});

// Wave 6 PR 4 (#3828) Task 2's core idempotency contract, asserted at the
// source level: the mocked db/schema modules above can't execute real SQL,
// so there is no way for a mock-driven test to prove an already-dispatched
// row is excluded from the claim — that's a property of the compiled WHERE
// clause a real Postgres evaluates. Assert the predicate survives in both
// places it must: the read-only stuck scan and the FOR UPDATE SKIP LOCKED
// claim CTE (see scanAndClaimIncidentRows in metricAnomalyIncidentPublisher.ts).
// A future edit that drops either occurrence — e.g. loosening the claim CTE
// to re-claim already-dispatched rows — fails here first, before it ever
// reaches production as a 5-second-interval re-publish storm.
describe('metricAnomalyIncidentPublisher — dispatched_at IS NULL claim guard (source-level)', () => {
  it('both the stuck scan and the claim CTE gate on dispatched_at IS NULL', () => {
    const src = fs.readFileSync(path.join(__dirname, 'metricAnomalyIncidentPublisher.ts'), 'utf8');
    const guardOccurrences = [
      ...src.matchAll(/WHERE \$\{metricAnomalyIncidents\.dispatchedAt\} IS NULL/g),
    ];
    expect(guardOccurrences.length).toBe(2);
  });

  it('the claim CTE additionally locks with FOR UPDATE SKIP LOCKED', () => {
    const src = fs.readFileSync(path.join(__dirname, 'metricAnomalyIncidentPublisher.ts'), 'utf8');
    expect(src).toContain('FOR UPDATE SKIP LOCKED');
  });
});

// Claim order must match the `(org_id, id)` partial index the migration
// documents (`metric_anomaly_incidents_undispatched_idx ... WHERE
// dispatched_at IS NULL`) — same rationale as
// ticketOutboxPublisher.test.ts's identical claim-order guard, adapted for
// this table's compound (org_id, id) index instead of ticket_outbox's
// (published_at, id) bigserial index.
describe('metricAnomalyIncidentPublisher — claim order matches the (org_id, id) partial index', () => {
  it('orders both the stuck scan and the claim CTE by (org_id, id)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'metricAnomalyIncidentPublisher.ts'), 'utf8');
    const orderByClauses = [...src.matchAll(/ORDER BY \$\{[^}]+\}, \$\{[^}]+\}/g)].map((m) => m[0]);
    expect(orderByClauses.length).toBe(2);
    for (const clause of orderByClauses) {
      expect(clause).toContain('metricAnomalyIncidents.orgId');
      expect(clause).toContain('metricAnomalyIncidents.id');
    }
  });
});
