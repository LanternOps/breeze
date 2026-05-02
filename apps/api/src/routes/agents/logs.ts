import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { gunzipSync } from 'node:zlib';
import { db } from '../../db';
import { devices, agentLogs } from '../../db/schema';

export const logsRoutes = new Hono();

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
const agentLogEntrySchema = z.object({
  timestamp: z.string().datetime({ offset: true }),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  component: z.string().max(100),
  message: z.string().max(10000),
  fields: z.record(z.any()).optional().refine(
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
    maxSize: 256 * 1024,
    onError: (c) => c.json({ error: 'Log batch too large (max 256KB gzipped)' }, 413),
  }),
  async (c) => {
  const agentId = c.req.param('id');
  let body: unknown;

  try {
    const raw = Buffer.from(await c.req.arrayBuffer());
    const encoding = c.req.header('content-encoding')?.toLowerCase() ?? '';
    const decoded = encoding.includes('gzip')
      ? gunzipSync(raw, { maxOutputLength: 10 * 1024 * 1024 }) // 10MB decompressed cap (defense-in-depth)
      : raw;
    body = JSON.parse(decoded.toString('utf-8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Hono's bodyLimit middleware throws a BodyLimitError when the request
    // body exceeds the configured maxSize (no Content-Length header) — surface
    // it as 413 instead of the generic 400.
    if (err instanceof Error && err.name === 'BodyLimitError') {
      return c.json({ error: 'Log batch too large (max 256KB gzipped)' }, 413);
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

  const rows = data.logs.map((log: any) => ({
    deviceId: device.id,
    orgId: device.orgId,
    timestamp: new Date(log.timestamp),
    level: log.level,
    component: log.component,
    message: log.message,
    fields: log.fields || null,
    agentVersion: log.agentVersion || null,
  }));

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

  if (inserted === 0 && rows.length > 0) {
    return c.json({ error: 'Failed to insert logs', received: 0 }, 500);
  }
  if (inserted < rows.length) {
    return c.json({ received: inserted, total: rows.length, partial: true }, 207);
  }
  return c.json({ received: inserted }, 201);
});
