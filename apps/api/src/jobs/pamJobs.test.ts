import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  execute: vi.fn(),
  txExecute: vi.fn(),
  txInsert: vi.fn(),
  txValues: vi.fn(),
  requestPamCleanup: vi.fn(),
  captureException: vi.fn(),
  publishEvent: vi.fn(),
  writeAuditEvent: vi.fn(),
}));

vi.mock('bullmq', () => ({ Queue: class {}, Worker: class {}, Job: class {} }));
vi.mock('../db', () => ({
  db: { transaction: mocks.transaction, execute: mocks.execute },
  withSystemDbAccessContext: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../services/pamActuationLifecycle', () => {
  class PamActuationNotFoundError extends Error {
    constructor(public readonly elevationRequestId: string) {
      super('PAM actuation not found');
      this.name = 'PamActuationNotFoundError';
    }
  }
  return { requestPamCleanup: mocks.requestPamCleanup, PamActuationNotFoundError };
});
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../services/sentry', () => ({ captureException: mocks.captureException }));
vi.mock('../services/eventBus', () => ({ publishEvent: mocks.publishEvent }));
vi.mock('../services/auditEvents', () => ({
  requestLikeFromSnapshot: () => ({}),
  writeAuditEvent: mocks.writeAuditEvent,
}));

import { enforceElevationExpiry } from './pamJobs';
import { PamActuationNotFoundError } from '../services/pamActuationLifecycle';

const expiredRow = {
  id: '30000000-0000-4000-8000-000000000001',
  org_id: '30000000-0000-4000-8000-000000000002',
  device_id: '30000000-0000-4000-8000-000000000003',
  flow_type: 'technician_initiated',
  prior_status: 'approved',
};

describe('enforceElevationExpiry', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.txInsert.mockReturnValue({ values: mocks.txValues });
    const tx: Record<string, unknown> = {
      execute: mocks.txExecute,
      insert: mocks.txInsert,
    };
    // Nested tx.transaction = a SAVEPOINT in drizzle; a throw inside it rolls
    // back only that savepoint and propagates to the caller.
    tx.transaction = vi.fn(async (fn: (sp: unknown) => Promise<unknown>) => fn(tx));
    mocks.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(tx));
  });

  function row(n: number) {
    return {
      ...expiredRow,
      id: `30000000-0000-4000-8000-00000000010${n}`,
    };
  }

  /** First execute = the due-row SELECT; then one per-row UPDATE per id. */
  function mockDue(rows: Array<typeof expiredRow>) {
    mocks.txExecute.mockResolvedValueOnce({ rows: rows.map((r) => ({ id: r.id })) });
    for (const r of rows) mocks.txExecute.mockResolvedValueOnce({ rows: [r] });
  }

  it('commits expiry, PAM cleanup intent, and elevation audit atomically', async () => {
    mockDue([expiredRow]);
    mocks.requestPamCleanup.mockResolvedValue({ id: 'actuation-1', generation: 2 });

    await expect(enforceElevationExpiry()).resolves.toBe(1);

    expect(mocks.transaction).toHaveBeenCalledOnce();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.requestPamCleanup).toHaveBeenCalledWith(
      expect.objectContaining({ execute: mocks.txExecute }),
      { elevationRequestId: expiredRow.id, cause: 'expired' },
    );
    expect(mocks.txValues).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ elevationRequestId: expiredRow.id, eventType: 'expired' }),
    ]));
    expect(mocks.publishEvent).toHaveBeenCalledOnce();
  });

  it('isolates a row whose cleanup fails: that row stays active, the rest of the batch still expires', async () => {
    const [a, bad, c] = [row(1), row(2), row(3)];
    mockDue([a, bad, c]);
    mocks.requestPamCleanup.mockImplementation(async (_tx: unknown, input: { elevationRequestId: string }) => {
      if (input.elevationRequestId === bad.id) throw new Error('outbox unavailable');
      return { id: `actuation-${input.elevationRequestId}`, generation: 2 };
    });

    await expect(enforceElevationExpiry()).resolves.toBe(2);

    // The failing row's savepoint rolled back its status flip — no audit,
    // no event for it; it is retried next run. The others committed.
    const auditRows = mocks.txValues.mock.calls.flatMap((call) => call[0] as Array<{ elevationRequestId: string }>);
    expect(auditRows.map((r) => r.elevationRequestId)).toEqual([a.id, c.id]);
    expect(mocks.publishEvent).toHaveBeenCalledTimes(2);
    expect(mocks.captureException).toHaveBeenCalledOnce();
  });

  // An elevation with no pam_actuations row makes requestPamCleanup throw
  // 'PAM actuation not found'. That row still expires and the rest of the
  // batch is unaffected.
  it('expires an actuation-less row (nothing to clean up on the device) without failing the rest of the batch', async () => {
    const [a, orphan, c] = [row(1), { ...row(2), prior_status: 'active' }, row(3)];
    mockDue([a, orphan, c]);
    mocks.requestPamCleanup.mockImplementation(async (_tx: unknown, input: { elevationRequestId: string }) => {
      if (input.elevationRequestId === orphan.id) throw new PamActuationNotFoundError(orphan.id);
      return { id: `actuation-${input.elevationRequestId}`, generation: 2 };
    });

    await expect(enforceElevationExpiry()).resolves.toBe(3);

    expect(mocks.requestPamCleanup).toHaveBeenCalledTimes(3);
    const auditRows = mocks.txValues.mock.calls.flatMap(
      (call) => call[0] as Array<{ elevationRequestId: string; details: Record<string, unknown> }>,
    );
    expect(auditRows.map((r) => r.elevationRequestId)).toEqual([a.id, orphan.id, c.id]);
    expect(auditRows[1]!.details).toMatchObject({ cleanup: 'no_actuation' });
    expect(auditRows[0]!.details).not.toHaveProperty('cleanup');
    expect(mocks.publishEvent).toHaveBeenCalledTimes(3);
    // Not an operational failure of the job — no Sentry noise.
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it('emits nothing when there is nothing due', async () => {
    mockDue([]);
    await expect(enforceElevationExpiry()).resolves.toBe(0);
    expect(mocks.requestPamCleanup).not.toHaveBeenCalled();
    expect(mocks.txValues).not.toHaveBeenCalled();
    expect(mocks.publishEvent).not.toHaveBeenCalled();
  });
});
