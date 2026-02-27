import { createHash } from 'crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, gte, inArray, sql, type SQL } from 'drizzle-orm';

import { db } from '../db';
import {
  devices,
  sensitiveDataFindings,
  sensitiveDataPolicies,
  sensitiveDataScans
} from '../db/schema';
import { requireScope } from '../middleware/auth';
import { getPagination } from '../utils/pagination';
import { CommandTypes, queueCommand } from '../services/commandQueue';
import { enqueueSensitiveDataScan } from '../jobs/sensitiveDataJobs';
import { publishEvent } from '../services/eventBus';
import { resolveSensitiveDataKeySelection } from '../services/sensitiveDataKeys';
import {
  recordSensitiveDataRemediationDecision,
  recordSensitiveDataScanQueued
} from './metrics';

export const sensitiveDataRoutes = new Hono();

const dataTypeValues = ['pii', 'pci', 'phi', 'credential', 'financial'] as const;
const riskValues = ['low', 'medium', 'high', 'critical'] as const;
const findingStatusValues = ['open', 'remediated', 'accepted', 'false_positive'] as const;
const remediationActionValues = [
  'encrypt',
  'quarantine',
  'secure_delete',
  'accept_risk',
  'false_positive',
  'mark_remediated'
] as const;

const policyScopeSchema = z.object({
  includePaths: z.array(z.string().min(1).max(2048)).max(256).optional(),
  excludePaths: z.array(z.string().min(1).max(2048)).max(256).optional(),
  fileTypes: z.array(z.string().min(1).max(32)).max(128).optional(),
  maxFileSizeBytes: z.number().int().min(1024).max(1024 * 1024 * 1024).optional(),
  workers: z.number().int().min(1).max(32).optional(),
  timeoutSeconds: z.number().int().min(5).max(1800).optional(),
  suppressPaths: z.array(z.string().min(1).max(2048)).max(256).optional(),
  suppressPatternIds: z.array(z.string().min(1).max(80)).max(200).optional(),
  suppressFilePathRegex: z.array(z.string().min(1).max(300)).max(80).optional(),
  ruleToggles: z.record(z.boolean()).optional(),
}).strict();

const policyScheduleSchema = z.object({
  enabled: z.boolean().optional().default(true),
  type: z.enum(['manual', 'interval', 'cron']).default('manual'),
  intervalMinutes: z.number().int().min(5).max(7 * 24 * 60).optional(),
  cron: z.string().max(120).optional(),
  timezone: z.string().max(64).optional(),
  deviceIds: z.array(z.string().uuid()).max(1000).optional(),
}).strict();

const createPolicySchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1).max(200),
  scope: policyScopeSchema.default({}),
  detectionClasses: z.array(z.enum(dataTypeValues)).min(1).max(5),
  schedule: policyScheduleSchema.optional(),
  isActive: z.boolean().optional().default(true),
});

const updatePolicySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  scope: policyScopeSchema.optional(),
  detectionClasses: z.array(z.enum(dataTypeValues)).min(1).max(5).optional(),
  schedule: policyScheduleSchema.optional(),
  isActive: z.boolean().optional(),
});

const createScanSchema = z.object({
  deviceIds: z.array(z.string().uuid()).min(1).max(200),
  policyId: z.string().uuid().optional(),
  scope: policyScopeSchema.optional(),
  detectionClasses: z.array(z.enum(dataTypeValues)).min(1).max(5).optional(),
  idempotencyKey: z.string().min(8).max(128).optional(),
});

const reportQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  status: z.enum(findingStatusValues).optional(),
  risk: z.enum(riskValues).optional(),
  dataType: z.enum(dataTypeValues).optional(),
  deviceId: z.string().uuid().optional(),
  scanId: z.string().uuid().optional(),
});

const remediationsSchema = z.object({
  findingIds: z.array(z.string().uuid()).min(1).max(250),
  action: z.enum(remediationActionValues),
  confirm: z.boolean().optional(),
  dryRun: z.boolean().optional().default(false),
  secondApprovalToken: z.string().max(256).optional(),
  encryptionKeyRef: z.string().max(255).optional(),
  encryptionKeyVersion: z.string().max(100).optional(),
  quarantineDir: z.string().max(2048).optional(),
});

