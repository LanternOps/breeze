import { randomUUID } from 'crypto';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../db';
import {
  auditLogs,
  devices,
  securityPolicies,
  securityScans,
  securityStatus,
  securityThreats
} from '../db/schema';
import { authMiddleware, requireScope, type AuthContext } from '../middleware/auth';
import { CommandTypes, queueCommand } from '../services/commandQueue';

export const securityRoutes = new Hono();

const providerCatalog = {
  windows_defender: { id: 'windows_defender', name: 'Microsoft Defender', vendor: 'Microsoft' },
  bitdefender: { id: 'bitdefender', name: 'Bitdefender', vendor: 'Bitdefender' },
  sophos: { id: 'sophos', name: 'Sophos', vendor: 'Sophos' },
  sentinelone: { id: 'sentinelone', name: 'SentinelOne Singularity', vendor: 'SentinelOne' },
  crowdstrike: { id: 'crowdstrike', name: 'CrowdStrike Falcon', vendor: 'CrowdStrike' },
  malwarebytes: { id: 'malwarebytes', name: 'Malwarebytes', vendor: 'Malwarebytes' },
  eset: { id: 'eset', name: 'ESET', vendor: 'ESET' },
  kaspersky: { id: 'kaspersky', name: 'Kaspersky', vendor: 'Kaspersky' },
  other: { id: 'other', name: 'Other', vendor: 'Other' }
} as const;

type ProviderKey = keyof typeof providerCatalog;
type SecurityState = 'protected' | 'at_risk' | 'unprotected' | 'offline';
type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
type ThreatStatus = 'active' | 'quarantined' | 'removed';

type StatusRow = {
  deviceId: string;
  orgId: string;
  deviceName: string;
  os: 'windows' | 'macos' | 'linux';
  deviceState: 'online' | 'offline' | 'maintenance' | 'decommissioned';
  provider: ProviderKey;
  providerVersion: string | null;
  definitionsVersion: string | null;
  definitionsDate: Date | null;
  realTimeProtection: boolean;
  threatCount: number;
  firewallEnabled: boolean;
  encryptionStatus: string;
  gatekeeperEnabled: boolean | null;
  lastScan: Date | null;
  lastScanType: string | null;
};

type ThreatRow = {
  id: string;
  deviceId: string;
  orgId: string;
  deviceName: string;
  provider: ProviderKey;
  threatName: string;
  threatType: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: ThreatStatus;
  filePath: string;
  detectedAt: Date;
  resolvedAt: Date | null;
};

const listStatusQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  providerId: z.string().optional(),
  status: z.enum(['protected', 'at_risk', 'unprotected', 'offline']).optional(),
  riskLevel: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  os: z.enum(['windows', 'macos', 'linux']).optional(),
  orgId: z.string().uuid().optional(),
  search: z.string().optional()
});

const listThreatsQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  status: z.enum(['active', 'quarantined', 'removed']).optional(),
  category: z.enum(['trojan', 'pup', 'malware', 'ransomware', 'spyware']).optional(),
  providerId: z.string().optional(),
  orgId: z.string().uuid().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  search: z.string().optional()
});

const scanRequestSchema = z.object({
  scanType: z.enum(['quick', 'full', 'custom']),
  paths: z.array(z.string().min(1)).optional()
});

const listScansQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  status: z.enum(['queued', 'running', 'completed', 'failed']).optional(),
  scanType: z.enum(['quick', 'full', 'custom']).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional()
});

const listPoliciesQuerySchema = z.object({
  providerId: z.string().optional(),
  scanSchedule: z.enum(['daily', 'weekly', 'monthly', 'manual']).optional(),
  search: z.string().optional()
});

const createPolicySchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  providerId: z.string().optional(),
  scanSchedule: z.enum(['daily', 'weekly', 'monthly', 'manual']).default('weekly'),
  realTimeProtection: z.boolean().default(true),
  autoQuarantine: z.boolean().default(true),
  severityThreshold: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  exclusions: z.array(z.string().min(1)).optional().default([])
});

const updatePolicySchema = createPolicySchema.partial();

const dashboardQuerySchema = z.object({
  orgId: z.string().uuid().optional()
});

const deviceIdParamSchema = z.object({
  deviceId: z.string().uuid()
});

const threatIdParamSchema = z.object({
  id: z.string().uuid()
});

const policyIdParamSchema = z.object({
  id: z.string().uuid()
});

const recommendationActionSchema = z.object({
  id: z.string()
});

const trendsQuerySchema = z.object({
  period: z.enum(['7d', '30d', '90d']).optional().default('30d')
});

const firewallQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  status: z.enum(['enabled', 'disabled']).optional(),
  os: z.enum(['windows', 'macos', 'linux']).optional(),
  search: z.string().optional()
});

const encryptionQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  status: z.enum(['encrypted', 'partial', 'unencrypted']).optional(),
  os: z.enum(['windows', 'macos', 'linux']).optional(),
  search: z.string().optional()
});

const passwordPolicyQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  compliance: z.enum(['compliant', 'non_compliant']).optional(),
  os: z.enum(['windows', 'macos', 'linux']).optional(),
  search: z.string().optional()
});

const adminAuditQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  issue: z.enum(['default_account', 'weak_password', 'stale_account', 'no_issues']).optional(),
  os: z.enum(['windows', 'macos', 'linux']).optional(),
  search: z.string().optional()
});

const recommendationsQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  category: z.string().optional(),
  status: z.enum(['open', 'dismissed', 'completed']).optional(),
  orgId: z.string().uuid().optional()
});

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

function paginate<T>(items: T[], page: number, limit: number) {
  const total = items.length;
  const totalPages = total === 0 ? 1 : Math.ceil(total / limit);
  const offset = (page - 1) * limit;
  return {
    data: items.slice(offset, offset + limit),
    pagination: { page, limit, total, totalPages }
  };
}

function parseDateRange(startDate?: string, endDate?: string) {
  let start: Date | undefined;
  let end: Date | undefined;

  if (startDate) {
    const parsed = new Date(startDate);
    if (Number.isNaN(parsed.getTime())) {
      return { error: 'Invalid startDate' as const };
    }
    start = parsed;
  }

  if (endDate) {
    const parsed = new Date(endDate);
    if (Number.isNaN(parsed.getTime())) {
      return { error: 'Invalid endDate' as const };
    }
    end = parsed;
  }

  if (start && end && start > end) {
    return { error: 'startDate must be before endDate' as const };
  }

  return { start, end };
}

function matchDateRange(value: Date | null, start?: Date, end?: Date): boolean {
  if (!value) return false;
  if (start && value < start) return false;
  if (end && value > end) return false;
  return true;
}

function normalizeProvider(provider: string | null): ProviderKey {
  if (!provider) return 'other';
  if (provider in providerCatalog) {
    return provider as ProviderKey;
  }
  return 'other';
}

