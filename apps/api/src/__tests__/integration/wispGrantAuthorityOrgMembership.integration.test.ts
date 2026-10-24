/**
 * Wisp (#9906) — "Wisp never exceeds its human" across the ORG axis, against
 * real Postgres.
 *
 * The human permission resolver (permissions.ts getUserPermissions) gives an
 * `organization_users` row precedence over the partner role inside that org.
 * A partner technician whose org-level role in org A is narrower than their
 * partner role must therefore get a Wisp ceiling that is equally narrow in
 * org A — and an org-A role without `ai_sessions:use` takes org A out of the
 * ceiling. Org B (no membership) keeps the partner-axis term throughout.
 *
 * Placement is load-bearing: `src/__tests__/integration/**` +
 * `.integration.test.ts` puts it in the blocking Integration Tests job.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { organizationUsers, permissions, rolePermissions, wispGrantRevisions, wispGrants } from '../../db/schema';
import type { WispCeilingSnapshot } from '../../db/schema/wisp';
import {
  assertToolCallWithinCeiling,
  assertWithinCeiling,
  CeilingViolationError,
  resolveGrantCeiling,
  type GrantCeiling,
} from '../../services/wisp/grantAuthority';
import { getTestDb } from './setup';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};

const BROAD_KEYS = ['ai_sessions:use', 'devices:read', 'devices:execute'];

// resolveGrantCeiling refuses every grant while Wisp is off; the suite runs with it on.
beforeEach(() => {
  vi.stubEnv('IS_HOSTED', 'true');
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  vi.stubEnv('BREEZE_WISP_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const perm = (key: string) => {
  const [resource, action] = key.split(':') as [string, string];
  return { resource, action };
};

/** Partner P with orgs A and B; grantor U is a partner user (org_access 'all') with a broad role; a partner-wide grant over both orgs. */
async function seed() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const grantor = await createUser({ partnerId: partner.id, email: `wisp-orgaxis-${randomUUID()}@wisp.test` });
  const partnerRole = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(partnerRole.id, BROAD_KEYS.map(perm));
  await assignUserToPartner(grantor.id, partner.id, partnerRole.id, 'all');

  const snapshot: WispCeilingSnapshot = {
    version: 1, permissionKeys: BROAD_KEYS, orgIds: [orgA.id, orgB.id], siteIds: null,
    toolAllowlist: null, deniedTools: [], partnerWide: true,
  };
  const pinned = await withDbAccessContext(SYSTEM_CTX, async () => {
    const [g] = await db.insert(wispGrants).values({
      partnerId: partner.id, grantorUserId: grantor.id, expiresAt: new Date(Date.now() + 30 * 86_400_000),
    }).returning({ id: wispGrants.id });
    const [r] = await db.insert(wispGrantRevisions).values({
      grantId: g!.id, partnerId: partner.id, revision: 1, ceilingSnapshot: snapshot,
      factorProof: { method: 'step_up', verifiedAt: new Date().toISOString() },
    }).returning({ id: wispGrantRevisions.id });
    await db.update(wispGrants).set({ currentRevisionId: r!.id }).where(eq(wispGrants.id, g!.id));
    return { grantId: g!.id, revisionId: r!.id };
  });
  return { partner, orgA, orgB, grantor, pinned };
}

function violation(fn: () => void): CeilingViolationError['code'] | 'none' {
  try {
    fn();
    return 'none';
  } catch (err) {
    if (err instanceof CeilingViolationError) return err.code;
    throw err;
  }
}

const permIn = (c: GrantCeiling, orgId: string | null | undefined, permission: string, siteId?: string | null) =>
  violation(() => assertWithinCeiling(c, { orgId, permission, ...(siteId !== undefined ? { siteId } : {}) }));

