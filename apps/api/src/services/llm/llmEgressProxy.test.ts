/**
 * Security-boundary tests for the allowlisting CONNECT proxy (#3922 W2, Task 2.2).
 *
 * These deliberately use REAL sockets on 127.0.0.1 — a real `http.request({method:'CONNECT'})`
 * client, a real TLS server standing in for the provider, and the proxy's real
 * listener. Mocking the socket layer here would assert the shape of our own
 * mocks rather than the property that matters (that an unauthorised or
 * off-allowlist CONNECT never reaches a socket).
 *
 * The only injected seam is DNS resolution (`__setResolverForTests`), because
 * the real `resolveSafeRecords` correctly refuses to hand back 127.0.0.1.
 */
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import http from 'http';
import net from 'net';
import tls from 'tls';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AddressInfo } from 'net';
import { SsrfBlockedError } from '../urlSafety';
import {
  __setResolverForTests,
  getLlmEgressProxy,
  startLlmEgressProxy,
  type EgressGrant,
  type LlmEgressAttempt,
  type LlmEgressProxy
} from './llmEgressProxy';

const PROVIDER_HOST = 'llm.provider.test';

// ---------------------------------------------------------------------------
// Local TLS "provider": echoes whatever is written to it. The certificate is
// generated at test time (never committed) with a SAN matching PROVIDER_HOST,
// so the client can verify hostname identity THROUGH the tunnel — which is the
// property that lets the proxy stay opaque.
// ---------------------------------------------------------------------------
let tlsMaterial: { key: string; cert: string };
let tlsDir: string;

beforeAll(() => {
  tlsDir = mkdtempSync(join(tmpdir(), 'breeze-llm-egress-'));
  const keyPath = join(tlsDir, 'key.pem');
  const certPath = join(tlsDir, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req', '-x509',
      '-newkey', 'ec',
      '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout', keyPath,
      '-out', certPath,
      '-days', '2',
      '-subj', `/CN=${PROVIDER_HOST}`,
      '-addext', `subjectAltName=DNS:${PROVIDER_HOST}`
    ],
    { stdio: 'ignore' }
  );
  tlsMaterial = {
    key: readFileSync(keyPath, 'utf8'),
    cert: readFileSync(certPath, 'utf8')
  };
});

afterAll(() => {
  if (tlsDir) rmSync(tlsDir, { recursive: true, force: true });
});

interface EchoServer {
  port: number;
  close(): Promise<void>;
}

async function startTlsEcho(): Promise<EchoServer> {
  const server = tls.createServer({ key: tlsMaterial.key, cert: tlsMaterial.cert }, (socket) => {
    socket.on('error', () => {});
    socket.pipe(socket);
  });
  server.on('error', () => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      })
  };
}

/** Grants in production are always :443; tests need the ephemeral echo port. */
function grantFor(host: string, port: number): EgressGrant {
  return { host, port } as unknown as EgressGrant;
}

type ConnectOutcome = { kind: 'status'; status: number } | { kind: 'tunnel'; socket: net.Socket };

