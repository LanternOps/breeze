/**
 * The loopback model gateway: one in-process HTTP listener on 127.0.0.1:<ephemeral>
 * through which every request for a gateway-kind connection (W06 openai_compatible,
 * W07 cloud kinds) leaves the API. Modelled on services/llm/llmEgressProxy.ts.
 *
 * Trust boundary: callers (the Agent SDK child, in-process clients) present a
 * per-dispatch grant token in the URL path (`/g/<token>/…`). The grant binds one
 * connection, partner, org and the exact wire model(s) the resolver priced; the
 * decrypted credential lives only in the grant record and is injected by
 * forward.ts. An unknown, expired or revoked token gets one fixed 401 body —
 * no oracle for whether a token ever existed — and no upstream call.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { scrubSecrets } from './scrub';
import { assertBoundModel, getGatewayAdapter, type GatewayAdapter } from './adapter';
import { auditGatewayEgress } from './forward';
import { createGrantStore, type GrantStore } from './grants';
import {
  GATEWAY_CONNECT_TIMEOUT_MS,
  GATEWAY_IDLE_TIMEOUT_MS,
  GATEWAY_MAX_CONCURRENT_PER_GRANT,
  GATEWAY_MAX_REQUEST_BYTES,
  GATEWAY_TOTAL_TIMEOUT_MS,
} from './limits';
import {
  GatewayError,
  gatewayErrorBody,
  type GatewayGrant,
  type GatewayGrantInput,
  type GatewayGrantRecord,
  type GatewayResponse,
} from './types';

export interface ModelGateway {
  grant(input: GatewayGrantInput): GatewayGrant;
  revoke(token: string): void;
  port(): number;
  close(): Promise<void>;
}

/** `/g/<token-segment>[/<path>][?query]` — the token segment is anything up to the next slash; the store validates it. */
const ROUTE = /^\/g\/([^/?#]*)(\/[^?#]*)?(?:\?.*)?$/;
/** Dot segments, encoded dots/slashes/backslashes, and raw backslashes are never legitimate in an adapter path. */
const UNSAFE_PATH = /%2e|%2f|%5c|\\/i;

const INVALID_GRANT = gatewayErrorBody('authentication_error', 'Invalid or expired gateway grant.');
const MALFORMED_PATH = gatewayErrorBody('invalid_request_error', 'Malformed gateway path.');

function send(res: ServerResponse, status: number, body: string): void {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req: IncomingMessage, limit: number, signal: AbortSignal): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > limit) {
    throw new GatewayError(413, 'request_too_large', 'request_too_large', 'Request body too large.');
  }
  const parts: Buffer[] = [];
  let total = 0;
  // Codex review #13: an abort destroys the request stream so a stalled sender
  // cannot hold a grant slot until the next chunk arrives.
  const onAbort = (): void => { req.destroy(); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const chunk of req) {
      if (signal.aborted) throw new GatewayError(499, 'api_error', 'client_aborted', 'Request aborted.');
      total += (chunk as Buffer).length;
      if (total > limit) throw new GatewayError(413, 'request_too_large', 'request_too_large', 'Request body too large.');
      parts.push(chunk as Buffer);
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  if (signal.aborted) throw new GatewayError(499, 'api_error', 'client_aborted', 'Request aborted.');
  return Buffer.concat(parts);
}

async function writeResponse(res: ServerResponse, out: GatewayResponse, signal: AbortSignal): Promise<void> {
  res.writeHead(out.status, { ...out.headers, 'cache-control': 'no-store' });
  if (Buffer.isBuffer(out.body)) { res.end(out.body); return; }
  let idle: NodeJS.Timeout | null = null;
  const arm = (): void => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => res.destroy(new Error('gateway idle timeout')), GATEWAY_IDLE_TIMEOUT_MS);
  };
  arm();
  try {
    for await (const chunk of out.body) {
      if (signal.aborted || res.destroyed) break;
      if (!res.write(chunk)) {
        // Codex review #13: wait for drain, but also wake on abort / close / error.
        await new Promise<void>((resolve) => {
          const done = (): void => {
            res.off('drain', done); res.off('close', done); res.off('error', done);
            signal.removeEventListener('abort', done);
            resolve();
          };
          res.once('drain', done); res.once('close', done); res.once('error', done);
          signal.addEventListener('abort', done, { once: true });
        });
        if (signal.aborted || res.destroyed) break;
      }
      arm();
    }
  } finally {
    if (idle) clearTimeout(idle);
    res.end();
  }
}

function headersOf(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') out[k.toLowerCase()] = v;
  return out;
}

