// Legacy source-directory extensions register against an isolated staging
// adapter. The stable gateway owns routing and auth; this loader publishes no
// route or AI contribution until all registration and tenancy checks pass.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { load as loadYaml } from 'js-yaml';
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
  discoverExtensions,
  listSourceExtensionCandidates,
  resolveExtensionsRoot,
  type DiscoveredExtension,
} from './discovery';
import {
  ExtensionContributionRegistry,
  type StagedExtensionContributions,
} from './contributionRegistry';
import {
  legacyExtensionAgentAuthMiddleware,
  legacyExtensionAuthMiddleware,
  legacyExtensionHelperAuthMiddleware,
} from './gateway';
import { assertExtensionTenancyRls, assertNoUnaccountedPublicTables } from './tenancyTripwire';
import { aiTools, hasCoreAiToolName } from '../services/aiTools';
import { db } from '../db';
import { createAuditLogAsync } from '../services/auditService';
import { decryptForColumn, encryptSecret } from '../services/secretCrypto';
import { registerGlobalRateLimitSkipPrefix } from '../middleware/globalRateLimit';

async function loadEntry(dir: string, entry: string): Promise<BreezeExtension> {
  const manifestEntry = path.join(dir, entry);
  const prodEntry = path.join(dir, 'dist', 'index.cjs');
  const target = process.env.NODE_ENV === 'production'
    ? (existsSync(prodEntry) ? prodEntry : manifestEntry)
    : (existsSync(manifestEntry) ? manifestEntry : prodEntry);
  const mod = await import(pathToFileURL(target).href);
  const ext = [mod.default?.default, mod.default?.extension, mod.default, mod.extension]
    .find((candidate): candidate is BreezeExtension => typeof candidate?.register === 'function');
  if (!ext || typeof ext.register !== 'function') {
    throw new Error(`[extensions] ${target} must default-export a BreezeExtension ({ register })`);
  }
  return ext;
}

/**
 * The staged manifest carries the legacy `helperRoutes` flag for the gateway's
 * auth guard, but the flag is NOT part of the v1 wire schema yet — it must be
 * stripped before `parseExtensionManifestV1` (strict) validates the rest.
 * TODO(runtime-platform): drop this once helperRoutes lands in the v1 manifest
 * as capability 'server.helper-routes.v1' (see the TODO in
 * packages/extension-sdk/src/manifest.ts).
 */
type StagedLegacyManifest = ExtensionManifestV1 & { helperRoutes?: boolean };

function synthesizeLegacyManifest(extension: DiscoveredExtension): StagedLegacyManifest {
  return {
    apiVersion: 'breeze.extensions/v1',
    name: extension.name,
    version: '0.0.0',
    routeNamespace: extension.manifest.routeNamespace,
    requires: {
      breeze: '*',
      serverSdk: '^1.0.0',
      capabilities: ['server.routes.v1'],
    },
    server: { entry: 'dist/index.cjs' },
    migrationsDir: extension.manifest.migrationsDir,
    schemaCompatibilityFloor: '0.0.0',
    publicRoutes: extension.manifest.publicRoutes,
    agentRoutes: extension.manifest.agentRoutes,
    helperRoutes: extension.manifest.helperRoutes,
    jobs: [],
    aiTools: [],
    tenancy: extension.manifest.tenancy,
  };
}

