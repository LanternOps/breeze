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
import {
  getLatestSecurityPostureForDevice,
  getSecurityPostureTrend,
  listLatestSecurityPosture
} from '../services/securityPosture';
import type { SecurityPostureItem } from '../services/securityPosture';

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
  encryptionDetails: unknown;
  localAdminSummary: unknown;
  passwordPolicySummary: unknown;
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

const postureQuerySchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  minScore: z.string().optional(),
  maxScore: z.string().optional(),
  riskLevel: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  search: z.string().optional()
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
      encryptionDetails: securityStatus.encryptionDetails,
      localAdminSummary: securityStatus.localAdminSummary,
      passwordPolicySummary: securityStatus.passwordPolicySummary,
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
    encryptionDetails: row.encryptionDetails ?? null,
    localAdminSummary: row.localAdminSummary ?? null,
    passwordPolicySummary: row.passwordPolicySummary ?? null,
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

type PostureFactorKey = keyof SecurityPostureItem['factors'];

type PolicyCheckResponse = {
  rule: string;
  key: string;
  pass: boolean;
  current?: string;
  required?: string;
};

type ParsedPasswordPolicy = {
  checks: PolicyCheckResponse[];
  compliant: boolean;
};

type ParsedAdminAccount = {
  username: string;
  isBuiltIn: boolean;
  enabled: boolean;
  lastLogin: string;
  passwordAgeDays: number;
  issues: Array<'default_account' | 'weak_password' | 'stale_account'>;
};

type ParsedAdminSummary = {
  accounts: ParsedAdminAccount[];
  totalAdmins: number;
  localAccounts: number;
  issueTypes: Array<'default_account' | 'weak_password' | 'stale_account'>;
  issueCounts: {
    defaultAccounts: number;
    weakPasswords: number;
    staleAccounts: number;
  };
};

type Be9Recommendation = {
  id: string;
  title: string;
  description: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  impact: 'high' | 'medium' | 'low';
  effort: 'low' | 'medium' | 'high';
  affectedDevices: number;
  steps: string[];
};

const postureComponentModel: Array<{ category: PostureFactorKey; label: string; weight: number }> = [
  { category: 'patch_compliance', label: 'Patch Compliance', weight: 25 },
  { category: 'encryption', label: 'Disk Encryption', weight: 15 },
  { category: 'av_health', label: 'AV Health', weight: 15 },
  { category: 'firewall', label: 'Firewall Status', weight: 10 },
  { category: 'open_ports', label: 'Open Ports Exposure', weight: 10 },
  { category: 'password_policy', label: 'Password Policy', weight: 10 },
  { category: 'os_currency', label: 'OS Currency', weight: 10 },
  { category: 'admin_exposure', label: 'Admin Exposure', weight: 5 }
];

const priorityRank: Record<'critical' | 'high' | 'medium' | 'low', number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1
};

function resolveScopedOrgIds(
  auth: AuthContext,
  orgId?: string
): { orgIds?: string[]; error?: { status: number; message: string } } {
  if (orgId) {
    if (!auth.canAccessOrg(orgId)) {
      return { error: { status: 403, message: 'Access denied to this organization' } };
    }
    return { orgIds: [orgId] };
  }

  if (auth.orgId) {
    return { orgIds: [auth.orgId] };
  }
  if (auth.accessibleOrgIds && auth.accessibleOrgIds.length > 0) {
    return { orgIds: auth.accessibleOrgIds };
  }
  if (auth.scope === 'system') {
    return {};
  }
  return { error: { status: 400, message: 'Organization context required' } };
}

function toObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false;
  }
  return null;
}

function toStringValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

function isOlderThanDays(value: string, days: number): boolean {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return Date.now() - parsed.getTime() > days * 24 * 60 * 60 * 1000;
}

function normalizeIssueName(raw: string): 'default_account' | 'weak_password' | 'stale_account' | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (value === 'default_account' || value === 'default' || value === 'builtin' || value === 'built_in') {
    return 'default_account';
  }
  if (value === 'weak_password' || value === 'weak' || value === 'password_weak') {
    return 'weak_password';
  }
  if (value === 'stale_account' || value === 'stale' || value === 'inactive') {
    return 'stale_account';
  }
  return null;
}

