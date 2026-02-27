import {
  and,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  lte,
  or,
  sql,
  type SQL
} from 'drizzle-orm';

import { db } from '../db';
import {
  auditLogs,
  deviceSessions,
  devices,
  organizationUsers,
  securityPostureSnapshots,
  securityThreats,
  sessions,
  softwareComplianceStatus,
  userRiskEvents,
  userRiskPolicies,
  userRiskScores,
  users,
  type UserRiskFactorBreakdown,
  type UserRiskPolicyInterventions,
  type UserRiskPolicyThresholds,
  type UserRiskPolicyWeights
} from '../db/schema';
import { publishEvent } from './eventBus';

const DAY_MS = 24 * 60 * 60 * 1000;
const HIGH_EVENT_TYPE = 'user.risk_score_high';
const SPIKE_EVENT_TYPE = 'user.risk_score_spike';
const TRAINING_ASSIGNED_EVENT_TYPE = 'user.training_assigned';

const DEFAULT_USER_RISK_WEIGHTS: UserRiskPolicyWeights = {
  mfaRisk: 0.14,
  authFailureRisk: 0.2,
  sessionAnomalyRisk: 0.1,
  threatExposureRisk: 0.2,
  softwareViolationRisk: 0.15,
  deviceSecurityRisk: 0.1,
  staleAccessRisk: 0.06,
  recentImpactRisk: 0.05
};

const DEFAULT_USER_RISK_THRESHOLDS: UserRiskPolicyThresholds = {
  medium: 50,
  high: 70,
  critical: 85,
  spikeDelta: 15,
  autoAssignTrainingAtOrAbove: 80
};

const DEFAULT_USER_RISK_INTERVENTIONS: UserRiskPolicyInterventions = {
  autoAssignTraining: false,
  trainingModuleId: 'security-awareness-baseline',
  notifyOnHighRisk: true,
  notifyOnRiskSpike: true
};

const USER_RISK_FACTOR_KEYS = Object.keys(DEFAULT_USER_RISK_WEIGHTS);
const TRAINING_REASSIGN_COOLDOWN_DAYS = 30;
const TRAINING_DEDUP_HOURS = Math.max(1, parseInt(process.env.USER_RISK_TRAINING_DEDUP_HOURS || '24', 10));

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function readFiniteNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return fallback;
}

function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

function normalizeFactorMap(value: unknown): UserRiskFactorBreakdown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const out: UserRiskFactorBreakdown = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    out[key] = clampScore(raw);
  }
  return out;
}

export function normalizeUserRiskWeights(value: unknown): UserRiskPolicyWeights {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_USER_RISK_WEIGHTS };
  }

  const raw = value as Record<string, unknown>;
  const merged: UserRiskPolicyWeights = { ...DEFAULT_USER_RISK_WEIGHTS };
  for (const key of USER_RISK_FACTOR_KEYS) {
    const input = raw[key];
    if (typeof input === 'number' && Number.isFinite(input) && input >= 0) {
      merged[key] = input;
    }
  }

  const total = Object.values(merged).reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) {
    return { ...DEFAULT_USER_RISK_WEIGHTS };
  }

  for (const key of USER_RISK_FACTOR_KEYS) {
    merged[key] = round2((merged[key] ?? 0) / total);
  }
  return merged;
}

export function normalizeUserRiskThresholds(value: unknown): UserRiskPolicyThresholds {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

  const medium = clampScore(readFiniteNumber(raw.medium, DEFAULT_USER_RISK_THRESHOLDS.medium ?? 50));
  const high = Math.max(medium, clampScore(readFiniteNumber(raw.high, DEFAULT_USER_RISK_THRESHOLDS.high ?? 70)));
  const critical = Math.max(high, clampScore(readFiniteNumber(raw.critical, DEFAULT_USER_RISK_THRESHOLDS.critical ?? 85)));
  const spikeDelta = Math.max(
    1,
    Math.min(100, Math.round(readFiniteNumber(raw.spikeDelta, DEFAULT_USER_RISK_THRESHOLDS.spikeDelta ?? 15)))
  );
  const autoAssignTrainingAtOrAbove = Math.max(
    high,
    clampScore(readFiniteNumber(raw.autoAssignTrainingAtOrAbove, DEFAULT_USER_RISK_THRESHOLDS.autoAssignTrainingAtOrAbove ?? 80))
  );

  return {
    medium,
    high,
    critical,
    spikeDelta,
    autoAssignTrainingAtOrAbove
  };
}

export function normalizeUserRiskInterventions(value: unknown): UserRiskPolicyInterventions {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

  const moduleIdRaw = typeof raw.trainingModuleId === 'string' ? raw.trainingModuleId.trim() : '';
  return {
    autoAssignTraining: raw.autoAssignTraining === true,
    trainingModuleId: moduleIdRaw || DEFAULT_USER_RISK_INTERVENTIONS.trainingModuleId,
    notifyOnHighRisk: raw.notifyOnHighRisk !== false,
    notifyOnRiskSpike: raw.notifyOnRiskSpike !== false
  };
}

function aliasesForUser(user: { email: string; name: string }): Set<string> {
  const aliases = new Set<string>();

  const email = user.email.trim().toLowerCase();
  aliases.add(email);
  const localPart = email.split('@')[0] ?? '';
  if (localPart) {
    aliases.add(localPart);
  }

  const normalizedName = user.name.trim().toLowerCase();
  if (normalizedName) {
    aliases.add(normalizedName);
    aliases.add(normalizedName.replace(/\s+/g, '.'));
    aliases.add(normalizedName.replace(/\s+/g, '_'));
  }

  return aliases;
}

