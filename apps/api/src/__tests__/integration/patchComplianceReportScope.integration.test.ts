import './setup';

import { readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { db, withSystemDbAccessContext } from '../../db';
import {
  devicePatches,
  devices,
  organizationUsers,
  patchComplianceReports,
  patches,
} from '../../db/schema';
import {
  enqueuePatchComplianceReport,
  getPatchComplianceReportQueue,
  isStalledLimitFailure,
  markStalledPatchComplianceReportFailed,
  processPatchComplianceReportJob,
  shutdownPatchComplianceReportWorker,
  PATCH_COMPLIANCE_REPORT_LOCK_DURATION_MS,
} from '../../jobs/patchComplianceReportWorker';
import { patchRoutes } from '../../routes/patches';
import {
  persistedSiteScopeValues,
  siteScopeFingerprint,
  type UserReportExecutionAuthority,
} from '../../services/siteScope';
import { createSite, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL && !!process.env.DATABASE_URL_APP);
const outputPaths: string[] = [];

afterEach(async () => {
  await shutdownPatchComplianceReportWorker();
  await Promise.all(outputPaths.splice(0).map((outputPath) =>
    unlink(outputPath).catch(() => undefined),
  ));
});

describe('patch compliance report site-scope boundary', () => {
  runDb('counts only current visible devices and fails closed after live scope revocation', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [
        { resource: 'reports', action: 'read' },
        { resource: 'reports', action: 'export' },
      ],
    });
    const hiddenSite = await createSite({ orgId: env.organization.id });

    const seeded = await withSystemDbAccessContext(async () => {
      await db.update(organizationUsers)
        .set({ siteIds: [env.site.id] })
        .where(eq(organizationUsers.userId, env.user.id));

      const insertedDevices = await db.insert(devices).values([
        {
          orgId: env.organization.id,
          siteId: env.site.id,
          agentId: `patch-report-visible-${Date.now()}`,
          hostname: 'patch-report-visible',
          osType: 'windows',
          osVersion: '11',
          architecture: 'x86_64',
          agentVersion: 'test',
          status: 'offline',
          isEphemeral: false,
        },
        {
          orgId: env.organization.id,
          siteId: hiddenSite.id,
          agentId: `patch-report-hidden-${Date.now()}`,
          hostname: 'patch-report-hidden',
          osType: 'windows',
          osVersion: '11',
          architecture: 'x86_64',
          agentVersion: 'test',
          status: 'offline',
          isEphemeral: false,
        },
      ]).returning({ id: devices.id });
      const [catalogPatch] = await db.insert(patches).values({
        source: 'microsoft',
        externalId: `patch-report-${Date.now()}`,
        title: 'Synthetic patch report fixture',
        severity: 'critical',
      }).returning({ id: patches.id });
      await db.insert(devicePatches).values(insertedDevices.map((device) => ({
        orgId: env.organization.id,
        deviceId: device.id,
        patchId: catalogPatch!.id,
        status: 'pending' as const,
      })));
      return { visibleDeviceId: insertedDevices[0]!.id };
    });

    const scope = {
      version: 1 as const,
      kind: 'restricted' as const,
      orgId: env.organization.id,
      siteIds: [env.site.id],
    };
    const authority: UserReportExecutionAuthority = {
      principalKind: 'user',
      scope,
      principalUserId: env.user.id,
      capturedAt: new Date(),
      fingerprint: siteScopeFingerprint(scope),
    };

    const firstReport = await withSystemDbAccessContext(async () => {
      const [row] = await db.insert(patchComplianceReports).values({
        orgId: env.organization.id,
        requestedBy: env.user.id,
        format: 'csv',
        status: 'pending',
        ...persistedSiteScopeValues(authority),
      }).returning({ id: patchComplianceReports.id });
      return row!;
    });

    const firstResult = await processPatchComplianceReportJob({
      type: 'generate-compliance-report',
      reportId: firstReport.id,
    });
    expect(firstResult?.rowCount).toBe(1);
    outputPaths.push(firstResult!.outputPath);

    await withSystemDbAccessContext(async () => {
      await db.update(devices)
        .set({ siteId: hiddenSite.id })
        .where(eq(devices.id, seeded.visibleDeviceId));
    });
    const movedReport = await withSystemDbAccessContext(async () => {
      const [row] = await db.insert(patchComplianceReports).values({
        orgId: env.organization.id,
        requestedBy: env.user.id,
        format: 'csv',
        status: 'pending',
        ...persistedSiteScopeValues(authority),
      }).returning({ id: patchComplianceReports.id });
      return row!;
    });
    const movedResult = await processPatchComplianceReportJob({
      type: 'generate-compliance-report',
      reportId: movedReport.id,
    });
    expect(movedResult?.rowCount).toBe(0);
    outputPaths.push(movedResult!.outputPath);

    await withSystemDbAccessContext(async () => {
      await db.update(organizationUsers)
        .set({ siteIds: [hiddenSite.id] })
        .where(eq(organizationUsers.userId, env.user.id));
    });
    const revokedReport = await withSystemDbAccessContext(async () => {
      const [row] = await db.insert(patchComplianceReports).values({
        orgId: env.organization.id,
        requestedBy: env.user.id,
        format: 'csv',
        status: 'pending',
        ...persistedSiteScopeValues(authority),
      }).returning({ id: patchComplianceReports.id });
      return row!;
    });

    const concurrentDeliveries = await Promise.allSettled([
      processPatchComplianceReportJob({
        type: 'generate-compliance-report',
        reportId: revokedReport.id,
      }),
      processPatchComplianceReportJob({
        type: 'generate-compliance-report',
        reportId: revokedReport.id,
      }),
    ]);
    expect(concurrentDeliveries.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(concurrentDeliveries.filter((result) =>
      result.status === 'fulfilled' && result.value === null,
    )).toHaveLength(1);
    const [failed] = await withSystemDbAccessContext(() => db
      .select({ status: patchComplianceReports.status, outputPath: patchComplianceReports.outputPath })
      .from(patchComplianceReports)
      .where(eq(patchComplianceReports.id, revokedReport.id))
      .limit(1));
    expect(failed).toEqual({ status: 'failed', outputPath: null });
  });

  runDb('classifies active legacy rows fail closed and preserves current envelopes on idempotent replay', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const scope = {
      version: 1 as const,
      kind: 'restricted' as const,
      orgId: env.organization.id,
      siteIds: [env.site.id],
    };
    const authority: UserReportExecutionAuthority = {
      principalKind: 'user',
      scope,
      principalUserId: env.user.id,
      capturedAt: new Date(),
      fingerprint: siteScopeFingerprint(scope),
    };

    const [legacy, current] = await getTestDb().insert(patchComplianceReports).values([
      {
        orgId: env.organization.id,
        requestedBy: env.user.id,
        format: 'csv',
        status: 'pending',
      },
      {
        orgId: env.organization.id,
        requestedBy: env.user.id,
        format: 'csv',
        status: 'pending',
        ...persistedSiteScopeValues(authority),
      },
    ]).returning({ id: patchComplianceReports.id });

    const migrationPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../migrations/2026-10-15-160120-patch-compliance-report-site-scope.sql',
    );
    const migrationSql = await readFile(migrationPath, 'utf8');
    await getTestDb().execute(sql.raw(migrationSql));
    await getTestDb().execute(sql.raw(migrationSql));

    const rows = await getTestDb().select({
      id: patchComplianceReports.id,
      status: patchComplianceReports.status,
      scopeKind: patchComplianceReports.executionScopeKind,
      siteIds: patchComplianceReports.executionScopeSiteIds,
      errorMessage: patchComplianceReports.errorMessage,
    }).from(patchComplianceReports);
    const legacyAfter = rows.find((row) => row.id === legacy!.id);
    const currentAfter = rows.find((row) => row.id === current!.id);
    expect(legacyAfter).toEqual(expect.objectContaining({
      status: 'failed',
      scopeKind: 'legacy_unscoped',
      siteIds: null,
      errorMessage: 'Report must be regenerated after the authorization-scope upgrade',
    }));
    expect(currentAfter).toEqual(expect.objectContaining({
      status: 'pending',
      scopeKind: 'restricted',
      siteIds: [env.site.id],
      errorMessage: null,
    }));
  });

  runDb('serves status and download only while current authority contains the stored scope', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [
        { resource: 'reports', action: 'read' },
        { resource: 'reports', action: 'export' },
      ],
    });
    const hiddenSite = await createSite({ orgId: env.organization.id });
    await withSystemDbAccessContext(() => db.update(organizationUsers)
      .set({ siteIds: [env.site.id] })
      .where(eq(organizationUsers.userId, env.user.id)));

    const scope = {
      version: 1 as const,
      kind: 'restricted' as const,
      orgId: env.organization.id,
      siteIds: [env.site.id],
    };
    const authority: UserReportExecutionAuthority = {
      principalKind: 'user',
      scope,
      principalUserId: env.user.id,
      capturedAt: new Date(),
      fingerprint: siteScopeFingerprint(scope),
    };
    const outputPath = path.join(os.tmpdir(), `breeze-patch-report-${Date.now()}.csv`);
    await writeFile(outputPath, 'metric,value\ntotal,"1"', 'utf8');
    outputPaths.push(outputPath);
    const [report] = await withSystemDbAccessContext(() => db
      .insert(patchComplianceReports)
      .values({
        orgId: env.organization.id,
        requestedBy: env.user.id,
        format: 'csv',
        status: 'completed',
        rowCount: 1,
        outputPath,
        ...persistedSiteScopeValues(authority),
      })
      .returning({ id: patchComplianceReports.id }));

    const app = new Hono();
    app.route('/patches', patchRoutes);
    const headers = { Authorization: `Bearer ${env.token}` };
    const statusAllowed = await app.request(
      `/patches/compliance/report/${report!.id}`,
      { headers },
    );
    expect(statusAllowed.status).toBe(200);
    const downloadAllowed = await app.request(
      `/patches/compliance/report/${report!.id}/download`,
      { headers },
    );
    expect(downloadAllowed.status).toBe(200);
    expect(await downloadAllowed.text()).toContain('total');

    await withSystemDbAccessContext(() => db.update(organizationUsers)
      .set({ siteIds: [hiddenSite.id] })
      .where(eq(organizationUsers.userId, env.user.id)));
    const statusDenied = await app.request(
      `/patches/compliance/report/${report!.id}`,
      { headers },
    );
    const downloadDenied = await app.request(
      `/patches/compliance/report/${report!.id}/download`,
      { headers },
    );
    expect(statusDenied.status).toBe(404);
    expect(downloadDenied.status).toBe(404);
  });

  runDb('serves a legacy envelope to an unrestricted reader and hides it from a site-restricted one', async () => {
    // The post-migration shape of a pre-SEC-095 report: classified
    // `legacy_unscoped`, no site list, fingerprint over the legacy envelope.
    // `persistedSiteScopeValues` cannot produce this (it only writes live
    // user/portal authorities), so the columns are written by hand — which is
    // also why this case needs the real decoder and the real database CHECK.
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [
        { resource: 'reports', action: 'read' },
        { resource: 'reports', action: 'export' },
      ],
    });

    const legacyScope = {
      version: 1 as const,
      kind: 'legacy_unscoped' as const,
      orgId: env.organization.id,
    };
    const outputPath = path.join(os.tmpdir(), `breeze-patch-report-legacy-${Date.now()}.csv`);
    await writeFile(outputPath, 'metric,value\ntotal,"1"', 'utf8');
    outputPaths.push(outputPath);
    const [report] = await withSystemDbAccessContext(() => db
      .insert(patchComplianceReports)
      .values({
        orgId: env.organization.id,
        requestedBy: env.user.id,
        format: 'csv',
        status: 'completed',
        rowCount: 1,
        outputPath,
        executionScopeVersion: 1,
        executionScopeKind: 'legacy_unscoped',
        executionScopeSiteIds: null,
        executionScopeUserId: env.user.id,
        executionScopeFingerprint: siteScopeFingerprint(legacyScope),
        executionScopeCapturedAt: new Date(),
        executionScopePrincipalKind: 'user',
      })
      .returning({ id: patchComplianceReports.id }));

    const app = new Hono();
    app.route('/patches', patchRoutes);
    const headers = { Authorization: `Bearer ${env.token}` };

    // The user carries no site narrowing, so live authority is org-wide
    // unrestricted, which DOES contain an unknown-scope org-wide row.
    const statusUnrestricted = await app.request(
      `/patches/compliance/report/${report!.id}`,
      { headers },
    );
    expect(statusUnrestricted.status).toBe(200);
    const downloadUnrestricted = await app.request(
      `/patches/compliance/report/${report!.id}/download`,
      { headers },
    );
    expect(downloadUnrestricted.status).toBe(200);
    expect(await downloadUnrestricted.text()).toContain('total');

    // Narrow the same user to one site: an unknown ceiling can no longer be
    // proven to sit inside theirs, so both routes go opaque.
    await withSystemDbAccessContext(() => db.update(organizationUsers)
      .set({ siteIds: [env.site.id] })
      .where(eq(organizationUsers.userId, env.user.id)));

    const statusRestricted = await app.request(
      `/patches/compliance/report/${report!.id}`,
      { headers },
    );
    const downloadRestricted = await app.request(
      `/patches/compliance/report/${report!.id}/download`,
      { headers },
    );
    expect(statusRestricted.status).toBe(404);
    expect(await statusRestricted.json()).toEqual({ error: 'Report not found' });
    expect(downloadRestricted.status).toBe(404);
    expect(await downloadRestricted.json()).toEqual({ error: 'Report not found' });
  });

  runDb('reclaims a running row abandoned past the job lock but leaves a fresh one alone', async () => {
    const env = await setupTestEnvironment({
      scope: 'organization',
      rolePermissions: [
        { resource: 'reports', action: 'read' },
        { resource: 'reports', action: 'export' },
      ],
    });
    const scope = {
      version: 1 as const,
      kind: 'restricted' as const,
      orgId: env.organization.id,
      siteIds: [env.site.id],
    };
    const authority: UserReportExecutionAuthority = {
      principalKind: 'user',
      scope,
      principalUserId: env.user.id,
      capturedAt: new Date(),
      fingerprint: siteScopeFingerprint(scope),
    };

    // An API restart mid-generation leaves this behind: BullMQ has long since
    // released the lock and redelivered, but the row still says `running`.
    const [stale, fresh] = await withSystemDbAccessContext(() => db
      .insert(patchComplianceReports)
      .values([
        {
          orgId: env.organization.id,
          requestedBy: env.user.id,
          format: 'csv',
          status: 'running',
          startedAt: new Date(Date.now() - PATCH_COMPLIANCE_REPORT_LOCK_DURATION_MS - 60_000),
          ...persistedSiteScopeValues(authority),
        },
        {
          orgId: env.organization.id,
          requestedBy: env.user.id,
          format: 'csv',
          status: 'running',
          startedAt: new Date(),
          ...persistedSiteScopeValues(authority),
        },
      ])
      .returning({ id: patchComplianceReports.id }));

    const reclaimed = await processPatchComplianceReportJob({
      type: 'generate-compliance-report',
      reportId: stale!.id,
    });
    expect(reclaimed).not.toBeNull();
    outputPaths.push(reclaimed!.outputPath);

    // A processor is presumed to still own this one; a redelivery must not
    // race it, so the job is a no-op and the row keeps its running state.
    const skipped = await processPatchComplianceReportJob({
      type: 'generate-compliance-report',
      reportId: fresh!.id,
    });
    expect(skipped).toBeNull();

    const rows = await withSystemDbAccessContext(() => db
      .select({
        id: patchComplianceReports.id,
        status: patchComplianceReports.status,
        outputPath: patchComplianceReports.outputPath,
      })
      .from(patchComplianceReports)
      .where(inArray(patchComplianceReports.id, [stale!.id, fresh!.id])));
    expect(rows.find((row) => row.id === stale!.id)).toEqual(expect.objectContaining({
      status: 'completed',
      outputPath: reclaimed!.outputPath,
    }));
    expect(rows.find((row) => row.id === fresh!.id)).toEqual(expect.objectContaining({
      status: 'running',
      outputPath: null,
    }));
  });

  runDb('marks a report BullMQ abandoned as failed rather than leaving it running', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const scope = {
      version: 1 as const,
      kind: 'restricted' as const,
      orgId: env.organization.id,
      siteIds: [env.site.id],
    };
    const authority: UserReportExecutionAuthority = {
      principalKind: 'user',
      scope,
      principalUserId: env.user.id,
      capturedAt: new Date(),
      fingerprint: siteScopeFingerprint(scope),
    };
    const [running, completed] = await withSystemDbAccessContext(() => db
      .insert(patchComplianceReports)
      .values([
        {
          orgId: env.organization.id,
          requestedBy: env.user.id,
          format: 'csv',
          status: 'running',
          startedAt: new Date(),
          ...persistedSiteScopeValues(authority),
        },
        {
          orgId: env.organization.id,
          requestedBy: env.user.id,
          format: 'csv',
          status: 'completed',
          rowCount: 0,
          outputPath: '/tmp/already-done.csv',
          ...persistedSiteScopeValues(authority),
        },
      ])
      .returning({ id: patchComplianceReports.id }));

    expect(isStalledLimitFailure(new Error('job stalled more than allowable limit'))).toBe(true);
    expect(isStalledLimitFailure(new Error('Report execution authority is no longer valid'))).toBe(false);

    await markStalledPatchComplianceReportFailed(running!.id);
    // A row a slow-but-successful processor already finished must survive.
    await markStalledPatchComplianceReportFailed(completed!.id);

    const rows = await withSystemDbAccessContext(() => db
      .select({
        id: patchComplianceReports.id,
        status: patchComplianceReports.status,
        errorMessage: patchComplianceReports.errorMessage,
      })
      .from(patchComplianceReports)
      .where(inArray(patchComplianceReports.id, [running!.id, completed!.id])));
    expect(rows.find((row) => row.id === running!.id)).toEqual(expect.objectContaining({
      status: 'failed',
      errorMessage: 'Report generation stalled and was abandoned; request the report again',
    }));
    expect(rows.find((row) => row.id === completed!.id)).toEqual(expect.objectContaining({
      status: 'completed',
      errorMessage: null,
    }));
  });

  runDb('stores only the report locator in the real Redis queue', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const scope = {
      version: 1 as const,
      kind: 'restricted' as const,
      orgId: env.organization.id,
      siteIds: [env.site.id],
    };
    const authority: UserReportExecutionAuthority = {
      principalKind: 'user',
      scope,
      principalUserId: env.user.id,
      capturedAt: new Date(),
      fingerprint: siteScopeFingerprint(scope),
    };
    const [report] = await withSystemDbAccessContext(() => db
      .insert(patchComplianceReports)
      .values({
        orgId: env.organization.id,
        requestedBy: env.user.id,
        format: 'csv',
        status: 'pending',
        ...persistedSiteScopeValues(authority),
      })
      .returning({ id: patchComplianceReports.id }));

    const queued = await enqueuePatchComplianceReport(report!.id);
    expect(queued.enqueued).toBe(true);
    const job = await getPatchComplianceReportQueue().getJob(queued.jobId!);
    expect(job?.data).toEqual({
      type: 'generate-compliance-report',
      reportId: report!.id,
    });
    await job?.remove();
  });
});