describe('resolveGrantCeiling — the grantor\'s org-level memberships narrow the ceiling (org-axis precedence)', () => {
  it('a narrower org role narrows that org only; an org role without ai_sessions:use takes the org out', async () => {
    const t = await seed();

    // Baseline: only the partner role applies — devices:execute in both orgs.
    const before = await resolveGrantCeiling(t.pinned.grantId, t.pinned.revisionId);
    expect([...before.orgIds].sort()).toEqual([t.orgA.id, t.orgB.id].sort());
    expect(before.partnerWide).toBe(true);
    expect(permIn(before, t.orgA.id, 'devices:execute')).toBe('none');
    expect(permIn(before, t.orgB.id, 'devices:execute')).toBe('none');

    // U gets a read-only (but AI-capable) role in org A.
    const narrowRole = await createRole({ scope: 'organization', orgId: t.orgA.id });
    await grantRolePermissions(narrowRole.id, ['ai_sessions:use', 'devices:read'].map(perm));
    await assignUserToOrganization(t.grantor.id, t.orgA.id, narrowRole.id);

    const narrowed = await resolveGrantCeiling(t.pinned.grantId, t.pinned.revisionId);
    expect([...narrowed.orgIds].sort()).toEqual([t.orgA.id, t.orgB.id].sort());
    expect(permIn(narrowed, t.orgA.id, 'devices:execute')).toBe('permission');
    expect(permIn(narrowed, t.orgA.id, 'devices:read')).toBe('none');
    expect(permIn(narrowed, t.orgB.id, 'devices:execute')).toBe('none');
    // An unbound / partner-level permission must hold in every org of the ceiling.
    expect(permIn(narrowed, undefined, 'devices:execute')).toBe('permission');
    expect(permIn(narrowed, null, 'devices:execute')).toBe('permission');
    expect(violation(() => assertToolCallWithinCeiling(
      narrowed, { toolName: 'get_device', orgId: t.orgA.id, siteId: null }, [perm('devices:execute')],
    ))).toBe('permission');

    // The membership's site allowlist binds org A only.
    const siteA1 = await createSite({ orgId: t.orgA.id });
    const siteA2 = await createSite({ orgId: t.orgA.id });
    await getTestDb().update(organizationUsers).set({ siteIds: [siteA1.id] })
      .where(and(eq(organizationUsers.userId, t.grantor.id), eq(organizationUsers.orgId, t.orgA.id)));
    const sited = await resolveGrantCeiling(t.pinned.grantId, t.pinned.revisionId);
    expect(permIn(sited, t.orgA.id, 'devices:read', siteA1.id)).toBe('none');
    expect(permIn(sited, t.orgA.id, 'devices:read', siteA2.id)).toBe('site');
    expect(permIn(sited, t.orgA.id, 'devices:read', null)).toBe('site');
    expect(permIn(sited, t.orgB.id, 'devices:execute', null)).toBe('none');

    // The org-A role loses ai_sessions:use → the human cannot use AI in A → A leaves the ceiling.
    const [aiUse] = await getTestDb().select({ id: permissions.id }).from(permissions)
      .where(and(eq(permissions.resource, 'ai_sessions'), eq(permissions.action, 'use'))).limit(1);
    await getTestDb().delete(rolePermissions)
      .where(and(eq(rolePermissions.roleId, narrowRole.id), eq(rolePermissions.permissionId, aiUse!.id)));

    const dropped = await resolveGrantCeiling(t.pinned.grantId, t.pinned.revisionId);
    expect([...dropped.orgIds]).toEqual([t.orgB.id]);
    expect(dropped.orgTerms.has(t.orgA.id)).toBe(false);
    expect(violation(() => assertWithinCeiling(dropped, { orgId: t.orgA.id }))).toBe('org');
    expect(permIn(dropped, t.orgB.id, 'devices:execute')).toBe('none');
    // The grantor no longer reaches every org of the partner: partner-level subjects close.
    expect(dropped.partnerWide).toBe(false);
    expect(violation(() => assertWithinCeiling(dropped, { orgId: null }))).toBe('org');
  });

  it('an org role WIDER than the partner role does not widen the ceiling in that org', async () => {
    const t = await seed();
    const wideRole = await createRole({ scope: 'organization', orgId: t.orgA.id });
    await grantRolePermissions(wideRole.id, [perm('*:*')]);
    await assignUserToOrganization(t.grantor.id, t.orgA.id, wideRole.id);

    const c = await resolveGrantCeiling(t.pinned.grantId, t.pinned.revisionId);
    expect(permIn(c, t.orgA.id, 'devices:execute')).toBe('none');
    expect(permIn(c, t.orgA.id, 'scripts:execute')).toBe('permission');
    expect(c.partnerWide).toBe(true);
  });
});
