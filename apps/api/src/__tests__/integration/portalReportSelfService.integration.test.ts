import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import {
  portalBranding,
  portalUsers,
  reportRuns,
  reports,
} from '../../db/schema';
import {
  createOrganization,
  createPartner,
} from './db-utils';
import {
  generatePortalReport,
  latestPortalHardwareLifecycleRun,
  listPortalRuns,
  PortalReportNotFoundError,
  renderRunCsv,
  renderRunPdf,
} from '../../services/portal/reportsSelfService';
import {
  persistedSiteScopeValues,
  siteScopeFingerprint,
  type UserReportExecutionAuthority,
} from '../../services/siteScope';

const runDb = it.runIf(Boolean(process.env.DATABASE_URL));

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    currentPartnerId: null,
    userId: null,
  };
}

describe('portal report self-service tenancy', () => {
  runDb('stores portal provenance and hides org A PDF from org B', async () => {
    const fixture = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const orgA = await createOrganization({ partnerId: partner.id });
      const orgB = await createOrganization({ partnerId: partner.id });

      const [portalUser] = await db.insert(portalUsers).values({
        orgId: orgA.id,
        email: `portal-${crypto.randomUUID()}@example.test`,
        status: 'active',
      }).returning({ id: portalUsers.id });

      const scope = {
        version: 1,
        kind: 'unrestricted',
        orgId: orgA.id,
      } as const;
      const authority: UserReportExecutionAuthority = {
        principalKind: 'user',
        principalUserId: crypto.randomUUID(),
        scope,
        capturedAt: new Date(),
        fingerprint: siteScopeFingerprint(scope),
      };

      await db.insert(reports).values({
        orgId: orgA.id,
        name: 'Customer portal — Executive summary',
        type: 'executive_summary',
        schedule: 'one_time',
        format: 'pdf',
        config: { dateRange: { preset: 'last_30_days' } },
        portalSelfService: true,
        ...persistedSiteScopeValues(authority),
      });

      return { orgA, orgB, portalUser: portalUser! };
    });

    const generated = await withDbAccessContext(
      orgContext(fixture.orgA.id),
      () => generatePortalReport({
        orgId: fixture.orgA.id,
        portalUserId: fixture.portalUser.id,
        type: 'executive_summary',
      }),
    );

    expect(generated.status).toBe('completed');

    // The MSP Reports list reads `reports.last_generated_at`; portal-generated
    // runs must stamp it too, or the MSP sees "Never" next to a definition the
    // customer has generated five times (portal QA walk, #4562).
    const [definition] = await withSystemDbAccessContext(() =>
      db.select({ lastGeneratedAt: reports.lastGeneratedAt })
        .from(reports)
        .where(eq(reports.id, generated.reportId)),
    );
    expect(definition?.lastGeneratedAt).toBeInstanceOf(Date);

    const [stored] = await withSystemDbAccessContext(() =>
      db.select({
        requestedByKind: reportRuns.requestedByKind,
        requestedByUserId: reportRuns.requestedByUserId,
        requestedByPortalUserId: reportRuns.requestedByPortalUserId,
      }).from(reportRuns).where(eq(reportRuns.id, generated.id)),
    );

    expect(stored).toEqual({
      requestedByKind: 'portal_user',
      requestedByUserId: null,
      requestedByPortalUserId: fixture.portalUser.id,
    });

    await expect(
      withDbAccessContext(orgContext(fixture.orgA.id), () =>
        renderRunPdf(generated.id, fixture.orgA.id, 'UTC'),
      ),
    ).resolves.toBeInstanceOf(Buffer);

    await expect(
      withDbAccessContext(orgContext(fixture.orgB.id), () =>
        renderRunPdf(generated.id, fixture.orgB.id, 'UTC'),
      ),
    ).rejects.toBeInstanceOf(PortalReportNotFoundError);
  });

  // R10-8: the self-service marker, not org membership alone, is what admits a
  // run into the portal. A completed run of an MSP-internal definition in the
  // portal user's OWN org must be neither listed nor downloadable.
  runDb('hides a non-self-service run from the portal even inside its own org', async () => {
    const fixture = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });

      const scope = {
        version: 1,
        kind: 'unrestricted',
        orgId: org.id,
      } as const;
      const authority: UserReportExecutionAuthority = {
        principalKind: 'user',
        principalUserId: crypto.randomUUID(),
        scope,
        capturedAt: new Date(),
        fingerprint: siteScopeFingerprint(scope),
      };

      const [definition] = await db.insert(reports).values({
        orgId: org.id,
        name: 'Internal executive summary',
        type: 'executive_summary',
        schedule: 'one_time',
        format: 'pdf',
        config: { dateRange: { preset: 'last_30_days' } },
        portalSelfService: false,
        ...persistedSiteScopeValues(authority),
      }).returning({ id: reports.id });

      const [run] = await db.insert(reportRuns).values({
        reportId: definition!.id,
        status: 'completed',
        startedAt: new Date(),
        completedAt: new Date(),
        result: { rows: [], summary: {} },
        rowCount: 0,
        // Tombstoned staff user: the provenance CHECK only forbids the WRONG id.
        requestedByKind: 'user',
        requestedByUserId: null,
        requestedByPortalUserId: null,
        ...persistedSiteScopeValues(authority),
      }).returning({ id: reportRuns.id });

      return { org, runId: run!.id };
    });

    const listed = await withDbAccessContext(orgContext(fixture.org.id), () =>
      listPortalRuns(fixture.org.id, 'UTC', { page: 1, limit: 50 }),
    );
    expect(listed.data.map((row) => row.id)).not.toContain(fixture.runId);

    await expect(
      withDbAccessContext(orgContext(fixture.org.id), () =>
        renderRunPdf(fixture.runId, fixture.org.id, 'UTC'),
      ),
    ).rejects.toBeInstanceOf(PortalReportNotFoundError);
  });

  // #6941 (defense in depth): the marker alone is not enough either. Neither
  // writer of portal_self_service can set it on an msp_staff-audience type
  // today, but if a row ever carried it (hand edit, future writer) an AR aging
  // run must still be neither listed nor downloadable from the portal. The
  // executive_summary run in the same org is the control: it proves the list
  // is not vacuously empty.
  runDb('hides an msp_staff-audience run even when its definition carries portal_self_service', async () => {
    const fixture = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });

      const scope = {
        version: 1,
        kind: 'unrestricted',
        orgId: org.id,
      } as const;
      const authority: UserReportExecutionAuthority = {
        principalKind: 'user',
        principalUserId: crypto.randomUUID(),
        scope,
        capturedAt: new Date(),
        fingerprint: siteScopeFingerprint(scope),
      };

      const seedRun = async (type: 'ar_aging' | 'executive_summary') => {
        const [definition] = await db.insert(reports).values({
          orgId: org.id,
          name: `Flagged ${type}`,
          type,
          schedule: 'one_time',
          format: 'csv',
          config: {},
          portalSelfService: true,
          ...persistedSiteScopeValues(authority),
        }).returning({ id: reports.id });

        const [run] = await db.insert(reportRuns).values({
          reportId: definition!.id,
          status: 'completed',
          startedAt: new Date(),
          completedAt: new Date(),
          result: { rows: [{ customer: 'Acme', balance: 100 }], summary: {} },
          rowCount: 1,
          requestedByKind: 'user',
          requestedByUserId: null,
          requestedByPortalUserId: null,
          ...persistedSiteScopeValues(authority),
        }).returning({ id: reportRuns.id });
        return run!.id;
      };

      return {
        org,
        mspStaffRunId: await seedRun('ar_aging'),
        customerRunId: await seedRun('executive_summary'),
      };
    });

    const listed = await withDbAccessContext(orgContext(fixture.org.id), () =>
      listPortalRuns(fixture.org.id, 'UTC', { page: 1, limit: 50 }),
    );
    const listedIds = listed.data.map((row) => row.id);
    expect(listedIds).toContain(fixture.customerRunId);
    expect(listedIds).not.toContain(fixture.mspStaffRunId);
    expect(listed.data.map((row) => row.type)).not.toContain('ar_aging');

    await expect(
      withDbAccessContext(orgContext(fixture.org.id), () =>
        renderRunCsv(fixture.customerRunId, fixture.org.id),
      ),
    ).resolves.toContain('Acme');

    await expect(
      withDbAccessContext(orgContext(fixture.org.id), () =>
        renderRunCsv(fixture.mspStaffRunId, fixture.org.id),
      ),
    ).rejects.toBeInstanceOf(PortalReportNotFoundError);

    await expect(
      withDbAccessContext(orgContext(fixture.org.id), () =>
        renderRunPdf(fixture.mspStaffRunId, fixture.org.id, 'UTC'),
      ),
    ).rejects.toBeInstanceOf(PortalReportNotFoundError);
  });
});