function normalizeIdentityValue(value: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!value) return out;

  const base = value.trim().toLowerCase();
  if (!base) return out;
  out.add(base);

  const slashIdx = Math.max(base.lastIndexOf('\\'), base.lastIndexOf('/'));
  if (slashIdx >= 0 && slashIdx < base.length - 1) {
    out.add(base.slice(slashIdx + 1));
  }

  if (base.includes('@')) {
    const localPart = base.split('@')[0];
    if (localPart) {
      out.add(localPart);
    }
  }

  return out;
}

function daysSince(now: Date, value: Date | null | undefined): number {
  if (!value) return 365;
  return Math.max(0, Math.floor((now.getTime() - value.getTime()) / DAY_MS));
}

function scoreFromStaleAccess(days: number): number {
  if (days <= 7) return 10;
  if (days <= 30) return 30;
  if (days <= 90) return 60;
  return 85;
}

export function deriveUserRiskTrendDirection(previousScore: number | null, currentScore: number): 'up' | 'down' | 'stable' {
  if (previousScore === null) return 'stable';
  const delta = currentScore - previousScore;
  if (delta >= 3) return 'up';
  if (delta <= -3) return 'down';
  return 'stable';
}

export function classifyUserRiskSeverity(
  score: number,
  thresholds: UserRiskPolicyThresholds
): 'low' | 'medium' | 'high' | 'critical' {
  const critical = thresholds.critical ?? DEFAULT_USER_RISK_THRESHOLDS.critical ?? 85;
  const high = thresholds.high ?? DEFAULT_USER_RISK_THRESHOLDS.high ?? 70;
  const medium = thresholds.medium ?? DEFAULT_USER_RISK_THRESHOLDS.medium ?? 50;

  if (score >= critical) return 'critical';
  if (score >= high) return 'high';
  if (score >= medium) return 'medium';
  return 'low';
}

export function computeUserRiskScoreFromFactors(
  factors: UserRiskFactorBreakdown,
  weights: UserRiskPolicyWeights
): number {
  const normalized = normalizeUserRiskWeights(weights);
  const weighted = USER_RISK_FACTOR_KEYS.reduce((sum, key) => {
    const factorScore = clampScore(factors[key] ?? 0);
    return sum + factorScore * (normalized[key] ?? 0);
  }, 0);
  return clampScore(weighted);
}

export type UserRiskPolicy = {
  orgId: string;
  weights: UserRiskPolicyWeights;
  thresholds: UserRiskPolicyThresholds;
  interventions: UserRiskPolicyInterventions;
  updatedAt: string;
  updatedBy: string | null;
};

export type UserRiskScoreListFilter = {
  orgIds?: string[];
  orgId?: string;
  siteId?: string;
  minScore?: number;
  maxScore?: number;
  trendDirection?: 'up' | 'down' | 'stable';
  search?: string;
  limit?: number;
  offset?: number;
};

export type UserRiskEventFilter = {
  orgIds?: string[];
  orgId?: string;
  userId?: string;
  eventType?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
};

type ComputedUserRisk = {
  orgId: string;
  userId: string;
  score: number;
  factors: UserRiskFactorBreakdown;
  previousScore: number | null;
  delta: number;
  trendDirection: 'up' | 'down' | 'stable';
};

export type UserRiskRecomputeResult = {
  orgId: string;
  calculatedAt: string;
  usersProcessed: number;
  changedUsers: Array<{
    userId: string;
    score: number;
    previousScore: number | null;
    delta: number;
    trendDirection: 'up' | 'down' | 'stable';
    crossedHighThreshold: boolean;
    spiked: boolean;
  }>;
  autoTrainingAssigned: number;
  policy: UserRiskPolicy;
};

export async function getOrCreateUserRiskPolicy(orgId: string): Promise<UserRiskPolicy> {
  const [existing] = await db
    .select()
    .from(userRiskPolicies)
    .where(eq(userRiskPolicies.orgId, orgId))
    .limit(1);

  if (existing) {
    return {
      orgId: existing.orgId,
      weights: normalizeUserRiskWeights(existing.weights),
      thresholds: normalizeUserRiskThresholds(existing.thresholds),
      interventions: normalizeUserRiskInterventions(existing.interventions),
      updatedAt: existing.updatedAt.toISOString(),
      updatedBy: existing.updatedBy ?? null
    };
  }

  await db
    .insert(userRiskPolicies)
    .values({
      orgId,
      weights: DEFAULT_USER_RISK_WEIGHTS,
      thresholds: DEFAULT_USER_RISK_THRESHOLDS,
      interventions: DEFAULT_USER_RISK_INTERVENTIONS
    })
    .onConflictDoNothing({ target: userRiskPolicies.orgId });

  const [created] = await db
    .select()
    .from(userRiskPolicies)
    .where(eq(userRiskPolicies.orgId, orgId))
    .limit(1);

  if (!created) {
    throw new Error(`Failed to initialize user risk policy for org ${orgId}`);
  }

  return {
    orgId: created.orgId,
    weights: normalizeUserRiskWeights(created.weights),
    thresholds: normalizeUserRiskThresholds(created.thresholds),
    interventions: normalizeUserRiskInterventions(created.interventions),
    updatedAt: created.updatedAt.toISOString(),
    updatedBy: created.updatedBy ?? null
  };
}

