import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type {
  BreezeExtensionV1,
  ExtensionManifestV1,
  ExtensionRuntimeContext,
} from '@breeze/extension-sdk';
import { defaultStageExtension } from './stageExtension';
import { ExtensionContributionRegistry } from './contributionRegistry';

describe('defaultStageExtension (v1 contract)', () => {
  const defaultTenancy = {
    orgCascadeDeleteTables: [],
    deviceCascadeDeleteTables: [],
    deviceOrgDenormalizedTables: [],
    deviceOrgMoveDeleteTables: [],
  };

  function makeManifest(overrides: Partial<ExtensionManifestV1> = {}): ExtensionManifestV1 {
    return {
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
      aiTools: [],
      tenancy: defaultTenancy,
      ...overrides,
    } as unknown as ExtensionManifestV1;
  }

  const v1Manifest = makeManifest();

  // THE regression this suite exists for: the host must stage extensions
  // through the PUBLIC v1 SDK shape — register(registrar, context) — not the
  // legacy single-argument ExtensionContext. The workspace extension shipped
  // against the SDK contract and failed live staging because every prior test
  // injected a fake stage port and never exercised this function.
  it('stages a v1 module: registrar first, runtime context second', async () => {
    const registry = new ExtensionContributionRegistry();
    const observed: Record<string, unknown> = {};
    const module: BreezeExtensionV1 = {
      register(registrar, context) {
        observed.registrarMount = typeof registrar.mountRoute;
        observed.dbExecute = typeof context.db?.execute;
        observed.encrypt = typeof context.secrets?.encryptForColumn;
        observed.audit = typeof context.audit;
        observed.aiInvoke = typeof context.ai?.invoke;
        observed.logIsLevelFirst = (() => {
          // A legacy host passed log(message); v1 log(level, message) must not
          // throw and must accept a fields object.
          context.log('info', 'staging demo', { probe: true });
          return true;
        })();
        registrar.mountRoute(new Hono());
      },
    };
    const staged = await defaultStageExtension(module, v1Manifest, registry);
    expect(observed).toEqual({
      registrarMount: 'function',
      dbExecute: 'function',
      encrypt: 'function',
      audit: 'function',
      aiInvoke: 'function',
      logIsLevelFirst: true,
    });
    expect(staged.routeApp).toBeTruthy();
  });

  it('refuses an aiTool registration the manifest never declared', async () => {
    const registry = new ExtensionContributionRegistry();
    const module: BreezeExtensionV1 = {
      register(registrar) {
        registrar.registerAiTool('list_devices', {
          definition: { name: 'list_devices', description: 'x', input_schema: {} },
          tier: 1,
          handler: async () => 'x',
        });
      },
    };
    await expect(defaultStageExtension(module, v1Manifest, registry))
      .rejects.toThrow(/Undeclared AI tool registration/);
  });

  it('stages the legacy helperRoutes flag on top of the manifest without failing v1 validation', async () => {
    let captured: ExtensionManifestV1 | undefined;
    const module: BreezeExtensionV1 = { register: () => {} };
    const staged = await defaultStageExtension(
      module,
      makeManifest(),
      new ExtensionContributionRegistry(),
      { helperRoutes: true },
    );
    captured = staged.manifest;
    expect((captured as { helperRoutes?: boolean }).helperRoutes).toBe(true);
  });

  // The host has no per-org install gate: every extension it loads is
  // server-scoped. `installedOrgs()` must THROW rather than return `[]` — an
  // empty array means "activated for no orgs", and a sweep that read the
  // absence of the feature that way would silently do nothing.
  it('runtime context tenancy.installedOrgs THROWS — no per-org install set exists', async () => {
    let captured: ExtensionRuntimeContext | undefined;
    const module: BreezeExtensionV1 = {
      register: (_registrar, context) => { captured = context; },
    };
    await defaultStageExtension(module, makeManifest(), new ExtensionContributionRegistry());
    await expect(captured!.tenancy.installedOrgs()).rejects.toThrow(/server-scoped/);
  });
});