const scanIdParamSchema = z.object({
  id: z.string().uuid()
});

const policyIdParamSchema = z.object({
  id: z.string().uuid()
});

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function readOrgIdFromAuth(auth: {
  orgId: string | null;
  accessibleOrgIds: string[] | null;
  canAccessOrg: (orgId: string) => boolean;
}, requestedOrgId?: string): string | null {
  if (requestedOrgId) {
    return auth.canAccessOrg(requestedOrgId) ? requestedOrgId : null;
  }
  if (auth.orgId) return auth.orgId;
  if (auth.accessibleOrgIds && auth.accessibleOrgIds.length === 1) {
    return auth.accessibleOrgIds[0] ?? null;
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asIso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function normalizeDetectionClasses(input: unknown): Array<typeof dataTypeValues[number]> {
  if (!Array.isArray(input)) return [];
  const seen = new Set<typeof dataTypeValues[number]>();
  for (const value of input) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim().toLowerCase();
    if ((dataTypeValues as readonly string[]).includes(normalized)) {
      seen.add(normalized as typeof dataTypeValues[number]);
    }
  }
  return Array.from(seen);
}

function createRequestFingerprint(payload: {
  deviceIds: string[];
  policyId: string | null;
  scope: unknown;
  detectionClasses: unknown;
}): string {
  const normalized = {
    deviceIds: [...new Set(payload.deviceIds)].sort(),
    policyId: payload.policyId,
    scope: payload.scope ?? {},
    detectionClasses: normalizeDetectionClasses(payload.detectionClasses).sort()
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function parseSummaryCounters(summary: unknown): {
  total: number;
  byRisk: Record<string, number>;
  byStatus: Record<string, number>;
} | null {
  if (!isObject(summary)) return null;
  const findings = isObject(summary.findings) ? summary.findings : null;
  if (!findings) return null;
  const total = typeof findings.total === 'number' ? Math.max(0, Math.floor(findings.total)) : 0;
  const byRisk = isObject(findings.byRisk)
    ? Object.fromEntries(
      Object.entries(findings.byRisk)
        .filter(([, value]) => typeof value === 'number')
        .map(([key, value]) => [key, Math.max(0, Math.floor(value as number))])
    )
    : {};
  const byStatus = isObject(findings.byStatus)
    ? Object.fromEntries(
      Object.entries(findings.byStatus)
        .filter(([, value]) => typeof value === 'number')
        .map(([key, value]) => [key, Math.max(0, Math.floor(value as number))])
    )
    : {};
  return { total, byRisk, byStatus };
}

function shouldRequireSecondApproval(): boolean {
  return envFlag('SENSITIVE_DATA_REQUIRE_SECOND_APPROVAL', false);
}

function isSecondApprovalValid(token: string | undefined): boolean {
  const expected = process.env.SENSITIVE_DATA_SECOND_APPROVAL_TOKEN?.trim();
  if (!expected) return false;
  return token?.trim() === expected;
}

sensitiveDataRoutes.post(
  '/scan',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createScanSchema),
  async (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');
    const idempotencyHeader = c.req.header('Idempotency-Key');
    const idempotencyKey = payload.idempotencyKey ?? idempotencyHeader;

    let policyRow: typeof sensitiveDataPolicies.$inferSelect | undefined;
    if (payload.policyId) {
      const policyConditions: SQL[] = [eq(sensitiveDataPolicies.id, payload.policyId)];
      const orgCondition = auth.orgCondition(sensitiveDataPolicies.orgId);
      if (orgCondition) policyConditions.push(orgCondition);

      [policyRow] = await db
        .select()
        .from(sensitiveDataPolicies)
        .where(and(...policyConditions))
        .limit(1);

      if (!policyRow) return c.json({ error: 'Policy not found' }, 404);
      if (!policyRow.isActive) return c.json({ error: 'Policy is inactive' }, 400);
    }

    const requestedScope = payload.scope ?? (isObject(policyRow?.scope) ? policyRow.scope : {});
    const requestedClasses = payload.detectionClasses
      ?? normalizeDetectionClasses(policyRow?.detectionClasses);
    const resolvedClasses = requestedClasses.length > 0 ? requestedClasses : ['credential'];
    const requestFingerprint = createRequestFingerprint({
      deviceIds: payload.deviceIds,
      policyId: policyRow?.id ?? null,
      scope: requestedScope,
      detectionClasses: resolvedClasses,
    });

    if (idempotencyKey) {
      const dedupeConditions: SQL[] = [
        eq(sensitiveDataScans.idempotencyKey, idempotencyKey),
        eq(sensitiveDataScans.requestFingerprint, requestFingerprint),
        gte(sensitiveDataScans.createdAt, new Date(Date.now() - 24 * 60 * 60 * 1000)),
      ];
      const orgCondition = auth.orgCondition(sensitiveDataScans.orgId);
      if (orgCondition) dedupeConditions.push(orgCondition);

      const existing = await db
        .select({
          id: sensitiveDataScans.id,
          orgId: sensitiveDataScans.orgId,
          deviceId: sensitiveDataScans.deviceId,
          status: sensitiveDataScans.status,
          createdAt: sensitiveDataScans.createdAt
        })
        .from(sensitiveDataScans)
        .where(and(...dedupeConditions))
        .orderBy(desc(sensitiveDataScans.createdAt));

      if (existing.length > 0) {
        return c.json({
          data: {
            scans: existing,
            queued: existing.filter((scan) => scan.status === 'queued' || scan.status === 'running').length,
            enqueueFailures: 0,
            skippedDeviceIds: [],
            idempotentReuse: true
          }
        }, 200);
      }
    }

    const deviceConditions: SQL[] = [inArray(devices.id, payload.deviceIds)];
    const orgCondition = auth.orgCondition(devices.orgId);
    if (orgCondition) deviceConditions.push(orgCondition);

    const availableDevices = await db
      .select({
        id: devices.id,
        orgId: devices.orgId,
        hostname: devices.hostname,
        status: devices.status
      })
      .from(devices)
      .where(and(...deviceConditions));

    if (availableDevices.length === 0) {
      return c.json({ error: 'No accessible devices found for scan request' }, 404);
    }

    const byId = new Map(availableDevices.map((device) => [device.id, device]));
    const skippedDeviceIds = payload.deviceIds.filter((id) => !byId.has(id));

    const scanRows = availableDevices
      .filter((device) => device.status !== 'decommissioned')
      .map((device) => ({
        orgId: device.orgId,
        deviceId: device.id,
        policyId: policyRow?.id ?? null,
        requestedBy: auth.user.id,
        status: 'queued',
        idempotencyKey: idempotencyKey ?? null,
        requestFingerprint,
        summary: {
          source: 'manual',
          request: {
            scope: requestedScope,
            detectionClasses: resolvedClasses
          }
        }
      }));

    if (scanRows.length === 0) {
      return c.json({ error: 'No eligible devices available for scan' }, 400);
    }

    const createdScans = await db
      .insert(sensitiveDataScans)
      .values(scanRows)
      .returning({
        id: sensitiveDataScans.id,
        deviceId: sensitiveDataScans.deviceId,
        orgId: sensitiveDataScans.orgId
      });

    const enqueueResults = await Promise.allSettled(
      createdScans.map((scan) => enqueueSensitiveDataScan(scan.id))
    );

    const enqueueFailures = enqueueResults.filter((result) => result.status === 'rejected').length;
    recordSensitiveDataScanQueued(createdScans.length - enqueueFailures);

    return c.json({
      data: {
        scans: createdScans,
        queued: createdScans.length - enqueueFailures,
        enqueueFailures,
        skippedDeviceIds,
        idempotentReuse: false
      }
    }, 202);
  }
);

sensitiveDataRoutes.get(
  '/scans/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', scanIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const conditions: SQL[] = [eq(sensitiveDataScans.id, id)];
    const orgCondition = auth.orgCondition(sensitiveDataScans.orgId);
    if (orgCondition) conditions.push(orgCondition);

    const [scan] = await db
      .select({
        id: sensitiveDataScans.id,
        orgId: sensitiveDataScans.orgId,
        deviceId: sensitiveDataScans.deviceId,
        policyId: sensitiveDataScans.policyId,
        status: sensitiveDataScans.status,
        startedAt: sensitiveDataScans.startedAt,
        completedAt: sensitiveDataScans.completedAt,
        summary: sensitiveDataScans.summary,
        createdAt: sensitiveDataScans.createdAt,
        deviceName: devices.hostname
      })
      .from(sensitiveDataScans)
      .innerJoin(devices, eq(devices.id, sensitiveDataScans.deviceId))
      .where(and(...conditions))
      .limit(1);

    if (!scan) return c.json({ error: 'Scan not found' }, 404);

    const summaryCounters = parseSummaryCounters(scan.summary);
    if (summaryCounters) {
      return c.json({
        data: {
          id: scan.id,
          orgId: scan.orgId,
          deviceId: scan.deviceId,
          deviceName: scan.deviceName,
          policyId: scan.policyId,
          status: scan.status,
          startedAt: asIso(scan.startedAt),
          completedAt: asIso(scan.completedAt),
          createdAt: asIso(scan.createdAt),
          summary: scan.summary ?? {},
          findings: summaryCounters
        }
      });
    }

    const findings = await db
      .select({
        id: sensitiveDataFindings.id,
        risk: sensitiveDataFindings.risk,
        status: sensitiveDataFindings.status
      })
      .from(sensitiveDataFindings)
      .where(eq(sensitiveDataFindings.scanId, scan.id));

    const riskCounts: Record<string, number> = {};
    const statusCounts: Record<string, number> = {};
    for (const finding of findings) {
      riskCounts[finding.risk] = (riskCounts[finding.risk] ?? 0) + 1;
      statusCounts[finding.status] = (statusCounts[finding.status] ?? 0) + 1;
    }

    return c.json({
      data: {
        id: scan.id,
        orgId: scan.orgId,
        deviceId: scan.deviceId,
        deviceName: scan.deviceName,
        policyId: scan.policyId,
        status: scan.status,
        startedAt: asIso(scan.startedAt),
        completedAt: asIso(scan.completedAt),
        createdAt: asIso(scan.createdAt),
        summary: scan.summary ?? {},
        findings: {
          total: findings.length,
          byRisk: riskCounts,
          byStatus: statusCounts
        }
      }
    });
  }
);

sensitiveDataRoutes.get(
  '/report',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', reportQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const pagination = getPagination(query, 200);

    const conditions: SQL[] = [];
    const orgCondition = auth.orgCondition(sensitiveDataFindings.orgId);
    if (orgCondition) conditions.push(orgCondition);
    if (query.status) conditions.push(eq(sensitiveDataFindings.status, query.status));
    if (query.risk) conditions.push(eq(sensitiveDataFindings.risk, query.risk));
    if (query.dataType) conditions.push(eq(sensitiveDataFindings.dataType, query.dataType));
    if (query.deviceId) conditions.push(eq(sensitiveDataFindings.deviceId, query.deviceId));
    if (query.scanId) conditions.push(eq(sensitiveDataFindings.scanId, query.scanId));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(sensitiveDataFindings)
      .where(whereClause);
    const count = row?.count ?? 0;

    const rows = await db
      .select({
        id: sensitiveDataFindings.id,
        orgId: sensitiveDataFindings.orgId,
        deviceId: sensitiveDataFindings.deviceId,
        deviceName: devices.hostname,
        scanId: sensitiveDataFindings.scanId,
        filePath: sensitiveDataFindings.filePath,
        dataType: sensitiveDataFindings.dataType,
        patternId: sensitiveDataFindings.patternId,
        matchCount: sensitiveDataFindings.matchCount,
        risk: sensitiveDataFindings.risk,
        confidence: sensitiveDataFindings.confidence,
        fileOwner: sensitiveDataFindings.fileOwner,
        fileModifiedAt: sensitiveDataFindings.fileModifiedAt,
        firstSeenAt: sensitiveDataFindings.firstSeenAt,
        lastSeenAt: sensitiveDataFindings.lastSeenAt,
        occurrenceCount: sensitiveDataFindings.occurrenceCount,
        status: sensitiveDataFindings.status,
        remediationAction: sensitiveDataFindings.remediationAction,
        remediationMetadata: sensitiveDataFindings.remediationMetadata,
        remediatedAt: sensitiveDataFindings.remediatedAt,
        createdAt: sensitiveDataFindings.createdAt
      })
      .from(sensitiveDataFindings)
      .innerJoin(devices, eq(devices.id, sensitiveDataFindings.deviceId))
      .where(whereClause)
      .orderBy(desc(sensitiveDataFindings.lastSeenAt))
      .limit(pagination.limit)
      .offset(pagination.offset);

    const total = Number(count ?? 0);
    const totalPages = total === 0 ? 1 : Math.ceil(total / pagination.limit);

    return c.json({
      data: rows.map((row) => ({
        ...row,
        fileModifiedAt: asIso(row.fileModifiedAt),
        firstSeenAt: asIso(row.firstSeenAt),
        lastSeenAt: asIso(row.lastSeenAt),
        remediatedAt: asIso(row.remediatedAt),
        createdAt: asIso(row.createdAt),
      })),
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        totalPages
      }
    });
  }
);

