import { recordLlmEgressEvent } from '../../llm/llmEgressRecorder';
import { ResponseHeadersTimeoutError, ResponseTooLargeError, safeFetch, SsrfBlockedError } from '../../urlSafety';
import { byoEgressAllowances } from './byoEndpointPolicy';
import {
  GATEWAY_CONNECT_TIMEOUT_MS,
  GATEWAY_ERROR_TEXT_MAX,
  GATEWAY_IDLE_TIMEOUT_MS,
  GATEWAY_MAX_RESPONSE_BYTES,
  GATEWAY_UPSTREAM_ERROR_READ_BYTES,
} from './limits';
import { scrubSecrets } from './scrub';
import { GatewayError, type GatewayGrantRecord } from './types';

export interface UpstreamRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string | Buffer;
  stream: boolean;
  /** Lower response cap for this call (discovery: 1 MiB). Never above GATEWAY_MAX_RESPONSE_BYTES. */
  maxBytes?: number;
}

/** Headers an adapter may never pass through to an upstream (credentials, routing, hop-by-hop). */
const STRIPPED = new Set([
  'authorization', 'x-api-key', 'api-key', 'cookie', 'host', 'proxy-authorization', 'proxy-connection',
  'forwarded', 'x-real-ip', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade', 'expect',
  'content-length', 'transfer-encoding',
]);
const STRIPPED_PREFIXES = ['x-forwarded-', 'proxy-'];

let fetchImpl: typeof safeFetch = safeFetch;
export function __setUpstreamFetchForTests(fn: typeof safeFetch | null): void { fetchImpl = fn ?? safeFetch; }

let warnedNoOrg = false;

/** Whether a grant's connection is still current (same row, same config version). */
export type GatewayConnectionCheck = (connectionId: string, configVersion: number) => Promise<boolean>;
let connectionCheck: GatewayConnectionCheck | null = null;

/**
 * Registers the check forwardUpstream runs before every dial. A grant outlives
 * the moment it was issued, so an edited, disabled or deleted connection must
 * stop reaching its upstream even while grants for it are still live. With no
 * check registered every request is allowed.
 */
export function setGatewayConnectionCheck(fn: GatewayConnectionCheck | null): void {
  connectionCheck = fn;
}

function staleGrant(): GatewayError {
  return new GatewayError(401, 'authentication_error', 'grant_stale', 'This connection changed; the request was not sent.');
}

/** An error's message plus its cause chain (fetch reports the socket error as `cause`). */
function describeError(error: unknown): string {
  const parts: string[] = [];
  let cur: unknown = error;
  for (let depth = 0; cur !== undefined && cur !== null && depth < 3; depth += 1) {
    parts.push(cur instanceof Error ? cur.message : String(cur));
    cur = cur instanceof Error ? (cur as Error & { cause?: unknown }).cause : undefined;
  }
  return parts.join(' <- ');
}

function logIds(grant: GatewayGrantRecord): string {
  return `grant ${grant.id}, connection ${grant.config.connectionId}`;
}

/** The upstream origin a grant may reach. W07 adds a cloud arm per kind (the `never` default forces it). */
export function upstreamOriginFor(grant: GatewayGrantRecord): string {
  switch (grant.config.kind) {
    case 'openai_compatible':
      return new URL(grant.config.baseUrl).origin;
    default: {
      const never: never = grant.config.kind;
      throw new Error(`no upstream origin for ${String(never)}`);
    }
  }
}

/**
 * The path prefix under the origin a grant may reach (the base URL's own path),
 * so a grant for `https://h/api/v1` cannot be steered at `https://h/admin`.
 */
function upstreamPathPrefixFor(grant: GatewayGrantRecord): string {
  switch (grant.config.kind) {
    case 'openai_compatible':
      return new URL(grant.config.baseUrl).pathname.replace(/\/+$/, '');
    default: {
      const never: never = grant.config.kind;
      throw new Error(`no upstream path for ${String(never)}`);
    }
  }
}