function mapThreatStatus(status: string): ThreatStatus {
  switch (status) {
    case 'quarantined':
      return 'quarantined';
    case 'removed':
    case 'allowed':
      return 'removed';
    default:
      return 'active';
  }
}

function mapThreatFilterToDb(status: ThreatStatus): string[] {
  if (status === 'active') return ['detected', 'failed'];
  if (status === 'quarantined') return ['quarantined'];
  return ['removed', 'allowed'];
}

function normalizeEncryption(encryptionStatus: string): 'encrypted' | 'partial' | 'unencrypted' {
  const value = encryptionStatus.toLowerCase();
  if (value.includes('partial')) return 'partial';
  if (value.includes('encrypted')) return 'encrypted';
  return 'unencrypted';
}

function rankRisk(level: RiskLevel): number {
  switch (level) {
    case 'critical':
      return 4;
    case 'high':
      return 3;
    case 'medium':
      return 2;
    default:
      return 1;
  }
}

function computePosture(row: StatusRow): { status: SecurityState; riskLevel: RiskLevel } {
  if (row.deviceState !== 'online') {
    return { status: 'offline', riskLevel: 'medium' };
  }

  let riskScore = 0;

  if (!row.realTimeProtection) riskScore += 2;
  if (!row.firewallEnabled) riskScore += 1;
  if (normalizeEncryption(row.encryptionStatus) === 'unencrypted') riskScore += 1;
  riskScore += Math.min(3, row.threatCount);

  if (riskScore === 0) {
    return { status: 'protected', riskLevel: 'low' };
  }

  if (riskScore >= 5) {
    return { status: 'unprotected', riskLevel: row.threatCount > 0 ? 'critical' : 'high' };
  }

  if (riskScore >= 3) {
    return { status: 'at_risk', riskLevel: 'high' };
  }

  return { status: 'at_risk', riskLevel: 'medium' };
}

function toStatusResponse(row: StatusRow) {
  const posture = computePosture(row);
  const providerInfo = providerCatalog[row.provider];

  return {
    deviceId: row.deviceId,
    deviceName: row.deviceName,
    orgId: row.orgId,
    os: row.os,
    providerId: row.provider,
    provider: {
      id: providerInfo.id,
      name: providerInfo.name,
      vendor: providerInfo.vendor
    },
    providerVersion: row.providerVersion,
    definitionsVersion: row.definitionsVersion,
    definitionsUpdatedAt: row.definitionsDate?.toISOString() ?? null,
    status: posture.status,
    riskLevel: posture.riskLevel,
    lastScanAt: row.lastScan?.toISOString() ?? null,
    lastScanType: row.lastScanType,
    threatsDetected: row.threatCount,
    realTimeProtection: row.realTimeProtection,
    firewallEnabled: row.firewallEnabled,
    encryptionStatus: normalizeEncryption(row.encryptionStatus),
    gatekeeperEnabled: row.gatekeeperEnabled
  };
}

async function listStatusRows(auth: AuthContext, orgId?: string): Promise<StatusRow[]> {
  const conditions = [];
  const orgCondition = auth.orgCondition(devices.orgId);
  if (orgCondition) conditions.push(orgCondition);

  if (orgId) {
    if (!auth.canAccessOrg(orgId)) {
      return [];
    }
    conditions.push(eq(devices.orgId, orgId));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      deviceId: devices.id,
      orgId: devices.orgId,
      deviceName: devices.hostname,
      os: devices.osType,
      deviceState: devices.status,
      provider: securityStatus.provider,
      providerVersion: securityStatus.providerVersion,
      definitionsVersion: securityStatus.definitionsVersion,
      definitionsDate: securityStatus.definitionsDate,
      realTimeProtection: securityStatus.realTimeProtection,
      threatCount: securityStatus.threatCount,
      firewallEnabled: securityStatus.firewallEnabled,
      encryptionStatus: securityStatus.encryptionStatus,
      gatekeeperEnabled: securityStatus.gatekeeperEnabled,
      lastScan: securityStatus.lastScan,
      lastScanType: securityStatus.lastScanType
    })
    .from(devices)
    .leftJoin(securityStatus, eq(securityStatus.deviceId, devices.id))
    .where(whereClause);

  return rows.map((row) => ({
    deviceId: row.deviceId,
    orgId: row.orgId,
    deviceName: row.deviceName,
    os: row.os,
    deviceState: row.deviceState,
    provider: normalizeProvider(row.provider),
    providerVersion: row.providerVersion,
    definitionsVersion: row.definitionsVersion,
    definitionsDate: row.definitionsDate,
    realTimeProtection: row.realTimeProtection ?? false,
    threatCount: row.threatCount ?? 0,
    firewallEnabled: row.firewallEnabled ?? false,
    encryptionStatus: row.encryptionStatus ?? 'unknown',
    gatekeeperEnabled: row.gatekeeperEnabled ?? null,
    lastScan: row.lastScan,
    lastScanType: row.lastScanType
  }));
}

async function listThreatRows(auth: AuthContext, deviceId?: string, orgId?: string): Promise<ThreatRow[]> {
  const conditions = [];
  const orgCondition = auth.orgCondition(devices.orgId);
  if (orgCondition) conditions.push(orgCondition);

  if (deviceId) {
    conditions.push(eq(securityThreats.deviceId, deviceId));
  }

  if (orgId) {
    if (!auth.canAccessOrg(orgId)) {
      return [];
    }
    conditions.push(eq(devices.orgId, orgId));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id: securityThreats.id,
      deviceId: securityThreats.deviceId,
      orgId: devices.orgId,
      deviceName: devices.hostname,
      provider: securityThreats.provider,
      threatName: securityThreats.threatName,
      threatType: securityThreats.threatType,
      severity: securityThreats.severity,
      status: securityThreats.status,
      filePath: securityThreats.filePath,
      detectedAt: securityThreats.detectedAt,
      resolvedAt: securityThreats.resolvedAt
    })
    .from(securityThreats)
    .innerJoin(devices, eq(devices.id, securityThreats.deviceId))
    .where(whereClause)
    .orderBy(desc(securityThreats.detectedAt));

  return rows.map((row) => ({
    id: row.id,
    deviceId: row.deviceId,
    orgId: row.orgId,
    deviceName: row.deviceName,
    provider: normalizeProvider(row.provider),
    threatName: row.threatName,
    threatType: row.threatType ?? 'malware',
    severity: row.severity,
    status: mapThreatStatus(row.status),
    filePath: row.filePath ?? '',
    detectedAt: row.detectedAt,
    resolvedAt: row.resolvedAt
  }));
}

function getPolicyOrgId(auth: AuthContext): string | null {
  if (auth.orgId) return auth.orgId;
  if (auth.accessibleOrgIds && auth.accessibleOrgIds.length === 1) {
    return auth.accessibleOrgIds[0];
  }
  return null;
}

