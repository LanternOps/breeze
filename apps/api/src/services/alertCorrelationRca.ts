import { and, desc, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';

import { db } from '../db';
import {
  agentLogs,
  alertCorrelationMembers,
  alertCorrelations,
  alertRules,
  alertTemplates,
  alerts,
  brainDeviceContext,
  configPolicyAlertRules,
  configPolicyFeatureLinks,
  configurationPolicies,
  deviceChangeLog,
  deviceEventLogs,
  devices,
  logCorrelationRules,
  logCorrelations,
  metricRollups,
} from '../db/schema';

type AlertRow = typeof alerts.$inferSelect;
type CorrelationRow = typeof alertCorrelations.$inferSelect;
type DeviceRow = Pick<typeof devices.$inferSelect, 'id' | 'hostname' | 'osType'>;

type AlertRuleSource = {
  ruleId: string;
  ruleName: string;
  ruleTargetType: string;
  ruleTargetId: string;
  ruleIsActive: boolean;
  templateId: string | null;
  templateName: string | null;
  templateCategory: string | null;
  templateSeverity: string | null;
  templateIsBuiltIn: boolean | null;
  templateCooldownMinutes: number | null;
};

type ConfigPolicyAlertSource = {
  configPolicyAlertRuleId: string;
  configPolicyAlertRuleName: string;
  configPolicyAlertSeverity: string;
  configPolicyAlertCooldownMinutes: number;
  featureLinkId: string;
  featureType: string;
  configurationPolicyId: string;
  configurationPolicyName: string;
  configurationPolicyStatus: string;
};

type LinkedLogCorrelation = {
  alertId: string | null;
  logCorrelationId: string;
  ruleId: string;
  ruleName: string;
  ruleSeverity: string;
  rulePattern: string;
  detectedPattern: string;
  firstSeen: Date;
  lastSeen: Date;
  occurrences: number;
  affectedDevices: unknown;
  sampleLogs: unknown;
};

type CorrelationMemberEvidence = {
  alertId: string;
  role: string;
  confidence: string | null;
  evidence: unknown;
  updatedAt: Date;
};

export interface RcaEvidenceItem {
  id: string;
  source: 'alert' | 'correlation' | 'device_context' | 'device_change' | 'event_log' | 'agent_log' | 'metric_rollup';
  type: string;
  timestamp: string;
  deviceId?: string;
  alertId?: string;
  severity?: string;
  title: string;
  summary: string;
  metadata?: Record<string, unknown>;
}

export interface RcaRootCauseCandidate {
  summary: string;
  confidence: number;
  supportingEvidenceIds: string[];
}

export interface RcaSuggestedNextStep {
  title: string;
  rationale: string;
  riskTier: 'low' | 'medium' | 'high';
  evidenceIds: string[];
}

export interface AlertCorrelationRcaResult {
  groupId: string;
  scope: {
    orgId: string;
    deviceIds: string[];
    alertIds: string[];
    windowStart: string;
    windowEnd: string;
  };
  timeline: RcaEvidenceItem[];
  rootCauseCandidates: RcaRootCauseCandidate[];
  suggestedNextSteps: RcaSuggestedNextStep[];
  gaps: string[];
}

interface BuildRcaOptions {
  orgId: string;
  groupId: string;
  groupScore?: number | null;
  alerts: AlertRow[];
  windowHours?: number;
  maxEvidenceItems?: number;
}

function toIso(value: Date): string {
  return value.toISOString();
}

function asDate(value: Date | string | null | undefined): Date {
  if (value instanceof Date) return value;
  const parsed = value ? new Date(value) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 100) / 100));
}

function summarizeJson(value: unknown, maxLength = 180): string {
  if (value == null) return '';
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  return raw.length > maxLength ? `${raw.slice(0, maxLength)}...` : raw;
}

function metadataRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function metadataStringArray(metadata: Record<string, unknown>, key: string, maxItems = 5): string[] {
  const value = metadata[key];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .slice(0, maxItems);
}

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function compactAffectedDevices(value: unknown): Array<{ deviceId: string; hostname: string | null; count: number | null }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 5).flatMap((item) => {
    const record = metadataRecord(item);
    const deviceId = metadataString(record, 'deviceId');
    if (!deviceId) return [];
    return [{
      deviceId,
      hostname: metadataString(record, 'hostname'),
      count: typeof record.count === 'number' ? record.count : null,
    }];
  });
}

function compactSampleLogIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => metadataString(metadataRecord(item), 'id'))
    .filter((id): id is string => Boolean(id))
    .slice(0, 5);
}

function buildCorrelationSummary(link: CorrelationRow): string {
  const metadata = metadataRecord(link.metadata);
  const details: string[] = [];
  const evidence = metadataStringArray(metadata, 'evidence');
  const sourceIds = [
    metadataString(metadata, 'ruleId') ? `rule ${metadataString(metadata, 'ruleId')}` : null,
    metadataString(metadata, 'templateId') ? `template ${metadataString(metadata, 'templateId')}` : null,
    metadataString(metadata, 'configPolicyId') && metadataString(metadata, 'configItemName')
      ? `config item ${metadataString(metadata, 'configPolicyId')}/${metadataString(metadata, 'configItemName')}`
      : null,
  ].filter((item): item is string => Boolean(item));
  const logRuleNames = metadataStringArray(metadata, 'logCorrelationRuleNames');
  const logPatterns = metadataStringArray(metadata, 'logPatterns', 3);
  const logOccurrences = typeof metadata.logOccurrences === 'number' ? metadata.logOccurrences : null;
  const logSeverity = metadataString(metadata, 'logSeverity');
  const flappingRuleIds = metadataStringArray(metadata, 'flappingRuleIds');
  const flappingDeviceIds = metadataStringArray(metadata, 'flappingDeviceIds');

  if (evidence.length > 0) details.push(`Evidence: ${evidence.join(', ')}`);
  if (sourceIds.length > 0) details.push(`Sources: ${sourceIds.join(', ')}`);
  if (logRuleNames.length > 0 || logPatterns.length > 0) {
    const logDetails = [
      logRuleNames.length > 0 ? `rules ${logRuleNames.join(', ')}` : null,
      logPatterns.length > 0 ? `patterns ${logPatterns.join(', ')}` : null,
      logOccurrences != null ? `${logOccurrences} occurrence${logOccurrences === 1 ? '' : 's'}` : null,
      logSeverity ? `severity ${logSeverity}` : null,
    ].filter((item): item is string => Boolean(item));
    details.push(`Log correlation: ${logDetails.join('; ')}`);
  }
  if (metadata.flappingDetected === true) {
    const flappingDetails = [
      flappingRuleIds.length > 0 ? `rules ${flappingRuleIds.join(', ')}` : null,
      flappingDeviceIds.length > 0 ? `devices ${flappingDeviceIds.join(', ')}` : null,
    ].filter((item): item is string => Boolean(item));
    details.push(`Flapping detected${flappingDetails.length > 0 ? ` on ${flappingDetails.join('; ')}` : ''}`);
  }

  const base = `Alert ${link.parentAlertId} is correlated with ${link.childAlertId} at confidence ${Number(link.confidence ?? 0).toFixed(2)}.`;
  return details.length > 0 ? `${base} ${details.join('. ')}.` : base;
}

function buildCorrelationMetadata(link: CorrelationRow): Record<string, unknown> {
  const metadata = metadataRecord(link.metadata);
  return {
    correlationId: link.id,
    parentAlertId: link.parentAlertId,
    childAlertId: link.childAlertId,
    confidence: Number(link.confidence ?? 0),
    evidence: metadataStringArray(metadata, 'evidence'),
    ruleId: metadataString(metadata, 'ruleId'),
    templateId: metadataString(metadata, 'templateId'),
    configPolicyId: metadataString(metadata, 'configPolicyId'),
    configItemName: metadataString(metadata, 'configItemName'),
    logCorrelationIds: metadataStringArray(metadata, 'logCorrelationIds'),
    logCorrelationRuleIds: metadataStringArray(metadata, 'logCorrelationRuleIds'),
    logCorrelationRuleNames: metadataStringArray(metadata, 'logCorrelationRuleNames'),
    logPatterns: metadataStringArray(metadata, 'logPatterns', 3),
    logOccurrences: typeof metadata.logOccurrences === 'number' ? metadata.logOccurrences : null,
    logSeverity: metadataString(metadata, 'logSeverity'),
    flappingDetected: metadata.flappingDetected === true,
    flappingRuleIds: metadataStringArray(metadata, 'flappingRuleIds'),
    flappingDeviceIds: metadataStringArray(metadata, 'flappingDeviceIds'),
    flappingConfigPolicyIds: metadataStringArray(metadata, 'flappingConfigPolicyIds'),
  };
}

