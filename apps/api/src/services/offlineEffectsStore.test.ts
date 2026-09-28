import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const parked = vi.hoisted(() => ({ isParkedDevice: vi.fn(async (_r: unknown, _id: string) => false) }));
vi.mock('./unassignedPool/deliveryEligibility', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./unassignedPool/deliveryEligibility')>()),
  isParkedDevice: parked.isParkedDevice,
}));

vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn() },
  assertInTransaction: vi.fn(),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import { db } from '../db';
import { lockCurrentOfflineObservation, persistOfflineTransition } from './offlineEffectsStore';

describe('lockCurrentOfflineObservation timestamp precision (#6024)', () => {
  it('matches last_seen_at at millisecond precision, not by exact equality', async () => {
    const observedLastSeenAt = '2026-09-16T10:00:00.123Z';
    const where = vi.fn((predicate: SQL) => {
      const query = new PgDialect().sqlToQuery(predicate);
      expect(query.sql).toContain(`date_trunc('milliseconds', "devices"."last_seen_at") = $`);
      expect(query.sql).not.toContain('"devices"."last_seen_at" = $');
      expect(query.params).toContain(observedLastSeenAt);
      return { for: vi.fn(async () => [{ id: 'dev' }]) };
    });
    vi.mocked(db.select).mockReturnValue({ from: vi.fn(() => ({ where })) } as never);

    const device = await lockCurrentOfflineObservation({
      deviceId: '00000000-0000-4000-8000-000000000001',
      orgId: '10000000-0000-4000-8000-000000000001',
      siteId: 's', hostname: 'h', displayName: null, osType: 'linux', osVersion: '1',
      observedLastSeenAt,
    } as never);
    expect(where).toHaveBeenCalledOnce();
    expect(device).toEqual({ id: 'dev' });
  });
});

describe('persistOfflineTransition for a device parked in a holding org', () => {
  const device = {
    id: '00000000-0000-4000-8000-000000000002', orgId: '10000000-0000-4000-8000-000000000002',
    siteId: 's', hostname: 'h', displayName: null, osType: 'linux', osVersion: '1', isEphemeral: false,
  } as never;

  function wireInsert() {
    const kinds: string[] = [];
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn((row: { kind: string }) => {
        kinds.push(row.kind);
        return { onConflictDoNothing: vi.fn(async () => undefined) };
      }),
    } as never);
    return kinds;
  }

  it('writes no offline event and no alert plan (no alerts, notifications or tickets)', async () => {
    const kinds = wireInsert();
    parked.isParkedDevice.mockResolvedValueOnce(true);
    const ids = await persistOfflineTransition(device, 'transition-1', '2026-09-16T10:00:00.000Z');
    expect(ids).toEqual([]);
    expect(kinds).toEqual([]);
    expect(parked.isParkedDevice).toHaveBeenCalledWith(expect.anything(), '00000000-0000-4000-8000-000000000002');
  });

  it('writes both effects for an ordinary device (control)', async () => {
    const kinds = wireInsert();
    parked.isParkedDevice.mockResolvedValueOnce(false);
    const ids = await persistOfflineTransition(device, 'transition-2', '2026-09-16T10:00:00.000Z');
    expect(ids).toHaveLength(2);
    expect(kinds).toEqual(['offline-event', 'alert-plan']);
  });
});
