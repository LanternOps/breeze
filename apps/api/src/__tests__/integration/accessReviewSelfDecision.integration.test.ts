/**
 * Access-review separation of duties, end to end on real Postgres.
 *
 * A reviewer may not decide the item about their OWN access unless no other
 * user in the review's scope is an eligible decider (single-admin exception);
 * a self-decision under the exception is persisted as
 * access_review_items.self_decided = true.
 *
 * Drives the real route (authMiddleware → requirePermission → requireMfa →
 * PATCH) with minted tokens, so eligibility is resolved against genuine
 * membership, role-grant and users rows — including a co-admin whose HOME org
 * differs from the reviewed org, whom the request's own RLS context cannot see
 * in `users` (the helper must still count them, or the exception fails open).
 *
 * Run (needs `pnpm test-stack up`):
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/accessReviewSelfDecision.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { accessReviewRoutes } from '../../routes/accessReviews';
import { accessReviewItems } from '../../db/schema';
import { createAccessToken } from '../../services/jwt';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

const USERS_RW = [
  { resource: 'users', action: 'read' },
  { resource: 'users', action: 'write' },
];

function buildApp(): Hono {
  const app = new Hono();
  app.route('/access-reviews', accessReviewRoutes);
  return app;
}

type Actor = { id: string; email: string; token: string };

async function tokenFor(
  user: { id: string; email: string },
  roleId: string,
  scope: { partnerId: string; orgId: string | null; scope: 'partner' | 'organization' },
): Promise<string> {
  return createAccessToken({
    sub: user.id,
    email: user.email,
    roleId,
    orgId: scope.orgId,
    partnerId: scope.partnerId,
    scope: scope.scope,
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  });
}

function call(app: Hono, actor: Actor, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { Authorization: `Bearer ${actor.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function itemRow(id: string) {
  const [row] = await (getTestDb() as any)
    .select({
      decision: accessReviewItems.decision,
      reviewedBy: accessReviewItems.reviewedBy,
      selfDecided: accessReviewItems.selfDecided,
    })
    .from(accessReviewItems)
    .where(eq(accessReviewItems.id, id));
  return row as { decision: string; reviewedBy: string | null; selfDecided: boolean };
}

/**
 * One org with an admin (users:write) and a plain member (users:read only).
 * `coAdmin` optionally adds a second org member with users:write, in the given
 * status, optionally with a different HOME org.
 */
async function seedOrg(coAdmin?: { status: 'active' | 'invited' | 'disabled'; foreignHome?: boolean }) {
  const unique = randomUUID().slice(0, 8);
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const adminRole = await createRole({ scope: 'organization', orgId: org.id, partnerId: partner.id });
  await grantRolePermissions(adminRole.id, USERS_RW);
  const memberRole = await createRole({ scope: 'organization', orgId: org.id, partnerId: partner.id });
  await grantRolePermissions(memberRole.id, [{ resource: 'users', action: 'read' }]);

  const admin = await createUser({ partnerId: partner.id, orgId: org.id, email: `sod-admin-${unique}@example.test` });
  await assignUserToOrganization(admin.id, org.id, adminRole.id);
  const member = await createUser({ partnerId: partner.id, orgId: org.id, email: `sod-member-${unique}@example.test` });
  await assignUserToOrganization(member.id, org.id, memberRole.id);

  let co: Actor | null = null;
  if (coAdmin) {
    const homeOrg = coAdmin.foreignHome ? await createOrganization({ partnerId: partner.id }) : org;
    const coUser = await createUser({
      partnerId: partner.id,
      orgId: homeOrg.id,
      status: coAdmin.status,
      email: `sod-co-${unique}@example.test`,
    });
    await assignUserToOrganization(coUser.id, org.id, adminRole.id);
    co = {
      id: coUser.id,
      email: coUser.email,
      token: await tokenFor(coUser, adminRole.id, { partnerId: partner.id, orgId: org.id, scope: 'organization' }),
    };
  }

  const adminActor: Actor = {
    id: admin.id,
    email: admin.email,
    token: await tokenFor(admin, adminRole.id, { partnerId: partner.id, orgId: org.id, scope: 'organization' }),
  };
  return { partner, org, admin: adminActor, member, co };
}

