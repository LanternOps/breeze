import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, gte, lte, ilike, or, sql, SQL } from 'drizzle-orm';
import { db } from '../db';
import { auditLogs as auditLogsTable, users } from '../db/schema';
import { authMiddleware } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';

export const auditLogRoutes = new Hono();

// Apply auth to all routes
auditLogRoutes.use('*', authMiddleware);

// ============================================
// Schemas
// ============================================

const listLogsSchema = z.object({
  page: z.string().optional(),
  limit: z.string().optional(),
  user: z.string().min(1).optional(),
  action: z.string().min(1).optional(),
  resource: z.string().min(1).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional()
});

const searchSchema = listLogsSchema.extend({
  q: z.string().min(1)
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

// ============================================
// Action classification sets (for reports)
// ============================================

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

// ============================================
// Helpers
// ============================================

function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

function escapeIlike(value: string): string {
  return value.replace(/[%_\\]/g, '\\$&');
}

function deriveCategory(action: string): string {
  if (action.startsWith('user.login') || action.startsWith('user.logout') || action.startsWith('user.permission')) return 'authentication';
  if (action.startsWith('device.')) return 'device';
  if (action.startsWith('script.')) return 'automation';
  if (action.startsWith('policy.')) return 'policy';
  if (action.startsWith('alert.')) return 'alert';
  if (action.startsWith('data.')) return 'compliance';
  if (action.startsWith('organization.')) return 'organization';
  return 'system';
}

type DbRow = {
  log: typeof auditLogsTable.$inferSelect;
  userName: string | null;
};

function flattenEntry(row: DbRow) {
  const log = row.log;
  const details = log.details as Record<string, unknown> | null;
  return {
    id: log.id,
    timestamp: log.timestamp.toISOString(),
    action: log.action,
    resource: log.resourceName ?? log.resourceType,
    resourceType: log.resourceType,
    details: details ? JSON.stringify(details) : '{}',
    ipAddress: log.ipAddress ?? '',
    userAgent: log.userAgent ?? '',
    sessionId: details?.sessionId ?? null,
    user: {
      name: row.userName ?? log.actorEmail ?? 'Unknown',
      email: log.actorEmail ?? '',
      role: log.actorType,
      department: ''
    },
    changes: {
      before: {},
      after: details ?? {}
    }
  };
}

function toFullEntry(row: DbRow) {
  const log = row.log;
  const details = log.details as Record<string, unknown> | null;
  return {
    id: log.id,
    timestamp: log.timestamp.toISOString(),
    user: {
      id: log.actorId,
      name: row.userName ?? log.actorEmail ?? 'Unknown',
      email: log.actorEmail ?? '',
      role: log.actorType
    },
    action: log.action,
    resource: {
      type: log.resourceType,
      id: log.resourceId ?? '',
      name: log.resourceName ?? ''
    },
    category: deriveCategory(log.action),
    result: log.result,
    ipAddress: log.ipAddress ?? '',
    userAgent: log.userAgent ?? '',
    details: details ?? {}
  };
}

function buildFilterConditions(
  orgCond: SQL | undefined,
  filters: { user?: string; action?: string; resource?: string; from?: string; to?: string }
): SQL | undefined {
  const conditions: SQL[] = [];

  if (orgCond) conditions.push(orgCond);

  if (filters.user) {
    const term = `%${escapeIlike(filters.user)}%`;
    conditions.push(
      or(
        ilike(auditLogsTable.actorEmail, term),
        ilike(users.name, term)
      )!
    );
  }

  if (filters.action) {
    conditions.push(ilike(auditLogsTable.action, `%${escapeIlike(filters.action)}%`));
  }

  if (filters.resource) {
    const term = `%${escapeIlike(filters.resource)}%`;
    conditions.push(
      or(
        ilike(auditLogsTable.resourceType, term),
        ilike(auditLogsTable.resourceName, term)
      )!
    );
  }

  if (filters.from) {
    conditions.push(gte(auditLogsTable.timestamp, new Date(filters.from)));
  }

  if (filters.to) {
    conditions.push(lte(auditLogsTable.timestamp, new Date(filters.to)));
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

function buildSearchCondition(q: string): SQL {
  const term = `%${escapeIlike(q)}%`;
  return or(
    ilike(auditLogsTable.action, term),
    ilike(auditLogsTable.actorEmail, term),
    ilike(auditLogsTable.resourceType, term),
    ilike(auditLogsTable.resourceName, term),
    sql`${auditLogsTable.details}::text ILIKE ${term}`
  )!;
}

async function queryRows(where: SQL | undefined, limit: number, offset: number): Promise<DbRow[]> {
  return db
    .select({ log: auditLogsTable, userName: users.name })
    .from(auditLogsTable)
    .leftJoin(users, eq(auditLogsTable.actorId, users.id))
    .where(where)
    .orderBy(desc(auditLogsTable.timestamp))
    .limit(limit)
    .offset(offset);
}

async function countRows(where: SQL | undefined): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(auditLogsTable)
    .leftJoin(users, eq(auditLogsTable.actorId, users.id))
    .where(where);
  return row?.count ?? 0;
}

async function fetchAllForReports(orgCond: SQL | undefined, filters: { from?: string; to?: string }): Promise<DbRow[]> {
  const where = buildFilterConditions(orgCond, filters);
  return queryRows(where, 5000, 0);
}

function toCsv(rows: DbRow[]): string {
  const headers = [
    'id', 'timestamp', 'actorId', 'actorName', 'actorEmail',
    'action', 'resourceType', 'resourceId', 'resourceName',
    'category', 'result', 'ipAddress', 'userAgent', 'details'
  ];

  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;

  const csvRows = rows.map((row) => {
    const log = row.log;
    const values = [
      log.id,
      log.timestamp.toISOString(),
      log.actorId,
      row.userName ?? '',
      log.actorEmail ?? '',
      log.action,
      log.resourceType,
      log.resourceId ?? '',
      log.resourceName ?? '',
      deriveCategory(log.action),
      log.result,
      log.ipAddress ?? '',
      log.userAgent ?? '',
      JSON.stringify(log.details ?? {})
    ];
    return values.map((v) => escape(String(v))).join(',');
  });

  return [headers.join(','), ...csvRows].join('\n');
}

function summarizeUsers(rows: DbRow[]) {
  const byUser = new Map<string, { userId: string; userName: string; userEmail: string; actionCount: number; lastActiveAt: string }>();

  for (const row of rows) {
    const userId = row.log.actorId;
    const existing = byUser.get(userId);
    if (!existing) {
      byUser.set(userId, {
        userId,
        userName: row.userName ?? row.log.actorEmail ?? 'Unknown',
        userEmail: row.log.actorEmail ?? '',
        actionCount: 1,
        lastActiveAt: row.log.timestamp.toISOString()
      });
      continue;
    }
    existing.actionCount += 1;
    if (row.log.timestamp.getTime() > new Date(existing.lastActiveAt).getTime()) {
      existing.lastActiveAt = row.log.timestamp.toISOString();
    }
  }

  return Array.from(byUser.values()).sort((a, b) => b.actionCount - a.actionCount);
}

function summarizeActions(rows: DbRow[]) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.log.action, (counts.get(row.log.action) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([action, count]) => ({ action, count }))
    .sort((a, b) => b.count - a.count);
}

function summarizeCategories(rows: DbRow[]) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const cat = deriveCategory(row.log.action);
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

// ============================================
// Routes
// ============================================

function paginatedListHandler(
  dataKey: string,
  mapFn: (row: DbRow) => unknown
) {
  return async (c: any) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const orgCond = auth.orgCondition(auditLogsTable.orgId);
    const where = buildFilterConditions(orgCond, query);
    const [total, rows] = await Promise.all([
      countRows(where),
      queryRows(where, limit, offset)
    ]);

    return c.json({
      [dataKey]: rows.map(mapFn),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  };
}

// GET / — used by AuditLogViewer (returns flattenEntry shape)
auditLogRoutes.get(
  '/',
  zValidator('query', listLogsSchema),
  paginatedListHandler('entries', flattenEntry)
);

// GET /logs — used by RecentActivity, UserActivityReport (returns full entry shape)
auditLogRoutes.get(
  '/logs',
  zValidator('query', listLogsSchema),
  paginatedListHandler('data', toFullEntry)
);

// GET /logs/:id — single entry detail
auditLogRoutes.get(
  '/logs/:id',
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id } = c.req.valid('param');

    const orgCond = auth.orgCondition(auditLogsTable.orgId);
    const conditions: SQL[] = [eq(auditLogsTable.id, id)];
    if (orgCond) conditions.push(orgCond);

    const [row] = await db
      .select({ log: auditLogsTable, userName: users.name })
      .from(auditLogsTable)
      .leftJoin(users, eq(auditLogsTable.actorId, users.id))
      .where(and(...conditions));

    if (!row) {
      return c.json({ error: 'Audit log not found' }, 404);
    }

    return c.json(toFullEntry(row));
  }
);

// GET /search
auditLogRoutes.get(
  '/search',
  zValidator('query', searchSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { page, limit, offset } = getPagination(query);

    const orgCond = auth.orgCondition(auditLogsTable.orgId);
    const filterWhere = buildFilterConditions(orgCond, query);
    const searchCond = buildSearchCondition(query.q);
    const where = filterWhere ? and(filterWhere, searchCond) : searchCond;

    const [total, rows] = await Promise.all([
      countRows(where),
      queryRows(where, limit, offset)
    ]);

    return c.json({
      data: rows.map(toFullEntry),
      query: query.q,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  }
);

// POST /export — used by AuditExport component
auditLogRoutes.post(
  '/export',
  zValidator('json', exportSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    const orgCond = auth.orgCondition(auditLogsTable.orgId);
    const where = buildFilterConditions(orgCond, {
      ...(body.filters ?? {}),
      from: body.dateRange?.from,
      to: body.dateRange?.to
    });

    const rows = await queryRows(where, 10000, 0);

    writeRouteAudit(c, {
      orgId: auth.orgId,
      action: 'audit_logs.export',
      resourceType: 'audit_log',
      details: {
        format: body.format,
        rowCount: rows.length
      }
    });

    if (body.format === 'csv') {
      c.header('Content-Type', 'text/csv');
      c.header('Content-Disposition', 'attachment; filename="audit-logs.csv"');
      return c.body(toCsv(rows));
    }

    return c.json({ data: rows.map(toFullEntry), total: rows.length });
  }
);

// GET /export — used by AuditLogViewer export button (CSV download)
const exportGetSchema = z.object({
  userId: z.string().uuid().optional()
});

auditLogRoutes.get(
  '/export',
  zValidator('query', exportGetSchema),
  async (c) => {
    const auth = c.get('auth');
    const orgCond = auth.orgCondition(auditLogsTable.orgId);

    const { userId } = c.req.valid('query');
    const conditions: SQL[] = [];
    if (orgCond) conditions.push(orgCond);
    if (userId) conditions.push(eq(auditLogsTable.actorId, userId));

    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const rows = await queryRows(where, 10000, 0);

    c.header('Content-Type', 'text/csv');
    c.header('Content-Disposition', 'attachment; filename="audit-logs.csv"');
    return c.body(toCsv(rows));
  }
);

// GET /reports/user-activity
auditLogRoutes.get(
  '/reports/user-activity',
  zValidator('query', reportQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgCond = auth.orgCondition(auditLogsTable.orgId);
    const rows = await fetchAllForReports(orgCond, query);

    const actionsPerUser = summarizeUsers(rows);
    const recentActivity = rows.slice(0, 10).map(toFullEntry);

    return c.json({
      totalUsers: actionsPerUser.length,
      totalEvents: rows.length,
      actionsPerUser,
      topUsers: actionsPerUser.slice(0, 5),
      recentActivity
    });
  }
);

// GET /reports/security-events
auditLogRoutes.get(
  '/reports/security-events',
  zValidator('query', reportQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgCond = auth.orgCondition(auditLogsTable.orgId);
    const allRows = await fetchAllForReports(orgCond, query);

    const securityRows = allRows.filter((r) => securityActions.has(r.log.action));
    const byAction = summarizeActions(securityRows);
    const loginAttempts = securityRows.filter((r) => r.log.action.startsWith('user.login')).length;
    const failedLogins = securityRows.filter((r) => r.log.action === 'user.login.failed').length;
    const permissionChanges = securityRows.filter((r) => r.log.action === 'user.permission.change').length;

    return c.json({
      totalEvents: securityRows.length,
      loginAttempts,
      failedLogins,
      permissionChanges,
      byAction,
      recentEvents: securityRows.slice(0, 10).map(toFullEntry)
    });
  }
);

// GET /reports/compliance
auditLogRoutes.get(
  '/reports/compliance',
  zValidator('query', reportQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgCond = auth.orgCondition(auditLogsTable.orgId);
    const allRows = await fetchAllForReports(orgCond, query);

    const complianceRows = allRows.filter((r) =>
      complianceActions.has(r.log.action) || deriveCategory(r.log.action) === 'compliance'
    );
    const byAction = summarizeActions(complianceRows);
    const dataAccess = complianceRows.filter((r) => dataAccessActions.has(r.log.action)).length;
    const dataChanges = complianceRows.filter((r) => dataChangeActions.has(r.log.action)).length;
    const exports = complianceRows.filter((r) => exportActions.has(r.log.action)).length;

    return c.json({
      totalEvents: complianceRows.length,
      dataAccess,
      dataChanges,
      exports,
      byAction,
      recentEvents: complianceRows.slice(0, 10).map(toFullEntry)
    });
  }
);

// GET /stats
auditLogRoutes.get(
  '/stats',
  zValidator('query', reportQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const orgCond = auth.orgCondition(auditLogsTable.orgId);
    const rows = await fetchAllForReports(orgCond, query);

    const byCategory = summarizeCategories(rows);
    const byUser = summarizeUsers(rows).map((entry) => ({
      userId: entry.userId,
      userName: entry.userName,
      actionCount: entry.actionCount
    }));

    return c.json({
      totalEvents: rows.length,
      byCategory,
      byUser,
      range: {
        from: query.from ?? null,
        to: query.to ?? null
      }
    });
  }
);
