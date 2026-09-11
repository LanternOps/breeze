/**
 * deliverable_template_sets / deliverable_template_items RLS — dual-axis
 * (org XOR partner) enforcement, branch-FK owner integrity, and the apply
 * fan-out (#5573 W05, CLAUDE.md "Partner-Wide First" step 6).
 *
 * The shipped policies (2026-10-15-170500-deliverable-templates.sql) are:
 *   <table>_isolation            FOR ALL  system OR breeze_has_org_access(org_id)
 *                                        OR breeze_has_partner_access(partner_id)
 *   <table>_partner_wide_select  FOR SELECT  org_id IS NULL
 *                                        AND partner_id = breeze_current_partner_id()
 *
 * The SELECT branch is a separate permissive policy, never an edit to the FOR
 * ALL one: Postgres does not consult FOR SELECT policies when computing
 * UPDATE/DELETE target rows, so it ORs into reads and grants no write.
 *
 * `rls-coverage.integration.test.ts` proves the policies EXIST by reading
 * pg_catalog; it cannot prove either branch enforces anything. This suite
 * drives the real postgres.js driver as `breeze_app` under FORCE RLS, which is
 * the only thing that does.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { deliverableTemplateSets, deliverableTemplateItems, serviceDeliverables, contracts } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner } from './db-utils';
import { applyTemplateSet, type TemplateActor } from '../../services/deliverableTemplateService';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

const createdSetNames: string[] = [];
const createdOrgIds: string[] = [];

afterEach(async () => {
  const names = [...new Set(createdSetNames)];
  const orgIds = [...new Set(createdOrgIds)];
  createdSetNames.length = 0;
  createdOrgIds.length = 0;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (orgIds.length > 0) await db.delete(serviceDeliverables).where(inArray(serviceDeliverables.orgId, orgIds));
    if (names.length > 0) await db.delete(deliverableTemplateSets).where(inArray(deliverableTemplateSets.name, names));
  });
});

/** A partner-scoped session: passes breeze_has_partner_access for its own partner. */
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

/**
 * An org-scoped session. `currentPartnerId` is populated from the token's
 * partnerId for org scope too (buildDbAccessContext) — exactly what the
 * partner-wide SELECT branch keys on. `null` is the degenerate "no partner GUC"
 * caller, kept so the `=` vs `IS NOT DISTINCT FROM` choice stays pinned.
 */
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

/** The DEVICE-TOKEN shape, copied from middleware/agentAuth.ts (#4673 W02). */
function agentContext(orgId: string, devicePartnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: devicePartnerId,
  };
}

function uniqueName(prefix: string): string {
  const name = `${prefix} ${Math.random().toString(36).slice(2, 10)}`;
  createdSetNames.push(name);
  return name;
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

/** Seed under SYSTEM scope, bypassing the policy under test. */
async function seedSet(values: { orgId?: string | null; partnerId?: string | null; name: string }): Promise<string> {
  const rows = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(deliverableTemplateSets)
      .values({ orgId: values.orgId ?? null, partnerId: values.partnerId ?? null, name: values.name })
      .returning({ id: deliverableTemplateSets.id }),
  );
  return rows[0]!.id;
}

async function seedItem(setId: string, owner: { orgId?: string | null; partnerId?: string | null }, name: string, cadence: 'monthly' | 'quarterly' = 'monthly', sortOrder = 0): Promise<string> {
  const rows = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(deliverableTemplateItems)
      .values({ setId, orgId: owner.orgId ?? null, partnerId: owner.partnerId ?? null, name, cadence, sortOrder })
      .returning({ id: deliverableTemplateItems.id }),
  );
  return rows[0]!.id;
}

const countSets = async (ctx: DbAccessContext, setId: string): Promise<number> =>
  withDbAccessContext(ctx, async () => {
    const rows = await db.select({ id: deliverableTemplateSets.id }).from(deliverableTemplateSets)
      .where(eq(deliverableTemplateSets.id, setId));
    return rows.length;
  });

