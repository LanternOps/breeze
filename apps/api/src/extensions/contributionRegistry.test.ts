import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { Hono } from 'hono';
import type {
  ExtensionAiTool,
  ExtensionJobDefinition,
  ExtensionManifestV1,
} from '@breeze/extension-sdk';

import {
  ExtensionContributionRegistry,
  type RegistryAiTool,
  type PublishedExtensionRouteApp,
  type StagedExtensionContributions,
} from './contributionRegistry';

function makeManifest(
  name = 'demo',
  version = '1.0.0',
  declarations: { jobs?: readonly string[]; aiTools?: readonly string[] } = {},
): ExtensionManifestV1 {
  return {
    apiVersion: 'breeze.extensions/v1',
    name,
    version,
    routeNamespace: name,
    requires: {
      breeze: '>=1.0.0',
      serverSdk: '^1.0.0',
      capabilities: [],
    },
    server: { entry: 'dist/server.js' },
    migrationsDir: 'migrations',
    schemaCompatibilityFloor: '1.0.0',
    jobs: (declarations.jobs ?? []).map((jobName) => ({ name: jobName, cron: '* * * * *' })),
    aiTools: (declarations.aiTools ?? []).map((toolName) => ({ name: toolName })),
    tenancy: {
      orgCascadeDeleteTables: [],
      deviceCascadeDeleteTables: [],
      deviceOrgDenormalizedTables: [],
    },
  };
}

function makeJob(name = 'nightly'): ExtensionJobDefinition {
  return { name, cron: '* * * * *', handler: vi.fn(async () => undefined) };
}

function makeTool(name = 'lookup'): ExtensionAiTool {
  return {
    definition: { name, description: `${name} tool`, input_schema: { type: 'object' } },
    tier: 1,
    handler: vi.fn(async () => 'ok'),
  };
}

function makeStaged(
  name = 'demo',
  version = '1.0.0',
  contributions: { route?: boolean; job?: boolean; tool?: boolean } = {},
): StagedExtensionContributions {
  const registry = new ExtensionContributionRegistry();
  const manifest = makeManifest(name, version, {
    jobs: contributions.job ? ['nightly'] : [],
    aiTools: contributions.tool ? ['lookup'] : [],
  });
  const session = registry.begin(manifest);
  if (contributions.route) session.registrar.mountRoute(new Hono());
  if (contributions.job) session.registrar.registerJob(makeJob());
  if (contributions.tool) session.registrar.registerAiTool('lookup', makeTool());
  return session.finish();
}

