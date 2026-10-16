/**
 * #8287 / PR #8443 — the display watch-set resolution runs inside the caller's
 * request transaction. A SQL error in it is caught (fail open → unfiltered),
 * but on the bare request transaction Postgres would abort the transaction and
 * every later query in the same request would fail (25P02). The resolution is
 * therefore run in a savepoint (`withDbTransaction`). This pins that: inject a
 * real SQL error into the resolver and assert the request transaction is still
 * usable afterwards.
 *
 * Separate file because it mocks the monitor resolver module.
 */
import './setup';
import { describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { buildDbAccessContext } from '../../middleware/auth';
import { loadActiveWatchKeys } from '../../services/monitoringActiveWatches';
import { createOrganization, createPartner } from './db-utils';

vi.mock('../../services/monitors/monitorResolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/monitors/monitorResolver')>();
  return {
    ...actual,
    // A genuine server-side error (division by zero), not a JS throw.
    resolveMonitorsForDevice: async () => {
      const { db: ambient } = await import('../../db');
      await ambient.execute(sql`select 1/0`);
      throw new Error('unreachable');
    },
  };
});

describe('display watch-set resolution SQL error (#8287)', () => {
  it('fails open and leaves the request transaction usable', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const ctx = buildDbAccessContext({
      scope: 'organization', orgId: org!.id, accessibleOrgIds: [org!.id], partnerId: partner.id, userId: null,
    });

    const after = await withDbAccessContext(ctx, async () => {
      // Random device id: no cache hit, so the resolver (and its SQL error) runs.
      const keys = await loadActiveWatchKeys('00000000-0000-4000-8000-000000000001');
      expect(keys).toBeNull();
      // The route's next query on the same request transaction.
      return db.execute(sql`select 42 as v`);
    });

    expect(Array.from(after as unknown as Array<{ v: number }>)[0]?.v).toBe(42);
  });
});
