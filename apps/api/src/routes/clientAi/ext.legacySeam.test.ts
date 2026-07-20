/**
 * END-TO-END seam test: legacy source-directory discovery → loader staging →
 * client-ai client-surface proxy.
 *
 * This is the assertion whose absence let a real defect through: the legacy
 * load path (`breeze-extension.json`, no `manifest.json`) synthesizes its v1
 * manifest from an explicit field allowlist, and `clientSurfaces` /
 * `clientPanels` were silently dropped — so the proxy read `undefined` and
 * every request 404'd while every unit test on both sides stayed green. This
 * suite stages a real fixture extension from disk through
 * `loadSourceExtensions` and proves a request actually crosses the proxy.
 *
 * It also pins the OTHER half of the contract: the legacy manifest must not be
 * a way to smuggle a declaration the v1 schema would reject (/agent, /helper,
 * blanket '/', dot segments, trailing slash) — those must fail discovery.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { getOrgPolicyMock } = vi.hoisted(() => ({ getOrgPolicyMock: vi.fn() }));

vi.mock('../../services/aiTools', () => {
  const aiTools = new Map();
  return {
    aiTools,
    hasCoreAiToolName: (name: string) => aiTools.has(name),
  };
});
vi.mock('../../db', () => ({
  db: { execute: vi.fn().mockResolvedValue([]), select: vi.fn() },
  withDbAccessContext: (_ctx: unknown, fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));
vi.mock('../../services/redis', () => ({ getRedis: () => null }));
vi.mock('../../services/clientIp', () => ({ getTrustedClientIp: () => 'legacy-seam-test' }));
vi.mock('../../services/auditService', () => ({ createAuditLogAsync: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/secretCrypto', () => ({
  encryptSecret: vi.fn((value: string) => `enc:${value}`),
  decryptForColumn: vi.fn((_t: string, _c: string, value: string) => value.split(':').at(-1)),
}));
vi.mock('../../middleware/agentAuth', () => ({ agentAuthMiddleware: vi.fn((_c: unknown, next: () => Promise<void>) => next()) }));
vi.mock('../../middleware/helperAuth', () => ({ helperAuth: vi.fn((_c: unknown, next: () => Promise<void>) => next()) }));
vi.mock('../../services/clientAiPolicy', () => ({
  getOrgPolicy: getOrgPolicyMock,
  isClientUserPermitted: () => true,
}));

const VALID_TOKEN = 'valid-session-token';
const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const CLIENT_USER_ID = 'beefbeef-1111-4222-8333-444455556666';

// Only the session-validation half is stubbed; the org-policy gate stays real,
// exactly as in ext.test.ts.
vi.mock('../../middleware/clientAiAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/clientAiAuth')>();
  return {
    ...actual,
    clientAiAuthMiddleware: vi.fn((c: any, next: any) => {
      if (c.req.header('authorization') !== `Bearer ${VALID_TOKEN}`) {
        return c.json({ error: 'Invalid or expired session' }, 401);
      }
      c.set('clientAiAuth', {
        clientUserId: CLIENT_USER_ID,
        orgId: ORG_ID,
        email: 'end.user@example.test',
        name: 'End User',
        token: VALID_TOKEN,
        partnerAiForOfficeEnabled: true,
      });
      return next();
    }),
  };
});

import { loadSourceExtensions } from '../../extensions/loader';
import { ExtensionContributionRegistry } from '../../extensions/contributionRegistry';
import { createClientAiExtRoutes, CLIENT_AI_EXT_MOUNT_PREFIX } from './ext';

const DECLARED_PANELS = [
  {
    host: 'client-ai',
    surface: 'panel.main',
    element: 'fixture-ext-panel',
    module: 'web/panel.js',
  },
];

/**
 * Stage a LEGACY fixture extension: `breeze-extension.json` ONLY — no
 * `manifest.json`, no packed bundle — declaring both client contribution keys.
 */
