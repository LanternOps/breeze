import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { ExtensionAiTool, ExtensionManifestV1 } from '@breeze/extension-sdk';
import type { AuthContext } from '../middleware/auth';

import {
  ExtensionContributionRegistry,
  extensionContributionRegistry,
} from './contributionRegistry';
import { mountExtensionGateway } from './gateway';
import {
  executeTool,
  getToolDefinitions,
  getToolTier,
} from '../services/aiTools';

function makeManifest(overrides: Partial<ExtensionManifestV1> = {}): ExtensionManifestV1 {
  return {
    apiVersion: 'breeze.extensions/v1',
    name: 'lifecycle-demo',
    version: '1.0.0',
    routeNamespace: 'lifecycle-legacy',
    requires: {
      breeze: '>=1.0.0',
      serverSdk: '^1.0.0',
      capabilities: ['server.routes.v1', 'server.ai-tools.v1'],
    },
    server: { entry: 'dist/server.js' },
    migrationsDir: 'migrations',
    schemaCompatibilityFloor: '1.0.0',
    publicRoutes: ['/health'],
    jobs: [],
    aiTools: [{ name: 'lifecycle_lookup_v1' }],
    tenancy: {
      orgCascadeDeleteTables: [],
      deviceCascadeDeleteTables: [],
      deviceOrgDenormalizedTables: [],
    },
    ...overrides,
  };
}

function makeTool(
  name: string,
  version: string,
  handler = vi.fn(async (input: Record<string, unknown>) => `${version}:${input.query}`),
): ExtensionAiTool {
  return {
    definition: {
      name,
      description: `${version} lookup`,
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string', minLength: 1 } },
        required: ['query'],
        additionalProperties: false,
      },
    },
    tier: 2,
    handler,
  };
}

function stage(
  registry: ExtensionContributionRegistry,
  manifest: ExtensionManifestV1,
  routeVersion: string,
  tool: ExtensionAiTool,
) {
  const routeApp = new Hono();
  routeApp.get('/health', (c) => c.json({ version: routeVersion }));
  const session = registry.begin(manifest);
  session.registrar.mountRoute(routeApp);
  session.registrar.registerAiTool(tool.definition.name, tool);
  return session.finish();
}

function makeAuth(): AuthContext {
  return {
    user: {
      id: 'user-1',
      email: 'user@example.com',
      name: 'User',
      isPlatformAdmin: false,
    },
    token: {} as AuthContext['token'],
    partnerId: null,
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
  } as unknown as AuthContext;
}

/**
 * `executeTool` re-reads the DURABLE enabled flag before running an
 * extension-contributed handler, so every call must supply a store. These tests
 * exercise the registry lifecycle, not the flag, so they inject an
 * always-enabled store; the stale-replica case is covered separately below.
 */
function enabledStore(enabled = true) {
  return { isEnabled: async () => enabled };
}