export async function updateUserRiskPolicy(input: {
  orgId: string;
  updatedBy: string;
  weights?: unknown;
  thresholds?: unknown;
  interventions?: unknown;
}): Promise<UserRiskPolicy> {
  const current = await getOrCreateUserRiskPolicy(input.orgId);

  const nextWeights = input.weights !== undefined
    ? normalizeUserRiskWeights({ ...current.weights, ...(input.weights as Record<string, unknown>) })
    : current.weights;
  const nextThresholds = input.thresholds !== undefined
    ? normalizeUserRiskThresholds({ ...current.thresholds, ...(input.thresholds as Record<string, unknown>) })
    : current.thresholds;
  const nextInterventions = input.interventions !== undefined
    ? normalizeUserRiskInterventions({ ...current.interventions, ...(input.interventions as Record<string, unknown>) })
    : current.interventions;

  const [updated] = await db
    .update(userRiskPolicies)
    .set({
      weights: nextWeights,
      thresholds: nextThresholds,
      interventions: nextInterventions,
      updatedBy: input.updatedBy,
      updatedAt: new Date()
    })
    .where(eq(userRiskPolicies.orgId, input.orgId))
    .returning();

  if (!updated) {
    throw new Error(`Failed to update user risk policy for org ${input.orgId}`);
  }

  return {
    orgId: updated.orgId,
    weights: normalizeUserRiskWeights(updated.weights),
    thresholds: normalizeUserRiskThresholds(updated.thresholds),
    interventions: normalizeUserRiskInterventions(updated.interventions),
    updatedAt: updated.updatedAt.toISOString(),
    updatedBy: updated.updatedBy ?? null
  };
}

async function fetchPreviousScores(orgId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({
      userId: userRiskScores.userId,
      score: userRiskScores.score
    })
    .from(userRiskScores)
    .where(eq(userRiskScores.orgId, orgId))
    .orderBy(desc(userRiskScores.calculatedAt));

  const latestByUser = new Map<string, number>();
  for (const row of rows) {
    if (!latestByUser.has(row.userId)) {
      latestByUser.set(row.userId, row.score);
    }
  }
  return latestByUser;
}

async function fetchRecentTrainingAssignments(orgId: string): Promise<Map<string, Date>> {
  const since = new Date(Date.now() - TRAINING_REASSIGN_COOLDOWN_DAYS * DAY_MS);
  const rows = await db
    .select({
      userId: userRiskEvents.userId,
      occurredAt: userRiskEvents.occurredAt
    })
    .from(userRiskEvents)
    .where(
      and(
        eq(userRiskEvents.orgId, orgId),
        eq(userRiskEvents.eventType, 'training_assigned'),
        gte(userRiskEvents.occurredAt, since)
      )
    )
    .orderBy(desc(userRiskEvents.occurredAt));

  const latestByUser = new Map<string, Date>();
  for (const row of rows) {
    if (!latestByUser.has(row.userId)) {
      latestByUser.set(row.userId, row.occurredAt);
    }
  }
  return latestByUser;
}

type UserMembership = {
  userId: string;
  email: string;
  name: string;
  mfaEnabled: boolean;
  lastLoginAt: Date | null;
};

async function fetchOrgUsers(orgId: string, targetUserIds?: string[]): Promise<UserMembership[]> {
  if (Array.isArray(targetUserIds) && targetUserIds.length === 0) {
    return [];
  }

  const conditions: SQL[] = [
    eq(organizationUsers.orgId, orgId),
    eq(users.status, 'active')
  ];
  if (targetUserIds && targetUserIds.length > 0) {
    conditions.push(inArray(users.id, targetUserIds));
  }

  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      mfaEnabled: users.mfaEnabled,
      lastLoginAt: users.lastLoginAt
    })
    .from(organizationUsers)
    .innerJoin(users, eq(organizationUsers.userId, users.id))
    .where(and(...conditions));

  return rows.map((row) => ({
    userId: row.userId,
    email: row.email,
    name: row.name,
    mfaEnabled: row.mfaEnabled,
    lastLoginAt: row.lastLoginAt ?? null
  }));
}

