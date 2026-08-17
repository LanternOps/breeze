/**
 * office_addin_user_bindings RLS — cross-partner forge proof (breeze_app role).
 *
 * Migration under test: 2026-08-22-office-addin-user-bindings.sql
 *
 * Shape 3 (partner-axis, flat breeze_has_partner_access(partner_id), no
 * org_id column). Policy (USING + WITH CHECK):
 *   public.breeze_current_scope() = 'system'
 *     OR public.breeze_has_partner_access(partner_id)
 *
 * Runs through the REAL postgres.js driver (breeze_app role, rolbypassrls =
 * false — see setup.ts), so RLS is genuinely enforced. Proves:
 *   1. a partner-A caller cannot INSERT a binding row for partner B's own
 *      user (WITH CHECK on partner_id fails; the forged row keeps
 *      (user_id, partner_id) internally consistent — user B really does
 *      belong to partner B — so this is a pure RLS rejection, not a
 *      collateral FK violation from office_addin_bindings_user_partner_fk).
 *   2. a binding legitimately inserted under partner A is invisible to a
 *      partner-B SELECT.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { officeAddinUserBindings, organizations, partners } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const seededPartnerIds: string[] = [];
const seededOrgIds: string[] = [];

interface SeededTenant {
  partnerId: string;
  orgId: string;
  userId: string;
}

/**
 * Seeds two unrelated partners, each with an org + a user, as the privileged
 * test role (which bypasses RLS). Partner A is the "attacker"; partner B is
 * the victim. Re-seeded PER TEST (called from each `it`) — NOT hoisted to
 * module scope, because setup.ts's beforeEach TRUNCATE CASCADE would wipe a
 * hoisted fixture and silently make later cases vacuous.
 */
async function seedTwoTenants(): Promise<{
  a: SeededTenant;
  b: SeededTenant;
  partnerAContext: DbAccessContext;
}> {
  const partnerA = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const userA = await createUser({
    partnerId: partnerA.id,
    orgId: orgA.id,
    email: `addin-rls-a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`,
  });

  const partnerB = await createPartner();
  const orgB = await createOrganization({ partnerId: partnerB.id });
  const userB = await createUser({
    partnerId: partnerB.id,
    orgId: orgB.id,
    email: `addin-rls-b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`,
  });

  seededPartnerIds.push(partnerA.id, partnerB.id);
  seededOrgIds.push(orgA.id, orgB.id);

  // Mirrors authMiddleware for a partner-scope user: they can access their own
  // partner + org, and their own user id seeds breeze_current_user_id().
  const partnerAContext: DbAccessContext = {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [orgA.id],
    accessiblePartnerIds: [partnerA.id],
    userId: userA.id,
  };

  return {
    a: { partnerId: partnerA.id, orgId: orgA.id, userId: userA.id },
    b: { partnerId: partnerB.id, orgId: orgB.id, userId: userB.id },
    partnerAContext,
  };
}

/**
 * Returns the postgres.js cause on an RLS rejection, or undefined if the
 * call unexpectedly succeeded. drizzle wraps the top-level message as
 * "Failed query: ..." — the real policy error lands on `.cause`.
 */
async function captureRlsCause(
  fn: () => Promise<unknown>
): Promise<{ code?: string; message?: string } | undefined> {
  try {
    await fn();
    return undefined; // no throw = isolation hole
  } catch (err) {
    return (err as { cause?: { code?: string; message?: string } } | undefined)?.cause;
  }
}

afterAll(async () => {
  if (seededPartnerIds.length === 0) return;
  const adminDb = getTestDb() as any;
  const partnerList = sql.join(seededPartnerIds.map((id) => sql`${id}`), sql`, `);

  // office_addin_user_bindings FKs partner_id (and the composite
  // (user_id, partner_id) -> users(id, partner_id) FK); delete first.
  await adminDb
    .delete(officeAddinUserBindings)
    .where(sql`${officeAddinUserBindings.partnerId} IN (${partnerList})`);
  // users carry the composite FK users_org_partner_fk (org_id, partner_id) ->
  // organizations(id, partner_id); they MUST be deleted before their orgs.
  await adminDb.execute(sql`DELETE FROM users WHERE partner_id IN (${partnerList})`);
  if (seededOrgIds.length > 0) {
    const orgList = sql.join(seededOrgIds.map((id) => sql`${id}`), sql`, `);
    await adminDb.delete(organizations).where(sql`${organizations.id} IN (${orgList})`);
  }
  await adminDb.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
});

