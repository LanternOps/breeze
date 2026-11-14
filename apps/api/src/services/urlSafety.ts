/**
 * urlSafety — shared helper for SSRF-safe outbound HTTP.
 *
 * Threat model: a URL supplied by a tenant (OIDC issuer, webhook target) must
 * not resolve to an internal network address. A naive "lookup + fetch" pattern
 * has a TOCTOU window where DNS rebinding can swap a public IP for a private
 * one between validation and connection.
 *
 * `safeFetch()` closes that window: it resolves the hostname ONCE, filters out
 * private/loopback/link-local addresses, and dials the request with a custom
 * `lookup` function that always returns the validated IP. When the connection
 * to that IP fails or stalls before it is established, the request moves on to
 * the next validated IP from the SAME resolution (a bounded number of times);
 * nothing is resolved again. The hostname is preserved as SNI. `safeFetch` derives the `Host` header from the URL and
 * ignores caller-supplied Host values so tenant-controlled headers cannot
 * redirect virtual-host routing. Certificate chain validation is NEVER disabled.
 */
import { lookup as dnsLookup } from 'dns/promises';
import type { LookupAddress } from 'dns';
import https from 'https';
import http from 'http';
import type { LookupFunction, Socket } from 'net';
import type { Duplex } from 'stream';
import { assertOutsideHeldDbContext } from '../db';
import {
  canonicalIpLiteral,
  isBlockedForEgress,
  isIpLiteralHost,
  isRfc1918OrUla
} from './ipRanges';

// The range table and its classifiers live in `ipRanges.ts` — one table, shared
// with the config-time guard in `ssrfGuard.ts`. Re-exported here because
// `isPrivateIp` / `isRfc1918OrUla` / `isAlwaysBlockedIp` are part of this
// module's long-standing public surface and existing callers import them from
// it; new callers may import either module.
export {
  canonicalIpLiteral,
  canonicalizeIpv4Literal,
  classifyBlockedIp,
  isAlwaysBlockedIp,
  isBlockedForEgress,
  isCarrierNatAddress,
  isIpLiteralHost,
  isPrivateIp,
  isRfc1918OrUla,
  BLOCKED_IP_CATEGORY_LABEL,
  type BlockedIpCategory,
  type EgressAllowances
} from './ipRanges';

export class SsrfBlockedError extends Error {
  public readonly resolvedIps?: string[];
  public readonly hostname?: string;

  constructor(message: string, opts?: { hostname?: string; resolvedIps?: string[] }) {
    super(message);
    this.name = 'SsrfBlockedError';
    this.hostname = opts?.hostname;
    this.resolvedIps = opts?.resolvedIps;
  }
}

/**
 * A hop's host failed the caller's `allowHost` predicate
 * (`safeFetchFollowingRedirects`). A subclass so callers can tell "this host
 * is outside what I may contact" (a standing answer) from an address-policy
 * refusal such as a private-range resolution (possibly transient).
 */
export class HostNotAllowedError extends SsrfBlockedError {
  constructor(hostname: string) {
    super(`host not allowed: ${hostname}`, { hostname });
    this.name = 'HostNotAllowedError';
  }
}

/** The response body exceeded the caller's `maxBytes` ceiling. The socket is destroyed. */
export class ResponseTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`response body exceeded maxBytes (${maxBytes})`);
    this.name = 'ResponseTooLargeError';
  }
}

/**
 * The whole exchange — resolution, connect, headers and body — outlasted the
 * caller's `deadlineMs`. `timeoutMs` measures inactivity; `deadlineMs` bounds
 * total duration.
 */
export class ResponseDeadlineError extends Error {
  constructor(public readonly deadlineMs: number) {
    super(`request did not complete within ${deadlineMs}ms`);
    this.name = 'ResponseDeadlineError';
  }
}

/** The error an aborted request settles with: the deadline's own, or the caller's plain abort. */
function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof ResponseDeadlineError ? signal.reason : new Error('aborted');
}

/**
 * The response headers did not arrive within the caller's `headersTimeoutMs`
 * (measured from the call, so it covers DNS, connect and the wait for the
 * status line). The request is destroyed.
 */
export class ResponseHeadersTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`response headers not received within ${timeoutMs}ms`);
    this.name = 'ResponseHeadersTimeoutError';
  }
}

// Optionally override DNS lookup in tests via module-level hook.
type LookupAllFn = (
  hostname: string,
  options: { all: true }
) => Promise<LookupAddress[]>;

let lookupImpl: LookupAllFn = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

/** Test hook — override DNS resolution. Pass `null` to restore default. */
export function __setLookupForTests(fn: LookupAllFn | null): void {
  lookupImpl = fn ?? ((hostname) => dnsLookup(hostname, { all: true, verbatim: true }));
}

/**
 * At most this many validated addresses are tried for one request. A host
 * that resolves to more is still served by its first few; the cap only bounds
 * how long a request can spend on addresses that do not answer.
 */
const MAX_CONNECT_ATTEMPTS = 3;

/**
 * How long one address gets to establish a connection (TCP connect, plus the
 * TLS handshake for https) before the next validated address is tried. Never
 * applied to the last address, which is governed by `timeoutMs` as before.
 */
const DEFAULT_CONNECT_ATTEMPT_TIMEOUT_MS = 10_000;
let connectAttemptTimeoutMs = DEFAULT_CONNECT_ATTEMPT_TIMEOUT_MS;

/** Test hook — override the per-address connect timeout. Pass `null` to restore default. */
export function __setConnectAttemptTimeoutForTests(ms: number | null): void {
  connectAttemptTimeoutMs = ms ?? DEFAULT_CONNECT_ATTEMPT_TIMEOUT_MS;
}

export interface SsrfGuardOptions {
  /** See `SafeFetchInit.allowPrivateNetwork`. */
  allowPrivateNetwork?: boolean;
  /** See `SafeFetchInit.allowCarrierNat`. */
  allowCarrierNat?: boolean;
}

