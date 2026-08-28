/**
 * llmEgressProxy — allowlisting, resolve-and-pin CONNECT proxy for the Agent
 * SDK subprocess (#3922 phase 2, Wave 2, Task 2.2).
 *
 * ## Why a proxy at all
 *
 * A partner routing their AI traffic to a catalog endpoint runs through the
 * `@anthropic-ai/claude-agent-sdk` **child process**, which builds its own HTTP
 * client from `ANTHROPIC_BASE_URL`. We cannot hand that child a guarded `fetch`
 * the way `guardedLlmFetch.ts` does for one-shot clients, so the only place the
 * SSRF/rebinding policy can be enforced is the socket layer between the child
 * and the network. `HTTPS_PROXY` pointed at this listener is that place:
 *
 *  - the child may open exactly one destination — the `host:443` its session
 *    was granted — and nothing else;
 *  - the destination's DNS is resolved HERE, filtered through
 *    `resolveSafeRecords` (the same policy `safeFetch` uses), and the socket is
 *    dialed **at the validated IP**, never at the hostname. That is the DNS
 *    rebinding pin: there is no second resolution for an attacker to race;
 *  - every CONNECT made against a live grant — allowed or refused — is reported
 *    to that session's audit recorder, which is what makes `llm_egress_events`
 *    a complete record rather than a success log. The one CONNECT that cannot
 *    be recorded is one presenting an absent or unknown proxy token: there is
 *    no grant, and therefore no org/partner, to attribute it to. Those are
 *    refused with 407 and left to process-level logging.
 *
 * ## What it deliberately does NOT do
 *
 * It never reads a byte of the tunnel past the CONNECT request line. TLS passes
 * through opaque, so the child still performs its own certificate and hostname
 * verification against the real provider name — the proxy is not a MITM and
 * holds no certificate authority. Terminating TLS here would silently downgrade
 * that guarantee.
 *
 * ## Trust boundary
 *
 * The listener binds `127.0.0.1:0` (loopback, ephemeral) and demands a
 * per-grant bearer token, constant-time compared, so another local process
 * cannot borrow a session's egress allowance by guessing the port. `revoke()`
 * invalidates the token AND destroys in-flight tunnels, so a delisted or
 * rotated session stops talking to the provider immediately rather than at the
 * end of its current turn.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import http from 'http';
import net from 'net';
import type { AddressInfo } from 'net';
import type { LookupAddress } from 'dns';
import { resolveSafeRecords } from '../urlSafety';

/** Exactly one host per session, always on 443 — no other port is grantable. */
export interface EgressGrant {
  host: string;
  port: 443;
}

/** One CONNECT attempt, allowed or refused. `blocked` attempts never dialed. */
export interface LlmEgressAttempt {
  host: string;
  resolvedIp: string | null;
  blocked: boolean;
}

/**
 * Fire-and-forget audit hook. A throwing recorder is swallowed: auditing must
 * never be able to fail the traffic it is merely observing.
 */
export type LlmEgressRecorder = (e: LlmEgressAttempt) => void;

export interface LlmEgressProxy {
  /**
   * Registers a session-scoped grant and returns the proxy URL to place in the
   * child's `HTTPS_PROXY`, with a freshly generated bearer token embedded.
   * Re-granting the same session id revokes the previous grant first.
   */
  grant(
    sessionId: string,
    allowed: EgressGrant,
    recordEgress: LlmEgressRecorder
  ): { proxyUrl: string };
  /** Invalidates the token and destroys any tunnel opened under it. */
  revoke(sessionId: string): void;
  port(): number;
  close(): Promise<void>;
}

/** Resolution seam — mirrors `urlSafety.__setLookupForTests`. */
type SafeRecordResolver = (
  hostname: string
) => Promise<{ safe: LookupAddress[]; allIps: string[] }>;

const defaultResolver: SafeRecordResolver = (hostname) => resolveSafeRecords(hostname);
let resolverImpl: SafeRecordResolver = defaultResolver;

/**
 * Test hook — override the resolve-and-filter step. Pass `null` to restore.
 * Exists because the real policy (correctly) refuses to resolve a test host to
 * 127.0.0.1, which is the only address a test server can listen on.
 */
export function __setResolverForTests(fn: SafeRecordResolver | null): void {
  resolverImpl = fn ?? defaultResolver;
}

interface GrantRecord {
  sessionId: string;
  /** Lowercased; CONNECT targets are compared case-insensitively. */
  host: string;
  port: number;
  tokenDigest: Buffer;
  recordEgress: LlmEgressRecorder;
  sockets: Set<net.Socket>;
}

function digest(value: string): Buffer {
  // Hashing before comparison keeps the compare fixed-width, so a wrong-length
  // token is rejected in the same time as a wrong-value one (and never throws
  // out of `timingSafeEqual`).
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Pull the token out of `Proxy-Authorization: Basic <base64>`. Tolerates both
 * `user:token` (what an HTTP client derives from proxy-URL userinfo) and a bare
 * token.
 */
function presentedToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^basic\s+(\S+)$/i.exec(header.trim());
  if (!match) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1]!, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const colon = decoded.indexOf(':');
  return colon === -1 ? decoded : decoded.slice(colon + 1);
}