function buildAlertMetadata(
  alert: AlertRow,
  ruleSource: AlertRuleSource | undefined,
  configSource: ConfigPolicyAlertSource | undefined,
  linkedLogCorrelations: LinkedLogCorrelation[],
  memberEvidence: CorrelationMemberEvidence | undefined,
): Record<string, unknown> {
  const memberEvidenceRecord = metadataRecord(memberEvidence?.evidence);
  return {
    alertId: alert.id,
    status: alert.status,
    ruleId: alert.ruleId,
    configPolicyId: alert.configPolicyId,
    configItemName: alert.configItemName,
    contextSummary: summarizeJson(alert.context, 500) || null,
    rule: ruleSource ? {
      id: ruleSource.ruleId,
      name: ruleSource.ruleName,
      targetType: ruleSource.ruleTargetType,
      targetId: ruleSource.ruleTargetId,
      isActive: ruleSource.ruleIsActive,
    } : null,
    template: ruleSource?.templateId ? {
      id: ruleSource.templateId,
      name: ruleSource.templateName,
      category: ruleSource.templateCategory,
      severity: ruleSource.templateSeverity,
      isBuiltIn: ruleSource.templateIsBuiltIn,
      cooldownMinutes: ruleSource.templateCooldownMinutes,
    } : null,
    configSource: configSource ? {
      configPolicyAlertRuleId: configSource.configPolicyAlertRuleId,
      configPolicyAlertRuleName: configSource.configPolicyAlertRuleName,
      severity: configSource.configPolicyAlertSeverity,
      cooldownMinutes: configSource.configPolicyAlertCooldownMinutes,
      featureLinkId: configSource.featureLinkId,
      featureType: configSource.featureType,
      configurationPolicyId: configSource.configurationPolicyId,
      configurationPolicyName: configSource.configurationPolicyName,
      configurationPolicyStatus: configSource.configurationPolicyStatus,
      itemName: alert.configItemName,
    } : alert.configPolicyId ? {
      configPolicyAlertRuleId: alert.configPolicyId,
      itemName: alert.configItemName,
    } : null,
    linkedLogCorrelations: linkedLogCorrelations.slice(0, 3).map((correlation) => ({
      id: correlation.logCorrelationId,
      ruleId: correlation.ruleId,
      ruleName: correlation.ruleName,
      ruleSeverity: correlation.ruleSeverity,
      rulePattern: correlation.rulePattern,
      detectedPattern: correlation.detectedPattern,
      firstSeen: toIso(asDate(correlation.firstSeen)),
      lastSeen: toIso(asDate(correlation.lastSeen)),
      occurrences: correlation.occurrences,
      affectedDevices: compactAffectedDevices(correlation.affectedDevices),
      sampleLogIds: compactSampleLogIds(correlation.sampleLogs),
    })),
    correlationMember: memberEvidence ? {
      role: memberEvidence.role,
      confidence: Number(memberEvidence.confidence ?? 0),
      evidenceVersion: metadataString(memberEvidenceRecord, 'version'),
      evidence: memberEvidenceRecord,
      updatedAt: toIso(asDate(memberEvidence.updatedAt)),
    } : null,
  };
}

const RCA_SOURCE_WEIGHT: Record<RcaEvidenceItem['source'], number> = {
  alert: 100,
  correlation: 80,
  device_change: 75,
  event_log: 70,
  agent_log: 65,
  metric_rollup: 55,
  device_context: 45,
};

/**
 * Select the top-N evidence items by importance (sourceWeight), then return those survivors
 * in chronological order for display. Selecting by importance FIRST (instead of sorting purely
 * by time and slicing) ensures high-signal evidence — e.g. the alerts and correlation edges —
 * is not dropped on busy windows where low-weight log/metric noise would otherwise crowd out
 * the earliest-N. Ties in weight are broken by recency so the most recent high-signal item wins.
 */
function rankEvidence(items: RcaEvidenceItem[], maxItems: number): RcaEvidenceItem[] {
  const byImportance = [...items].sort((a, b) => {
    const weightDiff = RCA_SOURCE_WEIGHT[b.source] - RCA_SOURCE_WEIGHT[a.source];
    if (weightDiff !== 0) return weightDiff;
    // Same source weight: prefer the more recent item.
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });

  const survivors = byImportance.slice(0, Math.max(maxItems, 0));

  return survivors.sort((a, b) => {
    const timeDiff = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    if (timeDiff !== 0) return timeDiff;
    return RCA_SOURCE_WEIGHT[b.source] - RCA_SOURCE_WEIGHT[a.source];
  });
}

