import { Job, Queue, Worker } from 'bullmq';
import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../db';
import {
  alertCorrelations,
  alertRules,
  alerts,
  devices,
  logCorrelationRules,
  logCorrelations,
  type LogCorrelationAffectedDevice,
  type LogCorrelationSampleLog,
} from '../db/schema';
import { persistAlertCorrelationGroupsForAlerts } from '../services/alertCorrelationGroups';
import { isReusableState } from '../services/bullmqUtils';
import { shouldProduceMlOutput } from '../services/mlFeatureFlags';
import { getBullMQConnection } from '../services/redis';
import { attachWorkerObservability } from './workerObservability';

const ALERT_CORRELATION_QUEUE = 'alert-correlation';
const DEDUPE_WINDOW_MS = 30 * 1000;
const DEFAULT_DELAY_MS = 5 * 1000;
const DEFAULT_WINDOW_MINUTES = 30;
const MAX_ALERTS_PER_SITE_PASS = 50;
const MAX_LOG_CORRELATIONS_PER_PASS = 25;

type CorrelatableAlert = {
  id: string;
  deviceId: string;
  triggeredAt: Date;
  ruleId: string | null;
  templateId: string | null;
  configPolicyId: string | null;
  configItemName: string | null;
  siteId: string | null;
};

type AlertCorrelationEvidenceType =
  | 'same_rule_temporal'
  | 'same_template_temporal'
  | 'same_config_policy_item_temporal'
  | 'same_site_temporal'
  | 'same_device_temporal';

type RecentLogCorrelation = {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: string;
  pattern: string;
  lastSeen: Date;
  occurrences: number;
  affectedDevices: LogCorrelationAffectedDevice[];
  sampleLogs: LogCorrelationSampleLog[] | null;
};

type AlertCorrelationLogEvidence = {
  evidenceType: 'shared_log_correlation' | 'related_log_correlation';
  logCorrelationIds: string[];
  logCorrelationRuleIds: string[];
  logCorrelationRuleNames: string[];
  logPatterns: string[];
  logOccurrences: number;
  logSeverity: string;
  logSampleLogIds: string[];
  logDeviceIds: string[];
};

export type AlertCorrelationJobData = {
  orgId: string;
  deviceId: string;
  queuedAt: string;
  windowMinutes?: number;
};

let alertCorrelationQueue: Queue<AlertCorrelationJobData> | null = null;
let alertCorrelationWorker: Worker<AlertCorrelationJobData> | null = null;

export function getAlertCorrelationQueue(): Queue<AlertCorrelationJobData> {
  if (!alertCorrelationQueue) {
    alertCorrelationQueue = new Queue<AlertCorrelationJobData>(ALERT_CORRELATION_QUEUE, {
      connection: getBullMQConnection(),
    });
  }
  return alertCorrelationQueue;
}

export function buildAlertCorrelationJobId(orgId: string, deviceId: string, now = Date.now()): string {
  const slot = Math.floor(now / DEDUPE_WINDOW_MS).toString(36);
  return ['alert-correlation', orgId, deviceId, slot].join('-');
}

