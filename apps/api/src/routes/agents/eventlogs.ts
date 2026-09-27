import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { devices, deviceEventLogs } from '../../db/schema';
import { writeAuditEvent } from '../../services/auditEvents';
import { recordAgentIngestSubmission } from '../metrics';
import { getRedis } from '../../services/redis';
import { rateLimiter } from '../../services/rate-limit';
import { submitEventLogsSchema } from './schemas';
import { getDeviceEventLogSettings, EVENT_LOG_DEFAULTS, sanitizeTimestamp, type EventLogSettings } from './helpers';
import { enqueueLogForwarding } from '../../jobs/logForwardingWorker';
import { getOrgForwardingConfig } from '../../services/logForwarding';
import { requireAgentRole } from '../../middleware/requireAgentRole';
import { captureException } from '../../services/sentry';

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

interface ForwardEvent {
  category: string;
  level: string;
  source: string;
  message: string;
  timestamp: string;
  details: unknown;
}

type EventLookupResult =
  | { ok: true; deviceId: string; deviceOrgId: string; hostname: string; settings: EventLogSettings | null }
  | { ok: false };

interface InsertPhaseResult {
  inserted: number;
  insertError: unknown;
  // null = nothing to forward (not configured, no rows inserted, or the
  // config/compute step itself failed — see the catch below).
  forwardEvents: ForwardEvent[] | null;
}

export const eventLogsRoutes = new Hono();
// Event-log ingest is the main agent's job; reject watchdog-role tokens so a
// weaker credential can't falsify operator-facing event-log posture (F8).
eventLogsRoutes.use('*', requireAgentRole);