function scaffoldLegacyFixture(root: string, manifestOverrides: Record<string, unknown> = {}): void {
  const dir = join(root, 'fixture-ext');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(
    join(dir, 'breeze-extension.json'),
    JSON.stringify({
      name: 'fixture-ext',
      routeNamespace: 'fixture-ext',
      entry: 'src/index.ts',
      tenancy: {},
      clientSurfaces: [{ pathPrefix: '/client' }],
      clientPanels: DECLARED_PANELS,
      ...manifestOverrides,
    }),
  );
  writeFileSync(
    join(dir, 'src', 'index.ts'),
    `import { Hono } from 'hono';
     const ext = {
       register(ctx) {
         const app = new Hono();
         app.get('/client/hello', (c) => c.json({ ok: true, via: 'legacy', authed: Boolean(c.get('auth')) }));
         app.get('/internal/secret', (c) => c.json({ leaked: true }));
         ctx.mountRoute(app);
       },
     };
     export default ext;`,
  );
}

async function loadFixture(root: string): Promise<ExtensionContributionRegistry> {
  const registry = new ExtensionContributionRegistry();
  await loadSourceExtensions(registry, root);
  return registry;
}

function buildProxyApp(registry: ExtensionContributionRegistry): Hono {
  const app = new Hono();
  app.route(
    CLIENT_AI_EXT_MOUNT_PREFIX,
    createClientAiExtRoutes({
      registry: { get: (name: string) => registry.get(name) },
      isEnabled: async () => true,
    }),
  );
  return app;
}

function proxied(path: string): [string, RequestInit] {
  return [
    `http://local.test${CLIENT_AI_EXT_MOUNT_PREFIX}${path}`,
    { headers: { authorization: `Bearer ${VALID_TOKEN}` } },
  ];
}

describe('legacy load path → client-surface proxy (end to end)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'breeze-ext-legacy-seam-'));
    vi.stubEnv('BREEZE_LEGACY_SOURCE_EXTENSIONS', 'true');
    getOrgPolicyMock.mockResolvedValue({
      orgId: ORG_ID, enabled: true, userAccess: 'all', selectedUserIds: [],
    });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('a legacy-declared clientSurface is reachable through the proxy', async () => {
    scaffoldLegacyFixture(root);
    const registry = await loadFixture(root);
    const app = buildProxyApp(registry);

    const res = await app.request(...proxied('/fixture-ext/client/hello'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, via: 'legacy', authed: true });
  });

  it('a path outside the declared prefix still 404s', async () => {
    scaffoldLegacyFixture(root);
    const registry = await loadFixture(root);
    const app = buildProxyApp(registry);

    const res = await app.request(...proxied('/fixture-ext/internal/secret'));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: 'extension_surface_not_found' });
  });

  it('carries clientPanels through to the activated manifest, verbatim', async () => {
    scaffoldLegacyFixture(root);
    const registry = await loadFixture(root);

    const active = registry.get('fixture-ext');
    expect(active?.manifest.clientSurfaces).toEqual([{ pathPrefix: '/client' }]);
    expect(active?.manifest.clientPanels).toEqual(DECLARED_PANELS);
  });

  // The legacy path must enforce the SAME refusals as the v1 schema — a
  // legacy manifest is not a side door for a prefix v1 would reject.
  const rejectedSurfaces: Array<[string, string]> = [
    ['/agent/x', 'reserved /agent namespace'],
    ['/helper', 'reserved /helper namespace'],
    ['/', 'blanket the whole namespace'],
    ['/client/', 'trailing slash'],
    ['/client/../agent', 'dot segments'],
  ];
  for (const [pathPrefix, label] of rejectedSurfaces) {
    it(`refuses a legacy clientSurfaces pathPrefix with ${label} ("${pathPrefix}")`, async () => {
      scaffoldLegacyFixture(root, { clientSurfaces: [{ pathPrefix }] });
      await expect(loadFixture(root)).rejects.toThrow(/invalid manifest/);
    });
  }

  it('refuses a legacy clientPanels element that is not a custom-element name', async () => {
    scaffoldLegacyFixture(root, {
      clientPanels: [{ host: 'client-ai', surface: 'panel.main', element: 'div', module: 'web/panel.js' }],
    });
    await expect(loadFixture(root)).rejects.toThrow(/invalid manifest/);
  });

  it('refuses a legacy clientPanels module path that traverses parents', async () => {
    scaffoldLegacyFixture(root, {
      clientPanels: [{ host: 'client-ai', surface: 'panel.main', element: 'fixture-ext-panel', module: '../../evil.js' }],
    });
    await expect(loadFixture(root)).rejects.toThrow(/invalid manifest/);
  });
});
