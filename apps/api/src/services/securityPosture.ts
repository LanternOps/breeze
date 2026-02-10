import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';

import { db } from '../db';
import {
  deviceConnections,
  devicePatches,
  devices,
  patches,
  securityPostureOrgSnapshots,
  securityPostureSnapshots,
  securityStatus,
  securityThreats
} from '../db/schema';

const SECURITY_FACTOR_WEIGHTS = {
  patch_compliance: 25,
  encryption: 15,
  av_health: 15,
  firewall: 10,
  open_ports: 10,
  password_policy: 10,
  os_currency: 10,
  admin_exposure: 5
} as const;

type SecurityFactorKey = keyof typeof SECURITY_FACTOR_WEIGHTS;
type SecurityRiskLevel = 'low' | 'medium' | 'high' | 'critical';

const factorLabels: Record<SecurityFactorKey, string> = {
  patch_compliance: 'Patch Compliance',
  encryption: 'Disk Encryption',
  av_health: 'AV Health',
  firewall: 'Firewall Status',
  open_ports: 'Open Ports Exposure',
  password_policy: 'Password Policy',
  os_currency: 'OS Currency',
  admin_exposure: 'Admin Exposure'
};

type FactorResult = {
  score: number;
  confidence: number;
  dataGap?: string;
  evidence?: Record<string, unknown>;
};

type FactorScores = Record<SecurityFactorKey, FactorResult>;

export interface SecurityPostureItem {
  orgId: string;
  deviceId: string;
  deviceName: string;
  osType: 'windows' | 'macos' | 'linux';
  deviceStatus: 'online' | 'offline' | 'maintenance' | 'decommissioned';
  capturedAt: string;
  overallScore: number;
  riskLevel: SecurityRiskLevel;
  factors: FactorScores;
  recommendations: Array<{
    id: string;
    category: SecurityFactorKey;
    title: string;
    priority: 'critical' | 'high' | 'medium' | 'low';
    impact: number;
    summary: string;
  }>;
}

export interface SecurityPostureSummary {
  overallScore: number;
  devicesAudited: number;
  lowRiskDevices: number;
  mediumRiskDevices: number;
  highRiskDevices: number;
  criticalRiskDevices: number;
  factors: Record<SecurityFactorKey, number>;
  topIssues: Array<{ category: SecurityFactorKey; label: string; score: number }>;
}

export interface SecurityPostureFilter {
  orgId?: string;
  orgIds?: string[];
  minScore?: number;
  maxScore?: number;
  riskLevel?: SecurityRiskLevel;
  search?: string;
  limit?: number;
}

type DeviceInput = {
  orgId: string;
  deviceId: string;
  deviceName: string;
  osType: 'windows' | 'macos' | 'linux';
  deviceStatus: 'online' | 'offline' | 'maintenance' | 'decommissioned';
  osVersion: string;
  security: {
    realTimeProtection: boolean | null;
    definitionsDate: Date | null;
    threatCount: number | null;
    firewallEnabled: boolean | null;
    encryptionStatus: string | null;
    encryptionDetails: unknown;
    localAdminSummary: unknown;
    passwordPolicySummary: unknown;
  };
  patchStats: {
    totalCriticalAndImportant: number;
    installedCriticalAndImportant: number;
  };
  activeThreats: number;
  listeningPorts: number[];
};

type DeviceSnapshotRecord = typeof securityPostureSnapshots.$inferSelect;

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function toRiskLevel(score: number): SecurityRiskLevel {
  if (score >= 85) return 'low';
  if (score >= 70) return 'medium';
  if (score >= 45) return 'high';
  return 'critical';
}

function normalizeEncryptionStatus(raw?: string | null): 'encrypted' | 'partial' | 'unencrypted' | 'unknown' {
  if (!raw) return 'unknown';
  const value = raw.toLowerCase();
  if (value.includes('partial')) return 'partial';
  if (value.includes('encrypted')) return 'encrypted';
  if (value.includes('unencrypted') || value.includes('off') || value.includes('disabled')) return 'unencrypted';
  return 'unknown';
}

function getEncryptionVolumeCoverage(rawDetails: unknown): number | null {
  if (!rawDetails || typeof rawDetails !== 'object') return null;
  const details = rawDetails as Record<string, unknown>;
  const volumes = Array.isArray(details.volumes) ? details.volumes : null;
  if (!volumes || volumes.length === 0) return null;
  const protectedCount = volumes.filter((volume) => {
    if (!volume || typeof volume !== 'object') return false;
    const v = volume as Record<string, unknown>;
    return Boolean(v.protected ?? v.encrypted);
  }).length;
  return Math.round((protectedCount / volumes.length) * 100);
}