/** `host:port` from a CONNECT request line. Rejects anything malformed. */
function parseConnectTarget(raw: string | undefined): { host: string; port: number } | null {
  if (!raw) return null;
  const bracketed = /^\[([0-9a-fA-F:]+)\]:(\d+)$/.exec(raw);
  const host = bracketed ? bracketed[1]! : raw.slice(0, raw.lastIndexOf(':'));
  const portStr = bracketed ? bracketed[2]! : raw.slice(raw.lastIndexOf(':') + 1);
  if (!host || !portStr || !/^\d+$/.test(portStr)) return null;
  const port = Number(portStr);
  if (port <= 0 || port > 65535) return null;
  return { host: host.toLowerCase(), port };
}

function refuse(socket: net.Socket, statusLine: string, extraHeaders = ''): void {
  const payload =
    `HTTP/1.1 ${statusLine}\r\n${extraHeaders}Connection: close\r\nContent-Length: 0\r\n\r\n`;
  try {
    // Flush the status, then tear the socket down. Ending first (rather than a
    // bare destroy) lets the client read the reason instead of an RST.
    socket.end(payload, () => socket.destroy());
  } catch {
    socket.destroy();
  }
}

function safeRecord(grant: GrantRecord, event: LlmEgressAttempt): void {
  try {
    grant.recordEgress(event);
  } catch {
    // Fire-and-forget by contract — see LlmEgressRecorder.
  }
}

