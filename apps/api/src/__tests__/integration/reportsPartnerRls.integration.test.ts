/**
 * reports RLS — dual-axis (org OR partner) enforcement (#3198 W01).
 *
 * Migration under test: 2026-10-26-140100-reports-partner-ownership.sql.
 *
 * A report is owned by EITHER an org (org_id set, partner_id NULL) OR a partner
 * (partner_id set, org_id NULL — a cross-org business aggregate). The policy is:
 *   system OR (org_id IS NOT NULL AND breeze_has_org_access(org_id))
 *          OR (partner_id IS NOT NULL AND breeze_has_partner_access(partner_id))
 * with deliberately NO partner-wide SELECT branch: a partner-owned report
 * aggregates money and utilisation across the partner's clients and must never
 * be legible to an org-scope session of the same partner.
 *
 * The rls-coverage contract proves only that SOME policy names one of the two
 * helpers per command (an org-only policy passes it). This suite, through the
 * real postgres.js driver as the forced-RLS breeze_app role, is the only proof
 * of the partner branch, of the XOR CHECK, of the execution-scope CHECK's
 * partner_wide arm, of the report_runs / report_run_deliveries FK-join partner
 * OR, of org-token blindness, and of the report_runs ON DELETE CASCADE.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { reports, reportRuns, reportRunDeliveries } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import {
  partnerWideScope,
  persistedSiteScopeValues,
  siteScopeFingerprint,
} from '../../services/siteScope';

const SYSTEM: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

const created: string[] = [];

afterEach(async () => {
  if (created.length === 0) return;
  // report_runs.report_id is ON DELETE CASCADE (and deliveries cascade from
  // runs), so deleting the definitions is sufficient.
  await withDbAccessContext(SYSTEM, async () => {
    for (const id of created) {
      await db.delete(reports).where(eq(reports.id, id));
    }
  });
  created.length = 0;
});

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

/**
 * An ORG-scoped session. `currentPartnerId` mirrors what
 * `buildDbAccessContext` (middleware/auth.ts) actually puts on an org token —
 * the token's OWN partner, populated for every scope and distinct from
 * `accessiblePartnerIds`, which stays empty for org scope. It is what a
 * `*_partner_wide_select` read branch would key on, so an "org scope sees
 * nothing" assertion that omitted it would exercise the AGENT context shape
 * (currentPartnerId null) and be vacuous. Every call below passes the owning
 * partner.
 */
function orgContext(orgId: string, currentPartnerId: string | null = null): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId,
  };
}

/** Execution-scope columns for a partner-owned row, via the real encoder. */
function partnerWideColumns(partnerId: string, userId: string) {
  const scope = partnerWideScope(partnerId);
  return persistedSiteScopeValues({
    principalKind: 'user',
    scope,
    principalUserId: userId,
    capturedAt: new Date(),
    fingerprint: siteScopeFingerprint(scope),
  });
}