export function buildAlertCorrelationEvidence(options: {
  older: CorrelatableAlert;
  newer: CorrelatableAlert;
  deviceId: string;
  timeDiffMs: number;
  maxWindowMs: number;
  logEvidence?: AlertCorrelationLogEvidence | null;
}): {
  correlationType: AlertCorrelationEvidenceType;
  confidence: number;
  metadata: Record<string, unknown>;
} {
  const baseConfidence = Math.round((1 - options.timeDiffMs / options.maxWindowMs) * 100) / 100;
  const sameDevice = options.older.deviceId === options.newer.deviceId;
  let correlationType: AlertCorrelationEvidenceType = sameDevice ? 'same_device_temporal' : 'same_site_temporal';
  let confidence = baseConfidence;
  const evidence: string[] = [sameDevice ? 'same_device' : 'same_site', 'time_window'];

  if (options.older.ruleId && options.older.ruleId === options.newer.ruleId) {
    correlationType = 'same_rule_temporal';
    confidence = Math.min(0.99, Math.round((confidence + 0.15) * 100) / 100);
    evidence.push('same_rule');
  } else if (options.older.templateId && options.older.templateId === options.newer.templateId) {
    correlationType = 'same_template_temporal';
    confidence = Math.min(0.99, Math.round((confidence + 0.1) * 100) / 100);
    evidence.push('same_template');
  } else if (
    options.older.configPolicyId &&
    options.older.configPolicyId === options.newer.configPolicyId &&
    options.older.configItemName &&
    options.older.configItemName === options.newer.configItemName
  ) {
    correlationType = 'same_config_policy_item_temporal';
    confidence = Math.min(0.99, Math.round((confidence + 0.1) * 100) / 100);
    evidence.push('same_config_policy_item');
  }

  if (options.logEvidence) {
    confidence = Math.min(
      0.99,
      Math.round((confidence + (options.logEvidence.evidenceType === 'shared_log_correlation' ? 0.1 : 0.05)) * 100) / 100
    );
    evidence.push(options.logEvidence.evidenceType);
  }

  const metadata: Record<string, unknown> = {
    timeDiffMinutes: Math.round(options.timeDiffMs / 60000),
    deviceId: options.deviceId,
    parentDeviceId: options.older.deviceId,
    childDeviceId: options.newer.deviceId,
    siteId: options.newer.siteId ?? options.older.siteId,
    ruleId: options.newer.ruleId ?? options.older.ruleId,
    templateId: options.newer.templateId ?? options.older.templateId,
    configPolicyId: options.newer.configPolicyId ?? options.older.configPolicyId,
    configItemName: options.newer.configItemName ?? options.older.configItemName,
    evidence,
  };

  if (options.logEvidence) {
    Object.assign(metadata, {
      logCorrelationIds: options.logEvidence.logCorrelationIds,
      logCorrelationRuleIds: options.logEvidence.logCorrelationRuleIds,
      logCorrelationRuleNames: options.logEvidence.logCorrelationRuleNames,
      logPatterns: options.logEvidence.logPatterns,
      logOccurrences: options.logEvidence.logOccurrences,
      logSeverity: options.logEvidence.logSeverity,
      logSampleLogIds: options.logEvidence.logSampleLogIds,
      logDeviceIds: options.logEvidence.logDeviceIds,
    });
  }

  return {
    correlationType,
    confidence,
    metadata,
  };
}

const severityRank: Record<string, number> = {
  info: 1,
  warning: 2,
  error: 3,
  critical: 4,
};

function addLimited(target: string[], value: string | null | undefined, max = 5): void {
  if (!value || target.includes(value) || target.length >= max) return;
  target.push(value);
}

function logCorrelationDeviceIds(correlation: RecentLogCorrelation): Set<string> {
  const deviceIds = new Set<string>();
  for (const device of Array.isArray(correlation.affectedDevices) ? correlation.affectedDevices : []) {
    if (device.deviceId) deviceIds.add(device.deviceId);
  }
  for (const log of Array.isArray(correlation.sampleLogs) ? correlation.sampleLogs : []) {
    if (log.deviceId) deviceIds.add(log.deviceId);
  }
  return deviceIds;
}

