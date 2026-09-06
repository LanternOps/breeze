import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  parseExtensionManifestV1,
  type BreezeExtensionV1,
  type ExtensionManifestV1,
} from '@breeze/extension-sdk';

import {
  BUILTIN_EXTENSION_NAMES,
  builtinTenancyDeclarations,
  isBuiltinEnabled,
  loadBuiltinExtensions,
  type BuiltinExtension,
  type BuiltinPorts,
} from './builtinExtensions';
import { BUILTINS } from './builtinRegistry';
import {
  getExtensionOrgExportColumns,
  registerRuntimeExtensionTenancy,
  resetExtensionTenancyCacheForTests,
} from './tenancyRegistry';
import { getTenantExportPolicyRegistry } from '../services/tenantExportPolicyRegistry';
import {
  ExtensionContributionRegistry,
  type StagedExtensionContributions,
} from './contributionRegistry';
import {
  ExtensionStateStore,
  type ExtensionStateBackend,
  type ExtensionStateRecord,
  type ObservedExtensionInput,
} from './stateStore';
import type { ExtensionLifecycleState } from '../db/schema/extensions';
import type { RegisterableExtensionWebAsset } from './webAssets';

/**
 * The built-in loading path is exercised entirely through injected ports, so
 * these tests need no database, no filesystem, and never import
 * `@breeze/ext-workspace` themselves:
 * the built-in LIST is itself a port, so a fixture extension stands in for the
 * real one. Only the `BUILTIN_EXTENSION_NAMES` suite looks at the real
 * registration: it pins the static registry fields and resolves the manifest
 * once to catch name drift.
 *
 * The in-memory state backend mirrors the Drizzle backend's semantics: a fresh
 * row is born `enabled: true` /
 * `lifecycle_state: 'discovered'`, and re-observing an existing row never
 * disturbs `enabled` or the lifecycle state.
 */
class InMemoryExtensionStateBackend implements ExtensionStateBackend {
  private readonly rows = new Map<string, ExtensionStateRecord>();
  private readonly floors = new Map<string, Map<string, string>>();

  async upsertObserved(input: ObservedExtensionInput): Promise<void> {
    const existing = this.rows.get(input.name);
    if (existing) {
      if (input.configuredVersion !== undefined) existing.configuredVersion = input.configuredVersion;
      if (input.activeVersion !== undefined) existing.activeVersion = input.activeVersion;
      existing.updatedAt = new Date();
      return;
    }
    this.rows.set(input.name, {
      name: input.name,
      configuredVersion: input.configuredVersion ?? null,
      activeVersion: input.activeVersion ?? null,
      artifactDigest: input.digest ?? null,
      publisherId: input.publisher ?? null,
      manifestApiVersion: input.manifestApiVersion ?? null,
      serverSdkVersion: input.serverSdkVersion ?? null,
      webSdkVersion: input.webSdkVersion ?? null,
      enabled: true,
      lifecycleState: 'discovered',
      lastErrorCategory: null,
      lastErrorMessage: null,
      migratedAt: null,
      activatedAt: null,
      updatedAt: new Date(),
    });
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const row = this.rows.get(name);
    if (row) { row.enabled = enabled; row.updatedAt = new Date(); }
  }

  async getRow(name: string): Promise<ExtensionStateRecord | null> {
    const row = this.rows.get(name);
    return row ? { ...row } : null;
  }

