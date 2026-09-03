import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  type DbAccessContext,
} from '../../db';
import {
  backupConfigs,
  backupJobs,
  backupVerifications,
  devices,
  portalUsers,
  reports,
  reportRuns,
  securityPostureOrgSnapshots,
  securityStatus,
  sites,
  tickets,
  timeEntries,
} from '../../db/schema';
import {
  supportUsageForOrg,
} from '../../services/portal/supportUsage';
import { patchesAppliedTile } from '../../services/portal/patchReadModel';
import {
  createOrganization,
  createPartner,
  createUser,
} from './db-utils';
import { getTestDb } from './setup';

async function seedDevice(
  admin: ReturnType<typeof getTestDb>,
  orgId: string,
  label: string,
) {
  const [site] = await admin
    .insert(sites)
    .values({ orgId, name: `${label} Site` })
    .returning({ id: sites.id });
  if (!site) throw new Error('site insert failed');

  const [device] = await admin
    .insert(devices)
    .values({
      orgId,
      siteId: site.id,
      agentId: `${label}-${randomUUID()}`,
      hostname: `${label}-host`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: 'test',
      status: 'online',
    })
    .returning({ id: devices.id });
  if (!device) throw new Error('device insert failed');

  return device.id;
}

describe('portal visibility RLS', () => {
  it('hides organization B evidence from organization A', async () => {
    const admin = getTestDb();
    const partner = await createPartner();
    const orgA = await createOrganization({
      partnerId: partner.id,
    });
    const orgB = await createOrganization({
      partnerId: partner.id,
    });
    const technician = await createUser({
      partnerId: partner.id,
      orgId: null,
    });

    const [portalA] = await admin
      .insert(portalUsers)
      .values({
        orgId: orgA.id,
        email: `portal-${randomUUID()}@example.test`,
        name: 'Portal A',
        status: 'active',
      })
      .returning({ id: portalUsers.id });
    if (!portalA) throw new Error('portal user insert failed');

    const deviceA = await seedDevice(admin, orgA.id, 'a');
    const deviceB = await seedDevice(admin, orgB.id, 'b');

    await admin.insert(securityStatus).values([
      {
        orgId: orgA.id,
        deviceId: deviceA,
        provider: 'windows_defender',
        realTimeProtection: true,
        avProducts: [{ displayName: 'Defender' }],
      },
      {
        orgId: orgB.id,
        deviceId: deviceB,
        provider: 'windows_defender',
        realTimeProtection: true,
        avProducts: [{ displayName: 'Defender' }],
      },
    ]);

    const score = {
      overallScore: 80,
      devicesAudited: 1,
      lowRiskDevices: 1,
      mediumRiskDevices: 0,
      highRiskDevices: 0,
      criticalRiskDevices: 0,
      patchComplianceScore: 80,
      encryptionScore: 80,
      avHealthScore: 80,
      firewallScore: 80,
      openPortsScore: 80,
      passwordPolicyScore: 80,
      osCurrencyScore: 80,
      adminExposureScore: 80,
    };

    await admin.insert(securityPostureOrgSnapshots).values([
      { orgId: orgA.id, ...score },
      { orgId: orgB.id, ...score },
    ]);

    const configs = await admin
      .insert(backupConfigs)
      .values([
        {
          orgId: orgA.id,
          name: 'A',
          type: 'file',
          provider: 'local',
          providerConfig: {},
        },
        {
          orgId: orgB.id,
          name: 'B',
          type: 'file',
          provider: 'local',
          providerConfig: {},
        },
      ])
      .returning({
        id: backupConfigs.id,
        orgId: backupConfigs.orgId,
      });
    const configByOrg = new Map(
      configs.map((row) => [row.orgId, row.id]),
    );

    const jobs = await admin
      .insert(backupJobs)
      .values([
        {
          orgId: orgA.id,
          configId: configByOrg.get(orgA.id)!,
          deviceId: deviceA,
          status: 'completed',
        },
        {
          orgId: orgB.id,
          configId: configByOrg.get(orgB.id)!,
          deviceId: deviceB,
          status: 'completed',
        },
      ])
      .returning({
        id: backupJobs.id,
        orgId: backupJobs.orgId,
      });
    const jobByOrg = new Map(
      jobs.map((row) => [row.orgId, row.id]),
    );

    await admin.insert(backupVerifications).values([
      {
        orgId: orgA.id,
        deviceId: deviceA,
        backupJobId: jobByOrg.get(orgA.id)!,
        verificationType: 'integrity',
        status: 'passed',
        startedAt: new Date(),
        completedAt: new Date(),
      },
      {
        orgId: orgB.id,
        deviceId: deviceB,
        backupJobId: jobByOrg.get(orgB.id)!,
        verificationType: 'integrity',
        status: 'passed',
        startedAt: new Date(),
        completedAt: new Date(),
      },
    ]);

    const reportRows = await admin
      .insert(reports)
      .values([
        {
          orgId: orgA.id,
          name: 'A',
          type: 'device_inventory',
          config: {},
          schedule: 'one_time',
          format: 'csv',
        },
        {
          orgId: orgB.id,
          name: 'B',
          type: 'device_inventory',
          config: {},
          schedule: 'one_time',
          format: 'csv',
        },
      ])
      .returning({
        id: reports.id,
        orgId: reports.orgId,
      });
    const reportByOrg = new Map(
      reportRows.map((row) => [row.orgId, row.id]),
    );

    const runs = await admin
      .insert(reportRuns)
      .values([
        {
          reportId: reportByOrg.get(orgA.id)!,
          status: 'completed',
        },
        {
          reportId: reportByOrg.get(orgB.id)!,
          status: 'completed',
        },
      ])
      .returning({
        id: reportRuns.id,
        reportId: reportRuns.reportId,
      });
    const runA = runs.find(
      (row) => row.reportId === reportByOrg.get(orgA.id),
    )!.id;
    const runB = runs.find(
      (row) => row.reportId === reportByOrg.get(orgB.id),
    )!.id;

    const [ticketA] = await admin
      .insert(tickets)
      .values({
        orgId: orgA.id,
        partnerId: partner.id,
        ticketNumber: `A-${randomUUID()}`,
        subject: 'A visible',
        source: 'portal',
      })
      .returning({ id: tickets.id });
    if (!ticketA) throw new Error('ticket insert failed');

    await admin.insert(timeEntries).values({
      partnerId: partner.id,
      orgId: orgA.id,
      ticketId: ticketA.id,
      userId: technician.id,
      startedAt: new Date(),
      endedAt: new Date(),
      durationMinutes: 45,
      isBillable: true,
      billingStatus: 'billed',
      isApproved: true,
      currencyCode: 'USD',
    });

    const [ticketB] = await admin
      .insert(tickets)
      .values({
        orgId: orgB.id,
        partnerId: partner.id,
        ticketNumber: `B-${randomUUID()}`,
        subject: 'B secret',
        source: 'portal',
      })
      .returning({ id: tickets.id });
    if (!ticketB) throw new Error('ticket insert failed');

    await admin.insert(timeEntries).values({
      partnerId: partner.id,
      orgId: orgB.id,
      ticketId: ticketB.id,
      userId: technician.id,
      startedAt: new Date(),
      endedAt: new Date(),
      durationMinutes: 75,
      isBillable: true,
      billingStatus: 'billed',
      isApproved: true,
      currencyCode: 'USD',
    });

    const context: DbAccessContext = {
      scope: 'organization',
      orgId: orgA.id,
      accessibleOrgIds: [orgA.id],
      accessiblePartnerIds: [],
      userId: null,
      currentPartnerId: null,
    };

    await withDbAccessContext(context, async () => {
      expect(
        (await db.select({
          orgId: securityStatus.orgId,
        }).from(securityStatus)).map((row) => row.orgId),
      ).toEqual([orgA.id]);

      expect(
        (await db.select({
          orgId: securityPostureOrgSnapshots.orgId,
        }).from(securityPostureOrgSnapshots))
          .map((row) => row.orgId),
      ).toEqual([orgA.id]);

      expect(
        (await db.select({
          orgId: backupVerifications.orgId,
        }).from(backupVerifications)).map((row) => row.orgId),
      ).toEqual([orgA.id]);

      const visibleRuns = await db
        .select({ id: reportRuns.id })
        .from(reportRuns);
      expect(visibleRuns.map((row) => row.id)).toContain(runA);
      expect(visibleRuns.map((row) => row.id)).not.toContain(runB);

      await expect(
        db.select({ id: timeEntries.id }).from(timeEntries),
      ).resolves.toEqual([]);

      const usage = await supportUsageForOrg({
        orgId: orgA.id,
        month: new Date().toISOString().slice(0, 7),
        timezone: 'UTC',
        portalUserId: portalA.id,
      });

      // Positive control: org A's own billed time entry must surface a
      // non-zero minutes value — proving the query actually reads org A's
      // rows, not merely that it excludes org B's.
      expect(usage.totals.billed.minutes).toBe(45);
      expect(usage.totals.toBeBilled.minutes).toBe(0);
      expect(usage.totals.coveredByContract.minutes).toBe(0);
      expect(usage.totals.pendingReview.minutes).toBe(0);
    });
  });

  it('resolves the month boundary in the caller-supplied timezone, not UTC', async () => {
    const admin = getTestDb();
    const partner = await createPartner();
    const orgA = await createOrganization({
      partnerId: partner.id,
    });
    const technician = await createUser({
      partnerId: partner.id,
      orgId: null,
    });

    const [portalA] = await admin
      .insert(portalUsers)
      .values({
        orgId: orgA.id,
        email: `portal-${randomUUID()}@example.test`,
        name: 'Portal A',
        status: 'active',
      })
      .returning({ id: portalUsers.id });
    if (!portalA) throw new Error('portal user insert failed');

    const [ticketAug] = await admin
      .insert(tickets)
      .values({
        orgId: orgA.id,
        partnerId: partner.id,
        ticketNumber: `AUG-${randomUUID()}`,
        subject: 'Straddles into August in Denver',
        source: 'portal',
      })
      .returning({ id: tickets.id });
    if (!ticketAug) throw new Error('ticket insert failed');

    // 2026-09-01T03:00:00Z is 2026-08-31T21:00:00 in America/Denver
    // (UTC-6 in summer) — belongs to the August 2026 window in Denver,
    // but to September in UTC.
    await admin.insert(timeEntries).values({
      partnerId: partner.id,
      orgId: orgA.id,
      ticketId: ticketAug.id,
      userId: technician.id,
      startedAt: new Date('2026-09-01T03:00:00Z'),
      endedAt: new Date('2026-09-01T03:30:00Z'),
      durationMinutes: 30,
      isBillable: true,
      billingStatus: 'billed',
      isApproved: true,
      currencyCode: 'USD',
    });

    const [ticketJul] = await admin
      .insert(tickets)
      .values({
        orgId: orgA.id,
        partnerId: partner.id,
        ticketNumber: `JUL-${randomUUID()}`,
        subject: 'Belongs to July in Denver',
        source: 'portal',
      })
      .returning({ id: tickets.id });
    if (!ticketJul) throw new Error('ticket insert failed');

    // 2026-08-01T04:00:00Z is 2026-07-31T22:00:00 in America/Denver —
    // belongs to July in Denver (excluded from the August window), but
    // to August in UTC.
    await admin.insert(timeEntries).values({
      partnerId: partner.id,
      orgId: orgA.id,
      ticketId: ticketJul.id,
      userId: technician.id,
      startedAt: new Date('2026-08-01T04:00:00Z'),
      endedAt: new Date('2026-08-01T04:20:00Z'),
      durationMinutes: 20,
      isBillable: true,
      billingStatus: 'billed',
      isApproved: true,
      currencyCode: 'USD',
    });

    const context: DbAccessContext = {
      scope: 'organization',
      orgId: orgA.id,
      accessibleOrgIds: [orgA.id],
      accessiblePartnerIds: [],
      userId: null,
      currentPartnerId: null,
    };

    await withDbAccessContext(context, async () => {
      const denverUsage = await supportUsageForOrg({
        orgId: orgA.id,
        month: '2026-08',
        timezone: 'America/Denver',
        portalUserId: portalA.id,
      });

      // Only the entry that falls in Denver's August window counts; the
      // one that is August only in UTC must be excluded.
      expect(denverUsage.totals.billed.minutes).toBe(30);

      const utcUsage = await supportUsageForOrg({
        orgId: orgA.id,
        month: '2026-08',
        timezone: 'UTC',
        portalUserId: portalA.id,
      });

      // Under UTC, the first entry (Sep 1 03:00Z) is September and stays
      // excluded, while the second entry (Aug 1 04:00Z, July in Denver)
      // is now August and included — the two calls disagree on which
      // entry belongs to the month, which is only possible if the
      // boundary is actually computed in the caller's timezone rather
      // than always in UTC.
      expect(utcUsage.totals.billed.minutes).toBe(20);
    });
  });

  // #4562 W04 regression, surfaced by the W10 portal e2e: the month-window
  // anchor was bound as a JS Date inside a raw `sql` fragment, which the
  // postgres-js driver cannot serialize (`Buffer.byteLength` TypeError at bind
  // time), so every dashboard request 500ed. Unit tests compile the SQL and
  // never bind, so only a real database proves this.
  it('computes the patches tile against a real database', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({
      partnerId: partner.id,
    });
    const portalContext: DbAccessContext = {
      scope: 'organization',
      orgId: orgA.id,
      accessibleOrgIds: [orgA.id],
      accessiblePartnerIds: [],
      currentPartnerId: null,
      userId: null,
    };

    await expect(
      withDbAccessContext(portalContext, () =>
        patchesAppliedTile(orgA.id, {
          timezone: 'America/Denver',
          now: new Date('2026-09-02T12:00:00Z'),
        }),
      ),
    ).resolves.toMatchObject({
      status: 'no_data',
      month: '2026-09',
      timezone: 'America/Denver',
    });
  });

  it('installs every portal visibility query index', async () => {
    const expected = [
      'device_patches_org_installed_at_idx',
      'security_threats_org_detected_at_idx',
      'security_threats_org_resolved_at_idx',
      's1_threats_org_detected_at_idx',
      's1_threats_org_resolved_at_idx',
      'huntress_incidents_org_reported_at_idx',
      'huntress_incidents_org_resolved_at_idx',
      'backup_verifications_org_completed_at_idx',
      'time_entries_org_started_at_idx',
    ];

    const result = (await getTestDb().execute(sql`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ${expected}
    `)) as unknown as Array<{ indexname: string }>;

    expect(new Set(result.map((row) => row.indexname)))
      .toEqual(new Set(expected));
  });
});