export function findAlertPairLogEvidence(options: {
  older: CorrelatableAlert;
  newer: CorrelatableAlert;
  logCorrelations: RecentLogCorrelation[];
}): AlertCorrelationLogEvidence | null {
  const logCorrelationIds: string[] = [];
  const logCorrelationRuleIds: string[] = [];
  const logCorrelationRuleNames: string[] = [];
  const logPatterns: string[] = [];
  const logSampleLogIds: string[] = [];
  const logDeviceIds: string[] = [];
  let logOccurrences = 0;
  let logSeverity = 'info';
  let hasSharedCorrelation = false;

  for (const correlation of options.logCorrelations) {
    const deviceIds = logCorrelationDeviceIds(correlation);
    const hasOlderDevice = deviceIds.has(options.older.deviceId);
    const hasNewerDevice = deviceIds.has(options.newer.deviceId);
    if (!hasOlderDevice && !hasNewerDevice) continue;

    addLimited(logCorrelationIds, correlation.id);
    addLimited(logCorrelationRuleIds, correlation.ruleId);
    addLimited(logCorrelationRuleNames, correlation.ruleName);
    addLimited(logPatterns, correlation.pattern);
    logOccurrences += correlation.occurrences;
    if ((severityRank[correlation.severity] ?? 0) > (severityRank[logSeverity] ?? 0)) {
      logSeverity = correlation.severity;
    }
    for (const deviceId of deviceIds) {
      if (deviceId === options.older.deviceId || deviceId === options.newer.deviceId) {
        addLimited(logDeviceIds, deviceId);
      }
    }
    for (const log of Array.isArray(correlation.sampleLogs) ? correlation.sampleLogs : []) {
      if (log.deviceId === options.older.deviceId || log.deviceId === options.newer.deviceId) {
        addLimited(logSampleLogIds, log.id);
      }
    }

    if (options.older.deviceId !== options.newer.deviceId && hasOlderDevice && hasNewerDevice) {
      hasSharedCorrelation = true;
    }
  }

  if (logCorrelationIds.length === 0) return null;

  return {
    evidenceType: hasSharedCorrelation ? 'shared_log_correlation' : 'related_log_correlation',
    logCorrelationIds,
    logCorrelationRuleIds,
    logCorrelationRuleNames,
    logPatterns,
    logOccurrences,
    logSeverity,
    logSampleLogIds,
    logDeviceIds,
  };
}

export async function enqueueAlertCorrelation(options: {
  orgId: string;
  deviceId: string;
  windowMinutes?: number;
}): Promise<string> {
  const queue = getAlertCorrelationQueue();
  const jobId = buildAlertCorrelationJobId(options.orgId, options.deviceId);

  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (isReusableState(state)) {
      return String(existing.id);
    }
    await existing.remove().catch((error) => {
      console.error(`[AlertCorrelationWorker] Failed to remove stale job ${jobId}:`, error);
    });
  }

  const job = await queue.add(
    'correlate-device-alerts',
    {
      orgId: options.orgId,
      deviceId: options.deviceId,
      windowMinutes: options.windowMinutes,
      queuedAt: new Date().toISOString(),
    },
    {
      jobId,
      delay: DEFAULT_DELAY_MS,
      removeOnComplete: true,
      removeOnFail: { count: 50 },
    }
  );

  return String(job.id);
}

