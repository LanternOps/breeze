/**
 * cis_baselines RLS — dual-axis (org OR partner) enforcement, epic #2135.
 *
 * Migration under test: 2026-08-10-cis-baselines-partner-ownership.sql.
 *
 * A CIS baseline is owned by EITHER an org (org_id set, partner_id NULL — the
 * original shape) OR a partner (partner_id set, org_id NULL — one benchmark
 * applied across every org the MSP manages). The write policy is:
 *   system OR (org_id IS NOT NULL AND breeze_has_org_access(org_id))
 *          OR (partner_id IS NOT NULL AND breeze_has_partner_access(partner_id))
 *
 * plus a SELECT-ONLY branch (cis_baselines_partner_wide_select):
 *   org_id IS NULL AND partner_id = breeze_current_partner_id()
 *
 * The rls-coverage contract test does NOT prove either branch functionally, so
 * this suite through the REAL postgres.js driver (breeze_app, FORCE RLS) is the
 * required guard.
 *
 * Two things here are specific to cis_baselines and are the reason this file
 * is longer than its sibling partner-RLS suites:
 *
 *  1. The SELECT-only read branch. Org users may READ their partner's
 *     partner-wide baselines (otherwise /cis/compliance, which INNER JOINs
 *     cis_baselines, would silently drop their own results) but must not
 *     write them. "Can read" and "cannot write" are asserted separately.
 *  2. The scan fan-out. `eq(devices.orgId, baseline.orgId)` compiles to
 *     `org_id = NULL` for a partner-wide baseline — zero devices, no error,
 *     nothing scanned. That is a silent failure a mocked-db unit test cannot
 *     catch, so selectCisScanTargetDevices is driven against real Postgres.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { cisBaselines, devices } from '../../db/schema';
import { selectCisScanTargetDevices } from '../../jobs/cisJobs';
import { createOrganization, createPartner, createSite } from './db-utils';

const createdBaselines: string[] = [];
const createdDevices: string[] = [];

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

afterEach(async () => {
  if (createdBaselines.length === 0 && createdDevices.length === 0) return;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (createdDevices.length > 0) {
      await db.delete(devices).where(inArray(devices.id, createdDevices));
    }
    if (createdBaselines.length > 0) {
      await db.delete(cisBaselines).where(inArray(cisBaselines.id, createdBaselines));
    }
  });
  createdBaselines.length = 0;
  createdDevices.length = 0;
});

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
 * partnerId for org scope too (buildDbAccessContext), which is exactly what
 * the SELECT-only read branch keys on — so it is set here deliberately.
 * `accessiblePartnerIds` stays empty: an org token never passes
 * breeze_has_partner_access, which is what keeps the branch read-only.
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

/**
 * Assert a write failed with a specific SQLSTATE. Drizzle wraps driver errors
 * in a DrizzleQueryError whose message is just "Failed query: ...", so a
 * regex on `.message` silently matches nothing useful — the real pg error
 * (with `.code`) hangs off `.cause`. Asserting the code is also stricter:
 * 23514 (check violation) and 42501 (RLS denial) are different guarantees and
 * a message regex would happily accept either.
 */
async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  const cause = (raised as { cause?: { code?: string } })?.cause;
  const actual = cause?.code ?? (raised as { code?: string })?.code;
  expect(actual).toBe(code);
}

const BASE = {
  name: 'CIS Windows 11 Enterprise',
  osType: 'windows' as const,
  benchmarkVersion: '3.0.0',
  level: 'l1' as const,
};

async function seedPartnerWide(partnerId: string): Promise<string> {
  const rows = await withDbAccessContext(partnerContext(partnerId, []), () =>
    db.insert(cisBaselines).values({ ...BASE, orgId: null, partnerId }).returning(),
  );
  const id = rows[0]!.id;
  createdBaselines.push(id);
  return id;
}

async function seedDevice(orgId: string, siteId: string, osType: 'windows' | 'linux' = 'windows'): Promise<string> {
  const rows = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(devices).values({
      orgId,
      siteId,
      agentId: randomUUID(),
      hostname: `cis-fanout-${randomUUID().slice(0, 8)}`,
      osType,
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
    }).returning({ id: devices.id }),
  );
  const id = rows[0]!.id;
  createdDevices.push(id);
  return id;
}

