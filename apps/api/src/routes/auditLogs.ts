import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

export const auditLogRoutes = new Hono();

type AuditLogEntry = {
  id: string;
  timestamp: string;
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
  };
  action: string;
  resource: {
    type: string;
    id: string;
    name: string;
  };
  category: string;
  result: 'success' | 'failure';
  ipAddress: string;
  userAgent: string;
  details: Record<string, unknown>;
};

type AuditFilters = {
  user?: string;
  action?: string;
  resource?: string;
  from?: string;
  to?: string;
};

type ActionTemplate = {
  action: string;
  resourceType: 'user' | 'device' | 'script' | 'policy' | 'alert' | 'organization';
  category: string;
  result: 'success' | 'failure';
  details: Record<string, unknown>;
};

const listLogsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  user: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  resource: z.string().min(1).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional()
});

const searchSchema = z.object({
  q: z.string().min(1),
  page: z.string().optional(),
  limit: z.string().optional(),
  user: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  resource: z.string().min(1).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional()
});

const idParamSchema = z.object({
  id: z.string().min(1)
});

const exportSchema = z.object({
  format: z.enum(['csv', 'json']).default('json'),
  filters: z.object({
    user: z.string().min(1).optional(),
    action: z.string().min(1).optional(),
    resource: z.string().min(1).optional()
  }).optional(),
  dateRange: z.object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional()
  }).optional()
});

const reportQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional()
});

const users = [
  { id: 'user-1', name: 'Avery Lee', email: 'avery.lee@breeze.example', role: 'admin' },
  { id: 'user-2', name: 'Jordan Patel', email: 'jordan.patel@breeze.example', role: 'operator' },
  { id: 'user-3', name: 'Morgan Chen', email: 'morgan.chen@breeze.example', role: 'analyst' },
  { id: 'user-4', name: 'Riley Morgan', email: 'riley.morgan@breeze.example', role: 'security' },
  { id: 'user-5', name: 'Casey Park', email: 'casey.park@breeze.example', role: 'admin' },
  { id: 'user-6', name: 'Sam Rivera', email: 'sam.rivera@breeze.example', role: 'support' }
];

const resourceNames = {
  device: ['SF-Laptop-12', 'NY-Server-3', 'Austin-Desktop-7', 'Berlin-VM-4', 'Tokyo-Mac-2', 'Denver-WS-9'],
  script: ['Patch Tuesday', 'Cleanup Temp', 'Vuln Scan', 'Onboarding Check', 'Log Rotate'],
  policy: ['USB Storage', 'Disk Encryption', 'Password Rotation', 'Firewall Baseline', 'Admin Access'],
  alert: ['Malware Detected', 'Suspicious Login', 'Disk Space Low', 'Unauthorized USB', 'Privilege Escalation'],
  organization: ['Breeze HQ', 'Breeze West', 'Breeze East']
};

const actionTemplates: ActionTemplate[] = [
  {
    action: 'user.login',
    resourceType: 'user',
    category: 'authentication',
    result: 'success',
    details: { method: 'password', mfa: true }
  },
  {
    action: 'user.login.failed',
    resourceType: 'user',
    category: 'authentication',
    result: 'failure',
    details: { method: 'password', reason: 'invalid_password' }
  },
  {
    action: 'user.logout',
    resourceType: 'user',
    category: 'authentication',
    result: 'success',
    details: { sessionDurationMinutes: 42 }
  },
  {
    action: 'user.permission.change',
    resourceType: 'user',
    category: 'security',
    result: 'success',
    details: { fromRole: 'viewer', toRole: 'admin' }
  },
  {
    action: 'device.create',
    resourceType: 'device',
    category: 'device',
    result: 'success',
    details: { model: 'ThinkPad X1 Carbon', os: 'Windows 11', assetTag: 'AT-4821' }
  },
  {
    action: 'device.delete',
    resourceType: 'device',
    category: 'device',
    result: 'success',
    details: { reason: 'decommissioned' }
  },
  {
    action: 'device.update',
    resourceType: 'device',
    category: 'device',
    result: 'success',
    details: { fields: ['hostname', 'owner'] }
  },
  {
    action: 'device.policy.apply',
    resourceType: 'device',
    category: 'device',
    result: 'success',
    details: { policy: 'Disk Encryption' }
  },
  {
    action: 'script.execute',
    resourceType: 'script',
    category: 'automation',
    result: 'success',
    details: { status: 'completed', durationSeconds: 72 }
  },
  {
    action: 'script.execute',
    resourceType: 'script',
    category: 'automation',
    result: 'failure',
    details: { status: 'failed', error: 'timeout' }
  },
  {
    action: 'policy.update',
    resourceType: 'policy',
    category: 'policy',
    result: 'success',
    details: { changes: ['enforcement', 'scope'] }
  },
  {
    action: 'policy.create',
    resourceType: 'policy',
    category: 'policy',
    result: 'success',
    details: { template: 'Baseline' }
  },
  {
    action: 'alert.create',
    resourceType: 'alert',
    category: 'alert',
    result: 'success',
    details: { severity: 'high', source: 'edr' }
  },
  {
    action: 'alert.resolve',
    resourceType: 'alert',
    category: 'alert',
    result: 'success',
    details: { resolution: 'quarantined' }
  },
  {
    action: 'organization.update',
    resourceType: 'organization',
    category: 'organization',
    result: 'success',
    details: { fields: ['billingEmail', 'timezone'] }
  },
  {
    action: 'data.export',
    resourceType: 'organization',
    category: 'compliance',
    result: 'success',
    details: { format: 'csv', recordCount: 1200 }
  },
  {
    action: 'data.access',
    resourceType: 'organization',
    category: 'compliance',
    result: 'success',
    details: { dataset: 'device.inventory', operation: 'read' }
  }
];