function scorePatchCompliance(input: DeviceInput): FactorResult {
  const total = input.patchStats.totalCriticalAndImportant;
  if (total <= 0) {
    return {
      score: 100,
      confidence: 0.35,
      dataGap: 'No critical/important patch telemetry found for this device.',
      evidence: { totalCriticalAndImportant: 0, installedCriticalAndImportant: 0 }
    };
  }

  const score = clampScore((input.patchStats.installedCriticalAndImportant / total) * 100);
  return {
    score,
    confidence: 0.9,
    evidence: {
      totalCriticalAndImportant: total,
      installedCriticalAndImportant: input.patchStats.installedCriticalAndImportant
    }
  };
}

function scoreEncryption(input: DeviceInput): FactorResult {
  const volumeCoverage = getEncryptionVolumeCoverage(input.security.encryptionDetails);
  if (volumeCoverage !== null) {
    return {
      score: clampScore(volumeCoverage),
      confidence: 0.95,
      evidence: { volumeCoverage }
    };
  }

  const normalized = normalizeEncryptionStatus(input.security.encryptionStatus);
  if (normalized === 'encrypted') {
    return { score: 100, confidence: 0.7, evidence: { encryptionStatus: normalized } };
  }
  if (normalized === 'partial') {
    return { score: 60, confidence: 0.65, evidence: { encryptionStatus: normalized } };
  }
  if (normalized === 'unencrypted') {
    return { score: 0, confidence: 0.7, evidence: { encryptionStatus: normalized } };
  }
  return {
    score: 50,
    confidence: 0.3,
    dataGap: 'Encryption status was unavailable.',
    evidence: { encryptionStatus: normalized }
  };
}

function scoreAvHealth(input: DeviceInput): FactorResult {
  const rtp = Boolean(input.security.realTimeProtection);
  let score = rtp ? 85 : 20;
  let confidence = input.security.realTimeProtection === null ? 0.3 : 0.9;
  const evidence: Record<string, unknown> = {
    realTimeProtection: input.security.realTimeProtection ?? null,
    activeThreats: input.activeThreats,
    threatCount: input.security.threatCount ?? 0
  };

  if (input.security.definitionsDate) {
    const ageHours = (Date.now() - input.security.definitionsDate.getTime()) / (1000 * 60 * 60);
    evidence.definitionsAgeHours = Math.round(ageHours);
    if (ageHours > 72) score -= 35;
    else if (ageHours > 24) score -= 20;
  } else {
    confidence = Math.min(confidence, 0.6);
    evidence.definitionsAgeHours = null;
    score -= 10;
  }

  const activeThreats = Math.max(0, input.activeThreats, input.security.threatCount ?? 0);
  score -= Math.min(30, activeThreats * 5);

  return {
    score: clampScore(score),
    confidence,
    dataGap: input.security.realTimeProtection === null ? 'Real-time AV status is unavailable.' : undefined,
    evidence
  };
}

function scoreFirewall(input: DeviceInput): FactorResult {
  if (input.security.firewallEnabled === true) {
    return { score: 100, confidence: 0.95, evidence: { firewallEnabled: true } };
  }
  if (input.security.firewallEnabled === false) {
    return { score: 0, confidence: 0.95, evidence: { firewallEnabled: false } };
  }
  return {
    score: 50,
    confidence: 0.3,
    dataGap: 'Firewall status was unavailable.',
    evidence: { firewallEnabled: null }
  };
}

const riskyPorts = new Set([22, 23, 445, 3389, 5900, 3306, 5432, 6379, 27017]);

function scoreOpenPorts(input: DeviceInput): FactorResult {
  if (input.listeningPorts.length === 0) {
    return {
      score: input.deviceStatus === 'online' ? 60 : 75,
      confidence: 0.35,
      dataGap: 'No listening-port telemetry available.',
      evidence: { listeningPortCount: 0, riskyPortCount: 0 }
    };
  }

  const portCount = input.listeningPorts.length;
  const riskyCount = input.listeningPorts.filter((port) => riskyPorts.has(port)).length;
  const basePenalty = Math.max(0, portCount - 12) * 3;
  const riskyPenalty = riskyCount * 10;

  return {
    score: clampScore(100 - basePenalty - riskyPenalty),
    confidence: 0.65,
    evidence: {
      listeningPortCount: portCount,
      riskyPortCount: riskyCount
    }
  };
}