function proxyConnect(opts: {
  port: number;
  token: string | null;
  target: string;
}): Promise<ConnectOutcome> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.token !== null) {
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(`breeze:${opts.token}`).toString('base64')}`;
    }
    const req = http.request({
      host: '127.0.0.1',
      port: opts.port,
      method: 'CONNECT',
      path: opts.target,
      headers,
      agent: false
    });
    // Node emits 'connect' for ANY response to a CONNECT request, not just a
    // 2xx — the status is what distinguishes a tunnel from a refusal.
    req.once('connect', (res, socket) => {
      socket.on('error', () => {});
      if (res.statusCode === 200) {
        resolve({ kind: 'tunnel', socket });
        return;
      }
      socket.destroy();
      resolve({ kind: 'status', status: res.statusCode ?? 0 });
    });
    req.once('response', (res) => {
      res.resume();
      resolve({ kind: 'status', status: res.statusCode ?? 0 });
    });
    req.once('error', reject);
    req.end();
  });
}

function extractToken(proxyUrl: string): string {
  return decodeURIComponent(new URL(proxyUrl).password);
}

function tlsThroughTunnel(socket: net.Socket): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const secured = tls.connect(
      {
        socket,
        servername: PROVIDER_HOST,
        ca: [tlsMaterial.cert],
        rejectUnauthorized: true
      },
      () => resolve(secured)
    );
    secured.once('error', reject);
  });
}

function waitForClose(socket: net.Socket, ms = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    if (socket.destroyed) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), ms);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

// ---------------------------------------------------------------------------

const openProxies: LlmEgressProxy[] = [];
const openEchoes: EchoServer[] = [];

async function newProxy(): Promise<LlmEgressProxy> {
  const proxy = await startLlmEgressProxy();
  openProxies.push(proxy);
  return proxy;
}

async function newEcho(): Promise<EchoServer> {
  const echo = await startTlsEcho();
  openEchoes.push(echo);
  return echo;
}

/** Resolver that maps PROVIDER_HOST to loopback and blocks everything else. */
function loopbackResolver() {
  return async (hostname: string) => {
    if (hostname === PROVIDER_HOST) {
      return { safe: [{ address: '127.0.0.1', family: 4 }], allIps: ['127.0.0.1'] };
    }
    throw new SsrfBlockedError(`all resolved IPs for ${hostname} are private/loopback/link-local`, {
      hostname
    });
  };
}

afterEach(async () => {
  __setResolverForTests(null);
  while (openProxies.length) await openProxies.pop()!.close();
  while (openEchoes.length) await openEchoes.pop()!.close();
});

describe('llmEgressProxy — listener posture', () => {
  it('binds loopback only and serves nothing but CONNECT', async () => {
    const proxy = await newProxy();
    expect(proxy.port()).toBeGreaterThan(0);

    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: proxy.port(), method: 'GET', path: '/', agent: false },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.once('error', reject);
      req.end();
    });
    expect(status).toBe(405);
  });

  it('close() stops accepting connections', async () => {
    const proxy = await startLlmEgressProxy();
    const port = proxy.port();
    await proxy.close();

    await expect(
      proxyConnect({ port, token: 'anything', target: `${PROVIDER_HOST}:443` })
    ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});

describe('llmEgressProxy — authorization', () => {
  it('rejects a CONNECT with no Proxy-Authorization (407)', async () => {
    const proxy = await newProxy();
    proxy.grant('s1', grantFor(PROVIDER_HOST, 443), () => {});

    const out = await proxyConnect({ port: proxy.port(), token: null, target: `${PROVIDER_HOST}:443` });
    expect(out).toEqual({ kind: 'status', status: 407 });
  });

  it('rejects an unknown token (407) — including a length that differs from the grant token', async () => {
    const proxy = await newProxy();
    proxy.grant('s1', grantFor(PROVIDER_HOST, 443), () => {});

    for (const token of ['short', 'x'.repeat(43), '']) {
      const out = await proxyConnect({ port: proxy.port(), token, target: `${PROVIDER_HOST}:443` });
      expect(out).toEqual({ kind: 'status', status: 407 });
    }
  });

  it('issues a distinct token per grant and refuses a revoked one', async () => {
    const proxy = await newProxy();
    const a = proxy.grant('s1', grantFor(PROVIDER_HOST, 443), () => {});
    const b = proxy.grant('s2', grantFor(PROVIDER_HOST, 443), () => {});
    expect(extractToken(a.proxyUrl)).not.toBe(extractToken(b.proxyUrl));
    expect(new URL(a.proxyUrl).hostname).toBe('127.0.0.1');
    expect(Number(new URL(a.proxyUrl).port)).toBe(proxy.port());

    proxy.revoke('s1');
    const out = await proxyConnect({
      port: proxy.port(),
      token: extractToken(a.proxyUrl),
      target: `${PROVIDER_HOST}:443`
    });
    expect(out).toEqual({ kind: 'status', status: 407 });
  });
});

describe('llmEgressProxy — allowlist enforcement', () => {
  it('refuses a host outside the grant (403) and records the blocked attempt', async () => {
    const proxy = await newProxy();
    const events: LlmEgressAttempt[] = [];
    const { proxyUrl } = proxy.grant('s1', grantFor(PROVIDER_HOST, 443), (e) => events.push(e));

    const out = await proxyConnect({
      port: proxy.port(),
      token: extractToken(proxyUrl),
      target: 'evil.example.com:443'
    });
    expect(out).toEqual({ kind: 'status', status: 403 });
    expect(events).toEqual([{ host: 'evil.example.com', resolvedIp: null, blocked: true }]);
  });

  it('refuses the granted host on a non-443 port (403)', async () => {
    const proxy = await newProxy();
    const events: LlmEgressAttempt[] = [];
    const { proxyUrl } = proxy.grant('s1', grantFor(PROVIDER_HOST, 443), (e) => events.push(e));

    const out = await proxyConnect({
      port: proxy.port(),
      token: extractToken(proxyUrl),
      target: `${PROVIDER_HOST}:8443`
    });
    expect(out).toEqual({ kind: 'status', status: 403 });
    expect(events).toEqual([{ host: PROVIDER_HOST, resolvedIp: null, blocked: true }]);
  });

  it('matches the host case-insensitively', async () => {
    __setResolverForTests(loopbackResolver());
    const echo = await newEcho();
    const proxy = await newProxy();
    const { proxyUrl } = proxy.grant('s1', grantFor(PROVIDER_HOST, echo.port), () => {});

    const out = await proxyConnect({
      port: proxy.port(),
      token: extractToken(proxyUrl),
      target: `${PROVIDER_HOST.toUpperCase()}:${echo.port}`
    });
    expect(out.kind).toBe('tunnel');
    if (out.kind === 'tunnel') out.socket.destroy();
  });

  it("one session's token cannot reach another session's host", async () => {
    const proxy = await newProxy();
    const a = proxy.grant('s1', grantFor('a.provider.test', 443), () => {});
    proxy.grant('s2', grantFor('b.provider.test', 443), () => {});

    const out = await proxyConnect({
      port: proxy.port(),
      token: extractToken(a.proxyUrl),
      target: 'b.provider.test:443'
    });
    expect(out).toEqual({ kind: 'status', status: 403 });
  });

  it('returns 502 and records a blocked attempt when nothing safe resolves', async () => {
    __setResolverForTests(async (hostname: string) => {
      throw new SsrfBlockedError(`all resolved IPs for ${hostname} are private/loopback/link-local`, {
        hostname
      });
    });
    const proxy = await newProxy();
    const events: LlmEgressAttempt[] = [];
    const { proxyUrl } = proxy.grant('s1', grantFor(PROVIDER_HOST, 443), (e) => events.push(e));

    const out = await proxyConnect({
      port: proxy.port(),
      token: extractToken(proxyUrl),
      target: `${PROVIDER_HOST}:443`
    });
    expect(out).toEqual({ kind: 'status', status: 502 });
    expect(events).toEqual([{ host: PROVIDER_HOST, resolvedIp: null, blocked: true }]);
  });
});

describe('llmEgressProxy — tunnelling', () => {
  it('tunnels TLS bytes end-to-end to the pinned IP and records the resolved address', async () => {
    __setResolverForTests(loopbackResolver());
    const echo = await newEcho();
    const proxy = await newProxy();
    const events: LlmEgressAttempt[] = [];
    const { proxyUrl } = proxy.grant('s1', grantFor(PROVIDER_HOST, echo.port), (e) => events.push(e));

    const out = await proxyConnect({
      port: proxy.port(),
      token: extractToken(proxyUrl),
      target: `${PROVIDER_HOST}:${echo.port}`
    });
    expect(out.kind).toBe('tunnel');
    if (out.kind !== 'tunnel') return;

    // The child's own TLS verification still applies: the certificate is
    // checked against PROVIDER_HOST, not against the proxy.
    const secured = await tlsThroughTunnel(out.socket);
    const echoed = await new Promise<string>((resolve) => {
      secured.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
      secured.write('ping-through-the-tunnel');
    });
    expect(echoed).toBe('ping-through-the-tunnel');

    expect(events).toEqual([{ host: PROVIDER_HOST, resolvedIp: '127.0.0.1', blocked: false }]);
    secured.destroy();
  });

  it('does not let a throwing recorder break the tunnel', async () => {
    __setResolverForTests(loopbackResolver());
    const echo = await newEcho();
    const proxy = await newProxy();
    const { proxyUrl } = proxy.grant('s1', grantFor(PROVIDER_HOST, echo.port), () => {
      throw new Error('recorder exploded');
    });

    const out = await proxyConnect({
      port: proxy.port(),
      token: extractToken(proxyUrl),
      target: `${PROVIDER_HOST}:${echo.port}`
    });
    expect(out.kind).toBe('tunnel');
    if (out.kind !== 'tunnel') return;
    const secured = await tlsThroughTunnel(out.socket);
    const echoed = await new Promise<string>((resolve) => {
      secured.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
      secured.write('still-works');
    });
    expect(echoed).toBe('still-works');
    secured.destroy();
  });

  it('revoke() destroys an in-flight tunnel', async () => {
    __setResolverForTests(loopbackResolver());
    const echo = await newEcho();
    const proxy = await newProxy();
    const { proxyUrl } = proxy.grant('s1', grantFor(PROVIDER_HOST, echo.port), () => {});

    const out = await proxyConnect({
      port: proxy.port(),
      token: extractToken(proxyUrl),
      target: `${PROVIDER_HOST}:${echo.port}`
    });
    expect(out.kind).toBe('tunnel');
    if (out.kind !== 'tunnel') return;
    const secured = await tlsThroughTunnel(out.socket);

    proxy.revoke('s1');
    expect(await waitForClose(secured)).toBe(true);
  });

  it('close() destroys in-flight tunnels', async () => {
    __setResolverForTests(loopbackResolver());
    const echo = await newEcho();
    const proxy = await startLlmEgressProxy();
    const { proxyUrl } = proxy.grant('s1', grantFor(PROVIDER_HOST, echo.port), () => {});

    const out = await proxyConnect({
      port: proxy.port(),
      token: extractToken(proxyUrl),
      target: `${PROVIDER_HOST}:${echo.port}`
    });
    expect(out.kind).toBe('tunnel');
    if (out.kind !== 'tunnel') return;
    const secured = await tlsThroughTunnel(out.socket);

    await proxy.close();
    expect(await waitForClose(secured)).toBe(true);
  });
});

describe('getLlmEgressProxy', () => {
  it('returns the same lazily-started instance and re-starts after close', async () => {
    const first = await getLlmEgressProxy();
    const second = await getLlmEgressProxy();
    expect(second).toBe(first);
    const firstPort = first.port();
    await first.close();

    const third = await getLlmEgressProxy();
    expect(third).not.toBe(first);
    expect(third.port()).not.toBe(firstPort);
    await third.close();
  });
});