describe('office_addin_user_bindings RLS — cross-partner forge (breeze_app role)', () => {
  it('rejects a cross-partner INSERT (partner A forging a binding for partner B\'s own user)', async () => {
    const { b, partnerAContext } = await seedTwoTenants();

    // The forged row is internally consistent (user B really does belong to
    // partner B, satisfying office_addin_bindings_user_partner_fk) — the
    // only thing wrong with it is that partner A's context is inserting it.
    const cause = await captureRlsCause(() =>
      withDbAccessContext(partnerAContext, () =>
        db.insert(officeAddinUserBindings).values({
          entraTenantId: randomUUID(),
          entraOid: randomUUID(),
          userId: b.userId, // forged: belongs to partner B
          partnerId: b.partnerId, // forged: belongs to partner B
          boundAuthEpoch: 1,
          mfaVerifiedAt: new Date(),
        })
      )
    );

    expect(cause).toBeDefined();
    expect(cause?.code).toBe('42501');
    expect(cause?.message).toMatch(
      /new row violates row-level security policy for table "office_addin_user_bindings"/
    );
  });

  it('a cross-partner UPDATE forge affects 0 rows (USING filters the row out)', async () => {
    const { b, partnerAContext } = await seedTwoTenants();

    const [seeded] = await withSystemDbAccessContext(() =>
      db
        .insert(officeAddinUserBindings)
        .values({
          entraTenantId: randomUUID(),
          entraOid: randomUUID(),
          userId: b.userId,
          partnerId: b.partnerId,
          boundAuthEpoch: 1,
          mfaVerifiedAt: new Date(),
        })
        .returning({ id: officeAddinUserBindings.id })
    );
    expect(seeded?.id).toBeDefined();

    // Partner A attempts the admin-revoke write shape against partner B's
    // binding. The single FOR ALL policy's USING clause hides the row, so this
    // is a silent 0-row no-op rather than a 42501 (unlike INSERT, where the
    // forged row reaches WITH CHECK).
    const updated = await withDbAccessContext(partnerAContext, () =>
      db
        .update(officeAddinUserBindings)
        .set({ revokedAt: new Date() })
        .where(eq(officeAddinUserBindings.id, seeded!.id))
        .returning({ id: officeAddinUserBindings.id })
    );
    expect(updated).toEqual([]);

    // The victim's binding is untouched (still active).
    const [row] = await withSystemDbAccessContext(() =>
      db
        .select({ revokedAt: officeAddinUserBindings.revokedAt })
        .from(officeAddinUserBindings)
        .where(eq(officeAddinUserBindings.id, seeded!.id))
    );
    expect(row?.revokedAt).toBeNull();
  });

  it('a cross-partner DELETE forge affects 0 rows and the row persists', async () => {
    const { b, partnerAContext } = await seedTwoTenants();

    const [seeded] = await withSystemDbAccessContext(() =>
      db
        .insert(officeAddinUserBindings)
        .values({
          entraTenantId: randomUUID(),
          entraOid: randomUUID(),
          userId: b.userId,
          partnerId: b.partnerId,
          boundAuthEpoch: 1,
          mfaVerifiedAt: new Date(),
        })
        .returning({ id: officeAddinUserBindings.id })
    );
    expect(seeded?.id).toBeDefined();

    const deleted = await withDbAccessContext(partnerAContext, () =>
      db
        .delete(officeAddinUserBindings)
        .where(eq(officeAddinUserBindings.id, seeded!.id))
        .returning({ id: officeAddinUserBindings.id })
    );
    expect(deleted).toEqual([]);

    const survivors = await withSystemDbAccessContext(() =>
      db
        .select({ id: officeAddinUserBindings.id })
        .from(officeAddinUserBindings)
        .where(eq(officeAddinUserBindings.id, seeded!.id))
    );
    expect(survivors).toHaveLength(1);
  });

  it('hides a partner-B binding from a partner-A SELECT (seeded via system scope)', async () => {
    const { a, b, partnerAContext } = await seedTwoTenants();

    // System scope legitimately bypasses the partner predicate — seed
    // partner B's binding this way (mirrors the auth-exchange write path).
    const [seeded] = await withSystemDbAccessContext(() =>
      db
        .insert(officeAddinUserBindings)
        .values({
          entraTenantId: randomUUID(),
          entraOid: randomUUID(),
          userId: b.userId,
          partnerId: b.partnerId,
          boundAuthEpoch: 1,
          mfaVerifiedAt: new Date(),
        })
        .returning({ id: officeAddinUserBindings.id })
    );
    expect(seeded?.id).toBeDefined();

    // Sanity: partner A's own legitimate binding remains visible to itself.
    const [ownSeeded] = await withSystemDbAccessContext(() =>
      db
        .insert(officeAddinUserBindings)
        .values({
          entraTenantId: randomUUID(),
          entraOid: randomUUID(),
          userId: a.userId,
          partnerId: a.partnerId,
          boundAuthEpoch: 1,
          mfaVerifiedAt: new Date(),
        })
        .returning({ id: officeAddinUserBindings.id })
    );
    const ownRows = await withDbAccessContext(partnerAContext, () =>
      db
        .select({ id: officeAddinUserBindings.id })
        .from(officeAddinUserBindings)
        .where(eq(officeAddinUserBindings.id, ownSeeded!.id))
    );
    expect(ownRows).toHaveLength(1);

    // Partner A must not see partner B's binding.
    const crossRows = await withDbAccessContext(partnerAContext, () =>
      db
        .select({ id: officeAddinUserBindings.id })
        .from(officeAddinUserBindings)
        .where(eq(officeAddinUserBindings.id, seeded!.id))
    );
    expect(crossRows).toEqual([]);
  });
});