function scorePasswordPolicy(input: DeviceInput): FactorResult {
  const raw = input.security.passwordPolicySummary;
  if (!raw || typeof raw !== 'object') {
    return {
      score: 60,
      confidence: 0.25,
      dataGap: 'Password policy summary was unavailable.',
      evidence: {}
    };
  }

  const policy = raw as Record<string, unknown>;
  const minLength = typeof policy.minLength === 'number' ? policy.minLength : null;
  const complexityEnabled = typeof policy.complexityEnabled === 'boolean' ? policy.complexityEnabled : null;
  const maxAgeDays = typeof policy.maxAgeDays === 'number' ? policy.maxAgeDays : null;
  const lockoutThreshold = typeof policy.lockoutThreshold === 'number' ? policy.lockoutThreshold : null;

  const checks = [
    minLength !== null ? minLength >= 12 : null,
    complexityEnabled !== null ? complexityEnabled : null,
    maxAgeDays !== null ? maxAgeDays <= 90 : null,
    lockoutThreshold !== null ? lockoutThreshold > 0 && lockoutThreshold <= 5 : null
  ];
  const knownChecks = checks.filter((value): value is boolean => value !== null);
  if (knownChecks.length === 0) {
    return {
      score: 60,
      confidence: 0.25,
      dataGap: 'Password policy summary had no parseable checks.',
      evidence: { minLength, complexityEnabled, maxAgeDays, lockoutThreshold }
    };
  }

  const passed = knownChecks.filter(Boolean).length;
  return {
    score: clampScore((passed / knownChecks.length) * 100),
    confidence: Math.max(0.35, Math.min(0.9, knownChecks.length / 4)),
    evidence: { minLength, complexityEnabled, maxAgeDays, lockoutThreshold, checksEvaluated: knownChecks.length }
  };
}

function scoreOsCurrency(input: DeviceInput): FactorResult {
  const value = input.osVersion.toLowerCase();
  let score = 75;

  if (input.osType === 'windows') {
    if (value.includes('windows 11')) score = 100;
    else if (value.includes('windows 10')) score = 85;
    else if (value.includes('server 2022')) score = 95;
    else if (value.includes('server 2019')) score = 80;
    else if (value.includes('server 2016')) score = 60;
    else score = 45;
  } else if (input.osType === 'macos') {
    const major = Number.parseInt(value.split(/[. ]/).find((chunk) => /^\d+$/.test(chunk)) ?? '0', 10);
    if (major >= 14) score = 100;
    else if (major >= 13) score = 90;
    else if (major >= 12) score = 70;
    else score = 50;
  } else {
    if (value.includes('ubuntu 24') || value.includes('debian 12') || value.includes('rhel 9')) score = 90;
    else if (value.includes('ubuntu 22') || value.includes('debian 11') || value.includes('rhel 8')) score = 80;
    else score = 70;
  }

  return {
    score,
    confidence: 0.55,
    evidence: { osType: input.osType, osVersion: input.osVersion }
  };
}

function scoreAdminExposure(input: DeviceInput): FactorResult {
  const raw = input.security.localAdminSummary;
  if (!raw || typeof raw !== 'object') {
    return {
      score: 70,
      confidence: 0.3,
      dataGap: 'Local admin summary was unavailable.',
      evidence: {}
    };
  }

  const summary = raw as Record<string, unknown>;
  const adminCount = typeof summary.adminCount === 'number'
    ? summary.adminCount
    : typeof summary.count === 'number'
      ? summary.count
      : null;

  if (adminCount === null) {
    return {
      score: 70,
      confidence: 0.3,
      dataGap: 'Local admin summary did not include admin count.',
      evidence: summary
    };
  }

  let score = 100;
  if (adminCount > 6) score = 15;
  else if (adminCount > 4) score = 40;
  else if (adminCount > 2) score = 70;

  return {
    score,
    confidence: 0.75,
    evidence: { adminCount }
  };
}

function computeDeviceFactors(input: DeviceInput): FactorScores {
  return {
    patch_compliance: scorePatchCompliance(input),
    encryption: scoreEncryption(input),
    av_health: scoreAvHealth(input),
    firewall: scoreFirewall(input),
    open_ports: scoreOpenPorts(input),
    password_policy: scorePasswordPolicy(input),
    os_currency: scoreOsCurrency(input),
    admin_exposure: scoreAdminExposure(input)
  };
}

function computeOverallScore(factors: FactorScores): number {
  const weightedSum = Object.entries(SECURITY_FACTOR_WEIGHTS).reduce((sum, [key, weight]) => {
    const score = factors[key as SecurityFactorKey].score;
    return sum + score * (weight / 100);
  }, 0);
  return clampScore(weightedSum);
}

function priorityFromImpact(impact: number): 'critical' | 'high' | 'medium' | 'low' {
  if (impact >= 20) return 'critical';
  if (impact >= 12) return 'high';
  if (impact >= 7) return 'medium';
  return 'low';
}

function buildRecommendations(factors: FactorScores): Array<{
  id: string;
  category: SecurityFactorKey;
  title: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  impact: number;
  summary: string;
}> {
  return (Object.keys(factors) as SecurityFactorKey[])
    .map((category) => {
      const factor = factors[category];
      const weight = SECURITY_FACTOR_WEIGHTS[category];
      const impact = Math.round(((100 - factor.score) * weight) / 100);
      return {
        id: `rec-${category}`,
        category,
        title: `Improve ${factorLabels[category]}`,
        priority: priorityFromImpact(impact),
        impact,
        summary: factor.dataGap
          ? `${factorLabels[category]} data is incomplete. Collect richer telemetry before remediation.`
          : `${factorLabels[category]} is below target. Focus this factor to improve posture quickly.`
      };
    })
    .filter((item) => item.impact > 0)
    .sort((a, b) => b.impact - a.impact)
    .slice(0, 8);
}

