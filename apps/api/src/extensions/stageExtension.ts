// The host side of the v1 extension registration contract: turn an extension's
// entry module into an isolated, NOT-yet-live set of staged contributions.
//
// This is the single staging seam for the one surviving delivery path —
// BUILT-IN extensions, statically compiled into the core image and loaded by
// builtinExtensions.ts. It was extracted from the (now deleted) signed
// runtime-bundle reconciler, which used the identical seam; nothing about
// staging was ever specific to how the code arrived.
import {
  parseExtensionManifestV1,
  type BreezeExtensionV1,
  type ExtensionManifestV1,
  type ExtensionRegistrar,
  type ExtensionRuntimeContext,
} from '@breeze/extension-sdk';
import {
  ExtensionContributionRegistry,
  type StagedExtensionContributions,
} from './contributionRegistry';
// Leaf module — NOT '../services/aiTools' (the ~45-domain-module tool
// registry hub, which reaches routes/agentWs.ts via aiToolsBackup.ts ->
// commandQueue.ts). See services/aiToolNames.ts's header (#4086 Task 5).
import { hasCoreAiToolName } from '../services/aiToolNames';
import { db } from '../db';
import { createAuditLogAsync } from '../services/auditService';
import { decryptForColumn, encryptSecret } from '../services/secretCrypto';
import { buildExtensionAiContext } from '../services/extensionAi';

/**
 * Stage an extension's contributions into an isolated session, through the
 * PUBLIC v1 SDK contract: `register(registrar, context)`. Staging drives the
 * extension's REAL v1 manifest so the session's declared-vs-registered checks
 * bind to what the manifest actually declares. The returned contributions are
 * NOT live: only `registry.activate` exposes them.
 *
 * `opts.helperRoutes` stages the legacy `helperRoutes` flag ON TOP of the
 * manifest: the gateway reads the flag off the STAGED manifest to apply core
 * helper auth to `/helper/*` (gateway.ts), but the flag is not part of the
 * strict v1 wire schema, so the CLEAN manifest — never the augmented one — is
 * what `parseExtensionManifestV1` validates below.
 */
export async function defaultStageExtension(
  module: BreezeExtensionV1,
  manifest: ExtensionManifestV1,
  registry: ExtensionContributionRegistry,
  opts: { helperRoutes?: boolean } = {},
): Promise<StagedExtensionContributions> {
  const stagedManifest: ExtensionManifestV1 = opts.helperRoutes
    ? ({ ...manifest, helperRoutes: true } as ExtensionManifestV1 & { helperRoutes: true })
    : manifest;
  const session = registry.begin(stagedManifest);

  // The session registrar already IS the v1 ExtensionRegistrar; wrap only the
  // aiTool channel so an extension can never shadow a core tool name.
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
    ai: buildExtensionAiContext(),
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
    tenancy: {
      // The host has no per-org install gate: every extension it loads is
      // server-scoped, so there is no per-org install SET to hand back. This
      // throws rather than returning `[]` — an empty array means "activated for
      // no orgs", and a sweep that read it that way would silently do nothing.
      installedOrgs: async () => {
        throw new Error(
          `[extensions] "${manifest.name}" is server-scoped; this host has no per-org `
          + 'install set, so installedOrgs() is not available',
        );
      },
    },
  };

  await module.register(registrar, context);
  // Re-parse as a defence in depth; the loading path already validated it.
  parseExtensionManifestV1(manifest);
  return session.finish();
}
