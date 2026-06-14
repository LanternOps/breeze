/**
 * Functional cross-tenant forge proof for the Breeze Authenticator Phase 1
 * foundation tables (`authenticator_devices`, `authenticator_policies`).
 *
 * Migration under test: 2026-06-14-a-authenticator-foundation.sql
 *
 * `authenticator_devices` is Shape 6 (user-id scoped). Policy (USING + WITH
 * CHECK):
 *   user_id = breeze_current_user_id() OR breeze_current_scope() = 'system'
 *
 * `authenticator_policies` is Shape 3 (partner-axis). Policy (USING + WITH
 * CHECK):
 *   public.breeze_current_scope() = 'system'
 *     OR public.breeze_has_partner_access(partner_id)
 *
 * The rls-coverage contract test only proves *a* policy referencing the right
 * helper exists — it cannot prove the scoping is actually correct (the
 * dual-axis / FK-child blindspots have bitten us before). This suite is the
 * functional proof: it runs through the REAL postgres.js driver, whose pool
 * connects as the unprivileged `breeze_app` role (rolbypassrls = false — see
 * setup.ts), so RLS is genuinely enforced and these assertions are NOT
 * vacuous.
 *
 * As the app role it proves, for BOTH tables:
 *   1. a cross-tenant INSERT is rejected (WITH CHECK)
 *   2. a row owned by tenant B (seeded via system scope) is invisible to a
 *      tenant-A SELECT (USING)
 *
 * postgres.js surfaces the policy error on `.cause` (drizzle wraps the
 * top-level message as "Failed query: ..."), so RLS rejections are matched
 * against the cause message (same convention as emailInboundRls /
 * ticket-comments-rls).
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { authenticatorDevices, authenticatorPolicies, organizations, partners } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

/**
 * Partner/org ids seeded here, for afterAll cleanup. The beforeEach in
 * setup.ts TRUNCATE-CASCADEs core tenant tables between tests, so usually only
 * the last test's rows survive — deleting everything registered is a harmless
 * superset. authenticator_devices / authenticator_policies cascade off
 * users / partners on delete, so removing the partners is enough, but we clean
 * the leaf tables first to be explicit and FK-safe.
 */
const seededPartnerIds: string[] = [];
const seededOrgIds: string[] = [];

interface SeededTenant {
  partnerId: string;
  orgId: string;
  userId: string;
}

/**
 * Seeds two unrelated partners, each with an org + a user, as the privileged
 * test role (which bypasses RLS). Tenant A is the "attacker"; tenant B is the
 * victim. Re-seeded PER TEST (called from each `it`) — NOT hoisted to module
 * scope, because setup.ts's beforeEach TRUNCATE CASCADE would wipe a hoisted
 * fixture and silently make later cases vacuous.
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
    email: `auth-rls-a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`,
  });

  const partnerB = await createPartner();
  const orgB = await createOrganization({ partnerId: partnerB.id });
  const userB = await createUser({
    partnerId: partnerB.id,
    orgId: orgB.id,
    email: `auth-rls-b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`,
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
 * Returns the postgres.js cause message for an RLS rejection, or undefined if
 * the call unexpectedly succeeded. drizzle wraps the policy error from
 * postgres.js on `.cause`.
 */
async function captureRlsCause(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined; // no throw = isolation hole
  } catch (err) {
    return (err as { cause?: { message?: string } } | undefined)?.cause?.message;
  }
}