sensitiveDataRoutes.get(
  '/dashboard',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const conditions: SQL[] = [];
    const orgCondition = auth.orgCondition(sensitiveDataFindings.orgId);
    if (orgCondition) conditions.push(orgCondition);
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select({
        dataType: sensitiveDataFindings.dataType,
        risk: sensitiveDataFindings.risk,
        status: sensitiveDataFindings.status,
        lastSeenAt: sensitiveDataFindings.lastSeenAt,
      })
      .from(sensitiveDataFindings)
      .where(whereClause);

    const now = Date.now();
    let openTotal = 0;
    let criticalOpen = 0;
    let remediated24h = 0;
    let sumOpenAgeHours = 0;
    const byDataType: Record<string, number> = {};
    const byRisk: Record<string, number> = {};

    for (const row of rows) {
      byDataType[row.dataType] = (byDataType[row.dataType] ?? 0) + 1;
      byRisk[row.risk] = (byRisk[row.risk] ?? 0) + 1;

      if (row.status === 'open') {
        openTotal++;
        if (row.risk === 'critical') criticalOpen++;
        if (row.lastSeenAt) {
          sumOpenAgeHours += Math.max(0, (now - row.lastSeenAt.getTime()) / (1000 * 60 * 60));
        }
      }
      if (row.status === 'remediated' && row.lastSeenAt && now - row.lastSeenAt.getTime() <= 24 * 60 * 60 * 1000) {
        remediated24h++;
      }
    }

    return c.json({
      data: {
        totals: {
          findings: rows.length,
          open: openTotal,
          criticalOpen,
          remediated24h,
          averageOpenAgeHours: openTotal > 0 ? Number((sumOpenAgeHours / openTotal).toFixed(2)) : 0,
        },
        byDataType,
        byRisk,
      }
    });
  }
);

