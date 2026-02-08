import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { authMiddleware, requireScope } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';

export const alertTemplateRoutes = new Hono();

type AlertSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

type AlertTemplateTarget = {
  scope: 'device' | 'site' | 'organization' | 'tag';
  deviceIds?: string[];
  siteIds?: string[];
  tags?: string[];
  orgId?: string;
};

type AlertTemplate = {
  id: string;
  name: string;
  description?: string;
  category: string;
  severity: AlertSeverity;
  builtIn: boolean;
  conditions: Record<string, unknown>;
  targets: AlertTemplateTarget;
  defaultCooldownMinutes: number;
  createdAt: Date;
  updatedAt: Date;
};

type AlertRule = {
  id: string;
  orgId: string | null;
  name: string;
  description?: string;
  templateId: string;
  templateName: string;
  severity: AlertSeverity;
  enabled: boolean;
  targets: AlertTemplateTarget;
  conditions: Record<string, unknown>;
  cooldownMinutes: number;
  createdAt: Date;
  updatedAt: Date;
  lastTriggeredAt: Date | null;
};

type CorrelationAlert = {
  id: string;
  ruleId: string;
  templateId: string;
  severity: AlertSeverity;
  message: string;
  deviceId: string;
  occurredAt: Date;
};

type CorrelationLink = {
  id: string;
  alertId: string;
  relatedAlertId: string;
  reason: string;
  confidence: number;
  createdAt: Date;
};

type CorrelationGroup = {
  id: string;
  title: string;
  summary: string;
  correlationScore: number;
  rootCauseHint: string | null;
  alerts: CorrelationAlert[];
  createdAt: Date;
};

// ============================================
// MOCK DATA
// ============================================

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

const builtInTemplates: AlertTemplate[] = [
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

const customTemplates = new Map<string, AlertTemplate>();

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

const customTemplateOrgById = new Map<string, string>([
  [dbConnectionsTemplateId, orgAlphaId],
  [backupFailureTemplateId, orgAlphaId]
]);

const alertRules = new Map<string, AlertRule>();

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

const correlationAlerts: CorrelationAlert[] = [
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

const correlationLinks: CorrelationLink[] = [
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

const correlationGroups: CorrelationGroup[] = [
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

// ============================================
// Helper functions
// ============================================

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

function paginate<T>(items: T[], query: { page?: string; limit?: string }) {
  const { page, limit, offset } = getPagination(query);
  return {
    data: items.slice(offset, offset + limit),
    page,
    limit,
    total: items.length
  };
}

function parseBoolean(value?: string) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function resolveScopedOrgId(
  auth: {
    scope: 'system' | 'partner' | 'organization';
    orgId?: string | null;
    accessibleOrgIds?: string[] | null;
  }
) {
  if (auth.orgId) {
    return auth.orgId;
  }

  if (auth.scope === 'partner' && Array.isArray(auth.accessibleOrgIds) && auth.accessibleOrgIds.length === 1) {
    return auth.accessibleOrgIds[0] ?? null;
  }

  return null;
}

function getAllTemplates(orgId: string) {
  return [
    ...builtInTemplates,
    ...[...customTemplates.values()].filter((template) => customTemplateOrgById.get(template.id) === orgId)
  ];
}

function getTemplateById(templateId: string, orgId: string) {
  const builtIn = builtInTemplates.find((template) => template.id === templateId);
  if (builtIn) {
    return builtIn;
  }

  const customTemplate = customTemplates.get(templateId);
  if (!customTemplate) {
    return null;
  }

  if (customTemplateOrgById.get(templateId) !== orgId) {
    return null;
  }

  return customTemplate;
}

function getRuleForOrg(ruleId: string, orgId: string) {
  const rule = alertRules.get(ruleId);
  if (!rule || rule.orgId !== orgId) {
    return null;
  }
  return rule;
}

function getScopedCorrelationAlerts(orgId: string) {
  return correlationAlerts.filter((alert) => {
    const rule = alertRules.get(alert.ruleId);
    return rule?.orgId === orgId;
  });
}

function isBuiltInTemplate(templateId: string) {
  return builtInTemplates.some((template) => template.id === templateId);
}

function matchesTargetFilter(rule: AlertRule, targetType?: string, targetValue?: string) {
  if (!targetType) return true;

  const targets = rule.targets;
  if (targetType === 'tag') {
    return Boolean(targetValue && targets.tags?.includes(targetValue));
  }

  if (targetType === 'device') {
    return Boolean(targetValue && targets.deviceIds?.includes(targetValue));
  }

  if (targetType === 'site') {
    return Boolean(targetValue && targets.siteIds?.includes(targetValue));
  }

  if (targetType === 'organization') {
    if (!targetValue) {
      return targets.scope === 'organization';
    }
    return targets.orgId === targetValue;
  }

  return true;
}

function getCorrelationLinksForAlert(alertId: string) {
  return correlationLinks.filter(
    (link) => link.alertId === alertId || link.relatedAlertId === alertId
  );
}

function getRelatedAlerts(alertId: string) {
  const relatedIds = new Set<string>();
  for (const link of getCorrelationLinksForAlert(alertId)) {
    relatedIds.add(link.alertId === alertId ? link.relatedAlertId : link.alertId);
  }
  return correlationAlerts.filter((alert) => relatedIds.has(alert.id));
}

function getCorrelationGroupsForAlert(alertId: string) {
  return correlationGroups.filter((group) =>
    group.alerts.some((alert) => alert.id === alertId)
  );
}

// ============================================
// Validation schemas
// ============================================

const severitySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);

const listTemplatesSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  builtIn: z.enum(['true', 'false']).optional(),
  severity: severitySchema.optional(),
  search: z.string().optional()
});

const createTemplateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  category: z.string().min(1).max(100).optional(),
  severity: severitySchema,
  conditions: z.record(z.any()).optional().default({}),
  targets: z.record(z.any()).optional(),
  defaultCooldownMinutes: z.number().int().min(0).max(10080).optional()
});

const updateTemplateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  category: z.string().min(1).max(100).optional(),
  severity: severitySchema.optional(),
  conditions: z.record(z.any()).optional(),
  targets: z.record(z.any()).optional(),
  defaultCooldownMinutes: z.number().int().min(0).max(10080).optional()
});

const listRulesSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  orgId: z.string().uuid().optional(),
  enabled: z.enum(['true', 'false']).optional(),
  severity: severitySchema.optional(),
  templateId: z.string().uuid().optional(),
  targetType: z.enum(['device', 'site', 'organization', 'tag']).optional(),
  targetValue: z.string().optional(),
  search: z.string().optional()
});

const createRuleSchema = z.object({
  orgId: z.string().uuid().optional(),
  templateId: z.string().uuid(),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  enabled: z.boolean().optional().default(true),
  severity: severitySchema.optional(),
  targets: z.record(z.any()).optional(),
  conditions: z.record(z.any()).optional(),
  cooldownMinutes: z.number().int().min(0).max(10080).optional()
});

const updateRuleSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  enabled: z.boolean().optional(),
  severity: severitySchema.optional(),
  targets: z.record(z.any()).optional(),
  conditions: z.record(z.any()).optional(),
  cooldownMinutes: z.number().int().min(0).max(10080).optional()
});

const toggleRuleSchema = z.object({
  enabled: z.boolean()
});

const listCorrelationsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  alertId: z.string().uuid().optional(),
  minConfidence: z.string().optional()
});

const analyzeCorrelationsSchema = z.object({
  alertIds: z.array(z.string().uuid()).optional(),
  windowMinutes: z.number().int().min(5).max(1440).optional()
});

alertTemplateRoutes.use('*', authMiddleware);

// ============================================
// TEMPLATE ROUTES
// ============================================

