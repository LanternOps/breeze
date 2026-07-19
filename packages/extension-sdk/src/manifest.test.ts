import { describe, expect, it } from 'vitest';
import { SUPPORTED_EXTENSION_CAPABILITIES, parseExtensionManifestV1 } from './manifest';

const valid = {
  apiVersion: 'breeze.extensions/v1',
  name: 'demo',
  version: '1.2.0',
  routeNamespace: 'demo',
  requires: {
    breeze: '>=0.1.0 <0.2.0',
    serverSdk: '^1.0.0',
    webSdk: '^1.0.0',
    capabilities: ['server.routes.v1'],
  },
  server: { entry: 'server/index.cjs' },
  web: { entry: 'web/index.js', pages: [], navigation: [], slots: [] },
  migrationsDir: 'migrations',
  schemaCompatibilityFloor: '1.0.0',
  publicRoutes: [],
  agentRoutes: false,
  jobs: [],
  aiTools: [],
  tenancy: {
    orgCascadeDeleteTables: [],
    deviceCascadeDeleteTables: [],
    deviceOrgDenormalizedTables: [],
  },
};

describe('parseExtensionManifestV1', () => {
  it('accepts v1 and preserves per-slot contract versions', () => {
    const parsed = parseExtensionManifestV1({
      ...valid,
      web: { ...valid.web, slots: [{ slot: 'device.detail.tabs', contractVersion: 1, element: 'demo-device-tab' }] },
    });
    expect(parsed.web!.slots[0]).toEqual({ slot: 'device.detail.tabs', contractVersion: 1, element: 'demo-device-tab' });
  });

  it.each([
    ['wrong api', { ...valid, apiVersion: 'breeze.extensions/v2' }],
    ['native entry', { ...valid, server: { entry: 'server/addon.node' } }],
    ['blank floor', { ...valid, schemaCompatibilityFloor: '' }],
  ])('rejects %s', (_name, raw) => expect(() => parseExtensionManifestV1(raw)).toThrow());

  it('exports the exact supported capability contract', () => {
    expect(SUPPORTED_EXTENSION_CAPABILITIES).toEqual([
      'server.routes.v1',
      'server.agent-routes.v1',
      'server.jobs.v1',
      'server.ai-tools.v1',
      'server.db.rls.v1',
      'server.secrets.v1',
      'server.audit.v1',
      'web.pages.v1',
      'web.navigation.v1',
      'web.slots.v1',
    ]);
  });

  it('accepts a server-only manifest without webSdk', () => {
    const { web: _web, ...serverOnly } = valid;
    const parsed = parseExtensionManifestV1({
      ...serverOnly,
      requires: { ...valid.requires, webSdk: undefined },
    });
    expect(parsed.web).toBeUndefined();
    expect(parsed.requires.webSdk).toBeUndefined();
  });

  it('accepts any unique supported capabilities independently of contributions', () => {
    const { web: _web, ...serverOnly } = valid;
    const parsed = parseExtensionManifestV1({
      ...serverOnly,
      requires: {
        ...valid.requires,
        webSdk: undefined,
        capabilities: [...SUPPORTED_EXTENSION_CAPABILITIES],
      },
    });
    expect(parsed.requires.capabilities).toEqual(SUPPORTED_EXTENSION_CAPABILITIES);
  });

  it.each([
    ['unknown capability', { ...valid, requires: { ...valid.requires, capabilities: ['unknown.v1'] } }],
    ['duplicate capability', { ...valid, requires: { ...valid.requires, capabilities: ['server.routes.v1', 'server.routes.v1'] } }],
    ['missing web SDK', { ...valid, requires: { ...valid.requires, webSdk: undefined } }],
  ])('rejects invalid requirements: %s', (_name, raw) => {
    expect(() => parseExtensionManifestV1(raw)).toThrow();
  });

  it.each([
    '/server/index.js',
    '../server/index.js',
    'server/../index.js',
    'server\\index.js',
    'C:/server/index.js',
    'file:server/index.js',
    'server/index.ts',
    'server/addon.node',
  ])('rejects unsafe or non-JavaScript server entry %s', (entry) => {
    expect(() => parseExtensionManifestV1({ ...valid, server: { entry } })).toThrow();
  });

  it.each(['/migrations', '../migrations', 'db/../migrations', 'db\\migrations', 'C:/migrations', 'file:migrations'])('rejects unsafe migrations path %s', (migrationsDir) => {
    expect(() => parseExtensionManifestV1({ ...valid, migrationsDir })).toThrow();
  });

  it.each(['1', '1.0', '01.0.0', '1.0.0-01'])('rejects invalid semantic version %s', (version) => {
    expect(() => parseExtensionManifestV1({ ...valid, version })).toThrow();
  });

  it.each(['', 'not-a-range'])('rejects invalid SDK compatibility range %s', (serverSdk) => {
    expect(() => parseExtensionManifestV1({
      ...valid,
      requires: { ...valid.requires, serverSdk },
    })).toThrow();
  });

  it('accepts fully-described web contributions with matching capabilities', () => {
    const parsed = parseExtensionManifestV1({
      ...valid,
      requires: {
        ...valid.requires,
        capabilities: ['server.routes.v1', 'web.pages.v1', 'web.navigation.v1', 'web.slots.v1'],
      },
      web: {
        entry: 'web/index.mjs',
        pages: [{ id: 'demo.page', path: '/demo', element: 'demo-page' }],
        navigation: [{ id: 'demo.nav', label: 'Demo', path: '/demo', order: 10 }],
        slots: [{ id: 'demo.slot', slot: 'device.detail.tabs', contractVersion: 1, element: 'demo-tab', label: 'Demo', order: 5 }],
      },
    });
    expect(parsed.web?.navigation[0]?.order).toBe(10);
  });

  it.each([
    ['page', { pages: [{ path: '/demo', element: 'demopage' }] }],
    ['page path', { pages: [{ path: 'demo', element: 'demo-page' }] }],
    ['navigation label', { navigation: [{ label: '', path: '/demo' }] }],
    ['navigation order', { navigation: [{ label: 'Demo', path: '/demo', order: 1.5 }] }],
    ['slot version', { slots: [{ slot: 'device.detail.tabs', contractVersion: 0, element: 'demo-tab' }] }],
    ['slot element', { slots: [{ slot: 'device.detail.tabs', contractVersion: 1, element: 'Demo-Tab' }] }],
  ])('rejects invalid web %s descriptor', (_name, contribution) => {
    expect(() => parseExtensionManifestV1({
      ...valid,
      requires: {
        ...valid.requires,
        capabilities: ['web.pages.v1', 'web.navigation.v1', 'web.slots.v1'],
      },
      web: { ...valid.web, ...contribution },
    })).toThrow();
  });

  it('accepts job, AI tool, and agent-route declarations before host capability negotiation', () => {
    const parsed = parseExtensionManifestV1({
      ...valid,
      jobs: [{ name: 'cleanup', cron: '0 * * * *' }],
      aiTools: [{ name: 'lookup' }],
      agentRoutes: true,
    });
    expect(parsed.jobs[0]?.name).toBe('cleanup');
  });

  it.each([
    ['job', { jobs: [{ name: 'cleanup', cron: '* * * * *' }, { name: 'cleanup', cron: '0 * * * *' }] }],
    ['AI tool', { aiTools: [{ name: 'lookup' }, { name: 'lookup' }] }],
    ['page', { web: { ...valid.web, pages: [{ id: 'demo.page', path: '/one', element: 'demo-one' }, { id: 'demo.page', path: '/two', element: 'demo-two' }] } }],
    ['slot', { web: { ...valid.web, slots: [{ id: 'demo.slot', slot: 'one', contractVersion: 1, element: 'demo-one' }, { id: 'demo.slot', slot: 'two', contractVersion: 1, element: 'demo-two' }] } }],
  ])('rejects duplicate %s declarations', (_name, contribution) => {
    expect(() => parseExtensionManifestV1({
      ...valid,
      requires: {
        ...valid.requires,
        capabilities: ['server.jobs.v1', 'server.ai-tools.v1', 'web.pages.v1', 'web.slots.v1'],
      },
      ...contribution,
    })).toThrow();
  });

  it('preserves reserved namespaces, default-deny public routes, and tenancy prefix checks', () => {
    expect(() => parseExtensionManifestV1({ ...valid, routeNamespace: 'devices' })).toThrow();
    expect(() => parseExtensionManifestV1({ ...valid, routeNamespace: 'ext' })).toThrow();
    expect(() => parseExtensionManifestV1({ ...valid, routeNamespace: 'extensions' })).toThrow();
    // #2634 — auth-sensitive core mounts that shipped unreserved.
    expect(() => parseExtensionManifestV1({ ...valid, routeNamespace: 'service-principals' })).toThrow();
    expect(() => parseExtensionManifestV1({ ...valid, routeNamespace: 'partner-service-principals' })).toThrow();
    expect(() => parseExtensionManifestV1({ ...valid, routeNamespace: 'partner-api' })).toThrow();
    expect(() => parseExtensionManifestV1({ ...valid, publicRoutes: ['/*'] })).toThrow();
    expect(() => parseExtensionManifestV1({ ...valid, publicRoutes: ['/agent/hook'] })).toThrow();
    expect(() => parseExtensionManifestV1({
      ...valid,
      tenancy: { ...valid.tenancy, orgCascadeDeleteTables: ['other_items'] },
    })).toThrow(/demo_/);
  });

  it.each([
    '/foo/../agent/hook',
    '/foo/./health',
    '/../health',
    '/foo/..',
    '/foo/.',
  ])('rejects public routes containing traversal segment %s', (route) => {
    expect(() => parseExtensionManifestV1({ ...valid, publicRoutes: [route] })).toThrow();
  });

  it('allows dots inside non-traversal public-route segments', () => {
    const parsed = parseExtensionManifestV1({
      ...valid,
      publicRoutes: ['/health.json', '/.well-known/status'],
    });
    expect(parsed.publicRoutes).toEqual(['/health.json', '/.well-known/status']);
  });

  it('rejects unknown keys at every manifest level', () => {
    expect(() => parseExtensionManifestV1({ ...valid, unknown: true })).toThrow();
    expect(() => parseExtensionManifestV1({ ...valid, server: { ...valid.server, unknown: true } })).toThrow();
    expect(() => parseExtensionManifestV1({ ...valid, requires: { ...valid.requires, unknown: true } })).toThrow();
    expect(() => parseExtensionManifestV1({ ...valid, tenancy: { ...valid.tenancy, unknown: true } })).toThrow();
  });

  it('requires explicit contribution arrays in the v1 contract', () => {
    const { jobs: _jobs, ...withoutJobs } = valid;
    const { aiTools: _aiTools, ...withoutAiTools } = valid;
    const { pages: _pages, ...webWithoutPages } = valid.web;
    expect(() => parseExtensionManifestV1(withoutJobs)).toThrow();
    expect(() => parseExtensionManifestV1(withoutAiTools)).toThrow();
    expect(() => parseExtensionManifestV1({ ...valid, web: webWithoutPages })).toThrow();
  });
});