async function computeOrgUserRiskRows(
  orgId: string,
  policy: UserRiskPolicy,
  targetUserIds?: string[]
): Promise<ComputedUserRisk[]> {
  const now = new Date();
  const since30d = new Date(now.getTime() - 30 * DAY_MS);
  const since14d = new Date(now.getTime() - 14 * DAY_MS);

  const memberships = await fetchOrgUsers(orgId, targetUserIds);
  if (memberships.length === 0) {
    return [];
  }

  const userIds = memberships.map((entry) => entry.userId);
  const usersByAlias = new Map<string, Set<string>>();
  for (const user of memberships) {
    const aliases = aliasesForUser({ email: user.email, name: user.name });
    for (const alias of aliases) {
      const bucket = usersByAlias.get(alias) ?? new Set<string>();
      bucket.add(user.userId);
      usersByAlias.set(alias, bucket);
    }
  }

  const [orgDevices, recentSessions, authFailures, activeThreats, policyViolations, recentSnapshots, recentRiskEvents, previousScores] = await Promise.all([
    db
      .select({
        deviceId: devices.id,
        lastUser: devices.lastUser
      })
      .from(devices)
      .where(
        and(
          eq(devices.orgId, orgId),
          isNotNull(devices.lastUser),
          or(eq(devices.status, 'online'), eq(devices.status, 'offline'), eq(devices.status, 'maintenance'), eq(devices.status, 'quarantined'))
        )
      ),
    db
      .select({
        userId: sessions.userId,
        ipAddress: sessions.ipAddress
      })
      .from(sessions)
      .where(
        and(
          inArray(sessions.userId, userIds),
          gte(sessions.createdAt, since30d)
        )
      ),
    db
      .select({
        actorId: auditLogs.actorId,
        result: auditLogs.result
      })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.orgId, orgId),
          inArray(auditLogs.actorId, userIds),
          gte(auditLogs.timestamp, since30d),
          inArray(auditLogs.result, ['failure', 'denied'])
        )
      ),
    db
      .select({
        deviceId: securityThreats.deviceId,
        severity: securityThreats.severity
      })
      .from(securityThreats)
      .innerJoin(devices, eq(securityThreats.deviceId, devices.id))
      .where(
        and(
          eq(devices.orgId, orgId),
          gte(securityThreats.detectedAt, since30d),
          inArray(securityThreats.status, ['detected', 'failed', 'quarantined'])
        )
      ),
    db
      .select({
        deviceId: softwareComplianceStatus.deviceId,
        status: softwareComplianceStatus.status
      })
      .from(softwareComplianceStatus)
      .innerJoin(devices, eq(softwareComplianceStatus.deviceId, devices.id))
      .where(
        and(
          eq(devices.orgId, orgId),
          gte(softwareComplianceStatus.lastChecked, since30d),
          eq(softwareComplianceStatus.status, 'violation')
        )
      ),
    db
      .select({
        deviceId: securityPostureSnapshots.deviceId,
        capturedAt: securityPostureSnapshots.capturedAt,
        overallScore: securityPostureSnapshots.overallScore
      })
      .from(securityPostureSnapshots)
      .where(
        and(
          eq(securityPostureSnapshots.orgId, orgId),
          gte(securityPostureSnapshots.capturedAt, since30d)
        )
      )
      .orderBy(desc(securityPostureSnapshots.capturedAt)),
    db
      .select({
        userId: userRiskEvents.userId,
        scoreImpact: userRiskEvents.scoreImpact
      })
      .from(userRiskEvents)
      .where(
        and(
          eq(userRiskEvents.orgId, orgId),
          inArray(userRiskEvents.userId, userIds),
          gte(userRiskEvents.occurredAt, since14d)
        )
      ),
    fetchPreviousScores(orgId)
  ]);

  const deviceIdsByUser = new Map<string, Set<string>>();
  for (const user of memberships) {
    deviceIdsByUser.set(user.userId, new Set());
  }

  for (const row of orgDevices) {
    const normalized = normalizeIdentityValue(row.lastUser ?? null);
    if (normalized.size === 0) continue;
    const matchedUserIds = new Set<string>();
    for (const candidate of normalized) {
      const matched = usersByAlias.get(candidate);
      if (!matched) continue;
      for (const userId of matched) {
        matchedUserIds.add(userId);
      }
    }
    for (const userId of matchedUserIds) {
      deviceIdsByUser.get(userId)?.add(row.deviceId);
    }
  }

  const sessionsByUser = new Map<string, Array<{ ipAddress: string | null }>>();
  for (const row of recentSessions) {
    const bucket = sessionsByUser.get(row.userId) ?? [];
    bucket.push({ ipAddress: row.ipAddress ?? null });
    sessionsByUser.set(row.userId, bucket);
  }

  const authFailureCountByUser = new Map<string, number>();
  for (const row of authFailures) {
    authFailureCountByUser.set(row.actorId, (authFailureCountByUser.get(row.actorId) ?? 0) + 1);
  }

  const threatByDevice = new Map<string, Array<'low' | 'medium' | 'high' | 'critical'>>();
  for (const row of activeThreats) {
    const bucket = threatByDevice.get(row.deviceId) ?? [];
    bucket.push(row.severity);
    threatByDevice.set(row.deviceId, bucket);
  }

  const violationByDevice = new Set(
    policyViolations
      .filter((row) => row.status === 'violation')
      .map((row) => row.deviceId)
  );

  const latestSnapshotByDevice = new Map<string, number>();
  for (const row of recentSnapshots) {
    if (!latestSnapshotByDevice.has(row.deviceId)) {
      latestSnapshotByDevice.set(row.deviceId, row.overallScore);
    }
  }

  const recentEventImpactByUser = new Map<string, number>();
  for (const row of recentRiskEvents) {
    recentEventImpactByUser.set(row.userId, (recentEventImpactByUser.get(row.userId) ?? 0) + row.scoreImpact);
  }

  const results: ComputedUserRisk[] = [];
  for (const user of memberships) {
    const userDeviceIds = Array.from(deviceIdsByUser.get(user.userId) ?? []);
    const mfaRisk = user.mfaEnabled ? 10 : 90;
    const failedAuthCount = authFailureCountByUser.get(user.userId) ?? 0;
    const authFailureRisk = clampScore(failedAuthCount * 18);

    const sessionRows = sessionsByUser.get(user.userId) ?? [];
    const uniqueIps = new Set(
      sessionRows
        .map((row) => row.ipAddress?.trim())
        .filter((value): value is string => !!value)
    );
    const sessionAnomalyRisk = clampScore(
      Math.max(0, (uniqueIps.size - 2) * 18)
      + Math.max(0, sessionRows.length - 40) * 2
    );

    let lowThreats = 0;
    let mediumThreats = 0;
    let highThreats = 0;
    let criticalThreats = 0;
    for (const deviceId of userDeviceIds) {
      const severities = threatByDevice.get(deviceId) ?? [];
      for (const severity of severities) {
        if (severity === 'critical') criticalThreats++;
        else if (severity === 'high') highThreats++;
        else if (severity === 'medium') mediumThreats++;
        else lowThreats++;
      }
    }
    const threatExposureRisk = clampScore(
      criticalThreats * 35
      + highThreats * 22
      + mediumThreats * 12
      + lowThreats * 5
    );

    const violationCount = userDeviceIds.filter((id) => violationByDevice.has(id)).length;
    const violationRatio = userDeviceIds.length > 0 ? (violationCount / userDeviceIds.length) : 0;
    const softwareViolationRisk = clampScore((violationCount * 18) + (violationRatio * 50));

    const associatedSnapshotScores = userDeviceIds
      .map((deviceId) => latestSnapshotByDevice.get(deviceId))
      .filter((value): value is number => typeof value === 'number');
    const avgDeviceScore = associatedSnapshotScores.length > 0
      ? associatedSnapshotScores.reduce((sum, score) => sum + score, 0) / associatedSnapshotScores.length
      : 80;
    const deviceSecurityRisk = clampScore(100 - avgDeviceScore);

    const staleAccessRisk = scoreFromStaleAccess(daysSince(now, user.lastLoginAt));
    const recentImpactRisk = clampScore((recentEventImpactByUser.get(user.userId) ?? 0) * 4);

    const factors: UserRiskFactorBreakdown = {
      mfaRisk,
      authFailureRisk,
      sessionAnomalyRisk,
      threatExposureRisk,
      softwareViolationRisk,
      deviceSecurityRisk,
      staleAccessRisk,
      recentImpactRisk
    };

    const score = computeUserRiskScoreFromFactors(factors, policy.weights);
    const previousScore = previousScores.get(user.userId) ?? null;
    const delta = previousScore === null ? 0 : score - previousScore;
    const trendDirection = deriveUserRiskTrendDirection(previousScore, score);

    results.push({
      orgId,
      userId: user.userId,
      score,
      factors,
      previousScore,
      delta,
      trendDirection
    });
  }

  return results;
}