function uniqueEmail(label: string): string {
  return `reports-rls-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

async function seedPartnerUser(partnerId: string, label: string) {
  return createUser({ partnerId, email: uniqueEmail(label) });
}

async function insertPartnerReport(partnerId: string, userId: string, name = 'Partner AR aging') {
  const rows = await withDbAccessContext(partnerContext(partnerId, []), () =>
    db
      .insert(reports)
      .values({
        partnerId,
        orgId: null,
        name,
        type: 'ar_aging',
        createdBy: userId,
        ...partnerWideColumns(partnerId, userId),
      })
      .returning(),
  );
  const row = rows[0]!;
  created.push(row.id);
  return row;
}

describe('reports RLS — partner ownership (2026-10-26-140100)', () => {
  it('a partner inserts and reads back its own partner-owned report; another partner sees nothing', async () => {
    const p1 = await createPartner();
    const p2 = await createPartner();
    const u1 = await seedPartnerUser(p1.id, 'p1');

    const row = await insertPartnerReport(p1.id, u1.id);
    expect(row.partnerId).toBe(p1.id);
    expect(row.orgId).toBeNull();
    expect(row.executionScopeKind).toBe('partner_wide');
    expect(row.executionScopePrincipalKind).toBe('user');
    expect(row.executionScopeUserId).toBe(u1.id);
    expect(row.executionScopeSiteIds).toBeNull();

    const mine = await withDbAccessContext(partnerContext(p1.id, []), () =>
      db.select({ id: reports.id }).from(reports).where(eq(reports.id, row.id)),
    );
    expect(mine.map((r) => r.id)).toEqual([row.id]);

    const theirs = await withDbAccessContext(partnerContext(p2.id, []), () =>
      db.select({ id: reports.id }).from(reports).where(eq(reports.id, row.id)),
    );
    expect(theirs).toHaveLength(0);
  });

  it('rejects a forged cross-partner insert (42501)', async () => {
    const p1 = await createPartner();
    const p2 = await createPartner();
    const u1 = await seedPartnerUser(p1.id, 'forger');

    await expect(
      withDbAccessContext(partnerContext(p1.id, []), () =>
        db
          .insert(reports)
          .values({
            partnerId: p2.id,
            orgId: null,
            name: 'forge',
            type: 'ar_aging',
            createdBy: u1.id,
            ...partnerWideColumns(p2.id, u1.id),
          })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });

    const landed = await withDbAccessContext(SYSTEM, () =>
      db.select({ id: reports.id }).from(reports).where(eq(reports.partnerId, p2.id)),
    );
    expect(landed).toHaveLength(0);
  });

  it('rejects both-axes and neither-axis rows (reports_one_owner_chk, 23514)', async () => {
    const p1 = await createPartner();
    const org = await createOrganization({ partnerId: p1.id });
    const u1 = await seedPartnerUser(p1.id, 'xor');

    await expect(
      withDbAccessContext(partnerContext(p1.id, [org.id]), () =>
        db
          .insert(reports)
          .values({
            partnerId: p1.id,
            orgId: org.id,
            name: 'both',
            type: 'ar_aging',
            createdBy: u1.id,
          })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514', constraint_name: 'reports_one_owner_chk' } });

    // Neither axis: run as system so RLS cannot be the reason it fails.
    await expect(
      withDbAccessContext(SYSTEM, () =>
        db
          .insert(reports)
          .values({ partnerId: null, orgId: null, name: 'neither', type: 'ar_aging', createdBy: u1.id })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514', constraint_name: 'reports_one_owner_chk' } });
  });

  it('rejects partner_wide scope on an org-owned row, and system/portal principals on partner_wide (23514)', async () => {
    const p1 = await createPartner();
    const org = await createOrganization({ partnerId: p1.id });
    const u1 = await seedPartnerUser(p1.id, 'scope');
    const shapeViolation = {
      cause: { code: '23514', constraint_name: 'reports_execution_scope_shape_chk' },
    };

    await expect(
      withDbAccessContext(partnerContext(p1.id, [org.id]), () =>
        db
          .insert(reports)
          .values({
            orgId: org.id,
            partnerId: null,
            name: 'org row with partner_wide scope',
            type: 'ar_aging',
            createdBy: u1.id,
            ...partnerWideColumns(p1.id, u1.id),
          })
          .returning(),
      ),
    ).rejects.toMatchObject(shapeViolation);

    for (const principal of ['system', 'portal_user'] as const) {
      await expect(
        withDbAccessContext(partnerContext(p1.id, []), () =>
          db
            .insert(reports)
            .values({
              partnerId: p1.id,
              orgId: null,
              name: `partner_wide with ${principal}`,
              type: 'ar_aging',
              createdBy: null,
              ...partnerWideColumns(p1.id, u1.id),
              executionScopeUserId: null,
              executionScopePrincipalKind: principal,
            })
            .returning(),
        ),
      ).rejects.toMatchObject(shapeViolation);
    }
  });

  it('an ORG token of the owning partner sees ZERO partner-owned reports, runs or deliveries (no partner-wide select branch)', async () => {
    const p1 = await createPartner();
    const org = await createOrganization({ partnerId: p1.id });
    const u1 = await seedPartnerUser(p1.id, 'blind');
    const row = await insertPartnerReport(p1.id, u1.id);

    const [run] = await withDbAccessContext(partnerContext(p1.id, []), () =>
      db
        .insert(reportRuns)
        .values({
          reportId: row.id,
          status: 'completed',
          requestedByKind: 'user',
          requestedByUserId: u1.id,
          ...partnerWideColumns(p1.id, u1.id),
        })
        .returning(),
    );
    const [delivery] = await withDbAccessContext(partnerContext(p1.id, []), () =>
      db
        .insert(reportRunDeliveries)
        .values({ reportRunId: run!.id, recipientUserId: u1.id, channel: 'email' })
        .returning(),
    );

    // Positive control for the same rows: the owning partner sees all three.
    const partnerSees = await withDbAccessContext(partnerContext(p1.id, [org.id]), async () => ({
      reports: await db.select({ id: reports.id }).from(reports).where(eq(reports.partnerId, p1.id)),
      runs: await db.select({ id: reportRuns.id }).from(reportRuns).where(eq(reportRuns.id, run!.id)),
      deliveries: await db
        .select({ id: reportRunDeliveries.id })
        .from(reportRunDeliveries)
        .where(eq(reportRunDeliveries.id, delivery!.id)),
    }));
    expect(partnerSees.reports.map((r) => r.id)).toEqual([row.id]);
    expect(partnerSees.runs).toHaveLength(1);
    expect(partnerSees.deliveries).toHaveLength(1);

    const orgSees = await withDbAccessContext(orgContext(org.id, p1.id), async () => ({
      reports: await db.select({ id: reports.id }).from(reports).where(eq(reports.partnerId, p1.id)),
      runs: await db.select({ id: reportRuns.id }).from(reportRuns).where(eq(reportRuns.id, run!.id)),
      deliveries: await db
        .select({ id: reportRunDeliveries.id })
        .from(reportRunDeliveries)
        .where(eq(reportRunDeliveries.id, delivery!.id)),
    }));
    expect(orgSees.reports).toHaveLength(0);
    expect(orgSees.runs).toHaveLength(0);
    expect(orgSees.deliveries).toHaveLength(0);

    // Nor can the org token write under the partner axis.
    await expect(
      withDbAccessContext(orgContext(org.id, p1.id), () =>
        db
          .insert(reports)
          .values({
            partnerId: p1.id,
            orgId: null,
            name: 'org forging a partner report',
            type: 'ar_aging',
            createdBy: u1.id,
            ...partnerWideColumns(p1.id, u1.id),
          })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('an org-owned report stays visible to its org exactly as before, and not to a sibling org', async () => {
    const p1 = await createPartner();
    const org = await createOrganization({ partnerId: p1.id });
    const sibling = await createOrganization({ partnerId: p1.id });
    const u1 = await seedPartnerUser(p1.id, 'org');

    const [row] = await withDbAccessContext(orgContext(org.id, p1.id), () =>
      db
        .insert(reports)
        .values({ orgId: org.id, partnerId: null, name: 'Org inventory', type: 'device_inventory', createdBy: u1.id })
        .returning(),
    );
    created.push(row!.id);
    expect(row!.orgId).toBe(org.id);
    expect(row!.partnerId).toBeNull();

    const [run] = await withDbAccessContext(orgContext(org.id, p1.id), () =>
      db.insert(reportRuns).values({ reportId: row!.id, status: 'completed' }).returning(),
    );

    const own = await withDbAccessContext(orgContext(org.id, p1.id), async () => ({
      reports: await db.select({ id: reports.id }).from(reports).where(eq(reports.id, row!.id)),
      runs: await db.select({ id: reportRuns.id }).from(reportRuns).where(eq(reportRuns.id, run!.id)),
    }));
    expect(own.reports).toHaveLength(1);
    expect(own.runs).toHaveLength(1);

    // The partner with the org in its accessible set still reaches it via the org branch.
    const partnerView = await withDbAccessContext(partnerContext(p1.id, [org.id]), () =>
      db.select({ id: reports.id }).from(reports).where(eq(reports.id, row!.id)),
    );
    expect(partnerView).toHaveLength(1);

    const siblingView = await withDbAccessContext(orgContext(sibling.id, p1.id), async () => ({
      reports: await db.select({ id: reports.id }).from(reports).where(eq(reports.id, row!.id)),
      runs: await db.select({ id: reportRuns.id }).from(reportRuns).where(eq(reportRuns.id, run!.id)),
    }));
    expect(siblingView.reports).toHaveLength(0);
    expect(siblingView.runs).toHaveLength(0);
  });

  it('runs and deliveries of a partner-owned report insert and read back under partner context; another partner can neither read nor forge them (FK-join partner OR)', async () => {
    const p1 = await createPartner();
    const p2 = await createPartner();
    const u1 = await seedPartnerUser(p1.id, 'runs');
    const u2 = await seedPartnerUser(p2.id, 'runs-other');
    const row = await insertPartnerReport(p1.id, u1.id);

    const [run] = await withDbAccessContext(partnerContext(p1.id, []), () =>
      db
        .insert(reportRuns)
        .values({
          reportId: row.id,
          status: 'completed',
          requestedByKind: 'user',
          requestedByUserId: u1.id,
          ...partnerWideColumns(p1.id, u1.id),
        })
        .returning(),
    );
    expect(run!.reportId).toBe(row.id);
    expect(run!.executionScopeKind).toBe('partner_wide');

    const [delivery] = await withDbAccessContext(partnerContext(p1.id, []), () =>
      db
        .insert(reportRunDeliveries)
        .values({ reportRunId: run!.id, recipientUserId: u1.id, channel: 'email' })
        .returning(),
    );
    expect(delivery!.reportRunId).toBe(run!.id);
    expect(delivery!.state).toBe('pending');

    const back = await withDbAccessContext(partnerContext(p1.id, []), async () => ({
      runs: await db.select({ id: reportRuns.id }).from(reportRuns).where(eq(reportRuns.id, run!.id)),
      deliveries: await db
        .select({ id: reportRunDeliveries.id })
        .from(reportRunDeliveries)
        .where(eq(reportRunDeliveries.id, delivery!.id)),
    }));
    expect(back.runs).toHaveLength(1);
    expect(back.deliveries).toHaveLength(1);

    const other = await withDbAccessContext(partnerContext(p2.id, []), async () => ({
      runs: await db.select({ id: reportRuns.id }).from(reportRuns).where(eq(reportRuns.id, run!.id)),
      deliveries: await db
        .select({ id: reportRunDeliveries.id })
        .from(reportRunDeliveries)
        .where(eq(reportRunDeliveries.id, delivery!.id)),
    }));
    expect(other.runs).toHaveLength(0);
    expect(other.deliveries).toHaveLength(0);

    // p2 cannot attach a run to p1's report, nor a delivery to p1's run.
    await expect(
      withDbAccessContext(partnerContext(p2.id, []), () =>
        db.insert(reportRuns).values({ reportId: row.id, status: 'pending' }).returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      withDbAccessContext(partnerContext(p2.id, []), () =>
        db
          .insert(reportRunDeliveries)
          .values({ reportRunId: run!.id, recipientUserId: u2.id, channel: 'email' })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('deleting a partner-owned report cascades its runs and their deliveries', async () => {
    const p1 = await createPartner();
    const u1 = await seedPartnerUser(p1.id, 'cascade');
    const row = await insertPartnerReport(p1.id, u1.id);

    const [run] = await withDbAccessContext(partnerContext(p1.id, []), () =>
      db
        .insert(reportRuns)
        .values({ reportId: row.id, status: 'completed', requestedByKind: 'user', requestedByUserId: u1.id })
        .returning(),
    );
    await withDbAccessContext(partnerContext(p1.id, []), () =>
      db.insert(reportRunDeliveries).values({ reportRunId: run!.id, recipientUserId: u1.id, channel: 'email' }),
    );

    // Under the partner's own context — the path a partner-scope DELETE route takes.
    const deleted = await withDbAccessContext(partnerContext(p1.id, []), () =>
      db.delete(reports).where(eq(reports.id, row.id)).returning({ id: reports.id }),
    );
    expect(deleted.map((r) => r.id)).toEqual([row.id]);

    const left = await withDbAccessContext(SYSTEM, async () => ({
      reports: await db.select({ id: reports.id }).from(reports).where(eq(reports.id, row.id)),
      runs: await db.select({ id: reportRuns.id }).from(reportRuns).where(eq(reportRuns.id, run!.id)),
      deliveries: await db
        .select({ id: reportRunDeliveries.id })
        .from(reportRunDeliveries)
        .where(eq(reportRunDeliveries.reportRunId, run!.id)),
    }));
    expect(left.reports).toHaveLength(0);
    expect(left.runs).toHaveLength(0);
    expect(left.deliveries).toHaveLength(0);
  });
});