eventLogsRoutes.put('/:id/eventlogs', zValidator('json', submitEventLogsSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');
  const agent = c.get('agent') as { orgId?: string; agentId?: string; partnerId?: string } | undefined;

  // Fail fast on a token that authenticated but carries no org. Building a
  // vacuous org-scoped RLS context (orgId '', accessibleOrgIds []) would make
  // every lookup below RLS-deny and masquerade as a 404 with no signal.
  if (!agent?.orgId) {
    console.error(`[EventLogs] eventlogs submit with no org context agent=${agentId}`);
    captureException(new Error('eventlogs ingest missing agent orgId'));
    return c.json({ error: 'Agent context missing organization' }, 401);
  }
  const orgId = agent.orgId;

  // #1105 / #6097 — `eventlogs` is in SELF_MANAGED_DB_CONTEXT_ACTIONS
  // (agentAuth.ts), so agentAuthMiddleware does NOT open a request-long
  // withDbAccessContext around this handler. `runOutsideDbContext` alone
  // cannot fix that hold — it only swaps which `db` proxy target the
  // AsyncLocalStorage points at; the OUTER `baseDb.transaction` the middleware
  // opens is what pins the pooled connection, and only an opted-out route can
  // avoid ever opening it. So this route holds two SHORT org-scoped contexts
  // of its own — one around the device/settings read, one around the insert +
  // forwarding-config read — with the Redis-only rate-limit check and the
  // BullMQ forwarding enqueue running in the gaps, genuinely outside any open
  // transaction (not just outside the ALS store).
  const dbContext = {
    scope: 'organization' as const,
    orgId,
    accessibleOrgIds: [orgId],
    // Partner-AXIS access (breeze_has_partner_access → writes) stays empty.
    accessiblePartnerIds: [],
    // #4673 W02 — self-managed context, so the partner id must be carried
    // from the agent context explicitly (see heartbeat.ts / reliability.ts).
    // Read-only visibility of this device's own MSP partner-wide rows; feeds
    // getOrgForwardingConfig's readWithPartnerAxisVisibility escape below.
    currentPartnerId: agent.partnerId ?? null,
  };

  if (data.events.length === 0) {
    return c.json({ success: true, count: 0, filtered: 0 });
  }

  // Phase 1 (short org-scoped context): resolve the device and its event_log
  // policy settings. getDeviceEventLogSettings does its own Redis cache
  // get/set plus, on a miss, a DB read across the config-policy hierarchy —
  // both need the device row and both need RLS visibility, so they stay
  // together in one context.
  const lookup = await withDbAccessContext(dbContext, async (): Promise<EventLookupResult> => {
    const [device] = await db
      .select()
      .from(devices)
      .where(eq(devices.agentId, agentId))
      .limit(1);

    if (!device) {
      return { ok: false };
    }

    let settings: EventLogSettings | null;
    try {
      settings = await getDeviceEventLogSettings(device.id);
    } catch (err) {
      console.error(`[EventLogs] Failed to resolve settings for device ${device.id}, using conservative defaults:`, err);
      settings = EVENT_LOG_DEFAULTS;
    }

    return { ok: true, deviceId: device.id, deviceOrgId: device.orgId, hostname: device.hostname, settings };
  });

  if (!lookup.ok) {
    return c.json({ error: 'Device not found' }, 404);
  }
  // deviceOrgId (the DB row's own org) is used for the inserted rows'
  // `orgId` column below; everywhere else (RLS context, forwarding config,
  // enqueue, audit) uses the agent-token `orgId` — mirrors reliability.ts's
  // discipline, which trusts the two to match (RLS made the lookup succeed
  // only because they did).
  const { deviceId, deviceOrgId, hostname, settings } = lookup;

  // Filter events by minimum level — pure, no DB/Redis, no context needed.
  const minLevel = settings ? LEVEL_ORDER[settings.minimumLevel] ?? 0 : 0;
  const filteredEvents = minLevel > 0
    ? data.events.filter((event: any) => (LEVEL_ORDER[event.level] ?? 0) >= minLevel)
    : data.events;

  const filteredCount = data.events.length - filteredEvents.length;

  if (filteredEvents.length === 0) {
    return c.json({ success: true, count: 0, filtered: filteredCount });
  }

  // Rate limit check (after filtering, so we check against actual insert
  // count) — outside phase 1's context, so this Redis round trip does not
  // pin the connection phase 1 just released.
  if (settings) {
    const redis = getRedis();
    const rateCheck = await rateLimiter(
      redis,
      `eventlog:rate:device:${deviceId}`,
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
  let timestampClampedCount = 0;
  const rows = filteredEvents.map((event: any) => {
    const normalized = normalizeEventLogTimestamp(event.timestamp, now);
    if (normalized.timestampClamped) timestampClampedCount++;
    return {
      deviceId,
      orgId: deviceOrgId,
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

  // Phase 2 (a fresh short org-scoped context): insert, then — only for rows
  // that actually inserted — read the org's forwarding config. Both need DB
  // access; the config read shares the request's RLS scope on purpose
  // (getOrgForwardingConfig self-manages the partner-axis escape for the
  // partner-owned destination override).
  const { inserted, insertError, forwardEvents } = await withDbAccessContext(
    dbContext,
    async (): Promise<InsertPhaseResult> => {
      let inserted = 0;
      let insertError: unknown = null;
      const insertedKeys = new Set<string>();
      try {
        for (let i = 0; i < rows.length; i += 100) {
          const batch = rows.slice(i, i + 100);
          // .returning() reveals which rows actually inserted vs. hit the
          // device_event_logs_dedup_idx conflict. Agents deliberately re-submit
          // a window after a sub-collector failure (#2390 retry semantics), so
          // duplicates are expected — they must be absorbed here, not
          // re-forwarded to the org's SIEM below.
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
        console.error(`[EventLogs] Error batch inserting events for device ${deviceId}:`, err);
        return { inserted, insertError, forwardEvents: null };
      }

      // Only the events that actually inserted (duplicates from agent retry
      // passes are skipped) — only if the org has forwarding configured.
      if (insertedKeys.size === 0) {
        return { inserted, insertError, forwardEvents: null };
      }

      try {
        const fwdConfig = await getOrgForwardingConfig(orgId);
        if (!fwdConfig) {
          return { inserted, insertError, forwardEvents: null };
        }
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
        return { inserted, insertError, forwardEvents };
      } catch (fwdErr) {
        console.warn(`[EventLogs] Failed to resolve forwarding config:`, fwdErr);
        return { inserted, insertError, forwardEvents: null };
      }
    },
  );

  // Enqueue for log forwarding — outside phase 2's context, so the BullMQ
  // round trip does not pin the connection phase 2 just released.
  if (forwardEvents && forwardEvents.length > 0) {
    try {
      await enqueueLogForwarding({
        orgId,
        deviceId,
        hostname,
        events: forwardEvents,
      });
    } catch (fwdErr) {
      console.warn(`[EventLogs] Failed to enqueue for forwarding:`, fwdErr);
    }
  }

  // #4340 — audit only an anomalous submit: an insert error or server-clamped
  // future timestamps. A routine submit (including one whose rows were all
  // absorbed as #2390 retry duplicates) is only counted; the events themselves
  // are the durable record in device_event_logs.
  //
  // writeAuditEvent self-manages its own DB context (services/auditEvents.ts
  // → auditService.ts persistAuditLog), so it is safe to call with none open.
  recordAgentIngestSubmission(
    'eventlogs',
    insertError ? (inserted > 0 ? 'partial' : 'failed') : 'success',
  );
  if (insertError || timestampClampedCount > 0) {
    writeAuditEvent(c, {
      orgId,
      actorType: 'agent',
      actorId: agent.agentId ?? agentId,
      action: 'agent.eventlogs.submit',
      resourceType: 'device',
      resourceId: deviceId,
      result: insertError ? 'failure' : 'success',
      details: {
        submittedCount: data.events.length,
        insertedCount: inserted,
        filteredCount,
        ...(timestampClampedCount > 0 ? { timestampClampedCount } : {}),
      },
    });
  }

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
