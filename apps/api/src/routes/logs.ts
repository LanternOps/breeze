import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';

import { db } from '../db';
import { logCorrelations, logCorrelationRules } from '../db/schema';
import { enqueueAdHocPatternCorrelationDetection, getLogCorrelationDetectionJob } from '../jobs/logCorrelation';
import { authMiddleware, requireScope } from '../middleware/auth';
import {
  createSavedLogSearchQuery,
  deleteSavedLogSearchQuery,
  detectPatternCorrelation,
  getSavedLogSearchQueryById,
  getLogAggregation,
  getLogTrends,
  getSavedLogSearchQuery,
  listSavedLogSearchQueries,
  mergeSavedLogSearchFilters,
  resolveSingleOrgId,
  runCorrelationRules,
  searchFleetLogs,
  type LogSearchInput,
  updateSavedSearchRunStats,
} from '../services/logSearch';

const levelSchema = z.enum(['info', 'warning', 'error', 'critical']);
const categorySchema = z.enum(['security', 'hardware', 'application', 'system']);

const timeRangeSchema = z.object({
  start: z.string().min(1),
  end: z.string().min(1),
});

const logSearchSchema = z.object({
  query: z.string().min(1).max(500).optional(),
  timeRange: timeRangeSchema.optional(),
  level: z.array(levelSchema).max(4).optional(),
  category: z.array(categorySchema).max(4).optional(),
  source: z.string().max(255).optional(),
  deviceIds: z.array(z.string().uuid()).max(500).optional(),
  siteIds: z.array(z.string().uuid()).max(500).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
  cursor: z.string().max(1024).optional(),
  countMode: z.enum(['exact', 'estimated', 'none']).optional(),
  sortBy: z.enum(['timestamp', 'level', 'device']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  savedQueryId: z.string().uuid().optional(),
});

const aggregationQuerySchema = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
  bucket: z.enum(['hour', 'day']).optional(),
  groupBy: z.enum(['level', 'category', 'source', 'device']).optional(),
  level: z.string().optional(),
  category: z.string().optional(),
  source: z.string().optional(),
  deviceIds: z.string().optional(),
  siteIds: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
});

const trendsQuerySchema = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
  minLevel: levelSchema.optional(),
  source: z.string().optional(),
  deviceIds: z.string().optional(),
  siteIds: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const correlationDetectSchema = z.object({
  orgId: z.string().uuid().optional(),
  ruleIds: z.array(z.string().uuid()).max(200).optional(),
  pattern: z.string().min(1).max(1000).optional(),
  isRegex: z.boolean().optional(),
  timeWindow: z.number().int().min(30).max(86_400).optional(),
  minDevices: z.number().int().min(1).max(200).optional(),
  minOccurrences: z.number().int().min(1).max(50_000).optional(),
});