const ipAddresses = [
  '192.0.2.10',
  '198.51.100.23',
  '203.0.113.45',
  '10.0.5.22',
  '172.16.4.50',
  '192.168.1.18'
];

const userAgents = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/537.36 Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/118.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/117.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
  'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/119.0.0.0'
];

const locations = [
  { city: 'San Francisco', region: 'CA', country: 'US' },
  { city: 'New York', region: 'NY', country: 'US' },
  { city: 'Austin', region: 'TX', country: 'US' },
  { city: 'Berlin', region: 'BE', country: 'DE' },
  { city: 'Tokyo', region: '13', country: 'JP' }
];

const securityActions = new Set([
  'user.login',
  'user.login.failed',
  'user.permission.change',
  'policy.update',
  'policy.create'
]);

const complianceActions = new Set([
  'data.access',
  'data.export',
  'device.create',
  'device.delete',
  'policy.update',
  'script.execute',
  'organization.update'
]);

const dataAccessActions = new Set(['data.access']);
const dataChangeActions = new Set([
  'device.create',
  'device.delete',
  'device.update',
  'policy.update',
  'policy.create',
  'script.execute',
  'organization.update'
]);

const exportActions = new Set(['data.export']);

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

function normalize(value?: string) {
  return value?.trim().toLowerCase();
}

function pickFilters(input: { user?: string; action?: string; resource?: string; from?: string; to?: string }): AuditFilters {
  return {
    user: input.user,
    action: input.action,
    resource: input.resource,
    from: input.from,
    to: input.to
  };
}

function applyFilters(logs: AuditLogEntry[], filters: AuditFilters): AuditLogEntry[] {
  const userTerm = normalize(filters.user);
  const actionTerm = normalize(filters.action);
  const resourceTerm = normalize(filters.resource);
  const fromDate = filters.from ? new Date(filters.from) : null;
  const toDate = filters.to ? new Date(filters.to) : null;

  return logs.filter((log) => {
    if (userTerm) {
      const matchesUser = [log.user.id, log.user.name, log.user.email].some((value) =>
        value.toLowerCase().includes(userTerm)
      );
      if (!matchesUser) return false;
    }

    if (actionTerm && !log.action.toLowerCase().includes(actionTerm)) {
      return false;
    }

    if (resourceTerm) {
      const matchesResource = [log.resource.type, log.resource.id, log.resource.name].some((value) =>
        value.toLowerCase().includes(resourceTerm)
      );
      if (!matchesResource) return false;
    }

    const timestamp = new Date(log.timestamp);
    if (fromDate && timestamp < fromDate) return false;
    if (toDate && timestamp > toDate) return false;

    return true;
  });
}

function applySearch(logs: AuditLogEntry[], term: string) {
  const normalized = normalize(term);
  if (!normalized) return logs;

  return logs.filter((log) => {
    const haystack = [
      log.action,
      log.category,
      log.user.name,
      log.user.email,
      log.resource.type,
      log.resource.name,
      log.resource.id,
      log.ipAddress,
      log.userAgent,
      JSON.stringify(log.details)
    ].join(' ').toLowerCase();

    return haystack.includes(normalized);
  });
}