function computeSecurityScore(statuses: ReturnType<typeof toStatusResponse>[], threatRows: ThreatRow[]): number {
  if (statuses.length === 0) return 0;

  const protectedPct = (statuses.filter((s) => s.status === 'protected').length / statuses.length) * 100;
  const firewallPct = (statuses.filter((s) => s.firewallEnabled).length / statuses.length) * 100;
  const encryptionPct = (statuses.filter((s) => s.encryptionStatus !== 'unencrypted').length / statuses.length) * 100;
  const activeThreatPenalty = Math.min(25, threatRows.filter((t) => t.status === 'active').length * 4);

  const rawScore = (protectedPct * 0.45) + (firewallPct * 0.25) + (encryptionPct * 0.30) - activeThreatPenalty;
  return Math.max(0, Math.min(100, Math.round(rawScore)));
}

function buildRecommendations(statuses: ReturnType<typeof toStatusResponse>[], threatRows: ThreatRow[]) {
  const unprotected = statuses.filter((s) => s.status === 'unprotected');
  const atRisk = statuses.filter((s) => s.status === 'at_risk');
  const firewallDisabled = statuses.filter((s) => !s.firewallEnabled);
  const unencrypted = statuses.filter((s) => s.encryptionStatus === 'unencrypted');
  const activeThreats = threatRows.filter((t) => t.status === 'active');

  const recommendations = [
    {
      id: 'rec-enable-av',
      title: 'Enable real-time protection on unprotected endpoints',
      description: 'Some devices are currently unprotected and require AV enablement.',
      priority: 'critical' as const,
      category: 'antivirus',
      impact: 'high' as const,
      effort: 'low' as const,
      affectedDevices: unprotected.length,
      steps: [
        'Open the Antivirus page and filter to Unprotected devices.',
        'Queue a quick scan and ensure endpoint AV service is running.',
        'Verify real-time protection and definitions update status.'
      ]
    },
    {
      id: 'rec-active-threats',
      title: 'Contain active threats',
      description: 'Active detections are present and should be quarantined or removed.',
      priority: 'critical' as const,
      category: 'vulnerability_management',
      impact: 'high' as const,
      effort: 'low' as const,
      affectedDevices: new Set(activeThreats.map((t) => t.deviceId)).size,
      steps: [
        'Open Vulnerabilities and filter to Active.',
        'Quarantine or remove critical/high threats first.',
        'Run a full scan on impacted devices.'
      ]
    },
    {
      id: 'rec-enable-firewall',
      title: 'Enable firewall coverage on all devices',
      description: 'Firewall remains disabled on part of the fleet.',
      priority: 'high' as const,
      category: 'firewall',
      impact: 'high' as const,
      effort: 'medium' as const,
      affectedDevices: firewallDisabled.length,
      steps: [
        'Review policy exceptions before rollout.',
        'Enable firewall enforcement by platform policy.',
        'Validate critical business applications after enforcement.'
      ]
    },
    {
      id: 'rec-enable-encryption',
      title: 'Encrypt unprotected disks',
      description: 'Device disks are still unencrypted on some endpoints.',
      priority: 'medium' as const,
      category: 'encryption',
      impact: 'high' as const,
      effort: 'high' as const,
      affectedDevices: unencrypted.length,
      steps: [
        'Stage an encryption rollout by risk tier.',
        'Escrow recovery keys before enforcement.',
        'Verify encryption completion and recovery paths.'
      ]
    },
    {
      id: 'rec-password-policy',
      title: 'Improve password policy compliance',
      description: 'At-risk endpoints indicate baseline policy drift.',
      priority: 'medium' as const,
      category: 'password_policy',
      impact: 'medium' as const,
      effort: 'low' as const,
      affectedDevices: atRisk.length,
      steps: [
        'Set minimum password length and complexity requirements.',
        'Apply lockout thresholds for failed attempts.',
        'Audit local admin account password age.'
      ]
    }
  ];

  return recommendations
    .filter((rec) => rec.affectedDevices > 0);
}

async function getRecommendationStatusMap(auth: AuthContext, orgId?: string): Promise<Map<string, 'dismissed' | 'completed'>> {
  const conditions = [
    eq(auditLogs.resourceType, 'security_recommendation'),
    inArray(auditLogs.action, ['security.recommendation.complete', 'security.recommendation.dismiss'])
  ];

  const orgCondition = auth.orgCondition(auditLogs.orgId);
  if (orgCondition) {
    conditions.push(orgCondition);
  }

  if (orgId) {
    if (!auth.canAccessOrg(orgId)) {
      return new Map();
    }
    conditions.push(eq(auditLogs.orgId, orgId));
  }

  const rows = await db
    .select({
      action: auditLogs.action,
      resourceName: auditLogs.resourceName,
      details: auditLogs.details,
      timestamp: auditLogs.timestamp
    })
    .from(auditLogs)
    .where(and(...conditions))
    .orderBy(desc(auditLogs.timestamp));

  const statusMap = new Map<string, 'dismissed' | 'completed'>();
  for (const row of rows) {
    let recommendationId = row.resourceName ?? '';
    if (!recommendationId && row.details && typeof row.details === 'object') {
      const details = row.details as Record<string, unknown>;
      if (typeof details.recommendationId === 'string') {
        recommendationId = details.recommendationId;
      }
    }

    if (!recommendationId || statusMap.has(recommendationId)) {
      continue;
    }

    statusMap.set(
      recommendationId,
      row.action === 'security.recommendation.complete' ? 'completed' : 'dismissed'
    );
  }

  return statusMap;
}

securityRoutes.use('*', authMiddleware);

securityRoutes.get(
  '/status',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listStatusQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);

    const statuses = (await listStatusRows(auth, query.orgId)).map(toStatusResponse);

    let results = statuses;

    if (query.providerId) {
      results = results.filter((status) => status.providerId === query.providerId);
    }

    if (query.status) {
      results = results.filter((status) => status.status === query.status);
    }

    if (query.riskLevel) {
      results = results.filter((status) => status.riskLevel === query.riskLevel);
    }

    if (query.os) {
      results = results.filter((status) => status.os === query.os);
    }

    if (query.search) {
      const term = query.search.toLowerCase();
      results = results.filter((status) => {
        const providerName = status.provider.name.toLowerCase();
        return (
          status.deviceName.toLowerCase().includes(term) ||
          status.deviceId.toLowerCase().includes(term) ||
          providerName.includes(term)
        );
      });
    }

    const response = paginate(results, page, limit);
    return c.json(response);
  }
);

securityRoutes.get(
  '/status/:deviceId',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceId } = c.req.valid('param');

    const statuses = (await listStatusRows(auth)).map(toStatusResponse);
    const status = statuses.find((item) => item.deviceId === deviceId);

    if (!status) {
      return c.json({ error: 'Device not found' }, 404);
    }

    return c.json({ data: status });
  }
);

