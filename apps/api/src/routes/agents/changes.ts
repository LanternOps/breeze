import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { devices, deviceChangeLog } from '../../db/schema';
import { requireAgentRole } from '../../middleware/requireAgentRole';
import { submitChangesSchema } from './schemas';
import { getRedis } from '../../services/redis';
import { checkAndConsumeIngestQuota } from '../../services/ingestQuota';
import { envInt } from '../../utils/envInt';

// Async gunzip: a synchronous inflate blocks the event loop for every OTHER
// agent's request for the duration of the decompression.
const gunzipAsync = promisify(gunzip);

export const changesRoutes = new Hono();

changesRoutes.use('*', requireAgentRole);

const MAX_CHANGES_BODY_BYTES = parseInt(process.env.CHANGE_INGEST_MAX_BODY_BYTES || String(5 * 1024 * 1024), 10);
const MAX_CHANGES_GZIP_OUTPUT_BYTES = parseInt(process.env.CHANGE_INGEST_MAX_DECOMPRESSED_BYTES || String(10 * 1024 * 1024), 10);

/**
 * Daily per-device / per-org row+byte ingest budgets — same gap and same fix
 * shape as `logs.ts`/`eventlogs.ts`: the 200-row-per-batch insert chunking and
 * the up-to-`CHANGE_INGEST_MAX_ITEMS` (50,000 default) per-request schema cap
 * bound a single request, but nothing bounds how many requests a day a device
 * or org can push, and this route has no per-minute request-rate limiter at
 * all (unlike logs/eventlogs). Config-change volume from a legitimate agent is
 * driven by the 15-minute inventory cadence (`sendConfigurationChanges` in
 * `agent/internal/heartbeat/heartbeat.go`) and is normally tiny — real
 * endpoint config churn, not a firehose — so these defaults are sized to
 * comfortably absorb a burst (e.g. catching up after being offline) while
 * still capping a misbehaving agent credential well below what the
 * per-request cap alone would otherwise admit indefinitely.
 */
const AGENT_CHANGES_MAX_ROWS_PER_DEVICE_PER_DAY = envInt('AGENT_CHANGES_MAX_ROWS_PER_DEVICE_PER_DAY', 500_000);
const AGENT_CHANGES_MAX_BYTES_PER_DEVICE_PER_DAY = envInt('AGENT_CHANGES_MAX_BYTES_PER_DEVICE_PER_DAY', 200 * 1024 * 1024);
const AGENT_CHANGES_MAX_ROWS_PER_ORG_PER_DAY = envInt('AGENT_CHANGES_MAX_ROWS_PER_ORG_PER_DAY', 5_000_000);
const AGENT_CHANGES_MAX_BYTES_PER_ORG_PER_DAY = envInt('AGENT_CHANGES_MAX_BYTES_PER_ORG_PER_DAY', 2 * 1024 * 1024 * 1024);

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue };

/**
 * Postgres rejects U+0000 in text (22021) and jsonb (22P05), and one bad value
 * aborts the whole 200-row insert batch — the agent then retries the identical
 * batch forever (#8020). Unlike the memory-inventory schema (`noNul` in
 * schemas.ts, which rejects), a change batch is stripped: rejecting would drop
 * every other valid change in the batch. Keys are stripped too.
 */
