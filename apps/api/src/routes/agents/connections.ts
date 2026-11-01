import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { zValidator } from '../../lib/validation';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { devices, deviceConnections } from '../../db/schema';
import { captureException } from '../../services/sentry';
import { requireAgentRole } from '../../middleware/requireAgentRole';
import { submitConnectionsSchema } from './schemas';
import { pgErrorNode } from '../../utils/pgErrors';
import { envInt } from '../../utils/envInt';
import { BULK_INSERT_CHUNK_ROWS, chunkRows } from '../../utils/chunkRows';
import { createReportThrottle } from '../../utils/reportThrottle';

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
// connection inventory (#1696). The first fix chunked at 5,000 rows (55,000
// params), which fit the limit but blocked the event loop for over a second
// while drizzle built each statement (#10859). Chunks are now 500 rows.
export const CONNECTION_INSERT_CHUNK_SIZE = BULK_INSERT_CHUNK_ROWS;

// #10859 — domain controllers and file servers report 5–10k sockets, most of
// them TIME_WAIT churn. Storing all of them costs a large write every report
// and adds little for the operator. The cap keeps the useful rows (see
// selectConnectionsToStore). The schema still accepts up to 10,000, so setting
// the env var to 10000 stores everything.
const DEFAULT_MAX_CONNECTIONS_PER_DEVICE = 2000;

/** Exported only as a test seam (`.reset()`). */
export const connectionCapLogThrottle = createReportThrottle(60 * 60 * 1000);

export function maxStoredConnectionsPerDevice(): number {
  const configured = envInt('AGENT_CONNECTIONS_MAX_PER_DEVICE', DEFAULT_MAX_CONNECTIONS_PER_DEVICE);
  return configured > 0 ? configured : DEFAULT_MAX_CONNECTIONS_PER_DEVICE;
}

type SubmittedConnection = {
  protocol: string;
  localAddr: string;
  localPort: number;
  remoteAddr?: string;
  remotePort?: number;
  state?: string;
  pid?: number;
  processName?: string;
};

/**
 * Priority when a report is over the cap, lowest first: listening sockets
 * (what the device serves), then established connections (who it talks to),
 * then UDP sockets (stateless, mostly bound services such as DNS), then all
 * other TCP states (TIME_WAIT, CLOSE_WAIT, SYN_SENT, … — transient churn).
 * Windows reports `LISTENING`, the other collectors `LISTEN`.
 */
function connectionPriority(conn: SubmittedConnection): number {
  const state = conn.state?.trim().toUpperCase() ?? '';
  if (state === 'LISTEN' || state === 'LISTENING') return 0;
  if (state === 'ESTABLISHED') return 1;
  if (conn.protocol.startsWith('udp')) return 2;
  return 3;
}

function compareText(a: string | undefined, b: string | undefined): number {
  const left = a ?? '';
  const right = b ?? '';
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Pick at most `max` connections to store. Under the cap the report is
 * returned as-is, in agent order. Over it, rows are ranked by
 * {@link connectionPriority} and then by a total order on the socket tuple, so
 * the same set of sockets always yields the same stored rows, whatever order
 * the agent sent them in.
 */
export function selectConnectionsToStore<T extends SubmittedConnection>(connections: readonly T[], max: number): T[] {
  if (connections.length <= max) return [...connections];
  return [...connections]
    .sort((a, b) =>
      connectionPriority(a) - connectionPriority(b)
      || compareText(a.protocol, b.protocol)
      || a.localPort - b.localPort
      || compareText(a.localAddr, b.localAddr)
      || compareText(a.remoteAddr, b.remoteAddr)
      || (a.remotePort ?? -1) - (b.remotePort ?? -1)
      || compareText(a.state, b.state)
      || (a.pid ?? -1) - (b.pid ?? -1)
      || compareText(a.processName, b.processName))
    .slice(0, max);
}

function clampNullable(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined || value === '') return null;
  return value.length > max ? value.slice(0, max) : value;
}

function clampRequired(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

export const connectionsRoutes = new Hono();

connectionsRoutes.use('*', requireAgentRole);

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

  const max = maxStoredConnectionsPerDevice();
  const toStore = selectConnectionsToStore(data.connections, max);
  const truncated = toStore.length < data.connections.length;
  // A capped device stays capped on every report, so log it once an hour per
  // device. The response's `truncated` flag carries it every time.
  if (truncated && connectionCapLogThrottle.shouldReport(device.id)) {
    console.warn('[connections] capped connection inventory', {
      agentId,
      deviceId: device.id,
      orgId: device.orgId,
      received: data.connections.length,
      stored: toStore.length,
      max,
    });
  }

  try {
    await db.transaction(async (tx) => {
      await tx
        .delete(deviceConnections)
        .where(eq(deviceConnections.deviceId, device.id));

      if (toStore.length > 0) {
        const now = new Date();
        const rows = toStore.map((conn) => ({
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
        // Bounded chunks (#1696, #10859). All batches share the transaction,
        // so delete+replace stays atomic.
        for (const batch of chunkRows(rows, CONNECTION_INSERT_CHUNK_SIZE)) {
          await tx.insert(deviceConnections).values(batch);
        }
      }
    });
  } catch (err) {
    // Global onError returns a generic 500; re-log with pg error fields
    // (code/constraint/column) so server logs retain diagnostic context,
    // and capture to Sentry for durability.
    // `pgErrorNode` returns the error that actually CARRIES the SQLSTATE, so
    // code/detail/table_name all come from the same object. Reading them off
    // the top-level error left every POSTGRES DIAGNOSTIC field below
    // permanently `undefined` under drizzle-orm/postgres-js — code, detail,
    // table_name, column_name, constraint_name. (`message` was never missing:
    // the outer DrizzleQueryError has its own. Note it now reports the inner
    // Postgres message rather than the outer query-and-params text, which is
    // the more useful half for these diagnostics.)
    const pg = (pgErrorNode(err) ?? {}) as { code?: string; detail?: string; table_name?: string; column_name?: string; constraint_name?: string; message?: string };
    console.error('connections-inventory insert failed', {
      agentId,
      deviceId: device.id,
      orgId: device.orgId,
      count: toStore.length,
      received: data.connections.length,
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

  return c.json({
    success: true,
    count: toStore.length,
    received: data.connections.length,
    truncated,
  });
});
