// The startup reconciler for SIGNED runtime-extension bundles.
//
// For each configured extension it runs an explicit phase pipeline —
// acquire → trust → verify → observe → compatibility → extract → load →
// migrate → publish-tenancy → stage → validate → activate — under a strict
// failure policy:
//
//   • An OPTIONAL extension that fails ANY phase records a SANITIZED failure,
//     is withdrawn from the contribution registry, is added to summary.failed,
//     and the loop moves on. Its contributions are never exposed.
//   • A REQUIRED extension that fails throws RequiredExtensionError, aborting
//     boot (after the same sanitized-failure + withdraw bookkeeping).
//
// Boot safety: a missing `extensions.yaml` (the common case) is a clean no-op —
// nothing is created, no DB client is opened, boot proceeds. Only a present but
// malformed config fails closed (a trust boundary: silently ignoring it could
// skip a required extension).
//
// Every dependency is an injectable PORT (mirroring the state-store backend
// seam) so the failure-policy unit tests need no bundle, filesystem, or DB.
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import type { Hono } from 'hono';
import {
  parseExtensionManifestV1,
  type BreezeExtensionV1,
  type ExtensionManifestV1,
  type ExtensionRegistrar,
  type ExtensionRuntimeContext,
} from '@breeze/extension-sdk';
import {
  loadExtensionDeploymentConfig,
  type ExtensionDeploymentConfig,
  type ExtensionSelection,
} from './config';
import { createArtifactStore, type ArtifactSource } from './artifactStore';
import {
  assertVerifiedMemberBytes,
  readBoundedZipDirectory,
  verifyExtensionBundle,
  type TrustedPublisher,
  type VerifiedExtensionBundle,
} from './bundleVerifier';
import { resolveTrustedPublisher } from './trust';
import type { ExtensionHostDescriptor } from './compatibility';
import { assertCompatible, HOST_DESCRIPTOR } from './hostDescriptor';
import {
  reconcileExtensionMigrations,
  toMigratableExtension,
} from './migrator';
import {
  ExtensionContributionRegistry,
  type StagedExtensionContributions,
} from './contributionRegistry';
import type { ExtensionStateStore, ObservedExtensionInput } from './stateStore';
import {
  assertExtensionTenancyRls,
  assertNoUnaccountedPublicTables,
} from './tenancyTripwire';
import {
  getExtensionTenancy,
  registerRuntimeExtensionTenancy,
} from './tenancyRegistry';
import { registerGlobalRateLimitSkipPrefix } from '../middleware/globalRateLimit';
import { hasCoreAiToolName } from '../services/aiTools';
import { db } from '../db';
import { createAuditLogAsync } from '../services/auditService';
import { decryptForColumn, encryptSecret } from '../services/secretCrypto';
import { ExtensionIncompatibleError, RequiredExtensionError } from './errors';
import { clearExtensionRoot, registerExtensionRoot } from './faultAttribution';
import { clearExtensionWebAsset, registerExtensionWebAsset } from './webAssets';

/** The ordered phases of the pipeline; doubles as the coarse failure category. */
type ReconcilePhase =
  | 'acquire'
  | 'trust'
  | 'verify'
  | 'observe'
  | 'compatibility'
  | 'extract'
  | 'load'
  | 'migration'
  | 'tenancy'
  | 'stage'
  | 'activate';

export interface ReconcileSummary {
  /** Extensions whose full pipeline succeeded and are now activated. */
  activated: string[];
  /** Extensions that failed a phase (optional ones; a required failure throws). */
  failed: string[];
  /** Reserved for future rollout gating; always empty today. */
  skipped: string[];
}

/**
 * Every I/O seam the reconciler touches, as a port. Production builds the real
 * set via {@link buildDefaultPorts}; tests inject fakes so the failure policy is
 * provable with no bundle/FS/DB.
 */