function stripNul<T>(value: T): T {
  if (typeof value === 'string') {
    return (value.includes('\u0000') ? value.replaceAll('\u0000', '') : value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripNul(item)) as T;
  }
  if (value !== null && typeof value === 'object') {
    // fromEntries defines own properties, so a literal "__proto__" key survives.
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [stripNul(k), stripNul(v)]),
    ) as T;
  }
  return value;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort((a, b) => a.localeCompare(b));
    const entries = keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${entries.join(',')}}`;
  }

  return JSON.stringify(String(value));
}

function computeChangeFingerprint(change: {
  timestamp: string;
  changeType: string;
  changeAction: string;
  subject: string;
  beforeValue?: JsonValue | null;
  afterValue?: JsonValue | null;
  details?: JsonValue | null;
}): string {
  const parsedTimestamp = new Date(change.timestamp);
  const canonicalTimestamp = Number.isNaN(parsedTimestamp.getTime())
    ? change.timestamp
    : parsedTimestamp.toISOString();
  const payload = [
    canonicalTimestamp,
    change.changeType,
    change.changeAction,
    change.subject,
    stableStringify(change.beforeValue ?? null),
    stableStringify(change.afterValue ?? null),
    stableStringify(change.details ?? null)
  ].join('|');
  return createHash('sha256').update(payload).digest('hex');
}

changesRoutes.put('/:id/changes', async (c) => {
  const agentId = c.req.param('id');
  let body: unknown;
  try {
    const raw = Buffer.from(await c.req.arrayBuffer());
    if (raw.length > MAX_CHANGES_BODY_BYTES) {
      return c.json({ error: 'Request body too large' }, 413);
    }

    const encoding = c.req.header('content-encoding')?.toLowerCase() ?? '';
    const decoded = encoding.includes('gzip')
      ? await gunzipAsync(raw, { maxOutputLength: MAX_CHANGES_GZIP_OUTPUT_BYTES })
      : raw;

    if (decoded.length > MAX_CHANGES_GZIP_OUTPUT_BYTES) {
      return c.json({ error: 'Decoded payload too large' }, 413);
    }

    body = JSON.parse(decoded.toString('utf-8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to decode request body', detail: message }, 400);
  }

  const parsed = submitChangesSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      error: 'Invalid request body',
      details: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message
      }))
    }, 400);
  }
  const data = { ...parsed.data, changes: stripNul(parsed.data.changes) };

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  if (data.changes.length === 0) {
    return c.json({ success: true, count: 0 });
  }

  const seenFingerprints = new Set<string>();
  const rows = [];
  for (const change of data.changes) {
    const fingerprint = computeChangeFingerprint(change);
    if (seenFingerprints.has(fingerprint)) {
      continue;
    }
    seenFingerprints.add(fingerprint);
    rows.push({
      deviceId: device.id,
      orgId: device.orgId,
      fingerprint,
      timestamp: new Date(change.timestamp),
      changeType: change.changeType,
      changeAction: change.changeAction,
      subject: change.subject,
      beforeValue: change.beforeValue ?? null,
      afterValue: change.afterValue ?? null,
      details: change.details ?? null
    });
  }

  // Daily row/byte ingest budget, checked before the batch is written — same
  // shape as logs.ts/eventlogs.ts. Bytes are the stored row shape (post-dedup),
  // not the wire payload, since that's what actually lands on disk.
  if (rows.length > 0) {
    const batchBytes = Buffer.byteLength(JSON.stringify(rows), 'utf-8');
    const redis = getRedis();
    const [deviceQuota, orgQuota] = await Promise.all([
      checkAndConsumeIngestQuota({
        redis,
        prefix: 'agent_changes',
        scope: 'device',
        id: device.id,
        rows: rows.length,
        bytes: batchBytes,
        maxRows: AGENT_CHANGES_MAX_ROWS_PER_DEVICE_PER_DAY,
        maxBytes: AGENT_CHANGES_MAX_BYTES_PER_DEVICE_PER_DAY,
      }),
      checkAndConsumeIngestQuota({
        redis,
        prefix: 'agent_changes',
        scope: 'org',
        id: device.orgId,
        rows: rows.length,
        bytes: batchBytes,
        maxRows: AGENT_CHANGES_MAX_ROWS_PER_ORG_PER_DAY,
        maxBytes: AGENT_CHANGES_MAX_BYTES_PER_ORG_PER_DAY,
      }),
    ]);

    if (!deviceQuota.allowed || !orgQuota.allowed) {
      console.warn(
        `[Changes] Daily ingest budget exceeded for device ${device.id} org ${device.orgId} `
        + `(device rows=${deviceQuota.rowsUsed} bytes=${deviceQuota.bytesUsed}, `
        + `org rows=${orgQuota.rowsUsed} bytes=${orgQuota.bytesUsed}) — dropping ${rows.length} row(s)`,
      );
      return c.json({ error: 'Daily change ingest budget exceeded', count: 0, dropped: rows.length }, 429);
    }
  }

  let inserted = 0;
  let insertFailed = false;
  try {
    for (let i = 0; i < rows.length; i += 200) {
      const batch = rows.slice(i, i + 200);
      const insertedBatch = await db
        .insert(deviceChangeLog)
        .values(batch)
        .onConflictDoNothing({
          target: [deviceChangeLog.deviceId, deviceChangeLog.fingerprint]
        })
        .returning({ id: deviceChangeLog.id });
      inserted += insertedBatch.length;
    }
  } catch (err) {
    insertFailed = true;
    console.error(`[Changes] Error inserting rows for device ${device.id}:`, err);
  }

  if (insertFailed && inserted === 0 && rows.length > 0) {
    return c.json({ error: 'Failed to insert changes', count: 0 }, 500);
  }

  if (inserted < rows.length) {
    return c.json({ success: true, count: inserted, total: rows.length, partial: true }, 207);
  }

  return c.json({ success: true, count: inserted });
});