alertTemplateRoutes.get(
  '/templates',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listTemplatesSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const query = c.req.valid('query');
      let data = getAllTemplates(orgId);

      if (query.builtIn) {
        const builtInFlag = parseBoolean(query.builtIn);
        if (builtInFlag !== undefined) {
          data = data.filter((template) => template.builtIn === builtInFlag);
        }
      }

      if (query.severity) {
        data = data.filter((template) => template.severity === query.severity);
      }

      if (query.search) {
        const search = query.search.toLowerCase();
        data = data.filter((template) =>
          template.name.toLowerCase().includes(search) ||
          (template.description ?? '').toLowerCase().includes(search)
        );
      }

      const result = paginate(data, query);
      return c.json(result);
    } catch {
      return c.json({ error: 'Failed to list templates' }, 500);
    }
  }
);

alertTemplateRoutes.get(
  '/templates/built-in',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listTemplatesSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const query = c.req.valid('query');
      let data = builtInTemplates;

      if (query.severity) {
        data = data.filter((template) => template.severity === query.severity);
      }

      if (query.search) {
        const search = query.search.toLowerCase();
        data = data.filter((template) =>
          template.name.toLowerCase().includes(search) ||
          (template.description ?? '').toLowerCase().includes(search)
        );
      }

      const result = paginate(data, query);
      return c.json(result);
    } catch {
      return c.json({ error: 'Failed to list built-in templates' }, 500);
    }
  }
);

alertTemplateRoutes.post(
  '/templates',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createTemplateSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const data = c.req.valid('json');
      const targets: AlertTemplateTarget = data.targets && Object.keys(data.targets).length > 0
        ? data.targets as AlertTemplateTarget
        : { scope: 'organization' };
      const template: AlertTemplate = {
        id: randomUUID(),
        name: data.name.trim(),
        description: data.description,
        category: data.category ?? 'Custom',
        severity: data.severity,
        builtIn: false,
        conditions: data.conditions ?? {},
        targets,
        defaultCooldownMinutes: data.defaultCooldownMinutes ?? 15,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      customTemplates.set(template.id, template);
      customTemplateOrgById.set(template.id, orgId);
      writeRouteAudit(c, {
        orgId,
        action: 'alert_template.create',
        resourceType: 'alert_template',
        resourceId: template.id,
        resourceName: template.name,
        details: {
          category: template.category,
          severity: template.severity,
        },
      });
      return c.json({ data: template }, 201);
    } catch {
      return c.json({ error: 'Failed to create template' }, 500);
    }
  }
);

alertTemplateRoutes.get(
  '/templates/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const templateId = c.req.param('id');
      const template = getTemplateById(templateId, orgId);

      if (!template) {
        return c.json({ error: 'Template not found' }, 404);
      }

      return c.json({ data: template });
    } catch {
      return c.json({ error: 'Failed to fetch template' }, 500);
    }
  }
);

alertTemplateRoutes.patch(
  '/templates/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateTemplateSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const templateId = c.req.param('id');
      const updates = c.req.valid('json');

      if (isBuiltInTemplate(templateId)) {
        return c.json({ error: 'Built-in templates cannot be modified' }, 403);
      }

      const existing = customTemplates.get(templateId);
      if (customTemplateOrgById.get(templateId) !== orgId) {
        return c.json({ error: 'Template not found' }, 404);
      }
      if (!existing) {
        return c.json({ error: 'Template not found' }, 404);
      }

      if (Object.keys(updates).length === 0) {
        return c.json({ error: 'No updates provided' }, 400);
      }

      const updated: AlertTemplate = {
        ...existing,
        name: updates.name?.trim() ?? existing.name,
        description: updates.description ?? existing.description,
        category: updates.category ?? existing.category,
        severity: updates.severity ?? existing.severity,
        conditions: updates.conditions ?? existing.conditions,
        targets: (updates.targets as AlertTemplateTarget | undefined) ?? existing.targets,
        defaultCooldownMinutes: updates.defaultCooldownMinutes ?? existing.defaultCooldownMinutes,
        updatedAt: new Date()
      };

      customTemplates.set(templateId, updated);
      writeRouteAudit(c, {
        orgId,
        action: 'alert_template.update',
        resourceType: 'alert_template',
        resourceId: updated.id,
        resourceName: updated.name,
        details: {
          updatedFields: Object.keys(updates),
        },
      });
      return c.json({ data: updated });
    } catch {
      return c.json({ error: 'Failed to update template' }, 500);
    }
  }
);

