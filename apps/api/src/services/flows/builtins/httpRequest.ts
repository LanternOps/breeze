/**
 * Tool Catalog W05 (#5220), plan Task B4 / Decision 12 — the `http_request`
 * built-in: one anonymous HTTPS call to the origin the flow's author fixed.
 *
 * Order (the plan's, load-bearing):
 *  1. per-run cap (`httpPerRunMax`, a policy failure);
 *  2. the rendered URL is parsed with `new URL()` and refused unless its
 *     origin equals the PUBLICATION's literal origin (`ctx.literalOrigin`),
 *     with no userinfo, an allowed scheme, and not one of Breeze's own
 *     hostnames (`egress_blocked`, policy) — a templated path can never move
 *     the request to another host;
 *  3. query appended with URLSearchParams; a JSON body ≤ 256 KB (never on
 *     GET/HEAD); headers re-filtered against the unconditional deny-list;
 *  4. `safeFetch`: every DNS answer checked and the dialled IP pinned,
 *     private/metadata ranges refused (RFC1918 only with the self-hosted flag,
 *     and cleartext only to RFC1918), redirects never followed, an ABSOLUTE
 *     deadline (`min(step timeout, 30 s)` via an abort signal — `timeoutMs`
 *     alone is socket inactivity) plus a headers deadline, a 1 MB response cap;
 *  5. the response: 3xx/4xx/5xx ⇒ `http_status`; an over-cap body is kept up
 *     to the cap and marked truncated (not a failure); the text is redacted
 *     BEFORE it is parsed, truncated or stored.
 *
 * A failure before anything was sent (cap, policy, the egress guard, a
 * refused connection) is definite. A timeout or an error after the request
 * may have reached the server is `unknown_outcome` (W04: Tier ≥ 2 never
 * retries; the run stops rather than guess). There is no credential path:
 * requests are anonymous in W5.
 */
import { FLOW_RUN_LIMITS, flowBuiltinTierFor, type FlowValue } from '@breeze/shared';
import { toolSourcesAllowPrivateEgress } from '../../../config/env';
import { redactSecretsFromOutput } from '../../secretRedaction';
import { ResponseTooLargeError, safeFetch, SsrfBlockedError } from '../../urlSafety';
import type { StepOutcome } from '../stepExecutor';
import { toStoredFlowOutput } from '../storedOutput';
import { isAllowedHttpProtocol, isBreezeOwnHostname, isDeniedHeaderName } from './httpPolicy';
import type { BuiltinContext } from './types';

export interface HttpRequestInput {
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  body?: unknown;
}

/** Response headers a flow may read; everything else (cookies, internals) is dropped. */
const KEPT_RESPONSE_HEADERS = ['content-type', 'etag', 'last-modified', 'retry-after'] as const;

/** Phase-of-connect failures: the request never reached the server. */
const NOT_SENT_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

const MESSAGE_MAX = 300;
const clip = (s: string) => (s.length > MESSAGE_MAX ? `${s.slice(0, MESSAGE_MAX)}…` : s);

function policy(code: 'egress_blocked' | 'input_invalid', message: string): StepOutcome {
  return { kind: 'failed', code, message, policy: true };
}

function errorCodeOf(err: unknown): string | undefined {
  const own = (err as { code?: unknown } | null)?.code;
  if (typeof own === 'string') return own;
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof cause === 'string' ? cause : undefined;
}

function utf8Length(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Read the body up to `maxBytes`, honouring `signal` between chunks (a mocked
 * or already-resolved body stream is not destroyed by the request's abort, so
 * the race is explicit). Over the cap ⇒ what fits, `truncated`.
 */
async function readBody(res: Response, maxBytes: number, signal: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: '', truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
  aborted.catch(() => {}); // observed below; never an unhandled rejection
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) break;
      const room = maxBytes - total;
      if (next.value.byteLength > room) {
        if (room > 0) chunks.push(next.value.subarray(0, room));
        total = maxBytes;
        void reader.cancel().catch(() => {});
        return { text: Buffer.concat(chunks).toString('utf8').replace(/�+$/, ''), truncated: true };
      }
      chunks.push(next.value);
      total += next.value.byteLength;
    }
  } catch (err) {
    void reader.cancel().catch(() => {});
    if (err instanceof ResponseTooLargeError) {
      return { text: Buffer.concat(chunks).toString('utf8').replace(/�+$/, ''), truncated: true };
    }
    throw err;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated: false };
}

function keptHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of KEPT_RESPONSE_HEADERS) {
    const v = res.headers.get(name);
    if (v !== null) out[name] = v;
  }
  return out;
}

export type HttpPreflight =
  | { ok: true; url: URL; body: string | undefined; headers: Record<string, string> }
  | { ok: false; outcome: StepOutcome };

/**
 * Steps 1–3: everything decidable before a byte is sent — the per-run cap,
 * the rendered URL staying on the literal origin, the scheme and own-host
 * rules, the body cap and the header deny-list. The runner applies it before
 * parking a Tier-3 request too, so an approver is never asked to approve a
 * request that is certain to be refused at release.
 */
