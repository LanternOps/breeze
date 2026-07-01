import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeMock, alertsTable } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  alertsTable: {
    status: 'alerts.status',
    suppressedUntil: 'alerts.suppressed_until',
  },
}));

vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {},
  Job: class {},
}));

vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return {
    ...actual,
    db: {
      ...actual.db,
      execute: (...args: unknown[]) => executeMock(...(args as [])),
    },
    withSystemDbAccessContext: async <T>(fn: () => Promise<T>) => fn(),
  };
});

vi.mock('../db/schema/alerts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/schema/alerts')>();
  return {
    ...actual,
    alerts: alertsTable,
  };
});

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
}));

import { reapExpiredSuppressions } from './suppressionExpiryReaper';
import { writeAuditEvent } from '../services/auditEvents';

describe('suppressionExpiryReaper.reapExpiredSuppressions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('reactivates expired suppressions and audits each transition', async () => {
    executeMock.mockResolvedValueOnce({
      rows: [{ id: 'alert-1', org_id: 'org-1', title: 'Warranty expires' }],
    });

    const reaped = await reapExpiredSuppressions();

    expect(reaped).toBe(1);
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(writeAuditEvent).toHaveBeenCalledTimes(1);
    expect(writeAuditEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: 'org-1',
        action: 'alert.suppression_expired',
        resourceType: 'alert',
        resourceId: 'alert-1',
        actorType: 'system',
        result: 'success',
        details: { previousStatus: 'suppressed' },
      }),
    );
  });

  it('returns 0 and audits nothing when no suppressions are due', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });

    const reaped = await reapExpiredSuppressions();

    expect(reaped).toBe(0);
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });

  it('still transitions when the audit write throws (best-effort audit)', async () => {
    executeMock.mockResolvedValueOnce({
      rows: [{ id: 'alert-2', org_id: 'org-2', title: 'CPU high' }],
    });
    vi.mocked(writeAuditEvent).mockImplementation(() => {
      throw new Error('audit sink down');
    });

    const reaped = await reapExpiredSuppressions();

    expect(reaped).toBe(1);
  });
});
