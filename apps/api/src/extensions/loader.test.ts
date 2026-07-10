import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
         app.get('/health', (c) => c.json({ ok: true, ext: 'demo' }));
         ctx.mountRoute(app);
         ctx.aiTools.set('demo_tool', { definition: { name: 'demo_tool', description: 'x', input_schema: { type: 'object' } }, tier: 1, handler: async () => 'ok' });
       },
     };
     export default ext;`
  );
  return root;
}

describe('mountExtensions', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ext-rt-')); });

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
    expect(await res.json()).toEqual({ ok: true, ext: 'demo' });
    const { aiTools } = await import('../services/aiTools');
    expect(aiTools.has('demo_tool')).toBe(true);
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
    aiTools.delete('demo_tool');
  });
});