afterAll(async () => {
  if (seededPartnerIds.length === 0) return;
  const adminDb = getTestDb() as any;
  const partnerList = sql.join(seededPartnerIds.map((id) => sql`${id}`), sql`, `);

  // authenticator_policies FKs partner_id; delete those first.
  await adminDb
    .delete(authenticatorPolicies)
    .where(sql`${authenticatorPolicies.partnerId} IN (${partnerList})`);
  // authenticator_devices cascades off users (off partners), but be explicit.
  await adminDb.execute(
    sql`DELETE FROM authenticator_devices WHERE user_id IN (SELECT id FROM users WHERE partner_id IN (${partnerList}))`
  );
  // users carry the composite FK users_org_partner_fk (org_id, partner_id) ->
  // organizations(id, partner_id); they MUST be deleted before their orgs or the
  // org delete below is blocked. Scoped to this test's own partners.
  await adminDb.execute(sql`DELETE FROM users WHERE partner_id IN (${partnerList})`);
  if (seededOrgIds.length > 0) {
    const orgList = sql.join(seededOrgIds.map((id) => sql`${id}`), sql`, `);
    await adminDb.delete(organizations).where(sql`${organizations.id} IN (${orgList})`);
  }
  await adminDb.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
});

describe('authenticator_devices RLS — cross-tenant forge (breeze_app role)', () => {
  it('rejects a cross-tenant INSERT (tenant A forging a row for tenant B user)', async () => {
    const { b, partnerAContext } = await seedTwoTenants();

    const cause = await captureRlsCause(() =>
      withDbAccessContext(partnerAContext, () =>
        db.insert(authenticatorDevices).values({
          userId: b.userId, // forged: belongs to tenant B's user
          kind: 'mobile_hw_key',
          publicKey: 'forged-key',
          isPlatformBound: true,
        })
      )
    );

    expect(cause).toBeDefined();
    expect(cause).toMatch(/row-level security/i);
    expect(cause).toMatch(
      /new row violates row-level security policy for table "authenticator_devices"/
    );
  });

  it('hides a tenant-B device row from a tenant-A SELECT (seeded via system scope)', async () => {
    const { b, partnerAContext } = await seedTwoTenants();

    // System scope legitimately bypasses the user predicate — seed tenant B's
    // device this way (mirrors an enrollment worker / system job).
    const [seeded] = await withSystemDbAccessContext(() =>
      db
        .insert(authenticatorDevices)
        .values({
          userId: b.userId,
          kind: 'mobile_hw_key',
          publicKey: `seed-b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          isPlatformBound: true,
        })
        .returning({ id: authenticatorDevices.id })
    );
    expect(seeded?.id).toBeDefined();

    // Tenant A must not see tenant B's device row.
    const rows = await withDbAccessContext(partnerAContext, () =>
      db
        .select({ id: authenticatorDevices.id })
        .from(authenticatorDevices)
        .where(eq(authenticatorDevices.id, seeded!.id))
    );

    expect(rows).toEqual([]);
  });
});

describe('authenticator_policies RLS — cross-partner forge (breeze_app role)', () => {
  it('rejects a cross-partner INSERT (partner A forging a partner-B policy)', async () => {
    const { b, partnerAContext } = await seedTwoTenants();

    const cause = await captureRlsCause(() =>
      withDbAccessContext(partnerAContext, () =>
        db.insert(authenticatorPolicies).values({
          partnerId: b.partnerId, // forged: belongs to partner B
          requireEnrollment: true,
        })
      )
    );

    expect(cause).toBeDefined();
    expect(cause).toMatch(/row-level security/i);
    expect(cause).toMatch(
      /new row violates row-level security policy for table "authenticator_policies"/
    );
  });

  it('hides a partner-B policy from a partner-A SELECT (seeded via system scope)', async () => {
    const { b, partnerAContext } = await seedTwoTenants();

    const [seeded] = await withSystemDbAccessContext(() =>
      db
        .insert(authenticatorPolicies)
        .values({
          partnerId: b.partnerId,
          requireEnrollment: true,
        })
        .returning({ partnerId: authenticatorPolicies.partnerId })
    );
    expect(seeded?.partnerId).toBe(b.partnerId);

    // Partner A must not see partner B's policy.
    const rows = await withDbAccessContext(partnerAContext, () =>
      db
        .select({ partnerId: authenticatorPolicies.partnerId })
        .from(authenticatorPolicies)
        .where(eq(authenticatorPolicies.partnerId, b.partnerId))
    );

    expect(rows).toEqual([]);
  });
});
