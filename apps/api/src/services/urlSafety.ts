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
 * `lookup` function that always returns the validated IP. The hostname is
 * preserved as SNI. `safeFetch` derives the `Host` header from the URL and
 * ignores caller-supplied Host values so tenant-controlled headers cannot
 * redirect virtual-host routing. Certificate chain validation is NEVER disabled.
 */
import { lookup as dnsLookup } from 'dns/promises';
import type { LookupAddress } from 'dns';
import https from 'https';
import http from 'http';
import type { LookupFunction } from 'net';
import { assertOutsideHeldDbContext } from '../db';

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

/** The response body exceeded the caller's `maxBytes` ceiling. The socket is destroyed. */
export class ResponseTooLargeError extends Error {
  constructor(public readonly maxBytes: number) {
    super(`response body exceeded maxBytes (${maxBytes})`);
    this.name = 'ResponseTooLargeError';
  }
}

// IPv4 ranges that must never be dialed from the server.
// Ordered roughly by how commonly they appear.
const PRIVATE_V4_MATCHERS: Array<(octets: number[]) => boolean> = [
  (o) => o[0] === 10, // 10.0.0.0/8
  (o) => o[0] === 127, // 127.0.0.0/8 loopback
  (o) => o[0] === 192 && o[1] === 168, // 192.168.0.0/16
  (o) => o[0] === 172 && o[1]! >= 16 && o[1]! <= 31, // 172.16.0.0/12
  (o) => o[0] === 169 && o[1] === 254, // 169.254.0.0/16 link-local + cloud metadata
  (o) => o[0] === 100 && o[1]! >= 64 && o[1]! <= 127, // 100.64.0.0/10 CGNAT
  (o) => o[0] === 0, // 0.0.0.0/8 unspecified/this-network
  (o) => o[0]! >= 224, // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  // Documentation / TEST-NET ranges — outbound to these is never legitimate.
  (o) => o[0] === 192 && o[1] === 0 && o[2] === 0, // 192.0.0.0/24
  (o) => o[0] === 192 && o[1] === 0 && o[2] === 2, // 192.0.2.0/24 TEST-NET-1
  (o) => o[0] === 198 && (o[1] === 18 || o[1] === 19), // 198.18.0.0/15 benchmarking
  (o) => o[0] === 198 && o[1] === 51 && o[2] === 100, // 198.51.100.0/24 TEST-NET-2
  (o) => o[0] === 203 && o[1] === 0 && o[2] === 113 // 203.0.113.0/24 TEST-NET-3
];

function parseV4(ip: string): number[] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return octets;
}

function isPrivateV4(ip: string): boolean {
  const octets = parseV4(ip);
  if (!octets) return false;
  return PRIVATE_V4_MATCHERS.some((m) => m(octets));
}

/**
 * If `ip` is an IPv4-mapped IPv6 literal (`::ffff:…`), return the embedded IPv4
 * address as a dotted-decimal string; otherwise return null. Handles BOTH the
 * dotted-decimal form (`::ffff:169.254.169.254`) AND the hex-pair form
 * (`::ffff:a9fe:a9fe`), case-insensitively.
 *
 * The hex-pair form is the dangerous one: `parseInt('a9fe',16)`/`parseInt('a9fe',16)`
 * decode to 169.254.169.254 (cloud metadata) yet `::ffff:a9fe:a9fe` still
 * contains a `:` after stripping the prefix, so a naive check routes it to the
 * IPv6 fc/fd path and never matches — an SSRF filter bypass.
 */
function mappedV4(ip: string): string | null {
  const lower = ip.toLowerCase();
  if (!lower.startsWith('::ffff:')) return null;
  const rest = lower.slice('::ffff:'.length);
  // Dotted-decimal embedded form: ::ffff:a.b.c.d
  if (rest.includes('.')) {
    return parseV4(rest) ? rest : null;
  }
  // Hex-pair embedded form: ::ffff:HHHH:HHHH
  const groups = rest.split(':');
  if (groups.length !== 2) return null;
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const hi = parseInt(groups[0]!, 16);
  const lo = parseInt(groups[1]!, 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d AND ::ffff:HHHH:HHHH hex-pair forms)
  const mapped = mappedV4(lower);
  if (mapped !== null) {
    return isPrivateV4(mapped);
  }
  // Unique Local Addresses (fc00::/7) — first byte 0xfc or 0xfd
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // Link-local (fe80::/10) — fe80 .. febf
  if (/^fe[89ab]/.test(lower)) return true;
  // Multicast ff00::/8
  if (lower.startsWith('ff')) return true;
  return false;
}