export async function runAlertCorrelationForDevice(options: {
  orgId: string;
  deviceId: string;
  windowMinutes?: number;
}): Promise<{ scanned: number; created: number }> {
  if (!(await shouldProduceMlOutput(options.orgId, 'ml.alert_correlation.enabled'))) {
    return { scanned: 0, created: 0 };
  }

  const windowMinutes = options.windowMinutes ?? DEFAULT_WINDOW_MINUTES;
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - windowMinutes * 60 * 1000);
  const [targetDevice] = await db
    .select({ siteId: devices.siteId })
    .from(devices)
    .where(and(eq(devices.id, options.deviceId), eq(devices.orgId, options.orgId)))
    .limit(1);

  if (!targetDevice) {
    return { scanned: 0, created: 0 };
  }

  const recentAlerts = await db
    .select({
      id: alerts.id,
      deviceId: alerts.deviceId,
      triggeredAt: alerts.triggeredAt,
      ruleId: alerts.ruleId,
      templateId: alertRules.templateId,
      configPolicyId: alerts.configPolicyId,
      configItemName: alerts.configItemName,
      siteId: devices.siteId,
    })
    .from(alerts)
    .leftJoin(alertRules, eq(alerts.ruleId, alertRules.id))
    .innerJoin(devices, eq(alerts.deviceId, devices.id))
    .where(
      and(
        eq(alerts.orgId, options.orgId),
        eq(devices.siteId, targetDevice.siteId),
        gte(alerts.triggeredAt, windowStart),
        inArray(alerts.status, ['active', 'acknowledged'])
      )
    )
    .orderBy(desc(alerts.triggeredAt))
    .limit(MAX_ALERTS_PER_SITE_PASS);

  if (recentAlerts.length < 2) {
    return { scanned: recentAlerts.length, created: 0 };
  }

  const alertIds = recentAlerts.map((alert) => alert.id);
  const existingLinks = await db
    .select({
      parentAlertId: alertCorrelations.parentAlertId,
      childAlertId: alertCorrelations.childAlertId,
    })
    .from(alertCorrelations)
    .where(
      and(
        inArray(alertCorrelations.parentAlertId, alertIds),
        inArray(alertCorrelations.childAlertId, alertIds)
      )
    );

  const linkedPairs = new Set(
    existingLinks.map((link) => [link.parentAlertId, link.childAlertId].sort().join('|'))
  );

  const recentLogCorrelations = await db
    .select({
      id: logCorrelations.id,
      ruleId: logCorrelations.ruleId,
      ruleName: logCorrelationRules.name,
      severity: logCorrelationRules.severity,
      pattern: logCorrelations.pattern,
      lastSeen: logCorrelations.lastSeen,
      occurrences: logCorrelations.occurrences,
      affectedDevices: logCorrelations.affectedDevices,
      sampleLogs: logCorrelations.sampleLogs,
    })
    .from(logCorrelations)
    .innerJoin(logCorrelationRules, eq(logCorrelations.ruleId, logCorrelationRules.id))
    .where(
      and(
        eq(logCorrelations.orgId, options.orgId),
        eq(logCorrelations.status, 'active'),
        gte(logCorrelations.lastSeen, windowStart),
        lte(logCorrelations.firstSeen, windowEnd)
      )
    )
    .orderBy(desc(logCorrelations.lastSeen))
    .limit(MAX_LOG_CORRELATIONS_PER_PASS);

  let created = 0;
  const maxWindowMs = windowMinutes * 60 * 1000;
  for (let i = 0; i < recentAlerts.length; i += 1) {
    for (let j = i + 1; j < recentAlerts.length; j += 1) {
      const newer = recentAlerts[i]!;
      const older = recentAlerts[j]!;
      const pairKey = [newer.id, older.id].sort().join('|');
      if (linkedPairs.has(pairKey)) continue;

      const timeDiffMs = Math.abs(newer.triggeredAt.getTime() - older.triggeredAt.getTime());
      const evidence = buildAlertCorrelationEvidence({
        older,
        newer,
        deviceId: options.deviceId,
        timeDiffMs,
        maxWindowMs,
        logEvidence: findAlertPairLogEvidence({ older, newer, logCorrelations: recentLogCorrelations }),
      });
      const confidence = evidence.confidence;
      if (confidence < 0.3) continue;

      await db
        .insert(alertCorrelations)
        .values({
          parentAlertId: older.id,
          childAlertId: newer.id,
          correlationType: evidence.correlationType,
          confidence: String(confidence),
          metadata: evidence.metadata,
        });

      linkedPairs.add(pairKey);
      created += 1;
    }
  }

  await persistAlertCorrelationGroupsForAlerts({
    orgId: options.orgId,
    alertIds,
  });

  return { scanned: recentAlerts.length, created };
}

export function createAlertCorrelationWorker(): Worker<AlertCorrelationJobData> {
  return new Worker<AlertCorrelationJobData>(
    ALERT_CORRELATION_QUEUE,
    async (job: Job<AlertCorrelationJobData>) =>
      withSystemDbAccessContext(() => runAlertCorrelationForDevice(job.data)),
    {
      connection: getBullMQConnection(),
      concurrency: 2,
    }
  );
}

export async function initializeAlertCorrelationWorker(): Promise<void> {
  alertCorrelationWorker = createAlertCorrelationWorker();
  attachWorkerObservability(alertCorrelationWorker, 'alertCorrelationWorker');
  alertCorrelationWorker.on('error', (error) => {
    console.error('[AlertCorrelationWorker] Worker error:', error);
  });
  alertCorrelationWorker.on('failed', (job, error) => {
    console.error(`[AlertCorrelationWorker] Job ${job?.id} failed:`, error);
  });
}

export async function shutdownAlertCorrelationWorker(): Promise<void> {
  if (alertCorrelationWorker) {
    await alertCorrelationWorker.close();
    alertCorrelationWorker = null;
  }
  if (alertCorrelationQueue) {
    await alertCorrelationQueue.close();
    alertCorrelationQueue = null;
  }
}