/** Auth headers for a grant's upstream. W07 adds per-kind arms (SigV4, Google bearer, Azure key). */
export function upstreamAuthHeaders(grant: GatewayGrantRecord): Record<string, string> {
  switch (grant.config.kind) {
    case 'openai_compatible':
      return grant.credential.secret ? { authorization: `Bearer ${grant.credential.secret}` } : {};
    default: {
      const never: never = grant.config.kind;
      throw new Error(`no auth for ${String(never)}`);
    }
  }
}

function hostOf(grant: GatewayGrantRecord): string {
  try { return new URL(upstreamOriginFor(grant)).hostname; } catch { return 'invalid'; }
}

/**
 * One egress audit row for this grant. Exported for the server's bound-model
 * refusal, which never reaches forwardUpstream but must still leave a blocked row.
 */
export function auditGatewayEgress(
  grant: GatewayGrantRecord,
  host: string | null,
  resolvedIp: string | null,
  blocked: boolean,
): void {
  if (!grant.orgId) {
    // llm_egress_events is org-scoped (shape 1); partner-level verification and
    // discovery have no org to attribute a row to. Same posture as the catalog
    // harness (providerFidelityHarness.ts).
    if (!warnedNoOrg) {
      warnedNoOrg = true;
      console.warn(`[modelGateway] ${grant.purpose} egress for connection ${grant.config.connectionId} is not persisted (no organization in context).`);
    }
    return;
  }
  recordLlmEgressEvent({
    orgId: grant.orgId,
    partnerId: grant.config.partnerId,
    surface: 'gateway_forward',
    host: host ?? hostOf(grant),
    resolvedIp,
    blocked,
    aiSessionId: grant.aiSessionId,
    connectionId: grant.config.connectionId,
  });
}

function offOrigin(): GatewayError {
  return new GatewayError(502, 'api_error', 'gateway_origin_mismatch', 'The gateway refused an off-origin upstream request.');
}

/**
 * The ONLY function that dials a gateway connection's upstream (Global
 * Constraints; enforced by aiModelRegistry.contract.test.ts). Origin- and path-pinned to the
 * connection, SSRF-guarded with DNS pinning (safeFetch, re-resolved on every
 * call), no redirects, response size capped, credential injected here and
 * nowhere else, one audit row per attempt.
 */
