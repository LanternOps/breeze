/**
 * CORS for the digest-addressed extension web-module route.
 *
 * An extension client panel is served from a DIFFERENT origin than this API
 * (an add-in pane, e.g. https://localhost:3004 in dev) and must `import()` an
 * extension's web-bundle module from `/api/v1/extensions/assets/...`. The
 * global CORS layer only knows the app's own origins, so without a dedicated
 * allowlist the module fetch is blocked cross-origin.
 *
 * Contract pinned here:
 *  - `EXTENSION_CLIENT_PANEL_ORIGINS` (comma-separated) is the ONLY source of
 *    allowed panel origins; empty/unset means NO cross-origin access.
 *  - No wildcard, ever: `*` entries are dropped, and the ACAO header is only
 *    ever an exact allowlisted origin.
 *  - ONLY the web-module route gains CORS — the same panel origin gets no
 *    ACAO on `/registry` or any other path.
 *  - The response keeps its JS MIME type and nosniff header.
 *
 * The harness composes hono/cors EXACTLY as index.ts does (same options,
 * shared `withExtensionPanelOrigins` composition), so what passes here is the
 * production wiring, not a test-local reimplementation.
 */
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: { get: (k: string) => unknown; json: (b: unknown, s: number) => unknown }, next: () => Promise<void>) => {
    if (!c.get('auth')) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  }),
}));

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionManifestV1 } from '@breeze/extension-sdk';
import { createExtensionsWebRoutes } from './extensionsWeb';
import { createCorsOriginResolver } from '../services/corsOrigins';
import {
  createExtensionPanelOriginResolver,
  parseExtensionClientPanelOrigins,
  withExtensionPanelOrigins,
} from '../services/extensionPanelOrigins';
import type { StagedExtensionContributions } from '../extensions/contributionRegistry';

const PANEL_ORIGIN = 'https://panel.example.test';
const OTHER_ORIGIN = 'https://evil.example.test';
const MODULE_BYTES = 'export const ok = true;\n';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const MODULE_PATH = `/api/v1/extensions/assets/demo/${DIGEST}/web/panel.js`;

function sha256(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'breeze-ext-cors-'));
  mkdirSync(join(root, 'web'), { recursive: true });
  writeFileSync(join(root, 'web', 'panel.js'), MODULE_BYTES);
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function manifest(): ExtensionManifestV1 {
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
    web: { entry: 'web/panel.js', pages: [], navigation: [], slots: [] },
  } as ExtensionManifestV1;
}

/** hono/cors options EXACTLY as apps/api/src/index.ts configures the global layer. */
function buildApp(panelOriginsRaw: string | undefined): Hono {
  // Production-mode base resolver with no configured app origins: nothing but
  // the always-on Tauri origins is allowed by the base, so anything the panel
  // resolver admits is provably its own doing.
  const resolveCorsOrigin = createCorsOriginResolver({ nodeEnv: 'production', configuredOriginsRaw: '' });
  const resolveExtensionPanelOrigin = createExtensionPanelOriginResolver({ configuredOriginsRaw: panelOriginsRaw });

  const app = new Hono();
  app.use('*', cors({
    origin: withExtensionPanelOrigins(resolveCorsOrigin, resolveExtensionPanelOrigin),
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-API-Key', 'X-Breeze-CSRF'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['Content-Length', 'X-Request-Id'],
    maxAge: 86400,
  }));
  app.use('*', async (c, next) => {
    c.set('auth', { user: { id: 'u1', email: 'u@breeze.test', name: 'U' } } as never);
    await next();
  });

  const snapshot = {
    name: 'demo',
    version: '1.0.0',
    manifest: manifest(),
    routeApp: null,
    jobs: new Map(),
    aiTools: new Map(),
    enabled: true,
  } as unknown as StagedExtensionContributions;

  app.route('/api/v1/extensions', createExtensionsWebRoutes({
    stateStore: { isEnabled: async () => true },
    registry: { listActive: () => [snapshot] },
    getWebAsset: () => ({
      root,
      digest: DIGEST,
      files: new Map([['web/panel.js', { sha256: sha256(MODULE_BYTES), uncompressedSize: MODULE_BYTES.length }]]),
    }),
  }));
  return app;
}