function buildAlertEvidence(
  alertRows: AlertRow[],
  deviceNames: Map<string, DeviceRow>,
  ruleSources: Map<string, AlertRuleSource>,
  configSources: Map<string, ConfigPolicyAlertSource>,
  linkedLogCorrelations: Map<string, LinkedLogCorrelation[]>,
  memberEvidenceByAlertId: Map<string, CorrelationMemberEvidence>,
): RcaEvidenceItem[] {
  return alertRows.map((alert) => {
    const device = deviceNames.get(alert.deviceId);
    const ruleSource = alert.ruleId ? ruleSources.get(alert.ruleId) : undefined;
    const configSource = alert.configPolicyId ? configSources.get(alert.configPolicyId) : undefined;
    const alertLinkedLogCorrelations = linkedLogCorrelations.get(alert.id) ?? [];
    const memberEvidence = memberEvidenceByAlertId.get(alert.id);
    const sourceSummary = ruleSource?.ruleName
      ? ` via rule "${ruleSource.ruleName}"`
      : configSource?.configPolicyAlertRuleName
        ? ` via config policy rule "${configSource.configPolicyAlertRuleName}"`
        : alert.configPolicyId
          ? ` via config policy item "${alert.configItemName ?? alert.configPolicyId}"`
        : '';
    const linkedLogSummary = alertLinkedLogCorrelations[0]?.ruleName
      ? ` with linked log correlation "${alertLinkedLogCorrelations[0].ruleName}"`
      : '';
    return {
      id: `alert:${alert.id}`,
      source: 'alert',
      type: alert.severity,
      timestamp: toIso(asDate(alert.triggeredAt)),
      deviceId: alert.deviceId,
      alertId: alert.id,
      severity: alert.severity,
      title: alert.title,
      summary: `${alert.severity.toUpperCase()} alert on ${device?.hostname ?? alert.deviceId}${sourceSummary}${linkedLogSummary}: ${alert.message ?? alert.title}`,
      metadata: buildAlertMetadata(alert, ruleSource, configSource, alertLinkedLogCorrelations, memberEvidence),
    };
  });
}

function buildPrimaryAlertCandidate(alertRows: AlertRow[], groupScore: number | null | undefined): RcaRootCauseCandidate | null {
  const sorted = [...alertRows].sort((a, b) => a.triggeredAt.getTime() - b.triggeredAt.getTime());
  const root = sorted[0];
  if (!root) return null;
  const related = Math.max(sorted.length - 1, 0);
  return {
    summary: `${root.title} was the earliest alert in the correlated incident and may be the initiating symptom for ${related} related alert${related === 1 ? '' : 's'}.`,
    confidence: clampConfidence(Math.max(Number(groupScore ?? 0), 0.45)),
    supportingEvidenceIds: [`alert:${root.id}`],
  };
}

function buildChangeCandidate(evidence: RcaEvidenceItem[]): RcaRootCauseCandidate | null {
  const change = evidence.find((item) => item.source === 'device_change');
  if (!change) return null;
  return {
    summary: `A recent device change occurred before or during the incident window: ${change.summary}`,
    confidence: 0.58,
    supportingEvidenceIds: [change.id],
  };
}

function buildLogCandidate(evidence: RcaEvidenceItem[]): RcaRootCauseCandidate | null {
  const log = evidence.find((item) => item.source === 'event_log' || item.source === 'agent_log');
  if (!log) return null;
  return {
    summary: `A high-severity log entry aligns with the incident window: ${log.summary}`,
    confidence: 0.52,
    supportingEvidenceIds: [log.id],
  };
}

