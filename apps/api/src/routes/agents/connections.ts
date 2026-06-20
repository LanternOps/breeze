import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { zValidator } from '@hono/zod-validator';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { devices, deviceConnections } from '../../db/schema';
import { captureException } from '../../services/sentry';
import { submitConnectionsSchema } from './schemas';

// Hard caps that match the device_connections column widths. Agent
// collectors emit kernel-bound values (TCP states, /proc comm names) that
// normally fit, but older or non-darwin agents skip sanitization and can
// occasionally egress oversized strings — see #504. Truncating here keeps
// the insert from blowing up with 22001 "value too long for type" and
// removes an entire class of 500s regardless of agent version.
const STATE_MAX = 20;
const PROCESS_NAME_MAX = 255;
const ADDR_MAX = 128; // local_addr / remote_addr are text; cap for sanity (e.g. IPv6 zone IDs)

// device_connections binds 11 columns per row (the row object omits `id`, which
// Postgres fills via its DEFAULT — it costs no bind param), and Postgres caps a
// single statement at 65534 bound parameters. The submit schema allows up to
// 10,000 connections, which at 11 cols would need 110,000 params and fail the
// insert with MAX_PARAMETERS_EXCEEDED — silently dropping the device's entire
// connection inventory (#1696). Chunk the insert well under the limit:
// 5000 rows × 11 cols = 55,000 params, a comfortable margin under 65534.
const CONNECTION_INSERT_CHUNK_SIZE = 5000;

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

function clampNullable(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined || value === '') return null;
  return value.length > max ? value.slice(0, max) : value;
}

function clampRequired(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

export const connectionsRoutes = new Hono();

connectionsRoutes.put(
  '/:id/connections',
  bodyLimit({ maxSize: 5 * 1024 * 1024, onError: (c) => c.json({ error: 'Request body too large' }, 413) }),
  zValidator('json', submitConnectionsSchema),
  async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  try {
    await db.transaction(async (tx) => {
      await tx
        .delete(deviceConnections)
        .where(eq(deviceConnections.deviceId, device.id));

      if (data.connections.length > 0) {
        const now = new Date();
        const rows = data.connections.map((conn) => ({
          deviceId: device.id,
          orgId: device.orgId,
          protocol: conn.protocol,
          localAddr: clampRequired(conn.localAddr, ADDR_MAX),
          localPort: conn.localPort,
          remoteAddr: clampNullable(conn.remoteAddr, ADDR_MAX),
          remotePort: conn.remotePort || null,
          state: clampNullable(conn.state, STATE_MAX),
          pid: conn.pid || null,
          processName: clampNullable(conn.processName, PROCESS_NAME_MAX),
          updatedAt: now
        }));
        // Chunk to stay under Postgres' 65534 bound-parameter limit (#1696).
        // All batches share the transaction, so delete+replace stays atomic.
        for (const batch of chunk(rows, CONNECTION_INSERT_CHUNK_SIZE)) {
          await tx.insert(deviceConnections).values(batch);
        }
      }
    });
  } catch (err) {
    // Global onError returns a generic 500; re-log with pg error fields
    // (code/constraint/column) so server logs retain diagnostic context,
    // and capture to Sentry for durability.
    const pg = err as { code?: string; detail?: string; table_name?: string; column_name?: string; constraint_name?: string; message?: string };
    console.error('connections-inventory insert failed', {
      agentId,
      deviceId: device.id,
      orgId: device.orgId,
      count: data.connections.length,
      pgCode: pg.code,
      pgDetail: pg.detail,
      pgTable: pg.table_name,
      pgColumn: pg.column_name,
      pgConstraint: pg.constraint_name,
      message: pg.message
    });
    captureException(err, c);
    throw err;
  }

  return c.json({ success: true, count: data.connections.length });
});
