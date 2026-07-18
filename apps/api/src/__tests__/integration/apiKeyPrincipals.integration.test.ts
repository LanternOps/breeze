/**
 * PR5 Task 6 (SR2-15) — Real-DB proof of live API-key-creator authorization
 * against real Postgres with FORCE-RLS.
 *
 * This is the whole point of the PR: a human-delegated API key's authority is
 * LIVE-bound to its creator (`middleware/apiKeyAuth.ts` + resolvers in
 * `services/apiKeyAuthorization.ts`, wired in PR5 Tasks 1-2 and 5). That
 * property — "membership removal / permission reduction on a REAL Postgres
 * row kills a live key on the NEXT request" — cannot be proven against a
 * mock: a mocked `getUserPermissions` can only ever return what the test
 * told it to return, never what forced RLS actually filters. Everything here
 * drives the REAL `apiKeyAuthMiddleware` end to end against real Postgres +
 * real Redis (Redis backs the API-key rate limiter AND the permission-cache
 * version keys the middleware's resolvers depend on for live invalidation).
 *
 * PRIVATE DB (the shared :5433 rig is routinely contaminated by other
 * worktrees and its docker-compose.test.yml ships an UNSIZED tmpfs that
 * fabricates spurious failures). Stand up private containers with a SIZED
 * tmpfs and a genuinely unprivileged `breeze_app` role — RLS is VACUOUS
 * under a superuser, which would make every DENY assertion below pass for
 * the WRONG reason:
 *
 *   export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
 *   docker rm -f pr5-int-pg pr5-int-redis 2>/dev/null || true
 *   docker run -d --name pr5-int-pg -e POSTGRES_USER=breeze -e POSTGRES_PASSWORD=breeze \
 *     -e POSTGRES_DB=breeze_test -p 5457:5432 \
 *     --tmpfs /var/lib/postgresql/data:rw,size=2g postgres:16-alpine
 *   docker run -d --name pr5-int-redis -p 6390:6379 redis:7-alpine
 *   until docker exec pr5-int-pg pg_isready -U breeze >/dev/null 2>&1; do sleep 1; done
 *   docker exec pr5-int-pg psql -U breeze -d breeze_test -c \
 *     "CREATE ROLE breeze_app LOGIN PASSWORD 'breeze';"
 *   docker exec pr5-int-pg psql -U breeze -d breeze_test -c \
 *     "SELECT rolsuper FROM pg_roles WHERE rolname='breeze_app';"   -- MUST print f
 *
 *   cd apps/api && \
 *   DATABASE_URL=postgresql://breeze:breeze@localhost:5457/breeze_test \
 *   DATABASE_URL_APP=postgresql://breeze_app:breeze@localhost:5457/breeze_test \
 *   BREEZE_APP_DB_PASSWORD=breeze POSTGRES_PASSWORD=breeze REDIS_URL=redis://localhost:6390 \
 *   pnpm vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/apiKeyPrincipals.integration.test.ts
 *
 * The integration harness (globalSetup.ts) runs autoMigrate() off
 * DATABASE_URL / DATABASE_URL_APP, which applies
 * 2026-07-19-service-principals.sql automatically.
 */
import './setup';

import { describe, it, expect, beforeAll } from 'vitest';
import type { Hono } from 'hono';
import { createHash, randomBytes } from 'crypto';
import { and, eq } from 'drizzle-orm';

import {
  apiKeys,
  organizationUsers,
  partnerUsers,
  permissions,
  rolePermissions,
  servicePrincipals,
  users,
} from '../../db/schema';
import { PERMISSIONS, clearPermissionCache } from '../../services/permissions';
import {
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
  assignUserToOrganization,
  assignUserToPartner,
} from './db-utils';
import { getTestDb } from './setup';

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Mirrors the private, unexported `hashApiKey` in middleware/apiKeyAuth.ts —
// duplicated here (test-only) so seeded rows hash exactly like a real mint.
function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function mintRawApiKey(): string {
  return `brz_${randomBytes(24).toString('hex')}`;
}

async function insertApiKey(opts: {
  orgId: string;
  createdBy: string;
  scopes: string[];
  status?: 'active' | 'revoked' | 'expired';
  principalType?: 'human' | 'service';
  principalId?: string | null;
}): Promise<{ rawKey: string; id: string }> {
  const rawKey = mintRawApiKey();
  const [row] = await getTestDb()
    .insert(apiKeys)
    .values({
      orgId: opts.orgId,
      name: `test-key-${uniq()}`,
      keyHash: hashApiKey(rawKey),
      keyPrefix: rawKey.slice(0, 12),
      scopes: opts.scopes,
      createdBy: opts.createdBy,
      status: opts.status ?? 'active',
      principalType: opts.principalType ?? 'human',
      principalId: opts.principalId ?? null,
    })
    .returning();
  return { rawKey, id: row!.id };
}