sensitiveDataRoutes.post(
  '/remediate',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', remediationsSchema),
  async (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');

    const destructive = payload.action === 'encrypt'
      || payload.action === 'quarantine'
      || payload.action === 'secure_delete';

    if (destructive && payload.confirm !== true) {
      return c.json({ error: 'Destructive remediation actions require confirm=true' }, 400);
    }

    if (
      payload.action === 'secure_delete'
      && shouldRequireSecondApproval()
      && !isSecondApprovalValid(payload.secondApprovalToken)
    ) {
      return c.json({ error: 'secure_delete requires a valid secondApprovalToken' }, 400);
    }

    const conditions: SQL[] = [inArray(sensitiveDataFindings.id, payload.findingIds)];
    const orgCondition = auth.orgCondition(sensitiveDataFindings.orgId);
    if (orgCondition) conditions.push(orgCondition);

    const findings = await db
      .select({
        id: sensitiveDataFindings.id,
        orgId: sensitiveDataFindings.orgId,
        deviceId: sensitiveDataFindings.deviceId,
        filePath: sensitiveDataFindings.filePath,
        status: sensitiveDataFindings.status
      })
      .from(sensitiveDataFindings)
      .where(and(...conditions));

    if (findings.length === 0) {
      return c.json({ error: 'No findings found' }, 404);
    }

    if (payload.dryRun) {
      recordSensitiveDataRemediationDecision('dry_run', findings.length);
      return c.json({
        data: {
          dryRun: true,
          action: payload.action,
          eligible: findings.length,
          findings: findings.map((finding) => ({
            findingId: finding.id,
            deviceId: finding.deviceId,
            filePath: finding.filePath
          }))
        }
      });
    }

    const now = new Date();
    const queued: Array<{ findingId: string; commandId: string }> = [];
    const failed: Array<{ findingId: string; error: string }> = [];

    if (payload.action === 'accept_risk' || payload.action === 'false_positive' || payload.action === 'mark_remediated') {
      const nextStatus = payload.action === 'accept_risk'
        ? 'accepted'
        : payload.action === 'false_positive'
          ? 'false_positive'
          : 'remediated';

      await db
        .update(sensitiveDataFindings)
        .set({
          status: nextStatus,
          remediationAction: payload.action,
          remediationMetadata: {
            source: 'manual',
            updatedBy: auth.user.id,
          },
          remediatedAt: now
        })
        .where(inArray(sensitiveDataFindings.id, findings.map((finding) => finding.id)));

      if (nextStatus === 'remediated') {
        const orgIds = Array.from(new Set(findings.map((finding) => finding.orgId)));
        await Promise.allSettled(
          orgIds.map((orgId) => publishEvent(
            'compliance.sensitive_data_remediated',
            orgId,
            {
              findingIds: findings.map((finding) => finding.id),
              action: payload.action,
              remediatedAt: now.toISOString(),
            },
            'sensitive-data-routes'
          ))
        );
      }

      recordSensitiveDataRemediationDecision(payload.action, findings.length);
      return c.json({
        data: {
          updated: findings.length,
          queued,
          failed
        }
      });
    }

    const commandType = payload.action === 'encrypt'
      ? CommandTypes.ENCRYPT_FILE
      : payload.action === 'quarantine'
        ? CommandTypes.QUARANTINE_FILE
        : CommandTypes.SECURE_DELETE_FILE;

    const keySelection = payload.action === 'encrypt'
      ? resolveSensitiveDataKeySelection({
        requestedKeyRef: payload.encryptionKeyRef,
        requestedKeyVersion: payload.encryptionKeyVersion
      })
      : null;

    for (const finding of findings) {
      try {
        const command = await queueCommand(
          finding.deviceId,
          commandType,
          {
            findingId: finding.id,
            path: finding.filePath,
            quarantineDir: payload.quarantineDir,
            encryptionKeyRef: keySelection?.keyRef,
            encryptionKeyVersion: keySelection?.keyVersion,
            encryptionProvider: keySelection?.provider,
          },
          auth.user.id
        );
        queued.push({ findingId: finding.id, commandId: command.id });
      } catch (error) {
        failed.push({
          findingId: finding.id,
          error: error instanceof Error ? error.message : 'Failed to queue remediation command'
        });
      }
    }

    await db
      .update(sensitiveDataFindings)
      .set({
        remediationAction: payload.action,
        remediationMetadata: {
          source: 'queued',
          updatedBy: auth.user.id,
          queuedAt: now.toISOString(),
          keyRef: keySelection?.keyRef ?? null,
          keyVersion: keySelection?.keyVersion ?? null,
          keyFingerprint: keySelection?.keyFingerprint ?? null,
        }
      })
      .where(inArray(sensitiveDataFindings.id, findings.map((finding) => finding.id)));

    if (queued.length > 0) {
      recordSensitiveDataRemediationDecision(payload.action, queued.length);
    }
    if (failed.length > 0) {
      recordSensitiveDataRemediationDecision('queue_failed', failed.length);
    }

    return c.json({
      data: {
        queued,
        failed,
        updated: findings.length
      }
    }, queued.length > 0 ? 202 : 200);
  }
);