function parsePasswordPolicySummary(raw: unknown): ParsedPasswordPolicy {
  const summary = toObject(raw);
  if (!summary) {
    return {
      checks: [
        { rule: 'Minimum length (12+)', key: 'min_length', pass: false, current: 'Unknown', required: '12 chars' },
        { rule: 'Complexity required', key: 'complexity', pass: false, current: 'Unknown', required: 'Enabled' },
        { rule: 'Maximum age (90 days)', key: 'max_age', pass: false, current: 'Unknown', required: '90 days' },
        { rule: 'Account lockout (5 attempts)', key: 'lockout', pass: false, current: 'Unknown', required: '1-5 attempts' },
        { rule: 'Password history (5)', key: 'history', pass: false, current: 'Unknown', required: '5+' }
      ],
      compliant: false
    };
  }

  const checksRaw = Array.isArray(summary.checks) ? summary.checks : null;
  if (checksRaw && checksRaw.length > 0) {
    const checks = checksRaw
      .map((entry, index) => {
        const item = toObject(entry);
        if (!item) return null;
        const pass = toBoolean(item.pass) ?? false;
        const key = toStringValue(item.key) ?? `check_${index + 1}`;
        const rule = toStringValue(item.rule) ?? key;
        const current = toStringValue(item.current) ?? undefined;
        const required = toStringValue(item.required) ?? undefined;
        return { rule, key, pass, current, required };
      })
      .filter((entry): entry is PolicyCheckResponse => entry !== null);

    if (checks.length > 0) {
      return {
        checks,
        compliant: checks.every((check) => check.pass)
      };
    }
  }

  const minLength = toNumber(summary.minLength ?? summary.minimumLength ?? summary.passwordMinLength);
  const complexityEnabled = toBoolean(summary.complexityEnabled ?? summary.complexity ?? summary.passwordComplexity);
  const maxAgeDays = toNumber(summary.maxAgeDays ?? summary.maxPasswordAgeDays ?? summary.passwordMaxAgeDays);
  const lockoutThreshold = toNumber(summary.lockoutThreshold ?? summary.accountLockoutThreshold ?? summary.maxFailedAttempts);
  const historyCount = toNumber(summary.historyCount ?? summary.passwordHistoryCount ?? summary.passwordHistory);

  const checks: PolicyCheckResponse[] = [
    {
      rule: 'Minimum length (12+)',
      key: 'min_length',
      pass: minLength !== null ? minLength >= 12 : false,
      current: minLength !== null ? `${Math.round(minLength)} chars` : 'Unknown',
      required: '12 chars'
    },
    {
      rule: 'Complexity required',
      key: 'complexity',
      pass: complexityEnabled !== null ? complexityEnabled : false,
      current: complexityEnabled !== null ? (complexityEnabled ? 'Enabled' : 'Disabled') : 'Unknown',
      required: 'Enabled'
    },
    {
      rule: 'Maximum age (90 days)',
      key: 'max_age',
      pass: maxAgeDays !== null ? maxAgeDays <= 90 : false,
      current: maxAgeDays !== null ? `${Math.round(maxAgeDays)} days` : 'Unknown',
      required: '90 days'
    },
    {
      rule: 'Account lockout (5 attempts)',
      key: 'lockout',
      pass: lockoutThreshold !== null ? lockoutThreshold > 0 && lockoutThreshold <= 5 : false,
      current: lockoutThreshold !== null ? `${Math.round(lockoutThreshold)} attempts` : 'Unknown',
      required: '1-5 attempts'
    },
    {
      rule: 'Password history (5)',
      key: 'history',
      pass: historyCount !== null ? historyCount >= 5 : false,
      current: historyCount !== null ? `${Math.round(historyCount)}` : 'Unknown',
      required: '5+'
    }
  ];

  return {
    checks,
    compliant: checks.every((check) => check.pass)
  };
}

