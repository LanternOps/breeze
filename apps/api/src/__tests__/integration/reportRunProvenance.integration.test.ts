import './setup';

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { db, withSystemDbAccessContext } from '../../db';
import {
  organizations,
  partners,
  portalUsers,
  reportRuns,
  reports,
  users,
} from '../../db/schema';

const runDb = it.runIf(Boolean(process.env.DATABASE_URL));

async function seedReportFixture() {
  return withSystemDbAccessContext(async () => {
    const suffix = randomUUID();
    const [partner] = await db.insert(partners).values({
      name: `Report provenance partner ${suffix}`,
      slug: `report-provenance-${suffix}`,
    }).returning({ id: partners.id });
    if (!partner) throw new Error('failed to seed partner');

    const [organization] = await db.insert(organizations).values({
      partnerId: partner.id,
      name: `Report provenance org ${suffix}`,
      slug: `report-provenance-org-${suffix}`,
      currencyCode: 'USD',
    }).returning({ id: organizations.id });
    if (!organization) throw new Error('failed to seed organization');

    const [report] = await db.insert(reports).values({
      orgId: organization.id,
      name: 'Report provenance fixture',
      type: 'executive_summary',
      schedule: 'one_time',
      format: 'pdf',
    }).returning({ id: reports.id });
    if (!report) throw new Error('failed to seed report');

    return {
      partnerId: partner.id,
      orgId: organization.id,
      reportId: report.id,
      suffix,
    };
  });
}

async function cleanupFixture(fixture: {
  partnerId: string;
  orgId: string;
  reportId: string;
}): Promise<void> {
  await withSystemDbAccessContext(async () => {
    await db.delete(reportRuns).where(eq(reportRuns.reportId, fixture.reportId));
    await db.delete(reports).where(eq(reports.id, fixture.reportId));
    await db.delete(portalUsers).where(eq(portalUsers.orgId, fixture.orgId));
    await db.delete(users).where(eq(users.orgId, fixture.orgId));
    await db.delete(organizations).where(eq(organizations.id, fixture.orgId));
    await db.delete(partners).where(eq(partners.id, fixture.partnerId));
  });
}

describe('report run requester tombstones', () => {
  runDb('preserves user provenance kind after the requesting user is deleted', async () => {
    const fixture = await seedReportFixture();
    try {
      const { userId, runId } = await withSystemDbAccessContext(async () => {
        const [user] = await db.insert(users).values({
          partnerId: fixture.partnerId,
          orgId: fixture.orgId,
          email: `staff-${fixture.suffix}@example.test`,
          name: 'Report requester',
          status: 'active',
        }).returning({ id: users.id });
        if (!user) throw new Error('failed to seed user');

        const [run] = await db.insert(reportRuns).values({
          reportId: fixture.reportId,
          requestedByKind: 'user',
          requestedByUserId: user.id,
        }).returning({ id: reportRuns.id });
        if (!run) throw new Error('failed to seed report run');
        return { userId: user.id, runId: run.id };
      });

      const [row] = await withSystemDbAccessContext(async () => {
        await db.delete(users).where(eq(users.id, userId));
        return db.select({
          id: reportRuns.id,
          requestedByKind: reportRuns.requestedByKind,
          requestedByUserId: reportRuns.requestedByUserId,
        }).from(reportRuns).where(eq(reportRuns.id, runId));
      });

      expect(row).toEqual({
        id: runId,
        requestedByKind: 'user',
        requestedByUserId: null,
      });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  runDb('preserves portal-user provenance kind after the portal user is deleted', async () => {
    const fixture = await seedReportFixture();
    try {
      const { portalUserId, runId } = await withSystemDbAccessContext(async () => {
        const [portalUser] = await db.insert(portalUsers).values({
          orgId: fixture.orgId,
          email: `portal-${fixture.suffix}@example.test`,
        }).returning({ id: portalUsers.id });
        if (!portalUser) throw new Error('failed to seed portal user');

        const [run] = await db.insert(reportRuns).values({
          reportId: fixture.reportId,
          requestedByKind: 'portal_user',
          requestedByPortalUserId: portalUser.id,
        }).returning({ id: reportRuns.id });
        if (!run) throw new Error('failed to seed report run');
        return { portalUserId: portalUser.id, runId: run.id };
      });

      const [row] = await withSystemDbAccessContext(async () => {
        await db.delete(portalUsers).where(eq(portalUsers.id, portalUserId));
        return db.select({
          id: reportRuns.id,
          requestedByKind: reportRuns.requestedByKind,
          requestedByPortalUserId: reportRuns.requestedByPortalUserId,
        }).from(reportRuns).where(eq(reportRuns.id, runId));
      });

      expect(row).toEqual({
        id: runId,
        requestedByKind: 'portal_user',
        requestedByPortalUserId: null,
      });
    } finally {
      await cleanupFixture(fixture);
    }
  });

  runDb('rejects a user provenance row carrying a portal-user id', async () => {
    const fixture = await seedReportFixture();
    try {
      const portalUserId = await withSystemDbAccessContext(async () => {
        const [portalUser] = await db.insert(portalUsers).values({
          orgId: fixture.orgId,
          email: `invalid-axis-${fixture.suffix}@example.test`,
        }).returning({ id: portalUsers.id });
        if (!portalUser) throw new Error('failed to seed portal user');
        return portalUser.id;
      });

      await expect(withSystemDbAccessContext(() =>
        db.insert(reportRuns).values({
          reportId: fixture.reportId,
          requestedByKind: 'user',
          requestedByPortalUserId: portalUserId,
        }),
      )).rejects.toMatchObject({
        cause: expect.objectContaining({
          code: '23514',
          constraint_name: 'report_runs_requested_by_shape_chk',
        }),
      });
    } finally {
      await cleanupFixture(fixture);
    }
  });
});