export async function startLlmEgressProxy(): Promise<LlmEgressProxy> {
  const grants = new Map<string, GrantRecord>();
  const allSockets = new Set<net.Socket>();

  const track = (socket: net.Socket, grant?: GrantRecord): void => {
    allSockets.add(socket);
    grant?.sockets.add(socket);
    socket.on('close', () => {
      allSockets.delete(socket);
      grant?.sockets.delete(socket);
    });
  };

  /**
   * Constant-work lookup: every live grant is compared, with no early exit, so
   * the response time does not leak which grant (if any) matched.
   */
  const findGrant = (token: string): GrantRecord | null => {
    const presented = digest(token);
    let matched: GrantRecord | null = null;
    for (const grant of grants.values()) {
      if (timingSafeEqual(presented, grant.tokenDigest)) matched = grant;
    }
    return matched;
  };

  const server = http.createServer((req, res) => {
    // Only CONNECT is served. A plain proxied request would mean the proxy
    // itself makes the outbound call — an origin-rewriting surface we do not
    // want to own, and one the child never needs.
    res.writeHead(405, { 'Content-Type': 'text/plain', Connection: 'close' });
    res.end('only CONNECT is supported', () => req.socket.destroy());
  });
  server.on('clientError', (_err, socket) => socket.destroy());
  server.on('error', () => {});

  server.on('connect', (req, clientSocket: net.Socket, head: Buffer) => {
    clientSocket.on('error', () => {});
    track(clientSocket);

    const token = presentedToken(req.headers['proxy-authorization']);
    const grant = token === null ? null : findGrant(token);
    if (!grant) {
      refuse(
        clientSocket,
        '407 Proxy Authentication Required',
        'Proxy-Authenticate: Basic realm="breeze-llm-egress"\r\n'
      );
      return;
    }

    const target = parseConnectTarget(req.url);
    if (!target || target.host !== grant.host || target.port !== grant.port) {
      safeRecord(grant, {
        host: target?.host ?? String(req.url ?? ''),
        resolvedIp: null,
        blocked: true
      });
      refuse(clientSocket, '403 Forbidden');
      return;
    }

    grant.sockets.add(clientSocket);
    clientSocket.on('close', () => grant.sockets.delete(clientSocket));

    void (async () => {
      let ip: string;
      try {
        const { safe } = await resolverImpl(target.host);
        const first = safe[0];
        if (!first) throw new Error(`no safe records for ${target.host}`);
        ip = first.address;
      } catch {
        safeRecord(grant, { host: target.host, resolvedIp: null, blocked: true });
        refuse(clientSocket, '502 Bad Gateway');
        return;
      }

      // A revoke() (or close()) may have landed during resolution — the grant
      // must still be live at the moment we dial, not merely when we started.
      if (grants.get(grant.sessionId) !== grant || clientSocket.destroyed) {
        // A grant we still hold, cut off mid-revocation — record it, or the
        // audit trail silently loses CONNECTs that died in this window.
        safeRecord(grant, { host: target.host, resolvedIp: null, blocked: true });
        refuse(clientSocket, '407 Proxy Authentication Required');
        return;
      }

      // THE PIN: dial the validated IP, never the hostname. No second
      // resolution happens anywhere below this line.
      const upstream = net.connect({ host: ip, port: target.port });
      // Tracked BEFORE the handshake completes: a revoke() landing while the
      // socket is still in SYN-SENT must be able to tear it down. Registering
      // in the 'connect' handler instead would leave an established connection
      // to the provider alive past revocation.
      track(upstream, grant);
      let established = false;
      // Exactly one audit row per CONNECT. Past this point the dial can end in
      // four ways — refused by the provider, torn down mid-handshake, refused
      // by a re-check, or tunnelled — and every one of them must land a row,
      // but only one. `settled` is what makes "record everywhere" safe.
      let settled = false;

      /**
       * A dial that never became a tunnel. Records it, then answers the client
       * with `statusLine`, or simply drops the socket when there is no client
       * left to tell (revocation destroys the client half too).
       */
      const blockedDial = (statusLine: string | null): void => {
        if (settled) return;
        settled = true;
        // `ip`, not null: the pin WAS applied and the packet WAS sent. That is
        // the difference between this and a resolver refusal, and it is the
        // detail an operator needs to tell "we never dialled" from "we dialled
        // the provider and then stopped".
        safeRecord(grant, { host: target.host, resolvedIp: ip, blocked: true });
        if (statusLine) refuse(clientSocket, statusLine);
        else clientSocket.destroy();
      };

      upstream.on('error', (err: Error) => {
        if (established) {
          // The tunnel already carried bytes, so its allowed row stands — a
          // transport failure afterwards must not retroactively add a blocked
          // one. But it must not be silent either: a provider resetting live
          // tunnels is indistinguishable from a hung session without this.
          console.warn(
            `[llmEgressProxy] established tunnel to ${target.host} failed: ${err.message}`
          );
          upstream.destroy();
          clientSocket.destroy();
          return;
        }
        upstream.destroy();
        blockedDial('502 Bad Gateway');
      });

      upstream.once('close', () => {
        // The socket died before the tunnel opened. A revoke() landing
        // mid-handshake is exactly this shape — and it is the WORST window to
        // lose, because the kernel may already have completed a TCP handshake
        // to the provider. Neither 'connect' (never emitted for a socket
        // destroyed while connecting) nor 'error' (a revoke destroy raises
        // none) fires here, so without this the dial vanishes from the audit
        // trail entirely.
        if (!established) blockedDial(null);
      });

      upstream.once('connect', () => {
        // Re-check: revoke() may have destroyed both halves while we were in
        // the handshake. Writing the 200 into a dead client would leave the
        // upstream half established with no teardown listener attached.
        if (grants.get(grant.sessionId) !== grant || clientSocket.destroyed) {
          blockedDial(null);
          upstream.destroy();
          clientSocket.destroy();
          return;
        }
        established = true;
        settled = true;
        safeRecord(grant, { host: target.host, resolvedIp: ip, blocked: false });

        clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: breeze-llm-egress\r\n\r\n');
        if (head && head.length > 0) upstream.write(head);

        // Opaque both ways from here: no inspection, no rewriting.
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);

        const teardown = (): void => {
          upstream.destroy();
          clientSocket.destroy();
        };
        upstream.on('close', teardown);
        clientSocket.on('close', teardown);
      });
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const listenPort = (server.address() as AddressInfo).port;

  const destroyGrantSockets = (grant: GrantRecord): void => {
    for (const socket of [...grant.sockets]) socket.destroy();
    grant.sockets.clear();
  };

  const api: LlmEgressProxy = {
    grant(sessionId, allowed, recordEgress) {
      const previous = grants.get(sessionId);
      if (previous) {
        grants.delete(sessionId);
        destroyGrantSockets(previous);
      }
      const token = randomBytes(32).toString('base64url');
      grants.set(sessionId, {
        sessionId,
        host: allowed.host.toLowerCase(),
        port: allowed.port,
        tokenDigest: digest(token),
        recordEgress,
        sockets: new Set()
      });
      return { proxyUrl: `http://breeze:${token}@127.0.0.1:${listenPort}` };
    },

    revoke(sessionId) {
      const grant = grants.get(sessionId);
      if (!grant) return;
      grants.delete(sessionId);
      destroyGrantSockets(grant);
    },

    port() {
      return listenPort;
    },

    async close() {
      grants.clear();
      for (const socket of [...allSockets]) socket.destroy();
      allSockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (singletonInstance === api) {
        singletonInstance = null;
        singletonPromise = null;
      }
    }
  };

  return api;
}

let singletonPromise: Promise<LlmEgressProxy> | null = null;
let singletonInstance: LlmEgressProxy | null = null;

/**
 * Lazy per-process singleton. One listener serves every catalog session; grants
 * are what separate them, so nothing is shared between sessions but the port.
 */
export function getLlmEgressProxy(): Promise<LlmEgressProxy> {
  if (!singletonPromise) {
    singletonPromise = startLlmEgressProxy().then(
      (proxy) => {
        singletonInstance = proxy;
        return proxy;
      },
      (err: unknown) => {
        singletonPromise = null;
        throw err;
      }
    );
  }
  return singletonPromise;
}