function parseLocalAdminSummary(raw: unknown): ParsedAdminSummary {
  const summary = toObject(raw);
  if (!summary) {
    return {
      accounts: [],
      totalAdmins: 0,
      localAccounts: 0,
      issueTypes: [],
      issueCounts: { defaultAccounts: 0, weakPasswords: 0, staleAccounts: 0 }
    };
  }

  const accountsRaw = Array.isArray(summary.accounts)
    ? summary.accounts
    : Array.isArray(summary.adminAccounts)
      ? summary.adminAccounts
      : Array.isArray(summary.members)
        ? summary.members
        : Array.isArray(summary.users)
          ? summary.users
          : [];

  const accounts: ParsedAdminAccount[] = accountsRaw
    .map((entry, index) => {
      const account = toObject(entry);
      if (!account) return null;

      const username = toStringValue(account.username ?? account.name ?? account.accountName) ?? `admin-${index + 1}`;
      const isBuiltIn = toBoolean(account.isBuiltIn ?? account.builtIn ?? account.defaultAccount) ?? false;
      const enabled = toBoolean(account.enabled ?? account.isEnabled ?? account.active) ?? true;
      const lastLogin = toStringValue(account.lastLogin ?? account.lastLoginAt ?? account.lastSeenAt ?? account.lastLogon) ?? '';
      const passwordAgeDays = Math.max(
        0,
        Math.round(toNumber(account.passwordAgeDays ?? account.passwordAge ?? account.passwordAgeInDays) ?? 0)
      );

      const issueSet = new Set<'default_account' | 'weak_password' | 'stale_account'>();
      const rawIssues = Array.isArray(account.issues) ? account.issues : [];
      for (const issue of rawIssues) {
        if (typeof issue !== 'string') continue;
        const normalized = normalizeIssueName(issue);
        if (normalized) issueSet.add(normalized);
      }

      if ((toBoolean(account.defaultAccount) ?? false) || (isBuiltIn && enabled)) {
        issueSet.add('default_account');
      }
      if ((toBoolean(account.weakPassword) ?? false) || passwordAgeDays > 180) {
        issueSet.add('weak_password');
      }
      if ((toBoolean(account.stale) ?? false) || (lastLogin && isOlderThanDays(lastLogin, 90))) {
        issueSet.add('stale_account');
      }

      return {
        username,
        isBuiltIn,
        enabled,
        lastLogin,
        passwordAgeDays,
        issues: Array.from(issueSet)
      };
    })
    .filter((entry): entry is ParsedAdminAccount => entry !== null);

  const derivedCounts = {
    defaultAccounts: accounts.filter((account) => account.issues.includes('default_account')).length,
    weakPasswords: accounts.filter((account) => account.issues.includes('weak_password')).length,
    staleAccounts: accounts.filter((account) => account.issues.includes('stale_account')).length
  };

  const defaultAccounts = Math.max(
    0,
    Math.round(
      toNumber(summary.defaultAccountCount ?? summary.defaultAccounts ?? summary.defaultCount) ?? derivedCounts.defaultAccounts
    )
  );
  const weakPasswords = Math.max(
    0,
    Math.round(toNumber(summary.weakPasswordCount ?? summary.weakPasswords ?? summary.weakCount) ?? derivedCounts.weakPasswords)
  );
  const staleAccounts = Math.max(
    0,
    Math.round(toNumber(summary.staleAccountCount ?? summary.staleAccounts ?? summary.staleCount) ?? derivedCounts.staleAccounts)
  );

  const totalAdmins = Math.max(
    accounts.length,
    Math.round(toNumber(summary.adminCount ?? summary.totalAdmins ?? summary.count) ?? accounts.length)
  );

  const localAccounts = Math.max(
    totalAdmins,
    Math.round(toNumber(summary.localAccountCount ?? summary.localAccounts ?? summary.accountCount) ?? totalAdmins)
  );

  const issueSet = new Set<'default_account' | 'weak_password' | 'stale_account'>();
  if (defaultAccounts > 0) issueSet.add('default_account');
  if (weakPasswords > 0) issueSet.add('weak_password');
  if (staleAccounts > 0) issueSet.add('stale_account');
  for (const account of accounts) {
    for (const issue of account.issues) {
      issueSet.add(issue);
    }
  }

  return {
    accounts,
    totalAdmins,
    localAccounts,
    issueTypes: Array.from(issueSet),
    issueCounts: {
      defaultAccounts,
      weakPasswords,
      staleAccounts
    }
  };
}

function averageFactorScore(posture: SecurityPostureItem[], factor: PostureFactorKey): number {
  if (posture.length === 0) return 0;
  return Math.round(
    posture.reduce((sum, item) => sum + item.factors[factor].score, 0) / posture.length
  );
}

function countFactorBelow(posture: SecurityPostureItem[], factor: PostureFactorKey, threshold: number): number {
  return posture.filter((item) => item.factors[factor].score < threshold).length;
}