function resolveResource(resourceType: ActionTemplate['resourceType'], user: AuditLogEntry['user'], index: number) {
  if (resourceType === 'user') {
    return { type: 'user', id: user.id, name: user.name };
  }

  const names = resourceNames[resourceType];
  const name = names[index % names.length];
  return {
    type: resourceType,
    id: `${resourceType}-${(index % names.length) + 1}`,
    name
  };
}

function createMockAuditLogs(count: number): AuditLogEntry[] {
  const logs: AuditLogEntry[] = [];
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const minuteMs = 60 * 1000;

  for (let i = 0; i < count; i += 1) {
    const template = actionTemplates[i % actionTemplates.length];
    const user = users[(i * 3) % users.length];
    const ipAddress = ipAddresses[(i * 5) % ipAddresses.length];
    const userAgent = userAgents[(i * 7) % userAgents.length];
    const location = locations[(i * 11) % locations.length];
    const resource = resolveResource(template.resourceType, user, i);
    const dayOffset = (i * 2) % 30;
    const minuteOffset = (i * 37) % (24 * 60);
    const timestamp = new Date(now - dayOffset * dayMs - minuteOffset * minuteMs);

    logs.push({
      id: `audit-${String(i + 1).padStart(4, '0')}`,
      timestamp: timestamp.toISOString(),
      user,
      action: template.action,
      resource,
      category: template.category,
      result: template.result,
      ipAddress,
      userAgent,
      details: {
        ...template.details,
        requestId: `req-${1000 + i}`,
        sessionId: `sess-${(i % 12) + 1}`,
        location
      }
    });
  }

  return logs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

function toCsv(logs: AuditLogEntry[]): string {
  const headers = [
    'id',
    'timestamp',
    'userId',
    'userName',
    'userEmail',
    'action',
    'resourceType',
    'resourceId',
    'resourceName',
    'category',
    'result',
    'ipAddress',
    'userAgent',
    'details'
  ];

  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;

  const rows = logs.map((log) => {
    const values = [
      log.id,
      log.timestamp,
      log.user.id,
      log.user.name,
      log.user.email,
      log.action,
      log.resource.type,
      log.resource.id,
      log.resource.name,
      log.category,
      log.result,
      log.ipAddress,
      log.userAgent,
      JSON.stringify(log.details)
    ];

    return values.map((value) => escape(String(value))).join(',');
  });

  return [headers.join(','), ...rows].join('\n');
}

function summarizeUsers(logs: AuditLogEntry[]) {
  const byUser = new Map<string, { userId: string; userName: string; userEmail: string; actionCount: number; lastActiveAt: string }>();

  for (const log of logs) {
    const existing = byUser.get(log.user.id);
    if (!existing) {
      byUser.set(log.user.id, {
        userId: log.user.id,
        userName: log.user.name,
        userEmail: log.user.email,
        actionCount: 1,
        lastActiveAt: log.timestamp
      });
      continue;
    }

    existing.actionCount += 1;
    if (new Date(log.timestamp).getTime() > new Date(existing.lastActiveAt).getTime()) {
      existing.lastActiveAt = log.timestamp;
    }
  }

  return Array.from(byUser.values()).sort((a, b) => b.actionCount - a.actionCount);
}

function summarizeActions(logs: AuditLogEntry[]) {
  const counts = new Map<string, number>();
  for (const log of logs) {
    counts.set(log.action, (counts.get(log.action) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([action, count]) => ({ action, count }))
    .sort((a, b) => b.count - a.count);
}

function summarizeCategories(logs: AuditLogEntry[]) {
  const counts = new Map<string, number>();
  for (const log of logs) {
    counts.set(log.category, (counts.get(log.category) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

const auditLogs = createMockAuditLogs(90);

auditLogRoutes.get(
  '/logs',
  zValidator('query', listLogsSchema),
  (c) => {
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);
    const filtered = applyFilters(auditLogs, pickFilters(query));
    const data = filtered.slice(offset, offset + limit);

    return c.json({
      data,
      pagination: {
        page,
        limit,
        total: filtered.length,
        totalPages: Math.ceil(filtered.length / limit)
      }
    });
  }
);

auditLogRoutes.get(
  '/logs/:id',
  zValidator('param', idParamSchema),
  (c) => {
    const { id } = c.req.valid('param');
    const log = auditLogs.find((entry) => entry.id === id);

    if (!log) {
      return c.json({ error: 'Audit log not found' }, 404);
    }

    return c.json(log);
  }
);

auditLogRoutes.get(
  '/search',
  zValidator('query', searchSchema),
  (c) => {
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);
    const filtered = applyFilters(auditLogs, pickFilters(query));
    const searched = applySearch(filtered, query.q);
    const data = searched.slice(offset, offset + limit);

    return c.json({
      data,
      query: query.q,
      pagination: {
        page,
        limit,
        total: searched.length,
        totalPages: Math.ceil(searched.length / limit)
      }
    });
  }
);

auditLogRoutes.post(
  '/export',
  zValidator('json', exportSchema),
  (c) => {
    const body = c.req.valid('json');
    const filters = pickFilters({
      ...(body.filters ?? {}),
      from: body.dateRange?.from,
      to: body.dateRange?.to
    });
    const filtered = applyFilters(auditLogs, filters);

    if (body.format === 'csv') {
      c.header('Content-Type', 'text/csv');
      c.header('Content-Disposition', 'attachment; filename="audit-logs.csv"');
      return c.body(toCsv(filtered));
    }

    return c.json({ data: filtered, total: filtered.length });
  }
);

auditLogRoutes.get(
  '/reports/user-activity',
  zValidator('query', reportQuerySchema),
  (c) => {
    const query = c.req.valid('query');
    const scopedLogs = applyFilters(auditLogs, pickFilters(query));
    const actionsPerUser = summarizeUsers(scopedLogs);

    return c.json({
      totalUsers: actionsPerUser.length,
      totalEvents: scopedLogs.length,
      actionsPerUser,
      topUsers: actionsPerUser.slice(0, 5),
      recentActivity: scopedLogs.slice(0, 10)
    });
  }
);

auditLogRoutes.get(
  '/reports/security-events',
  zValidator('query', reportQuerySchema),
  (c) => {
    const query = c.req.valid('query');
    const scopedLogs = applyFilters(auditLogs, pickFilters(query));
    const securityLogs = scopedLogs.filter((log) => securityActions.has(log.action));
    const byAction = summarizeActions(securityLogs);
    const loginAttempts = securityLogs.filter((log) => log.action.startsWith('user.login')).length;
    const failedLogins = securityLogs.filter((log) => log.action === 'user.login.failed').length;
    const permissionChanges = securityLogs.filter((log) => log.action === 'user.permission.change').length;

    return c.json({
      totalEvents: securityLogs.length,
      loginAttempts,
      failedLogins,
      permissionChanges,
      byAction,
      recentEvents: securityLogs.slice(0, 10)
    });
  }
);

auditLogRoutes.get(
  '/reports/compliance',
  zValidator('query', reportQuerySchema),
  (c) => {
    const query = c.req.valid('query');
    const scopedLogs = applyFilters(auditLogs, pickFilters(query));
    const complianceLogs = scopedLogs.filter((log) => complianceActions.has(log.action) || log.category === 'compliance');
    const byAction = summarizeActions(complianceLogs);
    const dataAccess = complianceLogs.filter((log) => dataAccessActions.has(log.action)).length;
    const dataChanges = complianceLogs.filter((log) => dataChangeActions.has(log.action)).length;
    const exports = complianceLogs.filter((log) => exportActions.has(log.action)).length;

    return c.json({
      totalEvents: complianceLogs.length,
      dataAccess,
      dataChanges,
      exports,
      byAction,
      recentEvents: complianceLogs.slice(0, 10)
    });
  }
);

auditLogRoutes.get(
  '/stats',
  zValidator('query', reportQuerySchema),
  (c) => {
    const query = c.req.valid('query');
    const scopedLogs = applyFilters(auditLogs, pickFilters(query));
    const byCategory = summarizeCategories(scopedLogs);
    const byUser = summarizeUsers(scopedLogs).map((entry) => ({
      userId: entry.userId,
      userName: entry.userName,
      actionCount: entry.actionCount
    }));

    return c.json({
      totalEvents: scopedLogs.length,
      byCategory,
      byUser,
      range: {
        from: query.from ?? null,
        to: query.to ?? null
      }
    });
  }
);
