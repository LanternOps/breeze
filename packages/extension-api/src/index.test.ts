import { describe, it, expect } from 'vitest';
import {
  parseExtensionManifest,
  parseExtensionManifestV1,
  RESERVED_ROUTE_NAMESPACES,
  SUPPORTED_EXTENSION_CAPABILITIES,
} from './index';

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
  // Hand-maintained contract. Regenerate the inner-mount list with:
  //   grep -oE "api\.route\('/[a-z0-9-]+" apps/api/src/index.ts
  // That yields the 111 `/api/v1/*` mounts inside the versioned router. Add
  // the outer-app mounts that don't go through that router: `oauth`,
  // `settings` (both mounted directly on the outer Hono app), and the
  // shortlink prefix `s` (`app.route('/s', publicShortLinkRoutes)`).
  const CORE_NAMESPACES = [
    'access-reviews', 'accounting', 'admin', 'agent-versions', 'agent-ws',
    'agents', 'ai', 'alert-templates', 'alerts', 'analytics', 'api-keys',
    'audit-baselines', 'audit-logs', 'auth', 'authenticator', 'automations',
    'backup', 'browser-security', 'c2c', 'catalog', 'changes', 'cis',
    'client-ai', 'config', 'configuration-policies', 'contracts',
    'custom-fields', 'deployments', 'desktop-ws', 'dev', 'device-groups',
    'devices', 'discovery', 'dns-security', 'docs', 'dr', 'enrollment-keys',
    'events', 'ext', 'extensions', 'filters', 'google', 'groups', 'helper',
    'huntress',
    'incidents', 'installer', 'integrations', 'internal', 'invoices', 'logs',
    'm365', 'maintenance', 'mcp', 'me', 'metrics', 'mobile', 'monitoring',
    'monitors', 'network', 'notifications', 'oauth', 'onedrive', 'orgs',
    'pam', 'partner', 'partners', 'patch-policies', 'patches', 'pax8',
    'peripherals', 'permissions', 'playbooks', 'plugins', 'policies',
    'portal', 'psa', 'quotes', 'reliability', 'remediation-suggestions',
    'remote', 'reports', 'roles', 's', 's1', 'script-library', 'scripts',
    'search', 'security', 'sensitive-data', 'settings', 'snmp', 'software',
    'software-inventory', 'software-policies', 'sso', 'system',
    'system-tools', 'tags', 'third-party-catalog', 'ticket-categories',
    'ticket-config', 'tickets', 'time-entries', 'tunnel-http', 'tunnel-ws',
    'tunnels', 'unifi', 'update-rings', 'user-risk', 'users', 'viewers',
    'vnc-exchange', 'vnc-viewer', 'vulnerabilities', 'webhooks',
  ];

  it('has exactly 116 entries in the ground-truth contract', () => {
    expect(CORE_NAMESPACES).toHaveLength(116);
  });

  it('reserves every core /api/v1 route namespace', () => {
    const missing = CORE_NAMESPACES.filter((ns) => !RESERVED_ROUTE_NAMESPACES.has(ns));
    expect(missing).toEqual([]);
  });
});
