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
