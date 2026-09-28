import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { bodyLimitOnError, reportBodyLimitRejection } from '../../middleware/bodyLimitGate';
import { z } from 'zod';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';

// Async gunzip: a synchronous inflate blocks the event loop for every OTHER
// agent's request for the duration of the decompression, which is worst
// exactly when a request is large (the case this is meant to bound).
const gunzipAsync = promisify(gunzip);
import { db } from '../../db';
import { devices, agentLogs } from '../../db/schema';
import { redactAgentLogFields, redactAgentLogMessage } from '../../services/logRedaction';
import { writeAuditEvent } from '../../services/auditEvents';
import { getRedis } from '../../services/redis';
import { checkAndConsumeIngestQuota } from '../../services/ingestQuota';
import { envInt } from '../../utils/envInt';
import { recordAgentIngestSubmission } from '../metrics';

export const logsRoutes = new Hono();

/**
 * Daily per-device / per-org row+byte ingest budgets (issue: no quota beyond
 * the 200-rows-per-request cap and the per-minute request-count limiters, so
 * an admitted device can still sustain tens of millions of rows and tens of
 * GB/day against shared Postgres disk/WAL/backups). Sized well above a
 * legitimate agent's built-in shipper ceiling (500 entries/60s, i.e. at most
 * ~720k rows/day if it somehow ran flat-out forever) and well below what the
 * per-request/per-minute limiters would otherwise admit.
 */
const AGENT_LOG_MAX_ROWS_PER_DEVICE_PER_DAY = envInt('AGENT_LOG_MAX_ROWS_PER_DEVICE_PER_DAY', 2_000_000);
const AGENT_LOG_MAX_BYTES_PER_DEVICE_PER_DAY = envInt('AGENT_LOG_MAX_BYTES_PER_DEVICE_PER_DAY', 500 * 1024 * 1024);
const AGENT_LOG_MAX_ROWS_PER_ORG_PER_DAY = envInt('AGENT_LOG_MAX_ROWS_PER_ORG_PER_DAY', 20_000_000);
const AGENT_LOG_MAX_BYTES_PER_ORG_PER_DAY = envInt('AGENT_LOG_MAX_BYTES_PER_ORG_PER_DAY', 5 * 1024 * 1024 * 1024);

// Agent Diagnostic Log Shipping
//
// Limits are layered to bound the worst-case impact of a single request:
//   - bodyLimit (256KB pre-gunzip): cap the on-the-wire payload from a single
//     misbehaving agent so it can't dump megabytes per call.
//   - gunzip maxOutputLength (10MB): defense-in-depth against zip-bomb-style
//     decompressed inflation; legitimate batches of 200 small entries stay
//     well under this ceiling.
//   - max(logs)=200: cap rows per request. Combined with the agent's ~60s
//     ship interval and a 1-2s typical processing budget, this still scales
//     to ~200 logs/min/agent, which is 5-10x the realistic steady-state rate.
const LOG_BATCH_MAX_BODY_BYTES = 256 * 1024;
const LOG_BATCH_TOO_LARGE = 'Log batch too large (max 256KB gzipped)';
// Match the event-log ingest boundary: modest positive clock skew is useful
// event evidence, but an agent must not place records arbitrarily far into the
// future. Receipt time remains the authoritative lifecycle/recency clock.
const MAX_AGENT_LOG_FUTURE_SKEW_MS = 10 * 60 * 1000;

/**
 * #7067 — `devices.last_log_at` throttle. This route is the hottest ingest
 * path per device (up to once a minute), so it must not cost a write on every
 * batch just to record "still shipping". Only move the column when it has
 * drifted by at least this much — a conditional UPDATE, not a read-then-write,
 * so it stays race-safe under concurrent requests for the same device.
 */
const DEVICE_LAST_LOG_AT_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Remove the two server-authored clamp-provenance keys from redacted agent
 * fields.
 *
 * `redactAgentLogFields` redacts *values* but preserves unknown *keys*
 * verbatim, so without this an agent could ship `timestampClamped: true` /
 * `originalTimestamp: <anything>` on an ordinary in-window row and forge
 * provenance the server never wrote. Both keys are stripped unconditionally
 * here; only the clamp branch in the ingest handler re-adds them.
 */
