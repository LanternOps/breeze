import type { Context } from 'hono';
import { Counter } from 'prom-client';
import { classifyAgentRequest } from '../services/admission/agentRouteClasses';
import { metricsRegistry } from '../services/metricsRegistry';
import { requestCorrelationId } from '../services/safeRequestLabel';
import { envInt } from '../utils/envInt';
import { reportBodyLimitRejection } from './bodyLimitGate';

/**
 * #8839 — receive an agent request's body BEFORE agentAuthMiddleware opens the
 * request-long org transaction.
 *
 * Wrapped agent routes run `bodyLimit` → `zValidator('json')` → handler inside
 * `withDbAccessContext`, so the body used to be read off the socket while a
 * pooled connection sat idle-in-transaction. An agent whose upload stalled
 * (bad WAN, a TLS-intercepting proxy, a retry storm) pinned that slot until the
 * client gave up: on 2026-10-15 one tenant's stalled uploads held connections
 * for 3.7–57.6 s each and drained the whole pool for every other tenant. The
 * same #1105 class as the self-managed routes, on the body-read leg.
 *
 * The fix buffers the body here, with deadlines and a size ceiling, and then
 * swaps `c.req.raw` for a Request over the in-memory bytes — the same
 * mechanism hono's own `bodyLimit` uses on its streaming leg
 * (`c.req.raw = new Request(c.req.raw, { body, duplex: 'half' })`). Every
 * downstream reader therefore sees an ordinary, complete body: `bodyLimit`
 * (Content-Length fast path or a re-count of the buffered stream, so the
 * route's own 413 message still answers), `zValidator`, `c.req.json()` /
 * `arrayBuffer()`, and gzip-decoding handlers like routes/agents/logs.ts.
 */

/**
 * Stall deadline: the longest the server waits for the NEXT chunk (the first
 * one included) before refusing with 408. This is the incident shape — a body
 * that stops arriving — and bounding the gap between chunks rather than the
 * whole transfer keeps a slow-but-steady link (a 5 MB inventory upload over a
 * congested site uplink) working.
 */
export const AGENT_BODY_RECEIVE_TIMEOUT_MS = 15_000;

/**
 * Total deadline for the whole body. Caps a client that dribbles a byte just
 * inside every stall window. 60 s matches the ceiling a wrapped body upload
 * effectively had before this change (Postgres's idle-in-transaction timeout
 * reaped the held connection), so no upload that used to succeed is cut off.
 */
export const AGENT_BODY_RECEIVE_TOTAL_TIMEOUT_MS = 60_000;

/**
 * Upper bound on a buffered body, independent of the global gate
 * (bodyLimitGate.ts, which runs first in index.ts). The largest body the
 * global gate admits on a WRAPPED agent path is the 12 MiB REST command-result
 * fallback (`/agents/:id/commands/:commandId/result`, `agent-command-result`
 * in bodyLimit.ts — it declares no route-level `bodyLimit` of its own); the
 * largest route-level `bodyLimit` any wrapped route declares is 5 MiB
 * (inventory, connections). The ceiling must admit the former or the #2401
 * large-result fix regresses. Every route's own, tighter `bodyLimit` still
 * answers below it with its own message.
 */
export const AGENT_WRAPPED_BODY_MAX_BYTES = 12 * 1024 * 1024;

const BUFFERED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const AGENT_BODY_REJECTED_METRIC = 'breeze_agent_request_body_rejected_total';

type RejectReason = 'timeout' | 'aborted' | 'too_large';
type CounterLabels = 'route' | 'reason';

const rejectedCounter: Counter<CounterLabels> =
  (metricsRegistry.getSingleMetric(AGENT_BODY_REJECTED_METRIC) as Counter<CounterLabels> | undefined)
  ?? new Counter({
    name: AGENT_BODY_REJECTED_METRIC,
    help: 'Agent request bodies refused before the org DB context opened, by route template and reason (#8839)',
    labelNames: ['route', 'reason'],
    registers: [metricsRegistry],
  });

/** Closed-set route template for labels; never request data. */
function routeLabel(c: Context): string {
  return classifyAgentRequest(c.req.method, c.req.path)?.label ?? 'other';
}

