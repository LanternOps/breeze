import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { devices, deviceEventLogs } from '../../db/schema';
import { writeAuditEvent } from '../../services/auditEvents';
import { getRedis } from '../../services/redis';
import { rateLimiter } from '../../services/rate-limit';
import { submitEventLogsSchema } from './schemas';
import { getDeviceEventLogSettings, EVENT_LOG_DEFAULTS, sanitizeTimestamp, type EventLogSettings } from './helpers';
import { enqueueLogForwarding } from '../../jobs/logForwardingWorker';
import { getOrgForwardingConfig } from '../../services/logForwarding';
import { requireAgentRole } from '../../middleware/requireAgentRole';

const LEVEL_ORDER: Record<string, number> = {
  info: 0,
  warning: 1,
  error: 2,
  critical: 3,
};
const MAX_EVENT_LOG_FUTURE_SKEW_MS = 10 * 60 * 1000;

interface NormalizedEventLog {
  timestamp: Date;
  originalTimestamp?: string;
  timestampClamped: boolean;
}

function normalizeEventLogTimestamp(value: unknown, receivedAt: Date): NormalizedEventLog {
  const parsed = sanitizeTimestamp(value);
  if (!parsed) {
    return { timestamp: receivedAt, timestampClamped: false };
  }

  if (parsed.getTime() > receivedAt.getTime() + MAX_EVENT_LOG_FUTURE_SKEW_MS) {
    return {
      timestamp: receivedAt,
      originalTimestamp: typeof value === 'string' ? value : undefined,
      timestampClamped: true,
    };
  }

  return { timestamp: parsed, timestampClamped: false };
}

function mergeEventDetails(
  details: Record<string, unknown> | undefined,
  normalized: NormalizedEventLog
): Record<string, unknown> | null {
  if (!normalized.timestampClamped) {
    return details || null;
  }

  return {
    ...(details || {}),
    originalTimestamp: normalized.originalTimestamp,
    timestampClamped: true,
  };
}

export const eventLogsRoutes = new Hono();
// Event-log ingest is the main agent's job; reject watchdog-role tokens so a
// weaker credential can't falsify operator-facing event-log posture (F8).
eventLogsRoutes.use('*', requireAgentRole);

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

  const now = new Date();
  const rows = filteredEvents.map((event: any) => {
    const normalized = normalizeEventLogTimestamp(event.timestamp, now);
    return {
      deviceId: device.id,
      orgId: device.orgId,
      timestamp: normalized.timestamp,
      level: event.level,
      category: event.category,
      source: event.source,
      eventId: event.eventId || null,
      message: event.message,
      details: mergeEventDetails(event.details, normalized)
    };
  });

  // Key matching the device_event_logs_dedup_idx axes (deviceId is constant
  // per request) so forwarding can be gated on rows that actually inserted.
  const eventLogRowKey = (source: string, eventId: string | null, ts: Date) =>
    `${source}|${eventId ?? ''}|${ts.toISOString()}`;

  let inserted = 0;
  let insertError: unknown = null;
  const insertedKeys = new Set<string>();
  try {
    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100);
      // .returning() reveals which rows actually inserted vs. hit the
      // device_event_logs_dedup_idx conflict. Agents deliberately re-submit a
      // window after a sub-collector failure (#2390 retry semantics), so
      // duplicates are expected — they must be absorbed here, not re-forwarded
      // to the org's SIEM below.
      const insertedRows = await db.insert(deviceEventLogs).values(batch).onConflictDoNothing().returning({
        source: deviceEventLogs.source,
        eventId: deviceEventLogs.eventId,
        timestamp: deviceEventLogs.timestamp,
      });
      inserted += insertedRows.length;
      for (const r of insertedRows) {
        insertedKeys.add(eventLogRowKey(r.source, r.eventId, r.timestamp));
      }
    }
  } catch (err) {
    insertError = err;
    console.error(`[EventLogs] Error batch inserting events for device ${device.id}:`, err);
  }

  // Enqueue for log forwarding if org has it configured — only the events
  // that actually inserted (duplicates from agent retry passes are skipped).
  if (!insertError && insertedKeys.size > 0) {
    try {
      const fwdConfig = await getOrgForwardingConfig(device.orgId);
      if (fwdConfig) {
        const forwardEvents = filteredEvents.flatMap((event: any, index: number) => {
          const row = rows[index];
          if (!row || !insertedKeys.has(eventLogRowKey(row.source, row.eventId, row.timestamp))) {
            return [];
          }
          return [{
            category: event.category,
            level: event.level,
            source: event.source,
            message: event.message,
            timestamp: row.timestamp.toISOString(),
            // The agent's structured per-event context lives in `details`
            // (see submitEventLogsSchema). The forward payload historically
            // read `event.rawData`, a field the schema strips — so it was
            // always `undefined` and nothing reached the SIEM. Forward the
            // persisted `row.details` so the SIEM matches what was stored
            // (including any timestamp-clamp provenance); the worker re-caps
            // it to 16KB before shipping. `null` (no details) is normalized
            // to `undefined` so the field is omitted rather than sent empty.
            details: row.details ?? undefined,
          }];
        });
        if (forwardEvents.length > 0) {
          await enqueueLogForwarding({
            orgId: device.orgId,
            deviceId: device.id,
            hostname: device.hostname,
            events: forwardEvents,
          });
        }
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