describe('cis_baselines RLS — dual-axis (2026-08-10 migration)', () => {
  describe('write policy', () => {
    it('partner scope can INSERT a partner-wide baseline (org_id NULL, partner_id set)', async () => {
      const partner = await createPartner();

      const rows = await withDbAccessContext(partnerContext(partner.id, []), () =>
        db.insert(cisBaselines).values({ ...BASE, orgId: null, partnerId: partner.id }).returning(),
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.orgId).toBeNull();
      expect(rows[0]?.partnerId).toBe(partner.id);
      createdBaselines.push(rows[0]!.id);
    });

    it('rejects a cross-partner forge (partner A cannot create for partner B)', async () => {
      const attacker = await createPartner();
      const victim = await createPartner();

      // 42501 = insufficient_privilege, i.e. the RLS WITH CHECK rejected it.
      await expectSqlState(
        () => withDbAccessContext(partnerContext(attacker.id, []), () =>
          db.insert(cisBaselines).values({ ...BASE, orgId: null, partnerId: victim.id }).returning(),
        ),
        '42501',
      );
    });

    it('rejects a row with BOTH axes set (XOR check, 23514)', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });

      await expectSqlState(
        () => withDbAccessContext(partnerContext(partner.id, [org.id]), () =>
          db.insert(cisBaselines).values({ ...BASE, orgId: org.id, partnerId: partner.id }).returning(),
        ),
        '23514',
      );
    });

    // Neither axis set trips RLS (42501) before the CHECK is ever evaluated:
    // with both columns NULL, neither the org branch nor the partner branch of
    // the WITH CHECK can match. Stricter than the constraint, so assert what
    // actually fires rather than the constraint we might have expected.
    it('rejects a row with NEITHER axis set', async () => {
      const partner = await createPartner();

      await expectSqlState(
        () => withDbAccessContext(partnerContext(partner.id, []), () =>
          db.insert(cisBaselines).values({ ...BASE, orgId: null, partnerId: null }).returning(),
        ),
        '42501',
      );
    });
  });

  describe('read isolation', () => {
    it('a different partner cannot SELECT another partner-wide baseline', async () => {
      const owner = await createPartner();
      const other = await createPartner();
      const id = await seedPartnerWide(owner.id);

      const rows = await withDbAccessContext(partnerContext(other.id, []), () =>
        db.select().from(cisBaselines).where(eq(cisBaselines.id, id)),
      );

      expect(rows).toHaveLength(0);
    });

    // The Q1 decision. Without this branch an org admin's own compliance
    // results vanish, because /cis/compliance INNER JOINs cis_baselines.
    it('an ORG user of the owning partner CAN read the partner-wide baseline', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const id = await seedPartnerWide(partner.id);

      const rows = await withDbAccessContext(orgContext(org.id, partner.id), () =>
        db.select().from(cisBaselines).where(eq(cisBaselines.id, id)),
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.partnerId).toBe(partner.id);
    });

    it('an ORG user of a DIFFERENT partner cannot read it', async () => {
      const owner = await createPartner();
      const other = await createPartner();
      const otherOrg = await createOrganization({ partnerId: other.id });
      const id = await seedPartnerWide(owner.id);

      const rows = await withDbAccessContext(orgContext(otherOrg.id, other.id), () =>
        db.select().from(cisBaselines).where(eq(cisBaselines.id, id)),
      );

      expect(rows).toHaveLength(0);
    });

    // Agent sessions set currentPartnerId null, so the read branch must not
    // fire for them. The agent ingest path resolves its baseline in a SYSTEM
    // context on purpose rather than relying on this.
    it('an agent-shaped context (currentPartnerId null) cannot read it', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const id = await seedPartnerWide(partner.id);

      const rows = await withDbAccessContext(orgContext(org.id, null), () =>
        db.select().from(cisBaselines).where(eq(cisBaselines.id, id)),
      );

      expect(rows).toHaveLength(0);
    });
  });

  describe('the read branch grants no write', () => {
    it('an ORG user of the owning partner cannot UPDATE the partner-wide baseline', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const id = await seedPartnerWide(partner.id);

      const updated = await withDbAccessContext(orgContext(org.id, partner.id), () =>
        db.update(cisBaselines).set({ name: 'HIJACKED' }).where(eq(cisBaselines.id, id)).returning(),
      );
      expect(updated).toHaveLength(0);

      const [after] = await withDbAccessContext(SYSTEM_CTX, () =>
        db.select().from(cisBaselines).where(eq(cisBaselines.id, id)),
      );
      expect(after?.name).toBe(BASE.name);
    });

    it('an ORG user of the owning partner cannot DELETE the partner-wide baseline', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const id = await seedPartnerWide(partner.id);

      const deleted = await withDbAccessContext(orgContext(org.id, partner.id), () =>
        db.delete(cisBaselines).where(eq(cisBaselines.id, id)).returning(),
      );
      expect(deleted).toHaveLength(0);

      const still = await withDbAccessContext(SYSTEM_CTX, () =>
        db.select().from(cisBaselines).where(eq(cisBaselines.id, id)),
      );
      expect(still).toHaveLength(1);
    });
  });

  // The silent-failure guard. Pre-migration code read
  // `eq(devices.orgId, baseline.orgId)`, which for a partner-wide baseline is
  // `org_id = NULL` — zero rows, no error, nothing scanned.
  describe('scan fan-out', () => {
    it('a partner-wide baseline targets devices across EVERY org under the partner', async () => {
      const partner = await createPartner();
      const orgA = await createOrganization({ partnerId: partner.id });
      const orgB = await createOrganization({ partnerId: partner.id });
      const siteA = await createSite({ orgId: orgA.id });
      const siteB = await createSite({ orgId: orgB.id });

      const deviceA = await seedDevice(orgA.id, siteA.id);
      const deviceB = await seedDevice(orgB.id, siteB.id);

      const targets = await withDbAccessContext(SYSTEM_CTX, () =>
        selectCisScanTargetDevices({ orgId: null, partnerId: partner.id, osType: 'windows' }),
      );

      const ids = targets.map((t) => t.id);
      expect(ids).toContain(deviceA);
      expect(ids).toContain(deviceB);

      // Each target carries its OWN org — that is what tenants the result rows
      // (cis_baseline_results.org_id is NOT NULL and must never come from the
      // baseline, which has no org here).
      expect(targets.find((t) => t.id === deviceA)?.orgId).toBe(orgA.id);
      expect(targets.find((t) => t.id === deviceB)?.orgId).toBe(orgB.id);
    });

    it('does not reach devices belonging to a different partner', async () => {
      const partner = await createPartner();
      const otherPartner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const otherOrg = await createOrganization({ partnerId: otherPartner.id });
      const site = await createSite({ orgId: org.id });
      const otherSite = await createSite({ orgId: otherOrg.id });

      const mine = await seedDevice(org.id, site.id);
      const theirs = await seedDevice(otherOrg.id, otherSite.id);

      const targets = await withDbAccessContext(SYSTEM_CTX, () =>
        selectCisScanTargetDevices({ orgId: null, partnerId: partner.id, osType: 'windows' }),
      );

      const ids = targets.map((t) => t.id);
      expect(ids).toContain(mine);
      expect(ids).not.toContain(theirs);
    });

    it('an org-owned baseline still targets only its own org', async () => {
      const partner = await createPartner();
      const orgA = await createOrganization({ partnerId: partner.id });
      const orgB = await createOrganization({ partnerId: partner.id });
      const siteA = await createSite({ orgId: orgA.id });
      const siteB = await createSite({ orgId: orgB.id });

      const deviceA = await seedDevice(orgA.id, siteA.id);
      const deviceB = await seedDevice(orgB.id, siteB.id);

      const targets = await withDbAccessContext(SYSTEM_CTX, () =>
        selectCisScanTargetDevices({ orgId: orgA.id, partnerId: null, osType: 'windows' }),
      );

      const ids = targets.map((t) => t.id);
      expect(ids).toContain(deviceA);
      expect(ids).not.toContain(deviceB);
    });

    it('still filters partner-wide targets by OS', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org.id });

      const win = await seedDevice(org.id, site.id, 'windows');
      const linux = await seedDevice(org.id, site.id, 'linux');

      const targets = await withDbAccessContext(SYSTEM_CTX, () =>
        selectCisScanTargetDevices({ orgId: null, partnerId: partner.id, osType: 'windows' }),
      );

      const ids = targets.map((t) => t.id);
      expect(ids).toContain(win);
      expect(ids).not.toContain(linux);
    });
  });
});