function toDevicePosture(input: DeviceInput, capturedAt: Date): SecurityPostureItem {
  const factors = computeDeviceFactors(input);
  const overallScore = computeOverallScore(factors);
  return {
    orgId: input.orgId,
    deviceId: input.deviceId,
    deviceName: input.deviceName,
    osType: input.osType,
    deviceStatus: input.deviceStatus,
    capturedAt: capturedAt.toISOString(),
    overallScore,
    riskLevel: toRiskLevel(overallScore),
    factors,
    recommendations: buildRecommendations(factors)
  };
}

function buildSummary(items: SecurityPostureItem[]): SecurityPostureSummary {
  if (items.length === 0) {
    return {
      overallScore: 0,
      devicesAudited: 0,
      lowRiskDevices: 0,
      mediumRiskDevices: 0,
      highRiskDevices: 0,
      criticalRiskDevices: 0,
      factors: {
        patch_compliance: 0,
        encryption: 0,
        av_health: 0,
        firewall: 0,
        open_ports: 0,
        password_policy: 0,
        os_currency: 0,
        admin_exposure: 0
      },
      topIssues: []
    };
  }

  const factorTotals: Record<SecurityFactorKey, number> = {
    patch_compliance: 0,
    encryption: 0,
    av_health: 0,
    firewall: 0,
    open_ports: 0,
    password_policy: 0,
    os_currency: 0,
    admin_exposure: 0
  };

  for (const item of items) {
    for (const factorKey of Object.keys(factorTotals) as SecurityFactorKey[]) {
      factorTotals[factorKey] += item.factors[factorKey].score;
    }
  }

  const averages = Object.fromEntries(
    (Object.keys(factorTotals) as SecurityFactorKey[]).map((factorKey) => [
      factorKey,
      clampScore(factorTotals[factorKey] / items.length)
    ])
  ) as Record<SecurityFactorKey, number>;

  const overallScore = clampScore(items.reduce((sum, item) => sum + item.overallScore, 0) / items.length);
  const lowRiskDevices = items.filter((item) => item.riskLevel === 'low').length;
  const mediumRiskDevices = items.filter((item) => item.riskLevel === 'medium').length;
  const highRiskDevices = items.filter((item) => item.riskLevel === 'high').length;
  const criticalRiskDevices = items.filter((item) => item.riskLevel === 'critical').length;

  const topIssues = (Object.keys(averages) as SecurityFactorKey[])
    .map((key) => ({ category: key, label: factorLabels[key], score: averages[key] }))
    .sort((a, b) => a.score - b.score)
    .slice(0, 3);

  return {
    overallScore,
    devicesAudited: items.length,
    lowRiskDevices,
    mediumRiskDevices,
    highRiskDevices,
    criticalRiskDevices,
    factors: averages,
    topIssues
  };
}

