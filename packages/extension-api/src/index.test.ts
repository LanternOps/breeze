import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  parseExtensionManifest,
  parseExtensionManifestV1,
  RESERVED_ROUTE_NAMESPACES,
  SUPPORTED_EXTENSION_CAPABILITIES,
} from './index';
import { RESERVED_ROUTE_NAMESPACES as LEGACY_RESERVED_ROUTE_NAMESPACES } from './legacy';

describe('versioned SDK adapter', () => {
  it('re-exports the v1 SDK alongside legacy names', () => {
    expect(parseExtensionManifestV1).toBeTypeOf('function');
    expect(SUPPORTED_EXTENSION_CAPABILITIES).toContain('server.routes.v1');
    expect(parseExtensionManifest).not.toBe(parseExtensionManifestV1);
  });
});

describe('parseExtensionManifest', () => {
  const valid = {
    name: 'sample',
    routeNamespace: 'sample',
    entry: 'src/index.ts',
    migrationsDir: 'migrations',
    tenancy: {
      orgCascadeDeleteTables: ['sample_items'],
      deviceOrgDenormalizedTables: ['sample_events'],
    },
  };

  it('accepts a valid manifest and applies defaults', () => {
    const m = parseExtensionManifest({ ...valid, migrationsDir: undefined });
    expect(m.name).toBe('sample');
    expect(m.migrationsDir).toBe('migrations'); // default
    expect(m.tenancy.deviceCascadeDeleteTables).toEqual([]); // default
    expect(m.tenancy.deviceOrgMoveDeleteTables).toBeUndefined(); // optional
  });

  it('accepts agentRoutes and deviceOrgMoveDeleteTables', () => {
    const m = parseExtensionManifest({
      name: 'demo', routeNamespace: 'demo', entry: 'src/index.ts',
      agentRoutes: true,
      tenancy: { deviceOrgMoveDeleteTables: ['demo_things'] },
    });
    expect(m.agentRoutes).toBe(true);
    expect(m.tenancy.deviceOrgMoveDeleteTables).toEqual(['demo_things']);
  });

  it('accepts helperRoutes flag', () => {
    const m = parseExtensionManifest({
      name: 'demo', routeNamespace: 'demo', entry: 'src/index.ts',
      helperRoutes: true,
      tenancy: {},
    });
    expect(m.helperRoutes).toBe(true);
  });

  it('defaults helperRoutes to false', () => {
    const m = parseExtensionManifest({
      name: 'demo', routeNamespace: 'demo', entry: 'src/index.ts',
      tenancy: {},
    });
    expect(m.helperRoutes).toBe(false);
  });

  it('rejects unprefixed tables in deviceOrgMoveDeleteTables', () => {
    expect(() => parseExtensionManifest({
      name: 'demo', routeNamespace: 'demo', entry: 'src/index.ts',
      tenancy: { deviceOrgMoveDeleteTables: ['other_things'] },
    })).toThrow(/demo_/);
  });

  it('rejects invalid names (uppercase, spaces, leading digit, "plugins")', () => {
    for (const name of ['Sample', 'sample name', '1sample', 'plugins']) {
      expect(() => parseExtensionManifest({ ...valid, name })).toThrow();
    }
  });

  it('reports invalid names with a human-readable validation message', () => {
    expect(() => parseExtensionManifest({ ...valid, name: 'NOT VALID' })).toThrow(
      expect.objectContaining({
        message: expect.stringMatching(/name|pattern/i),
      })
    );

    try {
      parseExtensionManifest({ ...valid, name: 'NOT VALID' });
    } catch (err) {
      expect((err as Error).message).not.toContain('"code":');
    }
  });

  it('rejects a routeNamespace that collides with core mounts', () => {
    for (const ns of ['plugins', 'devices', 'auth', 'ai', 'mcp', 'ext']) {
      expect(() => parseExtensionManifest({ ...valid, routeNamespace: ns })).toThrow();
    }
  });

  it('accepts publicRoutes with exact paths and prefix wildcards', () => {
    const m = parseExtensionManifest({ ...valid, publicRoutes: ['/health', '/webhooks/*'] });
    expect(m.publicRoutes).toEqual(['/health', '/webhooks/*']);
    expect(parseExtensionManifest(valid).publicRoutes).toBeUndefined();
  });

  it('rejects publicRoutes under /agent/ — they must stay behind agentAuthMiddleware', () => {
    for (const route of ['/agent', '/agent/hook', '/agent/*']) {
      expect(() => parseExtensionManifest({ ...valid, publicRoutes: [route] })).toThrow(/agent/i);
    }
  });

  it('rejects publicRoutes under /helper/ — they must stay behind core helper auth', () => {
    for (const route of ['/helper', '/helper/search', '/helper/*']) {
      expect(() => parseExtensionManifest({ ...valid, publicRoutes: [route] })).toThrow(/helper/i);
    }
  });

  it('rejects blanket and malformed publicRoutes', () => {
    for (const route of ['/', '/*', 'health', 'webhooks/*', '/spaced path']) {
      expect(() => parseExtensionManifest({ ...valid, publicRoutes: [route] })).toThrow();
    }
  });

  // #2466 — the opt-out that lets a genuinely global extension table exist
  // without RLS. It must be as prefix-disciplined as any other declaration: the
  // loader decides which live tables an extension OWNS purely from the `<name>_`
  // prefix, so an unprefixed entry names a table the tripwire can never find.
  it('accepts nonTenantTables and defaults it to undefined', () => {
    const m = parseExtensionManifest({
      ...valid,
      tenancy: { ...valid.tenancy, nonTenantTables: ['sample_catalog'] },
    });
    expect(m.tenancy.nonTenantTables).toEqual(['sample_catalog']);
    expect(parseExtensionManifest(valid).tenancy.nonTenantTables).toBeUndefined();
  });

  it('rejects unprefixed tables in nonTenantTables', () => {
    expect(() => parseExtensionManifest({
      ...valid,
      tenancy: { nonTenantTables: ['some_global_table'] },
    })).toThrow(/must be prefixed/);
  });

  it('rejects a table declared BOTH tenant-scoped and nonTenant', () => {
    // Unsatisfiable: the loader would demand RLS on it (as a tenant table) and
    // simultaneously demand it carry no tenant column (as a nonTenantTable).
    expect(() => parseExtensionManifest({
      ...valid,
      tenancy: {
        orgCascadeDeleteTables: ['sample_items'],
        nonTenantTables: ['sample_items'],
      },
    })).toThrow(/BOTH a tenancy array and tenancy.nonTenantTables/);
  });

  it('rejects table names not starting with the extension name prefix, except memory_blocks', () => {
    expect(() =>
      parseExtensionManifest({
        ...valid,
        tenancy: { orgCascadeDeleteTables: ['devices'] },
      })
    ).toThrow(/must be prefixed/);
    // memory_blocks is a deliberately shared cross-extension table — allowlisted
    expect(() =>
      parseExtensionManifest({
        ...valid,
        tenancy: { orgCascadeDeleteTables: ['memory_blocks'] },
      })
    ).not.toThrow();
  });
});

