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

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d)
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice('::ffff:'.length);
    if (isPrivateV4(v4)) return true;
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
  const stripped = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
  if (stripped.includes(':')) return isPrivateV6(stripped);
  return isPrivateV4(stripped);
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

export interface SafeFetchInit extends Omit<RequestInit, 'signal'> {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Resolve `url.hostname` once, reject if all resolved IPs are private, and
 * dispatch the request pinned to a validated IP. The hostname is preserved as
 * SNI and used to derive Host so TLS verification succeeds normally.
 *
 * Throws `SsrfBlockedError` for policy violations and `Error` (with `cause`)
 * for transport/TLS/timeout failures. Returns a standard `Response`.
 */
export async function safeFetch(urlStr: string, init: SafeFetchInit = {}): Promise<Response> {
  const u = new URL(urlStr);

  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new SsrfBlockedError(`unsupported URL scheme: ${u.protocol}`);
  }

  const hostname = u.hostname.replace(/^\[|\]$/g, '');

  // If the URL itself is a literal private IP, reject without any DNS work.
  // (This also catches `localhost` via the DNS path below, but handling
  // literals first avoids needing to resolve them.)
  const isLiteral = /^[\d.]+$/.test(hostname) || hostname.includes(':');
  if (isLiteral && isPrivateIp(hostname)) {
    throw new SsrfBlockedError(`URL points to blocked address: ${hostname}`, {
      hostname,
      resolvedIps: [hostname]
    });
  }

  // Resolve the hostname. Even literal IPs go through `dns.lookup` normally,
  // but we skip that and treat them as pre-resolved.
  let records: LookupAddress[];
  if (isLiteral) {
    records = [{ address: hostname, family: hostname.includes(':') ? 6 : 4 }];
  } else {
    records = await lookupImpl(hostname, { all: true });
    if (records.length === 0) {
      throw new SsrfBlockedError(`no DNS records for ${hostname}`, { hostname });
    }
  }

  const allIps = records.map((r) => r.address);
  const safeRecord = records.find((r) => !isPrivateIp(r.address));
  if (!safeRecord) {
    throw new SsrfBlockedError(
      `all resolved IPs for ${hostname} are private/loopback/link-local`,
      { hostname, resolvedIps: allIps }
    );
  }

  // Build a `lookup` that always hands back the validated record, so a DNS
  // rebind between now and the TCP connect cannot redirect us.
  const pinnedLookup: LookupFunction = (_hn, _opts, cb) => {
    // Node's LookupFunction callback is overloaded; runtime accepts (err, addr, family)
    (cb as (e: NodeJS.ErrnoException | null, addr: string, family: number) => void)(
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
    const req = requester(reqOptions, (res) => {
      // Follow no redirects by default — caller gets the raw response and can
      // re-invoke safeFetch if they want to trust the Location header.
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const bodyBytes = Buffer.concat(chunks);
        const responseHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v == null) continue;
          if (Array.isArray(v)) {
            for (const item of v) responseHeaders.append(k, item);
          } else {
            responseHeaders.set(k, String(v));
          }
        }
        resolve(
          new Response(bodyBytes, {
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            headers: responseHeaders
          })
        );
      });
      res.on('error', reject);
    });

    req.on('error', (err) => {
      // Includes TLS verification failures — propagate without suppression.
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
