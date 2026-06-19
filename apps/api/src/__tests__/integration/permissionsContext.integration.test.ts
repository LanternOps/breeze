/**
 * Real-DB regression test for the #1448 blocking finding: the partner pay-link
 * route (POST /invoices/:id/pay-link) opts out of the auth middleware's auto
 * request-transaction, so its route-level `requirePermission(INVOICES_SEND)` runs
 * `getUserPermissions` with NO ambient DB access context.
 *
 * Before the fix, those membership/role reads ran on the bare `breeze_app` pool
 * with no RLS GUCs set → forced RLS filtered them to 0 rows → `getUserPermissions`
 * returned a spurious `null` → the middleware threw 403, masked only by a warm
 * in-memory `permissionCache` (so it 403'd on a cold/expired cache). This is the
 * exact assembled-chain regression the unit tests mock away.
 *
 * This test drives the REAL `getUserPermissions` against Postgres with the cache
 * cleared and NO ambient context (via `runOutsideDbContext`), and asserts it
 * resolves the partner's real permission set rather than `null`. If the
 * `withSystemDbAccessContext` self-wrap is removed, this fails (cold-cache 403).
 */
import './setup';
import { describe, it, expect, beforeEach } from 'vitest';
import { db, withSystemDbAccessContext, runOutsideDbContext, hasDbAccessContext } from '../../db';
import { partners, organizations, users, roles, permissions, rolePermissions, partnerUsers } from '../../db/schema';
import { getUserPermissions, clearPermissionCache } from '../../services/permissions';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Fixture { partnerId: string; userId: string }

/** Seed a partner, a user, a partner-scope role holding invoices:send, and the
 *  partner_users membership linking them. All under a system context so the rows
 *  actually commit (the function under test reads them back with NO context). */
async function seedPartnerUserWithSendPerm(): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `PP ${sfx}`, slug: `pp-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [o] = await db.insert(organizations)
      .values({ partnerId: p!.id, name: 'POrg', slug: `po-${sfx}` })
      .returning({ id: organizations.id });
    const [u] = await db.insert(users)
      .values({ partnerId: p!.id, orgId: o!.id, email: `pp-${sfx}@x.io`, name: 'PP', status: 'active' })
      .returning({ id: users.id });
    const [r] = await db.insert(roles)
      .values({ partnerId: p!.id, scope: 'partner', name: `Sender ${sfx}` })
      .returning({ id: roles.id });
    const [perm] = await db.insert(permissions)
      .values({ resource: 'invoices', action: 'send' })
      .returning({ id: permissions.id });
    await db.insert(rolePermissions).values({ roleId: r!.id, permissionId: perm!.id });
    await db.insert(partnerUsers)
      .values({ partnerId: p!.id, userId: u!.id, roleId: r!.id, orgAccess: 'all' });
    return { partnerId: p!.id, userId: u!.id };
  });
}

describe('getUserPermissions DB access context (breeze_app, real DB, #1448)', () => {
  beforeEach(async () => {
    await clearPermissionCache();
  });

  runDb('resolves the real permission set when called contextless on a cold cache (the pay-link route condition)', async () => {
    const f = await seedPartnerUserWithSendPerm();

    // Drive it exactly as the contextless pay-link route does: no ambient context,
    // cold cache. Pre-fix this returned null (→ 403); post-fix it self-wraps.
    const perms = await runOutsideDbContext(() => {
      expect(hasDbAccessContext()).toBe(false); // prove we're genuinely contextless
      return getUserPermissions(f.userId, { partnerId: f.partnerId });
    });

    expect(perms).not.toBeNull();
    expect(perms?.scope).toBe('partner');
    expect(perms?.permissions).toContainEqual({ resource: 'invoices', action: 'send' });
  });

  runDb('returns null for a user with no membership (genuine no-access, not an RLS artifact)', async () => {
    // A user that exists but has no partner_users / organization_users row.
    const orphanId = await withSystemDbAccessContext(async () => {
      const sfx = Math.random().toString(36).slice(2, 8);
      const [p] = await db.insert(partners)
        .values({ name: `OP ${sfx}`, slug: `op-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
        .returning({ id: partners.id });
      const [u] = await db.insert(users)
        .values({ partnerId: p!.id, email: `op-${sfx}@x.io`, name: 'OP', status: 'active' })
        .returning({ id: users.id });
      return { partnerId: p!.id, userId: u!.id };
    });

    const perms = await runOutsideDbContext(() =>
      getUserPermissions(orphanId.userId, { partnerId: orphanId.partnerId }));

    expect(perms).toBeNull();
  });

  runDb('resolves the same permission set when already inside an ambient context (no-op nest)', async () => {
    const f = await seedPartnerUserWithSendPerm();

    // Normal-route path: an ambient system context is active; getUserPermissions must
    // NOT open a second context and must resolve the same row.
    const perms = await withSystemDbAccessContext(() => {
      expect(hasDbAccessContext()).toBe(true);
      return getUserPermissions(f.userId, { partnerId: f.partnerId });
    });

    expect(perms?.permissions).toContainEqual({ resource: 'invoices', action: 'send' });
  });
});
