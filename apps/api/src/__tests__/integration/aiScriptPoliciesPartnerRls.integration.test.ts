/**
 * ai_script_policies / ai_script_lane_state — live RLS, XOR, partner-wide
 * SELECT branch, cascade, and merge (#5612 W04, CLAUDE.md "Partner-Wide
 * First" step 6 and "Tenant Isolation" step 6).
 *
 * The shipped policies (2026-10-16-120200-ai-script-policies.sql) are:
 *   ai_script_policies_isolation            FOR ALL  system OR breeze_has_org_access(org_id)
 *                                                    OR breeze_has_partner_access(partner_id)
 *   ai_script_policies_partner_wide_select  FOR SELECT  org_id IS NULL
 *                                                    AND partner_id = breeze_current_partner_id()
 *   ai_script_lane_state_{select,insert,update,delete}  breeze_has_org_access(org_id)
 *
 * `rls-coverage.integration.test.ts` proves the policies EXIST by reading
 * pg_catalog; it cannot prove either branch enforces anything. This suite
 * drives the real postgres.js driver as `breeze_app` under FORCE RLS, which is
 * the only thing that does.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { aiScriptLaneState, aiScriptPolicies, organizations } from '../../db/schema';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import { executeOrgMerge } from '../../services/orgMerge';
import { resolveEffectiveScriptPolicy } from '../../services/scriptProposals/policy';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner, createUser } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

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

/** Org-scoped session. `currentPartnerId` is what the partner-wide SELECT branch keys on. */
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
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (partnerIds.length > 0) await db.delete(aiScriptPolicies).where(inArray(aiScriptPolicies.partnerId, partnerIds));
    if (orgIds.length > 0) {
      await db.delete(aiScriptPolicies).where(inArray(aiScriptPolicies.orgId, orgIds));
      await db.delete(aiScriptLaneState).where(inArray(aiScriptLaneState.orgId, orgIds));
    }
  });
});

async function fixture() {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const orgB = await createOrganization({ partnerId: partnerB.id });
  createdPartnerIds.push(partnerA.id, partnerB.id);
  createdOrgIds.push(orgA.id, orgB.id);
  return { partnerA: partnerA.id, partnerB: partnerB.id, orgA: orgA.id, orgB: orgB.id };
}

const seedPartnerCeiling = (partnerId: string, over: Partial<typeof aiScriptPolicies.$inferInsert> = {}) =>
  withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(aiScriptPolicies).values({ partnerId, orgId: null, unattendedAllowed: true, ...over }).returning({ id: aiScriptPolicies.id }),
  );
const seedOrgGrant = (orgId: string, over: Partial<typeof aiScriptPolicies.$inferInsert> = {}) =>
  withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(aiScriptPolicies).values({ orgId, partnerId: null, unattendedEnabled: true, ...over }).returning({ id: aiScriptPolicies.id }),
  );

