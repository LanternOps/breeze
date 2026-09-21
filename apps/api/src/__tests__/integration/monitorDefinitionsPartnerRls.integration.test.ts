/**
 * monitor_definitions / config_policy_monitors — live RLS, XOR ownership, the
 * partner-wide SELECT branch and the attachment-compatibility trigger
 * (#5287 W02, CLAUDE.md "Partner-Wide First" step 6).
 *
 * Shipped by 2026-10-16-160300-monitor-definitions.sql:
 *   monitor_definitions_isolation             FOR ALL     system OR breeze_has_org_access(org_id)
 *                                                         OR breeze_has_partner_access(partner_id)
 *   monitor_definitions_partner_wide_select   FOR SELECT  org_id IS NULL
 *                                                         AND partner_id = breeze_current_partner_id()
 *   config_policy_monitors_isolation          FOR ALL     join through configuration_policies
 *   config_policy_monitors_compat_trg         DEFERRED constraint trigger, 23514
 *
 * rls-coverage.integration.test.ts proves those policies EXIST by reading
 * pg_catalog. It cannot prove any of them enforces anything: only driving the
 * real postgres.js connection as `breeze_app` under FORCE RLS does that, which
 * is what this suite is for.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  configPolicyFeatureLinks,
  configPolicyMonitors,
  configurationPolicies,
  monitorDefinitions,
} from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner } from './db-utils';

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

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<unknown> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  expect(pgErrorCode(raised)).toBe(code);
  return raised;
}

const createdPartnerIds: string[] = [];
const createdOrgIds: string[] = [];

afterEach(async () => {
  const partnerIds = [...new Set(createdPartnerIds)];
  const orgIds = [...new Set(createdOrgIds)];
  createdPartnerIds.length = 0;
  createdOrgIds.length = 0;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (orgIds.length > 0) {
      await db.delete(configurationPolicies).where(inArray(configurationPolicies.orgId, orgIds));
      await db.delete(monitorDefinitions).where(inArray(monitorDefinitions.orgId, orgIds));
    }
    if (partnerIds.length > 0) {
      await db
        .delete(configurationPolicies)
        .where(inArray(configurationPolicies.partnerId, partnerIds));
      await db.delete(monitorDefinitions).where(inArray(monitorDefinitions.partnerId, partnerIds));
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

const CPU_CONDITION = { operator: 'gt', value: 90 };

function monitorValues(over: Partial<typeof monitorDefinitions.$inferInsert>) {
  return {
    name: `monitor-${Math.random().toString(36).slice(2, 10)}`,
    kind: 'cpu' as const,
    condition: CPU_CONDITION,
    severity: 'high' as const,
    ...over,
  };
}

const seedPartnerWide = (partnerId: string) =>
  withDbAccessContext(SYSTEM_CTX, () =>
    db
      .insert(monitorDefinitions)
      .values(monitorValues({ partnerId, orgId: null }))
      .returning({ id: monitorDefinitions.id }),
  );

const seedOrgOwned = (orgId: string) =>
  withDbAccessContext(SYSTEM_CTX, () =>
    db
      .insert(monitorDefinitions)
      .values(monitorValues({ orgId, partnerId: null }))
      .returning({ id: monitorDefinitions.id }),
  );

/** A configuration policy plus its `monitors` feature link, seeded as system. */
async function seedPolicyWithLink(owner: { orgId?: string; partnerId?: string }) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const [policy] = await db
      .insert(configurationPolicies)
      .values({
        orgId: owner.orgId ?? null,
        partnerId: owner.partnerId ?? null,
        name: `policy-${Math.random().toString(36).slice(2, 10)}`,
        status: 'active',
      })
      .returning({ id: configurationPolicies.id });
    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policy!.id, featureType: 'monitors' })
      .returning({ id: configPolicyFeatureLinks.id });
    return { policyId: policy!.id, linkId: link!.id };
  });
}

