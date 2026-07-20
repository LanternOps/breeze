/**
 * Real-Postgres integration coverage for the auth-lifecycle service
 * (Tasks 5/6/8/9/10): epoch advancement + refresh-family revocation must be
 * atomic, and durable revocation writes must run under a DB scope that RLS
 * actually grants.
 *
 * Mocked unit tests (Drizzle mocks) cannot prove any of the following —
 * they stub the query builder, so a rollback or an RLS 0-row write is
 * indistinguishable from success:
 *
 *   1. A mid-transaction throw rolls back BOTH the epoch bump and the family
 *      revoke — nothing partially applied.
 *   2. A successful transaction commits BOTH atomically.
 *   3. `refresh_token_families` is RLS Shape 6 (self OR system — see
 *      migration `2026-05-25-e-refresh-token-families.sql`). A partner-scoped
 *      admin revoking ANOTHER user's family under their own request-scope
 *      context silently writes ZERO rows (RLS filters it, no error) — the
 *      exact trap Task 9 avoids by wrapping every admin-driven revocation in
 *      `withSystemDbAccessContext`. Only a system-scope write actually lands.
 *   4. The real `removeMembershipForScope` / status-change PATCH paths
 *      (Tasks 6/9) fan out to a real membership delete + epoch advance +
 *      family revoke in one commit, end to end through the HTTP routes.
 *
 * Run:
 *   export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
 *   cd apps/api && pnpm vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/authLifecycle.integration.test.ts
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { users, refreshTokenFamilies, partnerUsers } from '../../db/schema';
import { advanceUserEpochs, revokeAllRefreshFamilies } from '../../services/authLifecycle';
import { mintRefreshTokenFamily } from '../../services/refreshTokenFamily';
import { createPartner, createUser, createRole, assignUserToPartner } from './db-utils';
import { getTestDb } from './setup';

async function readUserEpoch(userId: string): Promise<number> {
  const [row] = await getTestDb()
    .select({ authEpoch: users.authEpoch })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new Error(`user ${userId} not found`);
  return row.authEpoch;
}

async function readFamily(familyId: string) {
  const [row] = await getTestDb()
    .select()
    .from(refreshTokenFamilies)
    .where(eq(refreshTokenFamilies.familyId, familyId))
    .limit(1);
  if (!row) throw new Error(`family ${familyId} not found`);
  return row;
}

describe('auth-lifecycle atomicity — real Postgres (Task 13)', () => {
  let partnerId: string;

  beforeEach(async () => {
    const partner = await createPartner();
    partnerId = partner.id;
  });

  it('rolls back BOTH the epoch bump and the family revoke when the surrounding transaction throws (no partial state)', async () => {
    const user = await createUser({ partnerId, status: 'active' });
    const familyId = await mintRefreshTokenFamily(user.id);

    const epochBefore = await readUserEpoch(user.id);
    const familyBefore = await readFamily(familyId);
    expect(familyBefore.revokedAt).toBeNull();

    // Same pattern as routes/auth/password.ts / routes/users.ts: a single
    // db.transaction carrying both mutations. The primitive throw here
    // stands in for "any statement mid-tx fails" (Task 9 carried gap) — the
    // guarantee under test is that Postgres actually rolls the whole thing
    // back, not that this specific error path exists in production code.
    await expect(
      withSystemDbAccessContext(() =>
        db.transaction(async (tx) => {
          await advanceUserEpochs(tx, user.id, { auth: true });
          await revokeAllRefreshFamilies(tx, user.id, 'rollback-test');
          throw new Error('boom-mid-tx');
        })
      )
    ).rejects.toThrow('boom-mid-tx');

    const epochAfter = await readUserEpoch(user.id);
    const familyAfter = await readFamily(familyId);
    expect(epochAfter).toBe(epochBefore);
    expect(familyAfter.revokedAt).toBeNull();
    expect(familyAfter.revokedReason).toBeNull();
  });

  it('commits BOTH the epoch bump and the family revoke atomically when the transaction succeeds', async () => {
    const user = await createUser({ partnerId, status: 'active' });
    const familyId = await mintRefreshTokenFamily(user.id);
    const epochBefore = await readUserEpoch(user.id);

    await withSystemDbAccessContext(() =>
      db.transaction(async (tx) => {
        await advanceUserEpochs(tx, user.id, { auth: true });
        await revokeAllRefreshFamilies(tx, user.id, 'commit-test');
      })
    );

    const epochAfter = await readUserEpoch(user.id);
    const familyAfter = await readFamily(familyId);
    expect(epochAfter).toBe(epochBefore + 1);
    expect(familyAfter.revokedAt).not.toBeNull();
    expect(familyAfter.revokedReason).toBe('commit-test');
  });

  it('RLS-context proof: a request-scoped (non-system) revocation of ANOTHER user\'s family silently writes zero rows; only system scope actually revokes (Task 9 silent-zero-row trap)', async () => {
    const role = await createRole({ scope: 'partner', partnerId });
    const adminA = await createUser({ partnerId, status: 'active' });
    await assignUserToPartner(adminA.id, partnerId, role.id, 'all');
    const userB = await createUser({ partnerId, status: 'active' });
    const familyId = await mintRefreshTokenFamily(userB.id);

    // Admin A's own request-scope context (partner scope, NOT system).
    // refresh_token_families RLS is Shape 6 (self OR system) — admin A's
    // partner access does not satisfy either branch for user B's row, so the
    // UPDATE matches zero rows and returns successfully with no error. This
    // is exactly why every admin-driven revocation in production wraps the
    // mutation in withSystemDbAccessContext instead of the caller's own scope.
    await withDbAccessContext(
      {
        scope: 'partner',
        orgId: null,
        accessibleOrgIds: [],
        accessiblePartnerIds: [partnerId],
        userId: adminA.id,
        currentPartnerId: partnerId,
      },
      () => db.transaction((tx) => revokeAllRefreshFamilies(tx, userB.id, 'admin-driven-revoke'))
    );

    const afterRequestScope = await readFamily(familyId);
    expect(afterRequestScope.revokedAt).toBeNull();

    await withSystemDbAccessContext(() =>
      db.transaction((tx) => revokeAllRefreshFamilies(tx, userB.id, 'admin-driven-revoke'))
    );

    const afterSystemScope = await readFamily(familyId);
    expect(afterSystemScope.revokedAt).not.toBeNull();
    expect(afterSystemScope.revokedReason).toBe('admin-driven-revoke');
  });
});

// ============================================================================
// Real HTTP-route coverage: the production fan-out paths (Tasks 6/9) that
// actually call advanceUserEpochs + revokeAllRefreshFamilies inside one
// transaction. middleware/auth is mocked ONLY to inject a pre-built auth
// context (bypassing login/MFA/permission plumbing already covered
// elsewhere) — every DB write below still goes through real Postgres RLS via
// the real withDbAccessContext. Pattern mirrors
// userDeleteResurrect.integration.test.ts.
// ============================================================================
type AuthCtx = {
  scope: 'system' | 'partner' | 'organization';
  partnerId: string | null;
  orgId: string | null;
  accessibleOrgIds: string[] | null;
  accessiblePartnerIds: string[] | null;
  userId?: string | null;
};

let activeAuthContext: AuthCtx | null = null;

vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  const { withDbAccessContext } = await import('../../db');
  return {
    ...actual,
    authMiddleware: (c: any, next: any) => {
      if (!activeAuthContext) return c.json({ error: 'Unauthorized' }, 401);
      const ctx = activeAuthContext;
      c.set('auth', {
        scope: ctx.scope,
        partnerId: ctx.partnerId,
        orgId: ctx.orgId,
        accessibleOrgIds: ctx.accessibleOrgIds ?? [],
        user: {
          id: ctx.userId ?? null,
          email: 'integration@test',
          isPlatformAdmin: ctx.scope === 'system',
        },
      });
      return withDbAccessContext(
        {
          scope: ctx.scope,
          orgId: ctx.orgId,
          accessibleOrgIds: ctx.accessibleOrgIds,
          accessiblePartnerIds: ctx.accessiblePartnerIds,
          userId: ctx.userId ?? null,
        },
        () => next(),
      );
    },
    hasSatisfiedMfa: () => true,
    requireMfa: () => (_c: any, next: any) => next(),
    requirePermission: () => (_c: any, next: any) => next(),
  };
});

async function buildUsersApp() {
  const { userRoutes } = await import('../../routes/users');
  const { authMiddleware } = await import('../../middleware/auth');
  const app = new Hono();
  app.use('*', authMiddleware as never);
  app.route('/users', userRoutes);
  return app;
}

describe('membership-removal fan-out — atomic epoch advance + family revoke (Tasks 6/9)', () => {
  beforeEach(() => {
    activeAuthContext = null;
  });

  afterEach(() => {
    activeAuthContext = null;
    vi.clearAllMocks();
  });

  it('DELETE /users/:id removes the membership, advances auth_epoch, and revokes every refresh family in one commit', async () => {
    const partner = await createPartner();
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    const caller = await createUser({ partnerId: partner.id, status: 'active' });
    await assignUserToPartner(caller.id, partner.id, role.id, 'all');
    const target = await createUser({ partnerId: partner.id, status: 'active' });
    await assignUserToPartner(target.id, partner.id, role.id);
    const familyId = await mintRefreshTokenFamily(target.id);
    const epochBefore = await readUserEpoch(target.id);

    activeAuthContext = {
      scope: 'partner',
      partnerId: partner.id,
      orgId: null,
      accessibleOrgIds: [],
      accessiblePartnerIds: [partner.id],
      userId: caller.id,
    };

    const app = await buildUsersApp();
    const res = await app.request(`/users/${target.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);

    const [link] = await getTestDb()
      .select({ id: partnerUsers.id })
      .from(partnerUsers)
      .where(eq(partnerUsers.userId, target.id))
      .limit(1);
    expect(link).toBeUndefined();

    const epochAfter = await readUserEpoch(target.id);
    expect(epochAfter).toBe(epochBefore + 1);

    const family = await readFamily(familyId);
    expect(family.revokedAt).not.toBeNull();
    expect(family.revokedReason).toBe('membership-removed');
  });

  it('PATCH /users/:id status→disabled advances auth_epoch and revokes every refresh family atomically', async () => {
    const partner = await createPartner();
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    const caller = await createUser({ partnerId: partner.id, status: 'active' });
    await assignUserToPartner(caller.id, partner.id, role.id, 'all');
    const target = await createUser({ partnerId: partner.id, status: 'active' });
    await assignUserToPartner(target.id, partner.id, role.id);
    const familyId = await mintRefreshTokenFamily(target.id);
    const epochBefore = await readUserEpoch(target.id);

    activeAuthContext = {
      scope: 'system',
      partnerId: null,
      orgId: null,
      accessibleOrgIds: null,
      accessiblePartnerIds: null,
      userId: caller.id,
    };

    const app = await buildUsersApp();
    const res = await app.request(`/users/${target.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'disabled' }),
    });
    expect(res.status).toBe(200);

    const epochAfter = await readUserEpoch(target.id);
    expect(epochAfter).toBe(epochBefore + 1);

    const family = await readFamily(familyId);
    expect(family.revokedAt).not.toBeNull();
    expect(family.revokedReason).toBe('status:disabled');
  });

  it('a name-only PATCH (no status change) does NOT advance auth_epoch or touch refresh families', async () => {
    const partner = await createPartner();
    const role = await createRole({ scope: 'partner', partnerId: partner.id });
    const caller = await createUser({ partnerId: partner.id, status: 'active' });
    await assignUserToPartner(caller.id, partner.id, role.id, 'all');
    const target = await createUser({ partnerId: partner.id, status: 'active' });
    await assignUserToPartner(target.id, partner.id, role.id);
    const familyId = await mintRefreshTokenFamily(target.id);
    const epochBefore = await readUserEpoch(target.id);

    activeAuthContext = {
      // Global user identity rows may span multiple partners. Only system
      // authority can prove it owns every tenant affected by this mutation.
      scope: 'system',
      partnerId: null,
      orgId: null,
      accessibleOrgIds: null,
      accessiblePartnerIds: null,
      userId: caller.id,
    };

    const app = await buildUsersApp();
    const res = await app.request(`/users/${target.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed Target' }),
    });
    expect(res.status).toBe(200);

    const epochAfter = await readUserEpoch(target.id);
    expect(epochAfter).toBe(epochBefore);

    const family = await readFamily(familyId);
    expect(family.revokedAt).toBeNull();
  });
});
