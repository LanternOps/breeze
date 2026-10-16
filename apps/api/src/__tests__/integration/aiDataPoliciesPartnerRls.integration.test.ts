/**
 * ai_data_policies — live RLS, XOR, partner-default SELECT branch, cascade and
 * merge (AI device file read policy, #8852). Policies shipped in
 * 2026-12-29-130000-ai-data-policies.sql. Precedent:
 * aiScriptPoliciesPartnerRls.integration.test.ts.
 *
 * rls-coverage.integration.test.ts proves the policies EXIST; only driving the
 * real driver as `breeze_app` under FORCE RLS proves they enforce anything.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq, inArray, isNull } from 'drizzle-orm';

/**
 * Route harness for the org-session tests below: `authMiddleware` is replaced
 * by one that opens the request transaction EXACTLY the way the real one does
 * for an organization-session JWT — through the production
 * `buildDbAccessContext` with `partnerId: null` (org JWTs deliberately carry no
 * partner, middleware/auth.ts), so `currentPartnerId` is null and the
 * `ai_data_policies_partner_wide_select` branch cannot match. Everything else
 * in the module stays real.
 */
const routeAuth = vi.hoisted(() => ({ orgId: '', userId: '' }));
vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  const { withDbAccessContext: withCtx } = await import('../../db');
  return {
    ...actual,
    authMiddleware: (c: any, next: any) => {
      c.set('auth', {
        scope: 'organization',
        orgId: routeAuth.orgId,
        partnerId: null,
        accessibleOrgIds: [routeAuth.orgId],
        user: { id: routeAuth.userId, email: 'org-admin@data.test' },
        token: { mfa: true },
        canAccessOrg: (orgId: string) => orgId === routeAuth.orgId,
        orgCondition: () => undefined,
      });
      return withCtx(
        actual.buildDbAccessContext({
          scope: 'organization',
          orgId: routeAuth.orgId,
          accessibleOrgIds: [routeAuth.orgId],
          partnerId: null,
          userId: routeAuth.userId,
        }),
        () => next(),
      );
    },
    requirePermission: () => (_c: any, next: any) => next(),
    requireMfa: () => (_c: any, next: any) => next(),
  };
});

import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { aiDataPolicies } from '../../db/schema';
import { buildDbAccessContext } from '../../middleware/auth';
import { aiDataPolicyRoutes } from '../../routes/ai/dataPolicy';
import { resolveAiDataPolicy, resolveAiDataPolicyCeiling } from '../../services/aiDataPolicy';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import { executeOrgMerge } from '../../services/orgMerge';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner, createUser } from './db-utils';

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
    currentPartnerId: partnerId,
  };
}

/** Org-scoped session. `currentPartnerId` is what the partner-default SELECT branch keys on. */
function orgContext(orgId: string, currentPartnerId: string | null): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId,
  };
}

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  expect(pgErrorCode(raised)).toBe(code);
}

const createdPartnerIds: string[] = [];
const createdOrgIds: string[] = [];

afterEach(async () => {
  const partnerIds = [...new Set(createdPartnerIds)];
  const orgIds = [...new Set(createdOrgIds)];
  createdPartnerIds.length = 0;
  createdOrgIds.length = 0;
  await withSystemDbAccessContext(async () => {
    if (partnerIds.length > 0) await db.delete(aiDataPolicies).where(inArray(aiDataPolicies.partnerId, partnerIds));
    if (orgIds.length > 0) await db.delete(aiDataPolicies).where(inArray(aiDataPolicies.orgId, orgIds));
  });
});

let a: { partnerId: string; orgId: string };
let b: { partnerId: string; orgId: string };

beforeEach(async () => {
  const pa = await createPartner();
  const pb = await createPartner();
  const oa = await createOrganization({ partnerId: pa.id });
  const ob = await createOrganization({ partnerId: pb.id });
  createdPartnerIds.push(pa.id, pb.id);
  createdOrgIds.push(oa.id, ob.id);
  a = { partnerId: pa.id, orgId: oa.id };
  b = { partnerId: pb.id, orgId: ob.id };
});

const seedOrgRow = (orgId: string, over: Partial<typeof aiDataPolicies.$inferInsert> = {}) =>
  withSystemDbAccessContext(() =>
    db.insert(aiDataPolicies).values({ orgId, deviceFileReadLevel: 'off', ...over }));

