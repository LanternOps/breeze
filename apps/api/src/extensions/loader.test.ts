import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../services/aiTools', () => ({ aiTools: new Map() }));
vi.mock('../middleware/auth', () => ({ authMiddleware: async (_c: unknown, next: () => Promise<void>) => next() }));

import { mountExtensions } from './loader';

function scaffoldRuntimeExtension(root: string) {
  const dir = join(root, 'demo');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'breeze-extension.json'),
    JSON.stringify({ name: 'demo', routeNamespace: 'demo', entry: 'src/index.ts', tenancy: {} })
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
         ctx.mountRoute(app);
         ctx.aiTools.set('demo_tool', { definition: { name: 'demo_tool', description: 'x', input_schema: { type: 'object' } }, tier: 1, handler: async () => 'ok' });
       },
     };
     export default ext;`
  );
  return root;
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

  it('loads the dist CJS default export when present', async () => {
    scaffoldCjsRuntimeExtension(root);
    const app = new Hono();
    await mountExtensions(app, root);
    const res = await app.request('/api/v1/cjs-demo/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
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
