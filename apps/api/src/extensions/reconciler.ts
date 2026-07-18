// The startup reconciler for SIGNED runtime-extension bundles.
//
// For each configured extension it runs an explicit phase pipeline —
// acquire → trust → verify → compatibility → observe → extract → load →
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
import {
  createPublicKey,
  type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import type { Hono } from 'hono';
import type {
  AiToolLike,
  BreezeExtension,
  ExtensionContext,
  ExtensionDatabase,
} from '@breeze/extension-api';
import {
  parseExtensionManifestV1,
  type ExtensionManifestV1,
} from '@breeze/extension-sdk';
import {
  loadExtensionDeploymentConfig,
  type ExtensionDeploymentConfig,
  type ExtensionSelection,
} from './config';
import { createArtifactStore, type ArtifactSource } from './artifactStore';
import {
  readBoundedZipDirectory,
  verifyExtensionBundle,
  type TrustedPublisher,
  type VerifiedExtensionBundle,
} from './bundleVerifier';
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
import {
  legacyExtensionAgentAuthMiddleware,
  legacyExtensionAuthMiddleware,
} from './gateway';
import { registerGlobalRateLimitSkipPrefix } from '../middleware/globalRateLimit';
import { aiTools, hasCoreAiToolName } from '../services/aiTools';
import { db } from '../db';
import { createAuditLogAsync } from '../services/auditService';
import { decryptForColumn, encryptSecret } from '../services/secretCrypto';
import { ExtensionIncompatibleError, RequiredExtensionError } from './errors';

/** The ordered phases of the pipeline; doubles as the coarse failure category. */
type ReconcilePhase =
  | 'acquire'
  | 'trust'
  | 'verify'
  | 'compatibility'
  | 'observe'
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
  loadServerEntry(extractedRoot: string, entry: string): Promise<BreezeExtension>;
  runMigrations(
    bundle: VerifiedExtensionBundle,
    sql: postgres.Sql | null,
    stateStore: ExtensionStateStore,
    rollout: 'rolling' | 'replace',
  ): Promise<void>;
  publishTenancy(manifest: ExtensionManifestV1): void;
  stageExtension(
    module: BreezeExtension,
    manifest: ExtensionManifestV1,
  ): Promise<StagedExtensionContributions>;
  validateTenancyAndContributions(
    staged: StagedExtensionContributions,
    manifest: ExtensionManifestV1,
  ): Promise<void>;
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
 * Extract a verified bundle's payload members to a content-addressed directory
 * under `<storeRoot>/extracted/sha256-<hex>`. Only members in `bundle.files` are
 * written — i.e. members the verifier already hashed against the signed
 * inventory (integrity.json / signature are excluded and unneeded at runtime).
 * Idempotent: a completed extraction (marked by `.verified`) is reused. The
 * write goes to a temp dir renamed into place so a crash can't leave a partial
 * tree that the `.verified` check would then trust.
 */
export async function extractVerifiedPayload(
  bundle: VerifiedExtensionBundle,
  storeRoot: string,
): Promise<string> {
  const hex = bundle.artifactDigest.replace(/^sha256:/, '');
  const dest = path.join(storeRoot, 'extracted', `sha256-${hex}`);
  if (await pathExists(path.join(dest, '.verified'))) return dest;

  const tmp = `${dest}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await rm(tmp, { recursive: true, force: true });
  const archive = await readBoundedZipDirectory(bundle.archivePath);
  try {
    for (const member of bundle.files.keys()) {
      const bytes = await archive.read(member);
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

  try {
    await rename(tmp, dest);
  } catch {
    // A concurrent boot (or a retry) already committed this digest — reuse it.
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    if (await pathExists(path.join(dest, '.verified'))) return dest;
    throw new Error('failed to commit the extracted extension payload');
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
): Promise<BreezeExtension> {
  const target = path.join(extractedRoot, entry);
  const mod = await import(pathToFileURL(target).href);
  const ext = [mod.default?.default, mod.default?.extension, mod.default, mod.extension]
    .find((candidate): candidate is BreezeExtension => typeof candidate?.register === 'function');
  if (!ext || typeof ext.register !== 'function') {
    throw new Error(`[extensions] ${target} must default-export a BreezeExtension ({ register })`);
  }
  return ext;
}

/**
 * Stage a signed extension's contributions into an isolated session. Mirrors the
 * ExtensionContext wiring in loader.ts (mountRoute / auth / db / secrets / audit
 * / aiTools / log) but drives the extension's REAL v1 manifest — so the session's
 * declared-vs-registered checks bind to what the manifest actually declares. The
 * returned contributions are NOT live: only `registry.activate` exposes them.
 */
async function defaultStageExtension(
  module: BreezeExtension,
  manifest: ExtensionManifestV1,
  registry: ExtensionContributionRegistry,
): Promise<StagedExtensionContributions> {
  const session = registry.begin(manifest);
  const stagedAiTools = new Map<string, AiToolLike>(aiTools as Map<string, AiToolLike>);

  // Same collision-guarding proxy as the legacy loader, minus the manifest
  // mutation: a signed manifest already DECLARES its aiTools, so registrations
  // must match the declaration (the session's finish() enforces that) rather
  // than grow it.
  const stagedAiToolMap = new Proxy(stagedAiTools, {
    get(target, prop) {
      if (prop === 'set') {
        return (key: string, value: AiToolLike) => {
          if (hasCoreAiToolName(key) || target.has(key)) {
            throw new Error(
              `[extensions] AI tool "${key}" already registered (extension "${manifest.name}")`,
            );
          }
          session.registrar.registerAiTool(key, value);
          target.set(key, value);
          return stagedAiToolMap;
        };
      }
      if (prop === 'delete' || prop === 'clear') {
        return () => {
          throw new Error('[extensions] AI tool staging does not support delete or clear');
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const context: ExtensionContext = {
    mountRoute: (subApp) => session.registrar.mountRoute(subApp),
    authMiddleware: legacyExtensionAuthMiddleware,
    agentAuthMiddleware: legacyExtensionAgentAuthMiddleware,
    db: db as unknown as ExtensionDatabase,
    secrets: {
      encryptForColumn: (table, column, plaintext) =>
        encryptSecret(plaintext, { aad: `${table}.${column}` }) ?? '',
      decryptForColumn: (table, column, ciphertext) =>
        decryptForColumn(table, column, ciphertext) ?? '',
    },
    audit: (event) => createAuditLogAsync({
      ...event,
      initiatedBy: event.actorType === 'agent' ? 'agent' : 'manual',
    }),
    aiTools: stagedAiToolMap,
    log: (message) => console.log(`[extensions:${manifest.name}] ${message}`),
  };

  await module.register(context);
  // Re-parse as a defence in depth; the bundle verifier already validated it.
  parseExtensionManifestV1(manifest);
  return session.finish();
}

/**
 * Compose the two boot-time tenancy tripwires for a single extension: the
 * per-extension RLS assertion, then the repo-wide unaccounted-tables sweep over
 * ALL registered tenancy (this extension's declaration was already published, so
 * the sweep sees it). Migration safety is NOT re-checked here — it is validated
 * inside {@link reconcileExtensionMigrations}.
 */
async function defaultValidateTenancy(
  _staged: StagedExtensionContributions,
  manifest: ExtensionManifestV1,
): Promise<void> {
  await assertExtensionTenancyRls(manifest.name, manifest.tenancy);
  await assertNoUnaccountedPublicTables(getExtensionTenancy());
}

/** Resolve a publisher's public key into a {@link TrustedPublisher}. */
function defaultTrustFor(
  config: ExtensionDeploymentConfig,
  publisher: string,
): TrustedPublisher {
  const declared = config.publishers[publisher];
  if (!declared) {
    throw new Error(`unknown publisher "${publisher}"`);
  }
  const pem = readFileSync(declared.publicKeyFile);
  const publicKey: KeyObject = createPublicKey(pem);
  return { publisher, publicKey };
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
    createMigrationSql: () => postgres(
      process.env.DATABASE_URL || 'postgresql://breeze:breeze@localhost:5432/breeze',
      { max: 2 },
    ),
    hostDescriptor: HOST_DESCRIPTOR,
    acquire: (source) => artifactStore.acquire(source),
    trustFor: defaultTrustFor,
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

        phase = 'compatibility';
        ports.assertCompatible(bundle.manifest, ports.hostDescriptor);

        phase = 'observe';
        await stateStore.upsertObserved(observed(bundle, selection));

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

        summary.activated.push(selection.name);
        console.log(`[extensions] reconciled "${selection.name}" ${bundle.manifest.version}`);
      } catch (error) {
        await recordSanitizedFailure(stateStore, selection.name, phase, error);
        registry.withdraw(selection.name);
        summary.failed.push(selection.name);
        console.error(
          `[extensions] reconcile failed for "${selection.name}" at phase "${phase}" (${
            selection.required ? 'required' : 'optional'
          })`,
        );
        if (selection.required) {
          throw new RequiredExtensionError(selection.name, { cause: error });
        }
      }
    }
  } finally {
    if (sql) await sql.end();
  }

  return summary;
}