/**
 * Returns true if `ip` is a literal address in a range that must not be
 * contacted from the server. Accepts both IPv4 and IPv6 literals (including
 * IPv4-mapped IPv6 like `::ffff:10.0.0.1`).
 */
export function isPrivateIp(ip: string): boolean {
  if (!ip) return true;
  // Normalize any IPv4-mapped IPv6 literal (dotted OR hex-pair) to its embedded
  // IPv4 first, so both forms route through the IPv4 matchers.
  const mapped = mappedV4(ip);
  if (mapped !== null) return isPrivateV4(mapped);
  if (ip.includes(':')) return isPrivateV6(ip);
  return isPrivateV4(ip);
}

// RFC1918 (IPv4 private) + ULA (IPv6 fc00::/7) only. This is the strict subset
// of `isPrivateIp` that an on-prem appliance integration may legitimately need
// to reach (e.g. a Pi-hole / AdGuard Home box on the LAN). Deliberately
// EXCLUDES loopback (127/8, ::1), link-local + cloud metadata (169.254/16,
// fe80::/10), CGNAT (100.64/10), unspecified (0/8), multicast/reserved, and
// documentation/TEST-NET ranges — those are never a legitimate appliance
// target and remain blocked even when private networking is opted in.
function isRfc1918V4(ip: string): boolean {
  const octets = parseV4(ip);
  if (!octets) return false;
  return (
    octets[0] === 10 || // 10.0.0.0/8
    (octets[0] === 192 && octets[1] === 168) || // 192.168.0.0/16
    (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) // 172.16.0.0/12
  );
}

/**
 * True only for RFC1918 IPv4 or ULA IPv6 (fc00::/7) addresses — the ranges an
 * on-prem appliance integration may opt into reaching. Loopback, link-local,
 * metadata, CGNAT, multicast, etc. are NOT included here (see `isAlwaysBlockedIp`).
 */
export function isRfc1918OrUla(ip: string): boolean {
  if (!ip) return false;
  const lower = ip.toLowerCase();
  // Normalize any IPv4-mapped IPv6 literal (dotted OR hex-pair, case-insensitive)
  // to its embedded IPv4, so embedded RFC1918 is recognized as RFC1918 and
  // embedded metadata is treated as non-RFC1918 (stays always-blocked).
  const mapped = mappedV4(lower);
  if (mapped !== null) return isRfc1918V4(mapped);
  if (lower.includes(':')) {
    // ULA fc00::/7 — first byte 0xfc or 0xfd.
    return lower.startsWith('fc') || lower.startsWith('fd');
  }
  return isRfc1918V4(lower);
}

/**
 * IPs that must NEVER be dialed even when `allowPrivateNetwork` is set: any
 * private/loopback/link-local/metadata/CGNAT/multicast range that is NOT a
 * plain RFC1918/ULA appliance address. Public IPs return false (allowed).
 */