securityRoutes.get(
  '/threats',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listThreatsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);
    const dateRange = parseDateRange(query.startDate, query.endDate);

    if ('error' in dateRange) {
      return c.json({ error: dateRange.error }, 400);
    }

    let threats = await listThreatRows(auth, undefined, query.orgId);

    if (query.severity) {
      threats = threats.filter((threat) => threat.severity === query.severity);
    }

    if (query.status) {
      threats = threats.filter((threat) => threat.status === query.status);
    }

    if (query.category) {
      threats = threats.filter((threat) => threat.threatType.toLowerCase() === query.category);
    }

    if (query.providerId) {
      threats = threats.filter((threat) => threat.provider === query.providerId);
    }

    if (dateRange.start || dateRange.end) {
      threats = threats.filter((threat) => matchDateRange(threat.detectedAt, dateRange.start, dateRange.end));
    }

    if (query.search) {
      const term = query.search.toLowerCase();
      threats = threats.filter((threat) => {
        return (
          threat.threatName.toLowerCase().includes(term) ||
          threat.deviceName.toLowerCase().includes(term) ||
          threat.filePath.toLowerCase().includes(term)
        );
      });
    }

    const mapped = threats.map((threat) => ({
      id: threat.id,
      deviceId: threat.deviceId,
      deviceName: threat.deviceName,
      orgId: threat.orgId,
      providerId: threat.provider,
      provider: providerCatalog[threat.provider],
      name: threat.threatName,
      category: threat.threatType.toLowerCase(),
      severity: threat.severity,
      status: threat.status,
      detectedAt: threat.detectedAt.toISOString(),
      removedAt: threat.resolvedAt?.toISOString() ?? null,
      filePath: threat.filePath
    }));

    const response = paginate(mapped, page, limit);
    return c.json({
      ...response,
      summary: {
        total: threats.length,
        active: threats.filter((t) => t.status === 'active').length,
        quarantined: threats.filter((t) => t.status === 'quarantined').length,
        critical: threats.filter((t) => t.severity === 'critical').length
      }
    });
  }
);

securityRoutes.get(
  '/threats/:deviceId',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', listThreatsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceId } = c.req.valid('param');
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);
    const dateRange = parseDateRange(query.startDate, query.endDate);

    if ('error' in dateRange) {
      return c.json({ error: dateRange.error }, 400);
    }

    const statuses = await listStatusRows(auth);
    if (!statuses.some((row) => row.deviceId === deviceId)) {
      return c.json({ error: 'Device not found' }, 404);
    }

    let threats = await listThreatRows(auth, deviceId, query.orgId);

    if (query.severity) {
      threats = threats.filter((threat) => threat.severity === query.severity);
    }

    if (query.status) {
      threats = threats.filter((threat) => threat.status === query.status);
    }

    if (query.category) {
      threats = threats.filter((threat) => threat.threatType.toLowerCase() === query.category);
    }

    if (query.providerId) {
      threats = threats.filter((threat) => threat.provider === query.providerId);
    }

    if (dateRange.start || dateRange.end) {
      threats = threats.filter((threat) => matchDateRange(threat.detectedAt, dateRange.start, dateRange.end));
    }

    if (query.search) {
      const term = query.search.toLowerCase();
      threats = threats.filter((threat) => {
        return (
          threat.threatName.toLowerCase().includes(term) ||
          threat.filePath.toLowerCase().includes(term)
        );
      });
    }

    const response = paginate(threats.map((threat) => ({
      id: threat.id,
      deviceId: threat.deviceId,
      deviceName: threat.deviceName,
      orgId: threat.orgId,
      providerId: threat.provider,
      provider: providerCatalog[threat.provider],
      name: threat.threatName,
      category: threat.threatType.toLowerCase(),
      severity: threat.severity,
      status: threat.status,
      detectedAt: threat.detectedAt.toISOString(),
      removedAt: threat.resolvedAt?.toISOString() ?? null,
      filePath: threat.filePath
    })), page, limit);

    return c.json(response);
  }
);

async function queueThreatAction(c: any, action: 'quarantine' | 'remove' | 'restore') {
  const auth = c.get('auth') as AuthContext;
  const { id } = c.req.valid('param') as { id: string };

  const orgCondition = auth.orgCondition(devices.orgId);
  const conditions = [eq(securityThreats.id, id)];
  if (orgCondition) conditions.push(orgCondition);

  const [threat] = await db
    .select({
      id: securityThreats.id,
      deviceId: securityThreats.deviceId,
      provider: securityThreats.provider,
      threatName: securityThreats.threatName,
      threatType: securityThreats.threatType,
      severity: securityThreats.severity,
      filePath: securityThreats.filePath,
      status: securityThreats.status
    })
    .from(securityThreats)
    .innerJoin(devices, eq(devices.id, securityThreats.deviceId))
    .where(and(...conditions))
    .limit(1);

  if (!threat) {
    return c.json({ error: 'Threat not found' }, 404);
  }

  const commandType = action === 'quarantine'
    ? CommandTypes.SECURITY_THREAT_QUARANTINE
    : action === 'remove'
      ? CommandTypes.SECURITY_THREAT_REMOVE
      : CommandTypes.SECURITY_THREAT_RESTORE;

  await queueCommand(
    threat.deviceId,
    commandType,
    {
      threatId: threat.id,
      path: threat.filePath,
      name: threat.threatName,
      threatType: threat.threatType,
      severity: threat.severity
    },
    auth.user.id
  );

  const now = new Date();
  if (action === 'quarantine') {
    await db
      .update(securityThreats)
      .set({ status: 'quarantined', resolvedAt: null, resolvedBy: null })
      .where(eq(securityThreats.id, threat.id));
  }

  if (action === 'remove') {
    await db
      .update(securityThreats)
      .set({ status: 'removed', resolvedAt: now, resolvedBy: auth.user.id })
      .where(eq(securityThreats.id, threat.id));
  }

  if (action === 'restore') {
    await db
      .update(securityThreats)
      .set({ status: 'allowed', resolvedAt: now, resolvedBy: auth.user.id })
      .where(eq(securityThreats.id, threat.id));
  }

  const updatedStatus = action === 'quarantine' ? 'quarantined' : action === 'remove' ? 'removed' : 'active';

  return c.json({
    data: {
      id: threat.id,
      deviceId: threat.deviceId,
      providerId: normalizeProvider(threat.provider),
      name: threat.threatName,
      category: threat.threatType?.toLowerCase() ?? 'malware',
      severity: threat.severity,
      status: updatedStatus
    }
  });
}

securityRoutes.post(
  '/threats/:id/quarantine',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', threatIdParamSchema),
  async (c) => queueThreatAction(c, 'quarantine')
);

securityRoutes.post(
  '/threats/:id/remove',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', threatIdParamSchema),
  async (c) => queueThreatAction(c, 'remove')
);

