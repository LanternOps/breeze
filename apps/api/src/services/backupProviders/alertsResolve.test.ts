import { describe, it, expect, beforeEach, vi } from 'vitest';

const { dbState, resolveAlertMock } = vi.hoisted(() => ({
  dbState: { rows: [] as Array<{ id: string }>, capturedWhere: [] as unknown[] },
  resolveAlertMock: vi.fn(async (_id: string, _note?: string) => true),
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async (cond: unknown) => {
          dbState.capturedWhere.push(cond);
          return dbState.rows;
        }),
        innerJoin: vi.fn(() => ({
          where: vi.fn(async (cond: unknown) => {
            dbState.capturedWhere.push(cond);
            return dbState.rows;
          }),
        })),
      })),
    })),
  },
}));

vi.mock('../../db/schema', () => ({
  alerts: { id: 'alerts.id', status: 'alerts.status', context: 'alerts.context' },
  backupProviderDevices: { id: 'bpd.id', customerId: 'bpd.customer_id' },
}));

vi.mock('../alertService', () => ({
  RESOLVABLE_ALERT_STATUSES: ['active', 'acknowledged', 'suppressed'],
  resolveAlert: resolveAlertMock,
}));

import {
  BACKUP_PROVIDER_ALERT_SOURCE,
  resolveProviderAlertsForConnection,
  resolveProviderAlertsForProviderDevices,
} from './alertsResolve';

describe('resolveProviderAlertsForConnection', () => {
  beforeEach(() => {
    dbState.rows = [];
    dbState.capturedWhere = [];
    resolveAlertMock.mockReset().mockResolvedValue(true);
  });

  it('uses the contracted source discriminator', () => {
    expect(BACKUP_PROVIDER_ALERT_SOURCE).toBe('backup_provider');
  });

  it('resolves every open provider alert for the connection, with a stated note', async () => {
    dbState.rows = [{ id: 'a1' }, { id: 'a2' }];
    const resolved = await resolveProviderAlertsForConnection('conn-1');
    expect(resolved).toBe(2);
    expect(resolveAlertMock).toHaveBeenCalledTimes(2);
    const [, note] = resolveAlertMock.mock.calls[0]!;
    // A resolution note that says WHY is what stops the next technician
    // re-opening it: the row is gone, not fixed.
    expect(String(note)).toMatch(/backup provider connection/i);
  });

  it('counts only the alerts whose compare-and-swap it actually won', async () => {
    // resolveAlert returns false when another writer got there first; counting
    // it would over-report in the audit row.
    dbState.rows = [{ id: 'a1' }, { id: 'a2' }];
    resolveAlertMock.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(resolveProviderAlertsForConnection('conn-1')).resolves.toBe(1);
  });

  it('is a no-op when nothing is open', async () => {
    dbState.rows = [];
    await expect(resolveProviderAlertsForConnection('conn-1')).resolves.toBe(0);
    expect(resolveAlertMock).not.toHaveBeenCalled();
  });

  it('short-circuits an empty provider-device list without touching the database', async () => {
    await expect(resolveProviderAlertsForProviderDevices([])).resolves.toBe(0);
    expect(dbState.capturedWhere).toHaveLength(0);
  });

  it('keeps going when one resolve throws, so one bad alert cannot block a connection delete', async () => {
    dbState.rows = [{ id: 'a1' }, { id: 'a2' }];
    resolveAlertMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(true);
    await expect(resolveProviderAlertsForConnection('conn-1')).resolves.toBe(1);
  });
});
