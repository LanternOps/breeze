import { and, desc, eq, inArray } from 'drizzle-orm';

import { db } from '../../db';
import {
  auditLogs,
  devices,
  securityStatus,
  securityThreats
} from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { CommandTypes, queueCommand } from '../../services/commandQueue';
import type { SecurityPostureItem } from '../../services/securityPosture';
import {
  providerCatalog,
  type Be9Recommendation,
  type ParsedAdminAccount,
  type ParsedAdminSummary,
  type ParsedPasswordPolicy,
  type PolicyCheckResponse,
  type PostureFactorKey,
  type ProviderKey,
  type RiskLevel,
  type SecurityState,
  type StatusRow,
  type ThreatRow,
  type ThreatStatus,
  priorityRank
} from './schemas';
import {
  listLatestSecurityPosture
} from '../../services/securityPosture';

// ── Pagination ──────────────────────────────────────────────────────────────

export { getPagination } from '../../utils/pagination';

export function paginate<T>(items: T[], page: number, limit: number) {
  const total = items.length;
  const totalPages = total === 0 ? 1 : Math.ceil(total / limit);
  const offset = (page - 1) * limit;
  return {
    data: items.slice(offset, offset + limit),
    pagination: { page, limit, total, totalPages }
  };
}

export function parseDateRange(startDate?: string, endDate?: string) {
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

export function matchDateRange(value: Date | null, start?: Date, end?: Date): boolean {
  if (!value) return false;
  if (start && value < start) return false;
  if (end && value > end) return false;
  return true;
}

// ── Normalization ───────────────────────────────────────────────────────────

export function normalizeProvider(provider: string | null): ProviderKey {
  if (!provider) return 'other';
  if (provider in providerCatalog) {
    return provider as ProviderKey;
  }
  return 'other';
}

export function mapThreatStatus(status: string): ThreatStatus {
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

export function mapThreatFilterToDb(status: ThreatStatus): string[] {
  if (status === 'active') return ['detected', 'failed'];
  if (status === 'quarantined') return ['quarantined'];
  return ['removed', 'allowed'];
}

export function normalizeEncryption(encryptionStatus: string): 'encrypted' | 'partial' | 'unencrypted' {
  const value = encryptionStatus.toLowerCase();
  if (value.includes('partial')) return 'partial';
  if (value.includes('encrypted')) return 'encrypted';
  return 'unencrypted';
}

// ── Posture / Risk ──────────────────────────────────────────────────────────

export function computePosture(row: StatusRow): { status: SecurityState; riskLevel: RiskLevel } {
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

export function toStatusResponse(row: StatusRow) {
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

export function computeSecurityScore(statuses: ReturnType<typeof toStatusResponse>[], threatRows: ThreatRow[]): number {
  if (statuses.length === 0) return 0;

  const protectedPct = (statuses.filter((s) => s.status === 'protected').length / statuses.length) * 100;
  const firewallPct = (statuses.filter((s) => s.firewallEnabled).length / statuses.length) * 100;
  const encryptionPct = (statuses.filter((s) => s.encryptionStatus !== 'unencrypted').length / statuses.length) * 100;
  const activeThreatPenalty = Math.min(25, threatRows.filter((t) => t.status === 'active').length * 4);

  const rawScore = (protectedPct * 0.45) + (firewallPct * 0.25) + (encryptionPct * 0.30) - activeThreatPenalty;
  return Math.max(0, Math.min(100, Math.round(rawScore)));
}

// ── DB queries ──────────────────────────────────────────────────────────────

export async function listStatusRows(auth: AuthContext, orgId?: string): Promise<StatusRow[]> {
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

export async function listThreatRows(auth: AuthContext, deviceId?: string, orgId?: string): Promise<ThreatRow[]> {
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

export function getPolicyOrgId(auth: AuthContext): string | null {
  if (auth.orgId) return auth.orgId;
  if (auth.accessibleOrgIds && auth.accessibleOrgIds.length === 1) {
    return auth.accessibleOrgIds[0] ?? null;
  }
  return null;
}

export async function getRecommendationStatusMap(auth: AuthContext, orgId?: string): Promise<Map<string, 'dismissed' | 'completed'>> {
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

// ── Org scoping ─────────────────────────────────────────────────────────────

export function resolveScopedOrgIds(
  auth: AuthContext,
  orgId?: string
): { orgIds?: string[]; error?: { status: 400 | 403; message: string } } {
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

// ── Type-safe extractors ────────────────────────────────────────────────────

export function toObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function toBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false;
  }
  return null;
}

export function toStringValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

// ── Analysis utilities ──────────────────────────────────────────────────────

export function isOlderThanDays(value: string, days: number): boolean {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return Date.now() - parsed.getTime() > days * 24 * 60 * 60 * 1000;
}

export function normalizeIssueName(raw: string): 'default_account' | 'weak_password' | 'stale_account' | null {
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

// ── Data parsers ────────────────────────────────────────────────────────────

export function parsePasswordPolicySummary(raw: unknown): ParsedPasswordPolicy {
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
        const check: PolicyCheckResponse = { rule, key, pass };
        if (current !== undefined) check.current = current;
        if (required !== undefined) check.required = required;
        return check;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

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

export function parseLocalAdminSummary(raw: unknown): ParsedAdminSummary {
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

// ── Posture scoring ─────────────────────────────────────────────────────────

export function averageFactorScore(posture: SecurityPostureItem[], factor: PostureFactorKey): number {
  if (posture.length === 0) return 0;
  return Math.round(
    posture.reduce((sum, item) => sum + item.factors[factor].score, 0) / posture.length
  );
}

export function countFactorBelow(posture: SecurityPostureItem[], factor: PostureFactorKey, threshold: number): number {
  return posture.filter((item) => item.factors[factor].score < threshold).length;
}

export function priorityFromAffected(
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

export function impactFromAffected(affectedDevices: number, totalDevices: number): 'high' | 'medium' | 'low' {
  if (affectedDevices <= 0 || totalDevices <= 0) return 'low';
  const ratio = affectedDevices / totalDevices;
  if (ratio >= 0.3) return 'high';
  if (ratio >= 0.12) return 'medium';
  return 'low';
}

// ── Threat actions ──────────────────────────────────────────────────────────

export async function queueThreatAction(c: any, action: 'quarantine' | 'remove' | 'restore') {
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

// ── Recommendations engine ──────────────────────────────────────────────────

export async function buildBe9Recommendations(
  auth: AuthContext,
  orgId?: string
): Promise<{ recommendations: Be9Recommendation[]; error?: { status: 400 | 403; message: string } }> {
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
