/**
 * Real-driver cross-tenant forge tests for partner-axis patch tables.
 *
 * Runs under vitest.integration.config.ts — connects as the unprivileged
 * `breeze_app` role (rolbypassrls=f), so RLS is genuinely enforced. If
 * .env.test is missing the symlink, these tests pass vacuously on a
 * BYPASSRLS admin connection (see memory: worktree_env_test_rls_vacuous) —
 * the forged-insert assertions guard against that.
 *
 * Coverage:
 *   - patch_policies (partner-axis, RLS shape 3):
 *       partner B context reading partner A's ring → 0 rows (isolation)
 *       forged cross-partner INSERT (partner B context, partnerId=partnerA)
 *         rejected with RLS violation (42501)
 *       system scope CAN read the seeded ring (existence probe — non-vacuous)
 *
 *   - Route-level partner-scope + cross-partner denial (Task 14):
 *       org-scope POST /update-rings → 403 (requireScope gate)
 *       partner-scope POST /update-rings → 201, GET lists own rings only
 *       partner B GET /update-rings/:id owned by partner A → 404 (RLS hides ring; no existence oracle)
 *       approve patch with ringId from another partner → 404 (RLS hides ring; no existence oracle)
 *       partner-wide approval (ringId omitted) upserts (partner_id, patch_id,
 *         ring_id NULL) row visible only to that partner
 *
 * Drizzle wraps the driver error: the original Postgres 42501
 * ("new row violates row-level security policy for table …") surfaces on
 * `err.cause.code`. We assert on `cause.code` to match the verified sibling
 * pattern (stripe-payments-rls / catalog-rls).
 *
 * Why NO memoization: setup.ts cleanupDatabase() TRUNCATEs partners/
 * organizations in beforeEach — module-scope fixtures would be wiped before
 * the second test, making the RLS assertions vacuous (see memory:
 * rls-forge-test-memoized-fixture-vacuous). Each runDb() re-seeds fresh.
 *
 * Harness mirrored from:
 *   apps/api/src/__tests__/integration/org-scope-narrowing.integration.test.ts
 *   apps/api/src/__tests__/integration/time-entries-rls.integration.test.ts
 *
 * Key decisions:
 *   - Real authMiddleware (no vi.mock) + JWT minted with createAccessToken.
 *   - Write routes require requireMfa() — tokens are minted with mfa:true.
 *   - patches is a global catalog table; getTestDb() (superuser) seeds it.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { patchPolicies, patches, patchApprovals } from '../../db/schema';
import { createPartner, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';
import { createAccessToken } from '../../services/jwt';
import { authMiddleware } from '../../middleware/auth';
import { updateRingRoutes } from '../../routes/updateRings';
import { patchRoutes } from '../../routes/patches';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function buildRingsApp(): Hono {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.route('/update-rings', updateRingRoutes);
  return app;
}

function buildPatchesApp(): Hono {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.route('/patches', patchRoutes);
  return app;
}

function partnerCtx(partnerId: string): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: null,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

async function seed() {
  return withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();

    const [ringA] = await db
      .insert(patchPolicies)
      .values({
        partnerId: partnerA.id,
        kind: 'ring',
        name: `forge-ring-A-${Date.now()}`,
      })
      .returning();
    if (!ringA) throw new Error('failed to seed ring A');

    return { partnerA, partnerB, ringA };
  });
}

/** Seed a patches catalog row (global table, no tenant FK). Uses superuser
 *  pool because patch catalog is not tenant-scoped. */
async function seedPatch(): Promise<string> {
  const [row] = await getTestDb()
    .insert(patches)
    .values({
      source: 'microsoft',
      externalId: `microsoft:${randomUUID()}`,
      title: 'Route-test patch',
      severity: 'important',
    })
    .returning({ id: patches.id });
  if (!row) throw new Error('seedPatch: no row returned');
  return row.id;
}