const correlationListQuerySchema = z.object({
  orgId: z.string().uuid().optional(),
  status: z.enum(['active', 'resolved', 'ignored']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const savedSearchCreateSchema = z.object({
  orgId: z.string().uuid().optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  isShared: z.boolean().optional(),
  filters: logSearchSchema.omit({ savedQueryId: true, cursor: true }),
});

const ALLOWED_LEVELS = new Set(levelSchema.options);
const ALLOWED_CATEGORIES = new Set(categorySchema.options);
const uuidParser = z.string().uuid();

function parseCsv<T extends string>(value: string | undefined, parser?: (item: string) => T): T[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (items.length === 0) return undefined;
  return parser ? items.map(parser) : (items as T[]);
}

function parseLevelCsv(value: string | undefined): Array<'info' | 'warning' | 'error' | 'critical'> | undefined {
  const items = parseCsv(value);
  if (!items) return undefined;

  for (const item of items) {
    if (!ALLOWED_LEVELS.has(item as 'info' | 'warning' | 'error' | 'critical')) {
      throw new Error(`Invalid level value: ${item}`);
    }
  }

  return items as Array<'info' | 'warning' | 'error' | 'critical'>;
}

function parseCategoryCsv(value: string | undefined): Array<'security' | 'hardware' | 'application' | 'system'> | undefined {
  const items = parseCsv(value);
  if (!items) return undefined;

  for (const item of items) {
    if (!ALLOWED_CATEGORIES.has(item as 'security' | 'hardware' | 'application' | 'system')) {
      throw new Error(`Invalid category value: ${item}`);
    }
  }

  return items as Array<'security' | 'hardware' | 'application' | 'system'>;
}

function parseUuidCsv(value: string | undefined): string[] | undefined {
  const items = parseCsv(value);
  if (!items) return undefined;

  for (const item of items) {
    const parsed = uuidParser.safeParse(item);
    if (!parsed.success) {
      throw new Error(`Invalid UUID value: ${item}`);
    }
  }

  return items;
}

function mapCorrelationJobState(state: string): 'queued' | 'running' | 'completed' | 'failed' {
  if (state === 'completed') return 'completed';
  if (state === 'failed') return 'failed';
  if (state === 'active') return 'running';
  return 'queued';
}

export const logsRoutes = new Hono();

logsRoutes.use('*', authMiddleware);

logsRoutes.post(
  '/search',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', logSearchSchema),
  async (c) => {
    const auth = c.get('auth');
    const payload = c.req.valid('json');
    const { savedQueryId, ...inlineFilters } = payload;
    let filters: LogSearchInput = inlineFilters;

    try {
      if (savedQueryId) {
        const saved = await getSavedLogSearchQuery(auth, savedQueryId);
        if (!saved) {
          return c.json({ error: 'Saved query not found' }, 404);
        }
        filters = mergeSavedLogSearchFilters(saved.filters, inlineFilters);
      }

      const result = await searchFleetLogs(auth, filters);

      if (savedQueryId) {
        await updateSavedSearchRunStats(savedQueryId);
      }

      return c.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to search logs';
      const normalized = message.toLowerCase();
      const status = normalized.includes('time range') || normalized.includes('invalid') || normalized.includes('cursor') ? 400 : 500;
      return c.json({ error: message }, status);
    }
  }
);

logsRoutes.get(
  '/correlation/detect/:jobId',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const jobId = c.req.param('jobId');
    if (!jobId || jobId.trim().length === 0) {
      return c.json({ error: 'jobId is required' }, 400);
    }

    try {
      const job = await getLogCorrelationDetectionJob(jobId.trim());
      if (!job || job.data.type !== 'pattern') {
        return c.json({ error: 'Detection job not found' }, 404);
      }

      if (!auth.canAccessOrg(job.data.orgId)) {
        return c.json({ error: 'Access denied for requested org' }, 403);
      }

      const status = mapCorrelationJobState(job.state);
      return c.json({
        jobId: job.id,
        mode: 'adhoc',
        status,
        state: job.state,
        queuedAt: job.data.queuedAt,
        processedAt: job.processedOn ? new Date(job.processedOn).toISOString() : null,
        finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
        attemptsMade: job.attemptsMade,
        result: status === 'completed' ? job.result : undefined,
        error: status === 'failed' ? (job.failedReason ?? 'Detection job failed') : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch detection job';
      const normalized = message.toLowerCase();
      const status = normalized.includes('redis') ? 503 : 500;
      return c.json({ error: message }, status);
    }
  }
);

logsRoutes.get(
  '/aggregation',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', aggregationQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    try {
      const payload = await getLogAggregation(auth, {
        start: query.start,
        end: query.end,
        bucket: query.bucket,
        groupBy: query.groupBy,
        level: parseLevelCsv(query.level),
        category: parseCategoryCsv(query.category),
        source: query.source,
        deviceIds: parseUuidCsv(query.deviceIds),
        siteIds: parseUuidCsv(query.siteIds),
        limit: query.limit,
      });

      return c.json(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to aggregate logs';
      const normalized = message.toLowerCase();
      const status = normalized.includes('time range') || normalized.startsWith('invalid') ? 400 : 500;
      return c.json({ error: message }, status);
    }
  }
);

logsRoutes.get(
  '/trends',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', trendsQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    try {
      const payload = await getLogTrends(auth, {
        start: query.start,
        end: query.end,
        minLevel: query.minLevel,
        source: query.source,
        deviceIds: parseUuidCsv(query.deviceIds),
        siteIds: parseUuidCsv(query.siteIds),
        limit: query.limit,
      });

      return c.json(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch trends';
      const normalized = message.toLowerCase();
      const status = normalized.includes('time range') || normalized.startsWith('invalid') ? 400 : 500;
      return c.json({ error: message }, status);
    }
  }
);

logsRoutes.post(
  '/correlation/detect',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', correlationDetectSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    try {
      if (body.pattern) {
        const orgId = resolveSingleOrgId(auth, body.orgId);
        if (!orgId) {
          return c.json({ error: 'orgId is required for this scope' }, 400);
        }

        try {
          const jobId = await enqueueAdHocPatternCorrelationDetection({
            orgId,
            pattern: body.pattern,
            isRegex: body.isRegex,
            timeWindowSeconds: body.timeWindow,
            minDevices: body.minDevices,
            minOccurrences: body.minOccurrences,
          });

          return c.json({
            mode: 'adhoc',
            queued: true,
            jobId,
            status: 'queued',
          }, 202);
        } catch (queueError) {
          console.warn('[logs/correlation/detect] Queue unavailable, running inline fallback:', queueError);
          const result = await detectPatternCorrelation({
            orgId,
            pattern: body.pattern,
            isRegex: body.isRegex,
            timeWindowSeconds: body.timeWindow,
            minDevices: body.minDevices,
            minOccurrences: body.minOccurrences,
          });

          return c.json({
            mode: 'adhoc',
            queued: false,
            fallback: 'inline',
            detected: Boolean(result),
            result,
          });
        }
      }

      // Rules-based path: orgId is required (no pattern provided means broad rule run)
      const orgId = resolveSingleOrgId(auth, body.orgId);
      if (!orgId) {
        return c.json({ error: 'orgId is required for this scope' }, 400);
      }

      const detections = await runCorrelationRules({
        orgId,
        ruleIds: body.ruleIds,
      });

      return c.json({
        mode: 'rules',
        count: detections.length,
        detections,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to detect correlations';
      const normalized = message.toLowerCase();
      const status = normalized.includes('invalid') || normalized.includes('pattern') || normalized.includes('orgid') ? 400 : 500;
      return c.json({ error: message }, status);
    }
  }
);

logsRoutes.get(
  '/correlation',
  requireScope('organization', 'partner', 'system'),
  zValidator('query', correlationListQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');

    if (query.orgId && !auth.canAccessOrg(query.orgId)) {
      return c.json({ error: 'Access denied for requested org' }, 403);
    }

    const conditions: SQL[] = [];
    const orgCondition = auth.orgCondition(logCorrelations.orgId);
    if (orgCondition) {
      conditions.push(orgCondition);
    }
    if (query.orgId) {
      conditions.push(eq(logCorrelations.orgId, query.orgId));
    }
    if (query.status) {
      conditions.push(eq(logCorrelations.status, query.status));
    }

    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;

    const whereCondition = and(...conditions);

    const [rows, totalRows] = await Promise.all([
      db
        .select({
          id: logCorrelations.id,
          orgId: logCorrelations.orgId,
          ruleId: logCorrelations.ruleId,
          ruleName: logCorrelationRules.name,
          pattern: logCorrelations.pattern,
          firstSeen: logCorrelations.firstSeen,
          lastSeen: logCorrelations.lastSeen,
          occurrences: logCorrelations.occurrences,
          affectedDevices: logCorrelations.affectedDevices,
          sampleLogs: logCorrelations.sampleLogs,
          status: logCorrelations.status,
          alertId: logCorrelations.alertId,
          createdAt: logCorrelations.createdAt,
        })
        .from(logCorrelations)
        .leftJoin(logCorrelationRules, eq(logCorrelations.ruleId, logCorrelationRules.id))
        .where(whereCondition)
        .orderBy(desc(logCorrelations.lastSeen))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)` })
        .from(logCorrelations)
        .where(whereCondition),
    ]);

    return c.json({
      data: rows,
      limit,
      offset,
      total: Number(totalRows[0]?.count ?? 0),
    });
  }
);

logsRoutes.get(
  '/queries',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const data = await listSavedLogSearchQueries(auth);
    return c.json({ data });
  }
);

logsRoutes.post(
  '/queries',
  requireScope('organization', 'partner', 'system'),
  zValidator('json', savedSearchCreateSchema),
  async (c) => {
    const auth = c.get('auth');
    const body = c.req.valid('json');

    try {
      const created = await createSavedLogSearchQuery(auth, body);
      return c.json({ data: created }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save query';
      const status = message.toLowerCase().includes('orgid') ? 400 : 500;
      return c.json({ error: message }, status);
    }
  }
);

logsRoutes.get(
  '/queries/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const id = c.req.param('id');

    const query = await getSavedLogSearchQuery(auth, id);
    if (!query) {
      return c.json({ error: 'Saved query not found' }, 404);
    }

    return c.json({ data: query });
  }
);

logsRoutes.delete(
  '/queries/:id',
  requireScope('organization', 'partner', 'system'),
  async (c) => {
    const auth = c.get('auth');
    const id = c.req.param('id');

    const existing = await getSavedLogSearchQueryById(auth, id);
    if (!existing) {
      return c.json({ error: 'Saved query not found' }, 404);
    }

    const deleted = await deleteSavedLogSearchQuery(auth, id);
    if (!deleted) {
      return c.json({ error: 'Only the owner can delete this saved query' }, 403);
    }

    return c.body(null, 204);
  }
);