async function loadDeviceInputsForOrg(orgId: string): Promise<DeviceInput[]> {
  const baseRows = await db
    .select({
      orgId: devices.orgId,
      deviceId: devices.id,
      deviceName: devices.hostname,
      osType: devices.osType,
      deviceStatus: devices.status,
      osVersion: devices.osVersion,
      realTimeProtection: securityStatus.realTimeProtection,
      definitionsDate: securityStatus.definitionsDate,
      threatCount: securityStatus.threatCount,
      firewallEnabled: securityStatus.firewallEnabled,
      encryptionStatus: securityStatus.encryptionStatus,
      encryptionDetails: securityStatus.encryptionDetails,
      localAdminSummary: securityStatus.localAdminSummary,
      passwordPolicySummary: securityStatus.passwordPolicySummary
    })
    .from(devices)
    .leftJoin(securityStatus, eq(securityStatus.deviceId, devices.id))
    .where(and(eq(devices.orgId, orgId), sql`${devices.status} <> 'decommissioned'`));

  if (baseRows.length === 0) return [];

  const deviceIds = baseRows.map((row) => row.deviceId);

  const [patchRows, threatRows, portRows] = await Promise.all([
    db
      .select({
        deviceId: devicePatches.deviceId,
        severity: patches.severity,
        status: devicePatches.status,
        count: sql<number>`count(*)`
      })
      .from(devicePatches)
      .innerJoin(patches, eq(devicePatches.patchId, patches.id))
      .where(inArray(devicePatches.deviceId, deviceIds))
      .groupBy(devicePatches.deviceId, patches.severity, devicePatches.status),
    db
      .select({
        deviceId: securityThreats.deviceId,
        count: sql<number>`count(*)`
      })
      .from(securityThreats)
      .where(and(inArray(securityThreats.deviceId, deviceIds), inArray(securityThreats.status, ['detected', 'failed'])))
      .groupBy(securityThreats.deviceId),
    db
      .select({
        deviceId: deviceConnections.deviceId,
        localPort: deviceConnections.localPort,
        state: deviceConnections.state,
        remoteAddr: deviceConnections.remoteAddr
      })
      .from(deviceConnections)
      .where(inArray(deviceConnections.deviceId, deviceIds))
  ]);

  const patchMap = new Map<string, { totalCriticalAndImportant: number; installedCriticalAndImportant: number }>();
  for (const row of patchRows) {
    if (row.severity !== 'critical' && row.severity !== 'important') continue;
    const current = patchMap.get(row.deviceId) ?? { totalCriticalAndImportant: 0, installedCriticalAndImportant: 0 };
    const count = Number(row.count ?? 0);
    current.totalCriticalAndImportant += count;
    if (row.status === 'installed') {
      current.installedCriticalAndImportant += count;
    }
    patchMap.set(row.deviceId, current);
  }

  const threatMap = new Map<string, number>();
  for (const row of threatRows) {
    threatMap.set(row.deviceId, Number(row.count ?? 0));
  }

  const listeningPortsMap = new Map<string, Set<number>>();
  for (const row of portRows) {
    const state = (row.state ?? '').toLowerCase();
    const isListening = state.includes('listen') || row.remoteAddr === null;
    if (!isListening) continue;
    const existing = listeningPortsMap.get(row.deviceId) ?? new Set<number>();
    existing.add(row.localPort);
    listeningPortsMap.set(row.deviceId, existing);
  }

  return baseRows.map((row) => ({
    orgId: row.orgId,
    deviceId: row.deviceId,
    deviceName: row.deviceName,
    osType: row.osType,
    deviceStatus: row.deviceStatus,
    osVersion: row.osVersion,
    security: {
      realTimeProtection: row.realTimeProtection,
      definitionsDate: row.definitionsDate,
      threatCount: row.threatCount,
      firewallEnabled: row.firewallEnabled,
      encryptionStatus: row.encryptionStatus,
      encryptionDetails: row.encryptionDetails,
      localAdminSummary: row.localAdminSummary,
      passwordPolicySummary: row.passwordPolicySummary
    },
    patchStats: patchMap.get(row.deviceId) ?? { totalCriticalAndImportant: 0, installedCriticalAndImportant: 0 },
    activeThreats: threatMap.get(row.deviceId) ?? 0,
    listeningPorts: Array.from(listeningPortsMap.get(row.deviceId) ?? new Set<number>())
  }));
}

async function getLatestDeviceSnapshotsForOrg(orgId: string): Promise<Map<string, DeviceSnapshotRecord>> {
  const rows = await db
    .select()
    .from(securityPostureSnapshots)
    .where(eq(securityPostureSnapshots.orgId, orgId))
    .orderBy(desc(securityPostureSnapshots.capturedAt));

  const latest = new Map<string, DeviceSnapshotRecord>();
  for (const row of rows) {
    if (!latest.has(row.deviceId)) {
      latest.set(row.deviceId, row);
    }
  }
  return latest;
}

function changedTopFactors(previous: DeviceSnapshotRecord, next: SecurityPostureItem): boolean {
  const previousFactors: Array<[SecurityFactorKey, number]> = [
    ['patch_compliance', previous.patchComplianceScore],
    ['encryption', previous.encryptionScore],
    ['av_health', previous.avHealthScore],
    ['firewall', previous.firewallScore],
    ['open_ports', previous.openPortsScore],
    ['password_policy', previous.passwordPolicyScore],
    ['os_currency', previous.osCurrencyScore],
    ['admin_exposure', previous.adminExposureScore]
  ];
  const nextFactors: Array<[SecurityFactorKey, number]> = [
    ['patch_compliance', next.factors.patch_compliance.score],
    ['encryption', next.factors.encryption.score],
    ['av_health', next.factors.av_health.score],
    ['firewall', next.factors.firewall.score],
    ['open_ports', next.factors.open_ports.score],
    ['password_policy', next.factors.password_policy.score],
    ['os_currency', next.factors.os_currency.score],
    ['admin_exposure', next.factors.admin_exposure.score]
  ];
  const prevTop = previousFactors.sort((a, b) => a[1] - b[1]).slice(0, 3).map(([key]) => key).join(',');
  const nextTop = nextFactors.sort((a, b) => a[1] - b[1]).slice(0, 3).map(([key]) => key).join(',');
  return prevTop !== nextTop;
}