function buildCorrelationMetadataCandidate(evidence: RcaEvidenceItem[]): RcaRootCauseCandidate | null {
  const correlation = evidence.find((item) => item.source === 'correlation' && item.metadata);
  if (!correlation) return null;

  const metadata = metadataRecord(correlation.metadata);
  const logRuleNames = metadataStringArray(metadata, 'logCorrelationRuleNames', 3);
  const logPatterns = metadataStringArray(metadata, 'logPatterns', 3);
  const flappingRuleIds = metadataStringArray(metadata, 'flappingRuleIds', 3);
  const flappingDeviceIds = metadataStringArray(metadata, 'flappingDeviceIds', 3);

  if (metadata.flappingDetected === true) {
    const details = [
      flappingRuleIds.length > 0 ? `rules ${flappingRuleIds.join(', ')}` : null,
      flappingDeviceIds.length > 0 ? `devices ${flappingDeviceIds.join(', ')}` : null,
    ].filter((item): item is string => Boolean(item));
    return {
      summary: `Alert correlation detected flapping suppression evidence${details.length > 0 ? ` on ${details.join('; ')}` : ''}.`,
      confidence: 0.64,
      supportingEvidenceIds: [correlation.id],
    };
  }

  if (logRuleNames.length > 0 || logPatterns.length > 0) {
    const details = [
      logRuleNames.length > 0 ? `rules ${logRuleNames.join(', ')}` : null,
      logPatterns.length > 0 ? `patterns ${logPatterns.join(', ')}` : null,
    ].filter((item): item is string => Boolean(item));
    return {
      summary: `Alert correlation included matching log-correlation evidence: ${details.join('; ')}.`,
      confidence: 0.6,
      supportingEvidenceIds: [correlation.id],
    };
  }

  return null;
}

function buildSuggestedNextSteps(
  evidence: RcaEvidenceItem[],
  candidates: RcaRootCauseCandidate[],
  gaps: string[],
): RcaSuggestedNextStep[] {
  const steps: RcaSuggestedNextStep[] = [];
  const firstCandidate = candidates[0];
  if (firstCandidate) {
    steps.push({
      title: 'Validate the leading cause',
      rationale: 'Review the evidence supporting the highest-confidence candidate before changing device state.',
      riskTier: 'low',
      evidenceIds: firstCandidate.supportingEvidenceIds,
    });
  }

  const changeEvidence = evidence.find((item) => item.source === 'device_change');
  if (changeEvidence) {
    steps.push({
      title: 'Review recent changes',
      rationale: 'A configuration, service, software, or patch change overlaps the incident window.',
      riskTier: 'low',
      evidenceIds: [changeEvidence.id],
    });
  }

  const correlationEvidence = evidence.find((item) => item.source === 'correlation' && item.metadata);
  const correlationMetadata = metadataRecord(correlationEvidence?.metadata);
  const logCorrelationRuleNames = metadataStringArray(correlationMetadata, 'logCorrelationRuleNames', 3);
  if (correlationMetadata.flappingDetected === true && correlationEvidence) {
    steps.push({
      title: 'Review flapping suppression',
      rationale: 'Correlation evidence indicates repeated alert state changes; verify whether the underlying rule should be tuned or the device state is oscillating.',
      riskTier: 'low',
      evidenceIds: [correlationEvidence.id],
    });
  } else if (logCorrelationRuleNames.length > 0 && correlationEvidence) {
    steps.push({
      title: 'Inspect correlated log pattern',
      rationale: `Log-correlation evidence matched ${logCorrelationRuleNames.slice(0, 2).join(', ')} during the alert burst.`,
      riskTier: 'low',
      evidenceIds: [correlationEvidence.id],
    });
  }

  const logEvidence = evidence.find((item) => item.source === 'event_log' || item.source === 'agent_log');
  if (logEvidence) {
    steps.push({
      title: 'Inspect aligned error logs',
      rationale: 'Warning or error logs line up with the alert burst and may identify the failing service or component.',
      riskTier: 'low',
      evidenceIds: [logEvidence.id],
    });
  }

  const metricEvidence = evidence.find((item) => item.source === 'metric_rollup');
  if (metricEvidence) {
    steps.push({
      title: 'Verify resource pressure',
      rationale: 'Metric rollups show elevated utilization during the incident window.',
      riskTier: 'medium',
      evidenceIds: [metricEvidence.id],
    });
  }

  if (gaps.length > 0) {
    steps.push({
      title: 'Fill evidence gaps',
      rationale: gaps.slice(0, 2).join(' '),
      riskTier: 'low',
      evidenceIds: [],
    });
  }

  if (steps.length === 0) {
    steps.push({
      title: 'Confirm affected scope',
      rationale: 'No strong supporting evidence was found, so confirm the affected devices and user impact before taking action.',
      riskTier: 'low',
      evidenceIds: [],
    });
  }

  return steps.slice(0, 4);
}