describe('ai_data_policies RLS', () => {
  it('cross-partner ceiling insert is refused (42501)', async () => {
    await expectSqlState(
      () => withDbAccessContext(partnerContext(a.partnerId, [a.orgId]), () =>
        db.insert(aiDataPolicies).values({ partnerId: b.partnerId, deviceFileReadLevel: 'off' })),
      '42501',
    );
  });

  it('org token cannot insert a partner row (42501)', async () => {
    await expectSqlState(
      () => withDbAccessContext(orgContext(a.orgId, a.partnerId), () =>
        db.insert(aiDataPolicies).values({ partnerId: a.partnerId, deviceFileReadLevel: 'off' })),
      '42501',
    );
  });

  it('XOR: both owners set is refused (23514)', async () => {
    await expectSqlState(
      () => withSystemDbAccessContext(() =>
        db.insert(aiDataPolicies).values({ partnerId: a.partnerId, orgId: a.orgId })),
      '23514',
    );
  });

  it('retention below 1 is refused (23514)', async () => {
    await expectSqlState(
      () => withSystemDbAccessContext(() =>
        db.insert(aiDataPolicies).values({ partnerId: a.partnerId, toolOutputRetentionDays: 0 })),
      '23514',
    );
  });

  it('org token SEES its partner ceiling but cannot UPDATE or DELETE it', async () => {
    await withSystemDbAccessContext(() =>
      db.insert(aiDataPolicies).values({ partnerId: a.partnerId, deviceFileReadLevel: 'off' }));
    const seen = await withDbAccessContext(orgContext(a.orgId, a.partnerId), () =>
      db.select().from(aiDataPolicies).where(isNull(aiDataPolicies.orgId)));
    expect(seen).toHaveLength(1);
    const updated = await withDbAccessContext(orgContext(a.orgId, a.partnerId), () =>
      db.update(aiDataPolicies).set({ deviceFileReadLevel: 'any_with_approval' })
        .where(eq(aiDataPolicies.partnerId, a.partnerId)).returning());
    expect(updated).toHaveLength(0);
    const deleted = await withDbAccessContext(orgContext(a.orgId, a.partnerId), () =>
      db.delete(aiDataPolicies).where(eq(aiDataPolicies.partnerId, a.partnerId)).returning());
    expect(deleted).toHaveLength(0);
    const other = await withDbAccessContext(orgContext(b.orgId, b.partnerId), () =>
      db.select().from(aiDataPolicies).where(isNull(aiDataPolicies.orgId)));
    expect(other).toHaveLength(0);
  });

  describe('cascade and merge', () => {
    it('cascade deletes the org row and keeps the partner row', async () => {
      const actor = await createUser({ partnerId: a.partnerId, orgId: a.orgId, email: `erase-${Date.now()}@data.test` });
      await withSystemDbAccessContext(() =>
        db.insert(aiDataPolicies).values({ partnerId: a.partnerId, deviceFileReadLevel: 'off' }));
      await seedOrgRow(a.orgId);
      const stats = await cascadeDeleteOrg(a.orgId, actor.id, actor.email);
      expect(stats.tablesDeleted.ai_data_policies).toBe(1);
      const left = await withSystemDbAccessContext(() =>
        db.select().from(aiDataPolicies).where(eq(aiDataPolicies.partnerId, a.partnerId)));
      expect(left).toHaveLength(1);
      const orgRows = await withSystemDbAccessContext(() =>
        db.select().from(aiDataPolicies).where(eq(aiDataPolicies.orgId, a.orgId)));
      expect(orgRows).toHaveLength(0);
    });

    it("MERGE: the loser's row repoints to a survivor with none", async () => {
      const prior = process.env.ORG_MERGE_FENCE_DRAIN_MS;
      process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
      try {
        const survivor = await createOrganization({ partnerId: a.partnerId });
        createdOrgIds.push(survivor.id);
        const actor = await createUser({ partnerId: a.partnerId, email: `merge-${Date.now()}@data.test` });
        await seedOrgRow(a.orgId, { toolOutputRetentionDays: 9 });

        const result = await executeOrgMerge({
          loserOrgId: a.orgId, survivorOrgId: survivor.id, partnerId: a.partnerId,
          performedBy: actor.id, performedByEmail: actor.email,
        });
        expect(result.tables.ai_data_policies).toEqual({ moved: 1, dropped: 0 });

        const rows = await withSystemDbAccessContext(() =>
          db.select().from(aiDataPolicies).where(eq(aiDataPolicies.orgId, survivor.id)));
        expect(rows).toHaveLength(1);
        expect(rows[0]!.toolOutputRetentionDays).toBe(9);
      } finally {
        if (prior === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
        else process.env.ORG_MERGE_FENCE_DRAIN_MS = prior;
      }
    });

    it("MERGE: a survivor that ALREADY has a row keeps its own; the loser's is dropped (keep-survivor)", async () => {
      const prior = process.env.ORG_MERGE_FENCE_DRAIN_MS;
      process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
      try {
        const survivor = await createOrganization({ partnerId: a.partnerId });
        createdOrgIds.push(survivor.id);
        const actor = await createUser({ partnerId: a.partnerId, email: `merge2-${Date.now()}@data.test` });
        await seedOrgRow(survivor.id, { toolOutputRetentionDays: 2 });
        await seedOrgRow(a.orgId, { toolOutputRetentionDays: 9 });

        const result = await executeOrgMerge({
          loserOrgId: a.orgId, survivorOrgId: survivor.id, partnerId: a.partnerId,
          performedBy: actor.id, performedByEmail: actor.email,
        });
        expect(result.tables.ai_data_policies).toEqual({ moved: 0, dropped: 1 });

        const rows = await withSystemDbAccessContext(() =>
          db.select().from(aiDataPolicies).where(and(eq(aiDataPolicies.orgId, survivor.id))));
        expect(rows).toHaveLength(1);
        expect(rows[0]!.toolOutputRetentionDays).toBe(2);
      } finally {
        if (prior === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
        else process.env.ORG_MERGE_FENCE_DRAIN_MS = prior;
      }
    });
  });
});

describe('resolveAiDataPolicy under RLS', () => {
  const seedPartnerCeiling = () =>
    withSystemDbAccessContext(() =>
      db.insert(aiDataPolicies).values({ partnerId: a.partnerId, deviceFileReadLevel: 'off', toolOutputRetentionDays: 7 }));

  it('an org-scoped session resolves the partner ceiling through the SELECT branch', async () => {
    await seedPartnerCeiling();
    const ctx = orgContext(a.orgId, a.partnerId);
    const effective = await withDbAccessContext(ctx, () => resolveAiDataPolicy(a.orgId));
    expect(effective.deviceFileReadLevel).toBe('off');
    expect(effective.source.deviceFileReadLevel).toBe('partner');
    expect(effective.toolOutputRetentionDays).toBe(7);
    const ceiling = await withDbAccessContext(ctx, () => resolveAiDataPolicyCeiling(a.orgId));
    expect(ceiling.deviceFileReadLevel).toBe('off');
    expect(ceiling.source.deviceFileReadLevel).toBe('partner');
    expect(ceiling.toolOutputRetentionDays).toBe(7);
  });

  it('a partner-scoped session resolves the same ceiling', async () => {
    await seedPartnerCeiling();
    const effective = await withDbAccessContext(partnerContext(a.partnerId, [a.orgId]), () => resolveAiDataPolicy(a.orgId));
    expect(effective.deviceFileReadLevel).toBe('off');
    expect(effective.source.deviceFileReadLevel).toBe('partner');
  });

  it("another partner's org sees defaults: the foreign row is invisible", async () => {
    await seedPartnerCeiling();
    const effective = await withDbAccessContext(orgContext(b.orgId, b.partnerId), () => resolveAiDataPolicy(b.orgId));
    expect(effective.deviceFileReadLevel).toBe('no_user_profiles');
    expect(effective.toolOutputRetentionDays).toBe(30);
    expect(effective.source.deviceFileReadLevel).toBe('default');
    expect(effective.source.toolOutputRetentionDays).toBe('default');
  });

  // The REAL organization-session shape: org JWTs carry partnerId=null, so the
  // production builder yields currentPartnerId=null and the SELECT-only partner
  // branch cannot match. The resolver must still find the partner ceiling.
  const orgSessionCtx = (orgId: string): DbAccessContext =>
    buildDbAccessContext({ scope: 'organization', orgId, accessibleOrgIds: [orgId], partnerId: null, userId: null });

  it('an org-SESSION context (currentPartnerId null) still resolves the partner ceiling, never the looser default', async () => {
    await seedPartnerCeiling();
    const ctx = orgSessionCtx(a.orgId);
    expect(ctx.currentPartnerId).toBeNull();
    const effective = await withDbAccessContext(ctx, () => resolveAiDataPolicy(a.orgId));
    expect(effective.deviceFileReadLevel).toBe('off');
    expect(effective.source.deviceFileReadLevel).toBe('partner');
    expect(effective.toolOutputRetentionDays).toBe(7);
    const ceiling = await withDbAccessContext(ctx, () => resolveAiDataPolicyCeiling(a.orgId));
    expect(ceiling.deviceFileReadLevel).toBe('off');
    expect(ceiling.source.deviceFileReadLevel).toBe('partner');
    expect(ceiling.toolOutputRetentionDays).toBe(7);
  });

  it('an org-session context still applies its own tightening org row on top of the partner ceiling', async () => {
    await withSystemDbAccessContext(() =>
      db.insert(aiDataPolicies).values({ partnerId: a.partnerId, deviceFileReadLevel: 'any_with_approval', toolOutputRetentionDays: 90 }));
    await seedOrgRow(a.orgId, { deviceFileReadLevel: 'no_user_profiles', toolOutputRetentionDays: 14 });
    const effective = await withDbAccessContext(orgSessionCtx(a.orgId), () => resolveAiDataPolicy(a.orgId));
    expect(effective).toEqual({
      deviceFileReadLevel: 'no_user_profiles',
      toolOutputRetentionDays: 14,
      source: { deviceFileReadLevel: 'org', toolOutputRetentionDays: 'org' },
    });
  });

  it("cross-partner: an org-session context for partner A's org never resolves partner B's ceiling", async () => {
    await withSystemDbAccessContext(() =>
      db.insert(aiDataPolicies).values({ partnerId: b.partnerId, deviceFileReadLevel: 'any_with_approval', toolOutputRetentionDays: 365 }));
    // Org A's own resolution must not pick up B's row.
    const own = await withDbAccessContext(orgSessionCtx(a.orgId), () => resolveAiDataPolicyCeiling(a.orgId));
    expect(own.source.deviceFileReadLevel).toBe('default');
    expect(own.toolOutputRetentionDays).toBe(30);
    // Naming B's org from A's context: the org row is invisible under A's RLS,
    // so no partner id is derived and B's ceiling is never read.
    const foreignEffective = await withDbAccessContext(orgSessionCtx(a.orgId), () => resolveAiDataPolicy(b.orgId));
    expect(foreignEffective.source.deviceFileReadLevel).toBe('default');
    expect(foreignEffective.deviceFileReadLevel).toBe('no_user_profiles');
    const foreignCeiling = await withDbAccessContext(orgSessionCtx(a.orgId), () => resolveAiDataPolicyCeiling(b.orgId));
    expect(foreignCeiling.source.deviceFileReadLevel).toBe('default');
    expect(foreignCeiling.toolOutputRetentionDays).toBe(30);
  });
});

describe('org data-policy route under a real org-session DB context', () => {
  const app = () => {
    const h = new Hono();
    h.route('/ai', aiDataPolicyRoutes);
    return h;
  };

  beforeEach(async () => {
    const user = await createUser({ partnerId: a.partnerId, orgId: a.orgId, email: `org-admin-${Date.now()}@data.test` });
    routeAuth.orgId = a.orgId;
    routeAuth.userId = user.id;
    await withSystemDbAccessContext(() =>
      db.insert(aiDataPolicies).values({ partnerId: a.partnerId, deviceFileReadLevel: 'off', toolOutputRetentionDays: 7 }));
  });

  it('GET reports the partner ceiling, not the built-in default', async () => {
    const res = await app().request('/ai/data-policy');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ceiling.deviceFileReadLevel).toBe('off');
    expect(body.ceiling.source.deviceFileReadLevel).toBe('partner');
    expect(body.ceiling.toolOutputRetentionDays).toBe(7);
    expect(body.effective.deviceFileReadLevel).toBe('off');
    expect(body.effective.source.deviceFileReadLevel).toBe('partner');
  });

  it('PUT of a level looser than the partner ceiling is a 422 and stores nothing', async () => {
    const res = await app().request('/ai/data-policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceFileReadLevel: 'no_user_profiles' }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'above_partner_ceiling', field: 'deviceFileReadLevel' });
    const stored = await withSystemDbAccessContext(() =>
      db.select().from(aiDataPolicies).where(eq(aiDataPolicies.orgId, a.orgId)));
    expect(stored).toHaveLength(0);
  });

  it('PUT of a retention looser than the partner ceiling is a 422', async () => {
    const res = await app().request('/ai/data-policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolOutputRetentionDays: 30 }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'above_partner_ceiling', field: 'toolOutputRetentionDays' });
  });

  it('PUT of a value inside the ceiling still saves', async () => {
    const res = await app().request('/ai/data-policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceFileReadLevel: 'off', toolOutputRetentionDays: 3 }),
    });
    expect(res.status).toBe(200);
    const stored = await withSystemDbAccessContext(() =>
      db.select().from(aiDataPolicies).where(eq(aiDataPolicies.orgId, a.orgId)));
    expect(stored).toHaveLength(1);
    expect(stored[0]!.toolOutputRetentionDays).toBe(3);
  });
});
