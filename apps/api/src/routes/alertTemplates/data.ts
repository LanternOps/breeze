import { randomUUID } from 'crypto';
import type { AlertTemplate, AlertRule, CorrelationAlert, CorrelationLink, CorrelationGroup } from './schemas';

const now = new Date();
const lastHour = new Date(now.getTime() - 60 * 60 * 1000);
const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

const orgAlphaId = randomUUID();
const orgBetaId = randomUUID();
const dbDeviceId = randomUUID();
const appDeviceId = randomUUID();
const webDeviceId = randomUUID();
const backupDeviceId = randomUUID();
const hqSiteId = randomUUID();
const euSiteId = randomUUID();

const cpuTemplateId = randomUUID();
const diskTemplateId = randomUUID();
const serviceTemplateId = randomUUID();
const memoryTemplateId = randomUUID();
const latencyTemplateId = randomUUID();

export const builtInTemplates: AlertTemplate[] = [
  {
    id: cpuTemplateId,
    name: 'CPU High',
    description: 'CPU usage over 90% for 5 minutes',
    category: 'Performance',
    severity: 'high',
    builtIn: true,
    conditions: {
      metric: 'cpu.usage',
      operator: '>',
      threshold: 90,
      durationMinutes: 5
    },
    targets: {
      scope: 'tag',
      tags: ['production']
    },
    defaultCooldownMinutes: 15,
    createdAt: lastWeek,
    updatedAt: lastWeek
  },
  {
    id: diskTemplateId,
    name: 'Disk Space Low',
    description: 'Disk free space under 10% for 10 minutes',
    category: 'Capacity',
    severity: 'high',
    builtIn: true,
    conditions: {
      metric: 'disk.freePercent',
      operator: '<',
      threshold: 10,
      durationMinutes: 10
    },
    targets: {
      scope: 'site',
      siteIds: [hqSiteId]
    },
    defaultCooldownMinutes: 30,
    createdAt: lastWeek,
    updatedAt: lastWeek
  },
  {
    id: serviceTemplateId,
    name: 'Service Stopped',
    description: 'Critical service is stopped or not responding',
    category: 'Availability',
    severity: 'critical',
    builtIn: true,
    conditions: {
      metric: 'service.status',
      operator: 'equals',
      threshold: 'stopped',
      serviceName: 'nginx',
      durationMinutes: 1
    },
    targets: {
      scope: 'tag',
      tags: ['web']
    },
    defaultCooldownMinutes: 5,
    createdAt: lastWeek,
    updatedAt: lastWeek
  },
  {
    id: memoryTemplateId,
    name: 'Memory Pressure',
    description: 'Available memory below 15% for 5 minutes',
    category: 'Performance',
    severity: 'medium',
    builtIn: true,
    conditions: {
      metric: 'memory.availablePercent',
      operator: '<',
      threshold: 15,
      durationMinutes: 5
    },
    targets: {
      scope: 'tag',
      tags: ['database']
    },
    defaultCooldownMinutes: 15,
    createdAt: lastWeek,
    updatedAt: lastWeek
  },
  {
    id: latencyTemplateId,
    name: 'Network Latency High',
    description: 'Latency over 200ms for 3 minutes',
    category: 'Network',
    severity: 'medium',
    builtIn: true,
    conditions: {
      metric: 'network.latencyMs',
      operator: '>',
      threshold: 200,
      durationMinutes: 3
    },
    targets: {
      scope: 'site',
      siteIds: [euSiteId]
    },
    defaultCooldownMinutes: 10,
    createdAt: lastWeek,
    updatedAt: lastWeek
  }
];

export const customTemplates = new Map<string, AlertTemplate>();

const dbConnectionsTemplateId = randomUUID();
const backupFailureTemplateId = randomUUID();

customTemplates.set(dbConnectionsTemplateId, {
  id: dbConnectionsTemplateId,
  name: 'DB Connections Spike',
  description: 'Connections exceed expected concurrency',
  category: 'Database',
  severity: 'high',
  builtIn: false,
  conditions: {
    metric: 'db.connections',
    operator: '>',
    threshold: 800,
    durationMinutes: 5
  },
  targets: {
    scope: 'tag',
    tags: ['database', 'production']
  },
  defaultCooldownMinutes: 20,
  createdAt: yesterday,
  updatedAt: yesterday
});