/** Strip the brackets Node keeps on IPv6 URL hostnames. */
function bareHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '');
}

/**
 * Resolve `hostname` and return only the records that are safe to dial.
 *
 * The single place the resolve-and-filter policy lives, shared by `safeFetch`,
 * `assertSafeUrl` and `createGuardedLookup` so they can never drift apart.
 * Throws `SsrfBlockedError` when nothing safe remains.
 *
 * Exported for callers that dial a socket themselves and therefore need the
 * validated record rather than a finished `Response` — the LLM egress CONNECT
 * proxy (`services/llm/llmEgressProxy.ts`) is the motivating case: it must pin
 * the IP it dials, and re-implementing this filter there would be exactly the
 * drift this helper exists to prevent.
 */
export async function resolveSafeRecords(
  hostname: string,
  opts?: SsrfGuardOptions
): Promise<{ safe: LookupAddress[]; allIps: string[] }> {
  // With `allowPrivateNetwork`, RFC1918/ULA appliance addresses are permitted
  // but metadata/loopback/link-local/CGNAT (etc.) are STILL blocked — unless the
  // caller additionally opts into carrier-NAT (Tailscale et al.). Both opt-ins
  // are self-host-only in practice; see `isBlockedForEgress`.
  const block = (ip: string): boolean => isBlockedForEgress(ip, opts);

  let records: LookupAddress[];
  if (isIpLiteralHost(hostname)) {
    // Dial the canonical form, so the socket connects to the same address the
    // classifier just judged rather than to whatever the resolver makes of an
    // alternative spelling.
    const literal = canonicalIpLiteral(hostname);
    if (block(literal)) {
      throw new SsrfBlockedError(`URL points to blocked address: ${hostname}`, {
        hostname,
        resolvedIps: [literal]
      });
    }
    records = [{ address: literal, family: literal.includes(':') ? 6 : 4 }];
  } else {
    records = await lookupImpl(hostname, { all: true });
    if (records.length === 0) {
      throw new SsrfBlockedError(`no DNS records for ${hostname}`, { hostname });
    }
  }

  const allIps = records.map((r) => r.address);
  const safe = records.filter((r) => !block(r.address));
  if (safe.length === 0) {
    throw new SsrfBlockedError(
      `all resolved IPs for ${hostname} are private/loopback/link-local`,
      { hostname, resolvedIps: allIps }
    );
  }
  return { safe, allIps };
}

/**
 * Validate a URL without sending anything: scheme must be http/https and the
 * hostname must resolve to at least one non-blocked address.
 *
 * Exists so a user-facing "test connection" route can fail with an actionable
 * `SsrfBlockedError` message instead of an opaque socket error. It is NOT a
 * substitute for connect-time enforcement — pair it with `createGuardedLookup`
 * (or the agents below), which is what actually closes the DNS-rebinding
 * window.
 */
export async function assertSafeUrl(urlStr: string, opts?: SsrfGuardOptions): Promise<void> {
  // #1105 tripwire, same reasoning as `safeFetch` below. This function sends no
  // request, but it DOES perform a real `dns.lookup` against a hostname the
  // caller does not control — an unbounded network wait. Run inside a held
  // withDbAccessContext transaction it pins a pooled connection
  // idle-in-transaction for the duration of that resolution, which is the same
  // pool-poison class as an outbound fetch, only quieter. Guarding the
  // primitive (rather than trusting each new route to register itself in
  // middleware/selfManagedDbContextRoutes.ts) is what makes a new violation
  // visible at all. Warn-only in prod; throws under DB_CONTEXT_TRIPWIRE_STRICT.
  assertOutsideHeldDbContext('assertSafeUrl');

  const u = new URL(urlStr);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new SsrfBlockedError(`unsupported URL scheme: ${u.protocol}`);
  }
  await resolveSafeRecords(bareHostname(u.hostname), opts);
}

/**
 * A `net.LookupFunction` that resolves normally but only ever hands back
 * addresses that pass the SSRF policy.
 *
 * Because it runs at CONNECT time and is the only resolution the socket sees,
 * there is no validate-then-connect window at all — the rebinding class is
 * closed by construction. Errors are delivered through the callback (never
 * thrown synchronously) because that is what Node's connect path expects.
 */
