import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { zValidator } from '../../lib/validation';
import { and, desc, eq, gte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, runOutsideDbContext, withDbAccessContext } from '../../db';
import { deviceSessions } from '../../db/schema';
import {
  authMiddleware,
  dbAccessContextFromAuth,
  requirePermission,
  requireScope,
  type AuthContext,
} from '../../middleware/auth';
import { sendCommandToAgentAwaitResult } from '../../services/agentCommandAwait';
import { PERMISSIONS } from '../../services/permissions';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';

export const sessionsRoutes = new Hono();

sessionsRoutes.use('*', authMiddleware);

const deviceIdParamSchema = z.object({
  id: z.string().guid(),
});

const historyQuerySchema = z.object({
  limit: z.string().optional(),
  daysBack: z.string().optional(),
});

const experienceQuerySchema = z.object({
  daysBack: z.string().optional(),
});

function parsePositiveInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

sessionsRoutes.get(
  '/:id/sessions/active',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const active = await db
      .select({
        id: deviceSessions.id,
        username: deviceSessions.username,
        sessionType: deviceSessions.sessionType,
        osSessionId: deviceSessions.osSessionId,
        loginAt: deviceSessions.loginAt,
        idleMinutes: deviceSessions.idleMinutes,
        activityState: deviceSessions.activityState,
        loginPerformanceSeconds: deviceSessions.loginPerformanceSeconds,
        lastActivityAt: deviceSessions.lastActivityAt,
        updatedAt: deviceSessions.updatedAt,
      })
      .from(deviceSessions)
      .where(
        and(
          eq(deviceSessions.deviceId, deviceId),
          eq(deviceSessions.isActive, true)
        )
      )
      .orderBy(desc(deviceSessions.loginAt));

    return c.json({
      data: {
        deviceId,
        activeUsers: active,
        count: active.length,
      },
    });
  }
);

const liveSessionItemSchema = z.object({
  sessionId: z.number().int().min(0).max(65535),
  username: z.string(),
  state: z.string(),
  type: z.string(),
  helperConnected: z.boolean().optional().default(false),
  idleMinutes: z.number().int().min(0).nullable().optional().default(null),
});

export type LiveSessionItem = z.infer<typeof liveSessionItemSchema>;

const LIST_SESSIONS_TIMEOUT_MS = 10_000;

/**
 * Short, request-scoped DB access context for GET /:id/sessions/live.
 *
 * That route is registered in `SELF_MANAGED_DB_CONTEXT_ROUTES`
 * (middleware/selfManagedDbContextRoutes.ts), so `authMiddleware` runs it with
 * NO ambient transaction. THAT REGISTRATION IS WHAT MAKES THIS SAFE — see below.
 * Without it, the up-to-10s `sendCommandToAgentAwaitResult` wait would pin a
 * pooled connection idle-in-transaction for the full timeout, starving the pool
 * and 503-ing every route (#1105 class; observed in US prod as
 * `withDbAccessContext (scope=partner) held a pooled connection … for 10004ms`,
 * against a pool sized by DB_POOL_MAX — 35 on US prod in 2026-08, repo default
 * 30). Note the costly case is a CONNECTED-BUT-SILENT agent, not an offline one:
 * `sendCommandToAgentAwaitResult` returns immediately when the agent has no live
 * WS, so an offline device never reaches the timer at all.
 *
 * `runOutsideDbContext` here is NOT harmless redundancy — its safety is
 * conditional on that registration. Exiting the ALS store and opening a fresh
 * context while an OUTER transaction is still held is precisely the shape that
 * caused the 2026-07-24 US prod outage (see SELF_MANAGED_DB_CONTEXT_ACTIONS in
 * middleware/agentAuth.ts): `runOutsideDbContext` does not release the outer
 * transaction, so every agent poll held TWO pooled connections at once and the
 * pool self-deadlocked — all slots pinned by outer transactions parked
 * idle-in-transaction waiting for an inner connection.
 *
 * So: with the route registered there is no outer transaction, and this call
 * only guarantees `withDbAccessContext` opens a genuinely fresh, correctly-scoped
 * context instead of silently reusing an ambient store. If this route were ever
 * REMOVED from `SELF_MANAGED_DB_CONTEXT_ROUTES`, this helper would flip from
 * redundant to actively harmful — doubling connection usage per request rather
 * than merely failing to help. Keep the two in sync; do not "clean up" one
 * without the other.
 *
 * Tenant scoping is preserved exactly: the context is rebuilt from the request's
 * own `AuthContext` via `dbAccessContextFromAuth` → `buildDbAccessContext`, the
 * same single source of truth `authMiddleware` uses. This is deliberately NOT a
 * system context — that would widen a user-facing read past RLS.
 */