async function autoAssignTrainingIfNeeded(input: {
  computedRows: ComputedUserRisk[];
  policy: UserRiskPolicy;
  orgId: string;
  actorSource: string;
}): Promise<number> {
  if (!input.policy.interventions.autoAssignTraining) {
    return 0;
  }

  const threshold = input.policy.thresholds.autoAssignTrainingAtOrAbove
    ?? input.policy.thresholds.high
    ?? DEFAULT_USER_RISK_THRESHOLDS.high
    ?? 70;

  const recentAssignments = await fetchRecentTrainingAssignments(input.orgId);
  let assigned = 0;

  for (const row of input.computedRows) {
    if (row.score < threshold) continue;
    if (recentAssignments.has(row.userId)) continue;

    const moduleId = input.policy.interventions.trainingModuleId
      ?? DEFAULT_USER_RISK_INTERVENTIONS.trainingModuleId
      ?? 'security-awareness-baseline';

    const assignment = await recordTrainingAssignment({
      orgId: input.orgId,
      userId: row.userId,
      moduleId,
      assignedBy: null,
      source: input.actorSource,
      reason: `Auto-assigned for user risk score ${row.score}`
    });

    if (!assignment.deduplicated) {
      assigned += 1;
    }
  }

  return assigned;
}

function buildChangedUsers(
  computedRows: ComputedUserRisk[],
  thresholds: UserRiskPolicyThresholds
): UserRiskRecomputeResult['changedUsers'] {
  const highThreshold = thresholds.high ?? DEFAULT_USER_RISK_THRESHOLDS.high ?? 70;
  const spikeDelta = thresholds.spikeDelta ?? DEFAULT_USER_RISK_THRESHOLDS.spikeDelta ?? 15;

  return computedRows
    .map((row) => ({
      userId: row.userId,
      score: row.score,
      previousScore: row.previousScore,
      delta: row.delta,
      trendDirection: row.trendDirection,
      crossedHighThreshold: row.score >= highThreshold && (row.previousScore ?? 0) < highThreshold,
      spiked: row.delta >= spikeDelta
    }))
    .filter((row) => row.crossedHighThreshold || row.spiked || Math.abs(row.delta) >= 5);
}

async function persistUserRiskSnapshots(computedRows: ComputedUserRisk[], calculatedAt: Date): Promise<void> {
  if (computedRows.length === 0) return;
  await db.insert(userRiskScores).values(
    computedRows.map((row) => ({
      orgId: row.orgId,
      userId: row.userId,
      score: row.score,
      factors: row.factors,
      trendDirection: row.trendDirection,
      calculatedAt
    }))
  );
}

export async function computeAndPersistOrgUserRisk(orgId: string): Promise<UserRiskRecomputeResult> {
  const policy = await getOrCreateUserRiskPolicy(orgId);
  const calculatedAt = new Date();
  const computedRows = await computeOrgUserRiskRows(orgId, policy);
  await persistUserRiskSnapshots(computedRows, calculatedAt);

  const changedUsers = buildChangedUsers(computedRows, policy.thresholds);

  const autoTrainingAssigned = await autoAssignTrainingIfNeeded({
    computedRows,
    policy,
    orgId,
    actorSource: 'user-risk-intervention-evaluator'
  });

  return {
    orgId,
    calculatedAt: calculatedAt.toISOString(),
    usersProcessed: computedRows.length,
    changedUsers,
    autoTrainingAssigned,
    policy
  };
}

export async function computeAndPersistUserRiskForUser(orgId: string, userId: string): Promise<UserRiskRecomputeResult> {
  const policy = await getOrCreateUserRiskPolicy(orgId);
  const calculatedAt = new Date();
  const computedRows = await computeOrgUserRiskRows(orgId, policy, [userId]);
  await persistUserRiskSnapshots(computedRows, calculatedAt);

  const changedUsers = buildChangedUsers(computedRows, policy.thresholds);
  const autoTrainingAssigned = await autoAssignTrainingIfNeeded({
    computedRows,
    policy,
    orgId,
    actorSource: 'user-risk-intervention-evaluator'
  });

  return {
    orgId,
    calculatedAt: calculatedAt.toISOString(),
    usersProcessed: computedRows.length,
    changedUsers,
    autoTrainingAssigned,
    policy
  };
}