alertTemplateRoutes.delete(
  '/templates/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const templateId = c.req.param('id');

      if (isBuiltInTemplate(templateId)) {
        return c.json({ error: 'Built-in templates cannot be deleted' }, 403);
      }

      const existing = customTemplates.get(templateId);
      if (customTemplateOrgById.get(templateId) !== orgId) {
        return c.json({ error: 'Template not found' }, 404);
      }
      if (!existing) {
        return c.json({ error: 'Template not found' }, 404);
      }

      customTemplates.delete(templateId);
      customTemplateOrgById.delete(templateId);
      writeRouteAudit(c, {
        orgId,
        action: 'alert_template.delete',
        resourceType: 'alert_template',
        resourceId: existing.id,
        resourceName: existing.name,
      });
      return c.json({ data: { id: templateId, deleted: true } });
    } catch {
      return c.json({ error: 'Failed to delete template' }, 500);
    }
  }
);

// ============================================
// RULE ROUTES
// ============================================

alertTemplateRoutes.get(
  '/rules',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listRulesSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const query = c.req.valid('query');
      if (query.orgId && query.orgId !== orgId) {
        return c.json({ error: 'Forbidden' }, 403);
      }

      let data = Array.from(alertRules.values()).filter((rule) => rule.orgId === orgId);

      if (query.orgId) {
        data = data.filter((rule) => rule.orgId === query.orgId);
      }

      const enabled = parseBoolean(query.enabled);
      if (enabled !== undefined) {
        data = data.filter((rule) => rule.enabled === enabled);
      }

      if (query.severity) {
        data = data.filter((rule) => rule.severity === query.severity);
      }

      if (query.templateId) {
        data = data.filter((rule) => rule.templateId === query.templateId);
      }

      if (query.search) {
        const search = query.search.toLowerCase();
        data = data.filter((rule) =>
          rule.name.toLowerCase().includes(search) ||
          (rule.description ?? '').toLowerCase().includes(search)
        );
      }

      data = data.filter((rule) => matchesTargetFilter(rule, query.targetType, query.targetValue));

      const result = paginate(data, query);
      return c.json(result);
    } catch {
      return c.json({ error: 'Failed to list rules' }, 500);
    }
  }
);

alertTemplateRoutes.post(
  '/rules',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', createRuleSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const data = c.req.valid('json');
      if (data.orgId && data.orgId !== orgId) {
        return c.json({ error: 'Forbidden' }, 403);
      }

      const template = getTemplateById(data.templateId, orgId);

      if (!template) {
        return c.json({ error: 'Template not found' }, 404);
      }

      const rule: AlertRule = {
        id: randomUUID(),
        orgId,
        name: data.name.trim(),
        description: data.description,
        templateId: template.id,
        templateName: template.name,
        severity: data.severity ?? template.severity,
        enabled: data.enabled ?? true,
        targets: (data.targets as AlertTemplateTarget) ?? template.targets,
        conditions: data.conditions ?? template.conditions,
        cooldownMinutes: data.cooldownMinutes ?? template.defaultCooldownMinutes,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastTriggeredAt: null
      };

      alertRules.set(rule.id, rule);
      writeRouteAudit(c, {
        orgId,
        action: 'alert_rule.create',
        resourceType: 'alert_rule',
        resourceId: rule.id,
        resourceName: rule.name,
        details: {
          templateId: rule.templateId,
          enabled: rule.enabled,
          severity: rule.severity,
        },
      });
      return c.json({ data: rule }, 201);
    } catch {
      return c.json({ error: 'Failed to create rule' }, 500);
    }
  }
);