customTemplates.set(backupFailureTemplateId, {
  id: backupFailureTemplateId,
  name: 'Backup Job Failed',
  description: 'Backup job reports a failure status',
  category: 'Backup',
  severity: 'critical',
  builtIn: false,
  conditions: {
    metric: 'backup.status',
    operator: 'equals',
    threshold: 'failed',
    durationMinutes: 0
  },
  targets: {
    scope: 'device',
    deviceIds: [backupDeviceId]
  },
  defaultCooldownMinutes: 60,
  createdAt: yesterday,
  updatedAt: yesterday
});

export const customTemplateOrgById = new Map<string, string>([
  [dbConnectionsTemplateId, orgAlphaId],
  [backupFailureTemplateId, orgAlphaId]
]);

export const alertRules = new Map<string, AlertRule>();

const cpuDbRuleId = randomUUID();
const memoryDbRuleId = randomUUID();
const diskHqRuleId = randomUUID();
const webServiceRuleId = randomUUID();
const backupRuleId = randomUUID();

alertRules.set(cpuDbRuleId, {
  id: cpuDbRuleId,
  orgId: orgAlphaId,
  name: 'DB Cluster CPU Spike',
  description: 'Detect sustained CPU spikes on production DB nodes',
  templateId: cpuTemplateId,
  templateName: 'CPU High',
  severity: 'high',
  enabled: true,
  targets: {
    scope: 'tag',
    tags: ['database', 'production']
  },
  conditions: {
    metric: 'cpu.usage',
    operator: '>',
    threshold: 92,
    durationMinutes: 5
  },
  cooldownMinutes: 20,
  createdAt: lastWeek,
  updatedAt: yesterday,
  lastTriggeredAt: lastHour
});

alertRules.set(memoryDbRuleId, {
  id: memoryDbRuleId,
  orgId: orgAlphaId,
  name: 'DB Memory Pressure',
  description: 'Detect memory pressure on production DB nodes',
  templateId: memoryTemplateId,
  templateName: 'Memory Pressure',
  severity: 'medium',
  enabled: true,
  targets: {
    scope: 'tag',
    tags: ['database', 'production']
  },
  conditions: {
    metric: 'memory.availablePercent',
    operator: '<',
    threshold: 15,
    durationMinutes: 5
  },
  cooldownMinutes: 15,
  createdAt: lastWeek,
  updatedAt: yesterday,
  lastTriggeredAt: lastHour
});

alertRules.set(diskHqRuleId, {
  id: diskHqRuleId,
  orgId: orgAlphaId,
  name: 'HQ Disk Capacity',
  description: 'Warn when HQ endpoints hit low disk space',
  templateId: diskTemplateId,
  templateName: 'Disk Space Low',
  severity: 'high',
  enabled: true,
  targets: {
    scope: 'site',
    siteIds: [hqSiteId]
  },
  conditions: {
    metric: 'disk.freePercent',
    operator: '<',
    threshold: 12,
    durationMinutes: 15
  },
  cooldownMinutes: 45,
  createdAt: lastWeek,
  updatedAt: lastWeek,
  lastTriggeredAt: null
});

alertRules.set(webServiceRuleId, {
  id: webServiceRuleId,
  orgId: orgBetaId,
  name: 'Web Tier Service Health',
  description: 'Ensure nginx stays online on web tier servers',
  templateId: serviceTemplateId,
  templateName: 'Service Stopped',
  severity: 'critical',
  enabled: false,
  targets: {
    scope: 'device',
    deviceIds: [webDeviceId, appDeviceId]
  },
  conditions: {
    metric: 'service.status',
    operator: 'equals',
    threshold: 'stopped',
    serviceName: 'nginx',
    durationMinutes: 1
  },
  cooldownMinutes: 5,
  createdAt: lastWeek,
  updatedAt: yesterday,
  lastTriggeredAt: yesterday
});

alertRules.set(backupRuleId, {
  id: backupRuleId,
  orgId: orgAlphaId,
  name: 'Nightly Backup Failures',
  description: 'Alert when nightly backups fail to complete',
  templateId: backupFailureTemplateId,
  templateName: 'Backup Job Failed',
  severity: 'critical',
  enabled: true,
  targets: {
    scope: 'device',
    deviceIds: [backupDeviceId]
  },
  conditions: {
    metric: 'backup.status',
    operator: 'equals',
    threshold: 'failed',
    durationMinutes: 0
  },
  cooldownMinutes: 90,
  createdAt: yesterday,
  updatedAt: yesterday,
  lastTriggeredAt: lastHour
});