// Spec section 4, decision A2: enable_lifecycle gates the hardware lifecycle
// plan SEPARATELY from generic report self-service, and it has to hold on the
// GENERIC endpoints too. Those are mounted under /reports/*, gated on
// enableReports alone, and a completed run outlives the flag being switched
// back off — so a run that was legitimately generated while the flag was on
// must vanish from the run list and the download routes the moment it is off.
describe('hardware_lifecycle visibility follows enable_lifecycle', () => {
  async function seedLifecycleFixture(enableLifecycle: boolean) {
    return withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });

      const [portalUser] = await db.insert(portalUsers).values({
        orgId: org.id,
        email: `portal-${crypto.randomUUID()}@example.test`,
        status: 'active',
      }).returning({ id: portalUsers.id });

      await db.insert(portalBranding).values({
        orgId: org.id,
        enableReports: true,
        enableLifecycle,
      });

      const scope = {
        version: 1,
        kind: 'unrestricted',
        orgId: org.id,
      } as const;
      const authority: UserReportExecutionAuthority = {
        principalKind: 'user',
        principalUserId: crypto.randomUUID(),
        scope,
        capturedAt: new Date(),
        fingerprint: siteScopeFingerprint(scope),
      };

      const [lifecycleDefinition] = await db.insert(reports).values({
        orgId: org.id,
        name: 'Customer portal — Hardware Lifecycle',
        type: 'hardware_lifecycle',
        schedule: 'one_time',
        format: 'pdf',
        config: {
          sites: [],
          replaceAgeYears: 4,
          serverReplaceAgeYears: 5,
          includeManualAssets: true,
          includeOtherEquipment: true,
        },
        portalSelfService: true,
        ...persistedSiteScopeValues(authority),
      }).returning({ id: reports.id });

      const [summaryDefinition] = await db.insert(reports).values({
        orgId: org.id,
        name: 'Customer portal — Executive summary',
        type: 'executive_summary',
        schedule: 'one_time',
        format: 'pdf',
        config: { dateRange: { preset: 'last_30_days' } },
        portalSelfService: true,
        ...persistedSiteScopeValues(authority),
      }).returning({ id: reports.id });

      const completed = {
        status: 'completed' as const,
        startedAt: new Date(),
        completedAt: new Date(),
        result: { rows: [], summary: {} },
        rowCount: 0,
        requestedByKind: 'portal_user' as const,
        requestedByUserId: null,
        requestedByPortalUserId: portalUser!.id,
        ...persistedSiteScopeValues(authority),
      };

      const [lifecycleRun] = await db.insert(reportRuns).values({
        reportId: lifecycleDefinition!.id,
        ...completed,
      }).returning({ id: reportRuns.id });

      const [summaryRun] = await db.insert(reportRuns).values({
        reportId: summaryDefinition!.id,
        ...completed,
      }).returning({ id: reportRuns.id });

      return {
        org,
        portalUser: portalUser!,
        lifecycleRunId: lifecycleRun!.id,
        summaryRunId: summaryRun!.id,
      };
    });
  }

  runDb('hides a completed hardware_lifecycle run from every generic endpoint when the flag is off', async () => {
    const fixture = await seedLifecycleFixture(false);

    const listed = await withDbAccessContext(orgContext(fixture.org.id), () =>
      listPortalRuns(fixture.org.id, 'UTC', { page: 1, limit: 50 }),
    );

    const listedIds = listed.data.map((row) => row.id);
    expect(listedIds).not.toContain(fixture.lifecycleRunId);
    // The exclusion must be surgical: the org's other portal report types are
    // still listed. A blanket failure would look identical in a weaker test.
    expect(listedIds).toContain(fixture.summaryRunId);

    await expect(
      withDbAccessContext(orgContext(fixture.org.id), () =>
        renderRunPdf(fixture.lifecycleRunId, fixture.org.id, 'UTC'),
      ),
    ).rejects.toBeInstanceOf(PortalReportNotFoundError);

    await expect(
      withDbAccessContext(orgContext(fixture.org.id), () =>
        renderRunCsv(fixture.lifecycleRunId, fixture.org.id),
      ),
    ).rejects.toBeInstanceOf(PortalReportNotFoundError);

    await expect(
      withDbAccessContext(orgContext(fixture.org.id), () =>
        generatePortalReport({
          orgId: fixture.org.id,
          portalUserId: fixture.portalUser.id,
          type: 'hardware_lifecycle',
        }),
      ),
    ).rejects.toBeInstanceOf(PortalReportNotFoundError);

    await expect(
      withDbAccessContext(orgContext(fixture.org.id), () =>
        latestPortalHardwareLifecycleRun(fixture.org.id, 'UTC'),
      ),
    ).rejects.toBeInstanceOf(PortalReportNotFoundError);
  });

  runDb('exposes the same run through every endpoint once the flag is on', async () => {
    const fixture = await seedLifecycleFixture(true);

    const listed = await withDbAccessContext(orgContext(fixture.org.id), () =>
      listPortalRuns(fixture.org.id, 'UTC', { page: 1, limit: 50 }),
    );
    expect(listed.data.map((row) => row.id)).toContain(fixture.lifecycleRunId);

    await expect(
      withDbAccessContext(orgContext(fixture.org.id), () =>
        renderRunPdf(fixture.lifecycleRunId, fixture.org.id, 'UTC'),
      ),
    ).resolves.toBeInstanceOf(Buffer);

    const latest = await withDbAccessContext(orgContext(fixture.org.id), () =>
      latestPortalHardwareLifecycleRun(fixture.org.id, 'UTC'),
    );
    expect(latest.run.id).toBe(fixture.lifecycleRunId);
    expect(latest.run.generatedAt).toEqual(expect.any(String));
  });

  // Decision B2: the customer's run must use the MSP's own thresholds. The
  // MSP-side definition is portal_self_service = false, so nothing about it
  // except these four keys may reach the portal run.
  runDb('inherits the MSP definition thresholds but never its site scope', async () => {
    const fixture = await seedLifecycleFixture(true);
    const otherSiteId = crypto.randomUUID();

    const scope = {
      version: 1,
      kind: 'unrestricted',
      orgId: fixture.org.id,
    } as const;
    const mspAuthority: UserReportExecutionAuthority = {
      principalKind: 'user',
      principalUserId: crypto.randomUUID(),
      scope,
      capturedAt: new Date(),
      fingerprint: siteScopeFingerprint(scope),
    };

    await withSystemDbAccessContext(() =>
      db.insert(reports).values({
        orgId: fixture.org.id,
        name: 'Internal hardware lifecycle',
        type: 'hardware_lifecycle',
        schedule: 'one_time',
        format: 'pdf',
        config: {
          sites: [otherSiteId],
          replaceAgeYears: 6,
          serverReplaceAgeYears: 9,
          includeManualAssets: false,
          includeOtherEquipment: false,
        },
        portalSelfService: false,
        ...persistedSiteScopeValues(mspAuthority),
      }),
    );

    const generated = await withDbAccessContext(orgContext(fixture.org.id), () =>
      generatePortalReport({
        orgId: fixture.org.id,
        portalUserId: fixture.portalUser.id,
        type: 'hardware_lifecycle',
      }),
    );

    expect(generated.status).toBe('completed');
    expect(generated.type).toBe('hardware_lifecycle');

    // The status alone proves nothing: a run with the inheritance deleted
    // completes too, just on the portal defaults. The generator echoes the
    // thresholds it actually ran with into the summary, so read them back off
    // the STORED run. 6/9 are the MSP row's; the portal defaults are 4/5.
    const [storedRun] = await withSystemDbAccessContext(() =>
      db.select({ result: reportRuns.result })
        .from(reportRuns)
        .where(eq(reportRuns.id, generated.id)),
    );

    const summary = (storedRun?.result as {
      summary?: { replaceAgeYears?: number; serverReplaceAgeYears?: number };
    } | null)?.summary;

    expect(summary).toBeTruthy();
    expect(summary?.replaceAgeYears).toBe(6);
    expect(summary?.serverReplaceAgeYears).toBe(9);

    // The MSP row's single site must not have narrowed the portal run: the
    // portal definition is deliberately org-wide, and the MSP scope can name
    // sites this portal user cannot see.
    const [portalDefinition] = await withSystemDbAccessContext(() =>
      db.select({ config: reports.config })
        .from(reports)
        .where(eq(reports.id, generated.reportId)),
    );
    expect((portalDefinition?.config as { sites?: string[] })?.sites)
      .toEqual([]);
    expect((portalDefinition?.config as { sites?: string[] })?.sites)
      .not.toContain(otherSiteId);
  });
});