export interface ReconcilePorts {
  /** Load + validate the deployment config; return null when it is ABSENT. */
  loadDeploymentConfig(configPath: string): ExtensionDeploymentConfig | null;
  /**
   * Open the PRIVILEGED migration connection (same string autoMigrate uses;
   * `breeze_app` cannot issue extension DDL). Returns null when no client is
   * needed. Opened once per reconcile and closed in a finally.
   */
  createMigrationSql(): postgres.Sql | null;
  hostDescriptor: ExtensionHostDescriptor;
  acquire(source: ArtifactSource): Promise<string>;
  trustFor(config: ExtensionDeploymentConfig, publisher: string): TrustedPublisher;
  verify(
    archivePath: string,
    selection: ExtensionSelection,
    trust: TrustedPublisher,
  ): Promise<VerifiedExtensionBundle>;
  assertCompatible(manifest: ExtensionManifestV1, host: ExtensionHostDescriptor): void;
  extractVerifiedPayload(bundle: VerifiedExtensionBundle, storeRoot: string): Promise<string>;
  loadServerEntry(extractedRoot: string, entry: string): Promise<BreezeExtensionV1>;
  runMigrations(
    bundle: VerifiedExtensionBundle,
    sql: postgres.Sql | null,
    stateStore: ExtensionStateStore,
    rollout: 'rolling' | 'replace',
  ): Promise<void>;
  publishTenancy(manifest: ExtensionManifestV1): void;
  stageExtension(
    module: BreezeExtensionV1,
    manifest: ExtensionManifestV1,
  ): Promise<StagedExtensionContributions>;
  validateTenancyAndContributions(
    staged: StagedExtensionContributions,
    manifest: ExtensionManifestV1,
  ): Promise<void>;
  sweepUnaccountedTables(): Promise<void>;
}

export interface ReconcileExtensionsArgs {
  app: Hono;
  configPath: string;
  storeRoot: string;
  registry: ExtensionContributionRegistry;
  stateStore: ExtensionStateStore;
  /** Test seam: overrides merged over {@link buildDefaultPorts}. */
  ports?: Partial<ReconcilePorts>;
}

/** Generic, secret-free failure messages by phase. NEVER derived from `error`. */
const SANITIZED_MESSAGES: Record<ReconcilePhase, string> = {
  acquire: 'failed to acquire the extension artifact',
  trust: 'could not establish the extension publisher trust anchor',
  verify: 'extension bundle verification failed',
  compatibility: 'extension is not compatible with this host',
  observe: 'failed to record extension observed state',
  extract: 'failed to extract the verified extension payload',
  load: 'failed to load the extension server module',
  migration: 'extension database migrations failed',
  tenancy: 'extension tenancy validation failed',
  stage: 'failed to stage extension contributions',
  activate: 'failed to activate extension contributions',
};

/**
 * Persist a failure with a COARSE category and a fixed generic message. The raw
 * error is never inspected for its text — only its TYPE, to route an
 * incompatibility to lifecycle_state 'incompatible'. This is the security
 * chokepoint: no bundle bytes, key material, config secrets, exception text,
 * stack, or SQL can reach `installed_extensions`.
 */
export async function recordSanitizedFailure(
  stateStore: ExtensionStateStore,
  name: string,
  phase: ReconcilePhase,
  error: unknown,
): Promise<void> {
  const incompatible = error instanceof ExtensionIncompatibleError;
  await stateStore.recordFailure(name, {
    category: incompatible ? 'incompatible' : phase,
    message: SANITIZED_MESSAGES[phase],
    incompatible,
  });
}