function withLiveSessionsDbContext<T>(auth: AuthContext, fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withDbAccessContext(dbAccessContextFromAuth(auth), fn));
}

// Exported for tests. Agents return structured command output as a JSON string
// in CommandResult.Stdout; malformed individual entries are dropped, a fully
// malformed payload yields [] (the dialog shows "no sessions" rather than 500).
export function parseLiveSessionsStdout(stdout: string | undefined): LiveSessionItem[] {
  if (!stdout) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return [];
  }
  const list = (raw as { sessions?: unknown[] })?.sessions;
  if (!Array.isArray(list)) return [];
  const out: LiveSessionItem[] = [];
  for (const entry of list) {
    const parsed = liveSessionItemSchema.safeParse(entry);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

// Live WTS session enumeration straight from the agent (no DB persistence).
// Used by the RDS session pickers; distinct from /sessions/active, which reads
// the inventoried device_sessions rows and may be minutes stale.
sessionsRoutes.get(
  '/:id/sessions/live',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');

    // The ONLY DB work this handler does. It runs in its own short context,
    // which closes before the agent await below — so no pooled connection is
    // held across the up-to-10s wait.
    const device = await withLiveSessionsDbContext(auth, () =>
      getDeviceWithOrgAndSiteCheck(c, deviceId, auth)
    );
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    if (!device.agentId) return c.json({ error: 'Device has no enrolled agent' }, 409);

    const awaitResult = await sendCommandToAgentAwaitResult(
      device.agentId,
      { id: `list-sessions-${randomUUID()}`, type: 'list_sessions', payload: {} },
      LIST_SESSIONS_TIMEOUT_MS,
    );

    if (awaitResult.status !== 'completed') {
      const err = awaitResult.error ?? 'agent did not respond';
      return c.json({ error: err }, /timeout/i.test(err) ? 504 : 502);
    }

    return c.json({ data: { deviceId, sessions: parseLiveSessionsStdout(awaitResult.stdout) } });
  }
);

sessionsRoutes.get(
  '/:id/sessions/history',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', historyQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');
    const query = c.req.valid('query');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const limit = parsePositiveInt(query.limit, 100, 1, 500);
    const daysBack = parsePositiveInt(query.daysBack, 30, 1, 365);
    const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);

    const history = await db
      .select({
        id: deviceSessions.id,
        username: deviceSessions.username,
        sessionType: deviceSessions.sessionType,
        osSessionId: deviceSessions.osSessionId,
        loginAt: deviceSessions.loginAt,
        logoutAt: deviceSessions.logoutAt,
        durationSeconds: deviceSessions.durationSeconds,
        idleMinutes: deviceSessions.idleMinutes,
        activityState: deviceSessions.activityState,
        loginPerformanceSeconds: deviceSessions.loginPerformanceSeconds,
        isActive: deviceSessions.isActive,
      })
      .from(deviceSessions)
      .where(
        and(
          eq(deviceSessions.deviceId, deviceId),
          or(
            gte(deviceSessions.loginAt, since),
            gte(deviceSessions.updatedAt, since)
          )
        )
      )
      .orderBy(desc(deviceSessions.loginAt))
      .limit(limit);

    return c.json({
      data: {
        deviceId,
        daysBack,
        count: history.length,
        sessions: history,
      },
    });
  }
);