describe('extension route and AI lifecycle', () => {
  it('stages, advertises, validates, executes, replaces, and withdraws one active snapshot', async () => {
    const registry = new ExtensionContributionRegistry();
    const app = new Hono();
    mountExtensionGateway(app, registry, async () => true);
    registry.activate(stage(
      registry,
      makeManifest(),
      'v1',
      makeTool('lifecycle_lookup_v1', 'v1'),
    ));

    expect(await (await app.request('/api/v1/ext/lifecycle-demo/health')).json())
      .toEqual({ version: 'v1' });
    expect(await (await app.request('/api/v1/lifecycle-legacy/health')).json())
      .toEqual({ version: 'v1' });
    expect(getToolDefinitions(registry).some((tool) => tool.name === 'lifecycle_lookup_v1'))
      .toBe(true);
    expect(getToolTier('lifecycle_lookup_v1', registry)).toBe(2);

    const invalid = JSON.parse(await executeTool(
      'lifecycle_lookup_v1',
      { query: 42 },
      makeAuth(),
      registry,
      enabledStore(),
    ));
    expect(invalid.error).toMatch(/invalid input/i);
    expect(await executeTool(
      'lifecycle_lookup_v1',
      { query: 'hello' },
      makeAuth(),
      registry,
      enabledStore(),
    )).toBe('v1:hello');

    registry.activate(stage(
      registry,
      makeManifest({
        version: '2.0.0',
        routeNamespace: 'lifecycle-new',
        aiTools: [{ name: 'lifecycle_lookup_v2' }],
      }),
      'v2',
      makeTool('lifecycle_lookup_v2', 'v2'),
    ));

    expect((await app.request('/api/v1/lifecycle-legacy/health')).status).toBe(404);
    expect(await (await app.request('/api/v1/lifecycle-new/health')).json())
      .toEqual({ version: 'v2' });
    expect(getToolDefinitions(registry).some((tool) => tool.name === 'lifecycle_lookup_v1'))
      .toBe(false);
    await expect(executeTool('lifecycle_lookup_v1', {}, makeAuth(), registry, enabledStore()))
      .rejects.toThrow(/unknown tool/i);
    expect(await executeTool(
      'lifecycle_lookup_v2',
      { query: 'new' },
      makeAuth(),
      registry,
      enabledStore(),
    )).toBe('v2:new');

    registry.withdraw('lifecycle-demo');

    expect((await app.request('/api/v1/ext/lifecycle-demo/health')).status).toBe(503);
    expect((await app.request('/api/v1/lifecycle-new/health')).status).toBe(503);
    expect(getToolDefinitions(registry).some((tool) => tool.name === 'lifecycle_lookup_v2'))
      .toBe(false);
    expect(getToolTier('lifecycle_lookup_v2', registry)).toBeUndefined();
    await expect(executeTool('lifecycle_lookup_v2', {}, makeAuth(), registry, enabledStore()))
      .rejects.toThrow(/unknown tool/i);
  });

  it('lets an already-resolved handler complete while new lookups use its replacement', async () => {
    const registry = new ExtensionContributionRegistry();
    let releaseOld!: () => void;
    const oldBlocked = new Promise<void>((resolve) => { releaseOld = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const oldHandler = vi.fn(async () => {
      markStarted();
      await oldBlocked;
      return 'old-completed';
    });
    registry.activate(stage(
      registry,
      makeManifest(),
      'v1',
      makeTool('lifecycle_lookup_v1', 'v1', oldHandler),
    ));

    const inFlight = executeTool(
      'lifecycle_lookup_v1',
      { query: 'old' },
      makeAuth(),
      registry,
      enabledStore(),
    );
    await started;
    registry.activate(stage(
      registry,
      makeManifest({ version: '2.0.0' }),
      'v2',
      makeTool('lifecycle_lookup_v1', 'v2'),
    ));
    releaseOld();

    expect(await inFlight).toBe('old-completed');
    expect(await executeTool(
      'lifecycle_lookup_v1',
      { query: 'next' },
      makeAuth(),
      registry,
      enabledStore(),
    )).toBe('v2:next');
  });

  it('rejects invalid JSON Schema before publication and keeps the prior snapshot active', async () => {
    const registry = new ExtensionContributionRegistry();
    registry.activate(stage(
      registry,
      makeManifest(),
      'v1',
      makeTool('lifecycle_lookup_v1', 'v1'),
    ));
    const invalidTool = makeTool('lifecycle_lookup_v1', 'invalid');
    invalidTool.definition.input_schema = { type: 'not-a-json-schema-type' };

    expect(() => stage(
      registry,
      makeManifest({ version: '2.0.0' }),
      'v2',
      invalidTool,
    )).toThrow(/schema|type/i);
    expect(registry.get('lifecycle-demo')?.version).toBe('1.0.0');
    expect(await executeTool(
      'lifecycle_lookup_v1',
      { query: 'still-old' },
      makeAuth(),
      registry,
      enabledStore(),
    )).toBe('v1:still-old');
  });

  // THE STALE-REPLICA CASE. `breezectl extensions disable X` lands on ONE
  // replica: it flips the database flag and withdraws X from its OWN registry.
  // Every other replica keeps `enabled: true` in memory indefinitely — there is
  // no cross-replica invalidation and no restart. If executeTool trusted that
  // in-memory flag, the emergency shutoff would silently fail for the one
  // surface that most warrants it: running the extension's own code.
  it('refuses to run an extension AI handler whose durable flag is false, even though the local registry snapshot still says enabled', async () => {
    const registry = new ExtensionContributionRegistry();
    const handler = vi.fn(async () => 'should-never-run');
    registry.activate(stage(
      registry,
      makeManifest(),
      'v1',
      makeTool('lifecycle_lookup_v1', 'v1', handler),
    ));
    // Precisely the stale state: in-memory says enabled, the database says no.
    expect(registry.get('lifecycle-demo')?.enabled).toBe(true);
    expect(registry.getAiTool('lifecycle_lookup_v1')).toBeDefined();
    expect(registry.findAiToolOwner('lifecycle_lookup_v1')).toBe('lifecycle-demo');

    await expect(executeTool(
      'lifecycle_lookup_v1',
      { query: 'hello' },
      makeAuth(),
      registry,
      enabledStore(false),
    )).rejects.toThrow(/unknown tool/i);

    expect(handler).not.toHaveBeenCalled();
  });

  it('runs the same handler once the durable flag reads enabled', async () => {
    const registry = new ExtensionContributionRegistry();
    const handler = vi.fn(async () => 'ran');
    registry.activate(stage(
      registry,
      makeManifest(),
      'v1',
      makeTool('lifecycle_lookup_v1', 'v1', handler),
    ));

    expect(await executeTool(
      'lifecycle_lookup_v1',
      { query: 'hello' },
      makeAuth(),
      registry,
      enabledStore(true),
    )).toBe('ran');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  // The gate must not add a database read to the core tool path. The gate sits
  // BEFORE input validation, so reaching the validation error proves it was
  // skipped (an invalid uuid stops short of the handler and the database).
  it('never consults the enabled store for a core tool', async () => {
    const registry = new ExtensionContributionRegistry();
    const isEnabled = vi.fn(async () => false);

    const result = JSON.parse(await executeTool(
      'get_device_details',
      { deviceId: 'not-a-uuid' },
      makeAuth(),
      registry,
      { isEnabled },
    ));

    expect(result.error).toBeTruthy();
    expect(isEnabled).not.toHaveBeenCalled();
  });

  it('rejects cross-extension AI collisions without partially replacing either owner', () => {
    const registry = new ExtensionContributionRegistry();
    registry.activate(stage(
      registry,
      makeManifest(),
      'v1',
      makeTool('lifecycle_lookup_v1', 'v1'),
    ));
    const second = stage(
      registry,
      makeManifest({ name: 'other-demo', routeNamespace: 'other-legacy' }),
      'other',
      makeTool('lifecycle_lookup_v1', 'other'),
    );

    expect(() => registry.activate(second)).toThrow(/AI tool.*lifecycle_lookup_v1.*lifecycle-demo/i);
    expect(registry.get('lifecycle-demo')?.version).toBe('1.0.0');
    expect(registry.get('other-demo')).toBeUndefined();
  });

  it('compiles replacement schemas independently when authors reuse a stable schema id', () => {
    const registry = new ExtensionContributionRegistry();
    const v1 = makeTool('lifecycle_lookup_v1', 'v1');
    v1.definition.input_schema.$id = 'https://extensions.example/schemas/lifecycle-lookup';
    registry.activate(stage(registry, makeManifest(), 'v1', v1));
    const v2 = makeTool('lifecycle_lookup_v1', 'v2');
    v2.definition.input_schema.$id = 'https://extensions.example/schemas/lifecycle-lookup';

    expect(() => stage(
      registry,
      makeManifest({ version: '2.0.0' }),
      'v2',
      v2,
    )).not.toThrow();
  });

  it.each([
    'query_devices',
    'm365_lookup_user',
    'google_lookup_user',
  ])('production registry rejects reserved AI name %s before publication', (toolName) => {
    const manifest = makeManifest({
      name: 'reserved-collision-probe',
      routeNamespace: 'reserved-collision-probe',
      aiTools: [{ name: toolName }],
    });
    const rejected = stage(
      extensionContributionRegistry,
      manifest,
      'reserved',
      makeTool(toolName, 'reserved'),
    );

    expect(() => extensionContributionRegistry.activate(rejected)).toThrow(/collision|reserved/i);
    expect(extensionContributionRegistry.get('reserved-collision-probe')).toBeUndefined();
  });
});
