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

  describe('array binding of provider device ids', () => {
    // The real 22P02 failure this guards: binding the JS array directly as
    // `= ANY(${providerDeviceIds})` makes drizzle expand it to a TUPLE param
    // — postgres.js then hands Postgres a single text[] parameter holding a
    // bare uuid, and the query dies with "malformed array literal". The fix
    // binds each id as its own param inside an explicit `ARRAY[...]::text[]`
    // literal. See the comment in alertsResolve.ts.

    /** True if `target` (or an array equal to it) appears anywhere in the SQL tree as a single bound param — the raw-array-binding shape. */
    function containsArrayParam(node: unknown, target: string[]): boolean {
      if (Array.isArray(node)) {
        if (node.length === target.length && node.every((v, i) => v === target[i])) return true;
        return node.some((child) => containsArrayParam(child, target));
      }
      if (node && typeof node === 'object' && Array.isArray((node as { queryChunks?: unknown[] }).queryChunks)) {
        return (node as { queryChunks: unknown[] }).queryChunks.some((child) => containsArrayParam(child, target));
      }
      return false;
    }

    /** Flattens the SQL tree's literal text chunks (StringChunk `.value` arrays), ignoring bound params. */
    function flattenSqlText(node: unknown): string {
      if (node && typeof node === 'object') {
        const asValue = node as { value?: unknown };
        if (Array.isArray(asValue.value)) return (asValue.value as unknown[]).join('');
        const asChunks = node as { queryChunks?: unknown[] };
        if (Array.isArray(asChunks.queryChunks)) return asChunks.queryChunks.map(flattenSqlText).join('');
      }
      return '';
    }

    it('binds each provider device id inside an explicit ARRAY[...]::text[] literal, not as a raw array param', async () => {
      const ids = ['pd-1111', 'pd-2222'];
      dbState.rows = [];
      await resolveProviderAlertsForProviderDevices(ids);

      expect(dbState.capturedWhere).toHaveLength(1);
      const captured = dbState.capturedWhere[0];

      // Discriminating: this is exactly what would be TRUE if the code
      // reverted to `= ANY(${providerDeviceIds})` — see the "reverted" test
      // below for the live demonstration.
      expect(containsArrayParam(captured, ids)).toBe(false);

      const text = flattenSqlText(captured);
      expect(text).toContain('ARRAY[');
      expect(text).toContain('::text[]');
    });

    it('reverting to the raw-array form makes the assertion above fail (proves it is discriminating)', async () => {
      // Reproduce the exact shape `= ANY(${providerDeviceIds})` would produce,
      // using the same drizzle `sql` tagged template the module uses — this is
      // not a hand-rolled fixture, it is what a revert of alertsResolve.ts
      // would actually build.
      const { sql } = await import('drizzle-orm');
      const ids = ['pd-1111', 'pd-2222'];
      const reverted = sql`x = ANY(${ids})`;
      expect(containsArrayParam(reverted, ids)).toBe(true);
    });
  });
});