export async function computeAndPersistOrgSecurityPosture(orgId: string): Promise<{
  capturedAt: string;
  devices: SecurityPostureItem[];
  summary: SecurityPostureSummary;
  changedDevices: Array<{
    orgId: string;
    deviceId: string;
    previousScore: number | null;
    currentScore: number;
    delta: number;
    previousRiskLevel: SecurityRiskLevel | null;
    currentRiskLevel: SecurityRiskLevel;
    changedFactors: SecurityFactorKey[];
  }>;
}> {
  const capturedAt = new Date();
  const inputs = await loadDeviceInputsForOrg(orgId);
  const devicesPosture = inputs.map((input) => toDevicePosture(input, capturedAt));
  const summary = buildSummary(devicesPosture);
  const previousMap = await getLatestDeviceSnapshotsForOrg(orgId);
  const changedDevices: Array<{
    orgId: string;
    deviceId: string;
    previousScore: number | null;
    currentScore: number;
    delta: number;
    previousRiskLevel: SecurityRiskLevel | null;
    currentRiskLevel: SecurityRiskLevel;
    changedFactors: SecurityFactorKey[];
  }> = [];

  await db.transaction(async (tx) => {
    if (devicesPosture.length > 0) {
      await tx.insert(securityPostureSnapshots).values(
        devicesPosture.map((item) => ({
          orgId: item.orgId,
          deviceId: item.deviceId,
          capturedAt,
          overallScore: item.overallScore,
          riskLevel: item.riskLevel,
          patchComplianceScore: item.factors.patch_compliance.score,
          encryptionScore: item.factors.encryption.score,
          avHealthScore: item.factors.av_health.score,
          firewallScore: item.factors.firewall.score,
          openPortsScore: item.factors.open_ports.score,
          passwordPolicyScore: item.factors.password_policy.score,
          osCurrencyScore: item.factors.os_currency.score,
          adminExposureScore: item.factors.admin_exposure.score,
          factorDetails: item.factors,
          recommendations: item.recommendations
        }))
      );
    }

    await tx.insert(securityPostureOrgSnapshots).values({
      orgId,
      capturedAt,
      overallScore: summary.overallScore,
      devicesAudited: summary.devicesAudited,
      lowRiskDevices: summary.lowRiskDevices,
      mediumRiskDevices: summary.mediumRiskDevices,
      highRiskDevices: summary.highRiskDevices,
      criticalRiskDevices: summary.criticalRiskDevices,
      patchComplianceScore: summary.factors.patch_compliance,
      encryptionScore: summary.factors.encryption,
      avHealthScore: summary.factors.av_health,
      firewallScore: summary.factors.firewall,
      openPortsScore: summary.factors.open_ports,
      passwordPolicyScore: summary.factors.password_policy,
      osCurrencyScore: summary.factors.os_currency,
      adminExposureScore: summary.factors.admin_exposure,
      topIssues: summary.topIssues,
      summary: {
        generatedBy: 'security-posture-service',
        devicesAudited: summary.devicesAudited
      }
    });
  });

  for (const item of devicesPosture) {
    const previous = previousMap.get(item.deviceId);
    const changedFactors = (Object.keys(SECURITY_FACTOR_WEIGHTS) as SecurityFactorKey[])
      .filter((key) => {
        if (!previous) return true;
        const prevValue = key === 'patch_compliance'
          ? previous.patchComplianceScore
          : key === 'encryption'
            ? previous.encryptionScore
            : key === 'av_health'
              ? previous.avHealthScore
              : key === 'firewall'
                ? previous.firewallScore
                : key === 'open_ports'
                  ? previous.openPortsScore
                  : key === 'password_policy'
                    ? previous.passwordPolicyScore
                    : key === 'os_currency'
                      ? previous.osCurrencyScore
                      : previous.adminExposureScore;
        return Math.abs(prevValue - item.factors[key].score) >= 5;
      });

    const delta = previous ? item.overallScore - previous.overallScore : item.overallScore;
    const riskChanged = previous ? previous.riskLevel !== item.riskLevel : true;
    const significantDelta = previous ? Math.abs(delta) >= 5 : true;
    const topFactorsChanged = previous ? changedTopFactors(previous, item) : true;
    if (!significantDelta && !riskChanged && !topFactorsChanged) continue;

    changedDevices.push({
      orgId: item.orgId,
      deviceId: item.deviceId,
      previousScore: previous?.overallScore ?? null,
      currentScore: item.overallScore,
      delta,
      previousRiskLevel: previous?.riskLevel ?? null,
      currentRiskLevel: item.riskLevel,
      changedFactors
    });
  }

  return {
    capturedAt: capturedAt.toISOString(),
    devices: devicesPosture,
    summary,
    changedDevices
  };
}