describe('monitor_definitions RLS — dual-axis (#5289)', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    f = await fixture();
  });

  describe('write policy — forges', () => {
    it('partner A can insert its own partner-wide definition', async () => {
      const rows = await withDbAccessContext(partnerContext(f.partnerA, [f.orgA]), () =>
        db
          .insert(monitorDefinitions)
          .values(monitorValues({ partnerId: f.partnerA, orgId: null }))
          .returning({ id: monitorDefinitions.id }),
      );
      expect(rows).toHaveLength(1);
    });

    it('FORGE: partner B cannot insert a partner-wide definition for partner A (42501)', async () => {
      await expectSqlState(
        () =>
          withDbAccessContext(partnerContext(f.partnerB, [f.orgB]), () =>
            db
              .insert(monitorDefinitions)
              .values(monitorValues({ partnerId: f.partnerA, orgId: null }))
              .returning(),
          ),
        '42501',
      );
    });

    it('org A can insert its OWN org-owned definition (positive control for the forge below)', async () => {
      // Without this, a policy change that denied EVERY org-scoped insert would
      // still leave the cross-org forge passing — for the wrong reason.
      const rows = await withDbAccessContext(orgContext(f.orgA, f.partnerA), () =>
        db
          .insert(monitorDefinitions)
          .values(monitorValues({ orgId: f.orgA, partnerId: null }))
          .returning({ id: monitorDefinitions.id }),
      );
      expect(rows).toHaveLength(1);
    });

    it('FORGE: org B cannot insert an org-owned definition for org A (42501)', async () => {
      await expectSqlState(
        () =>
          withDbAccessContext(orgContext(f.orgB, f.partnerB), () =>
            db
              .insert(monitorDefinitions)
              .values(monitorValues({ orgId: f.orgA, partnerId: null }))
              .returning(),
          ),
        '42501',
      );
    });

    it('FORGE: an ORG token cannot insert a partner-wide row for its OWN partner — the SELECT branch grants no write (42501)', async () => {
      await expectSqlState(
        () =>
          withDbAccessContext(orgContext(f.orgA, f.partnerA), () =>
            db
              .insert(monitorDefinitions)
              .values(monitorValues({ orgId: null, partnerId: f.partnerA }))
              .returning(),
          ),
        '42501',
      );
    });

    it('FORGE: an ORG token cannot UPDATE its own partner-wide row it can read (42501 or zero rows)', async () => {
      const [seeded] = await seedPartnerWide(f.partnerA);
      const updated = await withDbAccessContext(orgContext(f.orgA, f.partnerA), () =>
        db
          .update(monitorDefinitions)
          .set({ name: 'hijacked' })
          .where(eq(monitorDefinitions.id, seeded!.id))
          .returning({ id: monitorDefinitions.id }),
      );
      // UPDATE row targeting never consults a FOR SELECT policy, so the row is
      // simply invisible to the UPDATE and nothing is written.
      expect(updated).toHaveLength(0);
    });

    it('FORGE: an ORG token cannot DELETE its own partner-wide row it can read', async () => {
      const [seeded] = await seedPartnerWide(f.partnerA);
      const deleted = await withDbAccessContext(orgContext(f.orgA, f.partnerA), () =>
        db
          .delete(monitorDefinitions)
          .where(eq(monitorDefinitions.id, seeded!.id))
          .returning({ id: monitorDefinitions.id }),
      );
      expect(deleted).toHaveLength(0);
      const survivors = await withDbAccessContext(SYSTEM_CTX, () =>
        db.select().from(monitorDefinitions).where(eq(monitorDefinitions.id, seeded!.id)),
      );
      expect(survivors).toHaveLength(1);
    });
  });

  describe('XOR ownership', () => {
    it('both axes set → 23514', async () => {
      await expectSqlState(
        () =>
          withDbAccessContext(SYSTEM_CTX, () =>
            db
              .insert(monitorDefinitions)
              .values(monitorValues({ orgId: f.orgA, partnerId: f.partnerA }))
              .returning(),
          ),
        '23514',
      );
    });

    it('neither axis set → 23514', async () => {
      await expectSqlState(
        () =>
          withDbAccessContext(SYSTEM_CTX, () =>
            db
              .insert(monitorDefinitions)
              .values(monitorValues({ orgId: null, partnerId: null }))
              .returning(),
          ),
        '23514',
      );
    });
  });

  describe('partner-wide SELECT branch', () => {
    it('an ORG session sees its OWN partner\'s partner-wide definitions', async () => {
      const [seeded] = await seedPartnerWide(f.partnerA);
      const rows = await withDbAccessContext(orgContext(f.orgA, f.partnerA), () =>
        db.select().from(monitorDefinitions).where(eq(monitorDefinitions.id, seeded!.id)),
      );
      expect(rows).toHaveLength(1);
    });

    it('an ORG session under a DIFFERENT partner sees nothing', async () => {
      const [seeded] = await seedPartnerWide(f.partnerA);
      const rows = await withDbAccessContext(orgContext(f.orgB, f.partnerB), () =>
        db.select().from(monitorDefinitions).where(eq(monitorDefinitions.id, seeded!.id)),
      );
      expect(rows).toHaveLength(0);
    });

    it('a session with NO current partner (unset GUC) sees nothing — `=` never matches NULL', async () => {
      const [seeded] = await seedPartnerWide(f.partnerA);
      const rows = await withDbAccessContext(orgContext(f.orgA, null), () =>
        db.select().from(monitorDefinitions).where(eq(monitorDefinitions.id, seeded!.id)),
      );
      expect(rows).toHaveLength(0);
    });

    it('org isolation still holds for ORG-owned definitions', async () => {
      const [seeded] = await seedOrgOwned(f.orgA);
      const rows = await withDbAccessContext(orgContext(f.orgB, f.partnerB), () =>
        db.select().from(monitorDefinitions).where(eq(monitorDefinitions.id, seeded!.id)),
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe('attachment compatibility trigger', () => {
    it('a partner-wide monitor attaches to a policy owned by an org UNDER that partner', async () => {
      const [monitor] = await seedPartnerWide(f.partnerA);
      const { linkId } = await seedPolicyWithLink({ orgId: f.orgA });
      const rows = await withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(configPolicyMonitors)
          .values({ featureLinkId: linkId, monitorId: monitor!.id })
          .returning({ id: configPolicyMonitors.id }),
      );
      expect(rows).toHaveLength(1);
    });

    it('a partner A monitor CANNOT attach to a policy owned by an org under partner B (23514, config_policy_monitors_compat)', async () => {
      const [monitor] = await seedPartnerWide(f.partnerA);
      const { linkId } = await seedPolicyWithLink({ orgId: f.orgB });
      // The trigger is DEFERRABLE INITIALLY DEFERRED, so it fires at COMMIT —
      // the insert statement itself "succeeds" and the transaction then aborts.
      const raised = await expectSqlState(
        () =>
          withDbAccessContext(SYSTEM_CTX, () =>
            db
              .insert(configPolicyMonitors)
              .values({ featureLinkId: linkId, monitorId: monitor!.id })
              .returning(),
          ),
        '23514',
      );
      expect(String((raised as { message?: string }).message)).toContain('owner mismatch');
    });

    it('an ORG-owned monitor CANNOT attach to another org\'s policy (23514)', async () => {
      const [monitor] = await seedOrgOwned(f.orgA);
      const { linkId } = await seedPolicyWithLink({ orgId: f.orgB });
      await expectSqlState(
        () =>
          withDbAccessContext(SYSTEM_CTX, () =>
            db
              .insert(configPolicyMonitors)
              .values({ featureLinkId: linkId, monitorId: monitor!.id })
              .returning(),
          ),
        '23514',
      );
    });

    it('a partner-wide monitor attaches to its own partner-wide policy', async () => {
      const [monitor] = await seedPartnerWide(f.partnerA);
      const { linkId } = await seedPolicyWithLink({ partnerId: f.partnerA });
      const rows = await withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(configPolicyMonitors)
          .values({ featureLinkId: linkId, monitorId: monitor!.id })
          .returning({ id: configPolicyMonitors.id }),
      );
      expect(rows).toHaveLength(1);
    });

    it('an org-owned monitor CANNOT attach to a PARTNER-wide policy (a partner-wide policy applies to every org)', async () => {
      const [monitor] = await seedOrgOwned(f.orgA);
      const { linkId } = await seedPolicyWithLink({ partnerId: f.partnerA });
      await expectSqlState(
        () =>
          withDbAccessContext(SYSTEM_CTX, () =>
            db
              .insert(configPolicyMonitors)
              .values({ featureLinkId: linkId, monitorId: monitor!.id })
              .returning(),
          ),
        '23514',
      );
    });
  });

  describe('cascade', () => {
    it('deleting a definition removes its policy attachments', async () => {
      const [monitor] = await seedOrgOwned(f.orgA);
      const { linkId } = await seedPolicyWithLink({ orgId: f.orgA });
      await withDbAccessContext(SYSTEM_CTX, () =>
        db.insert(configPolicyMonitors).values({ featureLinkId: linkId, monitorId: monitor!.id }),
      );
      await withDbAccessContext(SYSTEM_CTX, () =>
        db.delete(monitorDefinitions).where(eq(monitorDefinitions.id, monitor!.id)),
      );
      const left = await withDbAccessContext(SYSTEM_CTX, () =>
        db
          .select()
          .from(configPolicyMonitors)
          .where(
            and(eq(configPolicyMonitors.monitorId, monitor!.id), isNull(configPolicyMonitors.overrides)),
          ),
      );
      expect(left).toHaveLength(0);
    });
  });
});

// D7: a NULL creator denotes the system actor, including conversion sweeps.
it('allows monitor definitions to omit the system actor FK', async () => {
  const columns = await withDbAccessContext(SYSTEM_CTX, () => db.execute<{ is_nullable: string }>(sql`
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'monitor_definitions'
      AND column_name = 'created_by'
  `));
  expect([...columns]).toEqual([{ is_nullable: 'YES' }]);
});
