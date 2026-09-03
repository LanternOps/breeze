// Stub authMiddleware so the suite can inject its own auth context, exactly
// as extensionsAdmin.test.ts does.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: { get: (k: string) => unknown; header: (k: string, v: string) => void; json: (b: unknown, s: number) => unknown }, next: () => Promise<void>) => {
    if (!c.get('auth')) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  }),
}));

import { Hono } from 'hono';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionManifestV1 } from '@breeze/extension-sdk';
import { createExtensionsWebRoutes, type ExtensionsWebDeps } from './extensionsWeb';
import { mintExtensionAssetToken, verifyExtensionAssetToken } from '../services/extensionAssetToken';
import type { StagedExtensionContributions } from '../extensions/contributionRegistry';
import type { ExtensionWebAsset } from '../extensions/webAssets';

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function manifest(over: Partial<ExtensionManifestV1> = {}): ExtensionManifestV1 {
  return {
    apiVersion: 'breeze.extensions/v1',
    name: 'demo',
    version: '1.0.0',
    routeNamespace: 'demo',
    requires: { breeze: '^1.0.0', serverSdk: '^1.0.0', capabilities: [] },
    server: { entry: 'server/index.cjs' },
    migrationsDir: 'migrations',
    schemaCompatibilityFloor: '1.0.0',
    jobs: [],
    aiTools: [],
    tenancy: { orgCascadeDeleteTables: [], deviceCascadeDeleteTables: [], deviceOrgDenormalizedTables: [] },
    web: { entry: 'web/index.js', pages: [], navigation: [], slots: [] },
    ...over,
  } as ExtensionManifestV1;
}

function snapshot(over: Partial<StagedExtensionContributions> = {}): StagedExtensionContributions {
  return {
    name: 'demo',
    version: '1.0.0',
    manifest: manifest(),
    routeApp: null,
    jobs: new Map(),
    aiTools: new Map(),
    enabled: true,
    ...over,
  } as StagedExtensionContributions;
}

const AUTHED = {
  user: { id: 'u1', email: 'u@breeze.test', name: 'U' },
  partnerId: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222',
};

/** The tenant scope the registry would sign into a minted token. */
const SCOPE = { partnerId: AUTHED.partnerId, orgId: AUTHED.orgId };

const DIGEST_A = `sha256:${'a'.repeat(64)}`;

interface Harness {
  app: Hono;
  isEnabledCalls: string[];
}

function buildHarness(opts: {
  auth?: unknown;
  snapshots?: StagedExtensionContributions[];
  enabled?: Record<string, boolean>;
  webAssets?: Record<string, ExtensionWebAsset>;
} = {}): Harness {
  const enabled = opts.enabled ?? { demo: true };
  const webAssets = opts.webAssets ?? {};
  const isEnabledCalls: string[] = [];

  const deps: ExtensionsWebDeps = {
    stateStore: {
      isEnabled: async (name: string) => {
        isEnabledCalls.push(name);
        return enabled[name] ?? false;
      },
    },
    registry: {
      listActive: () => opts.snapshots ?? [snapshot()],
    },
    getWebAsset: (name: string) => webAssets[name],
    // The REAL minter, so the suite exercises the genuine HMAC round-trip end
    // to end rather than a stub that could never reject anything.
    mintAssetToken: mintExtensionAssetToken,
  };

  const app = new Hono();
  const auth = opts.auth === undefined ? AUTHED : opts.auth;
  app.use('*', async (c, next) => {
    if (auth) c.set('auth', auth as never);
    await next();
  });
  app.route('/api/v1/extensions', createExtensionsWebRoutes(deps));
  return { app, isEnabledCalls };
}