type LatestPostureRow = {
  id: string;
  orgId: string;
  deviceId: string;
  capturedAt: Date;
  overallScore: number;
  riskLevel: SecurityRiskLevel;
  patchComplianceScore: number;
  encryptionScore: number;
  avHealthScore: number;
  firewallScore: number;
  openPortsScore: number;
  passwordPolicyScore: number;
  osCurrencyScore: number;
  adminExposureScore: number;
  factorDetails: unknown;
  recommendations: unknown;
};

function hydratePostureRows(rows: LatestPostureRow[], deviceRows: Array<{
  id: string;
  orgId: string;
  hostname: string;
  osType: 'windows' | 'macos' | 'linux';
  status: 'online' | 'offline' | 'maintenance' | 'decommissioned';
}>): SecurityPostureItem[] {
  const deviceMap = new Map(deviceRows.map((row) => [row.id, row]));
  return rows
    .map((row) => {
      const device = deviceMap.get(row.deviceId);
      if (!device) return null;
      const factors: FactorScores = {
        patch_compliance: { score: row.patchComplianceScore, confidence: 1 },
        encryption: { score: row.encryptionScore, confidence: 1 },
        av_health: { score: row.avHealthScore, confidence: 1 },
        firewall: { score: row.firewallScore, confidence: 1 },
        open_ports: { score: row.openPortsScore, confidence: 1 },
        password_policy: { score: row.passwordPolicyScore, confidence: 1 },
        os_currency: { score: row.osCurrencyScore, confidence: 1 },
        admin_exposure: { score: row.adminExposureScore, confidence: 1 }
      };
      if (row.factorDetails && typeof row.factorDetails === 'object') {
        const detailObj = row.factorDetails as Record<string, FactorResult>;
        for (const key of Object.keys(factors) as SecurityFactorKey[]) {
          if (detailObj[key] && typeof detailObj[key].score === 'number') {
            factors[key] = detailObj[key];
          }
        }
      }

      return {
        orgId: row.orgId,
        deviceId: row.deviceId,
        deviceName: device.hostname,
        osType: device.osType,
        deviceStatus: device.status,
        capturedAt: row.capturedAt.toISOString(),
        overallScore: row.overallScore,
        riskLevel: row.riskLevel,
        factors,
        recommendations: Array.isArray(row.recommendations)
          ? row.recommendations as SecurityPostureItem['recommendations']
          : []
      };
    })
    .filter((row): row is SecurityPostureItem => row !== null);
}

export async function listLatestSecurityPosture(filter: SecurityPostureFilter): Promise<SecurityPostureItem[]> {
  const maxLimit = Math.min(Math.max(Number(filter.limit ?? 500), 1), 2000);
  const conditions = [];
  if (filter.orgId) {
    conditions.push(eq(securityPostureSnapshots.orgId, filter.orgId));
  } else if (filter.orgIds && filter.orgIds.length > 0) {
    conditions.push(inArray(securityPostureSnapshots.orgId, filter.orgIds));
  }

  const rows = await db
    .select({
      id: securityPostureSnapshots.id,
      orgId: securityPostureSnapshots.orgId,
      deviceId: securityPostureSnapshots.deviceId,
      capturedAt: securityPostureSnapshots.capturedAt,
      overallScore: securityPostureSnapshots.overallScore,
      riskLevel: securityPostureSnapshots.riskLevel,
      patchComplianceScore: securityPostureSnapshots.patchComplianceScore,
      encryptionScore: securityPostureSnapshots.encryptionScore,
      avHealthScore: securityPostureSnapshots.avHealthScore,
      firewallScore: securityPostureSnapshots.firewallScore,
      openPortsScore: securityPostureSnapshots.openPortsScore,
      passwordPolicyScore: securityPostureSnapshots.passwordPolicyScore,
      osCurrencyScore: securityPostureSnapshots.osCurrencyScore,
      adminExposureScore: securityPostureSnapshots.adminExposureScore,
      factorDetails: securityPostureSnapshots.factorDetails,
      recommendations: securityPostureSnapshots.recommendations
    })
    .from(securityPostureSnapshots)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(securityPostureSnapshots.capturedAt))
    .limit(maxLimit * 20);

  const latestByDevice = new Map<string, LatestPostureRow>();
  for (const row of rows) {
    if (!latestByDevice.has(row.deviceId)) {
      latestByDevice.set(row.deviceId, row);
    }
    if (latestByDevice.size >= maxLimit) {
      break;
    }
  }

  const latestRows = Array.from(latestByDevice.values());
  if (latestRows.length === 0) return [];

  const deviceRows = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      hostname: devices.hostname,
      osType: devices.osType,
      status: devices.status
    })
    .from(devices)
    .where(inArray(devices.id, latestRows.map((row) => row.deviceId)));

  let items = hydratePostureRows(latestRows, deviceRows);

  if (typeof filter.minScore === 'number') {
    items = items.filter((item) => item.overallScore >= filter.minScore!);
  }
  if (typeof filter.maxScore === 'number') {
    items = items.filter((item) => item.overallScore <= filter.maxScore!);
  }
  if (filter.riskLevel) {
    items = items.filter((item) => item.riskLevel === filter.riskLevel);
  }
  if (filter.search) {
    const term = filter.search.toLowerCase();
    items = items.filter((item) => item.deviceName.toLowerCase().includes(term));
  }

  items.sort((a, b) => a.overallScore - b.overallScore);
  return items.slice(0, maxLimit);
}

