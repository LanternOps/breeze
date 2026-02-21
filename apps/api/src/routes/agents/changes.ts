import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { devices, deviceChangeLog } from '../../db/schema';
import { submitChangesSchema } from './schemas';

export const changesRoutes = new Hono();

const MAX_CHANGES_BODY_BYTES = parseInt(process.env.CHANGE_INGEST_MAX_BODY_BYTES || String(5 * 1024 * 1024), 10);
const MAX_CHANGES_GZIP_OUTPUT_BYTES = parseInt(process.env.CHANGE_INGEST_MAX_DECOMPRESSED_BYTES || String(10 * 1024 * 1024), 10);

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue };

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
      ? gunzipSync(raw, { maxOutputLength: MAX_CHANGES_GZIP_OUTPUT_BYTES })
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
  const data = parsed.data;

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
