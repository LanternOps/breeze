import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * Scaling W05 follow-up 1 (#8636; spec W4): every module-level cache is classified.
 *
 * The API runs as several replicas. A per-process cache is only correct there
 * if it is classified into one of four kinds, and the class decides what a
 * stale entry on ANOTHER replica can do:
 *
 * - `cluster`: a writer invalidates it, so other replicas must drop their entry
 *   too. Registered on the W05 cluster cache bus under `name` (a
 *   `HotPathTtlCache` with `cluster: true`, `registerClusterInvalidator`, or a
 *   hand `registerClusterCache`), so an invalidation reaches every API and
 *   worker process within about 1 s, after commit. Rule of thumb: **if any
 *   writer invalidates or refreshes this process's copy, the cache is
 *   `cluster`**: the writer has already decided that serving the old value
 *   after the write is wrong.
 * - `redis-coherent`: coherent across replicas through its own Redis
 *   mechanism (`via`), not the bus.
 * - `process-local`: safe to diverge per replica. `reason` states the bound:
 *   no writer invalidates it (TTL-only everywhere, the writing replica
 *   included), the value is per-host (env, filesystem, build) or code-derived,
 *   it is a third-party token or key fetched with credentials that are part of
 *   the key, or it is a fallback that production never uses.
 * - `not-a-cache`: the detector matched a name that holds no cached data.
 *
 * Detection (`findCacheDeclarations`): a column-0 `const`/`let`/`var` in
 * `apps/api/src` or `ee/workspace/src` (not tests) whose declaration holds
 * state — a `let`/`var`, or a `const` initialized with `new …` — and whose name
 * contains the word cache/cached/memo, or whose constructor is `*Cache`, or a
 * `Map` whose entry type carries an expiry (`expiresAt`, `fetchedAt`, `ttl…`,
 * `*CacheEntry`, `Cached*`). Caches held in class fields or built inside a
 * function are out of scope (their owning singleton is what gets classified).
 *
 * A new cache fails here until someone decides which kind it is.
 */

type Classification =
  | { kind: 'cluster'; name: string }
  | { kind: 'redis-coherent'; via: string }
  | { kind: 'process-local'; reason: string }
  | { kind: 'not-a-cache'; reason: string };

const ENV = 'derived from env/config read at boot; identical on every replica of one deploy';
const CODE = 'built from in-code registries; identical for one build';
const TOKEN = 'third-party access token; the credentials that mint it are in the key or re-read per call, so a stale token is only a stale bearer of the same grant';
const JWKS = 'remote JWKS key set (jose handles key rotation by refetching on an unknown kid)';
const SINGLETON = 'lazily constructed client/service singleton; no cached data';

const CACHES: Record<string, Classification> = {
  // ── cluster: invalidated on every replica through the W05 bus ──────────────
  'apps/api/src/services/agentOrgSettingsCache.ts#orgAgentUpdateConfigCache': { kind: 'cluster', name: 'org-agent-update-config' },
  'apps/api/src/services/agentOrgSettingsCache.ts#orgTopologyFlagsCache': { kind: 'cluster', name: 'org-topology-flags' },
  'apps/api/src/services/agentOrgSettingsCache.ts#orgPolicyProbeCache': { kind: 'cluster', name: 'org-policy-probe' },
  'apps/api/src/services/agentOrgSettingsCache.ts#orgHelperSettingsCache': { kind: 'cluster', name: 'org-helper-legacy-settings' },
  'apps/api/src/services/agentOrgSettingsCache.ts#orgPamFallbackCache': { kind: 'cluster', name: 'org-pam-fallback' },
  'apps/api/src/services/manifestSigning.ts#trustKeysetCache': { kind: 'cluster', name: 'manifest-trust-keyset' },
  'apps/api/src/services/manifestSigning.ts#delegationRowsCache': { kind: 'cluster', name: 'manifest-key-delegations' },
  'apps/api/src/services/unifi/unifiCollectorService.ts#agentCollectorAbsenceCache': { kind: 'cluster', name: 'unifi-agent-collector-absence' },
  'apps/api/src/services/trustPage/attestationKeys.ts#keysetCache': { kind: 'cluster', name: 'trust-attestation-keyset' },
  'apps/api/src/services/entitlements.ts#cache': { kind: 'cluster', name: 'partner-entitlements' },
  // #8636: writers invalidated only their own process before this change.
  'apps/api/src/oauth/partnerScopePolicy.ts#policyCache': { kind: 'cluster', name: 'partner-oauth-scope-policy' },
  'apps/api/src/services/ipAllowlist.ts#cache': { kind: 'cluster', name: 'partner-ip-allowlist' },
  'apps/api/src/services/ipAllowlist.ts#cacheGeneration': { kind: 'cluster', name: 'partner-ip-allowlist' },
  'apps/api/src/services/remoteAccessPolicy.ts#cache': { kind: 'cluster', name: 'device-remote-access-policy' },
  'apps/api/src/services/remoteAccessPolicy.ts#cacheGeneration': { kind: 'cluster', name: 'device-remote-access-policy' },
  'apps/api/src/services/llmProviderCatalog.ts#listedProvidersCache': { kind: 'cluster', name: 'llm-provider-catalog' },
  'apps/api/src/services/llmProviderCatalog.ts#listedProvidersCacheLoadedAt': { kind: 'cluster', name: 'llm-provider-catalog' },
  'apps/api/src/services/llmProviderCatalog.ts#listedProvidersCacheEpoch': { kind: 'cluster', name: 'llm-provider-catalog' },
  'apps/api/src/services/thirdPartyEnrichment.ts#cache': { kind: 'cluster', name: 'third-party-package-catalog' },
  'apps/api/src/services/thirdPartyEnrichment.ts#cacheLoadedAt': { kind: 'cluster', name: 'third-party-package-catalog' },
  'apps/api/src/services/thirdPartyEnrichment.ts#cacheGeneration': { kind: 'cluster', name: 'third-party-package-catalog' },
  'apps/api/src/services/wisp/standingStateTurn.ts#factsCache': { kind: 'cluster', name: 'wisp-standing-state-facts' },
  'apps/api/src/services/aiModels/gatewayConnectionState.ts#cache': { kind: 'cluster', name: 'ai-gateway-connection-state' },
  'apps/api/src/services/aiModels/gatewayConnectionState.ts#cacheGeneration': { kind: 'cluster', name: 'ai-gateway-connection-state' },
  'apps/api/src/services/aiKillState.ts#cachedSnapshot': { kind: 'cluster', name: 'ai-kill-state' },
  'apps/api/src/services/aiKillState.ts#cachedAt': { kind: 'cluster', name: 'ai-kill-state' },

  // ── redis-coherent ─────────────────────────────────────────────────────────
  'apps/api/src/services/permissions.ts#permissionCache': { kind: 'redis-coherent', via: 'Redis permission-cache version keys compared on every read (clearPermissionCache bumps them); TTL-only while Redis is down, like the bus' },

  // ── process-local: TTL-bounded, and no writer invalidates it on any replica ─
  'apps/api/src/middleware/agentAuthNegativeCache.ts#agentAuthNegativeCache': { kind: 'process-local', reason: 'negative auth cache keyed by agentId + token hash, 60 s, no writer invalidates it; a replica without the entry just does the DB lookup, a stale entry only delays reinstatement (fail-closed)' },
  'apps/api/src/services/deviceSiteResolver.ts#cache': { kind: 'process-local', reason: 'deviceId → siteId, 60 s, no writer invalidates it on any replica (the writing one included); a miss fails open to no site attribution' },
  'apps/api/src/routes/agentWs.ts#terminalOutputOwnerCache': { kind: 'process-local', reason: 'sessionId → deviceId for cross-tenant-probe counting, 30 s, never a source of truth; no writer invalidates it' },
  'apps/api/src/services/agentEditionAutoMigrate.ts#targetCache': { kind: 'process-local', reason: 'resolved migration target per os/arch/pin, 60 s, no writer invalidates it; the pin is part of the key and the staged-version check runs after it' },
  'apps/api/src/services/onedriveGraph.ts#groupMembershipCache': { kind: 'process-local', reason: 'orgId:upn → Graph group ids; the source is Microsoft Graph, which no Breeze writer changes; TTL-bounded on every replica alike' },
  'apps/api/src/services/promptIdentityLogo.ts#memo': { kind: 'process-local', reason: 'L1 in front of a Redis logo cache, 60 s, max 64; logos are fetched from a URL, no writer invalidates it' },
  'apps/api/src/services/latestVersion.ts#cache': { kind: 'process-local', reason: 'latest GitHub release, 1 h; not tenant data, no writer' },
  'apps/api/src/services/backupStorageCredentialHistory.ts#cachedEnforcementMoment': { kind: 'process-local', reason: 'migration-ledger timestamp; immutable once the migration ran' },
  'apps/api/src/services/aiModels/gateway/openai/contextWindow.ts#memo': { kind: 'process-local', reason: 'context window learned from endpoint responses, keyed by connectionId + configVersion + model; each replica learns its own' },
  'apps/api/src/services/windowsAgentSigning.ts#cache': { kind: 'process-local', reason: 'whether the released Windows agent binary is signed, 5 min; release-bound, no writer' },
  'apps/api/src/services/installerBuilder.ts#verifiedMacosPkgCache': { kind: 'process-local', reason: 'verified release installer bytes, 5 min; release-bound, no writer' },
  'apps/api/src/services/installerBuilder.ts#verifiedHelperInstallerCache': { kind: 'process-local', reason: 'verified release installer bytes, 5 min; release-bound, no writer' },
  'apps/api/src/services/installerBuilder.ts#regularMsiCache': { kind: 'process-local', reason: 'release MSI bytes, 5 min; release-bound, no writer' },
  'apps/api/src/services/agentEditionAutoMigrate.ts#msiShaCache': { kind: 'process-local', reason: 'sha256 of a local MSI file, keyed by mtime + size; per-host filesystem' },
  'apps/api/src/services/localBinaryBuild.ts#cached': { kind: 'process-local', reason: 'build version from the local VERSION file/env, 60 s; per-host' },
  'apps/api/src/services/ticketImport/modules/zammad/directory.ts#CACHE': { kind: 'process-local', reason: 'Zammad lookup tables for one import run (disposed when the run ends); the run is one worker job' },
  'apps/api/src/services/ticketMailbox/arcSeal.ts#keyCache': { kind: 'process-local', reason: 'public DKIM keys from DNS, TTL-bounded; no Breeze writer' },
  'apps/api/src/services/ticketMailbox/googleMailboxClient.ts#handledLabelIdCache': { kind: 'process-local', reason: 'Gmail label id per account + mailbox; self-heals on 400/404' },
  'apps/api/src/services/ticketMailbox/mailboxToken.ts#cache': { kind: 'process-local', reason: TOKEN },
  'apps/api/src/services/m365DirectGraph.ts#tokenCache': { kind: 'process-local', reason: TOKEN },
  'apps/api/src/services/toolSources/authHeaders.ts#oauthTokenCache': { kind: 'process-local', reason: TOKEN },
  'apps/api/src/services/warrantyProviders/dellProvider.ts#cachedToken': { kind: 'process-local', reason: TOKEN },
  'apps/api/src/services/apns.ts#cachedToken': { kind: 'process-local', reason: 'APNs provider JWT signed with an env key; regenerated before expiry' },
  'apps/api/src/services/attestation/playIntegrity.ts#cachedAccessToken': { kind: 'process-local', reason: TOKEN },
  'apps/api/src/services/attestation/playIntegrity.ts#cachedServiceAccount': { kind: 'process-local', reason: ENV },
  'apps/api/src/services/attestation/playIntegrity.ts#cachedServiceAccountRaw': { kind: 'process-local', reason: ENV },
  'apps/api/src/services/attestation/androidKeyAttestation.ts#cachedRootSpkis': { kind: 'process-local', reason: 'Google attestation root SPKIs parsed from in-code PEMs' },
  'apps/api/src/middleware/bearerTokenAuth.ts#cachedJwks': { kind: 'process-local', reason: JWKS },
  'apps/api/src/services/cfAccessJwt.ts#cachedJwks': { kind: 'process-local', reason: JWKS },
  'apps/api/src/services/cfAccessJwt.ts#cachedConfigKey': { kind: 'process-local', reason: ENV },
  'apps/api/src/services/clientAiEntraJwt.ts#cachedJwks': { kind: 'process-local', reason: JWKS },
  'apps/api/src/services/portalOidc/entraClient.ts#cachedJwks': { kind: 'process-local', reason: JWKS },
  'apps/api/src/services/portalOidc/googleClient.ts#cachedJwks': { kind: 'process-local', reason: JWKS },
  'apps/api/src/services/ticketMailbox/microsoftIdentity.ts#cachedMicrosoftJwks': { kind: 'process-local', reason: JWKS },
  'apps/api/src/services/sso.ts#idTokenJwksCache': { kind: 'process-local', reason: JWKS },
  'apps/api/src/config/tunnelOrigin.ts#cached': { kind: 'process-local', reason: ENV },
  'apps/api/src/services/corsPolicy.ts#cachedResolver': { kind: 'process-local', reason: ENV },
  'apps/api/src/services/promptHostConfig.ts#cache': { kind: 'process-local', reason: ENV },
  'apps/api/src/services/oemUpdates/policySideStore.ts#fingerprintMemo': { kind: 'process-local', reason: 'hash of env + in-code manifest, recomputed when its input changes' },
  'apps/api/src/services/aiModels/transport.ts#carriageCache': { kind: 'process-local', reason: ENV },
  'apps/api/src/services/jwt.ts#cachedKeyring': { kind: 'process-local', reason: ENV },
  'apps/api/src/services/jwt.ts#cachedKeyringRaw': { kind: 'process-local', reason: ENV },
  'apps/api/src/services/secretCrypto.ts#cachedEncryptionKey': { kind: 'process-local', reason: ENV },
  'apps/api/src/services/secretCrypto.ts#cachedLegacyKeys': { kind: 'process-local', reason: ENV },
  'apps/api/src/services/secretCrypto.ts#cachedKeyring': { kind: 'process-local', reason: ENV },
  'apps/api/src/services/secretCrypto.ts#cachedKeyringRaw': { kind: 'process-local', reason: ENV },
  'apps/api/src/services/mfaSecretCrypto.ts#cachedMfaEncryptionKey': { kind: 'process-local', reason: ENV },
  'apps/api/src/services/aiModels/toolProfileCatalog.ts#cached': { kind: 'process-local', reason: CODE },
  'apps/api/src/services/aiAgents/agentToolCatalog.ts#memo': { kind: 'process-local', reason: CODE },
  'apps/api/src/services/aiAgentSdkTools.ts#cachedBreezeToolTemplate': { kind: 'process-local', reason: CODE },
  'apps/api/src/services/aiModels/gateway/openai/toolNames.ts#bareIndexCache': { kind: 'process-local', reason: 'WeakMap index over an in-memory tool schema object' },
  'apps/api/src/services/aiToolSurfaceFingerprint.ts#schemaJsonCache': { kind: 'process-local', reason: 'WeakMap from an in-memory tool schema object to its JSON Schema text (#12421)' },
  'apps/api/src/extensions/tenancyTripwire.ts#coreTableNamesCache': { kind: 'process-local', reason: 'core table names read once from the schema catalog; changes only with a migration (a deploy)' },
  'apps/api/src/services/workerClosure/closureGraph.ts#parseCache': { kind: 'process-local', reason: 'parsed source files for the worker-closure contract tooling' },
  'apps/api/src/jobs/aiAgentSweepScheduler.ts#occurrences': { kind: 'process-local', reason: 'pure cron-occurrence math; no data' },
  'apps/api/src/jobs/flowScheduleTick.ts#occurrences': { kind: 'process-local', reason: 'pure cron-occurrence math; no data' },
  'apps/api/src/services/yaraPrecheck.ts#versionMemo': { kind: 'process-local', reason: 'local yarac binary version; per-host' },
  'apps/api/src/services/yaraPrecheck.ts#availableMemo': { kind: 'process-local', reason: 'local yarac binary availability; per-host' },
  'apps/api/src/oauth/cimdPolicy.ts#approvals': { kind: 'process-local', reason: 'one-shot fetch approval registered and consumed inside the same oidc-provider request on this process; a miss refuses the fetch (fail-closed)' },
  'apps/api/src/routes/automations.ts#automationWebhookReplayCache': { kind: 'process-local', reason: 'replay-nonce fallback used only without Redis outside production (or behind AUTOMATION_WEBHOOK_ALLOW_LOCAL_REPLAY_FALLBACK); production reserves the nonce in Redis' },
  'apps/api/src/routes/agents/heartbeat.ts#watchdogRestartLogCache': { kind: 'process-local', reason: 'log-dedupe signature per device; a replica that lacks it writes one extra log row' },

  // ── not-a-cache ────────────────────────────────────────────────────────────
  'apps/api/src/db/auditAdminPool.ts#cachedDb': { kind: 'not-a-cache', reason: SINGLETON },
  'apps/api/src/db/auditAdminPool.ts#cachedClient': { kind: 'not-a-cache', reason: SINGLETON },
  'apps/api/src/db/index.ts#dbContextMemos': { kind: 'process-local', reason: 'per-transaction memo (getDbContextMemo): keyed by one outermost DB context and dropped with it, so it never outlives a request or crosses replicas' },
  'apps/api/src/services/email.ts#cachedService': { kind: 'not-a-cache', reason: SINGLETON },
  'apps/api/src/services/twilio.ts#cachedService': { kind: 'not-a-cache', reason: SINGLETON },
  'apps/api/src/services/stripeClient.ts#cached': { kind: 'not-a-cache', reason: SINGLETON },
  'apps/api/src/services/emailDomains/providerRegistry.ts#cached': { kind: 'not-a-cache', reason: SINGLETON },
  'apps/api/src/services/ipClassifyOffline.ts#cacheDir': { kind: 'not-a-cache', reason: 'a directory path' },
};

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SCAN_ROOTS = ['apps/api/src', 'ee/workspace/src'];

const CACHE_WORDS = new Set(['cache', 'cached', 'caches', 'memo', 'memoized', 'memos']);
// The optional type annotation may contain `=>` (a function type), never a bare `=`.
const DECLARATION = /^(?:export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::(?:=>|[^=])+)?=\s*([\s\S]{0,400})/;
const EXPIRING_ENTRY = /\b(?:expiresAt\w*|ttl\w*|fetchedAt|loadedAt|cachedAt)\b|\w*CacheEntry\b|\bCached\w*/;

function identifierWords(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .split(/\s+/);
}

/** Module-level cache declarations in one file's source, by identifier. */
export function findCacheDeclarations(source: string): string[] {
  const lines = source.split('\n');
  const found: string[] = [];
  lines.forEach((line, index) => {
    if (!/^(?:export\s+)?(?:const|let|var)\s/.test(line)) return;
    const text = lines.slice(index, index + 6).join('\n');
    const match = DECLARATION.exec(text);
    if (!match) return;
    const [, keyword, identifier, initializer] = match;
    const holdsState = keyword !== 'const' || /^new\s+[A-Za-z_$]/.test(initializer!);
    if (!holdsState) return;
    const namedCache = identifierWords(identifier!).some((word) => CACHE_WORDS.has(word));
    const cacheClass = /^new\s+\w*Cache\b/.test(initializer!);
    const expiringMap = /^new\s+(?:Map|WeakMap)\s*[<(]/.test(initializer!)
      && EXPIRING_ENTRY.test(text.split(/\)\s*;/)[0]!);
    if (namedCache || cacheClass || expiringMap) found.push(identifier!);
  });
  return found;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === '__fixtures__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ts$/.test(entry) && !/\.(test|spec)\.ts$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full);
  }
}

