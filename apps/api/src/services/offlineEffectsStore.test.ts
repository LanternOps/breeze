import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

vi.mock('../db', () => ({
  db: { select: vi.fn() },
  assertInTransaction: vi.fn(),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import { db } from '../db';
import { lockCurrentOfflineObservation } from './offlineEffectsStore';

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