async function insertServicePrincipal(opts: {
  orgId: string;
  createdBy: string;
  scopes: string[];
  status?: 'active' | 'disabled';
}) {
  const [row] = await getTestDb()
    .insert(servicePrincipals)
    .values({
      orgId: opts.orgId,
      name: `svc-principal-${uniq()}`,
      status: opts.status ?? 'active',
      scopes: opts.scopes,
      createdBy: opts.createdBy,
    })
    .returning();
  return row!;
}

async function setPrincipalStatus(principalId: string, status: 'active' | 'disabled') {
  await getTestDb().update(servicePrincipals).set({ status, updatedAt: new Date() }).where(eq(servicePrincipals.id, principalId));
}

async function setUserStatus(userId: string, status: 'active' | 'invited' | 'disabled') {
  await getTestDb().update(users).set({ status, updatedAt: new Date() }).where(eq(users.id, userId));
}

// Revokes ONE resource:action grant from a role by deleting its
// role_permissions row directly — the same DB-level effect a real
// role-permissions PATCH route produces. clearPermissionCache(userId) below
// mirrors the production call every such route makes afterward
// (routes/roles.ts, routes/users.ts) — required because getUserPermissions
// is Redis-version-cached; a raw DB mutation alone does not bump the version
// key, so a live key would otherwise keep reading the pre-mutation cache
// entry for up to 5 minutes.
async function revokeRolePermission(roleId: string, resource: string, action: string) {
  const [perm] = await getTestDb()
    .select({ id: permissions.id })
    .from(permissions)
    .where(and(eq(permissions.resource, resource), eq(permissions.action, action)))
    .limit(1);
  if (!perm) throw new Error(`permission ${resource}:${action} not seeded`);
  await getTestDb()
    .delete(rolePermissions)
    .where(and(eq(rolePermissions.roleId, roleId), eq(rolePermissions.permissionId, perm.id)));
}

// ---------------------------------------------------------------------------
// App bootstrap: mount the REAL apiKeyAuthMiddleware on a throwaway route.
// The middleware itself is the thing under test; the route handler only
// echoes back what the middleware resolved so assertions can inspect it.
// ---------------------------------------------------------------------------
let app: Hono;

beforeAll(async () => {
  const { Hono: HonoCtor } = await import('hono');
  const { apiKeyAuthMiddleware } = await import('../../middleware/apiKeyAuth');
  app = new HonoCtor();
  app.get('/keytest/protected', apiKeyAuthMiddleware, (c) => {
    const apiKey = c.get('apiKey');
    return c.json({ ok: true, scopes: apiKey.scopes, orgId: c.get('apiKeyOrgId') });
  });
});

function callWithKey(rawKey: string) {
  return app.request('/keytest/protected', { headers: { 'X-API-Key': rawKey } });
}