function priorityFromAffected(
  affectedDevices: number,
  totalDevices: number,
  baseline: 'critical' | 'high' | 'medium' | 'low'
): 'critical' | 'high' | 'medium' | 'low' {
  if (affectedDevices <= 0 || totalDevices <= 0) return 'low';
  const ratio = affectedDevices / totalDevices;
  const dynamic: 'critical' | 'high' | 'medium' | 'low' =
    ratio >= 0.45 ? 'critical' : ratio >= 0.25 ? 'high' : ratio >= 0.1 ? 'medium' : 'low';
  return priorityRank[dynamic] > priorityRank[baseline] ? dynamic : baseline;
}

function impactFromAffected(affectedDevices: number, totalDevices: number): 'high' | 'medium' | 'low' {
  if (affectedDevices <= 0 || totalDevices <= 0) return 'low';
  const ratio = affectedDevices / totalDevices;
  if (ratio >= 0.3) return 'high';
  if (ratio >= 0.12) return 'medium';
  return 'low';
}

async function buildBe9Recommendations(
  auth: AuthContext,
  orgId?: string
): Promise<{ recommendations: Be9Recommendation[]; error?: { status: number; message: string } }> {
  const scope = resolveScopedOrgIds(auth, orgId);
  if (scope.error) {
    return { recommendations: [], error: scope.error };
  }

  const [posture, threats] = await Promise.all([
    listLatestSecurityPosture({
      orgIds: scope.orgIds,
      limit: 2000
    }),
    listThreatRows(auth, undefined, orgId)
  ]);

  const totalDevices = posture.length;
  if (totalDevices === 0) {
    return { recommendations: [] };
  }

  const activeThreatDevices = new Set(
    threats.filter((threat) => threat.status === 'active').map((threat) => threat.deviceId)
  );

  const vulnerabilityDevices = new Set(activeThreatDevices);
  for (const item of posture) {
    if (item.factors.open_ports.score < 70 || item.factors.os_currency.score < 70) {
      vulnerabilityDevices.add(item.deviceId);
    }
  }

  const affectedCounts = {
    antivirus: countFactorBelow(posture, 'av_health', 80),
    firewall: countFactorBelow(posture, 'firewall', 90),
    encryption: countFactorBelow(posture, 'encryption', 90),
    password_policy: countFactorBelow(posture, 'password_policy', 85),
    admin_accounts: countFactorBelow(posture, 'admin_exposure', 85),
    patch_compliance: countFactorBelow(posture, 'patch_compliance', 90),
    vulnerability_management: vulnerabilityDevices.size
  };

  const definitions: Array<{
    id: string;
    category: keyof typeof affectedCounts;
    title: string;
    description: string;
    effort: 'low' | 'medium' | 'high';
    baseline: 'critical' | 'high' | 'medium' | 'low';
    steps: string[];
  }> = [
    {
      id: 'rec-enable-av',
      category: 'antivirus',
      title: 'Improve antivirus health coverage',
      description: 'Real-time protection or signature freshness is below target on part of the fleet.',
      effort: 'medium',
      baseline: 'high',
      steps: [
        'Enable real-time protection and ensure endpoint AV services are healthy.',
        'Update definitions and verify freshness is within policy target.',
        'Re-scan endpoints with active detections and confirm remediation.'
      ]
    },
    {
      id: 'rec-active-threats',
      category: 'vulnerability_management',
      title: 'Reduce active threat and exposure risk',
      description: 'Active threats and/or high-risk exposure factors are increasing incident likelihood.',
      effort: 'high',
      baseline: 'critical',
      steps: [
        'Contain devices with active threats first.',
        'Close risky listening services and validate host firewall policy.',
        'Prioritize OS and patch remediation for devices with lowest posture.'
      ]
    },
    {
      id: 'rec-enable-firewall',
      category: 'firewall',
      title: 'Increase firewall enforcement',
      description: 'Firewall posture is below policy on a subset of devices.',
      effort: 'medium',
      baseline: 'high',
      steps: [
        'Audit policy exceptions and remove unnecessary allowances.',
        'Enforce firewall state through endpoint policy.',
        'Validate business-critical application traffic post-change.'
      ]
    },
    {
      id: 'rec-enable-encryption',
      category: 'encryption',
      title: 'Increase disk encryption coverage',
      description: 'Encryption posture indicates incomplete or missing data protection on some endpoints.',
      effort: 'high',
      baseline: 'high',
      steps: [
        'Escrow recovery materials before enforcement.',
        'Enable disk encryption for at-risk endpoints in phased waves.',
        'Verify full volume protection and recovery workflows.'
      ]
    },
    {
      id: 'rec-password-policy',
      category: 'password_policy',
      title: 'Improve password policy compliance',
      description: 'Password policy baselines are failing for part of the fleet.',
      effort: 'low',
      baseline: 'medium',
      steps: [
        'Enforce minimum length and complexity requirements.',
        'Set lockout threshold and password aging limits.',
        'Re-audit local account policy drift after rollout.'
      ]
    },
    {
      id: 'rec-admin-accounts',
      category: 'admin_accounts',
      title: 'Reduce privileged account exposure',
      description: 'Local administrative exposure is elevated on some endpoints.',
      effort: 'medium',
      baseline: 'medium',
      steps: [
        'Remove unused local administrators.',
        'Rotate passwords for remaining privileged accounts.',
        'Disable or rename default built-in privileged identities where allowed.'
      ]
    },
    {
      id: 'rec-patch-compliance',
      category: 'patch_compliance',
      title: 'Improve critical patch compliance',
      description: 'Critical and important patch installation rates are below target.',
      effort: 'medium',
      baseline: 'high',
      steps: [
        'Prioritize devices with the lowest patch compliance scores.',
        'Schedule maintenance windows for pending critical updates.',
        'Reassess posture after deployment and close out exceptions.'
      ]
    }
  ];

  const recommendations = definitions
    .map((definition) => {
      const affectedDevices = affectedCounts[definition.category];
      if (affectedDevices <= 0) return null;
      return {
        id: definition.id,
        title: definition.title,
        description: definition.description,
        priority: priorityFromAffected(affectedDevices, totalDevices, definition.baseline),
        category: definition.category,
        impact: impactFromAffected(affectedDevices, totalDevices),
        effort: definition.effort,
        affectedDevices,
        steps: definition.steps
      } as Be9Recommendation;
    })
    .filter((entry): entry is Be9Recommendation => entry !== null)
    .sort((a, b) => {
      const byPriority = priorityRank[b.priority] - priorityRank[a.priority];
      if (byPriority !== 0) return byPriority;
      return b.affectedDevices - a.affectedDevices;
    });

  return { recommendations };
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
    const scope = resolveScopedOrgIds(auth, query.orgId);
    if (scope.error) {
      return c.json({ error: scope.error.message }, scope.error.status);
    }

    const [statusRows, threats, posture, recommendationsResult, trendPoints] = await Promise.all([
      listStatusRows(auth, query.orgId),
      listThreatRows(auth, undefined, query.orgId),
      listLatestSecurityPosture({
        orgIds: scope.orgIds,
        limit: 2000
      }),
      buildBe9Recommendations(auth, query.orgId),
      getSecurityPostureTrend({
        orgIds: scope.orgIds,
        days: 30
      })
    ]);
    const statuses = statusRows.map(toStatusResponse);

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

    const totalDevices = posture.length > 0 ? posture.length : statuses.length;
    const protectedDevices = posture.length > 0
      ? posture.filter((item) => item.deviceStatus === 'online' && item.riskLevel === 'low').length
      : statuses.filter((status) => status.status === 'protected').length;
    const atRiskDevices = posture.length > 0
      ? posture.filter((item) => item.riskLevel === 'medium' || item.riskLevel === 'high').length
      : statuses.filter((status) => status.status === 'at_risk').length;
    const unprotectedDevices = posture.length > 0
      ? posture.filter((item) => item.riskLevel === 'critical').length
      : statuses.filter((status) => status.status === 'unprotected').length;
    const offlineDevices = posture.length > 0
      ? posture.filter((item) => item.deviceStatus !== 'online').length
      : statuses.filter((status) => status.status === 'offline').length;
    const securityScore = posture.length > 0
      ? Math.round(posture.reduce((sum, item) => sum + item.overallScore, 0) / posture.length)
      : computeSecurityScore(statuses, threats);

    const passwordPolicyCompliance = averageFactorScore(posture, 'password_policy');

    const parsedAdmins = statusRows.map((row) => parseLocalAdminSummary(row.localAdminSummary));
    const defaultAccounts = parsedAdmins.reduce((sum, admin) => sum + admin.issueCounts.defaultAccounts, 0);
    const weakAccounts = parsedAdmins.reduce((sum, admin) => sum + admin.issueCounts.weakPasswords, 0);

    const encryptedStatuses = statuses.filter((status) => status.encryptionStatus !== 'unencrypted');
    const bitlockerEnabled = encryptedStatuses.filter((status) => status.os === 'windows').length;
    const filevaultEnabled = encryptedStatuses.filter((status) => status.os === 'macos').length;

    const chartTrend = trendPoints.map((point) => ({
      timestamp: String(point.timestamp),
      score: Number(point.overall ?? 0)
    }));

    return c.json({
      data: {
        totalDevices,
        protectedDevices,
        atRiskDevices,
        unprotectedDevices,
        offlineDevices,
        totalThreatsDetected: threats.length,
        activeThreats: threats.filter((threat) => threat.status === 'active').length,
        quarantinedThreats: threats.filter((threat) => threat.status === 'quarantined').length,
        removedThreats: threats.filter((threat) => threat.status === 'removed').length,
        lastScanAt,
        providers,
        securityScore,
        overallScore: securityScore,
        firewallEnabled: statuses.filter((status) => status.firewallEnabled).length,
        firewallDisabled: statuses.filter((status) => !status.firewallEnabled).length,
        encryption: {
          bitlockerEnabled,
          filevaultEnabled,
          total: statuses.length
        },
        passwordPolicyCompliance,
        adminAudit: {
          defaultAccounts,
          weakAccounts,
          deviceCount: statuses.length,
          devices: statusRows
            .map((row) => {
              const parsed = parseLocalAdminSummary(row.localAdminSummary);
              if (parsed.issueTypes.length === 0) return null;
              return {
                id: row.deviceId,
                name: row.deviceName,
                issue: parsed.issueTypes[0]
              };
            })
            .filter((row): row is { id: string; name: string; issue: string } => row !== null)
            .slice(0, 10)
        },
        recommendations: (recommendationsResult.error ? [] : recommendationsResult.recommendations).map((rec) => ({
          id: rec.id,
          title: rec.title,
          description: rec.description,
          priority: rec.priority,
          category: rec.category
        })),
        trend: chartTrend
      }
    });
  }
);