export function createGuardedLookup(opts?: SsrfGuardOptions): LookupFunction {
  return ((hostname: string, options: unknown, cb?: unknown) => {
    const callback = (typeof options === 'function' ? options : cb) as
      | ((e: NodeJS.ErrnoException | null, addr: string, family: number) => void)
      | ((e: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void)
      | undefined;

    if (!callback) return;

    const wantsAll =
      typeof options === 'object' && options !== null && 'all' in options &&
      (options as { all?: boolean }).all === true;

    resolveSafeRecords(bareHostname(hostname), opts).then(
      ({ safe }) => {
        if (wantsAll) {
          (callback as (e: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void)(null, safe);
          return;
        }
        const first = safe[0]!;
        (callback as (e: NodeJS.ErrnoException | null, addr: string, family: number) => void)(
          null,
          first.address,
          first.family
        );
      },
      (err: Error) => {
        (callback as (e: NodeJS.ErrnoException | null, addr: string, family: number) => void)(
          err as NodeJS.ErrnoException,
          '',
          0
        );
      }
    );
  }) as LookupFunction;
}

/**
 * HTTP/HTTPS agents whose DNS resolution is SSRF-guarded.
 *
 * For SDKs that build their own HTTP client and therefore cannot go through
 * `safeFetch` (the AWS SDK is the motivating case), handing them these agents
 * applies the same connect-time policy to every request they make.
 *
 * These agents keep sockets alive, and a reused socket skips the lookup. That
 * is sound only because every socket in a pair's pool was opened under the one
 * `opts` the pair was built with. Never share a pair between callers with
 * different policies — build a new pair per policy, as `createGuardedS3Client`
 * does per client.
 */
export function createGuardedHttpAgents(opts?: SsrfGuardOptions): {
  httpAgent: http.Agent;
  httpsAgent: https.Agent;
} {
  const lookup = createGuardedLookup(opts);
  return {
    httpAgent: new http.Agent({ lookup, keepAlive: true }),
    httpsAgent: new https.Agent({ lookup, keepAlive: true })
  };
}

export interface SafeFetchInit extends Omit<RequestInit, 'signal'> {
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Opt-in for on-prem appliance integrations (e.g. Pi-hole / AdGuard Home on
   * self-hosted deployments): allows RFC1918/ULA targets. Loopback, link-local,
   * cloud metadata (169.254.169.254), CGNAT, multicast, etc. remain blocked
   * even when this is true. Leave unset for strict (hosted-SaaS) behavior.
   */
  allowPrivateNetwork?: boolean;
  /**
   * Additionally permit carrier-grade-NAT (100.64.0.0/10) targets — the range an
   * overlay network such as Tailscale assigns to a device. Inert unless
   * `allowPrivateNetwork` is also set, so it cannot widen egress on the hosted
   * platform (where private networking is never opted in). Default off; enable
   * per integration only where an operator has affirmatively chosen it.
   */
  allowCarrierNat?: boolean;
  /**
   * Require a cleartext (`http:`) target to resolve to an RFC1918/ULA address.
   *
   * `allowPrivateNetwork` opts a self-hosted deployment into private targets,
   * but it does not narrow the scheme: `isAlwaysBlockedIp` returns false for
   * PUBLIC addresses too, so `http://example.com` is permitted alongside the
   * intended `http://10.0.0.5`. That sends the payload over the open internet
   * in the clear. Set this when the cleartext allowance exists only because
   * the operator owns both ends of an on-LAN hop.
   *
   * Enforced here rather than in the caller on purpose: the check has to run
   * against the SAME record that gets pinned, or the caller's resolution and
   * this one can disagree — reintroducing the TOCTOU window the pinning is
   * built to close. `https:` targets are unaffected.
   */
  requirePrivateForCleartext?: boolean;
  /**
   * Hard ceiling on the response body in bytes. On overrun the socket is
   * destroyed and ResponseTooLargeError is thrown — the partial body is never
   * buffered further. Unset = unbounded (legacy behavior for existing callers).
   *
   * safeFetch previously had NO size cap: it buffered whatever the remote sent.
   * That is an unauthenticated memory-exhaustion vector wherever a remote host
   * is attacker-influenced and the calling route is public — e.g. the SSO
   * callback's JWKS fetch (SR2-13).
   */
  maxBytes?: number;
  /**
   * Optional callback invoked with the validated IP `safeFetch` has pinned
   * for this request, before the socket is dialed. Exists so callers that
   * need to audit/record which address was actually contacted (e.g. the LLM
   * egress recorder) don't have to duplicate `resolveSafeRecords`.
   *
   * Normally called once. When the connection to that address cannot be
   * established and the request moves on to another validated address from
   * the same resolution, it is called again before each further dial, so the
   * last call names the address the request ended on.
   *
   * Fire-and-forget: a throwing `onConnect` is swallowed and never fails the
   * request or surfaces to the caller. Backward compatible — omitting it is a
   * no-op, matching every existing caller's behavior exactly.
   */
  onConnect?: (ip: string) => void;
  /**
   * Resolve as soon as the response HEADERS arrive, handing back a `Response`
   * whose body is the LIVE socket rather than a buffer.
   *
   * `safeFetch` otherwise buffers the entire body before resolving, which is
   * right for the one-shot JSON callers it was built for but wrong for a
   * long-lived event stream: an SSE chat completion buffered to completion
   * stops being a stream at all (every delta lands in one burst once the turn
   * ends) and pins the whole turn in memory for the life of the request.
   *
   * The SSRF properties are identical either way — resolution, filtering and
   * IP pinning all happen before the socket is dialed, so this option changes
   * only how the body is delivered. `maxBytes` is still enforced, but as bytes
   * FLOW: an overrun destroys the socket and errors the body stream, rather
   * than rejecting a promise that has already resolved. Cancelling the body
   * (`reader.cancel()`) destroys the request, so a consumer that stops reading
   * early releases the socket promptly.
   *
   * Defaults to false — every existing caller keeps byte-identical behavior.
   */
  streamResponse?: boolean;
  /**
   * Deadline, from the moment `safeFetch` is called, for the response HEADERS
   * to arrive — DNS resolution, connect, TLS and the wait for the status line.
   * Once headers arrive it no longer applies: a body that takes longer (a slow
   * non-streamed generation, say) is bounded only by `timeoutMs` inactivity,
   * `maxBytes` and the caller's `signal`. On expiry the request is destroyed
   * and the call rejects with `ResponseHeadersTimeoutError`.
   *
   * Distinct from `timeoutMs`, which is a socket-INACTIVITY timeout. Unset =
   * no headers deadline (existing behaviour).
   */
  headersTimeoutMs?: number;
  /**
   * Total deadline, from the moment `safeFetch` is called, for the whole
   * exchange: resolution, connect, headers and the body. `timeoutMs` measures
   * inactivity; `deadlineMs` bounds total duration. On expiry the request is
   * destroyed and the call (or, with `streamResponse`, the body) fails with
   * `ResponseDeadlineError`. Unset = no total deadline (existing behaviour).
   */
  deadlineMs?: number;
}

/**
 * Bound the pre-dial work (DNS resolution) by the request's signal and
 * deadlines. The OS resolver cannot be cancelled, so a stalled lookup keeps
 * running in the background; what matters is that the CALLER is released
 * promptly instead of waiting on it past every deadline it set. The abandoned
 * lookup's eventual result or error is ignored.
 */
function boundPreDial<T>(
  work: Promise<T>,
  bounds: { signal?: AbortSignal; timeoutMs?: number; headersTimeoutMs?: number }
): Promise<T> {
  const { signal, timeoutMs, headersTimeoutMs } = bounds;
  const hasTimeout = timeoutMs !== undefined && timeoutMs > 0;
  if (!signal && !hasTimeout && headersTimeoutMs === undefined) return work;

  return new Promise<T>((resolve, reject) => {
    const timers: NodeJS.Timeout[] = [];
    let done = false;
    const onAbort = (): void => finish(() => reject(abortError(signal!)));
    function finish(settle: () => void): void {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
      settle();
    }

    work.then(
      (value) => finish(() => resolve(value)),
      (err: unknown) => finish(() => reject(err))
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (hasTimeout) {
      timers.push(setTimeout(
        () => finish(() => reject(new Error(`request timed out after ${timeoutMs}ms`))),
        timeoutMs
      ));
    }
    if (headersTimeoutMs !== undefined) {
      timers.push(setTimeout(
        () => finish(() => reject(new ResponseHeadersTimeoutError(headersTimeoutMs))),
        headersTimeoutMs
      ));
    }
  });
}

/**
 * Statuses the `Response` constructor forbids from carrying a body at all.
 * Deliberately excludes the 1xx informational codes: `Response` rejects any
 * status below 200 outright, and Node never surfaces them to the response
 * callback anyway (they arrive on the request's `information` event).
 */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/** Copy Node's response headers onto a WHATWG `Headers`, preserving repeats. */
function toResponseHeaders(raw: http.IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(raw)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      for (const item of v) headers.append(k, item);
    } else {
      headers.set(k, String(v));
    }
  }
  return headers;
}

/**
 * Wrap a live `IncomingMessage` as a web `ReadableStream`, enforcing `maxBytes`
 * as the bytes flow and tearing the socket down on cancel/overrun.
 *
 * `registerFailer` hands the caller a way to fail this body, so a socket error
 * raised on the REQUEST after the promise already resolved (an abort, a
 * timeout, a reset mid-stream) can be surfaced here instead of vanishing into
 * an inert `reject` — a swallowed error there would leave the consumer waiting
 * forever on a stream that never ends. It is invoked synchronously during
 * construction, so the hook is in place before the `Response` is handed out.
 */
function streamedResponseBody(
  req: http.ClientRequest,
  res: http.IncomingMessage,
  maxBytes: number | undefined,
  registerFailer: (fail: (err: Error) => void) => void
): ReadableStream<Uint8Array> {
  let received = 0;
  let settled = false;

  /** Idempotent socket teardown — overrun, cancel and transport failure race. */
  const teardown = (): void => {
    res.destroy();
    req.destroy();
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        teardown();
        controller.error(err);
      };
      registerFailer(fail);

      res.on('data', (c: Buffer) => {
        if (settled) return;
        received += c.length;
        if (maxBytes !== undefined && received > maxBytes) {
          // Overrun: stop the socket before the next chunk lands, then error
          // the body. Mirrors the buffered path's teardown, except the caller
          // learns about it through the stream rather than a rejected promise.
          // `maxBytes` exactly is allowed; the first byte past it is not.
          settled = true;
          teardown();
          controller.error(new ResponseTooLargeError(maxBytes));
          return;
        }
        controller.enqueue(new Uint8Array(c));
        // Respect the consumer's backpressure: stop reading the socket once
        // the queue is full and let `pull` restart it.
        if ((controller.desiredSize ?? 1) <= 0) res.pause();
      });

      res.on('end', () => {
        if (settled) return;
        settled = true;
        controller.close();
      });

      res.on('error', fail);

      // A peer that drops the connection part-way through the body may emit
      // neither 'end' nor 'error' — only 'close', with `res.complete` false.
      // Treating that as a clean EOF would hand the consumer a silently
      // truncated response; leaving it unhandled would hang them forever.
      res.on('close', () => {
        if (settled) return;
        if (!res.complete) {
          fail(new Error('response closed before the body was complete'));
          return;
        }
        settled = true;
        controller.close();
      });
    },
    pull() {
      res.resume();
    },
    cancel() {
      // A consumer that walked away must not leave the socket open — or, for
      // an LLM endpoint, leave the model generating into a dead connection.
      settled = true;
      teardown();
    }
  });
}