export function preflightHttpRequest(input: HttpRequestInput, ctx: { literalOrigin: string; httpCalls: number }): HttpPreflight {
  const refuse = (code: 'egress_blocked' | 'input_invalid', message: string): HttpPreflight => ({ ok: false, outcome: policy(code, message) });

  // 1. per-run cap
  if (ctx.httpCalls > FLOW_RUN_LIMITS.httpPerRunMax) {
    return refuse('egress_blocked', `A flow run may make at most ${FLOW_RUN_LIMITS.httpPerRunMax} HTTP requests.`);
  }

  // 2. the rendered URL stays on the literal origin
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return refuse('input_invalid', 'The rendered URL is not a valid URL.');
  }
  if (url.username || url.password) return refuse('egress_blocked', 'The rendered URL carries credentials; requests are anonymous.');
  if (url.origin !== ctx.literalOrigin) return refuse('egress_blocked', 'The rendered URL does not stay on the origin fixed in the flow.');
  const protocol = url.protocol === 'https:' || url.protocol === 'http:' ? url.protocol : null;
  if (!protocol || !isAllowedHttpProtocol(protocol)) return refuse('egress_blocked', 'Only https:// requests are allowed.');
  if (isBreezeOwnHostname(url.hostname)) return refuse('egress_blocked', 'A flow cannot call Breeze itself.');
  url.hash = '';

  // 3. query, body, headers
  for (const [key, value] of Object.entries(input.query ?? {})) url.searchParams.append(key, String(value));
  let body: string | undefined;
  if (input.body !== undefined) {
    if (input.method === 'GET' || input.method === 'HEAD') return refuse('input_invalid', `A ${input.method} request carries no body.`);
    body = JSON.stringify(input.body);
    if (utf8Length(body) > FLOW_RUN_LIMITS.httpMaxRequestBodyBytes) {
      return refuse('input_invalid', `The request body is larger than ${FLOW_RUN_LIMITS.httpMaxRequestBodyBytes} bytes.`);
    }
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (isDeniedHeaderName(name)) continue; // unconditional, case-insensitive (save refused it; never trusted)
    headers[name.toLowerCase()] = value;
  }
  if (body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
  return { ok: true, url, body, headers };
}

export async function executeHttpRequestStep(input: HttpRequestInput, ctx: BuiltinContext & { literalOrigin: string }): Promise<StepOutcome> {
  const tier = flowBuiltinTierFor('http_request', input);
  const mayHaveRun = (message: string): StepOutcome => (tier >= 2
    ? { kind: 'unknown_outcome', message }
    : { kind: 'failed', code: 'step_failed', message, policy: false });

  const pre = preflightHttpRequest(input, { literalOrigin: ctx.literalOrigin, httpCalls: ctx.counters.http });
  if (!pre.ok) return pre.outcome;
  const { url, body, headers } = pre;

  // 4. the call, under an absolute deadline
  const budgetMs = Math.min(ctx.step.timeoutSec * 1000, FLOW_RUN_LIMITS.httpTimeoutMs, ctx.deadline - Date.now());
  if (budgetMs <= 0) return { kind: 'failed', code: 'step_timeout', message: 'The step had no time left to make the request.', policy: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`request did not finish within ${budgetMs} ms`)), budgetMs);
  try {
    let res: Response;
    try {
      res = await safeFetch(url.toString(), {
        method: input.method,
        headers,
        body,
        redirect: 'manual',
        signal: controller.signal,
        headersTimeoutMs: Math.min(10_000, budgetMs),
        timeoutMs: Math.min(10_000, budgetMs),
        maxBytes: FLOW_RUN_LIMITS.httpMaxResponseBytes,
        streamResponse: true,
        allowPrivateNetwork: toolSourcesAllowPrivateEgress(),
        requirePrivateForCleartext: true,
      });
    } catch (err) {
      // The guard resolves and checks before any socket opens: nothing was sent.
      if (err instanceof SsrfBlockedError) return policy('egress_blocked', 'The request was blocked by the egress guard.');
      const code = errorCodeOf(err);
      if (code && NOT_SENT_ERROR_CODES.has(code)) {
        return { kind: 'failed', code: 'step_failed', message: clip(`The request could not be sent (${code}).`), policy: false };
      }
      return mayHaveRun(clip(`The request did not complete and may have reached the server: ${err instanceof Error ? err.message : String(err)}`));
    }

    // 5. the response
    if (res.status >= 300) {
      void res.body?.cancel().catch(() => {});
      return { kind: 'failed', code: 'http_status', message: `The server answered ${res.status}.`, policy: false };
    }
    let read: { text: string; truncated: boolean };
    try {
      read = input.method === 'HEAD' ? { text: '', truncated: false } : await readBody(res, FLOW_RUN_LIMITS.httpMaxResponseBytes, controller.signal);
    } catch (err) {
      return mayHaveRun(clip(`The response did not arrive in time: ${err instanceof Error ? err.message : String(err)}`));
    }
    const redacted = redactSecretsFromOutput(read.text);
    let parsedBody: FlowValue = null;
    if (input.method !== 'HEAD' && res.status !== 204 && redacted.length > 0) {
      const isJson = /\bjson\b/i.test(res.headers.get('content-type') ?? '');
      parsedBody = redacted;
      if (isJson && !read.truncated) {
        try {
          parsedBody = JSON.parse(redacted) as FlowValue;
        } catch {
          parsedBody = redacted;
        }
      }
    }
    const output: Record<string, FlowValue> = { status: res.status, headers: keptHeaders(res), body: parsedBody };
    if (read.truncated) output.truncated = true;
    const stored = toStoredFlowOutput(output);
    return { kind: 'completed', output: stored.output, truncated: stored.truncated || read.truncated };
  } finally {
    clearTimeout(timer);
  }
}
