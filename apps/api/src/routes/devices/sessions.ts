import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { and, desc, eq, gte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { deviceSessions } from '../../db/schema';
import { authMiddleware, requireScope } from '../../middleware/auth';
import { getDeviceWithOrgCheck } from './helpers';

export const sessionsRoutes = new Hono();

sessionsRoutes.use('*', authMiddleware);

const deviceIdParamSchema = z.object({
  id: z.string().uuid(),
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
  zValidator('param', deviceIdParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
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

sessionsRoutes.get(
  '/:id/sessions/history',
  requireScope('organization', 'partner', 'system'),
  zValidator('param', deviceIdParamSchema),
  zValidator('query', historyQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');
    const query = c.req.valid('query');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
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
  zValidator('param', deviceIdParamSchema),
  zValidator('query', experienceQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId } = c.req.valid('param');
    const query = c.req.valid('query');

    const device = await getDeviceWithOrgCheck(deviceId, auth);
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