/**
 * Resolve `url.hostname` once, reject if all resolved IPs are private, and
 * dispatch the request pinned to a validated IP. The hostname is preserved as
 * SNI and used to derive Host so TLS verification succeeds normally.
 *
 * Throws `SsrfBlockedError` for policy violations and `Error` (with `cause`)
 * for transport/TLS/timeout failures. Returns a standard `Response` — buffered
 * by default, or streamed when `init.streamResponse` is set.
 */
export async function safeFetch(urlStr: string, init: SafeFetchInit = {}): Promise<Response> {
  // #1105 tripwire: an outbound HTTP request inside a held withDbAccessContext
  // transaction pins a pooled connection idle-in-transaction across the network
  // round-trip — the exact txn-around-slow-work pattern that poisoned the pool
  // (and the #1697 integration-sync class). safeFetch is the shared SSRF-guarded
  // fetch wrapper, so guarding it here covers every caller that routes through
  // it (Huntress/Pax8/SSO/DNS/SentinelOne/webhooks/PSA/log-forwarding). Note:
  // modules that call global `fetch()` directly bypass safeFetch and are NOT
  // covered by this guard — instrumenting those is out of scope for this slice.
  // Warn-only by default; throws when DB_CONTEXT_TRIPWIRE_STRICT is set (the
  // suites that exercise the tripwire set it), so a test that runs a new
  // violation under it fails instead of only logging.
  //
  // `includeOuterTransaction`: runOutsideDbContext only re-routes queries, so a
  // fetch inside it while an outer context is still open pins that context's
  // connection just the same.
  assertOutsideHeldDbContext('safeFetch', { includeOuterTransaction: true });

  const deadlineMs = init.deadlineMs !== undefined && init.deadlineMs > 0 ? init.deadlineMs : undefined;
  if (deadlineMs === undefined) return safeFetchWithin(urlStr, init, init.signal, () => {});
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new ResponseDeadlineError(deadlineMs)), deadlineMs);
  timer.unref?.();
  const signal = init.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
  return safeFetchWithin(urlStr, init, signal, () => clearTimeout(timer));
}