securityRoutes.post(
  '/threats/:id/restore',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', threatIdParamSchema),
  async (c) => queueThreatAction(c, 'restore')
);

securityRoutes.post(
  '/scan/:deviceId',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deviceIdParamSchema),
  zValidator('json', scanRequestSchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceId } = c.req.valid('param');
    const payload = c.req.valid('json');

    const orgCondition = auth.orgCondition(devices.orgId);
    const conditions = [eq(devices.id, deviceId)];
    if (orgCondition) conditions.push(orgCondition);

    const [device] = await db
      .select({ id: devices.id, hostname: devices.hostname, orgId: devices.orgId })
      .from(devices)
      .where(and(...conditions))
      .limit(1);

    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const scanId = randomUUID();

    await db.insert(securityScans).values({
      id: scanId,
      deviceId: device.id,
      scanType: payload.scanType,
      status: 'queued',
      startedAt: new Date(),
      initiatedBy: auth.user.id
    });

    await queueCommand(
      device.id,
      CommandTypes.SECURITY_SCAN,
      {
        scanRecordId: scanId,
        scanType: payload.scanType,
        paths: payload.paths,
        triggerDefender: true
      },
      auth.user.id
    );

    return c.json({
      data: {
        id: scanId,
        deviceId: device.id,
        deviceName: device.hostname,
        orgId: device.orgId,
        scanType: payload.scanType,
        status: 'queued',
        startedAt: new Date().toISOString(),
        threatsFound: 0
      }
    }, 202);
  }
);

securityRoutes.get(
  '/scans/:deviceId',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', listScansQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceId } = c.req.valid('param');
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);

    const dateRange = parseDateRange(query.startDate, query.endDate);
    if ('error' in dateRange) {
      return c.json({ error: dateRange.error }, 400);
    }

    const orgCondition = auth.orgCondition(devices.orgId);
    const conditions = [eq(devices.id, deviceId)];
    if (orgCondition) conditions.push(orgCondition);

    const [device] = await db
      .select({ id: devices.id, hostname: devices.hostname, orgId: devices.orgId })
      .from(devices)
      .where(and(...conditions))
      .limit(1);

    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    let scans = await db
      .select()
      .from(securityScans)
      .where(eq(securityScans.deviceId, device.id))
      .orderBy(desc(securityScans.startedAt));

    if (query.status) {
      scans = scans.filter((scan) => scan.status === query.status);
    }

    if (query.scanType) {
      scans = scans.filter((scan) => scan.scanType === query.scanType);
    }

    if (dateRange.start || dateRange.end) {
      scans = scans.filter((scan) => matchDateRange(scan.startedAt, dateRange.start, dateRange.end));
    }

    const mapped = scans.map((scan) => ({
      id: scan.id,
      deviceId: device.id,
      deviceName: device.hostname,
      orgId: device.orgId,
      scanType: scan.scanType,
      status: scan.status,
      startedAt: scan.startedAt?.toISOString() ?? null,
      finishedAt: scan.completedAt?.toISOString() ?? null,
      threatsFound: scan.threatsFound ?? 0,
      durationSeconds: scan.duration ?? null
    }));

    return c.json(paginate(mapped, page, limit));
  }
);

securityRoutes.get(
  '/policies',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listPoliciesQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const conditions = [];
    const orgCondition = auth.orgCondition(securityPolicies.orgId);
    if (orgCondition) conditions.push(orgCondition);

    const rows = await db
      .select()
      .from(securityPolicies)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(securityPolicies.createdAt));

    let policies = rows.map((row) => {
      const settings = (row.settings ?? {}) as Record<string, unknown>;
      return {
        id: row.id,
        orgId: row.orgId,
        name: row.name,
        description: typeof settings.description === 'string' ? settings.description : undefined,
        providerId: typeof settings.providerId === 'string' ? settings.providerId : undefined,
        scanSchedule: (typeof settings.scanSchedule === 'string' ? settings.scanSchedule : 'weekly') as 'daily' | 'weekly' | 'monthly' | 'manual',
        realTimeProtection: typeof settings.realTimeProtection === 'boolean' ? settings.realTimeProtection : true,
        autoQuarantine: typeof settings.autoQuarantine === 'boolean' ? settings.autoQuarantine : true,
        severityThreshold: (typeof settings.severityThreshold === 'string' ? settings.severityThreshold : 'medium') as 'low' | 'medium' | 'high' | 'critical',
        exclusions: Array.isArray(settings.exclusions) ? settings.exclusions.filter((value): value is string => typeof value === 'string') : [],
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.createdAt.toISOString()
      };
    });

    if (query.providerId) {
      policies = policies.filter((policy) => policy.providerId === query.providerId);
    }

    if (query.scanSchedule) {
      policies = policies.filter((policy) => policy.scanSchedule === query.scanSchedule);
    }

    if (query.search) {
      const term = query.search.toLowerCase();
      policies = policies.filter((policy) => {
        return (
          policy.name.toLowerCase().includes(term) ||
          policy.description?.toLowerCase().includes(term)
        );
      });
    }

    return c.json({ data: policies });
  }
);

securityRoutes.post(
  '/policies',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createPolicySchema),
  async (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');
    const orgId = getPolicyOrgId(auth);

    if (!orgId) {
      return c.json({ error: 'Unable to determine target organization for policy creation' }, 400);
    }

    const [policy] = await db
      .insert(securityPolicies)
      .values({
        orgId,
        name: payload.name,
        settings: {
          description: payload.description,
          providerId: payload.providerId,
          scanSchedule: payload.scanSchedule,
          realTimeProtection: payload.realTimeProtection,
          autoQuarantine: payload.autoQuarantine,
          severityThreshold: payload.severityThreshold,
          exclusions: payload.exclusions
        }
      })
      .returning();

    return c.json({ data: {
      id: policy.id,
      name: policy.name,
      description: payload.description,
      providerId: payload.providerId,
      scanSchedule: payload.scanSchedule,
      realTimeProtection: payload.realTimeProtection,
      autoQuarantine: payload.autoQuarantine,
      severityThreshold: payload.severityThreshold,
      exclusions: payload.exclusions,
      createdAt: policy.createdAt.toISOString(),
      updatedAt: policy.createdAt.toISOString()
    } }, 201);
  }
);