describe('ExtensionContributionRegistry', () => {
  it('keeps staging isolated until the finished snapshot is activated', () => {
    const registry = new ExtensionContributionRegistry();
    const session = registry.begin(makeManifest('demo', '1.0.0', { jobs: ['nightly'] }));
    session.registrar.registerJob(makeJob());

    expect(registry.get('demo')).toBeUndefined();

    const staged = session.finish();
    expect(registry.get('demo')).toBeUndefined();

    registry.activate(staged);
    expect(registry.get('demo')).toBe(staged);
  });

  it('keeps the old snapshot when replacement staging fails', () => {
    const registry = new ExtensionContributionRegistry();
    registry.activate(makeStaged('demo', '1.0.0'));
    const session = registry.begin(makeManifest('demo', '2.0.0', { aiTools: ['duplicate'] }));
    session.registrar.registerAiTool('duplicate', makeTool('duplicate'));
    session.registrar.registerAiTool('duplicate', makeTool('duplicate'));

    expect(() => session.finish()).toThrow(/duplicate/i);
    expect(registry.get('demo')?.version).toBe('1.0.0');
  });

  it('rejects reserved AI names before publication and keeps the prior snapshot active', () => {
    const registry = new ExtensionContributionRegistry({
      isReservedAiToolName: (name) => name === 'core_tool',
    });
    registry.activate(makeStaged('demo', '1.0.0'));
    const session = registry.begin(makeManifest('demo', '2.0.0', { aiTools: ['core_tool'] }));
    session.registrar.registerAiTool('core_tool', makeTool('core_tool'));
    const rejected = session.finish();

    expect(() => registry.activate(rejected)).toThrow(/reserved|core.*core_tool|core_tool.*core/i);
    expect(registry.get('demo')?.version).toBe('1.0.0');
  });

  it('swaps all contributions in one activation', () => {
    const registry = new ExtensionContributionRegistry();
    const staged = makeStaged('demo', '1.0.0', { route: true, job: true, tool: true });

    registry.activate(staged);

    expect(registry.get('demo')).toMatchObject({ version: '1.0.0', enabled: true });
    expect(registry.get('demo')?.routeApp).toBeDefined();
    expect(registry.get('demo')?.jobs.size).toBe(1);
    expect(registry.get('demo')?.aiTools.size).toBe(1);
  });

  it('rejects duplicate job registrations at finish', () => {
    const registry = new ExtensionContributionRegistry();
    const session = registry.begin(makeManifest('demo', '1.0.0', { jobs: ['nightly'] }));
    session.registrar.registerJob(makeJob());
    session.registrar.registerJob(makeJob());

    expect(() => session.finish()).toThrow(/duplicate job.*nightly/i);
  });

  it('rejects duplicate AI-tool registrations at finish', () => {
    const registry = new ExtensionContributionRegistry();
    const session = registry.begin(makeManifest('demo', '1.0.0', { aiTools: ['lookup'] }));
    session.registrar.registerAiTool('lookup', makeTool());
    session.registrar.registerAiTool('lookup', makeTool());

    expect(() => session.finish()).toThrow(/duplicate AI tool.*lookup/i);
  });

  it('rejects an AI tool whose definition name differs from its registration name', () => {
    const registry = new ExtensionContributionRegistry();
    const session = registry.begin(makeManifest('demo', '1.0.0', { aiTools: ['declared'] }));
    session.registrar.registerAiTool('declared', makeTool('undeclared'));

    expect(() => session.finish()).toThrow(/registration name "declared".*definition name "undeclared"/i);
  });

  it('rejects two registration keys that use the same AI-tool definition name', () => {
    const registry = new ExtensionContributionRegistry();
    const session = registry.begin(makeManifest('demo', '1.0.0', { aiTools: ['first', 'second'] }));
    session.registrar.registerAiTool('first', makeTool('first'));
    session.registrar.registerAiTool('second', makeTool('first'));

    expect(() => session.finish()).toThrow(/registration name "second".*definition name "first"/i);
  });

  it('rejects more than one route app at finish', () => {
    const registry = new ExtensionContributionRegistry();
    const session = registry.begin(makeManifest());
    session.registrar.mountRoute(new Hono());
    session.registrar.mountRoute(new Hono());

    expect(() => session.finish()).toThrow(/more than one route app/i);
  });

  it('requires registered job names to exactly match the manifest', () => {
    const registry = new ExtensionContributionRegistry();
    const missing = registry.begin(makeManifest('demo', '1.0.0', { jobs: ['nightly'] }));
    expect(() => missing.finish()).toThrow(/missing declared job.*nightly/i);

    const undeclared = registry.begin(makeManifest());
    undeclared.registrar.registerJob(makeJob());
    expect(() => undeclared.finish()).toThrow(/undeclared job.*nightly/i);
  });

  it('requires registered AI-tool names to exactly match the manifest', () => {
    const registry = new ExtensionContributionRegistry();
    const missing = registry.begin(makeManifest('demo', '1.0.0', { aiTools: ['lookup'] }));
    expect(() => missing.finish()).toThrow(/missing declared AI tool.*lookup/i);

    const undeclared = registry.begin(makeManifest());
    undeclared.registrar.registerAiTool('lookup', makeTool());
    expect(() => undeclared.finish()).toThrow(/undeclared AI tool.*lookup/i);
  });

  it('returns a frozen snapshot with cloned readonly maps', () => {
    const registry = new ExtensionContributionRegistry();
    const session = registry.begin(makeManifest('demo', '1.0.0', { jobs: ['nightly'] }));
    session.registrar.registerJob(makeJob());

    const staged = session.finish();

    expect(Object.isFrozen(staged)).toBe(true);
    expect([...staged.jobs.keys()]).toEqual(['nightly']);
    expectTypeOf(staged.jobs).toEqualTypeOf<ReadonlyMap<string, ExtensionJobDefinition>>();
    expectTypeOf(staged.aiTools).toEqualTypeOf<ReadonlyMap<string, RegistryAiTool>>();
  });

  it('seals the staging session and its retained registrar after finish', () => {
    const registry = new ExtensionContributionRegistry();
    const session = registry.begin(makeManifest());
    const registrar = session.registrar;

    session.finish();

    expect(Object.isFrozen(registrar)).toBe(true);
    expect(() => registrar.mountRoute(new Hono())).toThrow(/finished|sealed/i);
    expect(() => registrar.registerJob(makeJob('later'))).toThrow(/finished|sealed/i);
    expect(() => registrar.registerAiTool('later', makeTool('later'))).toThrow(/finished|sealed/i);
    expect(() => session.finish()).toThrow(/already finished|sealed/i);
  });

  it('deep-clones and freezes manifest and contribution metadata', () => {
    const registry = new ExtensionContributionRegistry();
    const manifest = makeManifest('demo', '1.0.0', { jobs: ['nightly'], aiTools: ['lookup'] });
    const job = makeJob();
    const deviceArgs = ['deviceId'];
    const tool = { ...makeTool(), deviceArgs };
    const session = registry.begin(manifest);
    session.registrar.registerJob(job);
    session.registrar.registerAiTool('lookup', tool);

    const staged = session.finish();
    manifest.version = '9.9.9';
    manifest.tenancy.orgCascadeDeleteTables.push('demo_late');
    job.name = 'changed';
    tool.definition.description = 'changed';
    deviceArgs.push('otherDeviceId');

    expect(staged.manifest.version).toBe('1.0.0');
    expect(staged.manifest.tenancy.orgCascadeDeleteTables).toEqual([]);
    expect(staged.jobs.get('nightly')?.name).toBe('nightly');
    expect(staged.aiTools.get('lookup')?.definition.description).toBe('lookup tool');
    expect(staged.aiTools.get('lookup')?.deviceArgs).toEqual(['deviceId']);
    expect(Object.isFrozen(staged.manifest.tenancy.orgCascadeDeleteTables)).toBe(true);
    expect(Object.isFrozen(staged.jobs.get('nightly'))).toBe(true);
    expect(Object.isFrozen(staged.aiTools.get('lookup')?.definition)).toBe(true);
  });

  it('exposes runtime-immutable map views even when callers cast them to Map', () => {
    const staged = makeStaged('demo', '1.0.0', { job: true, tool: true });

    expect(() => (staged.jobs as Map<string, ExtensionJobDefinition>).set('later', makeJob('later')))
      .toThrow();
    expect(() => (staged.aiTools as unknown as Map<string, ExtensionAiTool>).delete('lookup'))
      .toThrow();
    expect([...staged.jobs.keys()]).toEqual(['nightly']);
    expect([...staged.aiTools.keys()]).toEqual(['lookup']);
  });

  it('copies route registrations into a sealed host-owned Hono app', async () => {
    const registry = new ExtensionContributionRegistry();
    const extensionApp = new Hono();
    extensionApp.get('/before', (c) => c.json({ version: 'original' }));
    const session = registry.begin(makeManifest());
    session.registrar.mountRoute(extensionApp);

    const staged = session.finish();
    extensionApp.get('/after', (c) => c.json({ late: true }));
    const originalRoute = extensionApp.routes[0] as { handler: () => Response } | undefined;
    if (originalRoute) originalRoute.handler = () => new Response('replaced');

    const host = new Hono();
    staged.routeApp!.composeInto(host, '');
    expect((await host.request('/before')).status).toBe(200);
    expect(await (await host.request('/before')).json()).toEqual({ version: 'original' });
    expect((await host.request('/after')).status).toBe(404);
  });

  it('publishes only a sealed composition facade with no Hono mutation surface', async () => {
    const registry = new ExtensionContributionRegistry();
    const extensionApp = new Hono();
    extensionApp.get('/before', (c) => c.json({ version: 'original' }));
    const session = registry.begin(makeManifest());
    session.registrar.mountRoute(extensionApp);
    const published = session.finish().routeApp as PublishedExtensionRouteApp;
    const exposed = published as unknown as Record<string, unknown>;

    expect(Object.keys(published)).toEqual(['composeInto']);
    for (const mutator of [
      'get', 'post', 'put', 'delete', 'patch', 'options', 'all',
      'on', 'use', 'route', 'notFound', 'onError',
    ]) {
      expect(() => (exposed[mutator] as (...args: unknown[]) => unknown)('/late', vi.fn()))
        .toThrow();
    }
    expect(() => Object.assign(published, { routes: [] })).toThrow();
    expect(exposed.router).toBeUndefined();

    const host = new Hono();
    published.composeInto(host, '/published');
    expect(await (await host.request('/published/before')).json())
      .toEqual({ version: 'original' });
    expect((await host.request('/published/late')).status).toBe(404);
  });

  it('does not expose the private route app through caller-controlled composition', async () => {
    const registry = new ExtensionContributionRegistry();
    const extensionApp = new Hono();
    extensionApp.get('/before', (c) => c.json({ version: 'original' }));
    const session = registry.begin(makeManifest());
    session.registrar.mountRoute(extensionApp);
    const published = session.finish().routeApp as PublishedExtensionRouteApp;

    const host = new Hono();
    const originalRoute = host.route.bind(host);
    let capturedApp: Hono | undefined;
    host.route = ((path: string, app: Hono) => {
      capturedApp = app;
      return originalRoute(path, app);
    }) as typeof host.route;

    published.composeInto(host, '/published');

    if (capturedApp) {
      expect(() => capturedApp!.get('/late', (c) => c.json({ late: true }))).toThrow();
      expect((await capturedApp.request('/late')).status).toBe(404);
    }
    expect(capturedApp).toBeUndefined();
    expect(await (await host.request('/published/before')).json())
      .toEqual({ version: 'original' });
  });

  it('withdraws an active extension without removing its contributions', () => {
    const registry = new ExtensionContributionRegistry();
    const staged = makeStaged('demo', '1.0.0', { job: true, tool: true });
    registry.activate(staged);

    registry.withdraw('demo');

    expect(registry.get('demo')).toMatchObject({ name: 'demo', version: '1.0.0', enabled: false });
    expect(registry.get('demo')?.jobs.size).toBe(1);
    expect(registry.get('demo')?.aiTools.size).toBe(1);
    expect(Object.isFrozen(registry.get('demo'))).toBe(true);
  });

  it('ignores withdrawal of an inactive extension', () => {
    const registry = new ExtensionContributionRegistry();

    expect(() => registry.withdraw('missing')).not.toThrow();
    expect(registry.get('missing')).toBeUndefined();
  });
});