describe('patch_policies RLS — partner isolation forge (breeze_app)', () => {
  runDb('partner B cannot read partner A ring (0-row isolation)', async () => {
    const { partnerB, ringA } = await seed();
    const rows = await withDbAccessContext(partnerCtx(partnerB.id), () =>
      db.select({ id: patchPolicies.id }).from(patchPolicies).where(eq(patchPolicies.id, ringA.id))
    );
    expect(rows).toHaveLength(0);
  });

  runDb('forged cross-partner INSERT is rejected by WITH CHECK (42501)', async () => {
    const { partnerA, partnerB } = await seed();
    await expect(
      withDbAccessContext(partnerCtx(partnerB.id), () =>
        db.insert(patchPolicies).values({
          partnerId: partnerA.id, // forged — RLS WITH CHECK must reject
          kind: 'ring',
          name: `forge-x-${Date.now()}`,
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  runDb('system scope can read seeded ring (existence probe — non-vacuous)', async () => {
    const { ringA } = await seed();
    const rows = await withSystemDbAccessContext(() =>
      db.select({ id: patchPolicies.id }).from(patchPolicies).where(eq(patchPolicies.id, ringA.id))
    );
    expect(rows).toHaveLength(1);
  });
});

// ============================================================
// Route-level integration tests (Task 14)
// Mirrors harness from org-scope-narrowing.integration.test.ts
// and time-entries-rls.integration.test.ts (mfa:true tokens).
// ============================================================

describe('update-rings routes — partner-scope + cross-partner denial', () => {
  // Case 1: org-scope request → 403 (requireScope gate)
  runDb('org-scope POST /update-rings → 403', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    // Org-scope token has mfa:false; mfa gate is moot (scope gate fires first).
    const app = buildRingsApp();
    const res = await app.request('/update-rings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.token}`, ...JSON_HEADERS },
      body: JSON.stringify({ name: 'should-fail' }),
    });
    expect(res.status).toBe(403);
  });

  // Case 2: partner-scope create → 201, list returns only own rings
  runDb('partner-scope POST /update-rings → 201, GET lists own rings only', async () => {
    const envA = await setupTestEnvironment({ scope: 'partner' });
    const envB = await setupTestEnvironment({ scope: 'partner' });

    // Mint mfa:true token for partner A (POST requires requireMfa()).
    const mfaTokenA = await createAccessToken({
      sub: envA.user.id,
      email: envA.user.email,
      roleId: envA.role.id,
      orgId: null,
      partnerId: envA.partner.id,
      scope: 'partner',
      mfa: true,
      // Epoch claims (core-auth PR 1): authMiddleware rejects access tokens
      // missing aep/mep/sid or stale vs users.auth_epoch/mfa_epoch (DB default 1).
      aep: 1,
      mep: 1,
      sid: 'it-session',
    });

    const app = buildRingsApp();
    const ringName = `route-test-ring-${Date.now()}`;

    // Create a ring as partner A.
    const createRes = await app.request('/update-rings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${mfaTokenA}`, ...JSON_HEADERS },
      body: JSON.stringify({ name: ringName }),
    });
    expect(createRes.status).toBe(201);
    const ring = await createRes.json();
    expect(ring.partnerId).toBe(envA.partner.id);
    expect(ring.name).toBe(ringName);

    // List as partner A — should include the ring just created.
    // Non-mfa token is fine for GET (no requireMfa on GET).
    const listResA = await app.request('/update-rings', {
      headers: { Authorization: `Bearer ${envA.token}` },
    });
    expect(listResA.status).toBe(200);
    const listBodyA = await listResA.json();
    const ringIdsA = listBodyA.data.map((r: { id: string }) => r.id);
    expect(ringIdsA).toContain(ring.id);

    // List as partner B — must NOT see partner A's ring (RLS isolation).
    const listResB = await app.request('/update-rings', {
      headers: { Authorization: `Bearer ${envB.token}` },
    });
    expect(listResB.status).toBe(200);
    const listBodyB = await listResB.json();
    const ringIdsB = listBodyB.data.map((r: { id: string }) => r.id);
    expect(ringIdsB).not.toContain(ring.id);
  });

  // Case 3: partner B cannot GET partner A's ring
  // RLS hides the ring under partner B's context → 0 rows → 404.
  // No 403 existence-oracle leak: the route never sees the row.
  runDb('partner B GET /update-rings/:id owned by partner A → 404 (RLS hides ring)', async () => {
    const envA = await setupTestEnvironment({ scope: 'partner' });
    const envB = await setupTestEnvironment({ scope: 'partner' });

    // Seed a ring belonging to partner A via superuser pool (bypasses RLS).
    const [ringA] = await getTestDb()
      .insert(patchPolicies)
      .values({
        partnerId: envA.partner.id,
        kind: 'ring',
        name: `case3-ring-${Date.now()}`,
      })
      .returning();
    if (!ringA) throw new Error('failed to seed ringA for Case 3');

    // Mint a non-mfa token for the real envB user (GET doesn't require MFA).
    // authMiddleware looks up users by sub; a real DB row is required to avoid 401.
    const tokenB = await createAccessToken({
      sub: envB.user.id,
      email: envB.user.email,
      roleId: envB.role.id,
      orgId: null,
      partnerId: envB.partner.id,
      scope: 'partner',
      mfa: false,
      // Epoch claims (core-auth PR 1): authMiddleware rejects access tokens
      // missing aep/mep/sid or stale vs users.auth_epoch/mfa_epoch (DB default 1).
      aep: 1,
      mep: 1,
      sid: 'it-session',
    });

    const app = buildRingsApp();
    const res = await app.request(`/update-rings/${ringA.id}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    // RLS returns 0 rows for a cross-partner ring → route responds 404.
    // This is security-correct: no existence-oracle leak (a 403 would confirm the ring exists).
    expect(res.status).toBe(404);
  });

  // Case 4: approve patch with ringId from another partner → 404 (RLS hides ring)
  // resolvePatchApprovalPartnerIdForRing looks up the ring under partner B's RLS
  // context → 0 rows → { error: 'Update ring not found', status: 404 }.
  // No 403 existence-oracle leak.
  runDb('approve patch with ringId from another partner → 404 (RLS hides ring)', async () => {
    const envA = await setupTestEnvironment({ scope: 'partner' });
    const envB = await setupTestEnvironment({ scope: 'partner' });

    // Seed a ring belonging to partner A.
    const [ringA] = await getTestDb()
      .insert(patchPolicies)
      .values({
        partnerId: envA.partner.id,
        kind: 'ring',
        name: `case4-ring-${Date.now()}`,
        enabled: true,
      })
      .returning();
    if (!ringA) throw new Error('failed to seed ringA');

    const patchId = await seedPatch();

    // Mint mfa:true token for partner B (POST /patches/:id/approve requires MFA).
    const mfaTokenB = await createAccessToken({
      sub: envB.user.id,
      email: envB.user.email,
      roleId: envB.role.id,
      orgId: null,
      partnerId: envB.partner.id,
      scope: 'partner',
      mfa: true,
      // Epoch claims (core-auth PR 1): authMiddleware rejects access tokens
      // missing aep/mep/sid or stale vs users.auth_epoch/mfa_epoch (DB default 1).
      aep: 1,
      mep: 1,
      sid: 'it-session',
    });

    const app = buildPatchesApp();
    const res = await app.request(`/patches/${patchId}/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mfaTokenB}`, ...JSON_HEADERS },
      body: JSON.stringify({ ringId: ringA.id }),
    });
    // resolvePatchApprovalPartnerIdForRing looks up the ring under partner B's RLS context
    // → 0 rows → { error: 'Update ring not found', status: 404 }.
    // This is security-correct: no existence-oracle leak (a 403 would confirm the ring exists).
    expect(res.status).toBe(404);
  });

  // Case 5: partner-wide approval (ringId omitted) upserts (partner_id, patch_id, ring_id NULL)
  runDb('partner-wide approval upserts row visible to that partner only', async () => {
    const envA = await setupTestEnvironment({ scope: 'partner' });
    const envB = await setupTestEnvironment({ scope: 'partner' });

    const patchId = await seedPatch();

    // Mint mfa:true token for partner A.
    const mfaTokenA = await createAccessToken({
      sub: envA.user.id,
      email: envA.user.email,
      roleId: envA.role.id,
      orgId: null,
      partnerId: envA.partner.id,
      scope: 'partner',
      mfa: true,
      // Epoch claims (core-auth PR 1): authMiddleware rejects access tokens
      // missing aep/mep/sid or stale vs users.auth_epoch/mfa_epoch (DB default 1).
      aep: 1,
      mep: 1,
      sid: 'it-session',
    });

    const app = buildPatchesApp();

    // Approve without ringId → partner-wide row.
    const approveRes = await app.request(`/patches/${patchId}/approve`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${mfaTokenA}`, ...JSON_HEADERS },
      body: JSON.stringify({}),
    });
    expect(approveRes.status).toBe(200);
    const approveBody = await approveRes.json();
    expect(approveBody.ringId).toBeNull();

    // Confirm (partner_id=A, patch_id, ring_id=NULL) row exists in DB via superuser.
    const rows = await getTestDb()
      .select({
        partnerId: patchApprovals.partnerId,
        patchId: patchApprovals.patchId,
        ringId: patchApprovals.ringId,
        status: patchApprovals.status,
      })
      .from(patchApprovals)
      .where(
        and(
          eq(patchApprovals.partnerId, envA.partner.id),
          eq(patchApprovals.patchId, patchId)
        )
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ringId).toBeNull();
    expect(rows[0]!.status).toBe('approved');

    // Partner B listing approvals must NOT see partner A's row.
    const listResB = await app.request('/patches/approvals', {
      headers: {
        Authorization: `Bearer ${envB.token}`,
      },
    });
    expect(listResB.status).toBe(200);
    const listBodyB = await listResB.json();
    const bPatchIds = listBodyB.data.map((a: { patchId: string }) => a.patchId);
    expect(bPatchIds).not.toContain(patchId);
  });
});