describe('SR2-15 real-DB API key principal authorization', () => {
  it('scenario 1: membership removal kills the key (GUARD-BITE — the core SR2-15 property)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const creator = await createUser({ partnerId: partner.id, orgId: org.id, status: 'active' });

    const role = await createRole({ scope: 'organization', orgId: org.id, partnerId: partner.id });
    await grantRolePermissions(role.id, [{ resource: PERMISSIONS.DEVICES_READ.resource, action: PERMISSIONS.DEVICES_READ.action }]);
    const membership = await assignUserToOrganization(creator.id, org.id, role.id);

    const { rawKey } = await insertApiKey({ orgId: org.id, createdBy: creator.id, scopes: ['devices:read'] });

    const before = await callWithKey(rawKey);
    expect(before.status).toBe(200);

    // Off-boarding: the creator's organization_users row is removed by some
    // out-of-band SQL (or a real removal route) — no app call is made
    // through apiKeyAuth's own resolver.
    await getTestDb().delete(organizationUsers).where(eq(organizationUsers.id, membership.id));
    // Mirrors the invalidation a real membership-removal route performs
    // (routes/users.ts's runPostCommitCleanup -> clearPermissionCache).
    await clearPermissionCache(creator.id);

    const after = await callWithKey(rawKey);
    expect(after.status).toBe(401);
  });

  it('scenario 2: partner-axis creator (no org row) authorizes via the partner axis; removing partner_users DENIES', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    // MSP staff: partner_id set, org_id null — NO organization_users row will
    // ever exist for this creator.
    const creator = await createUser({ partnerId: partner.id, orgId: null, status: 'active' });

    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    await grantRolePermissions(role.id, [{ resource: PERMISSIONS.DEVICES_READ.resource, action: PERMISSIONS.DEVICES_READ.action }]);
    const membership = await assignUserToPartner(creator.id, partner.id, role.id, 'all');

    // The key itself is ORG-scoped (a manual key minted against org).
    const { rawKey } = await insertApiKey({ orgId: org.id, createdBy: creator.id, scopes: ['devices:read'] });

    const before = await callWithKey(rawKey);
    // A resolver that only checked the org axis (no organization_users row
    // exists) would falsely DENY here — proving the dual-axis pass (Q5).
    expect(before.status).toBe(200);

    await getTestDb().delete(partnerUsers).where(eq(partnerUsers.id, membership.id));
    await clearPermissionCache(creator.id);

    const after = await callWithKey(rawKey);
    expect(after.status).toBe(401);
  });

  it('scenario 3: a permission reduction between mint and request re-clamps — a devices:write key DENIES while devices:read still works', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const creator = await createUser({ partnerId: partner.id, orgId: org.id, status: 'active' });

    const role = await createRole({ scope: 'organization', orgId: org.id, partnerId: partner.id });
    await grantRolePermissions(role.id, [
      { resource: PERMISSIONS.DEVICES_READ.resource, action: PERMISSIONS.DEVICES_READ.action },
      { resource: PERMISSIONS.DEVICES_WRITE.resource, action: PERMISSIONS.DEVICES_WRITE.action },
    ]);
    await assignUserToOrganization(creator.id, org.id, role.id);

    const readKey = await insertApiKey({ orgId: org.id, createdBy: creator.id, scopes: ['devices:read'] });
    const writeKey = await insertApiKey({ orgId: org.id, createdBy: creator.id, scopes: ['devices:write'] });

    expect((await callWithKey(readKey.rawKey)).status).toBe(200);
    expect((await callWithKey(writeKey.rawKey)).status).toBe(200);

    // Role downgraded: the creator's role loses devices:write between mint
    // and this request. No app-service call touched the key or the role
    // assignment — only the underlying grant.
    await revokeRolePermission(role.id, PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action);
    await clearPermissionCache(creator.id);

    // The write-scoped key can no longer be delegated by its creator's
    // CURRENT permissions — a permission reduction after mint cannot be
    // out-run by a key minted while the creator was more powerful.
    expect((await callWithKey(writeKey.rawKey)).status).toBe(401);
    // The read-scoped key is unaffected — the creator still holds devices:read.
    expect((await callWithKey(readKey.rawKey)).status).toBe(200);
  });

  it('scenario 4: fail-closed — a creator with NO visible membership row (neither axis) DENIES rather than authorizing', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    // Active user, but zero rows in organization_users AND zero rows in
    // partner_users — a genuinely membership-less creator. This must never
    // be read as "no restrictions apply" / "unrestricted" — a 0-row read on
    // either axis must fail closed.
    const creator = await createUser({ partnerId: partner.id, orgId: org.id, status: 'active' });

    const { rawKey } = await insertApiKey({ orgId: org.id, createdBy: creator.id, scopes: ['devices:read'] });

    const res = await callWithKey(rawKey);
    expect(res.status).toBe(401);
  });

  it('scenario 5: service-principal lifecycle — active+covers authorizes, disabled DENIES, unaffected by creator off-boarding', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    // The human who created the principal — the whole point of a service
    // principal is that ITS authority does not depend on this human staying
    // active.
    const humanCreator = await createUser({ partnerId: partner.id, orgId: org.id, status: 'active' });

    const principal = await insertServicePrincipal({
      orgId: org.id,
      createdBy: humanCreator.id,
      scopes: ['devices:read'],
      status: 'active',
    });
    const { rawKey } = await insertApiKey({
      orgId: org.id,
      createdBy: humanCreator.id,
      scopes: ['devices:read'],
      principalType: 'service',
      principalId: principal.id,
    });

    // Active principal, scopes covered by the principal's own ceiling -> authorizes.
    expect((await callWithKey(rawKey)).status).toBe(200);

    // Off-board the HUMAN creator. A service-principal key's authority does
    // not derive from a human's live permissions, so this must NOT affect it.
    await setUserStatus(humanCreator.id, 'disabled');
    expect((await callWithKey(rawKey)).status).toBe(200);

    // Disable the PRINCIPAL itself -> the disable-cascade gate denies.
    await setPrincipalStatus(principal.id, 'disabled');
    expect((await callWithKey(rawKey)).status).toBe(401);
  });
});
