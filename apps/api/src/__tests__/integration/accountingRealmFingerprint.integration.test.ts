/**
 * Real-DB proof for the Phase D (payment pull-back) realm fingerprint
 * contract: `backfillRealmFingerprints` re-fingerprints stale/null rows
 * idempotently (a re-run finds nothing left to do), a fingerprint round-trips
 * back to the owning connection through `findConnectionByRealmFingerprint`,
 * and `advanceReconcileCursor`'s guarded UPDATE reports a miss rather than
 * silently no-opping when the (id, partnerId, realm fingerprint) triple doesn't
 * match — the scenario the mocked unit suite can only simulate via a zero-row
 * mock, not prove against the real predicate. Also covers finding C's
 * `resetConnectionForRealmChange`.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { accountingConnections, accountingEntityMappings } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import {
  advanceReconcileCursor,
  backfillRealmFingerprints,
  findConnectionByRealmFingerprint,
  resetConnectionForRealmChange,
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

  runDb('advanceReconcileCursor reports a miss when the connection is not this partner\'s', async () => {
    const [a, b] = [await createPartner(), await createPartner()];
    const conn = await withSystemDbAccessContext(() => upsertConnection(db, a.id, 'quickbooks', { realmId: 'realm-cursor' }));

    await expect(withSystemDbAccessContext(() =>
      advanceReconcileCursor(db, conn.id, b.id, conn.realmIdFingerprint, new Date(), new Date()),
    )).resolves.toBe(false);
  });

  runDb('advanceReconcileCursor writes under the matching realm fingerprint and refuses a stale one', async () => {
    const partner = await createPartner();
    const conn = await withSystemDbAccessContext(() => upsertConnection(db, partner.id, 'quickbooks', { realmId: 'realm-cas' }));
    const cursor = new Date('2026-09-02T20:10:00.000Z');

    await expect(withSystemDbAccessContext(() =>
      advanceReconcileCursor(db, conn.id, partner.id, conn.realmIdFingerprint, cursor, new Date()),
    )).resolves.toBe(true);

    // Finding C: the same job's write is refused once the realm has moved on.
    await expect(withSystemDbAccessContext(() =>
      advanceReconcileCursor(db, conn.id, partner.id, hmacFingerprint('realm-somewhere-else'), new Date(), new Date()),
    )).resolves.toBe(false);

    const [row] = await withSystemDbAccessContext(() =>
      db.select().from(accountingConnections).where(eq(accountingConnections.id, conn.id)));
    expect(row!.cdcCursor?.toISOString()).toBe(cursor.toISOString());
  });

  runDb('resetConnectionForRealmChange wipes the mappings and nulls the CDC watermark', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const conn = await withSystemDbAccessContext(() => upsertConnection(db, partner.id, 'quickbooks', { realmId: 'realm-old' }));
    await withSystemDbAccessContext(async () => {
      await db.insert(accountingEntityMappings).values({
        integrationId: conn.id,
        partnerId: partner.id,
        breezeEntityType: 'org',
        breezeEntityId: org.id,
        remoteEntityType: 'Customer',
        remoteEntityId: '58',
        linkStatus: 'confirmed',
        syncStatus: 'synced',
      });
      await advanceReconcileCursor(db, conn.id, partner.id, conn.realmIdFingerprint, new Date(), new Date());
    });

    const out = await withSystemDbAccessContext(() => resetConnectionForRealmChange(db, conn.id, partner.id));

    expect(out.mappingsDeleted).toBe(1);
    const remaining = await withSystemDbAccessContext(() => db.select().from(accountingEntityMappings)
      .where(eq(accountingEntityMappings.integrationId, conn.id)));
    expect(remaining).toHaveLength(0);
    const [row] = await withSystemDbAccessContext(() =>
      db.select().from(accountingConnections).where(eq(accountingConnections.id, conn.id)));
    expect(row!.cdcCursor).toBeNull();
    expect(row!.lastReconcileAt).toBeNull();
  });
});
