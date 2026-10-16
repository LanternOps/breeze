/**
 * ai_data_policies — live RLS, XOR, partner-default SELECT branch, cascade and
 * merge (AI device file read policy, #8852). Policies shipped in
 * 2026-12-29-110000-ai-data-policies.sql. Precedent:
 * aiScriptPoliciesPartnerRls.integration.test.ts.
 *
 * rls-coverage.integration.test.ts proves the policies EXIST; only driving the
 * real driver as `breeze_app` under FORCE RLS proves they enforce anything.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { aiDataPolicies } from '../../db/schema';
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

  it('fails open to defaults when the DB context carries no currentPartnerId (Wave 2 gate must assert it — see ledger ruling)', async () => {
    await seedPartnerCeiling();
    // Context literal built WITHOUT currentPartnerId: the partner SELECT branch cannot match.
    const noPartnerCtx: DbAccessContext = {
      scope: 'organization',
      orgId: a.orgId,
      accessibleOrgIds: [a.orgId],
      accessiblePartnerIds: [],
      userId: null,
    } as DbAccessContext;
    const effective = await withDbAccessContext(noPartnerCtx, () => resolveAiDataPolicy(a.orgId));
    // Pins the current gap: the partner's stricter 'off' is invisible, so the resolver
    // returns the (looser) default. Wave 2 turns this into a fail-closed assertion.
    expect(effective.deviceFileReadLevel).toBe('no_user_profiles');
    expect(effective.source.deviceFileReadLevel).toBe('default');
  });
});