describe('deliverable template RLS (#5573 W05)', () => {
  describe('write policy', () => {
    it('partner scope can INSERT a partner-wide set (org_id NULL, partner_id set)', async () => {
      const partner = await createPartner();
      const rows = await withDbAccessContext(partnerContext(partner.id, []), () =>
        db.insert(deliverableTemplateSets)
          .values({ orgId: null, partnerId: partner.id, name: uniqueName('Best plan') })
          .returning(),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.orgId).toBeNull();
      expect(rows[0]?.partnerId).toBe(partner.id);
    });

    it('refuses a cross-partner forge with 42501', async () => {
      const attacker = await createPartner();
      const victim = await createPartner();
      await expectSqlState(
        () => withDbAccessContext(partnerContext(attacker.id, []), () =>
          db.insert(deliverableTemplateSets)
            .values({ orgId: null, partnerId: victim.id, name: uniqueName('Forged') })
            .returning(),
        ),
        '42501',
      );
    });

    it('refuses a set claiming BOTH owners with 23514 (the XOR check)', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      // Both axes set satisfies the RLS WITH CHECK on the org branch, so the
      // statement reaches the CHECK — this proves the XOR does work RLS does not.
      await expectSqlState(
        () => withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
          db.insert(deliverableTemplateSets)
            .values({ orgId: org.id, partnerId: partner.id, name: uniqueName('Both axes') })
            .returning(),
        ),
        '23514',
      );
    });

    it('refuses an ITEM claiming BOTH owners with 23514', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const setId = await seedSet({ orgId: org.id, name: uniqueName('Org set') });
      await expectSqlState(
        () => withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
          db.insert(deliverableTemplateItems)
            .values({ setId, orgId: org.id, partnerId: partner.id, name: 'x', cadence: 'monthly' })
            .returning(),
        ),
        '23514',
      );
    });

    it('refuses an ownerless set with 42501 (RLS fires before the CHECK)', async () => {
      const partner = await createPartner();
      await expectSqlState(
        () => withDbAccessContext(partnerContext(partner.id, []), () =>
          db.insert(deliverableTemplateSets)
            .values({ orgId: null, partnerId: null, name: uniqueName('Ownerless') })
            .returning(),
        ),
        '42501',
      );
    });
  });

  describe('owner integrity (branch FKs)', () => {
    it('an org-owned item cannot point at a partner-wide set (23503)', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const partnerSet = await seedSet({ partnerId: partner.id, name: uniqueName('Partner set') });
      await expectSqlState(
        () => withDbAccessContext(SYSTEM_CTX, () =>
          db.insert(deliverableTemplateItems)
            .values({ setId: partnerSet, orgId: org.id, partnerId: null, name: 'x', cadence: 'monthly' })
            .returning(),
        ),
        '23503',
      );
    });

    it('a partner-wide item cannot point at an org-owned set (23503)', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const orgSet = await seedSet({ orgId: org.id, name: uniqueName('Org set') });
      await expectSqlState(
        () => withDbAccessContext(SYSTEM_CTX, () =>
          db.insert(deliverableTemplateItems)
            .values({ setId: orgSet, orgId: null, partnerId: partner.id, name: 'x', cadence: 'monthly' })
            .returning(),
        ),
        '23503',
      );
    });

    it('deleting a set cascades its items', async () => {
      const partner = await createPartner();
      const setId = await seedSet({ partnerId: partner.id, name: uniqueName('Cascade set') });
      await seedItem(setId, { partnerId: partner.id }, 'Sign-in log review');
      await withDbAccessContext(SYSTEM_CTX, () =>
        db.delete(deliverableTemplateSets).where(eq(deliverableTemplateSets.id, setId)),
      );
      const left = await withDbAccessContext(SYSTEM_CTX, () =>
        db.select({ id: deliverableTemplateItems.id }).from(deliverableTemplateItems)
          .where(eq(deliverableTemplateItems.setId, setId)),
      );
      expect(left).toHaveLength(0);
    });
  });

  describe('read isolation', () => {
    it('org A cannot read org B\'s set, but reads its own (positive control)', async () => {
      const partner = await createPartner();
      const orgA = await createOrganization({ partnerId: partner.id });
      const orgB = await createOrganization({ partnerId: partner.id });
      const setB = await seedSet({ orgId: orgB.id, name: uniqueName('Org B set') });
      const setA = await seedSet({ orgId: orgA.id, name: uniqueName('Org A set') });

      expect(await countSets(orgContext(orgA.id, partner.id), setB)).toBe(0);
      expect(await countSets(orgContext(orgA.id, partner.id), setA)).toBe(1);
    });

    it('an org token reads its OWN partner\'s partner-wide set through the SELECT branch', async () => {
      const partner = await createPartner();
      const other = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const mine = await seedSet({ partnerId: partner.id, name: uniqueName('Mine') });
      const theirs = await seedSet({ partnerId: other.id, name: uniqueName('Theirs') });

      expect(await countSets(orgContext(org.id, partner.id), mine)).toBe(1);
      expect(await countSets(orgContext(org.id, partner.id), theirs)).toBe(0);
      // NULL GUC: pins `=` over `IS NOT DISTINCT FROM` in the policy.
      expect(await countSets(orgContext(org.id, null), mine)).toBe(0);
    });

    it('the agent/device token reads partner-wide sets and items (the branch is load-bearing there)', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const setId = await seedSet({ partnerId: partner.id, name: uniqueName('Agent visible') });
      await seedItem(setId, { partnerId: partner.id }, 'Sign-in log review');

      expect(await countSets(agentContext(org.id, partner.id), setId)).toBe(1);
      const items = await withDbAccessContext(agentContext(org.id, partner.id), () =>
        db.select({ id: deliverableTemplateItems.id }).from(deliverableTemplateItems)
          .where(eq(deliverableTemplateItems.setId, setId)),
      );
      expect(items).toHaveLength(1);
    });

    it('a visible partner-wide set is still NOT writable from an org context', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const setId = await seedSet({ partnerId: partner.id, name: uniqueName('Read only here') });

      const updated = await withDbAccessContext(orgContext(org.id, partner.id), () =>
        db.update(deliverableTemplateSets).set({ description: 'hijacked' })
          .where(eq(deliverableTemplateSets.id, setId))
          .returning({ id: deliverableTemplateSets.id }),
      );
      expect(updated).toHaveLength(0);

      const deleted = await withDbAccessContext(orgContext(org.id, partner.id), () =>
        db.delete(deliverableTemplateSets).where(eq(deliverableTemplateSets.id, setId))
          .returning({ id: deliverableTemplateSets.id }),
      );
      expect(deleted).toHaveLength(0);

      await expectSqlState(
        () => withDbAccessContext(orgContext(org.id, partner.id), () =>
          db.insert(deliverableTemplateSets)
            .values({ orgId: null, partnerId: partner.id, name: uniqueName('Org forged partner-wide') })
            .returning(),
        ),
        '42501',
      );

      // The row survived every attempt.
      expect(await countSets(SYSTEM_CTX, setId)).toBe(1);
    });
  });

  describe('apply fan-out', () => {
    it('applies a partner-wide set into ONE org, with the spec anchors, and 409s on re-apply', async () => {
      const partner = await createPartner();
      const orgA = await createOrganization({ partnerId: partner.id });
      const orgB = await createOrganization({ partnerId: partner.id });
      createdOrgIds.push(orgA.id, orgB.id);

      const setId = await seedSet({ partnerId: partner.id, name: uniqueName('Best plan') });
      // Distinct sortOrder: apply order is (sort_order, name), which is what
      // the anchor assertions below depend on.
      await seedItem(setId, { partnerId: partner.id }, 'Sign-in log review', 'monthly', 0);
      await seedItem(setId, { partnerId: partner.id }, 'Firewall rule review', 'quarterly', 1);

      const actor: TemplateActor = {
        userId: null, scope: 'partner', partnerId: partner.id,
        partnerOrgAccess: 'all', accessibleOrgIds: [orgA.id, orgB.id],
      };

      const result = await withDbAccessContext(partnerContext(partner.id, [orgA.id, orgB.id]), () =>
        applyTemplateSet(orgA.id, setId, { effectiveFrom: '2026-10-01' }, actor),
      );
      expect(result.created.map((c) => c.name)).toEqual(['Sign-in log review', 'Firewall rule review']);
      expect(result.created.map((c) => c.anchorDueDate)).toEqual(['2026-10-31', '2026-12-31']);

      const inA = await withDbAccessContext(SYSTEM_CTX, () =>
        db.select({ name: serviceDeliverables.name, anchor: serviceDeliverables.anchorDueDate })
          .from(serviceDeliverables).where(eq(serviceDeliverables.orgId, orgA.id)),
      );
      expect(inA).toHaveLength(2);
      expect(inA.map((d) => d.anchor).sort()).toEqual(['2026-10-31', '2026-12-31']);

      const inB = await withDbAccessContext(SYSTEM_CTX, () =>
        db.select({ id: serviceDeliverables.id }).from(serviceDeliverables)
          .where(eq(serviceDeliverables.orgId, orgB.id)),
      );
      expect(inB).toHaveLength(0);

      // Re-applying writes nothing and names every collision.
      await expect(
        withDbAccessContext(partnerContext(partner.id, [orgA.id, orgB.id]), () =>
          applyTemplateSet(orgA.id, setId, { effectiveFrom: '2026-10-01' }, actor),
        ),
      ).rejects.toMatchObject({
        status: 409,
        code: 'TEMPLATE_NAME_COLLISION',
        details: { collisions: expect.arrayContaining(['Sign-in log review', 'Firewall rule review']) },
      });

      const stillTwo = await withDbAccessContext(SYSTEM_CTX, () =>
        db.select({ id: serviceDeliverables.id }).from(serviceDeliverables)
          .where(eq(serviceDeliverables.orgId, orgA.id)),
      );
      expect(stillTwo).toHaveLength(2);
    });

    it('a contract from another org aborts the apply before ANY deliverable is written', async () => {
      const partner = await createPartner();
      const orgA = await createOrganization({ partnerId: partner.id });
      const orgB = await createOrganization({ partnerId: partner.id });
      createdOrgIds.push(orgA.id, orgB.id);

      const setId = await seedSet({ partnerId: partner.id, name: uniqueName('Guarded') });
      await seedItem(setId, { partnerId: partner.id }, 'First item', 'monthly');
      await seedItem(setId, { partnerId: partner.id }, 'Second item', 'monthly');

      const [contractB] = await withDbAccessContext(SYSTEM_CTX, () =>
        db.insert(contracts).values({
          orgId: orgB.id, partnerId: partner.id, name: 'Other org contract',
          startDate: '2026-10-01', status: 'active', intervalMonths: 1, currencyCode: 'USD',
        }).returning({ id: contracts.id }),
      );

      const actor: TemplateActor = {
        userId: null, scope: 'partner', partnerId: partner.id,
        partnerOrgAccess: 'all', accessibleOrgIds: [orgA.id, orgB.id],
      };

      await expect(
        withDbAccessContext(partnerContext(partner.id, [orgA.id, orgB.id]), () =>
          applyTemplateSet(orgA.id, setId, { contractId: contractB!.id, effectiveFrom: '2026-10-01' }, actor),
        ),
      ).rejects.toMatchObject({ status: 400, code: 'CONTRACT_NOT_IN_ORG' });

      const rows = await withDbAccessContext(SYSTEM_CTX, () =>
        db.select({ id: serviceDeliverables.id }).from(serviceDeliverables)
          .where(eq(serviceDeliverables.orgId, orgA.id)),
      );
      expect(rows).toHaveLength(0);
    });

    it('a 409 inside the request transaction still commits as a 409, not a 500', async () => {
      // Regression guard: a 23505 raised inside withDbAccessContext's own
      // transaction poisons it and the mapped 409 becomes a 500 at commit
      // unless the write runs in a SAVEPOINT. Proven by doing real work in the
      // SAME context after the caught error.
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      createdOrgIds.push(org.id);
      const name = uniqueName('Dup set');
      await seedSet({ partnerId: partner.id, name });

      await withDbAccessContext(partnerContext(partner.id, [org.id]), async () => {
        const { createTemplateSet } = await import('../../services/deliverableTemplateService');
        await expect(
          createTemplateSet({ ownerScope: 'partner', name, items: [] }, {
            userId: null, scope: 'partner', partnerId: partner.id,
            partnerOrgAccess: 'all', accessibleOrgIds: [org.id],
          }),
        ).rejects.toMatchObject({ status: 409, code: 'DUPLICATE_TEMPLATE_SET_NAME' });

        // The transaction is still usable — this is the whole point.
        const rows = await db.select({ one: sql<number>`1` }).from(deliverableTemplateSets)
          .where(and(eq(deliverableTemplateSets.name, name), isNull(deliverableTemplateSets.orgId)));
        expect(rows).toHaveLength(1);
      });
    });
  });
});
