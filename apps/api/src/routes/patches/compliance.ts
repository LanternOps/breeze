import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { readFile } from 'node:fs/promises';
import { and, eq, sql, inArray } from 'drizzle-orm';
import { requireScope } from '../../middleware/auth';
import { db } from '../../db';
import { writeRouteAudit } from '../../services/auditEvents';
import { enqueuePatchComplianceReport } from '../../jobs/patchComplianceReportWorker';
import {
  patches,
  devicePatches,
  patchApprovals,
  patchComplianceReports,
  devices
} from '../../db/schema';
import { complianceSchema, complianceReportSchema } from './schemas';
import { resolvePatchReportOrgId } from './helpers';

export const complianceRoutes = new Hono();

// GET /patches/compliance - Get compliance summary
complianceRoutes.get(
  '/compliance',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', complianceSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    if (query.orgId && !auth.canAccessOrg(query.orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    // Get devices scoped to org (or all accessible orgs for partner/system)
    const deviceConditions = [];
    if (query.orgId) {
      deviceConditions.push(eq(devices.orgId, query.orgId));
    } else {
      const orgCond = auth.orgCondition(devices.orgId);
      if (orgCond) {
        deviceConditions.push(orgCond);
      } else if (auth.scope !== 'system') {
        return c.json({ error: 'Organization context required' }, 400);
      }
    }

    const orgDevices = await db
      .select({ id: devices.id })
      .from(devices)
      .where(deviceConditions.length > 0 ? and(...deviceConditions) : undefined);

    const deviceIds = orgDevices.map(d => d.id);

    if (deviceIds.length === 0) {
      return c.json({
        data: {
          summary: { total: 0, pending: 0, installed: 0, failed: 0, missing: 0 },
          compliancePercent: 100,
          totalDevices: 0,
          compliantDevices: 0,
          criticalSummary: { total: 0, patched: 0, pending: 0 },
          importantSummary: { total: 0, patched: 0, pending: 0 },
          devicesNeedingPatches: []
        }
      });
    }

    // If ringId specified, scope to ring-approved patches only
    let ringPatchScope: string[] | null = null;
    if (query.ringId && query.orgId) {
      const ringApprovedPatches = await db
        .select({ patchId: patchApprovals.patchId })
        .from(patchApprovals)
        .where(
          and(
            eq(patchApprovals.orgId, query.orgId),
            eq(patchApprovals.ringId, query.ringId),
            eq(patchApprovals.status, 'approved')
          )
        );
      ringPatchScope = ringApprovedPatches.map(a => a.patchId);
    }

    // Get patch status counts
    const complianceConditions = [inArray(devicePatches.deviceId, deviceIds)];
    if (ringPatchScope !== null) {
      if (ringPatchScope.length === 0) {
        return c.json({
          data: {
            summary: { total: 0, pending: 0, installed: 0, failed: 0, missing: 0 },
            compliancePercent: 100,
            totalDevices: deviceIds.length,
            compliantDevices: deviceIds.length,
            criticalSummary: { total: 0, patched: 0, pending: 0 },
            importantSummary: { total: 0, patched: 0, pending: 0 },
            devicesNeedingPatches: [],
            ringId: query.ringId ?? null
          }
        });
      }
      complianceConditions.push(inArray(devicePatches.patchId, ringPatchScope));
    }
    if (query.source) {
      complianceConditions.push(eq(patches.source, query.source));
    }
    if (query.severity) {
      complianceConditions.push(eq(patches.severity, query.severity));
    }

    const statusCounts = await db
      .select({
        status: devicePatches.status,
        count: sql<number>`count(*)`
      })
      .from(devicePatches)
      .innerJoin(patches, eq(devicePatches.patchId, patches.id))
      .where(and(...complianceConditions))
      .groupBy(devicePatches.status);

    const summary = {
      total: 0,
      pending: 0,
      installed: 0,
      failed: 0,
      missing: 0,
      skipped: 0
    };

    for (const row of statusCounts) {
      const count = Number(row.count);
      summary.total += count;
      if (row.status in summary) {
        summary[row.status as keyof typeof summary] = count;
      }
    }

    const compliancePercent = summary.total > 0
      ? Math.round((summary.installed / summary.total) * 100)
      : 100;

    // Per-device patch breakdown for "devices needing patches" table
    const deviceBreakdown = await db
      .select({
        deviceId: devicePatches.deviceId,
        hostname: devices.hostname,
        osType: devices.osType,
        lastSeenAt: devices.lastSeenAt,
        missingCount: sql<number>`count(*) filter (where ${devicePatches.status} in ('pending', 'missing'))`,
        criticalCount: sql<number>`count(*) filter (where ${devicePatches.status} in ('pending', 'missing') and ${patches.severity} = 'critical')`,
        importantCount: sql<number>`count(*) filter (where ${devicePatches.status} in ('pending', 'missing') and ${patches.severity} = 'important')`,
        osMissing: sql<number>`count(*) filter (where ${devicePatches.status} in ('pending', 'missing') and ${patches.source} in ('microsoft', 'apple', 'linux'))`,
        thirdPartyMissing: sql<number>`count(*) filter (where ${devicePatches.status} in ('pending', 'missing') and ${patches.source} in ('third_party', 'custom'))`,
        lastInstalledAt: sql<string | null>`max(case when ${devicePatches.status} = 'installed' and ${devicePatches.installedAt} is not null then ${devicePatches.installedAt}::timestamptz::text end)`,
        pendingReboot: sql<boolean>`bool_or(${patches.requiresReboot} and ${devicePatches.status} = 'installed' and ${devicePatches.installedAt} is not null)`,
        lastScannedAt: sql<string | null>`max(${devicePatches.lastCheckedAt})::timestamptz::text`
      })
      .from(devicePatches)
      .innerJoin(patches, eq(devicePatches.patchId, patches.id))
      .innerJoin(devices, eq(devicePatches.deviceId, devices.id))
      .where(and(...complianceConditions))
      .groupBy(devicePatches.deviceId, devices.hostname, devices.osType, devices.lastSeenAt)
      .having(sql`count(*) filter (where ${devicePatches.status} in ('pending', 'missing')) > 0`)
      .orderBy(sql`count(*) filter (where ${devicePatches.status} in ('pending', 'missing') and ${patches.severity} = 'critical') desc`);

    const devicesNeedingPatches = deviceBreakdown.map(row => ({
      id: row.deviceId,
      name: row.hostname,
      os: row.osType,
      missingCount: Number(row.missingCount),
      criticalCount: Number(row.criticalCount),
      importantCount: Number(row.importantCount),
      osMissing: Number(row.osMissing),
      thirdPartyMissing: Number(row.thirdPartyMissing),
      lastInstalledAt: row.lastInstalledAt ?? undefined,
      pendingReboot: row.pendingReboot ?? false,
      lastScannedAt: row.lastScannedAt ?? undefined,
      lastSeen: row.lastSeenAt?.toISOString() ?? undefined
    }));

    // Severity-level summaries
    const severityCounts = await db
      .select({
        severity: patches.severity,
        total: sql<number>`count(*)`,
        installed: sql<number>`count(*) filter (where ${devicePatches.status} = 'installed')`
      })
      .from(devicePatches)
      .innerJoin(patches, eq(devicePatches.patchId, patches.id))
      .where(and(...complianceConditions))
      .groupBy(patches.severity);

    const severityMap: Record<string, { total: number; patched: number; pending: number }> = {};
    for (const row of severityCounts) {
      const key = row.severity ?? 'unknown';
      const total = Number(row.total);
      const patched = Number(row.installed);
      severityMap[key] = { total, patched, pending: total - patched };
    }

    // Device-level compliance: a device is compliant if it has zero pending/missing patches
    const compliantDeviceCount = deviceIds.length - devicesNeedingPatches.length;

    return c.json({
      data: {
        summary,
        compliancePercent,
        totalDevices: deviceIds.length,
        compliantDevices: compliantDeviceCount,
        criticalSummary: severityMap['critical'] ?? { total: 0, patched: 0, pending: 0 },
        importantSummary: severityMap['important'] ?? { total: 0, patched: 0, pending: 0 },
        devicesNeedingPatches,
        filters: {
          source: query.source ?? null,
          severity: query.severity ?? null,
          ringId: query.ringId ?? null
        }
      }
    });
  }
);