/** A non-positive override would refuse every body instantly; ignore it. */
function positiveOr(value: number, fallback: number): number {
  return value > 0 ? value : fallback;
}

const TIMED_OUT = Symbol('timedOut');

async function readWithin(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
): Promise<ReadableStreamReadResult<Uint8Array> | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Read the whole request body into memory, then make it the body every later
 * reader sees. Returns `null` when the request may proceed (body buffered, or
 * nothing to buffer), or the refusal Response to send instead — in which case
 * the caller must NOT open a DB context.
 *
 * Only call this for routes that run inside agentAuthMiddleware's
 * request-long wrap; self-managed routes read their own bodies.
 */
export async function bufferAgentRequestBody(c: Context): Promise<Response | null> {
  if (!BUFFERED_METHODS.has(c.req.method)) return null;
  const raw = c.req.raw;
  const stream = raw.body;
  if (!stream) return null;

  const route = routeLabel(c);
  const startedAt = Date.now();
  let receivedBytes = 0;

  const refuse = (reason: RejectReason, status: 400 | 408 | 413, error: string, detail?: string): Response => {
    try {
      rejectedCounter.inc({ route, reason });
    } catch {
      // Telemetry must never turn a precise refusal into a 500.
    }
    // heldMs=0: the point of #8839 — no pooled connection was checked out
    // while this body was (not) arriving.
    console.warn(
      `[agentAuth] request body refused before DB context reason=${reason} route=${route} ` +
        `method=${c.req.method} receivedBytes=${receivedBytes} elapsedMs=${Date.now() - startedAt} heldMs=0 ` +
        `request_id=${requestCorrelationId(c)}` + (detail ? ` detail=${JSON.stringify(detail.slice(0, 200))}` : ''),
    );
    if (status !== 400) c.header('Connection', 'close');
    return c.json({ error }, status);
  };

  const tooLarge = (): Response => {
    reportBodyLimitRejection(c, 'agent-wrapped-body', AGENT_WRAPPED_BODY_MAX_BYTES);
    return refuse('too_large', 413, 'Request body too large');
  };

  const declared = c.req.header('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > AGENT_WRAPPED_BODY_MAX_BYTES) {
    return tooLarge();
  }

  // Read per request (not at import) so an operator override and the tests'
  // short deadlines both apply without a restart-ordering dependency.
  const stallMs = positiveOr(envInt('AGENT_BODY_RECEIVE_TIMEOUT_MS', AGENT_BODY_RECEIVE_TIMEOUT_MS), AGENT_BODY_RECEIVE_TIMEOUT_MS);
  const totalMs = positiveOr(
    envInt('AGENT_BODY_RECEIVE_TOTAL_TIMEOUT_MS', AGENT_BODY_RECEIVE_TOTAL_TIMEOUT_MS),
    AGENT_BODY_RECEIVE_TOTAL_TIMEOUT_MS,
  );
  const reader = stream.getReader();
  const release = () => {
    reader.cancel().catch(() => {});
  };
  const chunks: Uint8Array[] = [];

  try {
    for (;;) {
      const remaining = totalMs - (Date.now() - startedAt);
      const result = remaining > 0 ? await readWithin(reader, Math.min(stallMs, remaining)) : TIMED_OUT;
      if (result === TIMED_OUT) {
        release();
        return refuse('timeout', 408, 'Request body not received in time');
      }
      if (result.done) break;
      receivedBytes += result.value.byteLength;
      if (receivedBytes > AGENT_WRAPPED_BODY_MAX_BYTES) {
        release();
        return tooLarge();
      }
      chunks.push(result.value);
    }
  } catch (err) {
    // The client went away (or the transport failed) mid-body. Previously the
    // route's own decode path (e.g. `[AgentLogs] Failed to decode request
    // body`) reported this from INSIDE the held transaction; it now surfaces
    // here, with the same response body.
    release();
    return refuse('aborted', 400, 'Failed to decode request body', err instanceof Error ? err.message : String(err));
  }

  c.req.raw = new Request(raw, { body: concat(chunks, receivedBytes), duplex: 'half' } as RequestInit);
  return null;
}