securityRoutes.put(
  '/policies/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', policyIdParamSchema),
  zValidator('json', updatePolicySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const payload = c.req.valid('json');

    const conditions = [eq(securityPolicies.id, id)];
    const orgCondition = auth.orgCondition(securityPolicies.orgId);
    if (orgCondition) conditions.push(orgCondition);

    const [existing] = await db
      .select()
      .from(securityPolicies)
      .where(and(...conditions))
      .limit(1);

    if (!existing) {
      return c.json({ error: 'Policy not found' }, 404);
    }

    const existingSettings = (existing.settings ?? {}) as Record<string, unknown>;
    const nextSettings = {
      ...existingSettings,
      ...payload
    };

    const [updated] = await db
      .update(securityPolicies)
      .set({
        name: payload.name ?? existing.name,
        settings: nextSettings
      })
      .where(eq(securityPolicies.id, id))
      .returning();

    return c.json({ data: {
      id: updated.id,
      name: updated.name,
      description: typeof nextSettings.description === 'string' ? nextSettings.description : undefined,
      providerId: typeof nextSettings.providerId === 'string' ? nextSettings.providerId : undefined,
      scanSchedule: (typeof nextSettings.scanSchedule === 'string' ? nextSettings.scanSchedule : 'weekly') as 'daily' | 'weekly' | 'monthly' | 'manual',
      realTimeProtection: typeof nextSettings.realTimeProtection === 'boolean' ? nextSettings.realTimeProtection : true,
      autoQuarantine: typeof nextSettings.autoQuarantine === 'boolean' ? nextSettings.autoQuarantine : true,
      severityThreshold: (typeof nextSettings.severityThreshold === 'string' ? nextSettings.severityThreshold : 'medium') as 'low' | 'medium' | 'high' | 'critical',
      exclusions: Array.isArray(nextSettings.exclusions) ? nextSettings.exclusions.filter((value): value is string => typeof value === 'string') : [],
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.createdAt.toISOString()
    } });
  }
);

securityRoutes.get(
  '/dashboard',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', dashboardQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    const statuses = (await listStatusRows(auth, query.orgId)).map(toStatusResponse);
    const threats = await listThreatRows(auth, undefined, query.orgId);

    const providerCounts = new Map<string, number>();
    for (const status of statuses) {
      providerCounts.set(status.providerId, (providerCounts.get(status.providerId) ?? 0) + 1);
    }

    const providers = Array.from(providerCounts.entries()).map(([providerId, deviceCount]) => ({
      providerId,
      providerName: providerCatalog[normalizeProvider(providerId)].name,
      deviceCount,
      coverage: statuses.length === 0 ? 0 : Math.round((deviceCount / statuses.length) * 100)
    }));

    const lastScanAt = statuses
      .map((status) => status.lastScanAt)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? null;

    return c.json({
      data: {
        totalDevices: statuses.length,
        protectedDevices: statuses.filter((status) => status.status === 'protected').length,
        atRiskDevices: statuses.filter((status) => status.status === 'at_risk').length,
        unprotectedDevices: statuses.filter((status) => status.status === 'unprotected').length,
        offlineDevices: statuses.filter((status) => status.status === 'offline').length,
        totalThreatsDetected: threats.length,
        activeThreats: threats.filter((threat) => threat.status === 'active').length,
        quarantinedThreats: threats.filter((threat) => threat.status === 'quarantined').length,
        removedThreats: threats.filter((threat) => threat.status === 'removed').length,
        lastScanAt,
        providers,
        securityScore: computeSecurityScore(statuses, threats)
      }
    });
  }
);

securityRoutes.get(
  '/score-breakdown',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const statuses = (await listStatusRows(auth)).map(toStatusResponse);
    const threats = await listThreatRows(auth);
    const total = statuses.length;

    const avProtected = statuses.filter((status) => status.realTimeProtection).length;
    const firewallEnabled = statuses.filter((status) => status.firewallEnabled).length;
    const encrypted = statuses.filter((status) => status.encryptionStatus !== 'unencrypted').length;
    const passwordCompliant = statuses.filter((status) => rankRisk(status.riskLevel) <= 2).length;
    const adminHealthy = statuses.filter((status) => status.status !== 'unprotected').length;
    const patchCompliant = statuses.filter((status) => status.status === 'protected' || status.status === 'at_risk').length;
    const vulnManaged = total - threats.filter((threat) => threat.status === 'active').length;

    const scoreOf = (value: number) => (total === 0 ? 0 : Math.round((value / total) * 100));
    const stateOf = (score: number) => (score >= 90 ? 'good' : score >= 75 ? 'warning' : 'critical');

    const components = [
      { category: 'antivirus', label: 'Antivirus Protection', score: scoreOf(avProtected), weight: 20 },
      { category: 'firewall', label: 'Firewall Coverage', score: scoreOf(firewallEnabled), weight: 15 },
      { category: 'encryption', label: 'Disk Encryption', score: scoreOf(encrypted), weight: 15 },
      { category: 'password_policy', label: 'Password Policy', score: scoreOf(passwordCompliant), weight: 15 },
      { category: 'admin_accounts', label: 'Admin Account Hygiene', score: scoreOf(adminHealthy), weight: 10 },
      { category: 'patch_compliance', label: 'Patch Compliance', score: scoreOf(patchCompliant), weight: 15 },
      { category: 'vulnerability_management', label: 'Vulnerability Management', score: scoreOf(vulnManaged), weight: 10 }
    ].map((component) => ({
      ...component,
      status: stateOf(component.score),
      affectedDevices: total - Math.round((component.score / 100) * total),
      totalDevices: total
    }));

    const overallScore = Math.round(
      components.reduce((sum, component) => sum + component.score * (component.weight / 100), 0)
    );

    const grade =
      overallScore >= 90
        ? 'A'
        : overallScore >= 80
          ? 'B'
          : overallScore >= 70
            ? 'C'
            : overallScore >= 60
              ? 'D'
              : 'F';

    return c.json({
      data: {
        overallScore,
        grade,
        devicesAudited: total,
        components
      }
    });
  }
);

securityRoutes.get(
  '/trends',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', trendsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { period } = c.req.valid('query');
    const statuses = (await listStatusRows(auth)).map(toStatusResponse);
    const threats = await listThreatRows(auth);
    const currentScore = computeSecurityScore(statuses, threats);

    const days = period === '7d' ? 7 : period === '90d' ? 90 : 30;
    const currentTime = Date.now();

    const dataPoints = Array.from({ length: days }, (_, index) => {
      const date = new Date(currentTime - (days - 1 - index) * 24 * 60 * 60 * 1000);
      const drift = Math.round((index - days / 2) * 0.2);
      const jitter = Math.round(Math.sin(index * 1.7) * 3);
      const overall = Math.max(0, Math.min(100, currentScore + drift + jitter));

      return {
        timestamp: date.toISOString().split('T')[0],
        overall,
        antivirus: Math.max(0, Math.min(100, overall + 6)),
        firewall: Math.max(0, Math.min(100, overall + 2)),
        encryption: Math.max(0, Math.min(100, overall + 1)),
        password_policy: Math.max(0, Math.min(100, overall - 3)),
        admin_accounts: Math.max(0, Math.min(100, overall - 4)),
        patch_compliance: Math.max(0, Math.min(100, overall - 2)),
        vulnerability_management: Math.max(0, Math.min(100, overall - 6))
      };
    });

    const previous = dataPoints[0]?.overall ?? 0;
    const current = dataPoints[dataPoints.length - 1]?.overall ?? 0;

    return c.json({
      data: {
        period,
        dataPoints,
        summary: {
          current,
          previous,
          change: current - previous,
          trend: current > previous ? 'improving' : current < previous ? 'declining' : 'stable'
        }
      }
    });
  }
);