export async function listUserRiskScores(filter: UserRiskScoreListFilter): Promise<{
  total: number;
  rows: Array<{
    orgId: string;
    userId: string;
    userName: string;
    userEmail: string;
    score: number;
    trendDirection: 'up' | 'down' | 'stable' | null;
    calculatedAt: string;
    factors: UserRiskFactorBreakdown;
  }>;
}> {
  const scopeConditions: SQL[] = [];
  if (filter.orgId) {
    scopeConditions.push(eq(userRiskScores.orgId, filter.orgId));
  } else if (filter.orgIds && filter.orgIds.length > 0) {
    scopeConditions.push(inArray(userRiskScores.orgId, filter.orgIds));
  }

  const latestByUser = db
    .select({
      orgId: userRiskScores.orgId,
      userId: userRiskScores.userId,
      calculatedAt: sql<Date>`max(${userRiskScores.calculatedAt})`.as('calculated_at')
    })
    .from(userRiskScores)
    .where(scopeConditions.length > 0 ? and(...scopeConditions) : undefined)
    .groupBy(userRiskScores.orgId, userRiskScores.userId)
    .as('latest_user_risk_scores');

  const conditions: SQL[] = [
    eq(userRiskScores.orgId, latestByUser.orgId),
    eq(userRiskScores.userId, latestByUser.userId),
    eq(userRiskScores.calculatedAt, latestByUser.calculatedAt)
  ];
  if (filter.minScore !== undefined) conditions.push(gte(userRiskScores.score, clampScore(filter.minScore)));
  if (filter.maxScore !== undefined) conditions.push(lte(userRiskScores.score, clampScore(filter.maxScore)));
  if (filter.trendDirection) conditions.push(eq(userRiskScores.trendDirection, filter.trendDirection));
  if (filter.search) {
    const pattern = `%${filter.search}%`;
    conditions.push(
      or(
        ilike(users.name, pattern),
        ilike(users.email, pattern)
      )!
    );
  }
  if (filter.siteId) {
    conditions.push(sql`${organizationUsers.siteIds} @> ARRAY[${filter.siteId}]::uuid[]`);
  }

  const whereClause = and(...conditions);
  const limit = Math.min(Math.max(1, filter.limit ?? 25), 200);
  const offset = Math.max(0, filter.offset ?? 0);

  const [countRow, rows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(userRiskScores)
      .innerJoin(latestByUser, eq(userRiskScores.orgId, latestByUser.orgId))
      .innerJoin(users, eq(userRiskScores.userId, users.id))
      .innerJoin(
        organizationUsers,
        and(
          eq(organizationUsers.orgId, userRiskScores.orgId),
          eq(organizationUsers.userId, users.id)
        )
      )
      .where(whereClause)
      .then((result) => result[0]?.count ?? 0),
    db
      .select({
        orgId: userRiskScores.orgId,
        userId: userRiskScores.userId,
        userName: users.name,
        userEmail: users.email,
        score: userRiskScores.score,
        trendDirection: userRiskScores.trendDirection,
        calculatedAt: userRiskScores.calculatedAt,
        factors: userRiskScores.factors
      })
      .from(userRiskScores)
      .innerJoin(latestByUser, eq(userRiskScores.orgId, latestByUser.orgId))
      .innerJoin(users, eq(userRiskScores.userId, users.id))
      .innerJoin(
        organizationUsers,
        and(
          eq(organizationUsers.orgId, userRiskScores.orgId),
          eq(organizationUsers.userId, users.id)
        )
      )
      .where(whereClause)
      .orderBy(desc(userRiskScores.score), desc(userRiskScores.calculatedAt))
      .limit(limit)
      .offset(offset)
  ]);

  return {
    total: Number(countRow),
    rows: rows.map((row) => ({
      orgId: row.orgId,
      userId: row.userId,
      userName: row.userName,
      userEmail: row.userEmail,
      score: row.score,
      trendDirection: (row.trendDirection as 'up' | 'down' | 'stable' | null) ?? null,
      calculatedAt: row.calculatedAt.toISOString(),
      factors: normalizeFactorMap(row.factors)
    }))
  };
}

export async function getUserRiskDetail(orgId: string, userId: string): Promise<{
  user: { id: string; name: string; email: string; mfaEnabled: boolean; lastLoginAt: string | null };
  latestScore: {
    score: number;
    factors: UserRiskFactorBreakdown;
    trendDirection: 'up' | 'down' | 'stable' | null;
    calculatedAt: string;
    deltaFromPrevious: number;
    severity: 'low' | 'medium' | 'high' | 'critical';
  };
  recentEvents: Array<{
    id: string;
    eventType: string;
    severity: string | null;
    scoreImpact: number;
    description: string;
    occurredAt: string;
    details: Record<string, unknown> | null;
  }>;
  history: Array<{
    score: number;
    trendDirection: 'up' | 'down' | 'stable' | null;
    calculatedAt: string;
  }>;
  policy: UserRiskPolicy;
} | null> {
  const [membership] = await db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      mfaEnabled: users.mfaEnabled,
      lastLoginAt: users.lastLoginAt
    })
    .from(organizationUsers)
    .innerJoin(users, eq(organizationUsers.userId, users.id))
    .where(
      and(
        eq(organizationUsers.orgId, orgId),
        eq(organizationUsers.userId, userId)
      )
    )
    .limit(1);

  if (!membership) return null;

  const [history, events, policy] = await Promise.all([
    db
      .select({
        score: userRiskScores.score,
        trendDirection: userRiskScores.trendDirection,
        calculatedAt: userRiskScores.calculatedAt,
        factors: userRiskScores.factors
      })
      .from(userRiskScores)
      .where(
        and(
          eq(userRiskScores.orgId, orgId),
          eq(userRiskScores.userId, userId)
        )
      )
      .orderBy(desc(userRiskScores.calculatedAt))
      .limit(30),
    db
      .select({
        id: userRiskEvents.id,
        eventType: userRiskEvents.eventType,
        severity: userRiskEvents.severity,
        scoreImpact: userRiskEvents.scoreImpact,
        description: userRiskEvents.description,
        occurredAt: userRiskEvents.occurredAt,
        details: userRiskEvents.details
      })
      .from(userRiskEvents)
      .where(
        and(
          eq(userRiskEvents.orgId, orgId),
          eq(userRiskEvents.userId, userId)
        )
      )
      .orderBy(desc(userRiskEvents.occurredAt))
      .limit(100),
    getOrCreateUserRiskPolicy(orgId)
  ]);

  if (history.length === 0) return null;

  const latest = history[0];
  const previous = history[1] ?? null;
  const deltaFromPrevious = previous ? latest.score - previous.score : 0;

  return {
    user: {
      id: membership.userId,
      name: membership.name,
      email: membership.email,
      mfaEnabled: membership.mfaEnabled,
      lastLoginAt: membership.lastLoginAt?.toISOString() ?? null
    },
    latestScore: {
      score: latest.score,
      factors: normalizeFactorMap(latest.factors),
      trendDirection: (latest.trendDirection as 'up' | 'down' | 'stable' | null) ?? null,
      calculatedAt: latest.calculatedAt.toISOString(),
      deltaFromPrevious,
      severity: classifyUserRiskSeverity(latest.score, policy.thresholds)
    },
    recentEvents: events.map((event) => ({
      id: event.id,
      eventType: event.eventType,
      severity: event.severity,
      scoreImpact: event.scoreImpact,
      description: event.description,
      occurredAt: event.occurredAt.toISOString(),
      details: (event.details as Record<string, unknown> | null) ?? null
    })),
    history: history.map((row) => ({
      score: row.score,
      trendDirection: (row.trendDirection as 'up' | 'down' | 'stable' | null) ?? null,
      calculatedAt: row.calculatedAt.toISOString()
    })),
    policy
  };
}