// GET /patches/compliance/report - Generate compliance report
complianceRoutes.get(
  '/compliance/report',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', complianceReportSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const orgResolution = resolvePatchReportOrgId(auth, query.orgId);
    if ('error' in orgResolution) {
      return c.json({ error: orgResolution.error }, orgResolution.status);
    }
    const targetOrgId = orgResolution.orgId;

    const [report] = await db
      .insert(patchComplianceReports)
      .values({
        orgId: targetOrgId,
        requestedBy: auth.user.id,
        source: query.source ?? null,
        severity: query.severity ?? null,
        format: query.format ?? 'csv',
        status: 'pending'
      })
      .returning({
        id: patchComplianceReports.id,
        orgId: patchComplianceReports.orgId,
        status: patchComplianceReports.status,
        format: patchComplianceReports.format
      });

    if (!report) {
      return c.json({ error: 'Failed to create compliance report request' }, 500);
    }

    await enqueuePatchComplianceReport(report.id);

    writeRouteAudit(c, {
      orgId: targetOrgId,
      action: 'patch.compliance.report.queue',
      resourceType: 'patch_compliance_report',
      resourceId: report.id,
      details: {
        format: report.format,
        source: query.source ?? null,
        severity: query.severity ?? null
      }
    });

    return c.json({
      reportId: report.id,
      status: 'queued',
      format: report.format,
      source: query.source ?? null,
      severity: query.severity ?? null
    });
  }
);