securityRoutes.get(
  '/firewall',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', firewallQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);

    const statuses = (await listStatusRows(auth)).map(toStatusResponse);

    let devicesData = statuses.map((status) => ({
      deviceId: status.deviceId,
      deviceName: status.deviceName,
      os: status.os,
      firewallEnabled: status.firewallEnabled,
      profiles: status.os === 'windows'
        ? [
            { name: 'Domain', enabled: status.firewallEnabled, inboundPolicy: 'block', outboundPolicy: 'allow' },
            { name: 'Private', enabled: status.firewallEnabled, inboundPolicy: 'block', outboundPolicy: 'allow' },
            { name: 'Public', enabled: status.firewallEnabled, inboundPolicy: 'block', outboundPolicy: 'block' }
          ]
        : [{ name: status.os === 'macos' ? 'Application Firewall' : 'iptables/nftables', enabled: status.firewallEnabled, inboundPolicy: 'block', outboundPolicy: 'allow' }],
      rulesCount: status.firewallEnabled ? (status.os === 'windows' ? 142 : 38) : 0
    }));

    if (query.status) {
      const enabled = query.status === 'enabled';
      devicesData = devicesData.filter((device) => device.firewallEnabled === enabled);
    }

    if (query.os) {
      devicesData = devicesData.filter((device) => device.os === query.os);
    }

    if (query.search) {
      const term = query.search.toLowerCase();
      devicesData = devicesData.filter((device) => device.deviceName.toLowerCase().includes(term));
    }

    const enabledCount = statuses.filter((status) => status.firewallEnabled).length;
    const disabledCount = statuses.length - enabledCount;

    return c.json({
      ...paginate(devicesData, page, limit),
      summary: {
        total: statuses.length,
        enabled: enabledCount,
        disabled: disabledCount,
        coveragePercent: statuses.length ? Math.round((enabledCount / statuses.length) * 100) : 0
      }
    });
  }
);

securityRoutes.get(
  '/encryption',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', encryptionQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);

    const statuses = (await listStatusRows(auth)).map(toStatusResponse);

    const methodByOs: Record<'windows' | 'macos' | 'linux', string> = {
      windows: 'bitlocker',
      macos: 'filevault',
      linux: 'luks'
    };

    let devicesData = statuses.map((status) => {
      const encStatus = normalizeEncryption(status.encryptionStatus);
      const method = encStatus === 'unencrypted' ? 'none' : methodByOs[status.os];

      return {
        deviceId: status.deviceId,
        deviceName: status.deviceName,
        os: status.os,
        encryptionMethod: method,
        encryptionStatus: encStatus,
        volumes: [
          {
            drive: status.os === 'windows' ? 'C:' : status.os === 'macos' ? 'Macintosh HD' : '/dev/sda1',
            encrypted: encStatus !== 'unencrypted',
            method: method === 'bitlocker' ? 'BitLocker' : method === 'filevault' ? 'FileVault' : method === 'luks' ? 'LUKS2' : 'None',
            size: status.os === 'linux' ? '1 TB' : '512 GB'
          }
        ],
        tpmPresent: status.os === 'windows',
        recoveryKeyEscrowed: encStatus !== 'unencrypted' && status.os !== 'linux'
      };
    });

    if (query.status) {
      devicesData = devicesData.filter((device) => device.encryptionStatus === query.status);
    }

    if (query.os) {
      devicesData = devicesData.filter((device) => device.os === query.os);
    }

    if (query.search) {
      const term = query.search.toLowerCase();
      devicesData = devicesData.filter((device) => device.deviceName.toLowerCase().includes(term));
    }

    const fullyEncrypted = statuses.filter((status) => normalizeEncryption(status.encryptionStatus) === 'encrypted').length;
    const partial = statuses.filter((status) => normalizeEncryption(status.encryptionStatus) === 'partial').length;
    const unencrypted = statuses.filter((status) => normalizeEncryption(status.encryptionStatus) === 'unencrypted').length;

    return c.json({
      ...paginate(devicesData, page, limit),
      summary: {
        total: statuses.length,
        fullyEncrypted,
        partial,
        unencrypted,
        methodCounts: {
          bitlocker: devicesData.filter((device) => device.encryptionMethod === 'bitlocker').length,
          filevault: devicesData.filter((device) => device.encryptionMethod === 'filevault').length,
          luks: devicesData.filter((device) => device.encryptionMethod === 'luks').length,
          none: devicesData.filter((device) => device.encryptionMethod === 'none').length
        }
      }
    });
  }
);

securityRoutes.get(
  '/password-policy',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', passwordPolicyQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);

    const statuses = (await listStatusRows(auth)).map(toStatusResponse);

    const rules = [
      { rule: 'Minimum length (12+)', key: 'min_length' },
      { rule: 'Complexity required', key: 'complexity' },
      { rule: 'Maximum age (90 days)', key: 'max_age' },
      { rule: 'Account lockout (5 attempts)', key: 'lockout' },
      { rule: 'Password history (5)', key: 'history' }
    ];

    let devicesData = statuses.map((status) => {
      const failingChecks = status.status === 'unprotected' ? 3 : status.status === 'at_risk' ? 1 : 0;
      const checks = rules.map((rule, index) => ({
        rule: rule.rule,
        key: rule.key,
        pass: index >= failingChecks,
        current: index < failingChecks ? (index === 0 ? '8 chars' : index === 1 ? 'Disabled' : '180 days') : undefined,
        required: index < failingChecks ? (index === 0 ? '12 chars' : index === 1 ? 'Enabled' : '90 days') : undefined
      }));

      return {
        deviceId: status.deviceId,
        deviceName: status.deviceName,
        os: status.os,
        compliant: failingChecks === 0,
        checks,
        localAccounts: status.os === 'windows' ? 4 : 2,
        adminAccounts: status.os === 'windows' ? 2 : 1
      };
    });

    if (query.compliance) {
      const compliant = query.compliance === 'compliant';
      devicesData = devicesData.filter((device) => device.compliant === compliant);
    }

    if (query.os) {
      devicesData = devicesData.filter((device) => device.os === query.os);
    }

    if (query.search) {
      const term = query.search.toLowerCase();
      devicesData = devicesData.filter((device) => device.deviceName.toLowerCase().includes(term));
    }

    const compliantCount = devicesData.filter((device) => device.compliant).length;
    const total = devicesData.length;

    const failureCounts: Record<string, number> = {};
    for (const device of devicesData) {
      for (const check of device.checks) {
        if (!check.pass) {
          failureCounts[check.rule] = (failureCounts[check.rule] ?? 0) + 1;
        }
      }
    }

    const commonFailures = Object.entries(failureCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([rule, count]) => ({ rule, count }));

    return c.json({
      ...paginate(devicesData, page, limit),
      summary: {
        total,
        compliant: compliantCount,
        nonCompliant: total - compliantCount,
        compliancePercent: total ? Math.round((compliantCount / total) * 100) : 0,
        commonFailures
      }
    });
  }
);