describe('RESERVED_ROUTE_NAMESPACES', () => {
  // Ground truth is DERIVED from apps/api/src/index.ts at test time, not
  // hand-maintained (#2635). A core mount added without reserving it fails
  // this suite automatically — there is no list to keep in sync.
  const API_INDEX = fileURLToPath(
    new URL('../../../apps/api/src/index.ts', import.meta.url),
  );

  const validManifest = {
    name: 'sample',
    routeNamespace: 'sample',
    entry: 'src/index.ts',
    migrationsDir: 'migrations',
    tenancy: { orgCascadeDeleteTables: ['sample_items'] },
  };

  /** Strip comments so a commented-out mount is not read as a live one. */
  function stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

  function deriveCoreNamespaces(): string[] {
    const source = stripComments(readFileSync(API_INDEX, 'utf8'));
    const namespaces = new Set<string>();
    // Mounts on the versioned router: api.route('/devices', …) → /api/v1/devices
    for (const m of source.matchAll(/\bapi\.route\(\s*'\/([a-z0-9-]+)/g)) {
      namespaces.add(m[1]);
    }
    // Mounts placed directly on the outer app under the same prefix:
    // app.route('/api/v1/oauth', …) → oauth
    for (const m of source.matchAll(/\bapp\.route\(\s*'\/api\/v1\/([a-z0-9-]+)/g)) {
      namespaces.add(m[1]);
    }
    return [...namespaces].sort();
  }

  const coreNamespaces = deriveCoreNamespaces();

  it('derives the core mount list from apps/api/src/index.ts', () => {
    // Guards against the derivation silently matching nothing (moved file,
    // renamed router, changed mount style) and passing vacuously.
    expect(coreNamespaces.length).toBeGreaterThan(100);
    expect(coreNamespaces).toContain('devices');
    expect(coreNamespaces).toContain('service-principals');
  });

  it('reserves every core /api/v1 route namespace', () => {
    const missing = coreNamespaces.filter((ns) => !RESERVED_ROUTE_NAMESPACES.has(ns));
    expect(missing).toEqual([]);
  });

  it('keeps the extension-sdk and legacy reserved sets identical', () => {
    // Both sets gate routeNamespace validation on their own code path, so a
    // namespace reserved in only one of them is still hijackable via the other.
    expect([...LEGACY_RESERVED_ROUTE_NAMESPACES].sort())
      .toEqual([...RESERVED_ROUTE_NAMESPACES].sort());
  });

  it.each([
    'service-principals',
    'partner-service-principals',
    'partner-api',
  ])('rejects core auth surface %s as a routeNamespace', (namespace) => {
    // Regression guard for #2634 — these three shipped unreserved, letting an
    // installed+enabled extension shadow auth-sensitive core endpoints.
    expect(RESERVED_ROUTE_NAMESPACES.has(namespace)).toBe(true);
    expect(() => parseExtensionManifest({ ...validManifest, routeNamespace: namespace }))
      .toThrow();
  });
});
