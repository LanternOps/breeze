/**
 * Real-DB proof for the Phase D (payment pull-back) realm fingerprint
 * contract: `backfillRealmFingerprints` re-fingerprints stale/null rows
 * idempotently (a re-run finds nothing left to do), a fingerprint round-trips
 * back to the owning connection through `findConnectionByRealmFingerprint`,
 * and `advanceReconcileCursor`'s guarded UPDATE throws rather than silently
 * no-opping when the (id, partnerId) pair doesn't match — the scenario the
 * mocked unit suite can only simulate via a zero-row mock, not prove against
 * the real partner-scoped predicate.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { accountingConnections } from '../../db/schema';
import { createPartner } from './db-utils';
import {
  advanceReconcileCursor,
  backfillRealmFingerprints,
  findConnectionByRealmFingerprint,
  upsertConnection,
} from '../../services/accounting/accountingConnectionService';
import { hmacFingerprint } from '../../services/secretCrypto';

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('accountingRealmFingerprint (Phase D Task 1)', () => {
  runDb('backfills a null fingerprint and finds the connection by it', async () => {
    const partner = await createPartner();
    const conn = await withSystemDbAccessContext(() => upsertConnection(db, partner.id, 'quickbooks', {
      realmId: 'realm-backfill-1', environment: 'sandbox',
    }));
    // Simulate a pre-Phase-D row.
    await withSystemDbAccessContext(() => db.update(accountingConnections)
      .set({ realmIdFingerprint: null }).where(eq(accountingConnections.id, conn.id)));

    const first = await backfillRealmFingerprints();
    expect(first.updated).toBeGreaterThanOrEqual(1);
    const second = await backfillRealmFingerprints(); // idempotent
    expect(second.updated).toBe(0);

    const found = await withSystemDbAccessContext(() =>
      findConnectionByRealmFingerprint(db, 'quickbooks', hmacFingerprint('realm-backfill-1')));
    expect(found?.id).toBe(conn.id);
    expect(found?.pullPayments).toBe(true);
  });

  runDb('re-fingerprints a row stamped under a stale key generation', async () => {
    const partner = await createPartner();
    const conn = await withSystemDbAccessContext(() => upsertConnection(db, partner.id, 'quickbooks', { realmId: 'realm-rotated' }));
    await withSystemDbAccessContext(() => db.update(accountingConnections)
      .set({ realmIdFingerprint: 'fp1:retired-key:deadbeef' }).where(eq(accountingConnections.id, conn.id)));

    await backfillRealmFingerprints();

    const [row] = await withSystemDbAccessContext(() => db.select().from(accountingConnections).where(eq(accountingConnections.id, conn.id)));
    expect(row!.realmIdFingerprint).toBe(hmacFingerprint('realm-rotated'));
  });

  runDb('advanceReconcileCursor throws when the connection is not this partner\'s', async () => {
    const [a, b] = [await createPartner(), await createPartner()];
    const conn = await withSystemDbAccessContext(() => upsertConnection(db, a.id, 'quickbooks', { realmId: 'realm-cursor' }));

    await expect(withSystemDbAccessContext(() =>
      advanceReconcileCursor(db, conn.id, b.id, new Date(), new Date()),
    )).rejects.toThrow(/matched no accounting_connections row/);
  });
});