securityRoutes.get(
  '/admin-audit',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', adminAuditQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);

    const statuses = (await listStatusRows(auth)).map(toStatusResponse);

    let rows = statuses.map((status) => {
      const isHighRisk = status.riskLevel === 'high' || status.riskLevel === 'critical';
      const accounts = status.os === 'windows'
        ? [
            {
              username: 'Administrator',
              isBuiltIn: true,
              enabled: isHighRisk,
              lastLogin: new Date(Date.now() - (isHighRisk ? 120 : 5) * 86400000).toISOString(),
              passwordAgeDays: isHighRisk ? 365 : 30,
              issues: isHighRisk ? ['default_account', 'stale_account'] : []
            },
            {
              username: 'IT-Admin',
              isBuiltIn: false,
              enabled: true,
              lastLogin: new Date(Date.now() - 2 * 86400000).toISOString(),
              passwordAgeDays: 45,
              issues: []
            }
          ]
        : status.os === 'macos'
          ? [
              {
                username: 'admin',
                isBuiltIn: false,
                enabled: true,
                lastLogin: new Date(Date.now() - 86400000).toISOString(),
                passwordAgeDays: 60,
                issues: []
              }
            ]
          : [
              {
                username: 'root',
                isBuiltIn: true,
                enabled: true,
                lastLogin: new Date(Date.now() - (isHighRisk ? 90 : 10) * 86400000).toISOString(),
                passwordAgeDays: isHighRisk ? 200 : 30,
                issues: isHighRisk ? ['weak_password', 'stale_account'] : []
              }
            ];

      const issueTypes = Array.from(new Set(accounts.flatMap((account) => account.issues)));

      return {
        deviceId: status.deviceId,
        deviceName: status.deviceName,
        os: status.os,
        adminAccounts: accounts,
        totalAdmins: accounts.length,
        hasIssues: issueTypes.length > 0,
        issueTypes
      };
    });

    if (query.issue) {
      if (query.issue === 'no_issues') {
        rows = rows.filter((row) => !row.hasIssues);
      } else {
        rows = rows.filter((row) => row.issueTypes.includes(query.issue as string));
      }
    }

    if (query.os) {
      rows = rows.filter((row) => row.os === query.os);
    }

    if (query.search) {
      const term = query.search.toLowerCase();
      rows = rows.filter((row) => {
        return row.deviceName.toLowerCase().includes(term) || row.adminAccounts.some((account) => account.username.toLowerCase().includes(term));
      });
    }

    const devicesWithIssues = rows.filter((row) => row.hasIssues).length;
    const totalAdmins = rows.reduce((sum, row) => sum + row.totalAdmins, 0);
    const defaultAccounts = rows.reduce((sum, row) => sum + row.adminAccounts.filter((account) => account.issues.includes('default_account')).length, 0);
    const weakPasswords = rows.reduce((sum, row) => sum + row.adminAccounts.filter((account) => account.issues.includes('weak_password')).length, 0);
    const staleAccounts = rows.reduce((sum, row) => sum + row.adminAccounts.filter((account) => account.issues.includes('stale_account')).length, 0);

    return c.json({
      ...paginate(rows, page, limit),
      summary: {
        totalDevices: rows.length,
        devicesWithIssues,
        totalAdmins,
        defaultAccounts,
        weakPasswords,
        staleAccounts
      }
    });
  }
);

securityRoutes.get(
  '/recommendations',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', recommendationsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);

    const statuses = (await listStatusRows(auth, query.orgId)).map(toStatusResponse);
    const threats = await listThreatRows(auth, undefined, query.orgId);
    const recommendationStatusMap = await getRecommendationStatusMap(auth, query.orgId);

    let recommendations = buildRecommendations(statuses, threats).map((rec) => ({
      ...rec,
      status: recommendationStatusMap.get(rec.id) ?? 'open'
    }));

    if (query.priority) {
      recommendations = recommendations.filter((rec) => rec.priority === query.priority);
    }

    if (query.category) {
      recommendations = recommendations.filter((rec) => rec.category === query.category);
    }

    if (query.status) {
      recommendations = recommendations.filter((rec) => rec.status === query.status);
    }

    const all = buildRecommendations(statuses, threats).map((rec) => ({
      ...rec,
      status: recommendationStatusMap.get(rec.id) ?? 'open'
    }));

    return c.json({
      ...paginate(recommendations, page, limit),
      summary: {
        total: all.length,
        open: all.filter((rec) => rec.status === 'open').length,
        completed: all.filter((rec) => rec.status === 'completed').length,
        dismissed: all.filter((rec) => rec.status === 'dismissed').length,
        criticalAndHigh: all.filter((rec) => rec.priority === 'critical' || rec.priority === 'high').length
      }
    });
  }
);

securityRoutes.post(
  '/recommendations/:id/complete',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', recommendationActionSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const orgId = getPolicyOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'Unable to determine organization context' }, 400);
    }

    const statuses = (await listStatusRows(auth, orgId)).map(toStatusResponse);
    const threats = await listThreatRows(auth, undefined, orgId);
    const recommendation = buildRecommendations(statuses, threats).find((item) => item.id === id);
    if (!recommendation) {
      return c.json({ error: 'Recommendation not found' }, 404);
    }

    await db.insert(auditLogs).values({
      orgId,
      actorType: 'user',
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'security.recommendation.complete',
      resourceType: 'security_recommendation',
      resourceName: id,
      details: { recommendationId: id },
      result: 'success'
    });

    return c.json({ data: { id, status: 'completed' } });
  }
);

securityRoutes.post(
  '/recommendations/:id/dismiss',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', recommendationActionSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');
    const orgId = getPolicyOrgId(auth);
    if (!orgId) {
      return c.json({ error: 'Unable to determine organization context' }, 400);
    }

    const statuses = (await listStatusRows(auth, orgId)).map(toStatusResponse);
    const threats = await listThreatRows(auth, undefined, orgId);
    const recommendation = buildRecommendations(statuses, threats).find((item) => item.id === id);
    if (!recommendation) {
      return c.json({ error: 'Recommendation not found' }, 404);
    }

    await db.insert(auditLogs).values({
      orgId,
      actorType: 'user',
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'security.recommendation.dismiss',
      resourceType: 'security_recommendation',
      resourceName: id,
      details: { recommendationId: id },
      result: 'success'
    });

    return c.json({ data: { id, status: 'dismissed' } });
  }
);