  async listRows(): Promise<ExtensionStateRecord[]> {
    return [...this.rows.values()]
      .map((row) => ({ ...row }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async recordFailure(
    name: string,
    state: Extract<ExtensionLifecycleState, 'failed' | 'incompatible'>,
    category: string,
    message: string,
  ): Promise<void> {
    const row = this.rows.get(name);
    if (!row) return;
    row.lifecycleState = state;
    row.lastErrorCategory = category;
    row.lastErrorMessage = message;
    row.updatedAt = new Date();
  }

  async recordActive(name: string, activeVersion: string | null): Promise<void> {
    const row = this.rows.get(name);
    if (!row) return;
    row.lifecycleState = 'active';
    row.lastErrorCategory = null;
    row.lastErrorMessage = null;
    row.activatedAt = new Date();
    row.updatedAt = new Date();
    if (activeVersion !== null) row.activeVersion = activeVersion;
  }

  async insertSchemaFloor(name: string, version: string, floor: string): Promise<void> {
    let byVersion = this.floors.get(name);
    if (!byVersion) { byVersion = new Map(); this.floors.set(name, byVersion); }
    byVersion.set(version, floor);
  }

  async listSchemaFloors(name: string): Promise<string[]> {
    return [...(this.floors.get(name)?.values() ?? [])];
  }
}

/** Fixture built-in. `routeNamespace` deliberately differs from `name` so the
 *  rate-limit-prefix assertions prove BOTH mount forms are registered. */
const NAME = 'demo-builtin';
const NAMESPACE = 'demo-ns';
const VERSION = '1.4.0';
const ENABLE_ENV_VAR = 'BREEZE_DEMO_BUILTIN_ENABLED';

function fixtureManifest(overrides: Partial<ExtensionManifestV1> = {}): ExtensionManifestV1 {
  return {
    apiVersion: 'breeze.extensions/v1',
    name: NAME,
    version: VERSION,
    routeNamespace: NAMESPACE,
    requires: { breeze: '>=0.1.0', serverSdk: '^1.0.0', webSdk: '^1.0.0', capabilities: [] },
    server: { entry: 'server/index.cjs' },
    migrationsDir: 'migrations',
    schemaCompatibilityFloor: '1.0.0',
    publicRoutes: [],
    agentRoutes: true,
    jobs: [],
    aiTools: [],
    tenancy: {
      orgCascadeDeleteTables: [],
      deviceCascadeDeleteTables: [],
      deviceOrgDenormalizedTables: [],
      deviceOrgMoveDeleteTables: [],
    },
    ...overrides,
  } as unknown as ExtensionManifestV1;
}

function fixtureModule(): BreezeExtensionV1 {
  return {
    register(registrar) {
      const app = new Hono();
      app.get('/health', (c) => c.json({ ok: true }));
      registrar.mountRoute(app);
    },
  };
}

function fixtureBuiltin(overrides: Partial<BuiltinExtension> = {}): BuiltinExtension {
  return {
    module: fixtureModule(),
    name: NAME,
    manifest: fixtureManifest(),
    packageDir: 'ee/demo-builtin',
    packageName: '@breeze/ext-demo-builtin',
    helperRoutes: false,
    enableEnvVar: ENABLE_ENV_VAR,
    ...overrides,
  };
}

function fakeStaged(manifest: ExtensionManifestV1): StagedExtensionContributions {
  return {
    name: manifest.name,
    version: manifest.version,
    manifest,
    routeApp: { composeInto: () => {} },
    jobs: new Map(),
    aiTools: new Map(),
    enabled: true,
  };
}

const FIXTURE_WEB_ASSET: RegisterableExtensionWebAsset = {
  root: '/app/ee/demo-builtin/dist',
  digest: `sha256:${'b'.repeat(64)}`,
  files: new Map([['web/index.js', { sha256: 'c'.repeat(64), uncompressedSize: 12 }]]),
};

function enoent(message: string): Error {
  return Object.assign(new Error(message), { code: 'ENOENT' });
}

/**
 * Every phase is a recording stub, and `registry.activate` is recorded into the
 * SAME ordered log — so the phase order (migration → tenancy → stage → validate
 * → activate) is provable rather than merely plausible.
 */
function createHarness(overrides: {
  builtins?: readonly BuiltinExtension[];
  stateStore?: ExtensionStateStore;
  /** Drive the REAL `defaultStageExtension` instead of the recording stub. */
  realStage?: boolean;
  ports?: Partial<BuiltinPorts>;
} = {}) {
  const registry = new ExtensionContributionRegistry();
  const stateStore = overrides.stateStore
    ?? new ExtensionStateStore(new InMemoryExtensionStateBackend());
  const calls: string[] = [];
  /** Counts privileged-connection opens, which the DISABLED path must never do. */
  const migrationSqlOpens = { count: 0 };
  const rateLimitPrefixes: string[] = [];
  const registeredWebAssets: Array<{ name: string; asset: RegisterableExtensionWebAsset }> = [];
  /** Every manifest handed to publishTenancy — the declaration that goes LIVE. */
  const publishedTenancy: ExtensionManifestV1[] = [];
  /** Every (name, declaration) pair the RLS tripwire port was asked to verify. */
  const validatedTenancy: Array<{ name: string; tenancy: ExtensionManifestV1['tenancy'] }> = [];

  const activate = registry.activate.bind(registry);
  vi.spyOn(registry, 'activate').mockImplementation((staged) => {
    calls.push('activate');
    activate(staged);
  });

  const ports: Partial<BuiltinPorts> = {
    builtins: overrides.builtins ?? [fixtureBuiltin()],
    createMigrationSql: () => { migrationSqlOpens.count += 1; return null; },
    runMigrations: async () => {},
    checkMigrationParity: async () => {},
    publishTenancy: (manifest) => { calls.push('tenancy'); publishedTenancy.push(manifest); },
    builtinEverMigrated: async () => false,
    existingDeclaredTables: async () => { calls.push('probe'); return []; },
    ...(overrides.realStage ? {} : {
      stageExtension: async (_module: BreezeExtensionV1, manifest: ExtensionManifestV1) => {
        calls.push('stage');
        return fakeStaged(manifest);
      },
    }),
    validateTenancyDeclaration: async (name, tenancy) => {
      calls.push('validate');
      validatedTenancy.push({ name, tenancy });
    },
    registerRateLimitSkip: (prefix) => { rateLimitPrefixes.push(prefix); },
    webDistExists: () => true,
    readWebDist: () => FIXTURE_WEB_ASSET,
    registerWebAsset: (name, asset) => {
      calls.push('web');
      registeredWebAssets.push({ name, asset });
    },
    ...overrides.ports,
  };

  // The migration phase records itself OUTSIDE the stub, wrapping whatever
  // implementation survived the override merge. Tests that make migrations FAIL
  // replace `runMigrations` wholesale, and with the recording living inside the
  // default stub those tests could not tell "stopped AT the migration phase"
  // from "never got there".
  const runMigrations = ports.runMigrations!;
  ports.runMigrations = async (builtin, sql, stateStore) => {
    calls.push('migration');
    await runMigrations(builtin, sql, stateStore);
  };
  const checkMigrationParity = ports.checkMigrationParity!;
  ports.checkMigrationParity = async (builtin, sql) => {
    calls.push('migration');
    await checkMigrationParity(builtin, sql);
  };

  return {
    registry,
    stateStore,
    calls,
    migrationSqlOpens,
    rateLimitPrefixes,
    registeredWebAssets,
    publishedTenancy,
    validatedTenancy,
    load: (mode?: 'full' | 'worker') => loadBuiltinExtensions({ registry, stateStore, ports, mode }),
  };
}

/**
 * Switch the fixture built-in ON for a suite that exercises the loading
 * pipeline. Deliberately a raw `process.env` write rather than `vi.stubEnv`:
 * one test below stubs NODE_ENV and calls `vi.unstubAllEnvs()` mid-test, which
 * would otherwise silently un-enable the built-in for the rest of that test.
 */
function enableFixtureBuiltin(): void {
  beforeEach(() => {
    process.env[ENABLE_ENV_VAR] = 'true';
  });
  afterEach(() => {
    delete process.env[ENABLE_ENV_VAR];
  });
}

describe('loadBuiltinExtensions', () => {
  enableFixtureBuiltin();

  it('activates a built-in through the staged pipeline with enabled=true on first boot', async () => {
    const h = createHarness();
    await h.load();

    // Phase order, proven by the recording stubs' call sequence.
    expect(h.calls).toEqual(['migration', 'tenancy', 'stage', 'validate', 'activate', 'web']);

    const snapshot = h.registry.get(NAME);
    expect(snapshot?.enabled).toBe(true);
    expect(snapshot?.version).toBe(VERSION);

    // First boot seeds the row and defaults it ENABLED, then marks it active.
    const row = await h.stateStore.get(NAME);
    expect(row?.enabled).toBe(true);
    expect(row?.activeVersion).toBe(VERSION);
    expect(row?.lifecycleState).toBe('active');

    expect(h.registeredWebAssets).toEqual([{ name: NAME, asset: FIXTURE_WEB_ASSET }]);
  });

  it('respects a persisted enabled=false on later boots', async () => {
    const stateStore = new ExtensionStateStore(new InMemoryExtensionStateBackend());
    // A prior boot observed it; an operator then disabled it.
    await stateStore.upsertObserved({ name: NAME, activeVersion: VERSION });
    await stateStore.setEnabled(NAME, false);

    const setEnabled = vi.spyOn(stateStore, 'setEnabled');
    const h = createHarness({ stateStore });
    await h.load();

    // The routes activate but the snapshot is DISABLED, so the enabled gate
    // 404s them — and the persisted flag was never rewritten.
    expect(h.registry.get(NAME)?.enabled).toBe(false);
    expect(setEnabled).not.toHaveBeenCalled();
    expect((await stateStore.get(NAME))?.enabled).toBe(false);
  });

  // Regression for #3468: `activeVersion` must be written to
  // `installed_extensions` only AFTER `registry.activate()` succeeds, not
  // observed alongside `configuredVersion` before it runs. Two real built-ins
  // registered, the second sharing the first's `routeNamespace` so
  // `ExtensionContributionRegistry.activate` genuinely throws (a real
  // namespace-collision failure, not a mocked one) partway through the second
  // builtin's staged pipeline.
  it('a mid-pipeline activation failure on the second built-in leaves the first correctly active and records no phantom activeVersion for the second', async () => {
    const NAME_2 = 'demo-builtin-2';
    const VERSION_2 = '2.0.0';
    const ENABLE_ENV_VAR_2 = 'BREEZE_DEMO_BUILTIN_2_ENABLED';
    const builtin2 = fixtureBuiltin({
      name: NAME_2,
      enableEnvVar: ENABLE_ENV_VAR_2,
      // Same NAMESPACE as the first builtin (fixtureManifest's default) —
      // ExtensionContributionRegistry.activate() throws a real "route
      // namespace already owned" error for this, once the first builtin is
      // already active.
      manifest: fixtureManifest({ name: NAME_2, version: VERSION_2 }),
    });

    process.env[ENABLE_ENV_VAR_2] = 'true';
    try {
      const h = createHarness({ builtins: [fixtureBuiltin(), builtin2] });

      await expect(h.load()).rejects.toThrow(/route namespace .* is already owned by extension "demo-builtin"/i);

      // Full pipeline ran for builtin 1, and got as far as 'activate' (where
      // it throws) for builtin 2 — nothing downstream of that ran for it.
      expect(h.calls).toEqual([
        'migration', 'tenancy', 'stage', 'validate', 'activate', 'web',
        'migration', 'tenancy', 'stage', 'validate', 'activate',
      ]);

      // Built-in 1: unaffected by built-in 2's later failure — still
      // correctly activated with its real active version recorded.
      const snapshot1 = h.registry.get(NAME);
      expect(snapshot1?.enabled).toBe(true);
      expect(snapshot1?.version).toBe(VERSION);
      const row1 = await h.stateStore.get(NAME);
      expect(row1?.activeVersion).toBe(VERSION);
      expect(row1?.lifecycleState).toBe('active');

      // Built-in 2: activate() threw, so it never reached the registry, and
      // — this is the bug this test guards against — `installed_extensions`
      // must NOT claim an active version that was never actually activated.
      // upsertObserved ran (before activate) and seeded configuredVersion,
      // but recordActive (after activate) never ran.
      expect(h.registry.get(NAME_2)).toBeUndefined();
      const row2 = await h.stateStore.get(NAME_2);
      expect(row2?.configuredVersion).toBe(VERSION_2);
      expect(row2?.activeVersion).toBeNull();
      expect(row2?.lifecycleState).toBe('discovered');
    } finally {
      delete process.env[ENABLE_ENV_VAR_2];
    }
  });

  it('registers agent rate-limit skip prefixes when agentRoutes is true', async () => {
    const h = createHarness();
    await h.load();

    expect(h.rateLimitPrefixes).toEqual([
      `/api/v1/ext/${NAME}/agent/`,
      `/api/v1/${NAMESPACE}/agent/`,
    ]);
  });

  it('registers no rate-limit skip prefixes when agentRoutes is false', async () => {
    const h = createHarness({
      builtins: [fixtureBuiltin({ manifest: fixtureManifest({ agentRoutes: false }) })],
    });
    await h.load();

    expect(h.rateLimitPrefixes).toEqual([]);
  });

  it('production boot fails when the web dist is missing; dev warns and skips web asset', async () => {
    // The ABSENT-DIRECTORY condition is now decided by an explicit existence
    // check, not by catching ENOENT around the whole operation — so this is
    // what a missing bundle looks like, and `readWebDist` is never reached.
    const noWebDir = { webDistExists: () => false, readWebDist: () => { throw new Error('must not be called'); } };

    vi.stubEnv('NODE_ENV', 'production');
    try {
      const prod = createHarness({ ports: noWebDir });
      const error = await prod.load().then(() => null, (e: unknown) => e as Error);
      expect(error?.message).toContain('misbuilt');
      expect(error?.message).toMatch(/dist[/\\]web/);
      expect(error?.message).toContain('build:web');
    } finally {
      vi.unstubAllEnvs();
    }

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const dev = createHarness({ ports: noWebDir });
      await expect(dev.load()).resolves.toBeUndefined();

      // Server routes still activate — API-only development needs no web build.
      expect(dev.registry.get(NAME)?.enabled).toBe(true);
      expect(dev.registeredWebAssets).toEqual([]);
      expect(dev.calls).not.toContain('web');

      const warning = warn.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(warning).toContain('builtin_web_dist_missing');
      expect(warning).toContain('build:web');
    } finally {
      warn.mockRestore();
    }
  });

  // A failure from a PRESENT web dist is a real fault (permissions, a file
  // vanishing mid-walk, a corrupt tree) and must never be downgraded to a dev
  // warning — including when it happens to carry `code: 'ENOENT'`, which the
  // previous catch-based shape swallowed outside production.
  it.each([
    ['a permissions failure', Object.assign(new Error('permission denied'), { code: 'EACCES' })],
    ['an ENOENT mid-walk (a file vanished under the walker)', enoent('ENOENT: no such file, open .../dist/web/chunk.js')],
  ])('propagates %s from a PRESENT web dist even outside production', async (_label, boom) => {
    const h = createHarness({
      ports: { webDistExists: () => true, readWebDist: () => { throw boom; } },
    });
    await expect(h.load()).rejects.toBe(boom);
  });

  // The registration itself is not inside a lenient branch either.
  it('propagates a web-asset registration failure', async () => {
    const h = createHarness({
      ports: {
        registerWebAsset: () => { throw enoent('registry write failed'); },
      },
    });
    await expect(h.load()).rejects.toThrow(/registry write failed/);
  });

  /**
   * The pgvector case is the ONE migration failure with a known cause and two
   * concrete remedies, and the raw Postgres error names neither. Everything
   * else must reach the operator unedited.
   */
  it('rewrites a pgvector-shaped migration failure into an actionable error', async () => {
    const h = createHarness({
      ports: {
        runMigrations: async () => {
          throw new Error('extension "vector" is not available');
        },
      },
    });

    const error = await h.load().then(() => null, (e: unknown) => e as Error);
    expect(error?.message).toContain('pgvector');
    expect(error?.message).toContain('pgvector/pgvector:pg16');
    expect(error?.message).toContain(ENABLE_ENV_VAR);
    // The original text survives, and so does the original error as `cause`.
    expect(error?.message).toContain('extension "vector" is not available');
    expect((error?.cause as Error)?.message).toBe('extension "vector" is not available');

    // A failed migration aborts the pipeline AT the migration phase: nothing
    // downstream ran, so no tenancy was published for tables that do not exist,
    // nothing is live, and no `installed_extensions` row was seeded claiming an
    // active version. (This is the state the DISABLED path then has to survive
    // on the next boot — see the partial-schema test below.)
    expect(h.calls).toEqual(['migration']);
    expect(h.registry.get(NAME)).toBeUndefined();
    expect(await h.stateStore.get(NAME)).toBeNull();
  });

  it('rethrows an unrelated migration failure untouched', async () => {
    const boom = new Error('relation "widgets" already exists');
    const h = createHarness({ ports: { runMigrations: async () => { throw boom; } } });

    await expect(h.load()).rejects.toBe(boom);

    expect(h.calls).toEqual(['migration']);
    expect(h.registry.get(NAME)).toBeUndefined();
    expect(await h.stateStore.get(NAME)).toBeNull();
  });
});

/**
 * `mode: 'worker'` (wave 3.5d-b, #4086) — the counterpart pipeline for a
 * `BREEZE_ROLE=worker` process: parity-check-never-apply instead of
 * migrate, and no web-asset registration (a worker has no HTTP server to
 * serve it from). Everything else (publish tenancy, stage, validate, seed
 * state, activate) runs identically to `'full'`.
 */
describe('loadBuiltinExtensions — mode: worker', () => {
  enableFixtureBuiltin();

  it('runs parity-check instead of migrate, activates, and skips web-asset registration', async () => {
    const h = createHarness();
    await h.load('worker');

    // Same phase order as 'full', minus the trailing 'web' step.
    expect(h.calls).toEqual(['migration', 'tenancy', 'stage', 'validate', 'activate']);
    expect(h.registeredWebAssets).toEqual([]);

    const snapshot = h.registry.get(NAME);
    expect(snapshot?.enabled).toBe(true);
    expect(snapshot?.version).toBe(VERSION);

    const row = await h.stateStore.get(NAME);
    expect(row?.enabled).toBe(true);
    expect(row?.activeVersion).toBe(VERSION);
    expect(row?.lifecycleState).toBe('active');
  });

  it('never calls runMigrations (the apply path) in worker mode', async () => {
    const runMigrations = vi.fn(async () => {});
    const h = createHarness({ ports: { runMigrations } });
    await h.load('worker');
    expect(runMigrations).not.toHaveBeenCalled();
  });

  it('aborts boot when the built-in is not at migration parity', async () => {
    const boom = new Error(
      '[extensions] built-in "demo-builtin" is not at migration parity on a worker-role process ' +
        '(missing from ledger: demo-builtin/0001-init.sql) — an api/all-role process must apply its migrations first',
    );
    const h = createHarness({ ports: { checkMigrationParity: async () => { throw boom; } } });

    await expect(h.load('worker')).rejects.toBe(boom);

    // Aborted AT the parity-check phase: nothing downstream ran.
    expect(h.calls).toEqual(['migration']);
    expect(h.registry.get(NAME)).toBeUndefined();
    expect(await h.stateStore.get(NAME)).toBeNull();
  });

  it('defaults to full mode when `mode` is omitted', async () => {
    const runMigrations = vi.fn(async () => {});
    const checkMigrationParity = vi.fn(async () => {});
    const h = createHarness({ ports: { runMigrations, checkMigrationParity } });
    await h.load();
    expect(runMigrations).toHaveBeenCalledTimes(1);
    expect(checkMigrationParity).not.toHaveBeenCalled();
  });
});

/**
 * The DEPLOYMENT enable flag. Being compiled into the image makes a built-in
 * available, not loaded: a deployment that never asked for it must boot with no
 * migrations, no schema and none of the built-in's infrastructure requirements
 * (workspace's pgvector) — while a deployment that enabled it ONCE and later
 * switched it off must still boot, with its orphaned tables accounted for.
 */
describe('loadBuiltinExtensions — deployment enable flag', () => {
  afterEach(() => {
    delete process.env[ENABLE_ENV_VAR];
  });

  /** A built-in whose tenancy actually declares tables, so the probe matters. */
  const TENANT_TABLES = ['demo_files', 'demo_projects'];
  function tenantedBuiltin(): BuiltinExtension {
    return fixtureBuiltin({
      manifest: fixtureManifest({
        tenancy: {
          // Deliberately overlapping across the four lists: the probe must see
          // the DEDUPED union, not one list or four copies.
          orgCascadeDeleteTables: ['demo_projects', 'demo_files'],
          deviceCascadeDeleteTables: ['demo_files'],
          deviceOrgDenormalizedTables: [],
          deviceOrgMoveDeleteTables: ['demo_files'],
        },
      } as Partial<ExtensionManifestV1>),
    });
  }

  function captureWarnings() {
    return vi.spyOn(console, 'warn').mockImplementation(() => {});
  }

  it('loads nothing at all when the flag is unset', async () => {
    const warn = captureWarnings();
    try {
      const h = createHarness();
      await expect(h.load()).resolves.toBeUndefined();

      // No phase ran, nothing is live, and the privileged migration connection
      // was never even opened (so a plain-Postgres deployment boots clean).
      expect(h.calls).toEqual([]);
      expect(h.migrationSqlOpens.count).toBe(0);
      expect(h.registry.get(NAME)).toBeUndefined();
      expect(await h.stateStore.get(NAME)).toBeNull();
      expect(h.registeredWebAssets).toEqual([]);

      // Exactly ONE structured skip line, naming the flag to set.
      expect(warn).toHaveBeenCalledTimes(1);
      const line = warn.mock.calls[0]!.join(' ');
      expect(line).toContain('builtin_extension_disabled');
      expect(line).toContain(`"extension":"${NAME}"`);
      expect(line).toContain(`"enableFlag":"${ENABLE_ENV_VAR}"`);
      // UNSET is reported as an explicit null, not an empty string, so it reads
      // differently from a flag that was set to something wrong.
      expect(line).toContain('"observedValue":null');
      expect(line).toContain('opt-in per deployment');
    } finally {
      warn.mockRestore();
    }
  });

  it.each(['', 'false', '1', 'TRUE', 'yes'])(
    'stays off for the non-strict value %o',
    async (value) => {
      process.env[ENABLE_ENV_VAR] = value;
      const warn = captureWarnings();
      try {
        const h = createHarness();
        await h.load();
        expect(h.calls).toEqual([]);
        expect(h.registry.get(NAME)).toBeUndefined();
      } finally {
        warn.mockRestore();
      }
    },
  );

  /**
   * `BREEZE_WORKSPACE_ENABLED=1` looks enabled to a human reading the compose
   * file, and the old skip line said only "this one is not enabled" — which
   * reads as a lie to the operator who just set it. The value-strictness has to
   * be in the log, along with what was actually observed.
   */
  it.each(['1', 'TRUE', 'yes', 'false', ''])(
    'reports the observed value and a value-strict reason when the flag is set to %o',
    async (value) => {
      process.env[ENABLE_ENV_VAR] = value;
      const warn = captureWarnings();
      try {
        await createHarness().load();

        const line = warn.mock.calls[0]!.join(' ');
        expect(line).toContain(`"observedValue":${JSON.stringify(value)}`);
        expect(line).toContain('is SET but is not the exact string');
        expect(line).toContain('value-strict');
        // ...and NOT the never-configured wording.
        expect(line).not.toContain('opt-in per deployment');
      } finally {
        warn.mockRestore();
      }
    },
  );

  // A previously-enabled deployment left `demo_*` on the database. Without the
  // declaration, the unaccounted-public-tables sweep aborts boot on those
  // tables, and org-deletion cascades skip them.
  it('publishes tenancy — and ONLY tenancy (plus its RLS check) — when the built-in left tables behind', async () => {
    const warn = captureWarnings();
    try {
      const probed: Array<readonly string[]> = [];
      const h = createHarness({
        builtins: [tenantedBuiltin()],
        ports: {
          existingDeclaredTables: async (tables) => {
            probed.push(tables);
            return [...tables];
          },
        },
      });
      await h.load();

      expect(h.calls).toEqual(['tenancy', 'validate']);
      expect(h.migrationSqlOpens.count).toBe(0);
      expect(h.registry.get(NAME)).toBeUndefined();
      expect(await h.stateStore.get(NAME)).toBeNull();

      // The probe sees the deduped, sorted union of all four tenancy lists.
      expect(probed).toEqual([TENANT_TABLES]);

      // Everything present: the declaration goes out WHOLE, and no
      // partial-schema warning is emitted.
      expect(h.publishedTenancy[0]?.tenancy).toEqual(tenantedBuiltin().manifest.tenancy);
      const warnings = warn.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(warnings).not.toContain('builtin_extension_partial_schema');
    } finally {
      warn.mockRestore();
    }
  });

  // The other direction: declaring tables that were never created would point
  // core's cascade/export SQL at nonexistent relations.
  it('publishes nothing when the built-in has no tables on the database', async () => {
    const warn = captureWarnings();
    try {
      const h = createHarness({
        builtins: [tenantedBuiltin()],
        ports: { existingDeclaredTables: async () => [] },
      });
      await h.load();

      expect(h.calls).toEqual([]);
      expect(h.migrationSqlOpens.count).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * THE PARTIAL-SCHEMA CASE — the state a failed enabled boot actually leaves
   * behind, and the one the old boolean probe could not represent.
   *
   * Enabling the built-in on a database that cannot satisfy its migrations
   * aborts boot part-way through the file sequence, so the files that committed
   * leave their tables and the rest never run. (Workspace on stock Postgres:
   * three files apply, the fourth dies on `CREATE EXTENSION vector`.) Unsetting
   * the flag then reaches this path with SOME tables present — and a yes/no
   * probe answered "yes", which published the WHOLE manifest declaration and
   * pointed org-cascade and tenant-export SQL at relations that were never
   * created. Only the present subset may be declared.
   */
  it('publishes a FILTERED declaration — and warns — when only SOME of the tables exist', async () => {
    const warn = captureWarnings();
    try {
      const h = createHarness({
        builtins: [tenantedBuiltin()],
        // `demo_projects`' migration never committed; `demo_files`' did.
        ports: { existingDeclaredTables: async () => ['demo_files'] },
      });
      await h.load();

      expect(h.calls).toEqual(['tenancy', 'validate']);

      // Every one of the four lists is narrowed to the tables that EXIST —
      // `demo_projects` appears in none of them.
      const published = h.publishedTenancy[0]?.tenancy;
      expect(published).toEqual({
        orgCascadeDeleteTables: ['demo_files'],
        deviceCascadeDeleteTables: ['demo_files'],
        deviceOrgDenormalizedTables: [],
        deviceOrgMoveDeleteTables: ['demo_files'],
      });
      expect(JSON.stringify(published)).not.toContain('demo_projects');

      // The RLS tripwire runs over the SAME filtered declaration — asserting the
      // manifest's whole tenancy here would fail on the table that isn't there,
      // and skipping the assertion would leave an orphaned table holding tenant
      // rows with no boot-time RLS check at all.
      expect(h.validatedTenancy).toEqual([{ name: NAME, tenancy: published }]);

      // ...and the half-migrated state is an operator problem, not a silent one.
      const warnings = warn.mock.calls.map((args) => args.join(' ')).join('\n');
      expect(warnings).toContain('builtin_extension_partial_schema');
      expect(warnings).toContain('"presentTables":["demo_files"]');
      expect(warnings).toContain('"missingTables":["demo_projects"]');
      expect(warnings).toContain(`"enableFlag":"${ENABLE_ENV_VAR}"`);
      expect(warnings).toContain('org-cascade and tenant-export will NOT cover');
    } finally {
      warn.mockRestore();
    }
  });

  // The published declaration is the object the tripwire sees, and the
  // manifest's own tenancy must not be mutated on the way there — a later
  // reader (builtinTenancyDeclarations, the export registry) would inherit the
  // narrowing and forget tables that merely need their migration re-run.
  it('leaves the built-in\'s own manifest tenancy untouched while filtering', async () => {
    const warn = captureWarnings();
    try {
      const builtin = tenantedBuiltin();
      const before = structuredClone(builtin.manifest.tenancy);
      const h = createHarness({
        builtins: [builtin],
        ports: { existingDeclaredTables: async () => ['demo_files'] },
      });
      await h.load();

      expect(builtin.manifest.tenancy).toEqual(before);
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * A probe failure on the DISABLED path is the confusing one: nothing about
   * this built-in was asked for, so a bare postgres error reads as an
   * unexplained boot abort. The wrap has to say which built-in, that it is
   * switched OFF, and why a switched-off built-in queries the database at all.
   */
  it('wraps a probe failure with the disabled-path context, preserving the cause', async () => {
    const warn = captureWarnings();
    try {
      const boom = new Error('connection refused');
      const h = createHarness({
        builtins: [tenantedBuiltin()],
        ports: { existingDeclaredTables: async () => { throw boom; } },
      });

      const error = await h.load().then(() => null, (e: unknown) => e as Error);
      expect(error?.message).toContain(NAME);
      expect(error?.message).toContain('DISABLED');
      expect(error?.message).toContain(ENABLE_ENV_VAR);
      expect(error?.message).toContain('EARLIER enabled boot');
      // Names the tables it was asking about, so the operator can check by hand.
      expect(error?.message).toContain('demo_files');
      expect(error?.cause).toBe(boom);

      // Nothing was published on a probe we could not trust.
      expect(h.calls).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('skips the probe entirely for a built-in that declares no tenancy tables', async () => {
    const warn = captureWarnings();
    try {
      const h = createHarness();
      await h.load();
      expect(h.calls).not.toContain('probe');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('loadBuiltinExtensions — disabled built-in with an unreadable manifest (#3470)', () => {
  afterEach(() => {
    delete process.env[ENABLE_ENV_VAR];
  });

  function unreadableBuiltin(manifestError: Error): BuiltinExtension {
    const builtin = fixtureBuiltin();
    Object.defineProperty(builtin, 'manifest', {
      get() {
        throw manifestError;
      },
    });
    return builtin;
  }

  function captureWarnings() {
    return vi.spyOn(console, 'warn').mockImplementation(() => {});
  }

  it('continues when the ledger shows the disabled built-in never migrated', async () => {
    const manifestError = new Error('manifest fixture is unreadable');
    const builtinEverMigrated = vi.fn(async () => false);
    const existingDeclaredTables = vi.fn(async () => []);
    const warn = captureWarnings();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const h = createHarness({
        builtins: [unreadableBuiltin(manifestError)],
        ports: { builtinEverMigrated, existingDeclaredTables },
      });

      await expect(h.load()).resolves.toBeUndefined();

      expect(h.publishedTenancy).toEqual([]);
      expect(h.validatedTenancy).toEqual([]);
      expect(existingDeclaredTables).not.toHaveBeenCalled();
      expect(builtinEverMigrated).toHaveBeenCalledWith(NAME);

      // The ordinary skip line still comes first, at warn.
      const warnings = warn.mock.calls.map((args) => args.join(' '));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('builtin_extension_disabled');

      // The continue-on-an-inference line is ERROR, not warn: it is the only
      // branch here that proceeds without proof, so it must not sit at the same
      // level as the routine "this built-in is switched off" line.
      const errors = error.mock.calls.map((args) => args.join(' '));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('builtin_extension_manifest_unavailable');
      expect(errors[0]).toContain(`"extension":"${NAME}"`);
      expect(errors[0]).toContain(`"enableFlag":"${ENABLE_ENV_VAR}"`);
      // The assumption the skip rests on is named in the line itself, so an
      // operator reading it knows what would invalidate it.
      expect(errors[0]).toContain('migration ledger is intact');
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it('fails when the disabled built-in has applied migrations', async () => {
    const manifestError = new Error('manifest fixture is unreadable');
    const warn = captureWarnings();
    try {
      const h = createHarness({
        builtins: [unreadableBuiltin(manifestError)],
        ports: { builtinEverMigrated: async () => true },
      });

      const error = await h.load().then(() => null, (caught: unknown) => caught as Error);
      expect(error?.message).toContain(NAME);
      expect(error?.message).toContain(ENABLE_ENV_VAR);
      expect(error?.message).toContain('tenancy');
      expect(error?.message).toContain('cascades');
      expect(error?.cause).toBe(manifestError);
    } finally {
      warn.mockRestore();
    }
  });

  it('fails closed when the migration-ledger probe itself throws', async () => {
    const manifestError = new Error('manifest fixture is unreadable');
    const probeError = new Error('ledger connection refused');
    const warn = captureWarnings();
    try {
      const h = createHarness({
        builtins: [unreadableBuiltin(manifestError)],
        ports: { builtinEverMigrated: async () => { throw probeError; } },
      });

      const error = await h.load().then(() => null, (caught: unknown) => caught as Error);
      expect(error?.message).toContain(NAME);
      expect(error?.message).toContain('manifest was also unavailable');
      expect(error?.message).toContain('cannot decide whether it left tables behind');
      expect(error?.cause).toBe(probeError);
    } finally {
      warn.mockRestore();
    }
  });

  it('propagates the manifest error without a ledger probe when the built-in is enabled', async () => {
    process.env[ENABLE_ENV_VAR] = 'true';
    const manifestError = new Error('manifest fixture is unreadable');
    const builtinEverMigrated = vi.fn(async () => false);
    const h = createHarness({
      builtins: [unreadableBuiltin(manifestError)],
      ports: { builtinEverMigrated },
    });

    await expect(h.load()).rejects.toBe(manifestError);
    expect(builtinEverMigrated).not.toHaveBeenCalled();
  });
});

/**
 * Restores the `/helper/*` auth coverage that was dropped along with the
 * workspace legacy manifest: the gateway keys core helper auth off the
 * `helperRoutes` flag on the STAGED manifest (gateway.ts), while the flag is
 * NOT part of the strict v1 wire schema. Both halves must hold at once —
 * gateway-visible flag present, strict parse of the clean manifest unpolluted.
 *
 * These use the REAL `defaultStageExtension` (no `stageExtension` port
 * override), because the staged manifest is exactly what that function decides.
 */
describe('loadBuiltinExtensions — helperRoutes staging', () => {
  enableFixtureBuiltin();

  it('stages helperRoutes:true onto the manifest the registry session sees', async () => {
    const manifest = fixtureManifest();
    const h = createHarness({
      builtins: [fixtureBuiltin({ manifest, helperRoutes: true })],
      realStage: true,
    });
    await h.load();

    const staged = h.registry.get(NAME)?.manifest as
      (ExtensionManifestV1 & { helperRoutes?: boolean }) | undefined;
    expect(staged?.helperRoutes).toBe(true);

    // ...and the CLEAN manifest is untouched, so the strict v1 parse still passes.
    expect(Object.hasOwn(manifest, 'helperRoutes')).toBe(false);
    expect(() => parseExtensionManifestV1(manifest)).not.toThrow();
  });

  it('leaves the staged manifest unflagged when the built-in does not opt in', async () => {
    const h = createHarness({
      builtins: [fixtureBuiltin({ helperRoutes: false })],
      realStage: true,
    });
    await h.load();

    const staged = h.registry.get(NAME)?.manifest as
      (ExtensionManifestV1 & { helperRoutes?: boolean }) | undefined;
    expect(staged?.helperRoutes).toBeUndefined();
  });
});

describe('BUILTIN_EXTENSION_NAMES', () => {
  it('names the workspace extension (the first and only built-in)', () => {
    expect([...BUILTIN_EXTENSION_NAMES]).toEqual(['workspace']);
  });

  /**
   * The flag NAME is a deployment contract — it appears in .env.example, both
   * dev composes, docker-compose.yml, the CI boot step and the deploy docs — so
   * renaming it silently would leave every one of those switching nothing.
   */
  it('gates the workspace built-in on BREEZE_WORKSPACE_ENABLED, default off', () => {
    const workspace = BUILTINS.find((builtin) => builtin.name === 'workspace');
    expect(workspace?.enableEnvVar).toBe('BREEZE_WORKSPACE_ENABLED');

    const previous = process.env.BREEZE_WORKSPACE_ENABLED;
    try {
      delete process.env.BREEZE_WORKSPACE_ENABLED;
      expect(isBuiltinEnabled(workspace!)).toBe(false);
      process.env.BREEZE_WORKSPACE_ENABLED = 'true';
      expect(isBuiltinEnabled(workspace!)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.BREEZE_WORKSPACE_ENABLED;
      else process.env.BREEZE_WORKSPACE_ENABLED = previous;
    }
  });

  /**
   * Workspace's /helper/* tree is called by the device helper, so it must sit
   * behind core helper auth rather than the user default-deny. On the built-in
   * path that boundary is declared ONLY by this field — the legacy
   * breeze-extension.json the upstream repo asserted it from is not part of
   * this delivery mode. Dropping the field would silently move helper traffic
   * to authMiddleware (see the gateway's helperRoutes arm), so it is pinned
   * against the real registry entry, not a fixture.
   */
  it('keeps workspace /helper/* behind core helper auth', () => {
    const workspace = BUILTINS.find((builtin) => builtin.name === 'workspace');
    expect(workspace?.helperRoutes).toBe(true);
  });

  /**
   * The static `name` is what the disabled path probes the migration ledger
   * with when the manifest cannot be read, so it MUST match the shipped
   * `manifest.name`. `defineBuiltin` already enforces that at resolution time —
   * which is exactly why the assertion here is `not.toThrow()` and not an
   * equality check: an equality check could never observe a mismatch, because
   * the getter throws before returning one. What this test contributes is
   * FORCING that resolution against the REAL ee/workspace/manifest.json (every
   * other suite in this file uses a fixture and never touches `.manifest` on
   * the real registry), so a drift between the two lands here at test time
   * instead of at boot.
   */
  it('resolves the real workspace manifest against the static registry name', () => {
    const workspace = BUILTINS.find((builtin) => builtin.name === 'workspace');
    expect(workspace).toBeDefined();
    expect(() => workspace!.manifest).not.toThrow();
    expect(workspace!.manifest.name).toBe('workspace');
  });
});

/**
 * Publishing a built-in's tenancy is not free: `getExtensionOrgExportColumns()`
 * walks EVERY published declaration's `orgCascadeDeleteTables` and THROWS on the
 * first table with no export classification. That throw surfaces at
 * `getTenantExportPolicyRegistry()` — i.e. on the GDPR right-of-access export
 * path — so a built-in that declares cascade tables without `orgExportColumns`
 *500s every org's data export from the moment it boots, with nothing in the
 * boot logs. These tests pin the whole classification, against the REAL
 * manifest.
 */
describe('built-in tenancy participates in the tenant-export contract', () => {
  afterEach(() => {
    resetExtensionTenancyCacheForTests();
  });

  function publishBuiltinTenancy() {
    for (const declaration of builtinTenancyDeclarations()) {
      registerRuntimeExtensionTenancy(declaration);
    }
  }

  it('classifies every org-cascade table the workspace built-in declares', () => {
    const [workspace] = builtinTenancyDeclarations();
    expect(workspace?.orgCascadeDeleteTables.length).toBeGreaterThan(0);
    publishBuiltinTenancy();

    // Without `tenancy.orgExportColumns` in ee/workspace/manifest.json this
    // throws `[tenantExport] extension table "..." is missing an export
    // classification`.
    const classified = getExtensionOrgExportColumns();
    expect(Object.keys(classified).sort()).toEqual(
      [...workspace!.orgCascadeDeleteTables].sort(),
    );

    // Every table classifies a non-empty column set, and include/exclude never
    // overlap (assertUniqueExportColumns throws otherwise).
    for (const [table, policy] of Object.entries(classified)) {
      expect(
        policy.include.length + policy.exclude.length,
        `table ${table} classifies no columns`,
      ).toBeGreaterThan(0);
    }
  });

  it('builds the tenant-export policy registry the export path actually calls', () => {
    publishBuiltinTenancy();
    const registry = getTenantExportPolicyRegistry();

    for (const table of builtinTenancyDeclarations()[0]!.orgCascadeDeleteTables) {
      expect(registry[table]?.organizationKey, `missing policy for ${table}`).toBe('org_id');
    }
  });

  it('excludes the encrypted source credential while exporting the tenant-owned columns', () => {
    publishBuiltinTenancy();
    const sources = getTenantExportPolicyRegistry()['workspace_sources'];

    expect(sources?.columns['credential_enc']?.decision).toBe('exclude');
    expect(sources?.columns['root_path']?.decision).toBe('include');
    expect(sources?.columns['display_name']?.decision).toBe('include');
  });
});