async function stageLegacyExtension(
  extension: DiscoveredExtension,
  registry: ExtensionContributionRegistry,
): Promise<StagedExtensionContributions> {
  const loaded = await loadEntry(extension.dir, extension.manifest.entry);
  const manifest = synthesizeLegacyManifest(extension);
  const session = registry.begin(manifest);
  const stagedAiTools = new Map<string, AiToolLike>(aiTools as Map<string, AiToolLike>);

  const stagedAiToolMap = new Proxy(stagedAiTools, {
    get(target, prop) {
      if (prop === 'set') {
        return (key: string, value: AiToolLike) => {
          if (hasCoreAiToolName(key) || target.has(key)) {
            throw new Error(
              `[extensions] AI tool "${key}" already registered (extension "${extension.name}")`,
            );
          }
          manifest.aiTools.push({ name: key });
          session.registrar.registerAiTool(key, value);
          target.set(key, value);
          return stagedAiToolMap;
        };
      }
      if (prop === 'delete' || prop === 'clear') {
        return () => {
          throw new Error('[extensions] legacy AI tool staging does not support delete or clear');
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const context: ExtensionContext = {
    mountRoute: (subApp) => session.registrar.mountRoute(subApp),
    // Source-dir legacy extensions synthesize `jobs: []`, so there is no manifest
    // declaration a registration could match. Fail LOUDLY and immediately rather
    // than passing through to a declared-vs-registered mismatch that only
    // surfaces later — the author needs a signed bundle with declared `jobs`.
    registerJob: () => {
      throw new Error(
        `[extensions] source-dir extensions cannot register jobs (extension "${extension.name}"); package it as a signed bundle with declared manifest jobs`,
      );
    },
    authMiddleware: legacyExtensionAuthMiddleware,
    agentAuthMiddleware: legacyExtensionAgentAuthMiddleware,
    helperAuthMiddleware: legacyExtensionHelperAuthMiddleware,
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
    log: (message) => console.log(`[extensions:${extension.name}] ${message}`),
  };

  await loaded.register(context);
  const { helperRoutes: _legacyHelperRoutes, ...v1Manifest } = manifest;
  parseExtensionManifestV1(v1Manifest);
  return session.finish();
}

const DEPRECATION_DOCS = 'docs/extensions/build-time-transition.md';

/**
 * Names declared in the runtime deployment config (`extensions.yaml`) in the
 * same extensions root. Only names are extracted — full validation stays the
 * reconciler's job (config.ts) — but a PRESENT-yet-unreadable file fails
 * closed: the same-name gate cannot prove the absence of a collision.
 */
function declaredRuntimeExtensionNames(root: string): Set<string> {
  const configPath = path.join(root, 'extensions.yaml');
  if (!existsSync(configPath)) return new Set();
  let raw: unknown;
  try {
    raw = loadYaml(readFileSync(configPath, 'utf8'));
  } catch {
    // Never surface the raw parser exception (it can echo file contents).
    throw new Error('[extensions] extensions.yaml is not valid YAML');
  }
  const names = new Set<string>();
  const extensions = (raw as { extensions?: unknown } | null)?.extensions;
  if (Array.isArray(extensions)) {
    for (const entry of extensions) {
      const name = (entry as { name?: unknown } | null)?.name;
      if (typeof name === 'string') names.add(name);
    }
  }
  return names;
}

/**
 * Adapts source-directory extensions to the staged v1 contribution registry.
 * No route or AI contribution becomes live until every extension has
 * registered, validated, and passed both tenancy tripwires.
 *
 * DEPRECATED delivery path (compatibility window): source-directory loading is
 * gated behind BREEZE_LEGACY_SOURCE_EXTENSIONS=true and will be removed — see
 * docs/extensions/build-time-transition.md for the dated gate. Signed runtime
 * bundles (extensions.yaml + reconcileExtensions) are the supported path.
 */
export async function loadSourceExtensions(
  registry: ExtensionContributionRegistry,
  root?: string,
): Promise<void> {
  if (process.env.BREEZE_EXTENSIONS_ENABLED === 'false') {
    console.log('[extensions] disabled via BREEZE_EXTENSIONS_ENABLED=false');
    return;
  }

  const resolvedRoot = root ?? resolveExtensionsRoot();

  if (process.env.BREEZE_LEGACY_SOURCE_EXTENSIONS !== 'true') {
    // Candidate scan only — no manifest parsing, so a broken manifest on the
    // disabled legacy path cannot fail the boot.
    for (const name of listSourceExtensionCandidates(resolvedRoot)) {
      console.warn(
        `[extensions] ${JSON.stringify({
          event: 'legacy_source_extension_skipped',
          extension: name,
          reason: 'source-directory extension loading is deprecated and disabled by default',
          enableFlag: 'BREEZE_LEGACY_SOURCE_EXTENSIONS',
          docs: DEPRECATION_DOCS,
        })}`,
      );
    }
    return;
  }

  const discovered = discoverExtensions(resolvedRoot);
  if (discovered.length === 0) return;

  // Same-name simultaneity gate. registry.activate() REPLACES a same-name
  // snapshot, so a signed runtime artifact reconciled after this loader would
  // silently shadow the source extension — and a failed optional artifact
  // would withdraw the source extension's live routes. One delivery path per
  // name; fail the boot before staging anything.
  const runtimeNames = declaredRuntimeExtensionNames(resolvedRoot);
  for (const extension of discovered) {
    if (runtimeNames.has(extension.name)) {
      throw new Error(
        `[extensions] "${extension.name}" is present as a legacy source directory AND declared as a runtime artifact in extensions.yaml; a source-directory extension cannot be enabled simultaneously with a runtime artifact of the same name — remove the source directory or the extensions.yaml entry`,
      );
    }
  }

  const staged: StagedExtensionContributions[] = [];
  for (const extension of discovered) {
    console.warn(
      `[extensions] DEPRECATION ${JSON.stringify({
        event: 'legacy_source_extension_loaded',
        extension: extension.name,
        message: 'source-directory extension loading is deprecated and will be removed; ship a signed runtime bundle instead',
        docs: DEPRECATION_DOCS,
      })}`,
    );
    const contributions = await stageLegacyExtension(extension, registry);
    await assertExtensionTenancyRls(extension.name, extension.manifest.tenancy);
    staged.push(contributions);
  }

  // Repo-wide sweep — but only when this loader is the ONLY extension path on
  // this boot. When extensions.yaml also declares runtime artifacts, their
  // tables (migrated on a prior boot) already exist while their tenancy is
  // published only later by reconcileExtensions — sweeping here would misread
  // them as unaccounted and abort a healthy boot. The reconciler runs this
  // same sweep once per boot AFTER publishing runtime tenancy, over
  // getExtensionTenancy()'s union of source manifests and runtime
  // declarations, so deferring keeps the fail-closed contract.
  if (runtimeNames.size === 0) {
    await assertNoUnaccountedPublicTables(discovered.map((extension) => extension.manifest.tenancy));
  }

  const aiToolOwners = new Map<string, string>();
  for (const contributions of staged) {
    for (const name of contributions.aiTools.keys()) {
      const owner = aiToolOwners.get(name);
      if (owner) {
        throw new Error(
          `[extensions] AI tool "${name}" is registered by both "${owner}" and "${contributions.name}"`,
        );
      }
      aiToolOwners.set(name, contributions.name);
    }
  }

  for (const contributions of staged) {
    registry.activate(contributions);
    if (contributions.routeApp && contributions.manifest.agentRoutes === true) {
      registerGlobalRateLimitSkipPrefix(`/api/v1/ext/${contributions.name}/agent/`);
      registerGlobalRateLimitSkipPrefix(
        `/api/v1/${contributions.manifest.routeNamespace}/agent/`,
      );
    }
    console.log(
      contributions.routeApp
        ? `[extensions] activated "${contributions.name}" at /api/v1/ext/${contributions.name}`
        : `[extensions] activated "${contributions.name}" (no routes registered)`,
    );
  }
}