/**
 * Defence in depth for Review Focus 2: an Anthropic-dialect request whose JSON
 * body names a top-level `model` must name a bound one, whatever the adapter does.
 * Bodies that are not a JSON object are left to the adapter (which rejects them).
 */
function assertAnthropicBodyModel(adapter: GatewayAdapter, body: Buffer, grant: GatewayGrantRecord): void {
  if (adapter.dialect !== 'anthropic' || body.length === 0) return;
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { return; }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'model' in parsed) {
    assertBoundModel(grant, (parsed as { model?: unknown }).model);
  }
}

export async function startModelGateway(store: GrantStore = createGrantStore()): Promise<ModelGateway> {
  let listenPort = 0;
  const sweeper = setInterval(() => store.sweep(), 60_000);
  sweeper.unref();

  const server: Server = createServer((req, res) => {
    void (async () => {
      const m = ROUTE.exec(req.url ?? '');
      if (!m) { send(res, 400, MALFORMED_PATH); return; }
      const token = m[1]!;
      const path = m[2] ?? '/';
      if (UNSAFE_PATH.test(path) || path.split('/').some((seg) => seg === '..' || seg === '.')) {
        send(res, 400, MALFORMED_PATH);
        return;
      }
      const grant: GatewayGrantRecord | null = store.lookup(token);
      if (!grant) { send(res, 401, INVALID_GRANT); return; }
      if (grant.inFlight.size >= GATEWAY_MAX_CONCURRENT_PER_GRANT) {
        send(res, 429, gatewayErrorBody('rate_limit_error', 'Too many concurrent requests on this connection.'));
        return;
      }
      const ac = new AbortController();
      grant.inFlight.add(ac);
      const total = setTimeout(() => ac.abort(), GATEWAY_TOTAL_TIMEOUT_MS);
      res.on('close', () => ac.abort());
      try {
        const body = await readBody(req, GATEWAY_MAX_REQUEST_BYTES, ac.signal);
        const adapter = getGatewayAdapter(grant.config.kind);
        assertAnthropicBodyModel(adapter, body, grant);
        const out = await adapter.handle(
          { method: req.method ?? 'GET', path, headers: headersOf(req), body, signal: ac.signal },
          grant,
        );
        await writeResponse(res, out, ac.signal);
      } catch (error) {
        if (error instanceof GatewayError) {
          if (error.code === 'gateway_model_mismatch') {
            // The request never reached forwardUpstream; record the refusal against
            // the upstream it was bound for.
            auditGatewayEgress(grant, null, null, true);
          }
          if (error.status === 413) res.setHeader('connection', 'close');
          send(res, error.status === 499 ? 400 : error.status, gatewayErrorBody(error.errorType,
            scrubSecrets(error.message, [grant.credential.secret])));
        } else {
          console.error(`[modelGateway] unhandled adapter error (grant ${grant.id}, connection ${grant.config.connectionId}):`,
            scrubSecrets(error instanceof Error ? error.message : String(error), [grant.credential.secret]));
          send(res, 502, gatewayErrorBody('api_error', 'The model endpoint request failed.'));
        }
      } finally {
        clearTimeout(total);
        grant.inFlight.delete(ac);
      }
    })();
  });
  server.headersTimeout = GATEWAY_CONNECT_TIMEOUT_MS;
  server.requestTimeout = 0; // long streams; the per-request total timer governs

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const addr = server.address();
      listenPort = typeof addr === 'object' && addr ? addr.port : 0;
      resolve();
    });
  });
  server.on('error', (error) => {
    console.error('[modelGateway] listener error:', error instanceof Error ? error.message : String(error));
  });

  const api: ModelGateway = {
    grant(input) {
      const { token } = store.issue(input);
      return {
        token,
        baseUrl: `http://127.0.0.1:${listenPort}/g/${token}`,
        revoke: () => store.revoke(token),
      };
    },
    revoke: (token) => store.revoke(token),
    port: () => listenPort,
    async close() {
      clearInterval(sweeper);
      store.revokeAll();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (singletonInstance === api) { singletonInstance = null; singletonPromise = null; }
    },
  };
  return api;
}

let singletonPromise: Promise<ModelGateway> | null = null;
let singletonInstance: ModelGateway | null = null;

/** Lazy per-process singleton (one listener; grants separate callers). Starts on first use. */
export function getModelGateway(): Promise<ModelGateway> {
  if (!singletonPromise) {
    singletonPromise = startModelGateway().then((gw) => { singletonInstance = gw; return gw; }, (error) => {
      singletonPromise = null;
      throw error;
    });
  }
  return singletonPromise;
}

export async function closeModelGateway(): Promise<void> {
  const pending = singletonPromise;
  if (!pending) return;
  const gw = singletonInstance ?? (await pending.catch(() => null));
  if (gw) await gw.close();
}
