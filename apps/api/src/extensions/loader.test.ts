import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../services/aiTools', () => ({ aiTools: new Map() }));
vi.mock('../middleware/auth', () => ({ authMiddleware: async (_c: unknown, next: () => Promise<void>) => next() }));
vi.mock('../middleware/agentAuth', () => ({ agentAuthMiddleware: async (_c: unknown, next: () => Promise<void>) => next() }));
vi.mock('../services/auditService', () => ({ createAuditLogAsync: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/secretCrypto', () => ({
  encryptSecret: vi.fn((value: string, options: { aad?: string }) => `encrypted:${options.aad}:${value}`),
  decryptForColumn: vi.fn((_table: string, _column: string, value: string) => value.split(':').at(-1)),
}));
vi.mock('../db', () => ({ db: { execute: vi.fn() } }));
vi.mock('../services/redis', () => ({ getRedis: () => null }));
vi.mock('../services/clientIp', () => ({ getTrustedClientIp: () => 'extension-loader-test' }));

import { mountExtensions } from './loader';
import { __resetSkipPrefixesForTests, globalRateLimit } from '../middleware/globalRateLimit';

function scaffoldRuntimeExtension(root: string, manifestOverrides: Record<string, unknown> = {}) {
  const dir = join(root, 'demo');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'breeze-extension.json'),
    JSON.stringify({ name: 'demo', routeNamespace: 'demo', entry: 'src/index.ts', tenancy: {}, ...manifestOverrides })
  );
  // A real loadable entry — plain TS, imported under vitest's transform.
  writeFileSync(
    join(dir, 'src', 'index.ts'),
    `import { Hono } from 'hono';
     const ext = {
       register(ctx) {
         const app = new Hono();
         const initialAiToolCount = ctx.aiTools.size;
         app.get('/health', (c) => c.json({ ok: true, ext: 'demo', initialAiToolCount }));
         app.get('/agent/health', (c) => c.json({ ok: true }));
         ctx.mountRoute(app);
         ctx.aiTools.set('demo_tool', { definition: { name: 'demo_tool', description: 'x', input_schema: { type: 'object' } }, tier: 1, handler: async () => 'ok' });
         const ciphertext = ctx.secrets.encryptForColumn('demo_secrets', 'value', 'secret');
         const plaintext = ctx.secrets.decryptForColumn('demo_secrets', 'value', ciphertext);
         if (!ctx.agentAuthMiddleware || !ctx.db || plaintext !== 'secret') throw new Error('missing ctx member');
         ctx.audit({ actorId: 'user-1', action: 'demo.manual', resourceType: 'demo', result: 'success' });
         ctx.audit({ actorType: 'agent', actorId: 'agent-1', action: 'demo.agent', resourceType: 'demo', result: 'success' });
       },
     };
     export default ext;`
  );
  return root;
}

function addStaleCjsBuild(root: string) {
  const dir = join(root, 'demo');
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(
    join(dir, 'dist', 'index.cjs'),
    "module.exports = { default: { register(ctx){ const {Hono} = require('hono'); const app = new Hono(); app.get('/health', c => c.json({ok:true, ext:'stale-dist'})); ctx.mountRoute(app); } } };"
  );
}

function scaffoldCjsRuntimeExtension(root: string) {
  const dir = join(root, 'cjs-demo');
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(
    join(dir, 'breeze-extension.json'),
    JSON.stringify({ name: 'cjs-demo', routeNamespace: 'cjs-demo', entry: 'src/index.ts', tenancy: {} })
  );
  writeFileSync(
    join(dir, 'dist', 'index.cjs'),
    "module.exports = { default: { register(ctx){ const {Hono} = require('hono'); const app = new Hono(); app.get('/health', c => c.json({ok:true})); ctx.mountRoute(app); } } };"
  );
  return root;
}

describe('mountExtensions', () => {
  let root: string;
  beforeEach(async () => {
    root = mkdtempSync(join(process.cwd(), 'ext-rt-'));
    __resetSkipPrefixesForTests();
    vi.clearAllMocks();
    const { aiTools } = await import('../services/aiTools');
    aiTools.clear();
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('is a no-op with an empty extensions root', async () => {
    const app = new Hono();
    await mountExtensions(app, root);
    const res = await app.request('/api/v1/demo/health');
    expect(res.status).toBe(404);
  });

  it('mounts a discovered extension at /api/v1/<routeNamespace> and registers its tools', async () => {
    scaffoldRuntimeExtension(root);
    const app = new Hono();
    await mountExtensions(app, root);
    const res = await app.request('/api/v1/demo/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ext: 'demo', initialAiToolCount: 0 });
    const { aiTools } = await import('../services/aiTools');
    expect(aiTools.has('demo_tool')).toBe(true);
  });

  it('provides seam-v2 context members and registers the agent skip prefix', async () => {
    scaffoldRuntimeExtension(root, { agentRoutes: true });
    const app = new Hono();
    app.use('*', globalRateLimit({ limit: 1, windowSeconds: 60 }));

    await mountExtensions(app, root);

    const { createAuditLogAsync } = await import('../services/auditService');
    expect(createAuditLogAsync).toHaveBeenCalledWith(expect.objectContaining({
      actorId: 'user-1',
      action: 'demo.manual',
      initiatedBy: 'manual',
      result: 'success',
    }));
    expect(createAuditLogAsync).toHaveBeenCalledWith(expect.objectContaining({
      actorType: 'agent',
      actorId: 'agent-1',
      action: 'demo.agent',
      initiatedBy: 'agent',
      result: 'success',
    }));

    expect((await app.request('/api/v1/demo/agent/health')).status).toBe(200);
    expect((await app.request('/api/v1/demo/agent/health')).status).toBe(200);
  });

  it('loads the dist CJS default export when present', async () => {
    scaffoldCjsRuntimeExtension(root);
    const app = new Hono();
    await mountExtensions(app, root);
    const res = await app.request('/api/v1/cjs-demo/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('prefers the manifest TS entry over a coexisting dist build outside production', async () => {
    scaffoldRuntimeExtension(root);
    addStaleCjsBuild(root);
    vi.stubEnv('NODE_ENV', 'development');
    const app = new Hono();
    await mountExtensions(app, root);
    const res = await app.request('/api/v1/demo/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ext: 'demo', initialAiToolCount: 0 });
    vi.unstubAllEnvs();
  });

  it('prefers the dist build over a coexisting TS entry in production', async () => {
    scaffoldRuntimeExtension(root);
    addStaleCjsBuild(root);
    vi.stubEnv('NODE_ENV', 'production');
    const app = new Hono();
    await mountExtensions(app, root);
    const res = await app.request('/api/v1/demo/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ext: 'stale-dist' });
    vi.unstubAllEnvs();
  });

  it('respects BREEZE_EXTENSIONS_ENABLED=false', async () => {
    scaffoldRuntimeExtension(root);
    vi.stubEnv('BREEZE_EXTENSIONS_ENABLED', 'false');
    const app = new Hono();
    await mountExtensions(app, root);
    expect((await app.request('/api/v1/demo/health')).status).toBe(404);
    vi.unstubAllEnvs();
  });

  it('throws on AI tool name collision', async () => {
    scaffoldRuntimeExtension(root);
    const { aiTools } = await import('../services/aiTools');
    aiTools.set('demo_tool', { definition: { name: 'demo_tool' } } as never);
    const app = new Hono();
    await expect(mountExtensions(app, root)).rejects.toThrow(/demo_tool/);
  });
});