async function createReview(app: Hono, actor: Actor) {
  const res = await call(app, actor, 'POST', '/access-reviews', { name: `SoD review ${randomUUID()}` });
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  const detailRes = await call(app, actor, 'GET', `/access-reviews/${id}`);
  expect(detailRes.status).toBe(200);
  const detail = (await detailRes.json()) as {
    items: Array<{ id: string; userId: string }>;
    viewer: { userId: string; selfDecision: string | null };
  };
  return { id, detail };
}

function itemFor(detail: { items: Array<{ id: string; userId: string }> }, userId: string): string {
  const item = detail.items.find((i) => i.userId === userId);
  if (!item) throw new Error(`no review item for ${userId}`);
  return item.id;
}

describe('access review separation of duties (real Postgres)', () => {
  it('refuses a self-decision while an active co-admin exists; the co-admin decides it unflagged', async () => {
    const app = buildApp();
    const { admin, co } = await seedOrg({ status: 'active' });
    const { id, detail } = await createReview(app, admin);
    expect(detail.viewer.selfDecision).toBe('blocked');
    const ownItem = itemFor(detail, admin.id);

    const self = await call(app, admin, 'PATCH', `/access-reviews/${id}/items/${ownItem}`, { decision: 'approved' });
    expect(self.status).toBe(403);
    expect(((await self.json()) as { code: string }).code).toBe('ACCESS_REVIEW_SELF_DECISION');
    expect(await itemRow(ownItem)).toMatchObject({ decision: 'pending', reviewedBy: null, selfDecided: false });

    const byOther = await call(app, co!, 'PATCH', `/access-reviews/${id}/items/${ownItem}`, { decision: 'approved' });
    expect(byOther.status).toBe(200);
    expect(await itemRow(ownItem)).toMatchObject({ decision: 'approved', reviewedBy: co!.id, selfDecided: false });
  });

  it('counts a co-admin whose home org is elsewhere (invisible to the request RLS context)', async () => {
    const app = buildApp();
    const { admin } = await seedOrg({ status: 'active', foreignHome: true });
    const { id, detail } = await createReview(app, admin);
    const ownItem = itemFor(detail, admin.id);

    const self = await call(app, admin, 'PATCH', `/access-reviews/${id}/items/${ownItem}`, { decision: 'approved' });
    expect(self.status).toBe(403);
  });

  it.each(['disabled', 'invited'] as const)(
    'a %s co-admin cannot decide, so the single-admin exception applies',
    async (status) => {
      const app = buildApp();
      const { admin } = await seedOrg({ status });
      const { id, detail } = await createReview(app, admin);
      expect(detail.viewer.selfDecision).toBe('single_admin_exception');
      const ownItem = itemFor(detail, admin.id);

      const self = await call(app, admin, 'PATCH', `/access-reviews/${id}/items/${ownItem}`, { decision: 'approved' });
      expect(self.status).toBe(200);
      expect(await itemRow(ownItem)).toMatchObject({ decision: 'approved', reviewedBy: admin.id, selfDecided: true });
    },
  );

  it('a single admin can self-decide (flagged), decide the rest, and complete the review', async () => {
    const app = buildApp();
    const { admin, member } = await seedOrg();
    const { id, detail } = await createReview(app, admin);
    expect(detail.viewer.selfDecision).toBe('single_admin_exception');
    const ownItem = itemFor(detail, admin.id);
    const memberItem = itemFor(detail, member.id);

    expect((await call(app, admin, 'PATCH', `/access-reviews/${id}/items/${ownItem}`, { decision: 'approved' })).status).toBe(200);
    expect((await call(app, admin, 'PATCH', `/access-reviews/${id}/items/${memberItem}`, { decision: 'approved' })).status).toBe(200);

    expect(await itemRow(ownItem)).toMatchObject({ selfDecided: true });
    expect(await itemRow(memberItem)).toMatchObject({ selfDecided: false });

    const after = await call(app, admin, 'GET', `/access-reviews/${id}`);
    const afterBody = (await after.json()) as { items: Array<{ id: string; selfDecided: boolean }> };
    expect(afterBody.items.find((i) => i.id === ownItem)?.selfDecided).toBe(true);

    const complete = await call(app, admin, 'POST', `/access-reviews/${id}/complete`);
    expect(complete.status).toBe(200);
    expect(((await complete.json()) as { status: string }).status).toBe('completed');
  });

  it('partner reviews: a co-admin limited to selected orgs does not block the exception; one with all orgs does', async () => {
    const app = buildApp();
    const unique = randomUUID().slice(0, 8);
    const partner = await createPartner();
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    await grantRolePermissions(role.id, USERS_RW);
    const adminUser = await createUser({ partnerId: partner.id, orgId: null, email: `sod-p-admin-${unique}@example.test` });
    await assignUserToPartner(adminUser.id, partner.id, role.id, 'all');
    const coUser = await createUser({ partnerId: partner.id, orgId: null, email: `sod-p-co-${unique}@example.test` });
    await assignUserToPartner(coUser.id, partner.id, role.id, 'selected');
    const admin: Actor = {
      id: adminUser.id,
      email: adminUser.email,
      token: await tokenFor(adminUser, role.id, { partnerId: partner.id, orgId: null, scope: 'partner' }),
    };

    const first = await createReview(app, admin);
    expect(first.detail.viewer.selfDecision).toBe('single_admin_exception');
    const firstOwn = itemFor(first.detail, admin.id);
    expect((await call(app, admin, 'PATCH', `/access-reviews/${first.id}/items/${firstOwn}`, { decision: 'approved' })).status).toBe(200);
    expect(await itemRow(firstOwn)).toMatchObject({ selfDecided: true });

    // Add a second all-orgs admin: now someone else can decide.
    const fullAdmin = await createUser({ partnerId: partner.id, orgId: null, email: `sod-p-full-${unique}@example.test` });
    await assignUserToPartner(fullAdmin.id, partner.id, role.id, 'all');

    const second = await createReview(app, admin);
    expect(second.detail.viewer.selfDecision).toBe('blocked');
    const secondOwn = itemFor(second.detail, admin.id);
    const refused = await call(app, admin, 'PATCH', `/access-reviews/${second.id}/items/${secondOwn}`, { decision: 'approved' });
    expect(refused.status).toBe(403);
  });

  it('partner reviews: an all-orgs co-admin whose role lacks users:write does not block the exception', async () => {
    const app = buildApp();
    const unique = randomUUID().slice(0, 8);
    const partner = await createPartner();
    const adminRole = await createRole({ scope: 'partner', partnerId: partner.id });
    await grantRolePermissions(adminRole.id, USERS_RW);
    const readOnlyRole = await createRole({ scope: 'partner', partnerId: partner.id });
    await grantRolePermissions(readOnlyRole.id, [{ resource: 'users', action: 'read' }]);
    const adminUser = await createUser({ partnerId: partner.id, orgId: null, email: `sod-p2-admin-${unique}@example.test` });
    await assignUserToPartner(adminUser.id, partner.id, adminRole.id, 'all');
    const viewer = await createUser({ partnerId: partner.id, orgId: null, email: `sod-p2-ro-${unique}@example.test` });
    await assignUserToPartner(viewer.id, partner.id, readOnlyRole.id, 'all');
    const admin: Actor = {
      id: adminUser.id,
      email: adminUser.email,
      token: await tokenFor(adminUser, adminRole.id, { partnerId: partner.id, orgId: null, scope: 'partner' }),
    };

    const { id, detail } = await createReview(app, admin);
    expect(detail.viewer.selfDecision).toBe('single_admin_exception');
    const own = itemFor(detail, admin.id);
    expect((await call(app, admin, 'PATCH', `/access-reviews/${id}/items/${own}`, { decision: 'approved' })).status).toBe(200);
    expect(await itemRow(own)).toMatchObject({ selfDecided: true });
  });
});