function scanRepo(): Map<string, string> {
  const found = new Map<string, string>();
  for (const root of SCAN_ROOTS) {
    const files: string[] = [];
    walk(join(REPO_ROOT, root), files);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const path = relative(REPO_ROOT, file).split('\\').join('/');
      for (const identifier of findCacheDeclarations(source)) found.set(`${path}#${identifier}`, source);
    }
  }
  return found;
}

describe('module-level caches are classified for multiple replicas (#8636)', () => {
  const found = scanRepo();

  it('the detector finds each shape it is meant to find', () => {
    const sample = [
      'const fooCache = new Map<string, number>();',
      'let cachedThing: Thing | null = null;',
      'export const barCache = new HotPathTtlCache<string, Bar>({',
      'const occurrences = new CronOccurrenceCache();',
      'const entries = new Map<string, { value: string; expiresAt: number }>();',
      'const handlerCache: Map<string, () => void> = new Map();',
      'let memo: ((id: string) => Promise<string>) | null = null;',
      'const MAX_CACHE_ENTRIES = 500;',
      'const cacheTtlMs = 5_000;',
      'const cacheKey = (id: string) => `k:${id}`;',
      '  const innerCache = new Map();',
    ].join('\n');
    expect(findCacheDeclarations(sample)).toEqual(['fooCache', 'cachedThing', 'barCache', 'occurrences', 'entries', 'handlerCache', 'memo']);
  });

  it('finds the known caches (the walk is not vacuous)', () => {
    expect(found.has('apps/api/src/services/agentOrgSettingsCache.ts#orgAgentUpdateConfigCache')).toBe(true);
    expect(found.has('apps/api/src/services/ipAllowlist.ts#cache')).toBe(true);
    expect(found.size).toBeGreaterThan(50);
  });

  it('every cache is classified, and every classified cache still exists', () => {
    const unclassified = [...found.keys()].filter((key) => !(key in CACHES)).sort();
    const stale = Object.keys(CACHES).filter((key) => !found.has(key)).sort();
    expect(
      unclassified,
      `classify each in src/__tests__/processLocalCaches.contract.test.ts (see the header for the four kinds):\n${unclassified.join('\n')}`,
    ).toEqual([]);
    expect(stale, 'these declarations are gone or renamed; update CACHES').toEqual([]);
  });

  it('every `cluster` cache is registered on the cluster bus under its name, by its own file', async () => {
    const cluster = Object.entries(CACHES)
      .filter((entry): entry is [string, { kind: 'cluster'; name: string }] => entry[1].kind === 'cluster');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const file of new Set(cluster.map(([key]) => key.split('#')[0]!))) {
      await import(join(REPO_ROOT, file));
    }
    warn.mockRestore();
    const { clusterCacheTargets } = await import('../services/clusterCacheRegistry');
    const registered = new Set([...clusterCacheTargets()].map((target) => target.name));
    const unregistered = cluster
      .filter(([key, { name }]) => {
        const source = found.get(key);
        if (!source) return false; // reported as stale above
        // Registered at runtime, and the name is declared in this file (not a transitive import).
        return !registered.has(name) || !source.includes(`'${name}'`);
      })
      .map(([key, { name }]) => `${key} → '${name}'`);
    expect(unregistered, 'register these on the cluster bus (registerClusterInvalidator or HotPathTtlCache cluster: true)').toEqual([]);
  }, 120_000);
});
