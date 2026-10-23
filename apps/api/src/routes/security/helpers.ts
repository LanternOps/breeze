import { and, desc, eq, inArray, ne, type SQL } from 'drizzle-orm';

import { db } from '../../db';
import {
  auditLogs,
  devices,
  securityStatus,
  securityThreats
} from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { canAccessSite, getUserPermissions, type UserPermissions } from '../../services/permissions';
import { siteAllowlistOf, siteScopeCondition } from '../../services/aiToolsSiteScope';
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
  // 'unencrypted' must be checked before 'encrypted' -- 'encrypted' is a
  // substring of 'unencrypted', so the original order classified every
  // unencrypted device as encrypted across the security views (#1831).
  if (value.includes('unencrypted')) return 'unencrypted';
  if (value.includes('encrypted')) return 'encrypted';
  return 'unencrypted';
}

// ── Posture / Risk ──────────────────────────────────────────────────────────

export function computePosture(row: StatusRow): { status: SecurityState; riskLevel: RiskLevel } {
  if (row.deviceState !== 'online') {
    return { status: 'offline', riskLevel: 'medium' };
  }

  let riskScore = 0;

  // Only a reported `false` is "off". A null reading is unknown (#8252): it adds
  // no penalty, but it cannot confirm protection either.
  if (row.realTimeProtection === false) riskScore += 2;
  if (row.firewallEnabled === false) riskScore += 1;
  if (normalizeEncryption(row.encryptionStatus) === 'unencrypted') riskScore += 1;
  riskScore += Math.min(3, row.threatCount);

  if (riskScore === 0) {
    const unverified = row.realTimeProtection === null || row.firewallEnabled === null;
    return unverified
      ? { status: 'at_risk', riskLevel: 'low' }
      : { status: 'protected', riskLevel: 'low' };
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
  const firewallPct = (statuses.filter((s) => s.firewallEnabled === true).length / statuses.length) * 100;
  const encryptionPct = (statuses.filter((s) => s.encryptionStatus !== 'unencrypted').length / statuses.length) * 100;
  const activeThreatPenalty = Math.min(25, threatRows.filter((t) => t.status === 'active').length * 4);

  const rawScore = (protectedPct * 0.45) + (firewallPct * 0.25) + (encryptionPct * 0.30) - activeThreatPenalty;
  return Math.max(0, Math.min(100, Math.round(rawScore)));
}

// ── DB queries ──────────────────────────────────────────────────────────────

export async function listStatusRows(auth: AuthContext, orgId?: string): Promise<StatusRow[]> {
  const conditions: SQL[] = [ne(devices.status, 'decommissioned')];
  const orgCondition = auth.orgCondition(devices.orgId);
  if (orgCondition) conditions.push(orgCondition);

  if (orgId) {
    if (!auth.canAccessOrg(orgId)) {
      return [];
    }
    conditions.push(eq(devices.orgId, orgId));
  }

  // Site is an app-layer axis that org RLS does not cover. Applied in SQL so
  // every projection and aggregate built on these rows sees visible devices only.
  const siteCondition = siteScopeCondition(auth, devices.siteId);
  if (siteCondition) conditions.push(siteCondition);

  const whereClause = and(...conditions);

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
    realTimeProtection: row.realTimeProtection ?? null,
    threatCount: row.threatCount ?? 0,
    firewallEnabled: row.firewallEnabled ?? null,
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
  const conditions: SQL[] = [ne(devices.status, 'decommissioned')];
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

  const siteCondition = siteScopeCondition(auth, devices.siteId);
  if (siteCondition) conditions.push(siteCondition);

  const whereClause = and(...conditions);

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

export type AffectedOrgBreakdown = Map<string, { affectedDevices: number; latestObservedMs: number }>;
export type RecommendationActionStatus = 'completed' | 'dismissed' | 'reopened';
export type RecommendationAction = { status: RecommendationActionStatus; at: Date };
/** recommendation id -> org id -> that org's newest action (#9641). */
export type RecommendationActionMap = Map<string, Map<string, RecommendationAction>>;

const RECOMMENDATION_ACTION_STATUS: Record<string, RecommendationActionStatus> = {
  'security.recommendation.complete': 'completed',
  'security.recommendation.dismiss': 'dismissed',
  'security.recommendation.reopen': 'reopened'
};

/**
 * Newest complete/dismiss/reopen audit row per (recommendation, org). Keyed by
 * org so one client's action never matches another's in the all-organizations
 * view (#9641).
 */
export async function getRecommendationStatusMap(auth: AuthContext, orgId?: string): Promise<RecommendationActionMap> {
  const conditions = [
    eq(auditLogs.resourceType, 'security_recommendation'),
    inArray(auditLogs.action, Object.keys(RECOMMENDATION_ACTION_STATUS))
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
      orgId: auditLogs.orgId,
      resourceName: auditLogs.resourceName,
      details: auditLogs.details,
      timestamp: auditLogs.timestamp
    })
    .from(auditLogs)
    .where(and(...conditions))
    .orderBy(desc(auditLogs.timestamp));

  const actionMap: RecommendationActionMap = new Map();
  for (const row of rows) {
    let recommendationId = row.resourceName ?? '';
    if (!recommendationId && row.details && typeof row.details === 'object') {
      const details = row.details as Record<string, unknown>;
      if (typeof details.recommendationId === 'string') {
        recommendationId = details.recommendationId;
      }
    }
    const status = RECOMMENDATION_ACTION_STATUS[row.action];
    if (!recommendationId || !row.orgId || !status) continue;

    let byOrg = actionMap.get(recommendationId);
    if (!byOrg) {
      byOrg = new Map();
      actionMap.set(recommendationId, byOrg);
    }
    if (!byOrg.has(row.orgId)) {
      byOrg.set(row.orgId, { status, at: new Date(row.timestamp) });
    }
  }

  return actionMap;
}

/**
 * Effective status of one recommendation over the orgs where its problem is
 * currently present. Per org: a completion is void once the problem has been
 * observed after it (a newer snapshot/threat on an affected device); a dismissal
 * is permanent until an explicit reopen. Across orgs the recommendation is open
 * if ANY affected org is open (#9641).
 */
export function resolveRecommendationStatus(
  recommendationId: string,
  affectedByOrg: AffectedOrgBreakdown | undefined,
  actions: RecommendationActionMap | undefined
): 'open' | 'completed' | 'dismissed' {
  if (!affectedByOrg || affectedByOrg.size === 0) return 'open';
  const byOrg = actions?.get(recommendationId);
  let sawCompleted = false;
  for (const [orgId, affected] of affectedByOrg) {
    const action = byOrg?.get(orgId);
    if (!action || action.status === 'reopened') return 'open';
    if (action.status === 'completed') {
      if (affected.latestObservedMs > action.at.getTime()) return 'open';
      sawCompleted = true;
    }
  }
  return sawCompleted ? 'completed' : 'dismissed';
}

/**
 * Per-org view of one recommendation: each org where the problem is present with
 * that org's own effective status (same completion-voids-on-reobservation rule as
 * the aggregate) so the UI can complete/dismiss/reopen for exactly one org (#9714).
 */
export function resolveOrgRecommendationBreakdown(
  recommendationId: string,
  affectedByOrg: AffectedOrgBreakdown | undefined,
  actions: RecommendationActionMap | undefined
): Array<{ orgId: string; status: 'open' | 'completed' | 'dismissed'; affectedDevices: number }> {
  if (!affectedByOrg) return [];
  const byOrg = actions?.get(recommendationId);
  const rows: Array<{ orgId: string; status: 'open' | 'completed' | 'dismissed'; affectedDevices: number }> = [];
  for (const [orgId, affected] of affectedByOrg) {
    const action = byOrg?.get(orgId);
    let status: 'open' | 'completed' | 'dismissed' = 'open';
    if (action?.status === 'dismissed') status = 'dismissed';
    else if (action?.status === 'completed' && affected.latestObservedMs <= action.at.getTime()) status = 'completed';
    rows.push({ orgId, status, affectedDevices: affected.affectedDevices });
  }
  return rows;
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

export type EncryptionVolume = {
  drive: string;
  encrypted: boolean;
  method: string;
  status: string | null;
  percentEncrypted: number | null;
};

// BitLocker enum values by integer. Agents before #9608 forwarded Windows
// PowerShell 5.1's ConvertTo-Json output verbatim, which serialises enums as
// numbers, so stored encryption_details can hold "6" / "1" instead of names.
// Numbering and names match the BitLocker PowerShell module enums and the
// agent's own table (agent/internal/security/status.go). Methods are lowercased to match what
// the agent stores.
const BITLOCKER_METHOD_NAMES: Record<number, string> = {
  0: 'none',
  1: 'aes128diffuser',
  2: 'aes256diffuser',
  3: 'aes128',
  4: 'aes256',
  5: 'hardware',
  6: 'xtsaes128',
  7: 'xtsaes256'
};

const BITLOCKER_VOLUME_STATUS_NAMES: Record<number, string> = {
  0: 'FullyDecrypted',
  1: 'FullyEncrypted',
  2: 'EncryptionInProgress',
  3: 'DecryptionInProgress',
  4: 'EncryptionSuspended',
  5: 'DecryptionSuspended',
  6: 'FullyEncryptedWipeInProgress',
  7: 'FullyEncryptedWipeSuspended'
};

// A name passes through; an integer (or integer string) maps to its name, or
// to `unknownName` when outside the table so a bare number never reaches the UI.
function bitLockerEnumName(value: string | null, names: Record<number, string>, unknownName: string): string | null {
  if (value === null || !/^-?\d+$/.test(value)) return value;
  return names[Number(value)] ?? unknownName;
}

// Agent-reported per-volume encryption detail (security_status.encryption_details,
// shape {source, volumes:[{mount, method, protected, status, percentEncrypted}]}).
// Returns null when absent/malformed so callers can fall back to a synthesized row.
export function parseEncryptionVolumes(details: unknown): EncryptionVolume[] | null {
  const obj = toObject(details);
  if (!obj || !Array.isArray(obj.volumes)) return null;
  const isBitLocker = toStringValue(obj.source)?.toLowerCase() === 'bitlocker';
  const volumes: EncryptionVolume[] = [];
  for (const raw of obj.volumes) {
    const vol = toObject(raw);
    if (!vol) continue;
    let method = toStringValue(vol.method);
    let status = toStringValue(vol.status);
    if (isBitLocker) {
      method = bitLockerEnumName(method, BITLOCKER_METHOD_NAMES, 'unknown');
      status = bitLockerEnumName(status, BITLOCKER_VOLUME_STATUS_NAMES, 'Unknown');
    }
    volumes.push({
      drive: toStringValue(vol.mount) ?? '-',
      encrypted: toBoolean(vol.protected) ?? false,
      method: method ?? 'unknown',
      status,
      percentEncrypted: toNumber(vol.percentEncrypted)
    });
  }
  return volumes.length > 0 ? volumes : null;
}

// Device-level encryption method from what the agent reported (#9607) — never
// guessed from the OS. 'none' when the device reports unencrypted; 'unknown'
// when it reports encryption but no recognisable encryption_details source.
// Linux (lsblk) reports carry the method per volume (luks, zfs), so the first
// protected volume's method is used.
export function deriveEncryptionMethod(details: unknown, encryptionStatus: string): string {
  if (encryptionStatus === 'unencrypted') return 'none';
  const obj = toObject(details);
  if (!obj) return 'unknown';
  const source = toStringValue(obj.source)?.toLowerCase();
  if (source === 'bitlocker' || source === 'filevault') return source;
  if (source === 'lsblk' && Array.isArray(obj.volumes)) {
    for (const raw of obj.volumes) {
      const vol = toObject(raw);
      if (!vol || toBoolean(vol.protected) !== true) continue;
      const method = toStringValue(vol.method)?.toLowerCase();
      if (method && method !== 'none') return method;
    }
  }
  return 'unknown';
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

/**
 * One threat as the caller may see it (#6263 W04-5: shared by the threat
 * actions and the details view). BOTH checks, in this order: the org
 * condition (404 — not visible), then the site-scope gate (403) — RLS does
 * not defend the site axis, it is intra-org. Mirrors the GET
 * /threats/:deviceId read path.
 */
export async function loadThreatForCaller(c: any, id: string): Promise<
  | { threat: ThreatRowWithDetails }
  | { status: 404; error: 'Threat not found' }
  | { status: 403; error: 'Access to this site denied' }
> {
  const auth = c.get('auth') as AuthContext;
  let userPerms = c.get('permissions') as UserPermissions | undefined;
  if (!userPerms) {
    const fetched = await getUserPermissions(auth.user.id, {
      partnerId: auth.partnerId || undefined,
      orgId: auth.orgId || undefined,
    });
    userPerms = fetched || undefined;
  }

  const orgCondition = auth.orgCondition(devices.orgId);
  const conditions = [eq(securityThreats.id, id)];
  if (orgCondition) conditions.push(orgCondition);

  const [threat] = await db
    .select({
      id: securityThreats.id,
      deviceId: securityThreats.deviceId,
      deviceSiteId: devices.siteId,
      orgId: devices.orgId,
      deviceName: devices.hostname,
      provider: securityThreats.provider,
      threatName: securityThreats.threatName,
      threatType: securityThreats.threatType,
      severity: securityThreats.severity,
      filePath: securityThreats.filePath,
      status: securityThreats.status,
      detectedAt: securityThreats.detectedAt,
      resolvedAt: securityThreats.resolvedAt,
      details: securityThreats.details
    })
    .from(securityThreats)
    .innerJoin(devices, eq(devices.id, securityThreats.deviceId))
    .where(and(...conditions))
    .limit(1);

  if (!threat) {
    return { status: 404, error: 'Threat not found' };
  }

  // Site-scope gate: reject site-restricted callers on a threat whose device
  // is outside their site allowlist.
  if (
    userPerms?.allowedSiteIds &&
    (typeof threat.deviceSiteId !== 'string' || !canAccessSite(userPerms, threat.deviceSiteId))
  ) {
    return { status: 403, error: 'Access to this site denied' };
  }
  return { threat };
}

export type ThreatRowWithDetails = {
  id: string;
  deviceId: string;
  deviceSiteId: string | null;
  orgId: string;
  deviceName: string;
  provider: string;
  threatName: string;
  threatType: string | null;
  severity: ThreatRow['severity'];
  filePath: string | null;
  status: string;
  detectedAt: Date;
  resolvedAt: Date | null;
  details: unknown;
};

/** The listing's row shape for one loaded threat (same mapping as listThreatRows). */
export function toThreatRow(t: ThreatRowWithDetails): ThreatRow {
  return {
    id: t.id,
    deviceId: t.deviceId,
    orgId: t.orgId,
    deviceName: t.deviceName,
    provider: normalizeProvider(t.provider),
    threatName: t.threatName,
    threatType: t.threatType ?? 'malware',
    severity: t.severity,
    status: mapThreatStatus(t.status),
    filePath: t.filePath ?? '',
    detectedAt: t.detectedAt,
    resolvedAt: t.resolvedAt
  };
}

/** Exactly the object `GET /threats` (and `/threats/:deviceId`) emits per item. */
export function toThreatListItem(threat: ThreatRow) {
  return {
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
  };
}

export async function queueThreatAction(c: any, action: 'quarantine' | 'remove' | 'restore') {
  const auth = c.get('auth') as AuthContext;
  const { id } = c.req.valid('param') as { id: string };

  const loaded = await loadThreatForCaller(c, id);
  if (!('threat' in loaded)) {
    return c.json({ error: loaded.error }, loaded.status);
  }
  const { threat } = loaded;

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

  // #6685 -- this only QUEUES the command; nothing has executed on the device
  // yet, and an offline device may never claim it. Writing a terminal status
  // (quarantined/removed/allowed) here optimistically lied about the outcome
  // and raced the real update. `updateThreatStatusForAction`
  // (routes/agents/helpers.ts, invoked from handleSecurityCommandResult) is
  // the single source of truth for the terminal status -- it runs once the
  // agent actually reports back, mirroring the sensitiveData /remediate
  // pattern (which only records `remediationAction`/`remediationMetadata` at
  // enqueue time and leaves `status` for the agent-result handler).
  return c.json({
    data: {
      id: threat.id,
      deviceId: threat.deviceId,
      providerId: normalizeProvider(threat.provider),
      name: threat.threatName,
      category: threat.threatType?.toLowerCase() ?? 'malware',
      severity: threat.severity,
      status: mapThreatStatus(threat.status)
    }
  });
}

// ── Recommendations engine ──────────────────────────────────────────────────

export async function buildBe9Recommendations(
  auth: AuthContext,
  orgId?: string
): Promise<{ recommendations: Be9Recommendation[]; affectedByOrg?: Map<string, AffectedOrgBreakdown>; error?: { status: 400 | 403; message: string } }> {
  const scope = resolveScopedOrgIds(auth, orgId);
  if (scope.error) {
    return { recommendations: [], error: scope.error };
  }

  const [posture, threats] = await Promise.all([
    listLatestSecurityPosture({
      orgIds: scope.orgIds,
      siteIds: siteAllowlistOf(auth),
      limit: 2000
    }),
    listThreatRows(auth, undefined, orgId)
  ]);

  const totalDevices = posture.length;
  if (totalDevices === 0) {
    return { recommendations: [] };
  }

  const affectedCounts = {
    antivirus: 0,
    firewall: 0,
    encryption: 0,
    password_policy: 0,
    admin_accounts: 0,
    patch_compliance: 0,
    vulnerability_management: 0
  };

  // Per category, per org: affected device count + the newest time the problem
  // was observed (posture snapshot / active threat). Drives per-org status and
  // completion auto-reopen (#9641).
  const breakdowns = new Map<keyof typeof affectedCounts, AffectedOrgBreakdown>();
  const noteAffected = (category: keyof typeof affectedCounts, org: string, observedAt: string | Date | null | undefined) => {
    let byOrg = breakdowns.get(category);
    if (!byOrg) {
      byOrg = new Map();
      breakdowns.set(category, byOrg);
    }
    const entry = byOrg.get(org) ?? { affectedDevices: 0, latestObservedMs: 0 };
    entry.affectedDevices++;
    const ms = observedAt ? new Date(observedAt).getTime() : 0;
    if (Number.isFinite(ms) && ms > entry.latestObservedMs) entry.latestObservedMs = ms;
    byOrg.set(org, entry);
  };

  const vulnerabilityDevices = new Map<string, { orgId: string; observedAt: string | Date | null | undefined }>();
  for (const threat of threats) {
    if (threat.status !== 'active') continue;
    vulnerabilityDevices.set(threat.deviceId, { orgId: threat.orgId, observedAt: threat.detectedAt });
  }
  for (const item of posture) {
    if (item.factors.av_health.score < 80) { affectedCounts.antivirus++; noteAffected('antivirus', item.orgId, item.capturedAt); }
    if (item.factors.firewall.score < 90) { affectedCounts.firewall++; noteAffected('firewall', item.orgId, item.capturedAt); }
    if (item.factors.encryption.score < 90) { affectedCounts.encryption++; noteAffected('encryption', item.orgId, item.capturedAt); }
    if (item.factors.password_policy.score < 85) { affectedCounts.password_policy++; noteAffected('password_policy', item.orgId, item.capturedAt); }
    if (item.factors.admin_exposure.score < 85) { affectedCounts.admin_accounts++; noteAffected('admin_accounts', item.orgId, item.capturedAt); }
    if (item.factors.patch_compliance.score < 90) { affectedCounts.patch_compliance++; noteAffected('patch_compliance', item.orgId, item.capturedAt); }

    if (item.factors.open_ports.score < 70 || item.factors.os_currency.score < 70) {
      const existing = vulnerabilityDevices.get(item.deviceId);
      const existingMs = existing?.observedAt ? new Date(existing.observedAt).getTime() : 0;
      if (!existing || new Date(item.capturedAt).getTime() > existingMs) {
        vulnerabilityDevices.set(item.deviceId, { orgId: item.orgId, observedAt: item.capturedAt });
      }
    }
  }
  for (const device of vulnerabilityDevices.values()) {
    noteAffected('vulnerability_management', device.orgId, device.observedAt);
  }
  affectedCounts.vulnerability_management = vulnerabilityDevices.size;

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

  const affectedByOrg = new Map<string, AffectedOrgBreakdown>();
  for (const rec of recommendations) {
    const breakdown = breakdowns.get(rec.category as keyof typeof affectedCounts);
    if (breakdown) affectedByOrg.set(rec.id, breakdown);
  }

  return { recommendations, affectedByOrg };
}
