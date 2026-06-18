import { and, desc, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';

import { db } from '../db';
import {
  agentLogs,
  alertCorrelations,
  alerts,
  brainDeviceContext,
  deviceChangeLog,
  deviceEventLogs,
  devices,
  metricRollups,
} from '../db/schema';

type AlertRow = typeof alerts.$inferSelect;
type CorrelationRow = typeof alertCorrelations.$inferSelect;
type DeviceRow = Pick<typeof devices.$inferSelect, 'id' | 'hostname' | 'osType'>;

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

function rankEvidence(items: RcaEvidenceItem[]): RcaEvidenceItem[] {
  const sourceWeight: Record<RcaEvidenceItem['source'], number> = {
    alert: 100,
    correlation: 80,
    device_change: 75,
    event_log: 70,
    agent_log: 65,
    metric_rollup: 55,
    device_context: 45,
  };

  return [...items].sort((a, b) => {
    const timeDiff = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    if (timeDiff !== 0) return timeDiff;
    return sourceWeight[b.source] - sourceWeight[a.source];
  });
}

function buildAlertEvidence(alertRows: AlertRow[], deviceNames: Map<string, DeviceRow>): RcaEvidenceItem[] {
  return alertRows.map((alert) => {
    const device = deviceNames.get(alert.deviceId);
    return {
      id: `alert:${alert.id}`,
      source: 'alert',
      type: alert.severity,
      timestamp: toIso(asDate(alert.triggeredAt)),
      deviceId: alert.deviceId,
      alertId: alert.id,
      severity: alert.severity,
      title: alert.title,
      summary: `${alert.severity.toUpperCase()} alert on ${device?.hostname ?? alert.deviceId}: ${alert.message ?? alert.title}`,
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
    ...buildAlertEvidence(alertRows, deviceNames),
    ...correlationRows.map((link) => ({
      id: `correlation:${link.parentAlertId}:${link.childAlertId}`,
      source: 'correlation' as const,
      type: link.correlationType,
      timestamp: toIso(asDate(link.createdAt)),
      alertId: link.parentAlertId,
      title: `Correlation: ${link.correlationType}`,
      summary: `Alert ${link.parentAlertId} is correlated with ${link.childAlertId} at confidence ${Number(link.confidence ?? 0).toFixed(2)}.`,
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

  const timeline = rankEvidence(evidence).slice(0, maxEvidenceItems);
  const candidates = [
    buildPrimaryAlertCandidate(alertRows, options.groupScore),
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
