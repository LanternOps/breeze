import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BreezeExtensionV1 } from '@breeze/extension-sdk';
import type { AiTool } from './aiTools';

/**
 * aiToolNames.ts is the leaf half of the core/extension AI-tool-name
 * collision guard, extracted out of services/aiTools.ts so that
 * extensions/stageExtension.ts (and therefore extensions/builtinExtensions.ts,
 * one of worker.ts's dynamic-import boot seeds) never has to statically
 * import the full ~45-domain-module aiTools.ts hub. See that file's header
 * and workerEntrypointClosure.contract.test.ts.
 *
 * The whole point of the extraction only holds if BOTH of these are true:
 *   1. Importing aiToolNames.ts ALONE (as stageExtension.ts now does) is
 *      enough to wire `hasCoreAiToolName` onto
 *      `extensionContributionRegistry.configureReservedAiToolNames` — no
 *      dependency on aiTools.ts ever loading.
 *   2. Importing aiTools.ts (as every other pre-existing caller still does)
 *      yields IDENTICAL behavior to before the extraction: the same shared
 *      map, populated by the same registerXTools() calls, plus the same
 *      M365/Google tier fallback — registered exactly once, not duplicated.
 *
 * Each test starts with `vi.resetModules()` so module-scope side effects
 * (the map population, the `configureReservedAiToolNames` call) run fresh —
 * without it, a later test would silently ride on an earlier test's already-
 * populated module instance and could pass for the wrong reason.
 */
describe('aiToolNames leaf module (#4086 Task 5, chain (ii) break)', () => {
  it('importing the leaf ALONE wires hasCoreAiToolName onto aiTools (the shared map), no aiTools.ts import needed', async () => {
    vi.resetModules();
    const { aiTools, hasCoreAiToolName } = await import('./aiToolNames');
    expect(hasCoreAiToolName('leaf_only_probe_tool')).toBe(false);
    aiTools.set('leaf_only_probe_tool', {} as unknown as AiTool);
    expect(hasCoreAiToolName('leaf_only_probe_tool')).toBe(true);
  });

  it('importing the leaf ALONE wires registerReservedAiToolNamePredicate too (the M365/Google tier fallback mechanism)', async () => {
    vi.resetModules();
    const { hasCoreAiToolName, registerReservedAiToolNamePredicate } = await import('./aiToolNames');
    expect(hasCoreAiToolName('predicate_only_probe_tool')).toBe(false);
    registerReservedAiToolNamePredicate((name) => name === 'predicate_only_probe_tool');
    expect(hasCoreAiToolName('predicate_only_probe_tool')).toBe(true);
  });

  // Generous timeout: vi.resetModules() forces a fresh transform of
  // stageExtension.ts's own (unrelated, non-aiTools) import graph, which can
  // legitimately take a few seconds under the default 5000ms — this is a
  // slow-but-correct compile, not a hang (verified locally at ~6-8s).
  it('importing the leaf ALONE (no aiTools.ts) is enough to reject a colliding extension AI tool via stageExtension', async () => {
    vi.resetModules();
    const { aiTools } = await import('./aiToolNames');
    aiTools.set('leaf_only_reserved_for_extension_test', {} as unknown as AiTool);
    const { defaultStageExtension } = await import('../extensions/stageExtension');
    const { ExtensionContributionRegistry } = await import('../extensions/contributionRegistry');
    const registry = new ExtensionContributionRegistry();
    const manifest = {
      apiVersion: 'breeze.extensions/v1',
      name: 'demo',
      version: '1.0.0',
      routeNamespace: 'demo',
      requires: { breeze: '>=0.1.0', serverSdk: '^1.0.0', capabilities: [] },
      server: { entry: 'server/index.cjs' },
      migrationsDir: 'migrations',
      schemaCompatibilityFloor: '1.0.0',
      publicRoutes: [],
      agentRoutes: false,
      jobs: [],
      aiTools: [{ name: 'leaf_only_reserved_for_extension_test', description: 'x', input_schema: {} }],
      tenancy: {
        orgCascadeDeleteTables: [],
        deviceCascadeDeleteTables: [],
        deviceOrgDenormalizedTables: [],
        deviceOrgMoveDeleteTables: [],
      },
    } as never;
    const module: BreezeExtensionV1 = {
      register(registrar) {
        registrar.registerAiTool('leaf_only_reserved_for_extension_test', {
          definition: { name: 'leaf_only_reserved_for_extension_test', description: 'x', input_schema: {} },
          tier: 1,
          handler: async () => 'x',
        });
      },
    };
    await expect(
      defaultStageExtension(
        module,
        manifest,
        registry,
      ),
    ).rejects.toThrow(/already registered/);
  }, 20_000);

  it('importing aiTools.ts (the hub, as before this extraction) re-exports the SAME map instance and yields identical hasCoreAiToolName behavior', async () => {
    vi.resetModules();
    const hub = await import('./aiTools');
    const leaf = await import('./aiToolNames');
    expect(hub.aiTools).toBe(leaf.aiTools);
    expect(hub.hasCoreAiToolName).toBe(leaf.hasCoreAiToolName);
    // A real domain-registered tool name (added via one of the ~45
    // registerXTools(aiTools) calls) is reserved...
    expect(hub.hasCoreAiToolName('query_devices')).toBe(true);
    // ...and so is a real M365 tier-only name, which is never added to the
    // `aiTools` map itself — this is the fallback predicate aiTools.ts
    // registers via registerReservedAiToolNamePredicate.
    expect(hub.hasCoreAiToolName('m365_reset_password')).toBe(true);
    // An unknown name is not reserved.
    expect(hub.hasCoreAiToolName('definitely_not_a_real_tool_xyz')).toBe(false);
  }, 20_000);

  it('aiTools.ts source no longer calls configureReservedAiToolNames itself (only aiToolNames.ts may — a second call would make the registered predicate order-dependent)', () => {
    const src = readFileSync(fileURLToPath(new URL('./aiTools.ts', import.meta.url)), 'utf8');
    expect(src).not.toContain('configureReservedAiToolNames');
  });
});
