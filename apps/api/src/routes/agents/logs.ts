import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { gunzipSync } from 'node:zlib';
import { db } from '../../db';
import { devices, agentLogs } from '../../db/schema';

export const logsRoutes = new Hono();

// Agent Diagnostic Log Shipping
const agentLogEntrySchema = z.object({
  timestamp: z.string().datetime(),
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
  logs: z.array(agentLogEntrySchema).max(500),
});

logsRoutes.post('/:id/logs', async (c) => {
  const agentId = c.req.param('id');
  let body: unknown;

  try {
    const raw = Buffer.from(await c.req.arrayBuffer());
    const encoding = c.req.header('content-encoding')?.toLowerCase() ?? '';
    const decoded = encoding.includes('gzip')
      ? gunzipSync(raw, { maxOutputLength: 10 * 1024 * 1024 }) // 10MB limit
      : raw;
    body = JSON.parse(decoded.toString('utf-8'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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