securityRoutes.get(
  '/score-breakdown',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const scope = resolveScopedOrgIds(auth);
    if (scope.error) {
      return c.json({ error: scope.error.message }, scope.error.status);
    }

    const posture = await listLatestSecurityPosture({
      orgIds: scope.orgIds,
      limit: 2000
    });
    const total = posture.length;
    const stateOf = (score: number) => (score >= 90 ? 'good' : score >= 75 ? 'warning' : 'critical');

    const components = postureComponentModel.map((component) => {
      const score = averageFactorScore(posture, component.category);
      return {
        category: component.category,
        label: component.label,
        score,
        weight: component.weight,
        status: stateOf(score),
        affectedDevices: countFactorBelow(posture, component.category, 80),
        totalDevices: total
      };
    });

    const overallScore = total === 0
      ? 0
      : Math.round(posture.reduce((sum, item) => sum + item.overallScore, 0) / total);

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
  '/posture',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', postureQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit } = getPagination(query);

    if (query.orgId && !auth.canAccessOrg(query.orgId)) {
      return c.json({ error: 'Access denied to this organization' }, 403);
    }

    const parsedMinScore = query.minScore !== undefined ? Number.parseInt(query.minScore, 10) : undefined;
    const parsedMaxScore = query.maxScore !== undefined ? Number.parseInt(query.maxScore, 10) : undefined;
    if (parsedMinScore !== undefined && Number.isNaN(parsedMinScore)) {
      return c.json({ error: 'Invalid minScore' }, 400);
    }
    if (parsedMaxScore !== undefined && Number.isNaN(parsedMaxScore)) {
      return c.json({ error: 'Invalid maxScore' }, 400);
    }

    const orgIds = query.orgId
      ? [query.orgId]
      : auth.orgId
        ? [auth.orgId]
        : auth.accessibleOrgIds && auth.accessibleOrgIds.length > 0
          ? auth.accessibleOrgIds
          : undefined;

    if (!orgIds && auth.scope !== 'system') {
      return c.json({ error: 'Organization context required' }, 400);
    }

    const data = await listLatestSecurityPosture({
      orgIds,
      minScore: parsedMinScore,
      maxScore: parsedMaxScore,
      riskLevel: query.riskLevel,
      search: query.search,
      limit: Math.max(500, limit * page)
    });

    const summary = {
      totalDevices: data.length,
      averageScore: data.length
        ? Math.round(data.reduce((sum, item) => sum + item.overallScore, 0) / data.length)
        : 0,
      lowRiskDevices: data.filter((item) => item.riskLevel === 'low').length,
      mediumRiskDevices: data.filter((item) => item.riskLevel === 'medium').length,
      highRiskDevices: data.filter((item) => item.riskLevel === 'high').length,
      criticalRiskDevices: data.filter((item) => item.riskLevel === 'critical').length
    };

    return c.json({
      ...paginate(data, page, limit),
      summary
    });
  }
);

