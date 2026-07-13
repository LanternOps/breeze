import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../services/aiTools', () => ({ aiTools: new Map() }));
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

import { mountExtensions } from './loader';
import { __resetSkipPrefixesForTests, globalRateLimit } from '../middleware/globalRateLimit';

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

  describe('default-deny auth guard', () => {
    it('applies core authMiddleware to non-agent routes and agentAuthMiddleware to /agent/ routes', async () => {
      scaffoldRuntimeExtension(root);
      const app = new Hono();
      await mountExtensions(app, root);

      const userRoute = await app.request('/api/v1/demo/health');
      expect(userRoute.status).toBe(200);
      expect(userRoute.headers.get('x-guard')).toBe('user');

      const agentRoute = await app.request('/api/v1/demo/agent/health');
      expect(agentRoute.status).toBe(200);
      expect(agentRoute.headers.get('x-guard')).toBe('agent');
    });

    it('skips core auth only for manifest-declared publicRoutes (exact match)', async () => {
      scaffoldRuntimeExtension(root, { publicRoutes: ['/health'] });
      const app = new Hono();
      await mountExtensions(app, root);

      const publicRoute = await app.request('/api/v1/demo/health');
      expect(publicRoute.status).toBe(200);
      expect(publicRoute.headers.get('x-guard')).toBeNull();

      // Everything not listed stays behind core auth.
      const guarded = await app.request('/api/v1/demo/pub/thing');
      expect(guarded.headers.get('x-guard')).toBe('user');
      const agentRoute = await app.request('/api/v1/demo/agent/health');
      expect(agentRoute.headers.get('x-guard')).toBe('agent');
    });

    it('supports wildcard publicRoutes prefixes', async () => {
      scaffoldRuntimeExtension(root, { publicRoutes: ['/pub/*'] });
      const app = new Hono();
      await mountExtensions(app, root);

      const pub = await app.request('/api/v1/demo/pub/thing');
      expect(pub.status).toBe(200);
      expect(pub.headers.get('x-guard')).toBeNull();

      const guarded = await app.request('/api/v1/demo/health');
      expect(guarded.headers.get('x-guard')).toBe('user');
    });

    // The ctx-injected middlewares no-op only when the loader ALREADY ran the
    // SAME kind of auth. A boolean "loader authed" flag would make a mismatched
    // middleware silently evaporate — e.g. an extension applying
    // ctx.agentAuthMiddleware to a non-/agent/ route would get user auth
    // instead, with c.get('agent') undefined: an auth downgrade.
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

      const res = await app.request('/api/v1/demo/telemetry');
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
      const res = await app.request('/api/v1/demo/thing');
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
      await expect(mountExtensions(new Hono(), root)).rejects.toThrow(/mountRoute more than once/);
    });

    it('does not register the rate-limit skip prefix when the extension never mounts routes', async () => {
      scaffoldRuntimeExtension(
        root,
        { agentRoutes: true },
        'const ext = { register(ctx) { /* declares agentRoutes but never calls ctx.mountRoute */ } }; export default ext;',
      );
      const app = new Hono();
      app.use('*', globalRateLimit({ limit: 1, windowSeconds: 60 }));
      app.get('/api/v1/demo/agent/ping', (c) => c.json({ ok: true }));

      await mountExtensions(app, root);

      // No loader-wrapped /agent/ prefix exists, so the exemption was never
      // granted — the global limiter still applies to the namespace.
      expect((await app.request('/api/v1/demo/agent/ping')).status).toBe(200);
      expect((await app.request('/api/v1/demo/agent/ping')).status).toBe(429);
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
      expect((await app.request('/api/v1/demo/health')).status).toBe(200);
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
      expect(db.execute).toHaveBeenCalledTimes(1);
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

    const compliant = { rls_enabled: true, rls_forced: true, policy_count: 1 };

    it('fails the boot on a prefixed table that exists but is declared nowhere', async () => {
      scaffoldRuntimeExtension(root); // declares nothing
      await mockRlsCatalog([
        { table_name: 'demo_docs', ...compliant, tenant_column_count: 1 },
      ]);
      await expect(mountExtensions(new Hono(), root)).rejects.toThrow(
        /"demo_docs" exists and carries a tenant column.*declared in NO manifest tenancy array/s,
      );
    });

    it('fails the boot on an undeclared table even when it happens to have RLS', async () => {
      // RLS today is not the point — an undeclared table also gets no org-cascade
      // and no device-move handling, and nothing stops a later migration dropping
      // its policy with no tripwire watching.
      scaffoldRuntimeExtension(root);
      await mockRlsCatalog([
        { table_name: 'demo_lookup', ...compliant, tenant_column_count: 0 },
      ]);
      await expect(mountExtensions(new Hono(), root)).rejects.toThrow(
        /"demo_lookup" exists but is declared nowhere.*nonTenantTables/s,
      );
    });

    it('passes when the extension opts a genuinely global table out via nonTenantTables', async () => {
      scaffoldRuntimeExtension(root, { tenancy: { nonTenantTables: ['demo_lookup'] } });
      await mockRlsCatalog([
        { table_name: 'demo_lookup', rls_enabled: false, rls_forced: false, policy_count: 0, tenant_column_count: 0 },
      ]);
      const app = new Hono();
      await mountExtensions(app, root);
      expect((await app.request('/api/v1/demo/health')).status).toBe(200);
    });

    // The opt-out must be VERIFIED, not trusted — otherwise it is a hole exactly
    // as wide as the one #2466 closes: "just call your tenant table global".
    it('fails the boot when a nonTenantTables entry actually carries a tenant column', async () => {
      scaffoldRuntimeExtension(root, { tenancy: { nonTenantTables: ['demo_docs'] } });
      await mockRlsCatalog([
        { table_name: 'demo_docs', rls_enabled: false, rls_forced: false, policy_count: 0, tenant_column_count: 1 },
      ]);
      await expect(mountExtensions(new Hono(), root)).rejects.toThrow(
        /"demo_docs" is declared in tenancy.nonTenantTables but carries a tenant column/,
      );
    });

    it('fails the boot when a nonTenantTables entry does not exist', async () => {
      scaffoldRuntimeExtension(root, { tenancy: { nonTenantTables: ['demo_lookup'] } });
      await mockRlsCatalog([]);
      await expect(mountExtensions(new Hono(), root)).rejects.toThrow(
        /"demo_lookup" is declared in tenancy.nonTenantTables but does not exist/,
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