export async function buildAlertCorrelationRca(options: BuildRcaOptions): Promise<AlertCorrelationRcaResult> {
  const alertRows = [...options.alerts].sort((a, b) => a.triggeredAt.getTime() - b.triggeredAt.getTime());
  const alertIds = alertRows.map((alert) => alert.id);
  const deviceIds = [...new Set(alertRows.map((alert) => alert.deviceId))];
  const firstAlertAt = alertRows[0]?.triggeredAt ?? new Date();
  const lastAlertAt = alertRows[alertRows.length - 1]?.triggeredAt ?? firstAlertAt;
  const windowHours = Math.min(Math.max(options.windowHours ?? 6, 1), 24);
  const maxEvidenceItems = Math.min(Math.max(options.maxEvidenceItems ?? 30, 5), 100);
  const windowStart = new Date(firstAlertAt.getTime() - windowHours * 60 * 60 * 1000);
  const windowEnd = new Date(lastAlertAt.getTime() + 60 * 60 * 1000);
  const gaps: string[] = [];

  if (alertRows.length === 0) {
    return {
      groupId: options.groupId,
      scope: {
        orgId: options.orgId,
        deviceIds: [],
        alertIds: [],
        windowStart: toIso(windowStart),
        windowEnd: toIso(windowEnd),
      },
      timeline: [],
      rootCauseCandidates: [],
      suggestedNextSteps: [{
        title: 'Confirm affected scope',
        rationale: 'No alerts were attached, so confirm the incident group membership before taking action.',
        riskTier: 'low',
        evidenceIds: [],
      }],
      gaps: ['No alerts were attached to this correlation group.'],
    };
  }

  const deviceRows = deviceIds.length > 0
    ? await db
        .select({ id: devices.id, hostname: devices.hostname, osType: devices.osType })
        .from(devices)
        .where(and(eq(devices.orgId, options.orgId), inArray(devices.id, deviceIds)))
    : [];
  const deviceNames = new Map(deviceRows.map((device) => [device.id, device]));
  const ruleIds = [...new Set(alertRows.map((alert) => alert.ruleId).filter((id): id is string => Boolean(id)))];
  const ruleSourceRows: AlertRuleSource[] = ruleIds.length > 0
    ? await db
        .select({
          ruleId: alertRules.id,
          ruleName: alertRules.name,
          ruleTargetType: alertRules.targetType,
          ruleTargetId: alertRules.targetId,
          ruleIsActive: alertRules.isActive,
          templateId: alertTemplates.id,
          templateName: alertTemplates.name,
          templateCategory: alertTemplates.category,
          templateSeverity: alertTemplates.severity,
          templateIsBuiltIn: alertTemplates.isBuiltIn,
          templateCooldownMinutes: alertTemplates.cooldownMinutes,
        })
        .from(alertRules)
        .leftJoin(alertTemplates, eq(alertRules.templateId, alertTemplates.id))
        .where(and(eq(alertRules.orgId, options.orgId), inArray(alertRules.id, ruleIds)))
    : [];
  const ruleSources = new Map(ruleSourceRows.map((row) => [row.ruleId, row]));
  const configPolicyAlertRuleIds = [
    ...new Set(alertRows.map((alert) => alert.configPolicyId).filter((id): id is string => Boolean(id)))
  ];
  const configSourceRows: ConfigPolicyAlertSource[] = configPolicyAlertRuleIds.length > 0
    ? await db
        .select({
          configPolicyAlertRuleId: configPolicyAlertRules.id,
          configPolicyAlertRuleName: configPolicyAlertRules.name,
          configPolicyAlertSeverity: configPolicyAlertRules.severity,
          configPolicyAlertCooldownMinutes: configPolicyAlertRules.cooldownMinutes,
          featureLinkId: configPolicyFeatureLinks.id,
          featureType: configPolicyFeatureLinks.featureType,
          configurationPolicyId: configurationPolicies.id,
          configurationPolicyName: configurationPolicies.name,
          configurationPolicyStatus: configurationPolicies.status,
        })
        .from(configPolicyAlertRules)
        .innerJoin(configPolicyFeatureLinks, eq(configPolicyAlertRules.featureLinkId, configPolicyFeatureLinks.id))
        .innerJoin(configurationPolicies, eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id))
        .where(and(
          eq(configurationPolicies.orgId, options.orgId),
          inArray(configPolicyAlertRules.id, configPolicyAlertRuleIds)
        ))
    : [];
  const configSources = new Map(configSourceRows.map((row) => [row.configPolicyAlertRuleId, row]));
  const linkedLogCorrelationRows: LinkedLogCorrelation[] = alertIds.length > 0
    ? await db
        .select({
          alertId: logCorrelations.alertId,
          logCorrelationId: logCorrelations.id,
          ruleId: logCorrelations.ruleId,
          ruleName: logCorrelationRules.name,
          ruleSeverity: logCorrelationRules.severity,
          rulePattern: logCorrelationRules.pattern,
          detectedPattern: logCorrelations.pattern,
          firstSeen: logCorrelations.firstSeen,
          lastSeen: logCorrelations.lastSeen,
          occurrences: logCorrelations.occurrences,
          affectedDevices: logCorrelations.affectedDevices,
          sampleLogs: logCorrelations.sampleLogs,
        })
        .from(logCorrelations)
        .innerJoin(logCorrelationRules, eq(logCorrelations.ruleId, logCorrelationRules.id))
        .where(and(eq(logCorrelations.orgId, options.orgId), inArray(logCorrelations.alertId, alertIds)))
        .orderBy(desc(logCorrelations.lastSeen))
        .limit(Math.min(alertIds.length * 3, 15))
    : [];
  const linkedLogCorrelationsByAlertId = new Map<string, LinkedLogCorrelation[]>();
  for (const correlation of linkedLogCorrelationRows) {
    if (!correlation.alertId) continue;
    const rows = linkedLogCorrelationsByAlertId.get(correlation.alertId) ?? [];
    if (rows.length >= 3) continue;
    rows.push(correlation);
    linkedLogCorrelationsByAlertId.set(correlation.alertId, rows);
  }
  const memberEvidenceRows: CorrelationMemberEvidence[] = alertIds.length > 0
    ? await db
        .select({
          alertId: alertCorrelationMembers.alertId,
          role: alertCorrelationMembers.role,
          confidence: alertCorrelationMembers.confidence,
          evidence: alertCorrelationMembers.evidence,
          updatedAt: alertCorrelationMembers.updatedAt,
        })
        .from(alertCorrelationMembers)
        .where(and(
          eq(alertCorrelationMembers.orgId, options.orgId),
          eq(alertCorrelationMembers.groupId, options.groupId),
          inArray(alertCorrelationMembers.alertId, alertIds)
        ))
        .limit(alertIds.length)
    : [];
  const memberEvidenceByAlertId = new Map(memberEvidenceRows.map((row) => [row.alertId, row]));

  const correlationRows = alertIds.length > 1
    ? await db
        .select()
        .from(alertCorrelations)
        .where(and(inArray(alertCorrelations.parentAlertId, alertIds), inArray(alertCorrelations.childAlertId, alertIds)))
    : [];

  const contextRows = deviceIds.length > 0
    ? await db
        .select()
        .from(brainDeviceContext)
        .where(and(eq(brainDeviceContext.orgId, options.orgId), inArray(brainDeviceContext.deviceId, deviceIds), isNull(brainDeviceContext.resolvedAt)))
        .limit(10)
    : [];

  const changeRows = deviceIds.length > 0
    ? await db
        .select()
        .from(deviceChangeLog)
        .where(and(eq(deviceChangeLog.orgId, options.orgId), inArray(deviceChangeLog.deviceId, deviceIds), gte(deviceChangeLog.timestamp, windowStart), lte(deviceChangeLog.timestamp, windowEnd)))
        .orderBy(desc(deviceChangeLog.timestamp))
        .limit(10)
    : [];

  const eventRows = deviceIds.length > 0
    ? await db
        .select()
        .from(deviceEventLogs)
        .where(and(
          eq(deviceEventLogs.orgId, options.orgId),
          inArray(deviceEventLogs.deviceId, deviceIds),
          inArray(deviceEventLogs.level, ['warning', 'error', 'critical']),
          gte(deviceEventLogs.timestamp, windowStart),
          lte(deviceEventLogs.timestamp, windowEnd)
        ))
        .orderBy(desc(deviceEventLogs.timestamp))
        .limit(10)
    : [];

  const agentLogRows = deviceIds.length > 0
    ? await db
        .select()
        .from(agentLogs)
        .where(and(
          eq(agentLogs.orgId, options.orgId),
          inArray(agentLogs.deviceId, deviceIds),
          or(eq(agentLogs.level, 'warn'), eq(agentLogs.level, 'error')),
          gte(agentLogs.timestamp, windowStart),
          lte(agentLogs.timestamp, windowEnd)
        ))
        .orderBy(desc(agentLogs.timestamp))
        .limit(10)
    : [];

  const metricRows = deviceIds.length > 0
    ? await db
        .select()
        .from(metricRollups)
        .where(and(
          eq(metricRollups.orgId, options.orgId),
          eq(metricRollups.sourceTable, 'device_metrics'),
          eq(metricRollups.bucketSeconds, 300),
          inArray(metricRollups.deviceId, deviceIds),
          inArray(metricRollups.metricName, ['cpu_percent', 'ram_percent', 'disk_percent']),
          gte(metricRollups.bucketStart, windowStart),
          lte(metricRollups.bucketStart, windowEnd)
        ))
        .orderBy(desc(metricRollups.bucketStart))
        .limit(15)
    : [];

  if (correlationRows.length === 0) gaps.push('No correlation edge evidence was found for the grouped alerts.');
  if (changeRows.length === 0) gaps.push('No device changes were found in the incident window.');
  if (eventRows.length === 0 && agentLogRows.length === 0) gaps.push('No warning/error logs were found in the incident window.');
  if (metricRows.length === 0) gaps.push('No 5-minute metric rollups were available in the incident window.');

  const evidence: RcaEvidenceItem[] = [
    ...buildAlertEvidence(
      alertRows,
      deviceNames,
      ruleSources,
      configSources,
      linkedLogCorrelationsByAlertId,
      memberEvidenceByAlertId
    ),
    ...correlationRows.map((link) => ({
      id: `correlation:${link.parentAlertId}:${link.childAlertId}`,
      source: 'correlation' as const,
      type: link.correlationType,
      timestamp: toIso(asDate(link.createdAt)),
      alertId: link.parentAlertId,
      title: `Correlation: ${link.correlationType}`,
      summary: buildCorrelationSummary(link),
      metadata: buildCorrelationMetadata(link),
    })),
    ...contextRows.map((row) => ({
      id: `device_context:${row.id}`,
      source: 'device_context' as const,
      type: row.contextType,
      timestamp: toIso(asDate(row.createdAt)),
      deviceId: row.deviceId,
      title: row.summary,
      summary: row.details ? `${row.summary}: ${summarizeJson(row.details)}` : row.summary,
    })),
    ...changeRows.map((row) => ({
      id: `device_change:${row.id}`,
      source: 'device_change' as const,
      type: `${row.changeType}.${row.changeAction}`,
      timestamp: toIso(asDate(row.timestamp)),
      deviceId: row.deviceId,
      title: row.subject,
      summary: `${row.changeAction} ${row.changeType}: ${row.subject}`,
    })),
    ...eventRows.map((row) => ({
      id: `event_log:${row.id}`,
      source: 'event_log' as const,
      type: row.category,
      timestamp: toIso(asDate(row.timestamp)),
      deviceId: row.deviceId,
      severity: row.level,
      title: `${row.source}${row.eventId ? ` ${row.eventId}` : ''}`,
      summary: row.message,
    })),
    ...agentLogRows.map((row) => ({
      id: `agent_log:${row.id}`,
      source: 'agent_log' as const,
      type: row.component,
      timestamp: toIso(asDate(row.timestamp)),
      deviceId: row.deviceId,
      severity: row.level,
      title: row.component,
      summary: row.message,
    })),
    ...metricRows
      .filter((row) => Number(row.avgValue ?? 0) >= 85 || Number(row.maxValue ?? 0) >= 90)
      .map((row) => ({
        id: `metric_rollup:${row.deviceId}:${row.metricName}:${row.bucketStart.toISOString()}`,
        source: 'metric_rollup' as const,
        type: row.metricName,
        timestamp: toIso(asDate(row.bucketStart)),
        deviceId: row.deviceId,
        title: `${row.metricName} elevated`,
        summary: `${row.metricName} averaged ${Number(row.avgValue ?? 0).toFixed(1)} with max ${Number(row.maxValue ?? 0).toFixed(1)} over a 5-minute bucket.`,
      })),
  ];

  const timeline = rankEvidence(evidence, maxEvidenceItems);
  const candidates = [
    buildPrimaryAlertCandidate(alertRows, options.groupScore),
    buildCorrelationMetadataCandidate(timeline),
    buildChangeCandidate(timeline),
    buildLogCandidate(timeline),
  ].filter((candidate): candidate is RcaRootCauseCandidate => Boolean(candidate));
  const suggestedNextSteps = buildSuggestedNextSteps(timeline, candidates, gaps);

  return {
    groupId: options.groupId,
    scope: {
      orgId: options.orgId,
      deviceIds,
      alertIds,
      windowStart: toIso(windowStart),
      windowEnd: toIso(windowEnd),
    },
    timeline,
    rootCauseCandidates: candidates,
    suggestedNextSteps,
    gaps,
  };
}
