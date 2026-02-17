import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { devices, deviceSessions } from '../../db/schema';
import { writeAuditEvent } from '../../services/auditEvents';
import { publishEvent } from '../../services/eventBus';
import { parseDate } from './helpers';
import type { AgentContext } from './helpers';

export const sessionsRoutes = new Hono();

const sessionTypeSchema = z.enum(['console', 'rdp', 'ssh', 'other']);
const sessionActivityStateSchema = z.enum(['active', 'idle', 'locked', 'away', 'disconnected']);
const sessionEventTypeSchema = z.enum(['login', 'logout', 'lock', 'unlock', 'switch']);

const submitSessionsSchema = z.object({
  sessions: z.array(z.object({
    username: z.string().min(1).max(255),
    sessionType: sessionTypeSchema,
    sessionId: z.string().max(128).optional(),
    loginAt: z.string().optional(),
    idleMinutes: z.number().int().min(0).max(10080).optional(),
    activityState: sessionActivityStateSchema.optional(),
    loginPerformanceSeconds: z.number().int().min(0).max(36000).optional(),
    isActive: z.boolean().optional(),
    lastActivityAt: z.string().optional(),
  })).max(128).default([]),
  events: z.array(z.object({
    type: sessionEventTypeSchema,
    username: z.string().min(1).max(255),
    sessionType: sessionTypeSchema,
    sessionId: z.string().max(128).optional(),
    timestamp: z.string().optional(),
    activityState: sessionActivityStateSchema.optional(),
  })).max(256).optional(),
  collectedAt: z.string().optional(),
});

function getSessionIdentityKey(input: {
  username: string;
  sessionType: string;
  osSessionId: string | null;
}): string {
  return `${input.username.toLowerCase()}::${input.sessionType}::${input.osSessionId ?? ''}`;
}

sessionsRoutes.put('/:id/sessions', zValidator('json', submitSessionsSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');
  const agent = c.get('agent') as AgentContext | undefined;

  const [device] = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      hostname: devices.hostname,
    })
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  const now = new Date();
  const activeSessions = data.sessions.filter((session) => session.isActive !== false);

  await db.transaction(async (tx) => {
    const existingActive = await tx
      .select({
        id: deviceSessions.id,
        username: deviceSessions.username,
        sessionType: deviceSessions.sessionType,
        osSessionId: deviceSessions.osSessionId,
        loginAt: deviceSessions.loginAt,
      })
      .from(deviceSessions)
      .where(
        and(
          eq(deviceSessions.deviceId, device.id),
          eq(deviceSessions.isActive, true)
        )
      );

    const existingByKey = new Map(
      existingActive.map((row) => [
        getSessionIdentityKey({
          username: row.username,
          sessionType: row.sessionType,
          osSessionId: row.osSessionId ?? null,
        }),
        row,
      ])
    );
    const seenKeys = new Set<string>();

    for (const session of activeSessions) {
      const osSessionId = session.sessionId ?? null;
      const key = getSessionIdentityKey({
        username: session.username,
        sessionType: session.sessionType,
        osSessionId,
      });
      seenKeys.add(key);

      const loginAt = parseDate(session.loginAt) ?? now;
      const lastActivityAt = parseDate(session.lastActivityAt) ?? now;
      const existing = existingByKey.get(key);

      if (!existing) {
        await tx
          .insert(deviceSessions)
          .values({
            orgId: device.orgId,
            deviceId: device.id,
            username: session.username,
            sessionType: session.sessionType,
            osSessionId,
            loginAt,
            idleMinutes: session.idleMinutes ?? 0,
            activityState: session.activityState ?? 'active',
            loginPerformanceSeconds: session.loginPerformanceSeconds ?? null,
            isActive: true,
            lastActivityAt,
            updatedAt: now,
          });
        continue;
      }

      await tx
        .update(deviceSessions)
        .set({
          idleMinutes: session.idleMinutes ?? 0,
          activityState: session.activityState ?? 'active',
          loginPerformanceSeconds: session.loginPerformanceSeconds ?? null,
          isActive: true,
          lastActivityAt,
          updatedAt: now,
        })
        .where(eq(deviceSessions.id, existing.id));
    }

    for (const stale of existingActive) {
      const key = getSessionIdentityKey({
        username: stale.username,
        sessionType: stale.sessionType,
        osSessionId: stale.osSessionId ?? null,
      });
      if (seenKeys.has(key)) {
        continue;
      }

      const durationSeconds = Math.max(0, Math.floor((now.getTime() - stale.loginAt.getTime()) / 1000));
      await tx
        .update(deviceSessions)
        .set({
          isActive: false,
          logoutAt: now,
          durationSeconds,
          activityState: 'disconnected',
          updatedAt: now,
        })
        .where(eq(deviceSessions.id, stale.id));
    }
  });

  const events = data.events ?? [];
  for (const event of events) {
    if (event.type !== 'login' && event.type !== 'logout') {
      continue;
    }

    const eventType = event.type === 'login' ? 'session.login' : 'session.logout';
    try {
      await publishEvent(
        eventType,
        device.orgId,
        {
          deviceId: device.id,
          hostname: device.hostname,
          username: event.username,
          sessionType: event.sessionType,
          sessionId: event.sessionId ?? null,
          activityState: event.activityState ?? null,
          timestamp: event.timestamp ?? now.toISOString(),
        },
        'agent'
      );
    } catch (err) {
      console.error(`[agents] failed to publish ${eventType} for ${device.id}:`, err);
    }
  }

  writeAuditEvent(c, {
    orgId: agent?.orgId ?? device.orgId,
    actorType: 'agent',
    actorId: agent?.agentId ?? agentId,
    action: 'agent.sessions.submit',
    resourceType: 'device',
    resourceId: device.id,
    details: {
      activeSessions: activeSessions.length,
      events: events.length,
    },
  });

  return c.json({
    success: true,
    activeSessions: activeSessions.length,
    events: events.length,
  });
});
