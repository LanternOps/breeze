/**
 * Registry client (spec §9.2) against the REAL safeFetch path: DNS is stubbed
 * through `__setLookupForTests`, and every https dial is re-routed to a
 * loopback http server that plays the registry. So the SSRF proofs below
 * exercise the production allowlist + pinned-DNS code, not a mock of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';
import https from 'https';
import type { AddressInfo, LookupFunction } from 'net';
import { __setLookupForTests } from '../urlSafety';
import {
  MANIFEST_MAX_BYTES,
  MEDIA_TYPE_DOCKER_MANIFEST,
  MEDIA_TYPE_OCI_INDEX,
  createRegistryClient,
  parseBearerChallenge,
  parseRetryAfterMs,
  registryRequestHost,
  splitImageRepository,
} from './registryClient';

const D = (c: string) => `sha256:${c.repeat(64)}`;
const realHttpRequest = http.request;

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, host: string) => void;

interface Harness {
  /** Every request the fake registry received: `${method} ${host}${path}`. */
  seen: string[];
  /** Every host the pinned lookup approved (i.e. actually dialed). */
  dialed: string[];
  /** Authorization headers received, by host. */
  auth: Array<{ host: string; authorization: string | undefined }>;
  close: () => Promise<void>;
}

async function fakeRegistry(handler: Handler): Promise<Harness> {
  const seen: string[] = [];
  const dialed: string[] = [];
  const auth: Harness['auth'] = [];
  const server = http.createServer((req, res) => {
    const host = String(req.headers.host ?? '');
    seen.push(`${req.method} ${host}${req.url}`);
    auth.push({ host, authorization: req.headers.authorization });
    handler(req, res, host);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  vi.spyOn(https, 'request').mockImplementation(((options: https.RequestOptions, cb?: (res: http.IncomingMessage) => void) => {
    const pinned = options.lookup!;
    const toLoopback: LookupFunction = (host, opts, done) => {
      const callback = (typeof opts === 'function' ? opts : done) as (...a: unknown[]) => void;
      pinned(host, { all: true }, (err) => {
        if (err) return callback(err);
        dialed.push(host);
        if (typeof opts === 'object' && opts !== null && (opts as { all?: boolean }).all) {
          callback(null, [{ address: '127.0.0.1', family: 4 }]);
          return;
        }
        callback(null, '127.0.0.1', 4);
      });
    };
    return realHttpRequest({ ...options, port, lookup: toLoopback }, cb);
  }) as never);
  return {
    seen,
    dialed,
    auth,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const PUBLIC = async () => [{ address: '8.8.8.8', family: 4 }];
const noSleep = async () => {};

let harness: Harness | undefined;
beforeEach(() => __setLookupForTests(PUBLIC));
afterEach(async () => {
  __setLookupForTests(null);
  vi.restoreAllMocks();
  await harness?.close();
  harness = undefined;
});

const client = () => createRegistryClient({ sleep: noSleep, random: () => 0, log: () => {} });

describe('helpers', () => {
  it('maps docker.io to registry-1.docker.io and refuses hosts off the allowlist', () => {
    expect(registryRequestHost('docker.io')).toBe('registry-1.docker.io');
    expect(registryRequestHost('ghcr.io')).toBe('ghcr.io');
    expect(registryRequestHost('registry.example.com')).toBeNull();
    expect(registryRequestHost('localhost:5000')).toBeNull();
  });
  it('splits the normalized repository', () => {
    expect(splitImageRepository('docker.io/library/nginx')).toEqual({ registry: 'docker.io', path: 'library/nginx' });
    expect(splitImageRepository('nginx')).toBeNull();
  });
  it('parses a bearer challenge and Retry-After', () => {
    expect(
      parseBearerChallenge('Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"'),
    ).toEqual({ realm: 'https://auth.docker.io/token', service: 'registry.docker.io', scope: 'repository:library/nginx:pull' });
    expect(parseBearerChallenge('Basic realm="x"')).toBeNull();
    expect(parseRetryAfterMs('7')).toBe(7000);
    expect(parseRetryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
  });
});

describe('lookup — SSRF guard', () => {
  it('a registry off the allowlist makes zero requests', async () => {
    const lookupSpy = vi.fn(PUBLIC);
    __setLookupForTests(lookupSpy);
    harness = await fakeRegistry((_req, res) => res.end());
    const result = await client().lookup({ registry: 'registry.example.com', path: 'team/app', tag: '1', localDigests: [] });
    expect(result).toEqual({ kind: 'unsupported_registry' });
    expect(lookupSpy).not.toHaveBeenCalled();
    expect(harness.seen).toEqual([]);
  });

  it('refuses a redirect to a host off the allowlist without dialing it', async () => {
    harness = await fakeRegistry((_req, res) => {
      res.writeHead(307, { location: 'https://attacker.example/v2/x/manifests/1' });
      res.end();
    });
    const result = await client().lookup({ registry: 'ghcr.io', path: 'org/app', tag: '1', localDigests: [] });
    // Served from a host off the allowlist (e.g. a redirector registry): unsupported, not a retryable error.
    expect(result).toEqual({ kind: 'unsupported_registry' });
    expect(harness.dialed).toEqual(['ghcr.io']);
  });

  it('refuses a token realm off the allowlist without contacting it', async () => {
    harness = await fakeRegistry((_req, res) => {
      res.writeHead(401, { 'www-authenticate': 'Bearer realm="https://tokens.attacker.example/token",service="x"' });
      res.end();
    });
    const result = await client().lookup({ registry: 'ghcr.io', path: 'org/app', tag: '1', localDigests: [] });
    expect(result).toEqual({ kind: 'unsupported_registry' });
    expect(harness.dialed).toEqual(['ghcr.io']);
  });

  it('refuses an allowlisted host that resolves to a private address', async () => {
    __setLookupForTests(async () => [{ address: '10.1.2.3', family: 4 }]);
    harness = await fakeRegistry((_req, res) => res.end());
    const result = await client().lookup({ registry: 'quay.io', path: 'org/app', tag: '1', localDigests: [] });
    expect(result).toEqual({ kind: 'unsupported_registry' });
    expect(harness.seen).toEqual([]);
  });

  it('cuts off an oversize manifest body', async () => {
    harness = await fakeRegistry((req, res) => {
      res.writeHead(200, { 'content-type': MEDIA_TYPE_OCI_INDEX, 'docker-content-digest': D('a') });
      if (req.method === 'HEAD') return res.end();
      res.end(Buffer.alloc(MANIFEST_MAX_BYTES + 1024, 0x20));
    });
    const result = await client().lookup({ registry: 'ghcr.io', path: 'org/app', tag: '1', localDigests: [D('b')] });
    expect(result).toEqual({ kind: 'error', reason: 'response_too_large' });
  });
});

describe('lookup — registry protocol', () => {
  it('HEAD with all four manifest media types; a matching digest needs no GET', async () => {
    let accept = '';
    harness = await fakeRegistry((req, res) => {
      accept = String(req.headers.accept);
      res.writeHead(200, { 'content-type': MEDIA_TYPE_OCI_INDEX, 'docker-content-digest': D('a') });
      res.end();
    });
    const result = await client().lookup({ registry: 'ghcr.io', path: 'org/app', tag: '1.2', localDigests: [D('a')] });
    expect(result).toEqual({ kind: 'ok', digest: D('a'), mediaType: MEDIA_TYPE_OCI_INDEX, platformDigests: null });
    expect(harness.seen).toEqual(['HEAD ghcr.io/v2/org/app/manifests/1.2']);
    for (const t of ['oci.image.index', 'manifest.list.v2', 'oci.image.manifest', 'distribution.manifest.v2']) {
      expect(accept).toContain(t);
    }
  });

  it('on mismatch against an index, one bounded GET lists the platform manifests', async () => {
    harness = await fakeRegistry((req, res) => {
      res.writeHead(200, { 'content-type': MEDIA_TYPE_OCI_INDEX, 'docker-content-digest': D('a') });
      if (req.method === 'HEAD') return res.end();
      res.end(JSON.stringify({ manifests: [{ digest: D('b') }, { digest: D('c') }, { digest: 'bogus' }] }));
    });
    const result = await client().lookup({ registry: 'ghcr.io', path: 'org/app', tag: '1', localDigests: [D('b')] });
    expect(result).toEqual({ kind: 'ok', digest: D('a'), mediaType: MEDIA_TYPE_OCI_INDEX, platformDigests: [D('b'), D('c')] });
    expect(harness.seen.map((s) => s.split(' ')[0])).toEqual(['HEAD', 'GET']);
  });

  it('on mismatch against a single manifest, no GET', async () => {
    harness = await fakeRegistry((_req, res) => {
      res.writeHead(200, { 'content-type': MEDIA_TYPE_DOCKER_MANIFEST, 'docker-content-digest': D('a') });
      res.end();
    });
    const result = await client().lookup({ registry: 'ghcr.io', path: 'org/app', tag: '1', localDigests: [D('b')] });
    expect(result).toMatchObject({ kind: 'ok', digest: D('a'), platformDigests: null });
    expect(harness.seen).toHaveLength(1);
  });

  it('anonymous token flow: docker.io goes to registry-1.docker.io and auth.docker.io', async () => {
    harness = await fakeRegistry((req, res, host) => {
      if (host === 'auth.docker.io') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ token: 'anon-token' }));
      }
      if (req.headers.authorization !== 'Bearer anon-token') {
        res.writeHead(401, {
          'www-authenticate':
            'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"',
        });
        return res.end();
      }
      res.writeHead(200, { 'content-type': MEDIA_TYPE_OCI_INDEX, 'docker-content-digest': D('a') });
      res.end();
    });
    const result = await client().lookup({ registry: 'docker.io', path: 'library/nginx', tag: 'latest', localDigests: [D('a')] });
    expect(result).toMatchObject({ kind: 'ok', digest: D('a') });
    expect(harness.seen).toEqual([
      'HEAD registry-1.docker.io/v2/library/nginx/manifests/latest',
      'GET auth.docker.io/token?service=registry.docker.io&scope=repository%3Alibrary%2Fnginx%3Apull',
      'HEAD registry-1.docker.io/v2/library/nginx/manifests/latest',
    ]);
    // The token request itself carries no credential.
    expect(harness.auth.find((a) => a.host === 'auth.docker.io')?.authorization).toBeUndefined();
  });

  it('401 after the token flow is private', async () => {
    harness = await fakeRegistry((_req, res, host) => {
      if (host === 'ghcr.io' && _req.url?.startsWith('/token')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ token: 't' }));
      }
      res.writeHead(401, { 'www-authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' });
      res.end();
    });
    expect(await client().lookup({ registry: 'ghcr.io', path: 'org/secret', tag: '1', localDigests: [] })).toEqual({
      kind: 'private',
    });
  });

  it('403 is private; 404 is not_found', async () => {
    harness = await fakeRegistry((req, res) => {
      res.writeHead(req.url?.includes('gone') ? 404 : 403);
      res.end();
    });
    const c = client();
    expect(await c.lookup({ registry: 'quay.io', path: 'org/app', tag: '1', localDigests: [] })).toEqual({ kind: 'private' });
    expect(await c.lookup({ registry: 'quay.io', path: 'org/gone', tag: '1', localDigests: [] })).toEqual({ kind: 'not_found' });
  });

  it('retries 5xx with backoff, honouring Retry-After', async () => {
    let calls = 0;
    harness = await fakeRegistry((_req, res) => {
      calls++;
      if (calls === 1) {
        res.writeHead(503, { 'retry-after': '2' });
        return res.end();
      }
      res.writeHead(200, { 'content-type': MEDIA_TYPE_DOCKER_MANIFEST, 'docker-content-digest': D('a') });
      res.end();
    });
    const sleeps: number[] = [];
    const c = createRegistryClient({ sleep: async (ms) => void sleeps.push(ms), random: () => 0, log: () => {} });
    expect(await c.lookup({ registry: 'quay.io', path: 'org/app', tag: '1', localDigests: [] })).toMatchObject({ kind: 'ok' });
    expect(sleeps).toEqual([2000]);
  });

  it('a registry still answering 429 after retries is skipped for the rest of the pass', async () => {
    harness = await fakeRegistry((_req, res) => {
      res.writeHead(429);
      res.end();
    });
    const sleeps: number[] = [];
    const c = createRegistryClient({ sleep: async (ms) => void sleeps.push(ms), random: () => 0.5, log: () => {} });
    expect(await c.lookup({ registry: 'quay.io', path: 'org/a', tag: '1', localDigests: [] })).toEqual({
      kind: 'skipped',
      reason: 'registry_throttled',
    });
    expect(sleeps).toEqual([1500, 2500]); // exponential + jitter
    const before = harness.seen.length;
    expect(await c.lookup({ registry: 'quay.io', path: 'org/b', tag: '1', localDigests: [] })).toMatchObject({ kind: 'skipped' });
    expect(harness.seen.length).toBe(before);
  });

  it('an invalid reference makes no request', async () => {
    harness = await fakeRegistry((_req, res) => res.end());
    expect(await client().lookup({ registry: 'ghcr.io', path: '../../x', tag: '1', localDigests: [] })).toEqual({
      kind: 'error',
      reason: 'invalid_reference',
    });
    expect(harness.seen).toEqual([]);
  });

  it('never logs the token', async () => {
    const lines: string[] = [];
    harness = await fakeRegistry((req, res, host) => {
      if (host === 'ghcr.io' && req.url?.startsWith('/token')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ token: 'super-secret-token' }));
      }
      if (!req.headers.authorization) {
        res.writeHead(401, { 'www-authenticate': 'Bearer realm="https://ghcr.io/token"' });
        return res.end();
      }
      res.writeHead(500);
      res.end();
    });
    const c = createRegistryClient({ sleep: noSleep, random: () => 0, log: (l) => lines.push(l) });
    await c.lookup({ registry: 'ghcr.io', path: 'org/app', tag: '1', localDigests: [] });
    expect(lines.join('\n')).not.toContain('super-secret-token');
  });
});