sensitiveDataRoutes.get(
  '/policies',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const conditions: SQL[] = [];
    const orgCondition = auth.orgCondition(sensitiveDataPolicies.orgId);
    if (orgCondition) conditions.push(orgCondition);

    const rows = await db
      .select()
      .from(sensitiveDataPolicies)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(sensitiveDataPolicies.createdAt));

    return c.json({
      data: rows.map((row) => ({
        ...row,
        createdAt: asIso(row.createdAt),
        updatedAt: asIso(row.updatedAt),
      }))
    });
  }
);

sensitiveDataRoutes.post(
  '/policies',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createPolicySchema),
  async (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');
    const orgId = readOrgIdFromAuth(auth, payload.orgId);
    if (!orgId) {
      return c.json({ error: 'Unable to resolve target organization for policy creation' }, 400);
    }

    const [policy] = await db
      .insert(sensitiveDataPolicies)
      .values({
        orgId,
        name: payload.name,
        scope: payload.scope,
        detectionClasses: payload.detectionClasses,
        schedule: payload.schedule ?? null,
        isActive: payload.isActive ?? true,
        createdBy: auth.user.id
      })
      .returning();

    if (!policy) return c.json({ error: 'Failed to create policy' }, 500);

    return c.json({
      data: {
        ...policy,
        createdAt: asIso(policy.createdAt),
        updatedAt: asIso(policy.updatedAt),
      }
    }, 201);
  }
);

