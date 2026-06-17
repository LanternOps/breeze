/**
 * Real-DB idempotency guard for the role/permission seed.
 *
 * This PR added the `role_permissions` composite PK `(role_id, permission_id)`
 * and switched seedRoles() to `.onConflictDoNothing()` so a re-seed is a no-op
 * instead of throwing a 23505 unique_violation. That headline change had no
 * coverage: a mocked unit test can't exercise the real PK conflict, and the
 * pre-PR hand-rolled catch would have re-thrown it anyway (err.code is
 * undefined under Drizzle's DrizzleQueryError wrapper — the pg code lives on
 * err.cause). This test seeds twice against the real DB and asserts:
 *   (a) the second seedRoles() run does not throw, and
 *   (b) there is exactly ONE role_permissions row per (role_id, permission_id)
 *       grant — no duplicates.
 *
 * Runs under vitest.integration.config.ts — seedPermissions()/seedRoles() wrap
 * themselves in withSystemDbAccessContext, so they write through the system
 * (RLS-bypassing) path on the breeze_app pool. setup.ts's beforeEach TRUNCATEs
 * roles + role_permissions (and we re-seed permissions per test), so each it()
 * starts from a clean slate — no memoization.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { roles, rolePermissions } from '../../db/schema';
import { seedPermissions, seedRoles, SYSTEM_ROLES } from '../../db/seed';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function roleAndGrantCounts() {
  return withSystemDbAccessContext(async () => {
    const roleRows = await db
      .select({ roleCount: sql<number>`count(*)::int` })
      .from(roles);
    const grantRows = await db
      .select({ grantCount: sql<number>`count(*)::int` })
      .from(rolePermissions);
    return { roleCount: roleRows[0]!.roleCount, grantCount: grantRows[0]!.grantCount };
  });
}

// Duplicate rows on the composite PK itself. With the PK in place this must
// always be empty; it's the direct invariant the PR's onConflictDoNothing protects.
async function duplicatePkGrants() {
  return (await withSystemDbAccessContext(() =>
    db.execute(sql`
      SELECT role_id, permission_id, count(*) AS n
      FROM role_permissions
      GROUP BY role_id, permission_id
      HAVING count(*) > 1
    `),
  )) as unknown as Array<{ role_id: string; permission_id: string; n: number }>;
}

// Duplicate LOGICAL grants — a role holding the same resource:action more than
// once, even via different permission_id rows. This is stricter than the PK
// check and catches the case where a polluted `permissions` table (duplicate
// resource:action rows) lets seedRoles map a permKey to a different permission
// id on re-seed, slipping a second grant past the (role_id, permission_id) PK.
async function duplicateLogicalGrants() {
  return (await withSystemDbAccessContext(() =>
    db.execute(sql`
      SELECT rp.role_id, p.resource, p.action, count(*) AS n
      FROM role_permissions rp
      JOIN permissions p ON p.id = rp.permission_id
      GROUP BY rp.role_id, p.resource, p.action
      HAVING count(*) > 1
    `),
  )) as unknown as Array<{ role_id: string; resource: string; action: string; n: number }>;
}

describe('role/permission seed idempotency', () => {
  // The PR under test added the role_permissions composite PK
  // (role_id, permission_id) and switched seedRoles() to onConflictDoNothing.
  // We pin both the PK-level invariant (no duplicate (role_id, permission_id)
  // rows) and the stronger logical invariant (no role holds the same
  // resource:action twice, even via different permission ids). The latter is
  // what surfaced — and now guards — the seedPermissions() dedup fix in the
  // same change: re-seeding permissions used to re-insert duplicate
  // resource:action rows, which then leaked extra grants past the PK.
  runDb('seeding twice does not throw and produces no duplicate grants', async () => {
    // Start from a clean catalog so counts are deterministic. setup.ts wipes
    // roles + role_permissions per test but NOT `permissions` (it accumulates
    // across runs), so clear all three here for a true single-seed -> re-seed
    // cycle. Done under system scope on the breeze_app pool, which has DELETE
    // (but not TRUNCATE) on these tables; FK order is grants -> roles -> permissions.
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`DELETE FROM role_permissions`);
      await db.execute(sql`DELETE FROM roles`);
      await db.execute(sql`DELETE FROM permissions`);
    });

    // First seed.
    await seedPermissions();
    await seedRoles();

    const afterFirst = await roleAndGrantCounts();
    expect(afterFirst.roleCount).toBe(SYSTEM_ROLES.length);
    expect(afterFirst.grantCount).toBeGreaterThan(0);
    expect((await duplicatePkGrants()).length).toBe(0);
    expect((await duplicateLogicalGrants()).length).toBe(0);

    // Second seed — the headline change: must not throw on the (role_id,
    // permission_id) PK conflict (the .onConflictDoNothing() guard).
    await expect(seedPermissions()).resolves.not.toThrow();
    await expect(seedRoles()).resolves.not.toThrow();

    const afterSecond = await roleAndGrantCounts();

    // No new roles and no new grants created on re-seed — idempotent.
    expect(afterSecond.roleCount).toBe(afterFirst.roleCount);
    expect(afterSecond.grantCount).toBe(afterFirst.grantCount);

    // Exactly one row per (role_id, permission_id) — the composite PK invariant —
    // and no role holds the same resource:action twice.
    expect((await duplicatePkGrants()).length).toBe(0);
    expect((await duplicateLogicalGrants()).length).toBe(0);
  });
});
