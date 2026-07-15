import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { Hono } from 'hono';
import type {
  ExtensionAiTool,
  ExtensionJobDefinition,
  ExtensionManifestV1,
} from '@breeze/extension-sdk';

import {
  ExtensionContributionRegistry,
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

  it('swaps all contributions in one activation', () => {
    const registry = new ExtensionContributionRegistry();
    const staged = makeStaged('demo', '1.0.0', { route: true, job: true, tool: true });

    registry.activate(staged);

    expect(registry.get('demo')).toMatchObject({ version: '1.0.0', enabled: true });
    expect(registry.get('demo')?.routeApp).toBeInstanceOf(Hono);
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
    session.registrar.registerJob(makeJob('later'));

    expect(Object.isFrozen(staged)).toBe(true);
    expect([...staged.jobs.keys()]).toEqual(['nightly']);
    expectTypeOf(staged.jobs).toEqualTypeOf<ReadonlyMap<string, ExtensionJobDefinition>>();
    expectTypeOf(staged.aiTools).toEqualTypeOf<ReadonlyMap<string, ExtensionAiTool>>();
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