describe('ai_script_policies RLS (#5612 W04)', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    f = await fixture();
  });

  describe('write policy — forges', () => {
    it('FORGE: org B cannot insert a GRANT row for org A (42501)', async () => {
      await expectSqlState(
        () => withDbAccessContext(orgContext(f.orgB, f.partnerB), () =>
          db.insert(aiScriptPolicies).values({ orgId: f.orgA, partnerId: null }).returning()),
        '42501',
      );
    });

    it('FORGE: an ORG token cannot insert a PARTNER-wide row for its own partner (the SELECT branch grants no write)', async () => {
      await expectSqlState(
        () => withDbAccessContext(orgContext(f.orgA, f.partnerA), () =>
          db.insert(aiScriptPolicies).values({ orgId: null, partnerId: f.partnerA }).returning()),
        '42501',
      );
    });

    it('FORGE: partner B cannot insert a ceiling for partner A (42501)', async () => {
      await expectSqlState(
        () => withDbAccessContext(partnerContext(f.partnerB, []), () =>
          db.insert(aiScriptPolicies).values({ orgId: null, partnerId: f.partnerA }).returning()),
        '42501',
      );
    });

    it('partner scope CAN insert its own ceiling; org scope CAN insert its own grant', async () => {
      const [ceiling] = await withDbAccessContext(partnerContext(f.partnerA, []), () =>
        db.insert(aiScriptPolicies).values({ orgId: null, partnerId: f.partnerA, unattendedAllowed: true }).returning());
      expect(ceiling?.partnerId).toBe(f.partnerA);
      const [grant] = await withDbAccessContext(orgContext(f.orgA, f.partnerA), () =>
        db.insert(aiScriptPolicies).values({ orgId: f.orgA, partnerId: null }).returning());
      expect(grant?.orgId).toBe(f.orgA);
    });
  });

  describe('CHECK constraints (23514) — reached under system scope so RLS cannot mask them', () => {
    it('XOR: both axes set', async () => {
      await expectSqlState(
        () => withDbAccessContext(SYSTEM_CTX, () =>
          db.insert(aiScriptPolicies).values({ orgId: f.orgA, partnerId: f.partnerA }).returning()),
        '23514',
      );
    });

    it('XOR: neither axis set', async () => {
      await expectSqlState(
        () => withDbAccessContext(SYSTEM_CTX, () =>
          db.insert(aiScriptPolicies).values({ orgId: null, partnerId: null }).returning()),
        '23514',
      );
    });

    it('an org row cannot carry unattended_allowed (that is a partner ceiling)', async () => {
      await expectSqlState(
        () => withDbAccessContext(SYSTEM_CTX, () =>
          db.insert(aiScriptPolicies).values({ orgId: f.orgA, partnerId: null, unattendedAllowed: true }).returning()),
        '23514',
      );
    });

    it('a partner row cannot carry unattended_enabled (that is an org grant)', async () => {
      await expectSqlState(
        () => withDbAccessContext(SYSTEM_CTX, () =>
          db.insert(aiScriptPolicies).values({ orgId: null, partnerId: f.partnerA, unattendedEnabled: true }).returning()),
        '23514',
      );
    });

    it('high/critical is not a storable ceiling', async () => {
      await expectSqlState(
        () => withDbAccessContext(SYSTEM_CTX, () =>
          db.execute(sql`insert into ai_script_policies (partner_id, max_unattended_risk_tier) values (${f.partnerA}, 'high')`)),
        '23514',
      );
    });

    it('an unknown touch class is not storable', async () => {
      await expectSqlState(
        () => withDbAccessContext(SYSTEM_CTX, () =>
          db.execute(sql`insert into ai_script_policies (partner_id, unattended_allowed_classes) values (${f.partnerA}, ARRAY['not_a_class']::text[])`)),
        '23514',
      );
    });

    it('per-hour outside 0..100 is not storable', async () => {
      await expectSqlState(
        () => withDbAccessContext(SYSTEM_CTX, () =>
          db.insert(aiScriptPolicies).values({ orgId: null, partnerId: f.partnerA, maxUnattendedPerHour: 101 }).returning()),
        '23514',
      );
    });

    it('one row per owner (partial uniques)', async () => {
      await seedOrgGrant(f.orgA);
      await expectSqlState(() => seedOrgGrant(f.orgA), '23505');
      await seedPartnerCeiling(f.partnerA);
      await expectSqlState(() => seedPartnerCeiling(f.partnerA), '23505');
    });
  });

  describe('partner-wide SELECT branch', () => {
    it("an ORG token sees its own partner's ceiling row", async () => {
      await seedPartnerCeiling(f.partnerA);
      const rows = await withDbAccessContext(orgContext(f.orgA, f.partnerA), () =>
        db.select({ id: aiScriptPolicies.id }).from(aiScriptPolicies).where(isNull(aiScriptPolicies.orgId)));
      expect(rows).toHaveLength(1);
    });

    it('an org under a DIFFERENT partner sees nothing', async () => {
      await seedPartnerCeiling(f.partnerA);
      const rows = await withDbAccessContext(orgContext(f.orgB, f.partnerB), () =>
        db.select({ id: aiScriptPolicies.id }).from(aiScriptPolicies).where(isNull(aiScriptPolicies.orgId)));
      expect(rows).toHaveLength(0);
    });

    it('a caller with NO partner GUC sees nothing (= not IS NOT DISTINCT FROM)', async () => {
      await seedPartnerCeiling(f.partnerA);
      const rows = await withDbAccessContext(orgContext(f.orgA, null), () =>
        db.select({ id: aiScriptPolicies.id }).from(aiScriptPolicies).where(isNull(aiScriptPolicies.orgId)));
      expect(rows).toHaveLength(0);
    });

    it('is READ ONLY: an org token UPDATE of the ceiling matches zero rows', async () => {
      await seedPartnerCeiling(f.partnerA);
      const res = await withDbAccessContext(orgContext(f.orgA, f.partnerA), () =>
        db.update(aiScriptPolicies).set({ unattendedAllowed: false }).where(isNull(aiScriptPolicies.orgId)).returning({ id: aiScriptPolicies.id }));
      expect(res).toHaveLength(0);
      const [still] = await withDbAccessContext(SYSTEM_CTX, () =>
        db.select({ unattendedAllowed: aiScriptPolicies.unattendedAllowed }).from(aiScriptPolicies).where(eq(aiScriptPolicies.partnerId, f.partnerA)));
      expect(still?.unattendedAllowed).toBe(true);
    });

    it('is READ ONLY: an org token DELETE of the ceiling matches zero rows', async () => {
      await seedPartnerCeiling(f.partnerA);
      const res = await withDbAccessContext(orgContext(f.orgA, f.partnerA), () =>
        db.delete(aiScriptPolicies).where(isNull(aiScriptPolicies.orgId)).returning({ id: aiScriptPolicies.id }));
      expect(res).toHaveLength(0);
    });

    it('resolveEffectiveScriptPolicy reads BOTH rows from an ORG context without escalation', async () => {
      await seedPartnerCeiling(f.partnerA, { maxUnattendedRiskTier: 'medium', maxUnattendedPerHour: 6 });
      await seedOrgGrant(f.orgA, { maxUnattendedPerHour: 3 });
      const effective = await withDbAccessContext(orgContext(f.orgA, f.partnerA), () => resolveEffectiveScriptPolicy(f.orgA));
      expect(effective.unattendedEnabled).toBe(true);
      expect(effective.maxUnattendedPerHour).toBe(3);
      expect(effective.source.partnerRowId).not.toBeNull();
      expect(effective.source.orgRowId).not.toBeNull();
      // A sibling org under the SAME partner: sees the ceiling, has no grant → off.
      const sibling = await createOrganization({ partnerId: f.partnerA });
      createdOrgIds.push(sibling.id);
      const siblingEffective = await withDbAccessContext(orgContext(sibling.id, f.partnerA), () => resolveEffectiveScriptPolicy(sibling.id));
      expect(siblingEffective.unattendedEnabled).toBe(false);
      expect(siblingEffective.source.partnerRowId).not.toBeNull();
    });
  });

  describe('ai_script_lane_state (shape 1)', () => {
    it("FORGE: org B cannot read or write org A's lane state", async () => {
      await withDbAccessContext(SYSTEM_CTX, () => db.insert(aiScriptLaneState).values({ orgId: f.orgA, state: 'open' }));
      const rows = await withDbAccessContext(orgContext(f.orgB, f.partnerB), () =>
        db.select({ orgId: aiScriptLaneState.orgId }).from(aiScriptLaneState));
      expect(rows).toHaveLength(0);
      await expectSqlState(
        () => withDbAccessContext(orgContext(f.orgB, f.partnerB), () =>
          db.insert(aiScriptLaneState).values({ orgId: f.orgA }).returning()),
        '42501',
      );
      const updated = await withDbAccessContext(orgContext(f.orgB, f.partnerB), () =>
        db.update(aiScriptLaneState).set({ state: 'closed' }).where(eq(aiScriptLaneState.orgId, f.orgA)).returning({ orgId: aiScriptLaneState.orgId }));
      expect(updated).toHaveLength(0);
    });

    it('state is a closed set', async () => {
      await expectSqlState(
        () => withDbAccessContext(SYSTEM_CTX, () =>
          db.execute(sql`insert into ai_script_lane_state (org_id, state) values (${f.orgA}, 'half_open')`)),
        '23514',
      );
    });
  });

  describe('cascade and merge', () => {
    it('CASCADE: erasing the org removes its grant row and its lane state, and leaves the partner ceiling', async () => {
      const actor = await createUser({ partnerId: f.partnerA, orgId: f.orgA, email: `erase-${Date.now()}@lane.test` });
      await seedPartnerCeiling(f.partnerA);
      await seedOrgGrant(f.orgA);
      await withDbAccessContext(SYSTEM_CTX, () => db.insert(aiScriptLaneState).values({ orgId: f.orgA }));

      const stats = await cascadeDeleteOrg(f.orgA, actor.id, actor.email);
      expect(stats.tablesDeleted.ai_script_policies).toBe(1);
      expect(stats.tablesDeleted.ai_script_lane_state).toBe(1);

      await withDbAccessContext(SYSTEM_CTX, async () => {
        expect(await db.select().from(aiScriptPolicies).where(eq(aiScriptPolicies.orgId, f.orgA))).toHaveLength(0);
        expect(await db.select().from(aiScriptLaneState).where(eq(aiScriptLaneState.orgId, f.orgA))).toHaveLength(0);
        expect(await db.select().from(aiScriptPolicies).where(eq(aiScriptPolicies.partnerId, f.partnerA))).toHaveLength(1);
        expect(await db.select().from(organizations).where(eq(organizations.id, f.orgA))).toHaveLength(0);
      });
    });

    it("MERGE: the loser's grant row repoints to a survivor with none; lane state is left for erasure", async () => {
      const prior = process.env.ORG_MERGE_FENCE_DRAIN_MS;
      process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
      try {
        const survivor = await createOrganization({ partnerId: f.partnerA });
        createdOrgIds.push(survivor.id);
        const actor = await createUser({ partnerId: f.partnerA, email: `merge-${Date.now()}@lane.test` });
        await seedOrgGrant(f.orgA, { maxUnattendedPerHour: 9 });
        await withDbAccessContext(SYSTEM_CTX, () =>
          db.insert(aiScriptLaneState).values({ orgId: f.orgA, consecutiveFailedVerifications: 1 }));

        const result = await executeOrgMerge({
          loserOrgId: f.orgA, survivorOrgId: survivor.id, partnerId: f.partnerA,
          performedBy: actor.id, performedByEmail: actor.email,
        });
        expect(result.tables.ai_script_policies).toEqual({ moved: 1, dropped: 0 });

        await withSystemDbAccessContext(async () => {
          const rows = await db.select().from(aiScriptPolicies).where(eq(aiScriptPolicies.orgId, survivor.id));
          expect(rows).toHaveLength(1);
          expect(rows[0]!.maxUnattendedPerHour).toBe(9);
          expect(await db.select().from(aiScriptLaneState).where(eq(aiScriptLaneState.orgId, survivor.id))).toHaveLength(0);
        });
      } finally {
        if (prior === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
        else process.env.ORG_MERGE_FENCE_DRAIN_MS = prior;
      }
    });

    it("MERGE: a survivor that ALREADY has a grant keeps its own; the loser's is dropped (keep-survivor)", async () => {
      const prior = process.env.ORG_MERGE_FENCE_DRAIN_MS;
      process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
      try {
        const survivor = await createOrganization({ partnerId: f.partnerA });
        createdOrgIds.push(survivor.id);
        const actor = await createUser({ partnerId: f.partnerA, email: `merge2-${Date.now()}@lane.test` });
        await seedOrgGrant(survivor.id, { maxUnattendedPerHour: 2 });
        await seedOrgGrant(f.orgA, { maxUnattendedPerHour: 9 });

        const result = await executeOrgMerge({
          loserOrgId: f.orgA, survivorOrgId: survivor.id, partnerId: f.partnerA,
          performedBy: actor.id, performedByEmail: actor.email,
        });
        expect(result.tables.ai_script_policies).toEqual({ moved: 0, dropped: 1 });

        const rows = await withSystemDbAccessContext(() =>
          db.select().from(aiScriptPolicies).where(and(eq(aiScriptPolicies.orgId, survivor.id))));
        expect(rows).toHaveLength(1);
        expect(rows[0]!.maxUnattendedPerHour).toBe(2);
      } finally {
        if (prior === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
        else process.env.ORG_MERGE_FENCE_DRAIN_MS = prior;
      }
    });
  });
});