export async function listUserRiskEvents(filter: UserRiskEventFilter): Promise<{
  total: number;
  rows: Array<{
    id: string;
    orgId: string;
    userId: string;
    userName: string;
    userEmail: string;
    eventType: string;
    severity: string | null;
    scoreImpact: number;
    description: string;
    details: Record<string, unknown> | null;
    occurredAt: string;
  }>;
}> {
  const conditions: SQL[] = [];
  if (filter.orgId) {
    conditions.push(eq(userRiskEvents.orgId, filter.orgId));
  } else if (filter.orgIds && filter.orgIds.length > 0) {
    conditions.push(inArray(userRiskEvents.orgId, filter.orgIds));
  }
  if (filter.userId) conditions.push(eq(userRiskEvents.userId, filter.userId));
  if (filter.eventType) conditions.push(eq(userRiskEvents.eventType, filter.eventType));
  if (filter.severity) conditions.push(eq(userRiskEvents.severity, filter.severity));
  if (filter.from) conditions.push(gte(userRiskEvents.occurredAt, filter.from));
  if (filter.to) conditions.push(lte(userRiskEvents.occurredAt, filter.to));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const limit = Math.min(Math.max(1, filter.limit ?? 50), 500);
  const offset = Math.max(0, filter.offset ?? 0);

  const [count, rows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(userRiskEvents)
      .where(whereClause)
      .then((result) => result[0]?.count ?? 0),
    db
      .select({
        id: userRiskEvents.id,
        orgId: userRiskEvents.orgId,
        userId: userRiskEvents.userId,
        userName: users.name,
        userEmail: users.email,
        eventType: userRiskEvents.eventType,
        severity: userRiskEvents.severity,
        scoreImpact: userRiskEvents.scoreImpact,
        description: userRiskEvents.description,
        details: userRiskEvents.details,
        occurredAt: userRiskEvents.occurredAt
      })
      .from(userRiskEvents)
      .innerJoin(users, eq(userRiskEvents.userId, users.id))
      .where(whereClause)
      .orderBy(desc(userRiskEvents.occurredAt))
      .limit(limit)
      .offset(offset)
  ]);

  return {
    total: Number(count),
    rows: rows.map((row) => ({
      id: row.id,
      orgId: row.orgId,
      userId: row.userId,
      userName: row.userName,
      userEmail: row.userEmail,
      eventType: row.eventType,
      severity: row.severity,
      scoreImpact: row.scoreImpact,
      description: row.description,
      details: (row.details as Record<string, unknown> | null) ?? null,
      occurredAt: row.occurredAt.toISOString()
    }))
  };
}

type RecordTrainingInput = {
  orgId: string;
  userId: string;
  moduleId: string;
  assignedBy: string | null;
  source: string;
  reason?: string;
};

type RecordTrainingResult = {
  id: string;
  deduplicated: boolean;
  eventPublished: boolean;
};

async function recordTrainingAssignment(input: RecordTrainingInput): Promise<RecordTrainingResult> {
  const dedupCutoff = new Date(Date.now() - TRAINING_DEDUP_HOURS * 60 * 60 * 1000);
  const [existing] = await db
    .select({ id: userRiskEvents.id })
    .from(userRiskEvents)
    .where(
      and(
        eq(userRiskEvents.orgId, input.orgId),
        eq(userRiskEvents.userId, input.userId),
        eq(userRiskEvents.eventType, 'training_assigned'),
        gte(userRiskEvents.occurredAt, dedupCutoff),
        sql`${userRiskEvents.details}->>'moduleId' = ${input.moduleId}`
      )
    )
    .orderBy(desc(userRiskEvents.occurredAt))
    .limit(1);

  if (existing) {
    return {
      id: existing.id,
      deduplicated: true,
      eventPublished: false
    };
  }

  const now = new Date();
  const description = input.reason
    ? `Security training assigned: ${input.reason}`
    : 'Security training assigned';

  const [eventRow] = await db
    .insert(userRiskEvents)
    .values({
      orgId: input.orgId,
      userId: input.userId,
      eventType: 'training_assigned',
      severity: 'low',
      scoreImpact: -5,
      description,
      details: {
        moduleId: input.moduleId,
        source: input.source,
        assignedBy: input.assignedBy
      },
      occurredAt: now
    })
    .returning({ id: userRiskEvents.id });

  let eventPublished = false;
  try {
    await publishEvent(
      TRAINING_ASSIGNED_EVENT_TYPE,
      input.orgId,
      {
        userId: input.userId,
        moduleId: input.moduleId,
        assignedBy: input.assignedBy,
        assignedAt: now.toISOString(),
        source: input.source
      },
      input.source
    );
    eventPublished = true;
  } catch (error) {
    console.error(`[UserRisk] Failed to publish ${TRAINING_ASSIGNED_EVENT_TYPE} for user ${input.userId}:`, error);
  }

  return {
    id: eventRow?.id ?? '',
    deduplicated: false,
    eventPublished
  };
}