/** The `ObservedExtensionInput` derived from a verified bundle + its selection. */
function observed(
  bundle: VerifiedExtensionBundle,
  selection: ExtensionSelection,
): ObservedExtensionInput {
  return {
    name: selection.name,
    configuredVersion: selection.version ?? bundle.manifest.version,
    digest: bundle.artifactDigest,
    publisher: selection.publisher,
    manifestApiVersion: bundle.manifest.apiVersion,
    // The manifest declares REQUIRED ranges, not a resolved version; recording
    // the declared range is the observable fact about the bundle.
    serverSdkVersion: bundle.manifest.requires.serverSdk,
    webSdkVersion: bundle.manifest.requires.webSdk ?? null,
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide whether an ALREADY-EXTRACTED tree may be reused, by re-hashing what is
 * actually on disk against `bundle.files` — the same signed inventory the
 * extractor writes from, checked with the same {@link assertVerifiedMemberBytes}.
 *
 * The `.verified` marker alone proves only that SOME process once committed this
 * directory; it says nothing about the bytes there NOW. `<storeRoot>/extracted`
 * lives on the artifact-store volume named in the threat model (writable by a
 * compromised sibling container or any non-root process), so an attacker who
 * cannot forge a signature can simply overwrite the extracted server entry and
 * wait for the next boot to `import()` it. Re-verifying here is what makes the
 * reuse shortcut as strong as a fresh extraction.
 *
 * Returns false — never throws — for a missing marker, a missing/unreadable
 * member, a hash mismatch, or an EXTRA file (an extra file is reachable: a
 * verified member may `require()` a sibling). False means "re-extract", so a
 * tampered or partial tree self-heals instead of bricking boot. Nothing derived
 * from the on-disk bytes or from a host path is surfaced.
 */
async function isExtractedTreeVerified(
  bundle: VerifiedExtensionBundle,
  dest: string,
): Promise<boolean> {
  if (!(await pathExists(path.join(dest, '.verified')))) return false;
  try {
    for (const [member, expected] of bundle.files) {
      assertVerifiedMemberBytes(member, await readFile(path.join(dest, member)), expected.sha256);
    }
    for (const entry of await readdir(dest, { recursive: true })) {
      const rel = entry.split(path.sep).join('/');
      if (rel === '.verified' || bundle.files.has(rel)) continue;
      // Directories are implied by their members; only a stray FILE is extra.
      if ((await stat(path.join(dest, entry))).isFile()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The basename of an INCOMPLETE extraction staging directory, exactly as
 * {@link extractVerifiedPayload} names it: `<dest>.tmp-<pid>-<base36 millis>`,
 * where `<dest>` is itself `sha256-<64 hex>`. Anchored at both ends.
 *
 * This pattern is the whole safety argument for the prune. A COMMITTED tree is
 * named `sha256-<hex>` with no `.tmp-` infix, so it cannot match — a committed
 * directory (with or without its `.verified` marker) is structurally out of
 * reach here, not merely skipped by a check that could be reordered away.
 * Anything else an operator or another subsystem parked under `extracted/` also
 * cannot match, so the prune only ever claims directories this extractor itself
 * created and abandoned.
 */
const STALE_EXTRACTION_TEMP_DIR = /^sha256-[0-9a-f]{64}\.tmp-\d+-[0-9a-z]+$/;

/**
 * A temp directory younger than this may belong to an extraction still running
 * in a concurrent boot, so it is left alone. Extraction is bounded by the
 * archive limits (128 MiB total), so a real one never approaches this age.
 */
const STALE_EXTRACTION_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * Remove extraction staging directories orphaned by a crash.
 *
 * {@link extractVerifiedPayload} writes into a temp directory and renames it
 * into place, so a process that dies mid-extract leaves a partial tree behind
 * that nothing else ever collects; on a long-lived volume they accumulate. This
 * runs once at reconcile start, before any extraction of our own exists.
 *
 * Deliberately conservative on every axis: it only descends into
 * `<storeRoot>/extracted`, only considers DIRECTORIES whose basename matches
 * {@link STALE_EXTRACTION_TEMP_DIR}, and only those older than
 * {@link STALE_EXTRACTION_MIN_AGE_MS}. Committed `sha256-<hex>` trees cannot
 * match the pattern.
 *
 * BOOT SAFETY: housekeeping must never be able to break startup. Every failure
 * — an unreadable root, a permission error on one entry — is logged and stepped
 * over; this function does not throw. Only our own store paths are logged (the
 * point: the operator needs to know what to remove); no bundle bytes, no secrets
 * and no raw exception objects.
 */
export async function pruneStaleExtractionDirs(
  storeRoot: string,
  now: number = Date.now(),
): Promise<number> {
  const extractedRoot = path.join(storeRoot, 'extracted');
  let entries;
  try {
    entries = await readdir(extractedRoot, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    // A store that has never extracted anything has no `extracted/` dir. That is
    // the ordinary first-boot case, not a problem worth logging.
    if (code !== 'ENOENT') {
      console.warn(
        `[extensions] could not scan ${extractedRoot} for stale extraction directories (${code ?? 'unknown error'}); continuing`,
      );
    }
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !STALE_EXTRACTION_TEMP_DIR.test(entry.name)) continue;
    const target = path.join(extractedRoot, entry.name);
    try {
      if (now - (await stat(target)).mtimeMs < STALE_EXTRACTION_MIN_AGE_MS) continue;
      await rm(target, { recursive: true, force: true });
      removed += 1;
      console.warn(`[extensions] removed stale extraction directory ${target}`);
    } catch (error) {
      console.warn(
        `[extensions] could not remove stale extraction directory ${target} (${
          (error as NodeJS.ErrnoException)?.code ?? 'unknown error'
        }); continuing`,
      );
    }
  }
  return removed;
}

/**
 * Extract a verified bundle's payload members to a content-addressed directory
 * under `<storeRoot>/extracted/sha256-<hex>`. Only members in `bundle.files` are
 * written — i.e. members the verifier already hashed against the signed
 * inventory (integrity.json / signature are excluded and unneeded at runtime).
 * Idempotent: a completed extraction is reused, but only after
 * {@link isExtractedTreeVerified} re-hashes it — the reuse path must not be the
 * one unverified way into `import()`. The write goes to a temp dir renamed into
 * place so a crash can't leave a partial tree that would then be trusted.
 *
 * The archive is re-opened here, so every member's bytes are re-hashed against
 * the digest the verifier recorded before being written (see
 * {@link assertVerifiedMemberBytes}). Without that, swapping the archive on disk
 * between verify and extract would put attacker-controlled code into a tree this
 * process then `import()`s, with the signature check having covered other bytes.
 * A mismatch throws, and the failed temp tree is removed, so nothing is
 * committed and no `.verified` marker is ever written.
 *
 * Verification happens BEFORE this function returns, and `dest` is the only
 * handle a consumer (`loadServerEntry`) ever gets, so no caller can read the
 * tree ahead of the check.
 */
export async function extractVerifiedPayload(
  bundle: VerifiedExtensionBundle,
  storeRoot: string,
): Promise<string> {
  const hex = bundle.artifactDigest.replace(/^sha256:/, '');
  const dest = path.join(storeRoot, 'extracted', `sha256-${hex}`);
  if (await isExtractedTreeVerified(bundle, dest)) return dest;
  if (await pathExists(dest)) {
    // Marker present but the bytes no longer match the signed inventory (or a
    // stray file appeared). Sanitized: name the extension, never the path or the
    // bytes. Re-extraction below replaces the tree with the verified bytes.
    console.error(
      `[extensions] extracted payload for "${
        bundle.manifest.name || 'unknown'
      }" failed its integrity re-check; re-extracting from the verified archive`,
    );
  }

  const tmp = `${dest}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await rm(tmp, { recursive: true, force: true });
  const archive = await readBoundedZipDirectory(bundle.archivePath);
  try {
    for (const [member, expected] of bundle.files) {
      const bytes = await archive.read(member);
      assertVerifiedMemberBytes(member, bytes, expected.sha256);
      const target = path.join(tmp, member);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    await writeFile(path.join(tmp, '.verified'), '');
  } catch (error) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await archive.close().catch(() => {});
  }

  // Drop the rejected tree only once a good replacement is staged, so a failed
  // re-extraction above leaves the previous state untouched rather than none.
  await rm(dest, { recursive: true, force: true }).catch(() => {});
  try {
    await rename(tmp, dest);
  } catch {
    // A concurrent boot (or a retry) already committed this digest — reuse it,
    // but only on the same re-verification the fast path uses.
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    if (await isExtractedTreeVerified(bundle, dest)) return dest;
    // Name the directory: this is OUR store path, and without it an operator has
    // no way to tell what to remove to clear the wedge. Still sanitized — no
    // bundle bytes, no raw exception.
    throw new Error(
      `failed to commit the extracted extension payload to ${dest}; `
      + 'remove that directory and restart to re-extract from the verified archive',
    );
  }
  return dest;
}

/**
 * Load a signed extension's server entry from its EXTRACTED root. The extracted
 * variant of loader.ts's private `loadEntry`.
 *
 * TRUSTED-CODE NOTE: importing the module runs its top-level code NOW — before
 * migration validation and before any tenancy check — and that code may have
 * side effects. This is a contribution preflight, not a sandbox. A load failure
 * is attributed to the extension (phase 'load'); its contributions are never
 * published unless every LATER phase also succeeds.
 */
export async function loadServerEntry(
  extractedRoot: string,
  entry: string,
): Promise<BreezeExtensionV1> {
  const target = path.join(extractedRoot, entry);
  const mod = await import(pathToFileURL(target).href);
  const ext = [mod.default?.default, mod.default?.extension, mod.default, mod.extension]
    .find((candidate): candidate is BreezeExtensionV1 => typeof candidate?.register === 'function');
  if (!ext || typeof ext.register !== 'function') {
    throw new Error(`[extensions] ${target} must default-export a BreezeExtensionV1 ({ register })`);
  }
  return ext;
}

/**
 * Stage a signed extension's contributions into an isolated session, through
 * the PUBLIC v1 SDK contract: `register(registrar, context)`. Signed bundles
 * are v1 by verification (`apiVersion: breeze.extensions/v1`), and the SDK the
 * platform publishes types their entry as {@link BreezeExtensionV1} — the
 * legacy single-argument `ExtensionContext` shape (injected auth middleware,
 * `aiTools` map, message-only `log`) remains loader.ts's path for repo-local
 * SOURCE extensions only. Staging drives the extension's REAL v1 manifest so
 * the session's declared-vs-registered checks bind to what the manifest
 * actually declares. The returned contributions are NOT live: only
 * `registry.activate` exposes them.
 */
export async function defaultStageExtension(
  module: BreezeExtensionV1,
  manifest: ExtensionManifestV1,
  registry: ExtensionContributionRegistry,
): Promise<StagedExtensionContributions> {
  const session = registry.begin(manifest);

  // The session registrar already IS the v1 ExtensionRegistrar; wrap only the
  // aiTool channel so a signed bundle can never shadow a core tool name.
  // Intra-session duplicates are the session's own concern (finish() enforces
  // declared-vs-registered parity and rejects duplicates).
  const registrar: ExtensionRegistrar = Object.freeze({
    mountRoute: (app: Parameters<ExtensionRegistrar['mountRoute']>[0]) =>
      session.registrar.mountRoute(app),
    registerJob: (job: Parameters<ExtensionRegistrar['registerJob']>[0]) =>
      session.registrar.registerJob(job),
    registerAiTool: (name: string, tool: Parameters<ExtensionRegistrar['registerAiTool']>[1]) => {
      if (hasCoreAiToolName(name)) {
        throw new Error(
          `[extensions] AI tool "${name}" already registered (extension "${manifest.name}")`,
        );
      }
      session.registrar.registerAiTool(name, tool);
    },
  });

  const context: ExtensionRuntimeContext = {
    db: db as unknown as ExtensionRuntimeContext['db'],
    secrets: {
      encryptForColumn: (table, column, plaintext) =>
        encryptSecret(plaintext, { aad: `${table}.${column}` }) ?? '',
      decryptForColumn: (table, column, ciphertext) =>
        decryptForColumn(table, column, ciphertext) ?? '',
    },
    audit: async (event) => {
      await createAuditLogAsync({
        ...event,
        initiatedBy: (event as { actorType?: string }).actorType === 'agent' ? 'agent' : 'manual',
      } as Parameters<typeof createAuditLogAsync>[0]);
    },
    // Level-first v1 logger; error/warn land on the matching console stream so
    // container log filters see them.
    log: (level, message, fields) => {
      const line = `[extensions:${manifest.name}] ${message}`;
      const args = fields === undefined ? [line] : [line, fields];
      if (level === 'error') console.error(...args);
      else if (level === 'warn') console.warn(...args);
      else console.log(...args);
    },
    config: Object.freeze({}),
  };

  await module.register(registrar, context);
  // Re-parse as a defence in depth; the bundle verifier already validated it.
  parseExtensionManifestV1(manifest);
  return session.finish();
}

/**
 * Per-extension boot-time tenancy tripwire: the RLS assertion over the
 * extension's OWN declared tables. The repo-wide unaccounted-tables sweep is
 * deliberately NOT here — it runs once after the whole reconcile loop (see
 * {@link reconcileExtensions}), because per-extension it races a concurrent
 * replica: replica B validating its FIRST extension can see the SECOND
 * extension's tables (already migrated by replica A against the shared
 * database) before B has published that second declaration, and abort a
 * perfectly healthy boot. After the loop, every replica has published tenancy
 * for every selection in the shared extensions.yaml, so the sweep is
 * order-independent across replicas. Migration safety is NOT re-checked here —
 * it is validated inside {@link reconcileExtensionMigrations}.
 */
async function defaultValidateTenancy(
  _staged: StagedExtensionContributions,
  manifest: ExtensionManifestV1,
): Promise<void> {
  await assertExtensionTenancyRls(manifest.name, manifest.tenancy);
}

function buildDefaultPorts(args: ReconcileExtensionsArgs): ReconcilePorts {
  const artifactStore = createArtifactStore();
  return {
    loadDeploymentConfig: (configPath) => {
      try {
        return loadExtensionDeploymentConfig(configPath);
      } catch (error) {
        // A MISSING file is "no extensions" (boot-safe). A present-but-invalid
        // config is a real misconfiguration and fails closed.
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
        throw error;
      }
    },
    createMigrationSql: () => {
      // The migration connection is privileged (it issues extension DDL). Never
      // substitute a guessed DSN for a missing DATABASE_URL: silently pointing
      // that connection at a default localhost database masks the actual
      // misconfiguration. Fail fast instead.
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) {
        throw new Error('DATABASE_URL is required to run extension migrations');
      }
      return postgres(databaseUrl, { max: 2 });
    },
    hostDescriptor: HOST_DESCRIPTOR,
    acquire: (source) => artifactStore.acquire(source),
    trustFor: resolveTrustedPublisher,
    verify: verifyExtensionBundle,
    assertCompatible,
    extractVerifiedPayload,
    loadServerEntry,
    runMigrations: async (bundle, sql, stateStore, rollout) => {
      if (!sql) throw new Error('migration client is unavailable');
      const migratable = await toMigratableExtension(bundle);
      await reconcileExtensionMigrations(migratable, sql, stateStore, rollout);
    },
    publishTenancy: (manifest) => registerRuntimeExtensionTenancy(manifest.tenancy),
    stageExtension: (module, manifest) =>
      defaultStageExtension(module, manifest, args.registry),
    validateTenancyAndContributions: defaultValidateTenancy,
    sweepUnaccountedTables: () => assertNoUnaccountedPublicTables(getExtensionTenancy()),
  };
}

/**
 * Reconcile every configured signed extension at startup. Resolves to a summary;
 * throws {@link RequiredExtensionError} (aborting boot) if a REQUIRED extension
 * fails any phase.
 */
export async function reconcileExtensions(
  args: ReconcileExtensionsArgs,
): Promise<ReconcileSummary> {
  const ports: ReconcilePorts = { ...buildDefaultPorts(args), ...args.ports };
  const { registry, stateStore, storeRoot } = args;
  const summary: ReconcileSummary = { activated: [], failed: [], skipped: [] };

  const config = ports.loadDeploymentConfig(args.configPath);
  if (!config || config.extensions.length === 0) {
    // Absent config OR zero extensions: clean no-op. No DB client is opened.
    return summary;
  }

  // Housekeeping, once per boot, only now that we know this deployment actually
  // uses extensions. Never throws — see pruneStaleExtractionDirs.
  await pruneStaleExtractionDirs(storeRoot);

  const sql = ports.createMigrationSql();
  try {
    for (const selection of config.extensions) {
      let phase: ReconcilePhase = 'acquire';
      try {
        const archivePath = await ports.acquire(selection);

        phase = 'trust';
        const trust = ports.trustFor(config, selection.publisher);

        phase = 'verify';
        const bundle = await ports.verify(archivePath, selection, trust);
        if (bundle.manifest.name !== selection.name) {
          throw new Error('verified manifest name does not match the configured extension name');
        }

        // Observe BEFORE the compatibility gate so a first-time extension that
        // fails compatibility still has an `installed_extensions` row for
        // recordSanitizedFailure's UPDATE to land on (otherwise it hits 0 rows
        // and the operator sees neither a row nor an 'incompatible' lifecycle).
        // Only the verified bundle + selection are needed, so this is safe here.
        phase = 'observe';
        await stateStore.upsertObserved(observed(bundle, selection));

        phase = 'compatibility';
        ports.assertCompatible(bundle.manifest, ports.hostDescriptor);

        phase = 'extract';
        const extractedRoot = await ports.extractVerifiedPayload(bundle, storeRoot);

        phase = 'load';
        const module = await ports.loadServerEntry(extractedRoot, bundle.manifest.server.entry);

        phase = 'migration';
        await ports.runMigrations(bundle, sql, stateStore, selection.rollout);

        // Publish tenancy declarations the instant migrations succeed — before
        // staging/activation — so cascade/device-move handling for the tables
        // that now exist survives a later stage/validate failure or a disable.
        phase = 'tenancy';
        ports.publishTenancy(bundle.manifest);

        phase = 'stage';
        const staged = await ports.stageExtension(module, bundle.manifest);

        phase = 'tenancy';
        await ports.validateTenancyAndContributions(staged, bundle.manifest);

        phase = 'activate';
        registry.activate({
          ...staged,
          enabled: await stateStore.isEnabled(selection.name),
        });
        if (staged.routeApp && bundle.manifest.agentRoutes === true) {
          registerGlobalRateLimitSkipPrefix(`/api/v1/ext/${selection.name}/agent/`);
          registerGlobalRateLimitSkipPrefix(`/api/v1/${bundle.manifest.routeNamespace}/agent/`);
        }
        await stateStore.recordActive(selection.name, bundle.manifest.version);

        // Record the extracted root so a later process fault whose stack points
        // into this extension's loaded code can be attributed to it. Populated
        // only on FULL success; cleared on withdraw (the catch below).
        registerExtensionRoot(selection.name, extractedRoot);

        // Retain the verified bundle's digest + files inventory alongside the
        // root — the single source a later asset route reads to serve this
        // extension's web/* files. Same success condition, same withdraw/failure
        // clear path (the catch below) as registerExtensionRoot/clearExtensionRoot.
        registerExtensionWebAsset(selection.name, {
          root: extractedRoot,
          digest: bundle.artifactDigest,
          files: bundle.files,
        });

        summary.activated.push(selection.name);
        console.log(`[extensions] reconciled "${selection.name}" ${bundle.manifest.version}`);
      } catch (error) {
        // Recording the failure is best-effort recovery bookkeeping and MUST
        // NOT itself abort boot. A transient DB error here (plausibly the very
        // condition that failed an earlier phase) would otherwise propagate out
        // of this catch and take the whole API down — even for an OPTIONAL
        // extension, defeating the isolation the required/optional split exists
        // to provide. For a REQUIRED extension we still abort, but via the
        // sanitized RequiredExtensionError below (never the raw DB error, which
        // the boot logger could leak).
        try {
          await recordSanitizedFailure(stateStore, selection.name, phase, error);
        } catch {
          console.error(
            `[extensions] failed to record reconcile failure for "${selection.name}" at phase "${phase}"`,
          );
        }
        registry.withdraw(selection.name);
        clearExtensionRoot(selection.name);
        clearExtensionWebAsset(selection.name);
        summary.failed.push(selection.name);
        console.error(
          `[extensions] reconcile failed for "${selection.name}" at phase "${phase}" (${
            selection.required ? 'required' : 'optional'
          })`,
        );
        if (selection.required) {
          // Pass only the coarse phase — NEVER the raw `error` as `cause`. The
          // raw error was already consumed above to write the sanitized DB
          // record; threading it onto the thrown error would let Node's
          // cause-chain printer leak it to the boot logger (index.ts).
          throw new RequiredExtensionError(selection.name, phase);
        }
      }
    }

    // Repo-wide unaccounted-tables catch-all, ONCE per boot after the loop —
    // not per extension, which races a concurrent replica (see
    // defaultValidateTenancy's doc comment). By this point tenancy is
    // published for every selection whose migrations succeeded, including
    // optional extensions later withdrawn at stage/validate (publishTenancy
    // lands the moment migrations succeed, precisely so their tables stay
    // accounted for). Throws raw and aborts boot — the same fail-closed
    // contract as the legacy disk loader's boot-time call in loader.ts; the
    // tripwire's message is secret-free by design.
    await ports.sweepUnaccountedTables();
  } finally {
    if (sql) await sql.end();
  }

  return summary;
}
