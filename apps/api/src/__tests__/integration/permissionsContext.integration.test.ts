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
import { db, withDbAccessContext, withSystemDbAccessContext, runOutsideDbContext, hasDbAccessContext, getCurrentDbAccessContext } from '../../db';
import { partners, organizations, users, roles, permissions, rolePermissions, partnerUsers, organizationUsers } from '../../db/schema';
import { getUserPermissions, clearPermissionCache } from '../../services/permissions';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Fixture { partnerId: string; userId: string }

interface OrgFixture { partnerId: string; orgId: string; userId: string }

/** Seed a Partner Admin with a partner-scope role holding `devices:read`, an org
 *  under that partner, and the partner_users membership — but deliberately NO
 *  organization_users row. This is the #2019 self-hoster shape: a membership-less
 *  Partner Admin whose role lives only on the partner axis. */
async function seedMembershiplessPartnerAdmin(): Promise<OrgFixture> {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `MP ${sfx}`, slug: `mp-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [o] = await db.insert(organizations)
      .values({ partnerId: p!.id, name: 'MOrg', slug: `mo-${sfx}` })
      .returning({ id: organizations.id });
    const [u] = await db.insert(users)
      .values({ partnerId: p!.id, orgId: o!.id, email: `mp-${sfx}@x.io`, name: 'MP', status: 'active' })
      .returning({ id: users.id });
    const [r] = await db.insert(roles)
      .values({ partnerId: p!.id, scope: 'partner', name: `Admin ${sfx}` })
      .returning({ id: roles.id });
    const [perm] = await db.insert(permissions)
      .values({ resource: 'devices', action: 'read' })
      .returning({ id: permissions.id });
    await db.insert(rolePermissions).values({ roleId: r!.id, permissionId: perm!.id });
    await db.insert(partnerUsers)
      .values({ partnerId: p!.id, userId: u!.id, roleId: r!.id, orgAccess: 'all' });
    // NB: NO organization_users row — the role is partner-axis only.
    return { partnerId: p!.id, orgId: o!.id, userId: u!.id };
  });
}

/** Seed a user with a real organization_users row holding an org-scope role with
 *  devices:read — the common dashboard shape (org membership on the org axis). */
async function seedOrgMemberUser(): Promise<OrgFixture> {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);
    const [p] = await db.insert(partners)
      .values({ name: `OM ${sfx}`, slug: `om-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [o] = await db.insert(organizations)
      .values({ partnerId: p!.id, name: 'OMOrg', slug: `omo-${sfx}` })
      .returning({ id: organizations.id });
    const [u] = await db.insert(users)
      .values({ partnerId: p!.id, orgId: o!.id, email: `om-${sfx}@x.io`, name: 'OM', status: 'active' })
      .returning({ id: users.id });
    const [r] = await db.insert(roles)
      .values({ orgId: o!.id, scope: 'organization', name: `OrgRole ${sfx}` })
      .returning({ id: roles.id });
    const [perm] = await db.insert(permissions)
      .values({ resource: 'devices', action: 'read' })
      .returning({ id: permissions.id });
    await db.insert(rolePermissions).values({ roleId: r!.id, permissionId: perm!.id });
    await db.insert(organizationUsers).values({ orgId: o!.id, userId: u!.id, roleId: r!.id });
    return { partnerId: p!.id, orgId: o!.id, userId: u!.id };
  });
}

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

  runDb('getCurrentDbAccessContext mirrors the active context and clears under runOutsideDbContext', async () => {
    // Plumbing proof for the conditional-escalation getter: the metadata store must
    // surface the live context (so canSee() can read accessibleOrgIds/Partners) and must
    // be cleared when we exit via runOutsideDbContext (so the escalated read is genuinely
    // contextless). Uses synthetic ids — no rows queried, just GUC propagation.
    const orgId = '00000000-0000-0000-0000-0000000000aa';
    const { inside, outside } = await withDbAccessContext(
      {
        scope: 'organization',
        orgId,
        accessibleOrgIds: [orgId],
        accessiblePartnerIds: [],
        currentPartnerId: null,
      },
      async () => ({
        inside: getCurrentDbAccessContext(),
        outside: runOutsideDbContext(() => getCurrentDbAccessContext()),
      }),
    );

    expect(inside?.scope).toBe('organization');
    expect(inside?.accessibleOrgIds).toEqual([orgId]);
    expect(outside).toBeUndefined();
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

  runDb('resolves a membership-less Partner Admin role under a NARROWER org-scope ambient context (#2019 MCP org-key path)', async () => {
    const f = await seedMembershiplessPartnerAdmin();

    // Reproduce the manual org-scoped MCP/API-key request context exactly:
    // scope='organization', single accessible org, and an EMPTY partner allowlist
    // (apiKeyAuth withholds partner-axis RLS visibility from manual keys). The
    // caller passes BOTH the org and the resolved owning partnerId (the #2019 fix
    // threads partnerId in) — but the role lives in partner_users, which RLS hides
    // unless the read escalates to system scope. Pre-fix this returned null →
    // "Insufficient permissions: no role assigned" on every tools/call.
    const perms = await withDbAccessContext(
      {
        scope: 'organization',
        orgId: f.orgId,
        accessibleOrgIds: [f.orgId],
        accessiblePartnerIds: [], // the deliberately-narrow manual-key context
        currentPartnerId: null,
      },
      () => {
        expect(hasDbAccessContext()).toBe(true); // prove the narrower context is active
        return getUserPermissions(f.userId, { partnerId: f.partnerId, orgId: f.orgId });
      },
    );

    expect(perms).not.toBeNull();
    expect(perms?.scope).toBe('partner');
    expect(perms?.permissions).toContainEqual({ resource: 'devices', action: 'read' });
  });

  runDb('reuses an ambient SYSTEM context (which sees every row) without escalating', async () => {
    const f = await seedPartnerUserWithSendPerm();

    // A system-scope context already grants visibility to every row, so canSee() is true
    // and getUserPermissions resolves the partner role in-place — no exit/re-enter. The
    // assertion here is the resolved row; the no-escalation behavior for this case is
    // pinned at the unit level (permissions.test.ts reuse test).
    const perms = await withSystemDbAccessContext(() => {
      expect(hasDbAccessContext()).toBe(true);
      return getUserPermissions(f.userId, { partnerId: f.partnerId });
    });

    expect(perms?.permissions).toContainEqual({ resource: 'invoices', action: 'send' });
  });

  runDb('resolves an org member under their own org-scope ambient context (reuse path, real RLS)', async () => {
    // The common dashboard shape the unit tests can only mock: a user with a real
    // organization_users row, resolved inside the org-scope context authMiddleware would
    // open for them (accessibleOrgIds = [their org]). canSee('org') is true → the
    // org-axis read is reused against real Postgres RLS and must return the org role.
    const f = await seedOrgMemberUser();

    const perms = await withDbAccessContext(
      {
        scope: 'organization',
        orgId: f.orgId,
        accessibleOrgIds: [f.orgId],
        accessiblePartnerIds: [],
        currentPartnerId: null,
      },
      () => getUserPermissions(f.userId, { orgId: f.orgId, partnerId: f.partnerId }),
    );

    expect(perms).not.toBeNull();
    expect(perms?.scope).toBe('organization');
    expect(perms?.permissions).toContainEqual({ resource: 'devices', action: 'read' });
  });
});