alertTemplateRoutes.get(
  '/rules/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const ruleId = c.req.param('id');
      const rule = getRuleForOrg(ruleId, orgId);

      if (!rule) {
        return c.json({ error: 'Rule not found' }, 404);
      }

      return c.json({ data: rule });
    } catch {
      return c.json({ error: 'Failed to fetch rule' }, 500);
    }
  }
);

alertTemplateRoutes.patch(
  '/rules/:id',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', updateRuleSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const ruleId = c.req.param('id');
      const updates = c.req.valid('json');
      const existing = getRuleForOrg(ruleId, orgId);

      if (!existing) {
        return c.json({ error: 'Rule not found' }, 404);
      }

      if (Object.keys(updates).length === 0) {
        return c.json({ error: 'No updates provided' }, 400);
      }

      const updated: AlertRule = {
        ...existing,
        ...updates,
        name: updates.name?.trim() ?? existing.name,
        targets: (updates.targets as AlertTemplateTarget) ?? existing.targets,
        updatedAt: new Date()
      };

      alertRules.set(ruleId, updated);
      writeRouteAudit(c, {
        orgId,
        action: 'alert_rule.update',
        resourceType: 'alert_rule',
        resourceId: updated.id,
        resourceName: updated.name,
        details: {
          updatedFields: Object.keys(updates),
        },
      });
      return c.json({ data: updated });
    } catch {
      return c.json({ error: 'Failed to update rule' }, 500);
    }
  }
);

alertTemplateRoutes.delete(
  '/rules/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const ruleId = c.req.param('id');
      const existing = getRuleForOrg(ruleId, orgId);

      if (!existing) {
        return c.json({ error: 'Rule not found' }, 404);
      }

      alertRules.delete(ruleId);
      writeRouteAudit(c, {
        orgId,
        action: 'alert_rule.delete',
        resourceType: 'alert_rule',
        resourceId: existing.id,
        resourceName: existing.name,
      });
      return c.json({ data: { id: ruleId, deleted: true } });
    } catch {
      return c.json({ error: 'Failed to delete rule' }, 500);
    }
  }
);

alertTemplateRoutes.post(
  '/rules/:id/toggle',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', toggleRuleSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const ruleId = c.req.param('id');
      const { enabled } = c.req.valid('json');
      const existing = getRuleForOrg(ruleId, orgId);

      if (!existing) {
        return c.json({ error: 'Rule not found' }, 404);
      }

      const updated: AlertRule = {
        ...existing,
        enabled,
        updatedAt: new Date()
      };

      alertRules.set(ruleId, updated);
      writeRouteAudit(c, {
        orgId,
        action: 'alert_rule.toggle',
        resourceType: 'alert_rule',
        resourceId: updated.id,
        resourceName: updated.name,
        details: {
          enabled,
        },
      });
      return c.json({ data: updated });
    } catch {
      return c.json({ error: 'Failed to toggle rule' }, 500);
    }
  }
);

// ============================================
// CORRELATION ROUTES
// ============================================

alertTemplateRoutes.get(
  '/correlations',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', listCorrelationsSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const scopedAlerts = getScopedCorrelationAlerts(orgId);
      const scopedAlertIds = new Set(scopedAlerts.map((alert) => alert.id));
      const query = c.req.valid('query');
      let data = correlationLinks.filter(
        (link) => scopedAlertIds.has(link.alertId) && scopedAlertIds.has(link.relatedAlertId)
      );

      if (query.alertId) {
        data = data.filter(
          (link) => link.alertId === query.alertId || link.relatedAlertId === query.alertId
        );
      }

      if (query.minConfidence) {
        const minConfidence = Number.parseFloat(query.minConfidence);
        if (!Number.isNaN(minConfidence)) {
          data = data.filter((link) => link.confidence >= minConfidence);
        }
      }

      const result = paginate(data, query);
      return c.json(result);
    } catch {
      return c.json({ error: 'Failed to list correlations' }, 500);
    }
  }
);