/**
 * `safeFetch` after its deadline is armed. `signal` is the caller's signal
 * combined with the deadline; `release` clears the deadline once the request
 * is over (or never started).
 */
async function safeFetchWithin(
  urlStr: string,
  init: SafeFetchInit,
  signal: AbortSignal | undefined,
  release: () => void,
): Promise<Response> {
  let started = false;
  try {
    const response = await safeFetchRequest(urlStr, init, signal, () => {
      started = true;
    }, release);
    return response;
  } finally {
    if (!started) release();
  }
}

async function safeFetchRequest(
  urlStr: string,
  init: SafeFetchInit,
  signal: AbortSignal | undefined,
  onRequestStarted: () => void,
  release: () => void,
): Promise<Response> {
  const u = new URL(urlStr);

  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new SsrfBlockedError(`unsupported URL scheme: ${u.protocol}`);
  }

  const hostname = bareHostname(u.hostname);

  const headersTimeoutMs =
    init.headersTimeoutMs !== undefined && init.headersTimeoutMs > 0 ? init.headersTimeoutMs : undefined;
  const startedAt = Date.now();

  // Resolve + filter through the SHARED policy helper, so `safeFetch`,
  // `assertSafeUrl` and `createGuardedLookup` can never drift apart on what
  // counts as a blocked address. It rejects literal private IPs without any DNS
  // work, and throws when every resolved record is blocked. Resolution is
  // bounded by the caller's signal and deadlines like the rest of the request.
  const { safe, allIps } = await boundPreDial(
    resolveSafeRecords(hostname, {
      allowPrivateNetwork: init.allowPrivateNetwork,
      allowCarrierNat: init.allowCarrierNat
    }),
    { signal, timeoutMs: init.timeoutMs, headersTimeoutMs }
  );
  const firstRecord = safe[0]!;

  const notifyConnect = (ip: string): void => {
    if (!init.onConnect) return;
    try {
      init.onConnect(ip);
    } catch {
      // Fire-and-forget by contract — a caller's audit hook must never be
      // able to fail the request it's merely observing.
    }
  };

  notifyConnect(firstRecord.address);

  // Cleartext is only conceded for the on-LAN hop the operator owns. Checked
  // against the first pinned record specifically, so it cannot drift from the
  // address actually dialed; any further address the request may fall back to
  // must pass the same test (below).
  const cleartextNeedsPrivate = init.requirePrivateForCleartext === true && u.protocol === 'http:';
  if (cleartextNeedsPrivate && !isRfc1918OrUla(firstRecord.address)) {
    throw new SsrfBlockedError(
      `cleartext http is only permitted to private (RFC1918/ULA) addresses; ${hostname} resolves to ${firstRecord.address}`,
      { hostname, resolvedIps: allIps }
    );
  }

  // The addresses this request may dial, in resolver order. Every one passed
  // the policy above in this single resolution; nothing is resolved again
  // before or between attempts, so a rebind cannot add an address.
  const candidates = (cleartextNeedsPrivate ? safe.filter((r) => isRfc1918OrUla(r.address)) : safe)
    .slice(0, MAX_CONNECT_ATTEMPTS);

  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  const method = (init.method || 'GET').toUpperCase();

  // Normalize headers into a plain object.
  const headers: Record<string, string> = {};
  if (init.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((v, k) => {
        if (k.toLowerCase() !== 'host') headers[k] = v;
      });
    } else if (Array.isArray(init.headers)) {
      for (const [k, v] of init.headers) {
        if (k.toLowerCase() !== 'host') headers[k] = v;
      }
    } else {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        if (k.toLowerCase() !== 'host') headers[k] = v;
      }
    }
  }
  // Derive Host from the URL every time. Callers may pass tenant-controlled
  // headers, so preserving a supplied Host would let tenants override vhost
  // routing metadata.
  headers['Host'] = u.host; // includes port if non-default

  // Body serialization: support string, Buffer, URLSearchParams, and
  // ArrayBuffer/TypedArray. Callers shouldn't hand us streams/FormData here.
  let bodyBuf: Buffer | undefined;
  if (init.body != null) {
    if (typeof init.body === 'string') {
      bodyBuf = Buffer.from(init.body);
    } else if (init.body instanceof URLSearchParams) {
      bodyBuf = Buffer.from(init.body.toString());
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
    } else if (Buffer.isBuffer(init.body)) {
      bodyBuf = init.body as Buffer;
    } else if (init.body instanceof ArrayBuffer) {
      bodyBuf = Buffer.from(init.body);
    } else if (ArrayBuffer.isView(init.body)) {
      const view = init.body as ArrayBufferView;
      bodyBuf = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
    } else {
      throw new TypeError('safeFetch: unsupported body type');
    }
  }

  const attempt: DialContext = {
    url: u, hostname, port, method, headers, bodyBuf, init, signal,
    headersTimeoutMs, startedAt, onRequestStarted, release
  };

  // Try the candidates in order. Only an attempt that could not establish its
  // connection hands over to the next address (see `dialPinned`); anything
  // else, and every outcome of the last attempt, is returned or thrown as is.
  for (let i = 0; ; i++) {
    const record = candidates[i]!;
    if (i > 0) notifyConnect(record.address);
    try {
      return await dialPinned(attempt, record, i === candidates.length - 1);
    } catch (err) {
      if (!(err instanceof ConnectAttemptFailed)) throw err;
      // Logged here because only the LAST attempt's error reaches the caller.
      const code = (err.attemptError as NodeJS.ErrnoException).code;
      console.warn(
        `safeFetch: could not connect to ${hostname} at ${record.address} `
          + `(${code ? `${code}: ` : ''}${err.attemptError.message}); `
          + `trying the next resolved address (${i + 2}/${candidates.length})`
      );
    }
  }
}