describe('parseExtensionClientPanelOrigins', () => {
  it('parses a comma-separated allowlist, trimming and dropping empties', () => {
    expect(parseExtensionClientPanelOrigins(' https://a.test ,, https://b.test '))
      .toEqual(new Set(['https://a.test', 'https://b.test']));
  });

  it('is empty (default-deny) for unset or blank input', () => {
    expect(parseExtensionClientPanelOrigins(undefined).size).toBe(0);
    expect(parseExtensionClientPanelOrigins('').size).toBe(0);
    expect(parseExtensionClientPanelOrigins('  ,  ').size).toBe(0);
  });

  it('drops wildcards, non-URLs, and entries that are not bare origins', () => {
    expect(parseExtensionClientPanelOrigins('*')).toEqual(new Set());
    expect(parseExtensionClientPanelOrigins('https://*.example.test')).toEqual(new Set());
    expect(parseExtensionClientPanelOrigins('not a url')).toEqual(new Set());
    expect(parseExtensionClientPanelOrigins('https://a.test/path')).toEqual(new Set());
    expect(parseExtensionClientPanelOrigins('https://a.test, * , https://b.test/x, https://c.test'))
      .toEqual(new Set(['https://a.test', 'https://c.test']));
  });

  it('keeps explicit ports (the dev add-in origin)', () => {
    expect(parseExtensionClientPanelOrigins('https://localhost:3004'))
      .toEqual(new Set(['https://localhost:3004']));
  });
});

describe('extension web-module route CORS', () => {
  it('serves the module cross-origin to an allowlisted panel origin, JS MIME intact', async () => {
    const app = buildApp(PANEL_ORIGIN);
    const res = await app.request(MODULE_PATH, { headers: { origin: PANEL_ORIGIN } });

    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(PANEL_ORIGIN);
    expect(res.headers.get('vary')).toContain('Origin');
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    await expect(res.text()).resolves.toBe(MODULE_BYTES);
  });

  it('answers the preflight for an allowlisted panel origin', async () => {
    const app = buildApp(PANEL_ORIGIN);
    const res = await app.request(MODULE_PATH, {
      method: 'OPTIONS',
      headers: {
        origin: PANEL_ORIGIN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(PANEL_ORIGIN);
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization');
  });

  it('emits no ACAO for a non-allowlisted origin', async () => {
    const app = buildApp(PANEL_ORIGIN);
    const res = await app.request(MODULE_PATH, { headers: { origin: OTHER_ORIGIN } });

    expect(res.status).toBe(200); // same-origin/tooling requests still work
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('emits no ACAO anywhere when the allowlist is empty (default-deny)', async () => {
    for (const raw of [undefined, '']) {
      const app = buildApp(raw);
      const res = await app.request(MODULE_PATH, { headers: { origin: PANEL_ORIGIN } });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('never honors a wildcard entry', async () => {
    const app = buildApp('*');
    const res = await app.request(MODULE_PATH, { headers: { origin: OTHER_ORIGIN } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('grants a panel origin NOTHING outside the module route', async () => {
    const app = buildApp(PANEL_ORIGIN);

    const registry = await app.request('/api/v1/extensions/registry', { headers: { origin: PANEL_ORIGIN } });
    expect(registry.status).toBe(200);
    expect(registry.headers.get('access-control-allow-origin')).toBeNull();

    const elsewhere = await app.request('/api/v1/extensions/registry', {
      method: 'OPTIONS',
      headers: { origin: PANEL_ORIGIN, 'access-control-request-method': 'GET' },
    });
    expect(elsewhere.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('leaves the base resolver behavior intact (composition, not replacement)', async () => {
    const app = buildApp(PANEL_ORIGIN);
    // Tauri origins are always allowed by the base resolver, on any path.
    const res = await app.request('/api/v1/extensions/registry', { headers: { origin: 'tauri://localhost' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('tauri://localhost');
  });
});