export async function getLatestSecurityPostureForDevice(deviceId: string): Promise<SecurityPostureItem | null> {
  const [row] = await db
    .select({
      id: securityPostureSnapshots.id,
      orgId: securityPostureSnapshots.orgId,
      deviceId: securityPostureSnapshots.deviceId,
      capturedAt: securityPostureSnapshots.capturedAt,
      overallScore: securityPostureSnapshots.overallScore,
      riskLevel: securityPostureSnapshots.riskLevel,
      patchComplianceScore: securityPostureSnapshots.patchComplianceScore,
      encryptionScore: securityPostureSnapshots.encryptionScore,
      avHealthScore: securityPostureSnapshots.avHealthScore,
      firewallScore: securityPostureSnapshots.firewallScore,
      openPortsScore: securityPostureSnapshots.openPortsScore,
      passwordPolicyScore: securityPostureSnapshots.passwordPolicyScore,
      osCurrencyScore: securityPostureSnapshots.osCurrencyScore,
      adminExposureScore: securityPostureSnapshots.adminExposureScore,
      factorDetails: securityPostureSnapshots.factorDetails,
      recommendations: securityPostureSnapshots.recommendations
    })
    .from(securityPostureSnapshots)
    .where(eq(securityPostureSnapshots.deviceId, deviceId))
    .orderBy(desc(securityPostureSnapshots.capturedAt))
    .limit(1);

  if (!row) return null;

  const [device] = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      hostname: devices.hostname,
      osType: devices.osType,
      status: devices.status
    })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) return null;
  return hydratePostureRows([row], [device])[0] ?? null;
}

export async function getSecurityPostureTrend(params: {
  orgId?: string;
  orgIds?: string[];
  days: number;
}): Promise<Array<Record<string, string | number>>> {
  const since = new Date(Date.now() - params.days * 24 * 60 * 60 * 1000);
  const conditions = [gte(securityPostureOrgSnapshots.capturedAt, since)];
  if (params.orgId) {
    conditions.push(eq(securityPostureOrgSnapshots.orgId, params.orgId));
  } else if (params.orgIds && params.orgIds.length > 0) {
    conditions.push(inArray(securityPostureOrgSnapshots.orgId, params.orgIds));
  }

  const rows = await db
    .select({
      capturedAt: securityPostureOrgSnapshots.capturedAt,
      overallScore: securityPostureOrgSnapshots.overallScore,
      patchComplianceScore: securityPostureOrgSnapshots.patchComplianceScore,
      encryptionScore: securityPostureOrgSnapshots.encryptionScore,
      avHealthScore: securityPostureOrgSnapshots.avHealthScore,
      firewallScore: securityPostureOrgSnapshots.firewallScore,
      openPortsScore: securityPostureOrgSnapshots.openPortsScore,
      passwordPolicyScore: securityPostureOrgSnapshots.passwordPolicyScore,
      osCurrencyScore: securityPostureOrgSnapshots.osCurrencyScore,
      adminExposureScore: securityPostureOrgSnapshots.adminExposureScore
    })
    .from(securityPostureOrgSnapshots)
    .where(and(...conditions))
    .orderBy(desc(securityPostureOrgSnapshots.capturedAt));

  const grouped = new Map<string, Array<typeof rows[number]>>();
  for (const row of rows) {
    const day = row.capturedAt.toISOString().slice(0, 10);
    const current = grouped.get(day) ?? [];
    current.push(row);
    grouped.set(day, current);
  }

  const points = Array.from(grouped.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([timestamp, entries]) => {
      const avg = (key: keyof typeof entries[number]) =>
        clampScore(entries.reduce((sum, entry) => sum + Number(entry[key] ?? 0), 0) / entries.length);
      const overall = avg('overallScore');
      const antivirus = avg('avHealthScore');
      const firewall = avg('firewallScore');
      const encryption = avg('encryptionScore');
      const passwordPolicy = avg('passwordPolicyScore');
      const adminAccounts = avg('adminExposureScore');
      const patchCompliance = avg('patchComplianceScore');
      const vulnerabilityManagement = clampScore((antivirus + patchCompliance) / 2);
      return {
        timestamp,
        overall,
        antivirus,
        firewall,
        encryption,
        password_policy: passwordPolicy,
        admin_accounts: adminAccounts,
        patch_compliance: patchCompliance,
        vulnerability_management: vulnerabilityManagement
      };
    });

  return points;
}