export function isAlwaysBlockedIp(ip: string): boolean {
  return isPrivateIp(ip) ? !isRfc1918OrUla(ip) : false;
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

export interface SsrfGuardOptions {
  /** See `SafeFetchInit.allowPrivateNetwork`. */
  allowPrivateNetwork?: boolean;
}

/** A hostname that is already an IP literal needs no DNS work. */
function isIpLiteral(hostname: string): boolean {
  return /^[\d.]+$/.test(hostname) || hostname.includes(':');
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
  // but metadata/loopback/link-local/CGNAT (etc.) are STILL blocked.
  const block = opts?.allowPrivateNetwork ? isAlwaysBlockedIp : isPrivateIp;

  let records: LookupAddress[];
  if (isIpLiteral(hostname)) {
    if (block(hostname)) {
      throw new SsrfBlockedError(`URL points to blocked address: ${hostname}`, {
        hostname,
        resolvedIps: [hostname]
      });
    }
    records = [{ address: hostname, family: hostname.includes(':') ? 6 : 4 }];
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
   * Optional callback invoked once with the validated IP `safeFetch` has
   * pinned for this request, before the socket is dialed. Exists so callers
   * that need to audit/record which address was actually contacted (e.g. the
   * LLM egress recorder) don't have to duplicate `resolveSafeRecords`.
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
  // Warn-only in prod; throws in CI (strict) so a new violation fails the build
  // instead of surfacing only in Sentry after an incident.
  assertOutsideHeldDbContext('safeFetch');

  const u = new URL(urlStr);

  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new SsrfBlockedError(`unsupported URL scheme: ${u.protocol}`);
  }

  const hostname = bareHostname(u.hostname);

  // Resolve + filter through the SHARED policy helper, so `safeFetch`,
  // `assertSafeUrl` and `createGuardedLookup` can never drift apart on what
  // counts as a blocked address. It rejects literal private IPs without any DNS
  // work, and throws when every resolved record is blocked.
  const { safe, allIps } = await resolveSafeRecords(hostname, {
    allowPrivateNetwork: init.allowPrivateNetwork
  });
  const safeRecord = safe[0]!;

  if (init.onConnect) {
    try {
      init.onConnect(safeRecord.address);
    } catch {
      // Fire-and-forget by contract — a caller's audit hook must never be
      // able to fail the request it's merely observing.
    }
  }

  // Cleartext is only conceded for the on-LAN hop the operator owns. Checked
  // against the pinned record specifically, so it cannot drift from the address
  // actually dialed.
  if (init.requirePrivateForCleartext && u.protocol === 'http:' && !isRfc1918OrUla(safeRecord.address)) {
    throw new SsrfBlockedError(
      `cleartext http is only permitted to private (RFC1918/ULA) addresses; ${hostname} resolves to ${safeRecord.address}`,
      { hostname, resolvedIps: allIps }
    );
  }

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
      (callback as (e: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void)(null, [safeRecord]);
      return;
    }

    (callback as (e: NodeJS.ErrnoException | null, addr: string, family: number) => void)(
      null,
      safeRecord.address,
      safeRecord.family
    );
  };

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

  const isHttps = u.protocol === 'https:';
  const requester = isHttps ? https.request : http.request;

  const reqOptions: https.RequestOptions = {
    method,
    host: hostname,
    port,
    path: u.pathname + u.search,
    headers,
    lookup: pinnedLookup
    // No `rejectUnauthorized: false` — cert chain validation stays on.
    // Node's default `servername` for https.request is `host`, which is the
    // original hostname — so SNI and cert hostname check both work correctly.
  };

  const timeoutMs = init.timeoutMs;

  return new Promise<Response>((resolve, reject) => {
    // Set once the body has been handed to the caller as a live stream. From
    // that moment a transport error can no longer `reject` (the promise is
    // settled), so it has to be raised on the body instead.
    let failStream: ((err: Error) => void) | null = null;

    const req = requester(reqOptions, (res) => {
      // Follow no redirects by default — caller gets the raw response and can
      // re-invoke safeFetch if they want to trust the Location header.
      const status = res.statusCode ?? 0;

      if (init.streamResponse) {
        const headers = toResponseHeaders(res.headers);
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
          resolve(new Response(null, { status, statusText: res.statusMessage ?? '', headers }));
          return;
        }
        const body = streamedResponseBody(req, res, init.maxBytes, (fail) => {
          failStream = fail;
        });
        resolve(new Response(body, { status, statusText: res.statusMessage ?? '', headers }));
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
        const bodyBytes = Buffer.concat(chunks);
        resolve(
          new Response(bodyBytes, {
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            headers: toResponseHeaders(res.headers)
          })
        );
      });
      res.on('error', reject);
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
      reject(err);
    });

    if (timeoutMs && timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`request timed out after ${timeoutMs}ms`));
      });
    }

    if (init.signal) {
      if (init.signal.aborted) {
        req.destroy(new Error('aborted'));
      } else {
        init.signal.addEventListener(
          'abort',
          () => req.destroy(new Error('aborted')),
          { once: true }
        );
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
export async function safeFetchFollowingRedirects(
  urlStr: string,
  init: SafeFetchInit = {},
  maxRedirects: number = SAFE_FETCH_MAX_REDIRECTS
): Promise<Response> {
  let currentUrl = urlStr;
  let currentInit: SafeFetchInit = init;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const response = await safeFetch(currentUrl, currentInit);
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