export async function forwardUpstream(
  grant: GatewayGrantRecord,
  req: UpstreamRequest,
  signal: AbortSignal,
): Promise<Response> {
  let target: URL;
  try { target = new URL(req.url); } catch {
    auditGatewayEgress(grant, null, null, true);
    throw offOrigin();
  }
  const prefix = upstreamPathPrefixFor(grant);
  if (
    target.origin !== upstreamOriginFor(grant)
    || target.username !== '' || target.password !== ''
    || (target.pathname !== prefix && !target.pathname.startsWith(`${prefix}/`))
  ) {
    auditGatewayEgress(grant, target.hostname, null, true);
    throw offOrigin();
  }

  if (connectionCheck) {
    let current: boolean;
    try {
      current = await connectionCheck(grant.config.connectionId, grant.config.configVersion);
    } catch (error) {
      // Fail closed: an unverifiable grant does not dial.
      console.warn(`[modelGateway] connection check failed (${logIds(grant)}):`,
        scrubSecrets(describeError(error), [grant.credential.secret]));
      current = false;
    }
    if (current !== true) {
      auditGatewayEgress(grant, target.hostname, null, true);
      throw staleGrant();
    }
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (STRIPPED.has(key) || STRIPPED_PREFIXES.some((p) => key.startsWith(p))) continue;
    headers[key] = v;
  }
  Object.assign(headers, upstreamAuthHeaders(grant));

  const allow = byoEgressAllowances();
  let resolvedIp: string | null = null;
  let res: Response;
  try {
    res = await fetchImpl(target.toString(), {
      method: req.method,
      headers,
      // safeFetch serialises a Buffer body natively (urlSafety.ts); the DOM BodyInit type just doesn't list it.
      ...(req.body !== undefined ? { body: req.body as unknown as BodyInit } : {}),
      redirect: 'error',
      signal,
      // DNS + connect + response-headers deadline. safeFetch stops it the moment
      // headers arrive, in both modes — a non-streamed body buffers inside
      // safeFetch, so an abort-based deadline here would also cut off a slow
      // (but live) generation. The body is then bounded by the inactivity
      // timeout, the byte cap and the server's total timer (`signal`).
      headersTimeoutMs: GATEWAY_CONNECT_TIMEOUT_MS,
      // safeFetch's timeoutMs is a SOCKET-INACTIVITY timeout (urlSafety.ts),
      // so it is the stream idle limit, not a connect deadline.
      timeoutMs: GATEWAY_IDLE_TIMEOUT_MS,
      allowPrivateNetwork: allow.allowPrivateNetwork,
      requirePrivateForCleartext: allow.requirePrivateForCleartext,
      maxBytes: req.maxBytes !== undefined && Number.isFinite(req.maxBytes) && req.maxBytes > 0
        ? Math.min(req.maxBytes, GATEWAY_MAX_RESPONSE_BYTES)
        : GATEWAY_MAX_RESPONSE_BYTES,
      streamResponse: req.stream,
      onConnect: (ip: string) => { resolvedIp = ip; },
    });
  } catch (error) {
    auditGatewayEgress(grant, target.hostname, resolvedIp, true);
    if (error instanceof ResponseHeadersTimeoutError && !signal.aborted) {
      throw new GatewayError(504, 'api_error', 'upstream_timeout', 'The endpoint did not respond in time.');
    }
    if (error instanceof SsrfBlockedError) {
      throw new GatewayError(502, 'api_error', 'egress_blocked', 'The endpoint resolves to an address Breeze does not connect to.');
    }
    if (error instanceof ResponseTooLargeError) {
      throw new GatewayError(502, 'api_error', 'upstream_too_large', 'The endpoint response exceeded the size limit.');
    }
    if (signal.aborted) throw new GatewayError(499, 'api_error', 'client_aborted', 'Request aborted.');
    console.warn(`[modelGateway] upstream unreachable (${logIds(grant)}):`,
      scrubSecrets(describeError(error), [grant.credential.secret]));
    throw new GatewayError(502, 'api_error', 'upstream_unreachable', 'The endpoint could not be reached.');
  }
  auditGatewayEgress(grant, target.hostname, resolvedIp, false);
  if (res.status >= 300 && res.status < 400) {
    // safeFetch never follows; release the (possibly live) body socket and refuse.
    await res.body?.cancel().catch(() => {});
    throw new GatewayError(502, 'api_error', 'upstream_redirect', 'The endpoint answered with a redirect, which Breeze does not follow.');
  }
  return res;
}

/**
 * Error text from a non-2xx upstream response, safe to return or store: reads at
 * most GATEWAY_UPSTREAM_ERROR_READ_BYTES (the rest is cancelled unread), then
 * scrubs the grant's credential and generic key shapes and caps the length.
 * Adapters use this for every upstream error they surface.
 */
export async function readUpstreamErrorText(res: Response, grant: GatewayGrantRecord, max = 300): Promise<string> {
  let text = '';
  const reader = res.body?.getReader();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (total < GATEWAY_UPSTREAM_ERROR_READ_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
      }
    } catch {
      // A broken body still yields whatever arrived.
    } finally {
      await reader.cancel().catch(() => {});
    }
    text = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)))
      .subarray(0, GATEWAY_UPSTREAM_ERROR_READ_BYTES)
      .toString('utf8');
  }
  // The cap stays far below the read window, so a secret cut in half at the end
  // of the window (and therefore not matched by the scrub) is never visible.
  return scrubSecrets(text, [grant.credential.secret], Math.min(max, GATEWAY_ERROR_TEXT_MAX));
}