alertTemplateRoutes.get(
  '/correlations/groups',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const scopedAlertIds = new Set(getScopedCorrelationAlerts(orgId).map((alert) => alert.id));
      const groups = correlationGroups
        .map((group) => ({
          ...group,
          alerts: group.alerts.filter((alert) => scopedAlertIds.has(alert.id))
        }))
        .filter((group) => group.alerts.length > 0);
      return c.json({ data: groups });
    } catch {
      return c.json({ error: 'Failed to list correlation groups' }, 500);
    }
  }
);

alertTemplateRoutes.post(
  '/correlations/analyze',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', analyzeCorrelationsSchema),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const scopedAlerts = getScopedCorrelationAlerts(orgId);
      const scopedAlertIds = new Set(scopedAlerts.map((alert) => alert.id));
      const data = c.req.valid('json');
      const alertIds = (data.alertIds ?? []).filter((alertId) => scopedAlertIds.has(alertId));
      const windowMinutes = data.windowMinutes ?? 60;

      const baseGroups = correlationGroups
        .map((group) => ({
          ...group,
          alerts: group.alerts.filter((alert) => scopedAlertIds.has(alert.id))
        }))
        .filter((group) => group.alerts.length > 0);
      const groups = alertIds.length
        ? baseGroups.filter((group) => group.alerts.some((alert) => alertIds.includes(alert.id)))
        : baseGroups;

      const scopedLinks = correlationLinks.filter(
        (link) => scopedAlertIds.has(link.alertId) && scopedAlertIds.has(link.relatedAlertId)
      );
      const links = alertIds.length
        ? scopedLinks.filter(
          (link) => alertIds.includes(link.alertId) || alertIds.includes(link.relatedAlertId)
        )
        : scopedLinks;

      writeRouteAudit(c, {
        orgId,
        action: 'alert_correlation.analyze',
        resourceType: 'alert_correlation',
        details: {
          requestedAlertCount: alertIds.length,
          groupCount: groups.length,
          linkCount: links.length,
          windowMinutes,
        },
      });

      return c.json({
        data: {
          requestedAlertIds: alertIds,
          windowMinutes,
          groups,
          links,
          summary: alertIds.length
            ? 'Correlation analysis complete for requested alerts.'
            : 'Returning sample correlation analysis.'
        }
      });
    } catch {
      return c.json({ error: 'Failed to analyze correlations' }, 500);
    }
  }
);

alertTemplateRoutes.get(
  '/correlations/:alertId',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    try {
      const auth = c.get('auth');
      const orgId = resolveScopedOrgId(auth);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const scopedAlerts = getScopedCorrelationAlerts(orgId);
      const scopedAlertIds = new Set(scopedAlerts.map((item) => item.id));
      const alertId = c.req.param('alertId');
      const alert = scopedAlerts.find((item) => item.id === alertId);

      if (!alert) {
        return c.json({ error: 'Alert not found' }, 404);
      }

      return c.json({
        data: {
          alert,
          correlations: getCorrelationLinksForAlert(alertId).filter(
            (link) => scopedAlertIds.has(link.alertId) && scopedAlertIds.has(link.relatedAlertId)
          ),
          relatedAlerts: getRelatedAlerts(alertId).filter((item) => scopedAlertIds.has(item.id)),
          groups: getCorrelationGroupsForAlert(alertId)
            .map((group) => ({
              ...group,
              alerts: group.alerts.filter((item) => scopedAlertIds.has(item.id))
            }))
            .filter((group) => group.alerts.length > 0)
        }
      });
    } catch {
      return c.json({ error: 'Failed to fetch correlations' }, 500);
    }
  }
);