// GET /patches/compliance/report/:id - Report status
complianceRoutes.get(
  '/compliance/report/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const reportId = c.req.param('id')!;

    const [report] = await db
      .select({
        id: patchComplianceReports.id,
        orgId: patchComplianceReports.orgId,
        status: patchComplianceReports.status,
        format: patchComplianceReports.format,
        source: patchComplianceReports.source,
        severity: patchComplianceReports.severity,
        summary: patchComplianceReports.summary,
        rowCount: patchComplianceReports.rowCount,
        errorMessage: patchComplianceReports.errorMessage,
        startedAt: patchComplianceReports.startedAt,
        completedAt: patchComplianceReports.completedAt,
        createdAt: patchComplianceReports.createdAt,
        outputPath: patchComplianceReports.outputPath
      })
      .from(patchComplianceReports)
      .where(eq(patchComplianceReports.id, reportId))
      .limit(1);

    if (!report) {
      return c.json({ error: 'Report not found' }, 404);
    }

    if (!auth.canAccessOrg(report.orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    return c.json({
      data: {
        id: report.id,
        status: report.status,
        format: report.format,
        source: report.source,
        severity: report.severity,
        summary: report.summary,
        rowCount: report.rowCount,
        errorMessage: report.errorMessage,
        startedAt: report.startedAt,
        completedAt: report.completedAt,
        createdAt: report.createdAt,
        downloadUrl: report.outputPath
          ? `/api/v1/patches/compliance/report/${report.id}/download`
          : null
      }
    });
  }
);

// GET /patches/compliance/report/:id/download - Download completed report file
complianceRoutes.get(
  '/compliance/report/:id/download',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const reportId = c.req.param('id')!;

    const [report] = await db
      .select({
        id: patchComplianceReports.id,
        orgId: patchComplianceReports.orgId,
        status: patchComplianceReports.status,
        format: patchComplianceReports.format,
        outputPath: patchComplianceReports.outputPath
      })
      .from(patchComplianceReports)
      .where(eq(patchComplianceReports.id, reportId))
      .limit(1);

    if (!report) {
      return c.json({ error: 'Report not found' }, 404);
    }

    if (!auth.canAccessOrg(report.orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    if (report.status !== 'completed') {
      return c.json({ error: 'Report is not ready for download' }, 409);
    }

    if (!report.outputPath) {
      return c.json({ error: 'Report output is unavailable' }, 404);
    }

    try {
      const file = await readFile(report.outputPath);
      const extension = report.format === 'pdf' ? 'pdf' : 'csv';
      const contentType = report.format === 'pdf' ? 'application/pdf' : 'text/csv; charset=utf-8';

      c.header('Content-Type', contentType);
      c.header('Content-Disposition', `attachment; filename=\"patch-compliance-${report.id}.${extension}\"`);
      c.header('Cache-Control', 'no-store');

      return c.body(file);
    } catch {
      return c.json({ error: 'Report file not found' }, 404);
    }
  }
);