sessionsRoutes.get(
  '/:id/sessions/experience',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', experienceQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');
    const query = c.req.valid('query');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const daysBack = parsePositiveInt(query.daysBack, 30, 1, 365);
    const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);

    const sessions = await db
      .select({
        username: deviceSessions.username,
        loginAt: deviceSessions.loginAt,
        logoutAt: deviceSessions.logoutAt,
        durationSeconds: deviceSessions.durationSeconds,
        idleMinutes: deviceSessions.idleMinutes,
        loginPerformanceSeconds: deviceSessions.loginPerformanceSeconds,
        activityState: deviceSessions.activityState,
        isActive: deviceSessions.isActive,
      })
      .from(deviceSessions)
      .where(
        and(
          eq(deviceSessions.deviceId, deviceId),
          gte(deviceSessions.loginAt, since)
        )
      )
      .orderBy(desc(deviceSessions.loginAt));

    const durationSamples = sessions
      .map((session) => session.durationSeconds)
      .filter((value): value is number => typeof value === 'number' && value >= 0);
    const loginPerfSamples = sessions
      .map((session) => session.loginPerformanceSeconds)
      .filter((value): value is number => typeof value === 'number' && value >= 0);
    const idleSamples = sessions
      .map((session) => session.idleMinutes)
      .filter((value): value is number => typeof value === 'number' && value >= 0);

    const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

    const byUser = new Map<string, { sessions: number; active: number; totalDuration: number; durationSamples: number }>();
    for (const session of sessions) {
      const current = byUser.get(session.username) ?? { sessions: 0, active: 0, totalDuration: 0, durationSamples: 0 };
      current.sessions += 1;
      if (session.isActive) current.active += 1;
      if (typeof session.durationSeconds === 'number' && session.durationSeconds >= 0) {
        current.totalDuration += session.durationSeconds;
        current.durationSamples += 1;
      }
      byUser.set(session.username, current);
    }

    const perUser = Array.from(byUser.entries())
      .map(([username, stats]) => ({
        username,
        sessionCount: stats.sessions,
        activeCount: stats.active,
        avgSessionDurationSeconds: stats.durationSamples > 0
          ? Math.round(stats.totalDuration / stats.durationSamples)
          : null,
      }))
      .sort((left, right) => right.sessionCount - left.sessionCount);

    const trend = sessions
      .filter((session) => typeof session.loginPerformanceSeconds === 'number')
      .slice(0, 50)
      .map((session) => ({
        loginAt: session.loginAt,
        username: session.username,
        loginPerformanceSeconds: session.loginPerformanceSeconds,
      }));

    const [activeCounts] = await db
      .select({
        active: sql<number>`count(*) filter (where ${deviceSessions.isActive} = true)`,
        total: sql<number>`count(*)`,
      })
      .from(deviceSessions)
      .where(eq(deviceSessions.deviceId, deviceId));

    return c.json({
      data: {
        deviceId,
        daysBack,
        totals: {
          sessions: sessions.length,
          currentlyActive: Number(activeCounts?.active ?? 0),
          totalRows: Number(activeCounts?.total ?? 0),
        },
        averages: {
          sessionDurationSeconds: durationSamples.length > 0 ? Math.round(sum(durationSamples) / durationSamples.length) : null,
          loginPerformanceSeconds: loginPerfSamples.length > 0 ? Math.round(sum(loginPerfSamples) / loginPerfSamples.length) : null,
          idleMinutes: idleSamples.length > 0 ? Math.round(sum(idleSamples) / idleSamples.length) : null,
        },
        perUser,
        loginPerformanceTrend: trend,
      },
    });
  }
);
