import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../services/aiTools', () => {
  const aiTools = new Map();
  return {
    aiTools,
    hasCoreAiToolName: (name: string) => aiTools.has(name),
  };
});
// Auth mocks stamp a response header so tests can observe WHICH guard the
// loader's default-deny wrapper applied to each route.
vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(
    async (c: { header: (k: string, v: string) => void }, next: () => Promise<void>) => {
      c.header('x-guard', 'user');
      return next();
    },
  ),
}));
vi.mock('../middleware/agentAuth', () => ({
  agentAuthMiddleware: vi.fn(
    async (c: { header: (k: string, v: string) => void }, next: () => Promise<void>) => {
      c.header('x-guard', 'agent');
      return next();
    },
  ),
}));
vi.mock('../middleware/helperAuth', () => ({
  helperAuth: vi.fn(
    async (c: { header: (k: string, v: string) => void }, next: () => Promise<void>) => {
      c.header('x-guard', 'helper');
      return next();
    },
  ),
}));
vi.mock('../services/auditService', () => ({ createAuditLogAsync: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/secretCrypto', () => ({
  encryptSecret: vi.fn((value: string, options: { aad?: string }) => `encrypted:${options.aad}:${value}`),
  decryptForColumn: vi.fn((_table: string, _column: string, value: string) => value.split(':').at(-1)),
}));
// Resolves to zero catalog rows by default: the scaffolded manifests declare no
// tenancy tables and create none, so the tripwire finds nothing to complain
// about. Tests that exercise the tripwire's verdicts stub rows per-case.
//
// These mocked verdict tests prove the BRANCHING, never the SQL — a mocked
// db.execute will happily "return rows" for a query Postgres would reject
// outright (that is exactly how a `= ANY(tuple)` bug once passed six green unit
// tests). The real contract lives in
// src/__tests__/integration/extensionTenancyRls.integration.test.ts.
vi.mock('../db', () => ({ db: { execute: vi.fn().mockResolvedValue([]) } }));
vi.mock('../services/redis', () => ({ getRedis: () => null }));
vi.mock('../services/clientIp', () => ({ getTrustedClientIp: () => 'extension-loader-test' }));

import { loadSourceExtensions } from './loader';
import { ExtensionContributionRegistry } from './contributionRegistry';
import { mountExtensionGateway } from './gateway';
import { __resetSkipPrefixesForTests, globalRateLimit } from '../middleware/globalRateLimit';

async function mountExtensions(app: Hono, root: string): Promise<void> {
  const registry = new ExtensionContributionRegistry();
  mountExtensionGateway(app, registry, async () => true);
  await loadSourceExtensions(registry, root);
}