const alertCpuId = randomUUID();
const alertMemoryId = randomUUID();
const alertDiskId = randomUUID();
const alertServiceId = randomUUID();
const alertLatencyId = randomUUID();
const alertBackupId = randomUUID();

export const correlationAlerts: CorrelationAlert[] = [
  {
    id: alertCpuId,
    ruleId: cpuDbRuleId,
    templateId: cpuTemplateId,
    severity: 'high',
    message: 'CPU usage 94% on db-01',
    deviceId: dbDeviceId,
    occurredAt: lastHour
  },
  {
    id: alertMemoryId,
    ruleId: memoryDbRuleId,
    templateId: memoryTemplateId,
    severity: 'medium',
    message: 'Memory available 11% on db-01',
    deviceId: dbDeviceId,
    occurredAt: new Date(lastHour.getTime() + 5 * 60 * 1000)
  },
  {
    id: alertDiskId,
    ruleId: diskHqRuleId,
    templateId: diskTemplateId,
    severity: 'high',
    message: 'Disk free 8% on db-01',
    deviceId: dbDeviceId,
    occurredAt: new Date(lastHour.getTime() + 9 * 60 * 1000)
  },
  {
    id: alertServiceId,
    ruleId: webServiceRuleId,
    templateId: serviceTemplateId,
    severity: 'critical',
    message: 'nginx stopped on web-02',
    deviceId: webDeviceId,
    occurredAt: yesterday
  },
  {
    id: alertLatencyId,
    ruleId: webServiceRuleId,
    templateId: latencyTemplateId,
    severity: 'medium',
    message: 'Latency 280ms from EU edge',
    deviceId: webDeviceId,
    occurredAt: new Date(yesterday.getTime() + 15 * 60 * 1000)
  },
  {
    id: alertBackupId,
    ruleId: backupRuleId,
    templateId: backupFailureTemplateId,
    severity: 'critical',
    message: 'Nightly backup failed on backup-01',
    deviceId: backupDeviceId,
    occurredAt: new Date(yesterday.getTime() + 45 * 60 * 1000)
  }
];

export const correlationLinks: CorrelationLink[] = [
  {
    id: randomUUID(),
    alertId: alertCpuId,
    relatedAlertId: alertMemoryId,
    reason: 'Same host and time window',
    confidence: 0.86,
    createdAt: lastHour
  },
  {
    id: randomUUID(),
    alertId: alertCpuId,
    relatedAlertId: alertDiskId,
    reason: 'I/O contention on db-01',
    confidence: 0.72,
    createdAt: lastHour
  },
  {
    id: randomUUID(),
    alertId: alertServiceId,
    relatedAlertId: alertLatencyId,
    reason: 'Edge latency spike preceding service stop',
    confidence: 0.81,
    createdAt: yesterday
  },
  {
    id: randomUUID(),
    alertId: alertBackupId,
    relatedAlertId: alertDiskId,
    reason: 'Shared storage volume reached low capacity',
    confidence: 0.64,
    createdAt: yesterday
  }
];

const getCorrelationAlertsByIndex = (indices: number[]): CorrelationAlert[] =>
  indices
    .map((index) => correlationAlerts[index])
    .filter((alert): alert is CorrelationAlert => Boolean(alert));

export const correlationGroups: CorrelationGroup[] = [
  {
    id: randomUUID(),
    title: 'Database Host Saturation',
    summary: 'CPU, memory, and disk alerts clustered around db-01 performance.',
    correlationScore: 0.84,
    rootCauseHint: 'Burst workload on db-01 during reporting window',
    alerts: getCorrelationAlertsByIndex([0, 1, 2]),
    createdAt: lastHour
  },
  {
    id: randomUUID(),
    title: 'Web Stack Instability',
    summary: 'Latency spike followed by nginx service stop on web-02.',
    correlationScore: 0.78,
    rootCauseHint: 'Possible upstream network degradation in EU region',
    alerts: getCorrelationAlertsByIndex([3, 4]),
    createdAt: yesterday
  },
  {
    id: randomUUID(),
    title: 'Backup Pipeline Failure',
    summary: 'Backup failure correlated with low disk capacity.',
    correlationScore: 0.62,
    rootCauseHint: 'Backup target volume nearly full',
    alerts: getCorrelationAlertsByIndex([5, 2]),
    createdAt: yesterday
  }
];
