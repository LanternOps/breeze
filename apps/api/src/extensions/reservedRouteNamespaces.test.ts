import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RESERVED_ROUTE_NAMESPACES, parseExtensionManifestV1 } from '@breeze/extension-sdk';

/**
 * Lives in apps/api rather than packages/extension-sdk because its ground
 * truth IS apps/api/src/index.ts: the reserved set is only correct relative to
 * the core mounts in this file, and the SDK package has no Node type surface
 * (or reason) to read it.
 */
const validManifest = {
  apiVersion: 'breeze.extensions/v1',
  name: 'sample',
  version: '1.0.0',
  routeNamespace: 'sample',
  requires: { breeze: '>=1.0.0', serverSdk: '^1.0.0', capabilities: [] },
  server: { entry: 'server/index.cjs' },
  migrationsDir: 'migrations',
  schemaCompatibilityFloor: '1.0.0',
  jobs: [],
  aiTools: [],
  tenancy: {
    orgCascadeDeleteTables: ['sample_items'],
    orgExportColumns: { sample_items: { include: ['id'], exclude: [] } },
    deviceCascadeDeleteTables: [],
    deviceOrgDenormalizedTables: [],
  },
};

describe('RESERVED_ROUTE_NAMESPACES', () => {
  // Ground truth is DERIVED from apps/api/src/index.ts at test time rather
  // than hand-maintained (#2635), so a core mount added without reserving it
  // fails this suite automatically.
  //
  // KNOWN BLIND SPOTS — two mount styles declare their paths in another file,
  // so this single-file derivation cannot see them:
  //
  //   1. `api.route('/', subRouter)` — the sub-router declares its OWN
  //      top-level segments. Reserved by hand and pinned by the root-mount
  //      tripwire below.
  //   2. `mountX(app)` helper-function mounts — 2 today
  //      (`mountInviteLandingRoutes`, `mountExtensionGateway`), neither of
  //      which adds a `/api/v1/<ns>` top-level segment. NOT tripwired; a new
  //      helper that mounts under /api/v1 would escape this test, so reserve
  //      its namespace by hand.
  const API_INDEX = fileURLToPath(
    new URL('../index.ts', import.meta.url),
  );

  const source = readFileSync(API_INDEX, 'utf8');

  // Matches are anchored to statement position (`^\s*`), which excludes
  // commented-out mounts by construction — no comment stripping needed, and
  // no risk of a stray `/*` in a route pattern eating real code.
  // Mounts on the versioned router: api.route('/devices', …) → /api/v1/devices
  const INNER_MOUNT_RE = /^\s*api\.route\(\s*['"`]\/([a-z0-9-]+)/gm;
  // Mounts placed directly on the outer app under the same prefix:
  // app.route('/api/v1/oauth', …) → oauth
  const OUTER_MOUNT_RE = /^\s*app\.route\(\s*['"`]\/api\/v1\/([a-z0-9-]+)/gm;
  // api.route('/', subRouter) — see the blind-spot note above. Captures the
  // router identifier so the tripwire pins identity, not just a count.
  const ROOT_MOUNT_RE = /^\s*api\.route\(\s*['"`]\/['"`]\s*,\s*([A-Za-z0-9_]+)/gm;

  function deriveCoreNamespaces(): string[] {
    const namespaces = new Set<string>();
    for (const m of source.matchAll(INNER_MOUNT_RE)) namespaces.add(m[1]!);
    for (const m of source.matchAll(OUTER_MOUNT_RE)) namespaces.add(m[1]!);
    return [...namespaces].sort();
  }

  const coreNamespaces = deriveCoreNamespaces();

  it('derives the core mount list from apps/api/src/index.ts', () => {
    // Guards against the derivation silently matching nothing or only part of
    // the file (moved file, renamed router, changed mount style) and passing
    // vacuously. Keep the floor just under the real count.
    expect(coreNamespaces.length).toBeGreaterThan(110);
    expect(coreNamespaces).toContain('devices');
    expect(coreNamespaces).toContain('service-principals');
  });

  it('pins which sub-routers are root-mounted where the derivation cannot see them', () => {
    // Tripwire for the blind spot documented above. Pinning the identifiers
    // rather than a count means swapping one root-mounted router for another
    // still fails, instead of passing on an unchanged total.
    //
    // Resolved top-level segments (all reserved):
    //   externalServicesRoutes        → billing, support
    //   invoiceAssemblyRoutes         → orgs, tickets
    //   invoiceSettingsRoutes         → orgs, partner
    //   ticketResponseTemplateRoutes  → ticket-response-templates
    //   ticketFormRoutes              → ticket-forms
    //   lifecycleRoutes               → me
    //   lifecycleAdminRoutes          → admin
    //   m365CallbackRoute             → c2c
    //   tenantVariableRoutes          → tenant-variables
    // If this list changes, open the new sub-router, resolve its top-level
    // segments by hand, and add them to RESERVED_ROUTE_NAMESPACES.
    const rootMounts = [...source.matchAll(ROOT_MOUNT_RE)].map((m) => m[1]!).sort();
    expect(rootMounts).toEqual([
      'externalServicesRoutes',
      'invoiceAssemblyRoutes',
      'invoiceSettingsRoutes',
      'lifecycleAdminRoutes',
      'lifecycleRoutes',
      'm365CallbackRoute',
      'tenantVariableRoutes',
      'ticketFormRoutes',
      'ticketResponseTemplateRoutes',
    ]);
  });

  it.each([
    'billing',
    'support',
    'tenant-variables',
    'ticket-forms',
    'ticket-response-templates',
  ])('reserves and rejects root-mounted sub-router namespace %s', (namespace) => {
    expect(RESERVED_ROUTE_NAMESPACES.has(namespace)).toBe(true);
    expect(() => parseExtensionManifestV1({ ...validManifest, routeNamespace: namespace })).toThrow();
  });

  it('reserves every core /api/v1 route namespace', () => {
    const missing = coreNamespaces.filter((ns) => !RESERVED_ROUTE_NAMESPACES.has(ns));
    expect(missing).toEqual([]);
  });

  it.each([
    'service-principals',
    'partner-service-principals',
    'partner-api',
  ])('rejects core auth surface %s as a routeNamespace', (namespace) => {
    // Regression guard for #2634 — these three shipped unreserved, letting an
    // installed+enabled extension shadow auth-sensitive core endpoints.
    expect(RESERVED_ROUTE_NAMESPACES.has(namespace)).toBe(true);
    expect(() => parseExtensionManifestV1({ ...validManifest, routeNamespace: namespace })).toThrow();
  });
});