function scaffoldRuntimeExtension(
  root: string,
  manifestOverrides: Record<string, unknown> = {},
  entrySource?: string,
) {
  const dir = join(root, 'demo');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'breeze-extension.json'),
    JSON.stringify({ name: 'demo', routeNamespace: 'demo', entry: 'src/index.ts', tenancy: {}, ...manifestOverrides })
  );
  // A real loadable entry — plain TS, imported under vitest's transform.
  writeFileSync(
    join(dir, 'src', 'index.ts'),
    entrySource ?? `import { Hono } from 'hono';
     const ext = {
       register(ctx) {
         const app = new Hono();
         const initialAiToolCount = ctx.aiTools.size;
         app.get('/health', (c) => c.json({ ok: true, ext: 'demo', initialAiToolCount }));
         app.get('/agent/health', (c) => c.json({ ok: true }));
         app.get('/pub/thing', (c) => c.json({ ok: true, pub: true }));
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

  it('stages and activates legacy route and AI contributions under the stable namespace', async () => {
    scaffoldRuntimeExtension(root, { routeNamespace: 'legacy-alias' });
    const registry = new ExtensionContributionRegistry();
    const app = new Hono();
    mountExtensionGateway(app, registry, async () => true);

    await loadSourceExtensions(registry, root);

    const active = registry.get('demo');
    expect(active).toMatchObject({
      name: 'demo',
      version: '0.0.0',
      enabled: true,
      manifest: {
        apiVersion: 'breeze.extensions/v1',
        routeNamespace: 'legacy-alias',
        aiTools: [{ name: 'demo_tool' }],
      },
    });
    expect(active?.aiTools.has('demo_tool')).toBe(true);
    expect((await app.request('/api/v1/ext/demo/health')).status).toBe(200);
    expect((await app.request('/api/v1/legacy-alias/health')).status).toBe(200);
  });

  it('does not activate or publish staged contributions when registration fails', async () => {
    scaffoldRuntimeExtension(
      root,
      {},
      `import { Hono } from 'hono';
       const ext = {
         register(ctx) {
           const app = new Hono();
           app.get('/health', (c) => c.json({ ok: true }));
           ctx.mountRoute(app);
           ctx.aiTools.set('demo_tool', { definition: { name: 'demo_tool', description: 'x', input_schema: { type: 'object' } }, tier: 1, handler: async () => 'ok' });
           throw new Error('registration failed');
         },
       };
       export default ext;`,
    );
    const registry = new ExtensionContributionRegistry();
    const { aiTools } = await import('../services/aiTools');

    await expect(loadSourceExtensions(registry, root)).rejects.toThrow(/registration failed/);

    expect(registry.get('demo')).toBeUndefined();
    expect(aiTools.has('demo_tool')).toBe(false);
  });

  it('does not activate staged contributions when the repo-wide tenancy check fails', async () => {
    scaffoldRuntimeExtension(root);
    const { db } = await import('../db');
    (db.execute as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          table_name: 'documents',
          relkind: 'r',
          rls_enabled: true,
          rls_forced: true,
          policy_count: 1,
          tenant_column_count: 1,
          tenant_fk_count: 1,
        },
      ]);
    const registry = new ExtensionContributionRegistry();
    const { aiTools } = await import('../services/aiTools');

    await expect(loadSourceExtensions(registry, root)).rejects.toThrow(/belong to no core schema/);

    expect(registry.get('demo')).toBeUndefined();
    expect(aiTools.has('demo_tool')).toBe(false);
  });

  it('is a no-op with an empty extensions root', async () => {
    const app = new Hono();
    await mountExtensions(app, root);
    const res = await app.request('/api/v1/ext/demo/health');
    expect(res.status).toBe(503);
  });

  it('activates a discovered extension at /api/v1/ext/<name> and registers its tools', async () => {
    scaffoldRuntimeExtension(root);
    const app = new Hono();
    const registry = new ExtensionContributionRegistry();
    mountExtensionGateway(app, registry, async () => true);
    await loadSourceExtensions(registry, root);
    const res = await app.request('/api/v1/ext/demo/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ext: 'demo', initialAiToolCount: 0 });
    const { aiTools } = await import('../services/aiTools');
    expect(aiTools.has('demo_tool')).toBe(false);
    expect(registry.getAiTool('demo_tool')).toBeDefined();
  });

  it('provides seam-v2 context members and registers the agent skip prefix', async () => {
    scaffoldRuntimeExtension(root, { agentRoutes: true, routeNamespace: 'legacy-agent' });
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

    expect((await app.request('/api/v1/ext/demo/agent/health')).status).toBe(200);
    expect((await app.request('/api/v1/ext/demo/agent/health')).status).toBe(200);
    expect((await app.request('/api/v1/legacy-agent/agent/health')).status).toBe(200);
    expect((await app.request('/api/v1/legacy-agent/agent/health')).status).toBe(200);
  });

  it('loads the dist CJS default export when present', async () => {
    scaffoldCjsRuntimeExtension(root);
    const app = new Hono();
    await mountExtensions(app, root);
    const res = await app.request('/api/v1/ext/cjs-demo/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('prefers the manifest TS entry over a coexisting dist build outside production', async () => {
    scaffoldRuntimeExtension(root);
    addStaleCjsBuild(root);
    vi.stubEnv('NODE_ENV', 'development');
    const app = new Hono();
    await mountExtensions(app, root);
    const res = await app.request('/api/v1/ext/demo/health');
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
    const res = await app.request('/api/v1/ext/demo/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ext: 'stale-dist' });
    vi.unstubAllEnvs();
  });

  it('respects BREEZE_EXTENSIONS_ENABLED=false', async () => {
    scaffoldRuntimeExtension(root);
    vi.stubEnv('BREEZE_EXTENSIONS_ENABLED', 'false');
    const app = new Hono();
    await mountExtensions(app, root);
    expect((await app.request('/api/v1/ext/demo/health')).status).toBe(503);
    vi.unstubAllEnvs();
  });

  it('throws immediately when a source-dir extension calls ctx.registerJob', async () => {
    scaffoldRuntimeExtension(root, {}, `import { Hono } from 'hono';
     const ext = {
       register(ctx) {
         const app = new Hono();
         app.get('/health', (c) => c.json({ ok: true }));
         ctx.mountRoute(app);
         ctx.registerJob({ name: 'sweep', cron: '0 * * * *', handler: async () => {} });
       },
     };
     export default ext;`);
    const app = new Hono();
    await expect(mountExtensions(app, root)).rejects.toThrow(
      /source-dir extensions cannot register jobs/,
    );
  });

  it('throws on AI tool name collision', async () => {
    scaffoldRuntimeExtension(root);
    const { aiTools } = await import('../services/aiTools');
    aiTools.set('demo_tool', { definition: { name: 'demo_tool' } } as never);
    const app = new Hono();
    await expect(mountExtensions(app, root)).rejects.toThrow(/demo_tool/);
  });

  describe('default-deny auth guard', () => {
    it('applies core authMiddleware to non-agent routes and agentAuthMiddleware to /agent/ routes', async () => {
      scaffoldRuntimeExtension(root);
      const app = new Hono();
      await mountExtensions(app, root);

      const userRoute = await app.request('/api/v1/ext/demo/health');
      expect(userRoute.status).toBe(200);
      expect(userRoute.headers.get('x-guard')).toBe('user');

      const agentRoute = await app.request('/api/v1/ext/demo/agent/health');
      expect(agentRoute.status).toBe(200);
      expect(agentRoute.headers.get('x-guard')).toBe('agent');
    });

    it('skips core auth only for manifest-declared publicRoutes (exact match)', async () => {
      scaffoldRuntimeExtension(root, { publicRoutes: ['/health'] });
      const app = new Hono();
      await mountExtensions(app, root);

      const publicRoute = await app.request('/api/v1/ext/demo/health');
      expect(publicRoute.status).toBe(200);
      expect(publicRoute.headers.get('x-guard')).toBeNull();

      // Everything not listed stays behind core auth.
      const guarded = await app.request('/api/v1/ext/demo/pub/thing');
      expect(guarded.headers.get('x-guard')).toBe('user');
      const agentRoute = await app.request('/api/v1/ext/demo/agent/health');
      expect(agentRoute.headers.get('x-guard')).toBe('agent');
    });

    it('supports wildcard publicRoutes prefixes', async () => {
      scaffoldRuntimeExtension(root, { publicRoutes: ['/pub/*'] });
      const app = new Hono();
      await mountExtensions(app, root);

      const pub = await app.request('/api/v1/ext/demo/pub/thing');
      expect(pub.status).toBe(200);
      expect(pub.headers.get('x-guard')).toBeNull();

      const guarded = await app.request('/api/v1/ext/demo/health');
      expect(guarded.headers.get('x-guard')).toBe('user');
    });

    // The ctx-injected middlewares no-op only when the loader ALREADY ran the
    // SAME kind of auth. A boolean "loader authed" flag would make a mismatched
    // middleware silently evaporate — e.g. an extension applying
    // ctx.agentAuthMiddleware to a non-/agent/ route would get user auth
    // instead, with c.get('agent') undefined: an auth downgrade.
    it('applies core helperAuth to /helper/ routes when the manifest opts in via helperRoutes', async () => {
      scaffoldRuntimeExtension(
        root,
        { helperRoutes: true },
        `import { Hono } from 'hono';
         const ext = {
           register(ctx) {
             if (!ctx.helperAuthMiddleware) throw new Error('missing ctx.helperAuthMiddleware');
             const app = new Hono();
             app.get('/helper/health', (c) => c.json({ ok: true }));
             app.get('/health', (c) => c.json({ ok: true }));
             ctx.mountRoute(app);
           },
         };
         export default ext;`,
      );
      const app = new Hono();
      await mountExtensions(app, root);

      const helperRoute = await app.request('/api/v1/ext/demo/helper/health');
      expect(helperRoute.status).toBe(200);
      expect(helperRoute.headers.get('x-guard')).toBe('helper');

      // Everything outside /helper/ stays on the user default-deny.
      const userRoute = await app.request('/api/v1/ext/demo/health');
      expect(userRoute.headers.get('x-guard')).toBe('user');
    });

    it('keeps /helper/ routes on user auth when the manifest does NOT opt in', async () => {
      scaffoldRuntimeExtension(
        root,
        {},
        `import { Hono } from 'hono';
         const ext = {
           register(ctx) {
             const app = new Hono();
             app.get('/helper/health', (c) => c.json({ ok: true }));
             ctx.mountRoute(app);
           },
         };
         export default ext;`,
      );
      const app = new Hono();
      await mountExtensions(app, root);

      const res = await app.request('/api/v1/ext/demo/helper/health');
      expect(res.status).toBe(200);
      expect(res.headers.get('x-guard')).toBe('user');
    });

    it('no-ops a redundant ctx.helperAuthMiddleware when the loader already ran the SAME (helper) auth', async () => {
      scaffoldRuntimeExtension(
        root,
        { helperRoutes: true },
        `import { Hono } from 'hono';
         const ext = {
           register(ctx) {
             const app = new Hono();
             // Redundant belt-and-suspenders: the loader guard already applies
             // helper auth to /helper/ paths for this manifest.
             app.use('/helper/*', ctx.helperAuthMiddleware);
             app.get('/helper/thing', (c) => c.json({ ok: true }));
             ctx.mountRoute(app);
           },
         };
         export default ext;`,
      );
      const app = new Hono();
      await mountExtensions(app, root);

      const { helperAuth } = await import('../middleware/helperAuth');
      const res = await app.request('/api/v1/ext/demo/helper/thing');
      expect(res.status).toBe(200);
      // Core helper auth ran exactly ONCE (the loader's) — the extension's
      // redundant call was skipped by the kind-matched wrapper.
      expect(vi.mocked(helperAuth)).toHaveBeenCalledTimes(1);
    });

    it('runs the extension\'s ctx.agentAuthMiddleware on a non-/agent/ route (loader ran USER auth — kinds differ, must not be skipped)', async () => {
      scaffoldRuntimeExtension(
        root,
        {},
        `import { Hono } from 'hono';
         const ext = {
           register(ctx) {
             const app = new Hono();
             // Extension explicitly demands AGENT auth on a path the loader
             // default-denies with USER auth. Both must run — fail closed.
             app.use('/telemetry', ctx.agentAuthMiddleware);
             app.get('/telemetry', (c) => c.json({ ok: true }));
             ctx.mountRoute(app);
           },
         };
         export default ext;`,
      );
      const app = new Hono();
      await mountExtensions(app, root);

      const res = await app.request('/api/v1/ext/demo/telemetry');
      expect(res.status).toBe(200);
      // The loader's user guard ran AND the extension's agent middleware ran —
      // the header is overwritten by whichever ran last, so 'agent' proves the
      // extension's middleware was NOT silently skipped.
      expect(res.headers.get('x-guard')).toBe('agent');
    });

    it('no-ops a redundant ctx.authMiddleware when the loader already ran the SAME (user) auth', async () => {
      scaffoldRuntimeExtension(
        root,
        {},
        `import { Hono } from 'hono';
         const ext = {
           register(ctx) {
             const app = new Hono();
             // Redundant: the loader already applies user auth to this path.
             app.use('/thing', ctx.authMiddleware);
             app.get('/thing', (c) => c.json({ ok: true }));
             ctx.mountRoute(app);
           },
         };
         export default ext;`,
      );
      const app = new Hono();
      await mountExtensions(app, root);

      const { authMiddleware } = await import('../middleware/auth');
      const res = await app.request('/api/v1/ext/demo/thing');
      expect(res.status).toBe(200);
      // Core user auth ran exactly ONCE (the loader's) — the extension's
      // redundant call was skipped, so the per-IP/per-agent rate counters
      // inside core auth are not double-incremented.
      expect(vi.mocked(authMiddleware)).toHaveBeenCalledTimes(1);
    });

    it('throws when an extension calls ctx.mountRoute twice (second sub-app would shadow the first)', async () => {
      scaffoldRuntimeExtension(
        root,
        {},
        `import { Hono } from 'hono';
         const ext = {
           register(ctx) {
             const a = new Hono();
             a.get('/health', (c) => c.json({ ok: true }));
             ctx.mountRoute(a);
             const b = new Hono();
             b.get('/health', (c) => c.json({ shadowed: true }));
             ctx.mountRoute(b);
           },
         };
         export default ext;`,
      );
      await expect(mountExtensions(new Hono(), root)).rejects.toThrow(/more than one route app/);
    });

    it('does not register the rate-limit skip prefix when the extension never mounts routes', async () => {
      scaffoldRuntimeExtension(
        root,
        { agentRoutes: true },
        'const ext = { register(ctx) { /* declares agentRoutes but never calls ctx.mountRoute */ } }; export default ext;',
      );
      const app = new Hono();
      app.use('*', globalRateLimit({ limit: 1, windowSeconds: 60 }));
      app.get('/api/v1/ext/demo/agent/ping', (c) => c.json({ ok: true }));

      await mountExtensions(app, root);

      // No loader-wrapped /agent/ prefix exists, so the exemption was never
      // granted — the global limiter still applies to the namespace.
      expect((await app.request('/api/v1/ext/demo/agent/ping')).status).toBe(200);
      expect((await app.request('/api/v1/ext/demo/agent/ping')).status).toBe(429);
    });
  });

  describe('boot-time extension RLS assertion', () => {
    const tenancy = { orgCascadeDeleteTables: ['demo_items'] };

    async function mockRlsCatalog(rows: unknown[]) {
      const { db } = await import('../db');
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue(rows);
    }

    it('mounts when every declared table has RLS enabled + forced + at least one policy', async () => {
      scaffoldRuntimeExtension(root, { tenancy });
      await mockRlsCatalog([
        { table_name: 'demo_items', rls_enabled: true, rls_forced: true, policy_count: 2 },
      ]);
      const app = new Hono();
      await mountExtensions(app, root);
      expect((await app.request('/api/v1/ext/demo/health')).status).toBe(200);
    });

    it('fails the boot when a declared table does not exist', async () => {
      scaffoldRuntimeExtension(root, { tenancy });
      await mockRlsCatalog([]);
      await expect(mountExtensions(new Hono(), root)).rejects.toThrow(/demo_items.*does not exist/);
    });

    it('fails the boot when RLS is enabled but not forced', async () => {
      scaffoldRuntimeExtension(root, { tenancy });
      await mockRlsCatalog([
        { table_name: 'demo_items', rls_enabled: true, rls_forced: false, policy_count: 1 },
      ]);
      await expect(mountExtensions(new Hono(), root)).rejects.toThrow(/FORCE ROW LEVEL SECURITY/);
    });

    it('fails the boot when a declared table has zero policies', async () => {
      scaffoldRuntimeExtension(root, { tenancy });
      await mockRlsCatalog([
        { table_name: 'demo_items', rls_enabled: true, rls_forced: true, policy_count: 0 },
      ]);
      await expect(mountExtensions(new Hono(), root)).rejects.toThrow(/no RLS policies/);
    });

    it('checks every tenancy array, deduplicated', async () => {
      scaffoldRuntimeExtension(root, {
        tenancy: {
          orgCascadeDeleteTables: ['demo_items'],
          deviceCascadeDeleteTables: ['demo_items', 'demo_child'],
          deviceOrgDenormalizedTables: ['demo_events'],
          deviceOrgMoveDeleteTables: ['demo_moves'],
        },
      });
      await mockRlsCatalog([]);
      const err = await mountExtensions(new Hono(), root).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      for (const table of ['demo_items', 'demo_child', 'demo_events', 'demo_moves']) {
        expect(msg).toContain(`"${table}"`);
      }
      expect(msg.match(/demo_items/g)).toHaveLength(1); // deduped across arrays
    });

    // Regression guard for #2466. This previously asserted the OPPOSITE — that a
    // manifest declaring nothing skipped the DB probe entirely. That "no work to
    // do" shortcut WAS the vulnerability: an extension whose migration created
    // `demo_docs(org_id …)` and whose manifest simply omitted it took this exact
    // branch and shipped with no RLS check whatsoever. The probe must always run,
    // because the catalog — not the manifest — is what proves the table set.
    it('still probes the catalog when the manifest declares NO tenancy tables (#2466)', async () => {
      scaffoldRuntimeExtension(root); // tenancy: {}
      const { db } = await import('../db');
      await mountExtensions(new Hono(), root);
      // Two probes: the per-extension ownership scan, then the repo-wide
      // unaccounted-table reconciliation. Neither may be skipped.
      expect(db.execute).toHaveBeenCalledTimes(2);
    });
  });

  // #2466: the manifest is a claim by the policed party. These verdicts are what
  // reconcile it against the live catalog. (SQL validity is proven only by the
  // real-Postgres suite — see the mock's comment at the top of this file.)
  describe('undeclared extension tables (#2466)', () => {
    async function mockRlsCatalog(rows: unknown[]) {
      const { db } = await import('../db');
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue(rows);
    }

    const compliant = { relkind: 'r', rls_enabled: true, rls_forced: true, policy_count: 1 };
    const noTenantScope = { tenant_column_count: 0, tenant_fk_count: 0 };

    it('fails the boot on a prefixed table that exists but is declared nowhere', async () => {
      scaffoldRuntimeExtension(root); // declares nothing
      await mockRlsCatalog([
        { table_name: 'demo_docs', ...compliant, tenant_column_count: 1, tenant_fk_count: 0 },
      ]);
      await expect(mountExtensions(new Hono(), root)).rejects.toThrow(
        /"demo_docs" exists and is tenant-scoped.*declared in NO manifest tenancy array/s,
      );
    });

    it('fails the boot on an undeclared table even when it happens to have RLS', async () => {
      // RLS today is not the point — an undeclared table also gets no org-cascade
      // and no device-move handling, and nothing stops a later migration dropping
      // its policy with no tripwire watching.
      scaffoldRuntimeExtension(root);
      await mockRlsCatalog([
        { table_name: 'demo_lookup', ...compliant, ...noTenantScope },
      ]);
      await expect(mountExtensions(new Hono(), root)).rejects.toThrow(
        /"demo_lookup" exists but is declared nowhere.*nonTenantTables/s,
      );
    });

    it('passes when the extension opts a genuinely global table out via nonTenantTables', async () => {
      scaffoldRuntimeExtension(root, { tenancy: { nonTenantTables: ['demo_lookup'] } });
      await mockRlsCatalog([
        { table_name: 'demo_lookup', relkind: 'r', rls_enabled: false, rls_forced: false, policy_count: 0, ...noTenantScope },
      ]);
      const app = new Hono();
      await mountExtensions(app, root);
      expect((await app.request('/api/v1/ext/demo/health')).status).toBe(200);
    });

    // The opt-out must be VERIFIED, not trusted — otherwise it is a hole exactly
    // as wide as the one #2466 closes: "just call your tenant table global".
    it('fails the boot when a nonTenantTables entry actually carries a tenant column', async () => {
      scaffoldRuntimeExtension(root, { tenancy: { nonTenantTables: ['demo_docs'] } });
      await mockRlsCatalog([
        { table_name: 'demo_docs', relkind: 'r', rls_enabled: false, rls_forced: false, policy_count: 0, tenant_column_count: 1, tenant_fk_count: 0 },
      ]);
      await expect(mountExtensions(new Hono(), root)).rejects.toThrow(
        /"demo_docs" is declared in tenancy.nonTenantTables but carries a tenant column/,
      );
    });

    // TENANT_SCOPE_COLUMNS matches names the POLICED PARTY chooses. An extension
    // that calls the column `organization_id` sails straight past it — so the
    // FOREIGN KEY into a core tenant table is the load-bearing half of the
    // verification. Without this, the opt-out is a naming convention, not a check.
    it('fails the boot when a nonTenantTables entry has an FK into a core tenant table despite no matching column name', async () => {
      scaffoldRuntimeExtension(root, { tenancy: { nonTenantTables: ['demo_docs'] } });
      await mockRlsCatalog([
        // e.g. `organization_id uuid REFERENCES organizations(id)` — zero
        // TENANT_SCOPE_COLUMNS hits, but unmistakably tenant data.
        { table_name: 'demo_docs', relkind: 'r', rls_enabled: false, rls_forced: false, policy_count: 0, tenant_column_count: 0, tenant_fk_count: 1 },
      ]);
      await expect(mountExtensions(new Hono(), root)).rejects.toThrow(
        /"demo_docs" is declared in tenancy.nonTenantTables but has a FOREIGN KEY into a core tenant table/,
      );
    });

    // Postgres cannot apply RLS to a materialized view AT ALL, so there is no
    // declaration that makes one safe — a matview over tenant data is a physical
    // cross-tenant copy no policy can reach. Reject, don't merely scan.
    it('fails the boot on an extension-owned materialized view, even if declared', async () => {
      scaffoldRuntimeExtension(root, { tenancy: { nonTenantTables: ['demo_all'] } });
      await mockRlsCatalog([
        { table_name: 'demo_all', relkind: 'm', rls_enabled: false, rls_forced: false, policy_count: 0, ...noTenantScope },
      ]);
      await expect(mountExtensions(new Hono(), root)).rejects.toThrow(
        /"demo_all" is a materialized view, which Postgres cannot protect with RLS/,
      );
    });

    // The per-extension scan infers ownership from the `<name>_` prefix, but the
    // prefix is enforced only on manifest DECLARATIONS — never on the migration's
    // DDL. `CREATE TABLE documents (org_id uuid)` in extension `demo` matches no
    // prefix and is declared nowhere, reopening #2466 for the price of one word.
    // The repo-wide reconciliation catches it by elimination.
    it('fails the boot on an UNPREFIXED extension table that no manifest accounts for', async () => {
      scaffoldRuntimeExtension(root); // declares nothing; prefix is `demo_`
      await mockRlsCatalog([
        { table_name: 'documents', ...compliant, tenant_column_count: 1, tenant_fk_count: 1 },
      ]);
      await expect(mountExtensions(new Hono(), root)).rejects.toThrow(
        /belong to no core schema and to no extension manifest[\s\S]*documents/,
      );
    });

    it('fails the boot when a nonTenantTables entry does not exist', async () => {
      scaffoldRuntimeExtension(root, { tenancy: { nonTenantTables: ['demo_lookup'] } });
      await mockRlsCatalog([]);
      await expect(mountExtensions(new Hono(), root)).rejects.toThrow(
        /"demo_lookup" is declared in tenancy.nonTenantTables but does not exist/,
      );
    });

    // A tripwire's catastrophic failure mode is the SILENT PASS, not the crash.
    // postgres-js returns an array and node-postgres returns `{ rows }`; a
    // `?? []` fallback for anything else would hand this function zero rows,
    // which every check below reads as "owns nothing, declared nothing — all
    // clear". A driver swap could then disable the whole tripwire with no test
    // going red. Unreadable must mean "refuse to boot", never "all clear".
    it('fails the boot when the driver returns an unreadable result shape (never reads it as "all clear")', async () => {
      scaffoldRuntimeExtension(root);
      await mockRlsCatalog(undefined as unknown as unknown[]);
      await expect(mountExtensions(new Hono(), root)).rejects.toThrow(
        /could not read the catalog query result/,
      );
    });

    it('accepts the node-postgres { rows } result shape', async () => {
      scaffoldRuntimeExtension(root, { tenancy: { nonTenantTables: ['demo_lookup'] } });
      const { db } = await import('../db');
      (db.execute as ReturnType<typeof vi.fn>).mockResolvedValue({
        rows: [{ table_name: 'demo_lookup', relkind: 'r', rls_enabled: false, rls_forced: false, policy_count: 0, ...noTenantScope }],
      });
      await expect(mountExtensions(new Hono(), root)).resolves.toBeUndefined();
    });

    it('fails the boot when a nonTenantTables entry has unreadable tenant-scope counts', async () => {
      // `Number(undefined) > 0` is false — so a bare `> 0` would silently ratify
      // the opt-out. It must fail closed, like the policy_count check.
      scaffoldRuntimeExtension(root, { tenancy: { nonTenantTables: ['demo_lookup'] } });
      await mockRlsCatalog([
        { table_name: 'demo_lookup', relkind: 'r', rls_enabled: false, rls_forced: false, policy_count: 0 },
      ]);
      await expect(mountExtensions(new Hono(), root)).rejects.toThrow(
        /tenant-scope counts could not be read/,
      );
    });

    it('does not blame the extension for CORE tables that share its name prefix', async () => {
      // An extension may legally be named `device` — and core owns device_commands,
      // device_disks, and ~30 more. Without the core-schema subtraction this
      // extension would brick the boot over tables it never created, and the
      // operator's only lever is BREEZE_EXTENSIONS_ENABLED=false, which switches
      // off every tripwire including this one.
      const dir = join(root, 'device');
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(
        join(dir, 'breeze-extension.json'),
        JSON.stringify({ name: 'device', routeNamespace: 'device-ext', entry: 'src/index.ts', tenancy: {} }),
      );
      writeFileSync(
        join(dir, 'src', 'index.ts'),
        'const ext = { register() {} };\nexport default ext;',
      );
      await mockRlsCatalog([
        // Real core tables, returned by the prefix scan for prefix `device_`.
        { table_name: 'device_commands', ...compliant, tenant_column_count: 1 },
        { table_name: 'device_disks', ...compliant, tenant_column_count: 1 },
      ]);
      await expect(mountExtensions(new Hono(), root)).resolves.toBeUndefined();
    });
  });
});
