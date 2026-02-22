import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { devices, deviceEventLogs } from '../../db/schema';
import { writeAuditEvent } from '../../services/auditEvents';
import { getRedis } from '../../services/redis';
import { rateLimiter } from '../../services/rate-limit';
import { submitEventLogsSchema } from './schemas';
import { getDeviceEventLogSettings, EVENT_LOG_DEFAULTS, type EventLogSettings } from './helpers';
import { enqueueLogForwarding } from '../../jobs/logForwardingWorker';
import { getOrgForwardingConfig } from '../../services/logForwarding';

const LEVEL_ORDER: Record<string, number> = {
  info: 0,
  warning: 1,
  error: 2,
  critical: 3,
};

export const eventLogsRoutes = new Hono();

eventLogsRoutes.put('/:id/eventlogs', zValidator('json', submitEventLogsSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');
  const agent = c.get('agent') as { orgId?: string; agentId?: string } | undefined;

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  if (data.events.length === 0) {
    return c.json({ success: true, count: 0, filtered: 0 });
  }

  // Resolve org-level event_log policy settings
  let settings: EventLogSettings | null;
  try {
    settings = await getDeviceEventLogSettings(device.id);
  } catch (err) {
    console.error(`[EventLogs] Failed to resolve settings for device ${device.id}, using conservative defaults:`, err);
    settings = EVENT_LOG_DEFAULTS;
  }

  // Filter events by minimum level
  const minLevel = settings ? LEVEL_ORDER[settings.minimumLevel] ?? 0 : 0;
  const filteredEvents = minLevel > 0
    ? data.events.filter((event: any) => (LEVEL_ORDER[event.level] ?? 0) >= minLevel)
    : data.events;

  const filteredCount = data.events.length - filteredEvents.length;

  if (filteredEvents.length === 0) {
    return c.json({ success: true, count: 0, filtered: filteredCount });
  }

  // Rate limit check (after filtering, so we check against actual insert count)
  if (settings) {
    const redis = getRedis();
    const rateCheck = await rateLimiter(
      redis,
      `eventlog:rate:device:${device.id}`,
      settings.rateLimitPerHour,
      3600,
      filteredEvents.length,
    );
    if (!rateCheck.allowed) {
      return c.json({
        error: 'Rate limit exceeded',
        remaining: rateCheck.remaining,
        resetAt: rateCheck.resetAt.toISOString(),
      }, 429);
    }
  }

  const rows = filteredEvents.map((event: any) => ({
    deviceId: device.id,
    orgId: device.orgId,
    timestamp: new Date(event.timestamp),
    level: event.level,
    category: event.category,
    source: event.source,
    eventId: event.eventId || null,
    message: event.message,
    details: event.details || null
  }));

  let inserted = 0;
  let insertError: unknown = null;
  try {
    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100);
      await db.insert(deviceEventLogs).values(batch).onConflictDoNothing();
      inserted += batch.length;
    }
  } catch (err) {
    insertError = err;
    console.error(`[EventLogs] Error batch inserting events for device ${device.id}:`, err);
  }

  // Enqueue for log forwarding if org has it configured
  if (!insertError) {
    try {
      const fwdConfig = await getOrgForwardingConfig(device.orgId);
      if (fwdConfig) {
        await enqueueLogForwarding({
          orgId: device.orgId,
          deviceId: device.id,
          hostname: device.hostname,
          events: filteredEvents.map((e: any) => ({
            category: e.category,
            level: e.level,
            source: e.source,
            message: e.message,
            timestamp: e.timestamp,
            rawData: e.rawData,
          })),
        });
      }
    } catch (fwdErr) {
      console.warn(`[EventLogs] Failed to enqueue for forwarding:`, fwdErr);
    }
  }

  writeAuditEvent(c, {
    orgId: agent?.orgId ?? device.orgId,
    actorType: 'agent',
    actorId: agent?.agentId ?? agentId,
    action: 'agent.eventlogs.submit',
    resourceType: 'device',
    resourceId: device.id,
    details: {
      submittedCount: data.events.length,
      insertedCount: inserted,
      filteredCount,
    },
  });

  if (insertError) {
    return c.json({
      success: false,
      error: 'Partial insert failure',
      count: inserted,
      filtered: filteredCount,
      expectedCount: rows.length,
    }, 500);
  }

  return c.json({ success: true, count: inserted, filtered: filteredCount });
});
