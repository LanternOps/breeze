// Legacy source-directory extensions register against an isolated staging
// adapter. The stable gateway owns routing and auth; this loader publishes no
// route or AI contribution until all registration and tenancy checks pass.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
import { discoverExtensions, type DiscoveredExtension } from './discovery';
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

/**
 * Adapts source-directory extensions to the staged v1 contribution registry.
 * No route or AI contribution becomes live until every extension has
 * registered, validated, and passed both tenancy tripwires.
 */
export async function loadSourceExtensions(
  registry: ExtensionContributionRegistry,
  root?: string,
): Promise<void> {
  if (process.env.BREEZE_EXTENSIONS_ENABLED === 'false') {
    console.log('[extensions] disabled via BREEZE_EXTENSIONS_ENABLED=false');
    return;
  }

  const discovered = discoverExtensions(root);
  if (discovered.length === 0) return;

  const staged: StagedExtensionContributions[] = [];
  for (const extension of discovered) {
    const contributions = await stageLegacyExtension(extension, registry);
    await assertExtensionTenancyRls(extension.name, extension.manifest.tenancy);
    staged.push(contributions);
  }

  await assertNoUnaccountedPublicTables(discovered.map((extension) => extension.manifest.tenancy));

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
