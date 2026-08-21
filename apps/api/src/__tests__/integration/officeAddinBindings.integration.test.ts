/**
 * office_addin_user_bindings — `createBinding` real-Postgres proof (Task 11
 * fix-review finding: the 409 `identity_already_bound` path was only proven
 * at the mock level in the route test; `isPgUniqueViolation`'s
 * constraint-name matching depends on the actual driver error shape
 * surfaced through Drizzle's `.cause` chain for
 * `office_addin_bindings_identity_active_uq`, which a mock can't exercise).
 *
 * Runs `createBinding` itself (not the HTTP route) against the real
 * postgres.js driver, under `withSystemDbAccessContext` — mirrors how the
 * bind route calls it. Proves:
 *   1. a genuine identity conflict — the SAME (tid, oid) already actively
 *      bound to a DIFFERENT user — turns the raw 23505 into
 *      `BindingConflictError`, not a generic thrown error / 500.
 *   2. the re-link case (same user, new Entra tenant) revokes the old
 *      binding and inserts a new active one inside the same transaction,
 *      leaving exactly one active row for that user.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { withSystemDbAccessContext } from '../../db';
import { officeAddinUserBindings, partners } from '../../db/schema';
import {
  createBinding,
  BindingConflictError,
} from '../../services/officeAddin/officeAddinBindings';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const seededPartnerIds: string[] = [];

interface SeededTenant {
  partnerId: string;
  orgId: string;
  userId: string;
}

/** Seeds one partner + org + user as the privileged test role (bypasses RLS). */
async function seedTenant(): Promise<SeededTenant> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `addin-bind-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`,
  });
  seededPartnerIds.push(partner.id);
  return { partnerId: partner.id, orgId: org.id, userId: user.id };
}

async function activeBindingsForUser(userId: string) {
  const adminDb = getTestDb() as any;
  return adminDb
    .select()
    .from(officeAddinUserBindings)
    .where(and(eq(officeAddinUserBindings.userId, userId), isNull(officeAddinUserBindings.revokedAt)));
}

afterAll(async () => {
  if (seededPartnerIds.length === 0) return;
  const adminDb = getTestDb() as any;
  const partnerList = sql.join(seededPartnerIds.map((id) => sql`${id}`), sql`, `);
  await adminDb.execute(sql`DELETE FROM office_addin_user_bindings WHERE partner_id IN (${partnerList})`);
  await adminDb.execute(sql`DELETE FROM users WHERE partner_id IN (${partnerList})`);
  await adminDb.execute(sql`DELETE FROM organizations WHERE partner_id IN (${partnerList})`);
  await adminDb.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
});

describe('createBinding — real-Postgres proof of the 23505 branch (Task 11)', () => {
  it('a genuine (tid,oid) conflict against a DIFFERENT user throws BindingConflictError, not a generic error', async () => {
    const userA = await seedTenant();
    const userB = await seedTenant();
    const tid = randomUUID();
    const oid = randomUUID();

    await withSystemDbAccessContext(() =>
      createBinding({
        entraTenantId: tid,
        entraOid: oid,
        userId: userA.userId,
        partnerId: userA.partnerId,
        boundAuthEpoch: 1,
        mfaVerifiedAt: new Date(),
      })
    );

    await expect(
      withSystemDbAccessContext(() =>
        createBinding({
          entraTenantId: tid,
          entraOid: oid,
          userId: userB.userId,
          partnerId: userB.partnerId,
          boundAuthEpoch: 1,
          mfaVerifiedAt: new Date(),
        })
      )
    ).rejects.toBeInstanceOf(BindingConflictError);

    // User B must not have gained a binding from the failed attempt.
    const userBRows = await activeBindingsForUser(userB.userId);
    expect(userBRows).toHaveLength(0);
  });

  it('re-link: same user binding a new Entra tenant revokes the old row and leaves exactly one active binding', async () => {
    const user = await seedTenant();
    const firstTid = randomUUID();
    const firstOid = randomUUID();
    const secondTid = randomUUID();
    const secondOid = randomUUID();

    const first = await withSystemDbAccessContext(() =>
      createBinding({
        entraTenantId: firstTid,
        entraOid: firstOid,
        userId: user.userId,
        partnerId: user.partnerId,
        boundAuthEpoch: 1,
        mfaVerifiedAt: new Date(),
      })
    );

    const second = await withSystemDbAccessContext(() =>
      createBinding({
        entraTenantId: secondTid,
        entraOid: secondOid,
        userId: user.userId,
        partnerId: user.partnerId,
        boundAuthEpoch: 1,
        mfaVerifiedAt: new Date(),
      })
    );

    expect(second.id).not.toBe(first.id);

    const adminDb = getTestDb() as any;
    const [oldRow] = await adminDb
      .select()
      .from(officeAddinUserBindings)
      .where(eq(officeAddinUserBindings.id, first.id));
    expect(oldRow?.revokedAt).not.toBeNull();

    const activeRows = await activeBindingsForUser(user.userId);
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0]?.id).toBe(second.id);
    expect(activeRows[0]?.entraTenantId).toBe(secondTid);
    expect(activeRows[0]?.entraOid).toBe(secondOid);
  });
});