export async function assignSecurityTraining(input: {
  orgId: string;
  userId: string;
  moduleId?: string;
  reason?: string;
  assignedBy: string;
}): Promise<{ assignmentEventId: string; moduleId: string; deduplicated: boolean; eventPublished: boolean }> {
  const [membership] = await db
    .select({ userId: organizationUsers.userId })
    .from(organizationUsers)
    .where(
      and(
        eq(organizationUsers.orgId, input.orgId),
        eq(organizationUsers.userId, input.userId)
      )
    )
    .limit(1);

  if (!membership) {
    throw new Error('User is not part of this organization');
  }

  const moduleId = input.moduleId?.trim() || DEFAULT_USER_RISK_INTERVENTIONS.trainingModuleId || 'security-awareness-baseline';
  const assignment = await recordTrainingAssignment({
    orgId: input.orgId,
    userId: input.userId,
    moduleId,
    assignedBy: input.assignedBy,
    source: 'user-risk-api',
    reason: input.reason
  });

  return {
    assignmentEventId: assignment.id,
    moduleId,
    deduplicated: assignment.deduplicated,
    eventPublished: assignment.eventPublished
  };
}

export async function publishUserRiskScoreEvents(input: {
  orgId: string;
  changedUsers: UserRiskRecomputeResult['changedUsers'];
  thresholds: UserRiskPolicyThresholds;
  interventions: UserRiskPolicyInterventions;
}): Promise<{ publishedHigh: number; publishedSpikes: number; failed: number }> {
  let publishedHigh = 0;
  let publishedSpikes = 0;
  let failed = 0;

  for (const user of input.changedUsers) {
    if (user.crossedHighThreshold && input.interventions.notifyOnHighRisk !== false) {
      try {
        await publishEvent(
          HIGH_EVENT_TYPE,
          input.orgId,
          {
            userId: user.userId,
            score: user.score,
            previousScore: user.previousScore,
            delta: user.delta,
            threshold: input.thresholds.high ?? DEFAULT_USER_RISK_THRESHOLDS.high
          },
          'user-risk-jobs'
        );
        publishedHigh++;
      } catch (error) {
        failed++;
        console.error(`[UserRiskJobs] Failed to publish ${HIGH_EVENT_TYPE} for user ${user.userId}:`, error);
      }
    }

    if (user.spiked && input.interventions.notifyOnRiskSpike !== false) {
      try {
        await publishEvent(
          SPIKE_EVENT_TYPE,
          input.orgId,
          {
            userId: user.userId,
            score: user.score,
            previousScore: user.previousScore,
            delta: user.delta,
            threshold: input.thresholds.spikeDelta ?? DEFAULT_USER_RISK_THRESHOLDS.spikeDelta
          },
          'user-risk-jobs'
        );
        publishedSpikes++;
      } catch (error) {
        failed++;
        console.error(`[UserRiskJobs] Failed to publish ${SPIKE_EVENT_TYPE} for user ${user.userId}:`, error);
      }
    }
  }

  return {
    publishedHigh,
    publishedSpikes,
    failed
  };
}

export async function appendUserRiskSignalEvent(input: {
  orgId: string;
  userId: string;
  eventType: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  scoreImpact?: number;
  description: string;
  details?: Record<string, unknown>;
  occurredAt?: Date;
}): Promise<string> {
  const [row] = await db
    .insert(userRiskEvents)
    .values({
      orgId: input.orgId,
      userId: input.userId,
      eventType: input.eventType,
      severity: input.severity ?? null,
      scoreImpact: input.scoreImpact ?? 0,
      description: input.description,
      details: input.details ?? null,
      occurredAt: input.occurredAt ?? new Date()
    })
    .returning({ id: userRiskEvents.id });

  return row?.id ?? '';
}

export async function getUserRiskOrgMembership(userId: string, orgId: string): Promise<boolean> {
  const [membership] = await db
    .select({ id: organizationUsers.id })
    .from(organizationUsers)
    .where(
      and(
        eq(organizationUsers.userId, userId),
        eq(organizationUsers.orgId, orgId)
      )
    )
    .limit(1);
  return !!membership;
}

export async function listActiveDeviceSessionsForUserInOrg(input: {
  orgId: string;
  userEmail: string;
}): Promise<{ activeSessions: number; idleSessions: number }> {
  const usernameCandidates = Array.from(normalizeIdentityValue(input.userEmail));
  if (usernameCandidates.length === 0) {
    return { activeSessions: 0, idleSessions: 0 };
  }

  const rows = await db
    .select({
      activityState: deviceSessions.activityState
    })
    .from(deviceSessions)
    .where(
      and(
        eq(deviceSessions.orgId, input.orgId),
        eq(deviceSessions.isActive, true),
        inArray(deviceSessions.username, usernameCandidates)
      )
    );

  return {
    activeSessions: rows.length,
    idleSessions: rows.filter((row) => row.activityState === 'idle' || row.activityState === 'away').length
  };
}