function stripClampProvenance(fields: unknown): unknown {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return fields;
  const copy = { ...(fields as Record<string, unknown>) };
  delete copy.timestampClamped;
  delete copy.originalTimestamp;
  return copy;
}

const agentLogEntrySchema = z.object({
  timestamp: z.string().datetime({ offset: true }),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  component: z.string().max(100),
  message: z.string().max(10000),
  fields: z.record(z.string(), z.any()).optional().refine(
    (val) => !val || JSON.stringify(val).length <= 32000,
    { message: 'fields object too large (max 32KB)' }
  ),
  agentVersion: z.string().max(50).optional(),
});

const agentLogIngestSchema = z.object({
  logs: z.array(agentLogEntrySchema).max(200),
});

logsRoutes.post(
  '/:id/logs',
  bodyLimit({
    maxSize: LOG_BATCH_MAX_BODY_BYTES,
    // #3517: report the rejection — this limit is tighter than the global gate,
    // so the instrumented gate never sees it.
    onError: bodyLimitOnError('agent-logs', LOG_BATCH_MAX_BODY_BYTES, LOG_BATCH_TOO_LARGE),
  }),
  async (c) => {
  const agentId = c.req.param('id');
  let body: unknown;

  try {
    const raw = Buffer.from(await c.req.arrayBuffer());
    const encoding = c.req.header('content-encoding')?.toLowerCase() ?? '';
    const decoded = encoding.includes('gzip')
      ? await gunzipAsync(raw, { maxOutputLength: 10 * 1024 * 1024 }) // 10MB decompressed cap (defense-in-depth)
      : raw;
    body = JSON.parse(decoded.toString('utf-8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Vestigial/defensive: kept so an oversize body can never be reported as a
    // generic 400. Under the pinned hono, `bodyLimit()` returns `onError(c)`
    // directly on BOTH the Content-Length and the streaming leg and never
    // throws, so this branch is unreachable today and `BodyLimitError` is
    // defined nowhere in the tree. It only fires if a future hono reinstates a
    // throwing path — hence the report, which keeps the 413 visible (#3517)
    // rather than silently regressing to the pre-#3517 behaviour.
    if (err instanceof Error && err.name === 'BodyLimitError') {
      reportBodyLimitRejection(c, 'agent-logs', LOG_BATCH_MAX_BODY_BYTES);
      return c.json({ error: LOG_BATCH_TOO_LARGE }, 413);
    }
    console.error(`[AgentLogs] Failed to decode request body for agent ${agentId}:`, message);
    return c.json({ error: 'Failed to decode request body', detail: message }, 400);
  }

  const parsed = agentLogIngestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: 'Invalid request body',
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
      400
    );
  }
  const data = parsed.data;

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  if (data.logs.length === 0) {
    return c.json({ received: 0 }, 200);
  }

  const receivedAt = new Date();
  let timestampClampedCount = 0;
  const rows = data.logs.map((log: any) => {
    const reportedTimestamp = new Date(log.timestamp);
    const timestampClamped = reportedTimestamp.getTime()
      > receivedAt.getTime() + MAX_AGENT_LOG_FUTURE_SKEW_MS;
    if (timestampClamped) timestampClampedCount++;
    const redactedFields = log.fields
      ? stripClampProvenance(redactAgentLogFields(log.fields))
      : null;

    return {
      deviceId: device.id,
      orgId: device.orgId,
      timestamp: timestampClamped ? receivedAt : reportedTimestamp,
      level: log.level,
      component: log.component,
      // Ingest and every read path share one rule set — see redactAgentLogRow (#3109).
      message: redactAgentLogMessage(log.message),
      fields: timestampClamped
        ? {
            ...(redactedFields || {}),
            // Server-authored keys; the agent's own copies were stripped above.
            originalTimestamp: log.timestamp,
            timestampClamped: true,
          }
        : redactedFields,
      agentVersion: log.agentVersion || null,
    };
  });

  // Daily row/byte ingest budget, checked before the batch is written. Bytes
  // are the stored (redacted) row shape, not the wire payload — what actually
  // lands on disk is what the budget is protecting.
  const batchBytes = Buffer.byteLength(JSON.stringify(rows), 'utf-8');
  const redis = getRedis();
  const [deviceQuota, orgQuota] = await Promise.all([
    checkAndConsumeIngestQuota({
      redis,
      prefix: 'agent_logs',
      scope: 'device',
      id: device.id,
      rows: rows.length,
      bytes: batchBytes,
      maxRows: AGENT_LOG_MAX_ROWS_PER_DEVICE_PER_DAY,
      maxBytes: AGENT_LOG_MAX_BYTES_PER_DEVICE_PER_DAY,
    }),
    checkAndConsumeIngestQuota({
      redis,
      prefix: 'agent_logs',
      scope: 'org',
      id: device.orgId,
      rows: rows.length,
      bytes: batchBytes,
      maxRows: AGENT_LOG_MAX_ROWS_PER_ORG_PER_DAY,
      maxBytes: AGENT_LOG_MAX_BYTES_PER_ORG_PER_DAY,
    }),
  ]);

  if (!deviceQuota.allowed || !orgQuota.allowed) {
    console.warn(
      `[AgentLogs] Daily ingest budget exceeded for device ${device.id} org ${device.orgId} `
      + `(device rows=${deviceQuota.rowsUsed} bytes=${deviceQuota.bytesUsed}, `
      + `org rows=${orgQuota.rowsUsed} bytes=${orgQuota.bytesUsed}) — dropping ${rows.length} row(s)`,
    );
    return c.json({ error: 'Daily log ingest budget exceeded', received: 0, dropped: rows.length }, 429);
  }

  let inserted = 0;
  try {
    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100);
      await db.insert(agentLogs).values(batch);
      inserted += batch.length;
    }
  } catch (err) {
    console.error(`[AgentLogs] Error batch inserting logs for device ${device.id}:`, err);
  }

  // #7067 — stamp the device's latest log-ingest time so "heartbeating but no
  // logs" becomes a queryable condition (isDeviceLogSilent, @breeze/shared)
  // instead of an absence. Throttled: skip the write entirely when the column
  // already moved within the last DEVICE_LAST_LOG_AT_THROTTLE_MS, so a
  // healthy device shipping every ~60s doesn't cost a write per batch.
  if (inserted > 0) {
    try {
      await db
        .update(devices)
        .set({ lastLogAt: receivedAt })
        .where(and(
          eq(devices.id, device.id),
          or(
            isNull(devices.lastLogAt),
            lt(devices.lastLogAt, new Date(receivedAt.getTime() - DEVICE_LAST_LOG_AT_THROTTLE_MS)),
          ),
        ));
    } catch (err) {
      console.error(`[AgentLogs] Failed to update last_log_at for device ${device.id}:`, err);
    }
  }

  // Content-free ingest audit (counts only, NO log message contents), written
  // ONLY for an anomalous batch: an insert shortfall (a swallowed insert error
  // still leaves a trail) or server-clamped future timestamps. Finding #9
  // (#2359) originally audited every batch; at one batch per device per minute
  // that receipt was ~57% of audit_logs (#4340), and the batch itself is
  // already durable evidence in agent_logs. Routine volume is counted in
  // breeze_agent_ingest_submissions_total instead.
  const agent = c.get('agent') as { orgId?: string; agentId?: string } | undefined;
  const partialFailure = rows.length - inserted;
  recordAgentIngestSubmission(
    'logs',
    partialFailure === 0 ? 'success' : inserted === 0 ? 'failed' : 'partial',
  );
  if (partialFailure > 0 || timestampClampedCount > 0) {
    writeAuditEvent(c, {
      orgId: agent?.orgId ?? device.orgId,
      actorType: 'agent',
      actorId: agent?.agentId ?? agentId,
      action: 'agent.logs.submit',
      resourceType: 'device',
      resourceId: device.id,
      result: partialFailure > 0 ? 'failure' : 'success',
      details: {
        submittedCount: data.logs.length,
        insertedCount: inserted,
        ...(timestampClampedCount > 0 ? { timestampClampedCount } : {}),
        ...(partialFailure > 0 ? { partialFailure } : {}),
      },
    });
  }

  if (inserted === 0 && rows.length > 0) {
    return c.json({ error: 'Failed to insert logs', received: 0 }, 500);
  }
  if (inserted < rows.length) {
    return c.json({ received: inserted, total: rows.length, partial: true }, 207);
  }
  return c.json({ received: inserted }, 201);
});