/** Everything one dial attempt needs from `safeFetchRequest`; shared by every attempt. */
interface DialContext {
  url: URL;
  hostname: string;
  port: number;
  method: string;
  headers: Record<string, string>;
  bodyBuf: Buffer | undefined;
  init: SafeFetchInit;
  signal: AbortSignal | undefined;
  headersTimeoutMs: number | undefined;
  startedAt: number;
  onRequestStarted: () => void;
  release: () => void;
}

/**
 * One validated address could not establish its connection, and the request
 * may try the next. Internal to `safeFetch`: the last address never raises it,
 * so it never reaches a caller.
 */
class ConnectAttemptFailed extends Error {
  constructor(public readonly attemptError: Error) {
    super(attemptError.message);
    this.name = 'ConnectAttemptFailed';
  }
}

/**
 * One request, pinned to one validated `record`. When the connection to it
 * fails or stalls before it is established, and this is not the last
 * candidate, the attempt rejects with `ConnectAttemptFailed` so the caller can
 * move on. At that point no request byte has reached the peer: Node holds
 * cleartext writes until the TCP connect, and TLS application data until the
 * handshake completes. A TLS handshake that FAILS (as opposed to stalling) is
 * final, as is anything after the connection is established.
 */
function dialPinned(ctx: DialContext, record: LookupAddress, isLast: boolean): Promise<Response> {
  const {
    url: u, hostname, port, method, headers, bodyBuf, init, signal,
    headersTimeoutMs, startedAt, onRequestStarted, release
  } = ctx;
  const isHttps = u.protocol === 'https:';
  const requester = isHttps ? https.request : http.request;
  const timeoutMs = init.timeoutMs;

  // Build a `lookup` that always hands back the validated record, so a DNS
  // rebind between now and the TCP connect cannot redirect us.
  const pinnedLookup: LookupFunction = (_hn, opts, cb) => {
    const callback = (typeof opts === 'function' ? opts : cb) as
      | ((e: NodeJS.ErrnoException | null, addr: string, family: number) => void)
      | ((e: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void)
      | undefined;

    // Unreachable via Node's connect path (it always supplies a callback), but
    // if it ever happened, silently returning would hang the request forever
    // when no timeoutMs is set — throw so it surfaces as a connection error.
    if (!callback) throw new Error('pinnedLookup invoked without a callback');

    if (typeof opts === 'object' && opts !== null && 'all' in opts && opts.all === true) {
      (callback as (e: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void)(null, [record]);
      return;
    }

    (callback as (e: NodeJS.ErrnoException | null, addr: string, family: number) => void)(
      null,
      record.address,
      record.family
    );
  };

  const reqOptions: https.RequestOptions = {
    method,
    host: hostname,
    port,
    path: u.pathname + u.search,
    headers,
    lookup: pinnedLookup,
    // A fresh connection per request. Node's global agent keeps sockets alive
    // and pools them by host:port alone, so a pooled socket would carry this
    // request to whatever address an EARLIER request pinned — possibly under a
    // looser policy (`allowPrivateNetwork` / `allowCarrierNat`) — without ever
    // calling `pinnedLookup` or re-checking the address. `agent: false` makes
    // every request dial through its own pinned, policy-checked lookup.
    agent: false
    // No `rejectUnauthorized: false` — cert chain validation stays on.
    // Node's default `servername` for https.request is `host`, which is the
    // original hostname — so SNI and cert hostname check both work correctly.
  };

  return new Promise<Response>((resolve, reject) => {
    // Set once the body has been handed to the caller as a live stream. From
    // that moment a transport error can no longer `reject` (the promise is
    // settled), so it has to be raised on the body instead.
    let failStream: ((err: Error) => void) | null = null;
    let headersTimer: NodeJS.Timeout | undefined;
    const clearHeadersTimer = (): void => {
      if (headersTimer !== undefined) clearTimeout(headersTimer);
      headersTimer = undefined;
    };

    // Connection progress of this attempt (see `dialPinned`).
    let tcpConnected = false;
    let established = false;
    let stalled = false;
    let handedOff = false;
    let attemptTimer: NodeJS.Timeout | undefined;
    const clearAttemptTimer = (): void => {
      if (attemptTimer !== undefined) clearTimeout(attemptTimer);
      attemptTimer = undefined;
    };
    const markEstablished = (): void => {
      established = true;
      clearAttemptTimer();
    };

    /**
     * Build and resolve the caller's `Response`. The constructor throws for a
     * status outside 200-599 and for any body on a null-body status, and this
     * runs inside socket callbacks where a throw would escape as an uncaught
     * exception. So a null-body status always gets a null body, and anything
     * else that throws becomes an ordinary rejection.
     */
    const respond = (res: http.IncomingMessage, body: BodyInit | null): void => {
      const status = res.statusCode ?? 0;
      try {
        resolve(new Response(NULL_BODY_STATUSES.has(status) ? null : body, {
          status,
          statusText: res.statusMessage ?? '',
          headers: toResponseHeaders(res.headers)
        }));
      } catch (err) {
        req.destroy();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };

    // True once the response callback has run (the promise is then settled or
    // about to be, by `respond` or by a body error).
    let responded = false;

    const req = requester(reqOptions, (res) => {
      responded = true;
      clearHeadersTimer();
      markEstablished();
      // Follow no redirects by default — caller gets the raw response and can
      // re-invoke safeFetch if they want to trust the Location header.
      const status = res.statusCode ?? 0;

      if (!Number.isInteger(status) || status < 200 || status > 599) {
        // Not representable as a `Response`; refuse it as a transport failure.
        req.destroy();
        reject(new Error(`upstream answered with an invalid HTTP status (${status})`));
        return;
      }

      if (init.streamResponse) {
        // 204/304 and friends may not carry a body at all; draining is the only
        // correct thing to do with the (empty) stream.
        if (NULL_BODY_STATUSES.has(status)) {
          // There is no body to hand back and the promise is about to settle,
          // so a later socket error has nowhere to be reported TO — but it
          // must still have a listener. An 'error' emitted on an EventEmitter
          // with none throws synchronously and takes the whole process down,
          // and this is the one response path with neither a stream nor a live
          // `reject` to absorb it. Route both the response's and the request's
          // late errors here so they leave a trace instead of vanishing.
          const noteLateError = (err: Error): void => {
            console.warn(
              `safeFetch: ignoring a late error on an already-returned ${status} response `
                + `from ${hostname}: ${err.message}`
            );
          };
          res.on('error', noteLateError);
          failStream = noteLateError;
          res.resume();
          respond(res, null);
          return;
        }
        const body = streamedResponseBody(req, res, init.maxBytes, (fail) => {
          failStream = fail;
        });
        respond(res, body);
        return;
      }

      const chunks: Buffer[] = [];
      let received = 0;
      let aborted = false;
      const maxBytes = init.maxBytes;
      res.on('data', (c: Buffer) => {
        if (aborted) return;
        received += c.length;
        if (maxBytes !== undefined && received > maxBytes) {
          // Overrun: stop buffering, tear down the socket, and reject exactly
          // once. `aborted` guards against a late 'data'/'end' after destroy
          // re-entering resolve/reject (the Promise is already settled).
          aborted = true;
          req.destroy();
          reject(new ResponseTooLargeError(maxBytes));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        if (aborted) return;
        respond(res, Buffer.concat(chunks));
      });
      res.on('error', reject);
      // A peer that drops mid-body may emit only 'close'; never resolve or
      // hang on a truncated buffer.
      res.on('close', () => {
        if (!res.complete) reject(new Error('response closed before the body was complete'));
      });
    });

    // A 101 (protocol upgrade) or a CONNECT tunnel never reaches the response
    // callback: Node hands over the raw socket on these events instead, or
    // destroys it when nobody listens, leaving the promise pending forever.
    // Neither is an HTTP response this function can return, so refuse both.
    const refuseRawSocket = (kind: string) => (_res: http.IncomingMessage, socket: Duplex): void => {
      // Node detaches its own socket listeners on hand-over; keep one so a
      // queued socket error cannot surface as an unhandled 'error' event.
      socket.on('error', () => {});
      socket.destroy();
      req.destroy();
      reject(new Error(`upstream attempted a ${kind}, which is not supported`));
    };
    req.on('upgrade', refuseRawSocket('protocol upgrade'));
    req.on('connect', refuseRawSocket('CONNECT tunnel (protocol upgrade)'));
    // The request closed without ever producing a response (and without an
    // 'error' carrying a more specific reason): settle rather than hang.
    req.once('close', () => {
      if (!responded) reject(new Error('connection closed before a response was received'));
    });

    req.on('socket', (socket: Socket) => {
      const onTcpConnect = (): void => {
        tcpConnected = true;
        if (!isHttps) markEstablished();
      };
      if (socket.connecting) socket.once('connect', onTcpConnect);
      else onTcpConnect();
      if (isHttps) socket.once('secureConnect', markEstablished);
    });

    req.on('error', (err) => {
      // Includes TLS verification failures — propagate without suppression.
      // Once the body is streaming the promise is already settled, so the only
      // place left to report a socket failure is the body itself; rejecting
      // here would be a no-op and leave the consumer waiting on a stream that
      // never ends. This is also the path an abort/timeout `req.destroy(err)`
      // takes mid-stream.
      if (failStream) {
        failStream(err);
        return;
      }
      // The connect to this address failed, or stalled before the connection
      // was established: let the next validated address have a go. Never after
      // the caller's own abort, deadline or headers timeout.
      if (
        !isLast && !responded && !established && (!tcpConnected || stalled)
        && !signal?.aborted && !(err instanceof ResponseHeadersTimeoutError)
      ) {
        handedOff = true;
        reject(new ConnectAttemptFailed(err));
        return;
      }
      reject(err);
    });

    if (timeoutMs && timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        if (!established) stalled = true;
        req.destroy(new Error(`request timed out after ${timeoutMs}ms`));
      });
    }

    if (!isLast) {
      // Bound how long this address may take to establish the connection, so
      // one that never answers costs seconds rather than the whole timeoutMs.
      const attemptMs = timeoutMs && timeoutMs > 0
        ? Math.min(connectAttemptTimeoutMs, timeoutMs)
        : connectAttemptTimeoutMs;
      attemptTimer = setTimeout(() => {
        attemptTimer = undefined;
        stalled = true;
        req.destroy(new Error(`connection to ${record.address} was not established within ${attemptMs}ms`));
      }, attemptMs);
      req.once('close', clearAttemptTimer);
    }

    if (headersTimeoutMs !== undefined) {
      // Whatever is left of the deadline after DNS resolution.
      const remaining = Math.max(0, headersTimeoutMs - (Date.now() - startedAt));
      headersTimer = setTimeout(() => {
        headersTimer = undefined;
        req.destroy(new ResponseHeadersTimeoutError(headersTimeoutMs));
      }, remaining);
      req.once('close', clearHeadersTimer);
    }

    // The request owns the deadline from here: it is cleared when the request
    // is over, which for a streamed body is when the body ends or is cancelled.
    // An attempt that handed over to the next address passes it on instead.
    onRequestStarted();
    req.once('close', () => {
      if (!handedOff) release();
    });

    if (signal) {
      // Abort settles the promise directly: an already-closed request emits no
      // further 'error', so relying on destroy() alone could leave it pending.
      // Once a response is out, a live body is failed through req's 'error'.
      const onAbort = (): void => {
        const err = abortError(signal);
        if (!responded) reject(err);
        req.destroy(err);
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
        // Drop the listener once the request is finished with, so a long-lived
        // caller signal does not accumulate one closure per completed request.
        req.once('close', () => signal.removeEventListener('abort', onAbort));
      }
    }

    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

/** HTTP statuses that carry a `Location` we are willing to follow. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Default hop ceiling for `safeFetchFollowingRedirects`. */
export const SAFE_FETCH_MAX_REDIRECTS = 5;

/** Headers that must never survive a hop to a different origin. */
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

function stripCredentialHeaders(headers: SafeFetchInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const entries: Array<[string, string]> =
    headers instanceof Headers
      ? [...headers.entries()]
      : Array.isArray(headers)
        ? (headers as Array<[string, string]>)
        : Object.entries(headers as Record<string, string>);
  for (const [k, v] of entries) {
    if (!CREDENTIAL_HEADERS.includes(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/**
 * `safeFetch`, plus an EXPLICIT, bounded redirect chain.
 *
 * `safeFetch` deliberately follows nothing: it hands back the 3xx so the caller
 * decides whether the `Location` is worth trusting. That default must not
 * change — every existing caller relies on it — but some server-configured
 * endpoints simply cannot be reached without following, GitHub release assets
 * being the motivating case (`github.com/.../releases/download/...` 302s to
 * `objects.githubusercontent.com`). Converting such a caller to bare `safeFetch`
 * turns a working download into `download failed with status 302`.
 *
 * The security property that matters: each hop is a fresh `safeFetch`, so every
 * intermediate URL is independently DNS-resolved, filtered and IP-pinned. A
 * redirect to `169.254.169.254`, loopback or RFC1918 is rejected exactly as a
 * first-party URL would be — which is the whole reason naive
 * `redirect: 'follow'` is an SSRF bypass and this loop is not.
 *
 * Method/credential handling follows the fetch spec's intent: a 303 (and a
 * 301/302 on a non-GET/HEAD request) degrades to GET with no body, and
 * credential headers are dropped when the hop crosses to a different origin.
 */
export interface FollowRedirectsOptions {
  /**
   * Optional host predicate, checked against EVERY hop (the first URL
   * included) before that hop is resolved or dialed. A hop that fails it
   * throws `SsrfBlockedError`. This narrows, never widens: the pinned-DNS
   * address policy still applies to every hop that passes. Used by callers
   * that may only talk to a fixed allowlist of hosts (the workload
   * image-currency registry client).
   */
  allowHost?: (url: URL) => boolean;
}

export async function safeFetchFollowingRedirects(
  urlStr: string,
  init: SafeFetchInit = {},
  maxRedirects: number = SAFE_FETCH_MAX_REDIRECTS,
  options: FollowRedirectsOptions = {}
): Promise<Response> {
  let currentUrl = urlStr;
  let currentInit: SafeFetchInit = init;
  // One deadline for the whole chain, not a fresh one per hop.
  const endsAt = init.deadlineMs !== undefined && init.deadlineMs > 0 ? Date.now() + init.deadlineMs : undefined;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (options.allowHost) {
      const target = new URL(currentUrl);
      if (!options.allowHost(target)) {
        throw new HostNotAllowedError(target.hostname);
      }
    }
    if (endsAt !== undefined) {
      const remaining = endsAt - Date.now();
      if (remaining <= 0) throw new ResponseDeadlineError(init.deadlineMs!);
      currentInit = { ...currentInit, deadlineMs: remaining };
    }
    let response: Response;
    try {
      response = await safeFetch(currentUrl, currentInit);
    } catch (err) {
      // A hop runs on what is left of the chain's deadline; report the
      // caller's own deadline, not the remainder.
      if (err instanceof ResponseDeadlineError && init.deadlineMs !== undefined) throw new ResponseDeadlineError(init.deadlineMs);
      throw err;
    }
    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const location = response.headers.get('location');
    if (!location) {
      throw new SsrfBlockedError(
        `redirect (${response.status}) from ${currentUrl} has no Location header`
      );
    }

    let next: URL;
    try {
      // Relative Locations are legal, so resolve against the CURRENT url.
      next = new URL(location, currentUrl);
    } catch {
      throw new SsrfBlockedError(
        `redirect (${response.status}) from ${currentUrl} has an unparseable Location: ${location}`
      );
    }
    if (next.protocol !== 'https:' && next.protocol !== 'http:') {
      throw new SsrfBlockedError(`redirect to unsupported URL scheme: ${next.protocol}`);
    }

    const method = (currentInit.method || 'GET').toUpperCase();
    const degradeToGet =
      response.status === 303 || (response.status !== 307 && response.status !== 308 && method !== 'GET' && method !== 'HEAD');
    const crossOrigin = new URL(currentUrl).origin !== next.origin;

    currentInit = {
      ...currentInit,
      ...(degradeToGet ? { method: 'GET', body: undefined } : {}),
      ...(crossOrigin ? { headers: stripCredentialHeaders(currentInit.headers) } : {})
    };
    currentUrl = next.toString();
  }

  // Exhausting the budget is an error, never a silent success: returning the
  // last 3xx would hand the caller a body it did not ask for.
  throw new Error(`too many redirects (more than ${maxRedirects}) starting at ${urlStr}`);
}