describe('GET /api/v1/extensions/registry', () => {
  it('requires authentication', async () => {
    const { app } = buildHarness({ auth: null });
    const res = await app.request('/api/v1/extensions/registry');
    expect(res.status).toBe(401);
  });

  it('projects only enabled extensions (live recheck), excluding a stale-enabled snapshot', async () => {
    const { app, isEnabledCalls } = buildHarness({
      snapshots: [
        snapshot({ name: 'enabled-demo', manifest: manifest({ name: 'enabled-demo' }), enabled: true }),
        snapshot({ name: 'disabled-demo', manifest: manifest({ name: 'disabled-demo' }), enabled: true }),
      ],
      enabled: { 'enabled-demo': true, 'disabled-demo': false },
      webAssets: {
        'enabled-demo': { root: '/root/a', digest: `sha256:${'a'.repeat(64)}`, files: new Map() },
        'disabled-demo': { root: '/root/b', digest: `sha256:${'b'.repeat(64)}`, files: new Map() },
      },
    });

    const res = await app.request('/api/v1/extensions/registry');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.extensions.map((e: { name: string }) => e.name)).toEqual(['enabled-demo']);
    // Live re-check actually happened for both, not just trusted from the snapshot.
    expect(isEnabledCalls.sort()).toEqual(['disabled-demo', 'enabled-demo']);
  });

  it('advertises a SIGNED moduleUrl the browser can import without a header (#4164)', async () => {
    const { app } = buildHarness({
      webAssets: { demo: { root: '/root/a', digest: DIGEST_A, files: new Map() } },
    });
    const res = await app.request('/api/v1/extensions/registry');
    const body = await res.json();
    const moduleUrl: string = body.extensions[0].moduleUrl;

    expect(moduleUrl).toMatch(
      new RegExp(`^/api/v1/extensions/assets/t/[^/]+/demo/${DIGEST_A}/web/index\\.js$`),
    );
    // The token in that URL must actually verify for this extension + digest —
    // an unverifiable one would leave the loader 404ing instead of 401ing, which
    // is not a fix.
    const token = moduleUrl.split('/')[6]!;
    const verified = verifyExtensionAssetToken(token, { name: 'demo', digest: DIGEST_A });
    expect(verified).not.toBeNull();
    expect(verified!.claims.partnerId).toBe(SCOPE.partnerId);
    expect(verified!.claims.orgId).toBe(SCOPE.orgId);
  });

  it('is never stored by a cache — the response carries live credentials', async () => {
    const { app } = buildHarness({
      webAssets: { demo: { root: '/root/a', digest: DIGEST_A, files: new Map() } },
    });
    const res = await app.request('/api/v1/extensions/registry');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('never leaks the extraction root or a filesystem path', async () => {
    const { app } = buildHarness({
      webAssets: { demo: { root: '/var/lib/breeze/extracted/sha256-abc', digest: `sha256:${'a'.repeat(64)}`, files: new Map() } },
    });
    const res = await app.request('/api/v1/extensions/registry');
    const text = await res.text();
    expect(text).not.toContain('/var/lib/breeze');
    expect(text).not.toContain('"root"');
  });
});

describe('GET /api/v1/extensions/assets/t/:token/:name/:digest/*', () => {
  let root: string;
  const DIGEST = `sha256:${'a'.repeat(64)}`;

  /** Build the digest-addressed URL the registry would advertise, carrying a
   *  real signed token for the `(name, digest)` the URL asks for. Overriding
   *  `digest`/`name` mints for the OVERRIDDEN value on purpose, so a test that
   *  means to exercise a later check (retained-digest mismatch, inventory
   *  allowlist, containment) is not silently short-circuited by step 0. */
  function assetUrl(
    member: string,
    opts: { name?: string; digest?: string; token?: string } = {},
  ): string {
    const name = opts.name ?? 'demo';
    const digest = opts.digest ?? DIGEST;
    const token = opts.token ?? mintExtensionAssetToken({ name, digest }, SCOPE);
    return `/api/v1/extensions/assets/t/${token}/${name}/${digest}/${member}`;
  }

  function harnessWithAsset(files: Record<string, { path: string; content: Buffer | string }>, opts: {
    enabled?: boolean;
    digest?: string;
    auth?: unknown;
  } = {}) {
    const inventory = new Map<string, { sha256: string; uncompressedSize: number }>();
    for (const [member, { path, content }] of Object.entries(files)) {
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
      const abs = join(root, path);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, buf);
      inventory.set(member, { sha256: sha256(buf), uncompressedSize: buf.length });
    }
    return buildHarness({
      ...('auth' in opts ? { auth: opts.auth } : {}),
      enabled: { demo: opts.enabled ?? true },
      webAssets: {
        demo: { root, digest: opts.digest ?? DIGEST, files: inventory },
      },
    });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'breeze-ext-web-asset-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // ---- the signed-token gate (issue #4164) --------------------------------
  //
  // This route is deliberately NOT behind `authMiddleware`: a browser loads an
  // extension's entry module with a bare dynamic `import()`, which cannot send
  // an Authorization header, so a bearer gate here 401'd every extension UI.
  // The capability in the URL is what stands in its place, and every rejection
  // below must be the SAME bare 404 as every other rejection on this route.

  it('serves a signed asset with NO auth context at all (the #4164 regression)', async () => {
    const content = 'console.log("hello")';
    const { app } = harnessWithAsset(
      { 'web/index.js': { path: 'web/index.js', content } },
      { auth: null },
    );
    const res = await app.request(assetUrl('web/index.js'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(content);
  });

  it('404s (never 401) when no token segment is present at all — the old URL shape', async () => {
    const { app } = harnessWithAsset({ 'web/index.js': { path: 'web/index.js', content: 'x' } });
    const res = await app.request(`/api/v1/extensions/assets/demo/${DIGEST}/web/index.js`);
    expect(res.status).toBe(404);
    // ...and the body must not echo the request path back (the app-level 404
    // handler does; this router's own bare 404 must win, or a presented token
    // would be reflected into the response).
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('404s on a garbage token', async () => {
    const { app } = harnessWithAsset({ 'web/index.js': { path: 'web/index.js', content: 'x' } });
    const res = await app.request(assetUrl('web/index.js', { token: 'not-a-token' }));
    expect(res.status).toBe(404);
  });

  it('404s on a tampered token (payload edited, signature kept)', async () => {
    const { app } = harnessWithAsset({ 'web/index.js': { path: 'web/index.js', content: 'x' } });
    const good = mintExtensionAssetToken({ name: 'demo', digest: DIGEST }, SCOPE);
    const [, payload, sig] = good.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
    const edited = Buffer.from(JSON.stringify({ ...claims, exp: claims.exp + 86_400 }), 'utf8').toString('base64url');
    const res = await app.request(assetUrl('web/index.js', { token: `v1.${edited}.${sig}` }));
    expect(res.status).toBe(404);
  });

  it('404s on an EXPIRED token, and 200s on the same token before it expires', async () => {
    const content = 'console.log("hello")';
    const { app } = harnessWithAsset({ 'web/index.js': { path: 'web/index.js', content } });
    const token = mintExtensionAssetToken({ name: 'demo', digest: DIGEST }, SCOPE);
    const url = assetUrl('web/index.js', { token });

    expect((await app.request(url)).status).toBe(200);

    vi.useFakeTimers();
    try {
      // One hour + one bucket past mint clears any TTL the minter could have used.
      vi.setSystemTime(new Date(Date.now() + 2 * 60 * 60 * 1000));
      const res = await app.request(url);
      expect(res.status).toBe(404);
    } finally {
      vi.useRealTimers();
    }
  });

  it('404s when the token is bound to a DIFFERENT digest than the URL asks for', async () => {
    const { app } = harnessWithAsset({ 'web/index.js': { path: 'web/index.js', content: 'x' } });
    const foreign = mintExtensionAssetToken({ name: 'demo', digest: `sha256:${'c'.repeat(64)}` }, SCOPE);
    const res = await app.request(assetUrl('web/index.js', { token: foreign }));
    expect(res.status).toBe(404);
  });

  it('404s when the token is bound to a DIFFERENT extension than the URL asks for', async () => {
    const { app } = harnessWithAsset({ 'web/index.js': { path: 'web/index.js', content: 'x' } });
    const foreign = mintExtensionAssetToken({ name: 'other-ext', digest: DIGEST }, SCOPE);
    const res = await app.request(assetUrl('web/index.js', { token: foreign }));
    expect(res.status).toBe(404);
  });

  it('rejects a bad token BEFORE touching the state store or the filesystem', async () => {
    const { app, isEnabledCalls } = harnessWithAsset({ 'web/index.js': { path: 'web/index.js', content: 'x' } });
    const res = await app.request(assetUrl('web/index.js', { token: 'not-a-token' }));
    expect(res.status).toBe(404);
    // Step 0 runs ahead of the enabled re-check, the realpath calls and the
    // file read, so an unauthenticated flood of junk costs no I/O.
    expect(isEnabledCalls).toEqual([]);
  });

  it('serves a valid .js asset with the three required headers, verifying bytes at serve time', async () => {
    const content = 'console.log("hello")';
    const { app } = harnessWithAsset({ 'web/index.js': { path: 'web/index.js', content } });
    const res = await app.request(assetUrl('web/index.js'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    // Freshness is capped at the presented token's remaining life, NOT the year
    // an immutable digest-addressed URL would otherwise earn — a private cache
    // that outlived the token would keep serving these bytes without ever
    // re-reaching the live enabled re-check.
    const cacheControl = res.headers.get('cache-control') ?? '';
    expect(cacheControl).toMatch(/^private, max-age=\d+, immutable$/);
    const maxAge = Number(/max-age=(\d+)/.exec(cacheControl)![1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(3600);
    expect(await res.text()).toBe(content);
  });

  it('404s when the extension has no retained web asset at all', async () => {
    const { app } = buildHarness({ webAssets: {} });
    const res = await app.request(assetUrl('web/index.js'));
    expect(res.status).toBe(404);
  });

  it('404s on digest mismatch (stale/other version)', async () => {
    const { app } = harnessWithAsset({ 'web/index.js': { path: 'web/index.js', content: 'x' } });
    const res = await app.request(assetUrl('web/index.js', { digest: `sha256:${'f'.repeat(64)}` }));
    expect(res.status).toBe(404);
  });

  it('404s when the extension has been disabled after the snapshot was taken', async () => {
    const { app } = harnessWithAsset({ 'web/index.js': { path: 'web/index.js', content: 'x' } }, { enabled: false });
    const res = await app.request(assetUrl('web/index.js'));
    expect(res.status).toBe(404);
  });

  it('404s when the requested member is missing from the verified inventory', async () => {
    const { app } = harnessWithAsset({ 'web/index.js': { path: 'web/index.js', content: 'x' } });
    const res = await app.request(assetUrl('web/not-in-inventory.js'));
    expect(res.status).toBe(404);
  });

  it('404s a traversal member "../server/index.cjs"', async () => {
    const { app } = harnessWithAsset({ 'web/index.js': { path: 'web/index.js', content: 'x' } });
    const res = await app.request(assetUrl('../server/index.cjs'));
    expect(res.status).toBe(404);
  });

  it('404s a percent-encoded traversal member "%2e%2e/server/index.cjs"', async () => {
    const { app } = harnessWithAsset({ 'web/index.js': { path: 'web/index.js', content: 'x' } });
    const res = await app.request(assetUrl('%2e%2e/server/index.cjs'));
    expect(res.status).toBe(404);
  });

  it('404s a "web/module.node" member even when present in the inventory (disallowed content type)', async () => {
    const { app } = harnessWithAsset({ 'web/module.node': { path: 'web/module.node', content: 'native-binary-bytes' } });
    const res = await app.request(assetUrl('web/module.node'));
    expect(res.status).toBe(404);
  });

  it('404s disallowed content types: .html, .map, .node', async () => {
    const { app } = harnessWithAsset({
      'web/index.html': { path: 'web/index.html', content: '<html></html>' },
      'web/index.js.map': { path: 'web/index.js.map', content: '{}' },
      'web/lib/native.node': { path: 'web/lib/native.node', content: 'bin' },
    });
    for (const member of ['web/index.html', 'web/index.js.map', 'web/lib/native.node']) {
      const res = await app.request(assetUrl(`${member}`));
      expect(res.status).toBe(404);
    }
  });

  it('404s a symlink that escapes the extraction root', async () => {
    const secretDir = mkdtempSync(join(tmpdir(), 'breeze-ext-secret-'));
    const secretPath = join(secretDir, 'secret.js');
    const secretContent = 'const SECRET = "leak-me";';
    writeFileSync(secretPath, secretContent);

    mkdirSync(join(root, 'web'), { recursive: true });
    const linkPath = join(root, 'web', 'evil.js');
    symlinkSync(secretPath, linkPath);

    const inventory = new Map([
      ['web/evil.js', { sha256: sha256(secretContent), uncompressedSize: secretContent.length }],
    ]);
    const { app } = buildHarness({
      webAssets: { demo: { root, digest: DIGEST, files: inventory } },
    });

    const res = await app.request(assetUrl('web/evil.js'));
    expect(res.status).toBe(404);

    rmSync(secretDir, { recursive: true, force: true });
  });

  it('404s a sibling-directory prefix-trap ("<root>-evil" must not pass a naive startsWith(root) check)', async () => {
    const evilSiblingDir = `${root}-evil`;
    mkdirSync(evilSiblingDir, { recursive: true });
    const evilContent = 'sibling-secret';
    writeFileSync(join(evilSiblingDir, 'secret.js'), evilContent);

    // A member that, once path.resolve'd against `root`, lands in the sibling
    // directory whose name happens to start with the same prefix as `root`.
    const member = '../' + evilSiblingDir.slice(root.length + 1) + '/secret.js';
    const inventory = new Map([
      [member, { sha256: sha256(evilContent), uncompressedSize: evilContent.length }],
    ]);
    const { app } = buildHarness({ webAssets: { demo: { root, digest: DIGEST, files: inventory } } });

    const res = await app.request(assetUrl(`${member}`));
    expect(res.status).toBe(404);

    rmSync(evilSiblingDir, { recursive: true, force: true });
  });

  it('404s (TOCTOU) when the on-disk bytes no longer match the verified inventory hash', async () => {
    const original = 'console.log("original")';
    const { app } = harnessWithAsset({ 'web/index.js': { path: 'web/index.js', content: original } });
    // Swap the bytes on disk AFTER the inventory hash was recorded — simulates
    // a write to the artifact-store root between verification and serving.
    writeFileSync(join(root, 'web', 'index.js'), 'console.log("tampered")');

    const res = await app.request(assetUrl('web/index.js'));
    expect(res.status).toBe(404);
  });

  // SECURITY (Plan-03 final review): the retained inventory used to be the
  // bundle's FULL verified `files` map — including `manifest.json` (leaks
  // `publicRoutes`/`tenancy`/`server.entry` filesystem-adjacent paths) and
  // any `server/*`/`migrations/*` member with an allowed extension. These
  // cases inject such members directly into the inventory (bypassing
  // `registerExtensionWebAsset`'s retention-time filter, exactly as a stale
  // caller or a future `getWebAsset` source might) to prove the ROUTE itself
  // — not just retention — refuses to serve them.
  it('404s the manifest.json member even when present in the verified inventory', async () => {
    const { app } = harnessWithAsset({ 'manifest.json': { path: 'manifest.json', content: '{"tenancy":{}}' } });
    const res = await app.request(assetUrl('manifest.json'));
    expect(res.status).toBe(404);
  });

  it('404s a server-side member even when present in the verified inventory', async () => {
    const { app } = harnessWithAsset({
      'server/config.json': { path: 'server/config.json', content: '{"secret":"x"}' },
    });
    const res = await app.request(assetUrl('server/config.json'));
    expect(res.status).toBe(404);
  });

  it('404s a migrations-tree member even when present in the verified inventory', async () => {
    const { app } = harnessWithAsset({
      'migrations/0001_init.sql': { path: 'migrations/0001_init.sql', content: 'select 1;' },
    });
    const res = await app.request(assetUrl('migrations/0001_init.sql'));
    expect(res.status).toBe(404);
  });

  it('404s the reserved integrity.json/signature members even when present in the verified inventory', async () => {
    const { app } = harnessWithAsset({
      'integrity.json': { path: 'integrity.json', content: '{}' },
    });
    const res = await app.request(assetUrl('integrity.json'));
    expect(res.status).toBe(404);
  });

  it('still serves a valid web/index.js asset (matches the fixture manifest\'s web.entry convention)', async () => {
    const content = 'export default 1;';
    const { app } = harnessWithAsset({ 'web/index.js': { path: 'web/index.js', content } });
    const res = await app.request(assetUrl('web/index.js'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(content);
  });

  it('still serves a nested web/nested/x.css asset', async () => {
    const content = '.demo { color: red; }';
    const { app } = harnessWithAsset({ 'web/nested/x.css': { path: 'web/nested/x.css', content } });
    const res = await app.request(assetUrl('web/nested/x.css'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/css/);
    expect(await res.text()).toBe(content);
  });

  it('sets the correct content type per allowed extension', async () => {
    const cases: Record<string, string> = {
      'web/a.mjs': 'javascript',
      'web/a.css': 'css',
      'web/a.json': 'json',
      'web/a.wasm': 'wasm',
      'web/a.svg': 'svg',
      'web/a.png': 'png',
      'web/a.jpg': 'jpeg',
      'web/a.jpeg': 'jpeg',
      'web/a.gif': 'gif',
      'web/a.webp': 'webp',
      'web/a.woff2': 'font',
    };
    const files: Record<string, { path: string; content: Buffer | string }> = {};
    for (const name of Object.keys(cases)) files[name] = { path: name, content: 'x' };
    const { app } = harnessWithAsset(files);
    for (const [name, expected] of Object.entries(cases)) {
      const res = await app.request(assetUrl(`${name}`));
      expect(res.status, `${name} should be served`).toBe(200);
      expect(res.headers.get('content-type'), name).toMatch(new RegExp(expected));
    }
  });

  // SECURITY (Plan-03 follow-up re-review): the OLD denylist excluded only
  // manifest.json, RESERVED_MEMBERS, and the server/migrations subtrees — a
  // root-level config.json/secrets.json, a data/seed.json, or a stray
  // non-server/ .js helper was still servable to any authenticated user of
  // any tenant where the extension is enabled. The fail-CLOSED web/-prefix
  // allowlist closes this: only members actually under web/ are ever
  // servable, regardless of name or content type.
  it('404s a root-level config.json (member NOT under web/, .json content-type) even when present in the verified inventory', async () => {
    const { app } = harnessWithAsset({
      'config.json': { path: 'config.json', content: '{"apiKey":"leak-me"}' },
    });
    const res = await app.request(assetUrl('config.json'));
    expect(res.status).toBe(404);
  });

  it('404s a root-level secrets.json even when present in the verified inventory', async () => {
    const { app } = harnessWithAsset({
      'secrets.json': { path: 'secrets.json', content: '{"token":"leak-me"}' },
    });
    const res = await app.request(assetUrl('secrets.json'));
    expect(res.status).toBe(404);
  });

  it('404s a non-web data/seed.json even when present in the verified inventory', async () => {
    const { app } = harnessWithAsset({
      'data/seed.json': { path: 'data/seed.json', content: '{"rows":[]}' },
    });
    const res = await app.request(assetUrl('data/seed.json'));
    expect(res.status).toBe(404);
  });

  it('404s a non-server/ .js helper at the bundle root even when present in the verified inventory', async () => {
    const { app } = harnessWithAsset({
      'app.js': { path: 'app.js', content: 'console.log("helper")' },
    });
    const res = await app.request(assetUrl('app.js'));
    expect(res.status).toBe(404);
  });

  it('404s a "webhook/x.js" sibling that shares the "web" prefix but not the exact "web/" segment', async () => {
    const { app } = harnessWithAsset({
      'webhook/x.js': { path: 'webhook/x.js', content: 'console.log("not web/")' },
    });
    const res = await app.request(assetUrl('webhook/x.js'));
    expect(res.status).toBe(404);
  });
});