securityRoutes.get(
  '/posture/:deviceId',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { deviceId } = c.req.valid('param');

    const [device] = await db
      .select({
        id: devices.id,
        orgId: devices.orgId
      })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);

    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    if (!auth.canAccessOrg(device.orgId)) {
      return c.json({ error: 'Access denied to this device' }, 403);
    }

    const posture = await getLatestSecurityPostureForDevice(deviceId);
    if (!posture) {
      return c.json({ error: 'No security posture available for this device yet' }, 404);
    }
    return c.json({ data: posture });
  }
);

securityRoutes.get(
  '/trends',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', trendsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { period } = c.req.valid('query');
    const days = period === '7d' ? 7 : period === '90d' ? 90 : 30;

    const orgIds = auth.orgId
      ? [auth.orgId]
      : auth.accessibleOrgIds && auth.accessibleOrgIds.length > 0
        ? auth.accessibleOrgIds
        : undefined;

    const dataPoints = await getSecurityPostureTrend({
      orgIds,
      days
    });

    const previous = Number(dataPoints[0]?.overall ?? 0);
    const current = Number(dataPoints[dataPoints.length - 1]?.overall ?? 0);

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
    const statusRows = await listStatusRows(auth);

    let devicesData = statusRows.map((row) => {
      const policy = parsePasswordPolicySummary(row.passwordPolicySummary);
      const adminSummary = parseLocalAdminSummary(row.localAdminSummary);

      return {
        deviceId: row.deviceId,
        deviceName: row.deviceName,
        os: row.os,
        compliant: policy.compliant,
        checks: policy.checks,
        localAccounts: adminSummary.localAccounts,
        adminAccounts: adminSummary.totalAdmins
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
    const statusRows = await listStatusRows(auth);

    let rows = statusRows.map((row) => {
      const parsed = parseLocalAdminSummary(row.localAdminSummary);
      return {
        deviceId: row.deviceId,
        deviceName: row.deviceName,
        os: row.os,
        adminAccounts: parsed.accounts,
        totalAdmins: parsed.totalAdmins,
        hasIssues: parsed.issueTypes.length > 0,
        issueTypes: parsed.issueTypes,
        issueCounts: parsed.issueCounts
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
    const defaultAccounts = rows.reduce((sum, row) => sum + row.issueCounts.defaultAccounts, 0);
    const weakPasswords = rows.reduce((sum, row) => sum + row.issueCounts.weakPasswords, 0);
    const staleAccounts = rows.reduce((sum, row) => sum + row.issueCounts.staleAccounts, 0);

    return c.json({
      ...paginate(
        rows.map((row) => ({
          deviceId: row.deviceId,
          deviceName: row.deviceName,
          os: row.os,
          adminAccounts: row.adminAccounts,
          totalAdmins: row.totalAdmins,
          hasIssues: row.hasIssues,
          issueTypes: row.issueTypes
        })),
        page,
        limit
      ),
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
    const recommendationsResult = await buildBe9Recommendations(auth, query.orgId);
    if (recommendationsResult.error) {
      return c.json({ error: recommendationsResult.error.message }, recommendationsResult.error.status);
    }
    const recommendationStatusMap = await getRecommendationStatusMap(auth, query.orgId);

    let recommendations = recommendationsResult.recommendations.map((rec) => ({
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

    const all = recommendationsResult.recommendations.map((rec) => ({
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

    const recommendationsResult = await buildBe9Recommendations(auth, orgId);
    if (recommendationsResult.error) {
      return c.json({ error: recommendationsResult.error.message }, recommendationsResult.error.status);
    }
    const recommendation = recommendationsResult.recommendations.find((item) => item.id === id);
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

    const recommendationsResult = await buildBe9Recommendations(auth, orgId);
    if (recommendationsResult.error) {
      return c.json({ error: recommendationsResult.error.message }, recommendationsResult.error.status);
    }
    const recommendation = recommendationsResult.recommendations.find((item) => item.id === id);
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