sensitiveDataRoutes.put(
  '/policies/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdParamSchema),
  zValidator('json', updatePolicySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const conditions: SQL[] = [eq(sensitiveDataPolicies.id, id)];
    const orgCondition = auth.orgCondition(sensitiveDataPolicies.orgId);
    if (orgCondition) conditions.push(orgCondition);

    const [existing] = await db
      .select()
      .from(sensitiveDataPolicies)
      .where(and(...conditions))
      .limit(1);

    if (!existing) return c.json({ error: 'Policy not found' }, 404);

    const [updated] = await db
      .update(sensitiveDataPolicies)
      .set({
        name: payload.name ?? existing.name,
        scope: payload.scope ?? existing.scope,
        detectionClasses: payload.detectionClasses ?? existing.detectionClasses,
        schedule: payload.schedule ?? existing.schedule,
        isActive: payload.isActive ?? existing.isActive,
        updatedAt: new Date()
      })
      .where(eq(sensitiveDataPolicies.id, id))
      .returning();

    if (!updated) return c.json({ error: 'Failed to update policy' }, 500);

    return c.json({
      data: {
        ...updated,
        createdAt: asIso(updated.createdAt),
        updatedAt: asIso(updated.updatedAt),
      }
    });
  }
);

sensitiveDataRoutes.delete(
  '/policies/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const conditions: SQL[] = [eq(sensitiveDataPolicies.id, id)];
    const orgCondition = auth.orgCondition(sensitiveDataPolicies.orgId);
    if (orgCondition) conditions.push(orgCondition);

    const [existing] = await db
      .select({ id: sensitiveDataPolicies.id })
      .from(sensitiveDataPolicies)
      .where(and(...conditions))
      .limit(1);

    if (!existing) return c.json({ error: 'Policy not found' }, 404);

    await db.delete(sensitiveDataPolicies).where(eq(sensitiveDataPolicies.id, id));
    return c.json({ success: true });
  }
);
