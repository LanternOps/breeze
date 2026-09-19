import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  execute: vi.fn(),
  txExecute: vi.fn(),
  txInsert: vi.fn(),
  txValues: vi.fn(),
  requestPamCleanup: vi.fn(),
  publishEvent: vi.fn(),
  writeAuditEvent: vi.fn(),
}));

vi.mock('bullmq', () => ({ Queue: class {}, Worker: class {}, Job: class {} }));
vi.mock('../db', () => ({
  db: { transaction: mocks.transaction, execute: mocks.execute },
  withSystemDbAccessContext: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../services/pamActuationLifecycle', () => ({
  requestPamCleanup: mocks.requestPamCleanup,
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/eventBus', () => ({ publishEvent: mocks.publishEvent }));
vi.mock('../services/auditEvents', () => ({
  requestLikeFromSnapshot: () => ({}),
  writeAuditEvent: mocks.writeAuditEvent,
}));

import { enforceElevationExpiry } from './pamJobs';

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
    mocks.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({
      execute: mocks.txExecute,
      insert: mocks.txInsert,
    }));
  });

  it('commits expiry, PAM cleanup intent, and elevation audit atomically', async () => {
    mocks.txExecute.mockResolvedValue({ rows: [expiredRow] });
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

  it('rolls the expiry back and emits no success effects when cleanup intent creation fails', async () => {
    mocks.txExecute.mockResolvedValue({ rows: [expiredRow] });
    mocks.requestPamCleanup.mockRejectedValue(new Error('outbox unavailable'));

    await expect(enforceElevationExpiry()).rejects.toThrow('outbox unavailable');
    expect(mocks.txValues).not.toHaveBeenCalled();
    expect(mocks.publishEvent).not.toHaveBeenCalled();
    expect(mocks.writeAuditEvent).not.toHaveBeenCalled();
  });
});
