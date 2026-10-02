import { and, eq, inArray, ne } from 'drizzle-orm';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizations, partnerAiConnections } from '../../db/schema';
import type { LlmEgressSurface } from '../../db/schema/llmEgressEvents';
import type { CatalogPricingSnapshot } from '../aiCostTracker';
import { resolveDefaultModel } from '../aiModel';
import { getListedProviderByEntryId, type ListedProvider } from '../llmProviderCatalog';
import { decryptConnectionKey } from '../aiModels/connectionKeys';
import { SecretKeyMaterialError } from '../secretCrypto';
import { captureException } from '../sentry';
import { isPlatformLlmConfigured, type LlmUnusableCode } from './llmAvailability';
import { LlmUnavailableError } from './llmUnavailableError';
import { captureAtMostHourly } from './platformKeyAlert';

/**
 * Where a partner's traffic actually goes (#3922 phase 2).
 *
 * `anthropic` is phase-1 behavior and must stay byte-identical: the public
 * endpoint, pinned, with environment auth-token inheritance disabled. `catalog`
 * is a platform-vetted third-party Anthropic-dialect endpoint, carried as a
 * fully-resolved snapshot — the base URL, the wire model id and the pricing all
 * come from ONE immutable revision, so nothing downstream has to re-read the
 * catalog (and cannot see a half-rotated mixture of two revisions).
 */
/** What one logical (platform) model id becomes on a catalog endpoint's wire. */
export interface CatalogModelBinding {
  /** The id sent on the wire; the logical model stays the platform id. */
  providerModel: string;
  pricing: CatalogPricingSnapshot;
}

export type ResolvedLlmEndpoint =
  | { kind: 'anthropic' }
  | {
      kind: 'catalog';
      catalogEntryId: string;
      revisionId: string;
      baseUrl: string;
      authMode: 'x-api-key' | 'bearer';
      /** The id sent on the wire; the logical `model` stays the platform id. */
      providerModel: string;
      pricing: CatalogPricingSnapshot;
      /**
       * Every logical model this revision BOTH maps and has a passing
       * verification for, keyed by platform id.
       *
       * The partner default (`providerModel`/`pricing` above) is only one of
       * them: an `ai_sessions` row carries a client-supplied model, and a
       * one-shot surface can be handed a session's model — neither is the
       * default, and neither is covered by the resolver's `model_unverified`
       * gate, which keys on the partner default alone. Carrying the whole map
       * on the snapshot lets the connection's wire-model mapping translate (or fail
       * closed on) any of them without re-reading the catalog and without
       * risking a half-rotated mixture of two revisions.
       */
      models: Readonly<Record<string, CatalogModelBinding>>;
    };

export type ResolvedLlmConfig =
  | { source: 'platform'; apiKey: string | undefined; model: string }
  | {
      source: 'partner';
      partnerId: string;
      apiKey: string;
      model: string;
      configId: string;
      configVersion: number;
      endpoint: ResolvedLlmEndpoint;
    }
  | {
      source: 'unavailable';
      partnerId: string;
      reason:
        | 'key_error'
        | 'key_material'
        | 'provider_delisted'
        | 'catalog_disabled'
        | 'model_unverified';
    };

export type UsableLlmConfig = Exclude<ResolvedLlmConfig, { source: 'unavailable' }>;

export { LlmUnavailableError };

/**
 * #7601 W03 Task 6B: the partner's AI configuration is its compat
 * (anthropic_byok | catalog) connection — the /ai/provider facade writes only
 * the registry now, and partner_llm_configs is frozen (dropped in W08). The
 * W02 migration copied every legacy row to a same-id connection and the W02
 * mirror kept them identical until this wave dropped it, so the connection is
 * exact for every partner, cut over or not. partner_ai_connections_compat_uq
 * guarantees at most one row.
 */
const compatConnectionOf = (partnerId: string) => and(
  eq(partnerAiConnections.partnerId, partnerId),
  inArray(partnerAiConnections.kind, ['anthropic_byok', 'catalog']),
  // A disconnected connection is provenance only (#7700 finding 1).
  ne(partnerAiConnections.status, 'disconnected'),
);

/**
 * The legacy row shape the resolver consumes, read from the compat connection.
 * Built per call (not at module load) so suites that mock the schema without
 * the registry tables can still import this module.
 */
const compatConfigColumns = () => ({
  id: partnerAiConnections.id,
  partnerId: partnerAiConnections.partnerId,
  apiKeyEncrypted: partnerAiConnections.apiKeyEncrypted,
  defaultModel: partnerAiConnections.legacyDefaultModel,
  catalogEntryId: partnerAiConnections.catalogEntryId,
  status: partnerAiConnections.status,
  configVersion: partnerAiConnections.configVersion,
});

async function readPartnerLlmConfig(partnerId: string) {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [row] = await db
        .select(compatConfigColumns())
        .from(partnerAiConnections)
        .where(compatConnectionOf(partnerId))
        .limit(1);
      return row;
    }),
  );
}

/**
 * Gates every catalog code path (#3922 W3, Task 3.1). Read at call time rather
 * than captured at import so a restart-free flip is honoured, and read
 * strictly: anything but `true` is off, so a typo or a half-applied deploy
 * fails CLOSED — a partner already pinned to a catalog entry resolves as
 * `unavailable('catalog_disabled')` and never silently reverts to sending
 * their key to api.anthropic.com under a provider selection they made
 * deliberately.
 */
export function isLlmProviderCatalogEnabled(): boolean {
  return (process.env.LLM_PROVIDER_CATALOG_ENABLED ?? '').toLowerCase() === 'true';
}

/**
 * Joins a partner's pinned catalog entry to a usable endpoint, or explains why
 * it cannot. Every failure is loud: phase 1's invariant is that AI stops rather
 * than quietly billing the platform key, and a delisted or unverified provider
 * is exactly that situation.
 */
async function resolveCatalogEndpoint(
  catalogEntryId: string,
  model: string,
): Promise<
  | { ok: true; endpoint: ResolvedLlmEndpoint }
  | { ok: false; reason: 'provider_delisted' | 'catalog_disabled' | 'model_unverified' }
> {
  if (!isLlmProviderCatalogEnabled()) return { ok: false, reason: 'catalog_disabled' };

  // `getListedProviderByEntryId` only ever yields entries that are BOTH
  // status='listed' AND joined to an active revision, so a deleted entry, a
  // delisted one, and one whose active revision was cleared all collapse to
  // null here — one reason covers all three because the partner-visible
  // remedy is identical.
  const provider = await getListedProviderByEntryId(catalogEntryId);
  if (!provider) return { ok: false, reason: 'provider_delisted' };

  const endpoint = buildCatalogEndpointSnapshot(provider, model);
  if (!endpoint) return { ok: false, reason: 'model_unverified' };
  return { ok: true, endpoint };
}

/**
 * Snapshots one listed catalog entry against a logical model, or returns null
 * when this revision has not BOTH mapped and verified that model.
 *
 * Both halves matter. An unmapped model has no wire id or price at all; a
 * mapped-but-unverified one has never proven tool-call fidelity on THIS
 * revision at the CURRENT harness version, and shipping agent turns to it
 * would fail in ways the partner cannot diagnose. Intersecting the two up
 * front means every entry in `models` is usable by construction.
 *
 * Shared by the resolver, the partner-facing endpoint selection, and the
 * key-rotation probe so those three can never disagree about what "usable"
 * means or about which wire id a model maps to.
 */
export function buildCatalogEndpointSnapshot(
  provider: ListedProvider,
  model: string,
): Extract<ResolvedLlmEndpoint, { kind: 'catalog' }> | null {
  // Null-prototype, and every lookup into it (and into the jsonb-sourced
  // `modelMap`) guarded by `Object.hasOwn` (#3922 W3 review round 2). Logical
  // model ids are free-form client input — `ai_sessions.model` is
  // `z.string().max(100)` — so `constructor`, `__proto__`, `toString` and the
  // rest of Object.prototype otherwise resolve TRUTHY by inheritance. On a
  // plain literal that fails OPEN three ways: `modelMap['constructor']`
  // registers a binding whose wire id and every price are `undefined`;
  // `models['__proto__'] = …` silently REPLACES the map's prototype instead of
  // adding a key; and a `models[logicalModel]` lookup downstream skips its
  // fail-closed throw.
  const models: Record<string, CatalogModelBinding> = Object.create(null);
  for (const modelId of provider.verifiedModels) {
    if (!Object.hasOwn(provider.modelMap, modelId)) continue;
    const mapped = provider.modelMap[modelId];
    if (!mapped) continue;
    models[modelId] = {
      providerModel: mapped.providerModel,
      pricing: {
        catalogEntryId: provider.entryId,
        revisionId: provider.revisionId,
        inputCentsPerM: mapped.inputCentsPerM,
        outputCentsPerM: mapped.outputCentsPerM,
        cacheReadCentsPerM: mapped.cacheReadCentsPerM,
        cacheWriteCentsPerM: mapped.cacheWriteCentsPerM,
      },
    };
  }

  const defaultBinding = Object.hasOwn(models, model) ? models[model] : undefined;
  if (!defaultBinding) return null;

  return {
    kind: 'catalog',
    catalogEntryId: provider.entryId,
    revisionId: provider.revisionId,
    baseUrl: provider.baseUrl,
    authMode: provider.authMode,
    providerModel: defaultBinding.providerModel,
    pricing: defaultBinding.pricing,
    models,
  };
}

export async function resolveLlmConfig(partnerId: string | null): Promise<ResolvedLlmConfig> {
  const platform = (): ResolvedLlmConfig => ({
    source: 'platform',
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: resolveDefaultModel(),
  });

  if (!partnerId) return platform();

  const row = await readPartnerLlmConfig(partnerId);
  if (!row) return platform();
  if (row.status === 'error') {
    return { source: 'unavailable', partnerId, reason: 'key_error' };
  }

  let apiKey: string;
  try {
    apiKey = decryptConnectionKey({ id: row.id, apiKeyEncrypted: row.apiKeyEncrypted });
  } catch (error) {
    if (error instanceof SecretKeyMaterialError) {
      captureAtMostHourly(`key-material:${partnerId}`, () => {
        captureException(error, undefined, { service: 'llmConfigResolver', partnerId });
      });
      console.error(
        '[llmConfigResolver] partner config cannot be decrypted with this node key material',
        { partnerId, error },
      );
      return { source: 'unavailable', partnerId, reason: 'key_material' };
    }
    captureException(error, undefined, { service: 'llmConfigResolver', partnerId });
    try {
      await markPartnerLlmError({
        configId: row.id,
        configVersion: row.configVersion,
        reason: 'decrypt_failed',
      });
    } catch (markError) {
      console.error('[llmConfigResolver] failed to mark unreadable partner config', {
        partnerId,
        configVersion: row.configVersion,
        error: markError,
      });
      captureException(markError, undefined, { service: 'llmConfigResolver', partnerId });
    }
    return { source: 'unavailable', partnerId, reason: 'key_error' };
  }

  const model = row.defaultModel ?? resolveDefaultModel();

  let endpoint: ResolvedLlmEndpoint = { kind: 'anthropic' };
  if (row.catalogEntryId) {
    const catalog = await resolveCatalogEndpoint(row.catalogEntryId, model);
    if (!catalog.ok) return { source: 'unavailable', partnerId, reason: catalog.reason };
    endpoint = catalog.endpoint;
  }

  return {
    source: 'partner',
    partnerId,
    apiKey,
    model,
    configId: row.id,
    configVersion: row.configVersion,
    endpoint,
  };
}

/**
 * Readiness view of `resolveLlmConfig` + `llmUnusableCode` for an org, for a
 * caller ALREADY inside a system DB context (topology AI readiness, review
 * R1): the same decisions — no partner config means the platform path, which
 * is usable with a platform credential (`isPlatformLlmConfigured`) or (W06)
 * with a live OpenAI-compatible connection of the partner's (an env
 * deployment's env-managed connection, or a BYO gateway; the deployment may
 * have no Anthropic key at all); an `error` status, an undecryptable key or
 * an unusable catalog pin means unavailable — read on the caller's own
 * connection. Returns null when a model can be
 * called. It never escapes to a second pooled connection (the resolver's
 * `runOutsideDbContext` reads would, which under a held transaction is the
 * #6671 pool-exhaustion shape) and has no side effects: it never marks a
 * config errored — only a real model call does. The authoritative resolution
 * still happens before any model call.
 */
export async function llmUnusableCodeForOrgInSystemContext(orgId: string): Promise<LlmUnusableCode | null> {
  if (getCurrentDbAccessContext()?.scope !== 'system') {
    throw new Error('llmUnusableCodeForOrgInSystemContext requires a held system DB context');
  }
  const [organization] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!organization) return 'ai_unavailable';
  const partnerId = organization.partnerId;
  if (!partnerId) return isPlatformLlmConfigured() ? null : 'ai_not_configured';
  const [row] = await db
    .select(compatConfigColumns())
    .from(partnerAiConnections)
    .where(compatConnectionOf(partnerId))
    .limit(1);
  if (!row) {
    if (isPlatformLlmConfigured()) return null;
    // Approximate like the rest of this view: the turn's own resolution still
    // decides whether an eligible offering on it answers chat.
    const [gateway] = await db
      .select({ id: partnerAiConnections.id })
      .from(partnerAiConnections)
      .where(and(
        eq(partnerAiConnections.partnerId, partnerId),
        eq(partnerAiConnections.kind, 'openai_compatible'),
        eq(partnerAiConnections.status, 'active'),
      ))
      .limit(1);
    return gateway ? null : 'ai_not_configured';
  }
  if (row.status === 'error') return 'ai_unavailable';
  try {
    decryptConnectionKey({ id: row.id, apiKeyEncrypted: row.apiKeyEncrypted });
  } catch {
    return 'ai_unavailable';
  }
  if (!row.catalogEntryId) return null;
  const catalog = await resolveCatalogEndpoint(row.catalogEntryId, row.defaultModel ?? resolveDefaultModel());
  return catalog.ok ? null : 'ai_unavailable';
}

export type PartnerLlmErrorReason = 'decrypt_failed' | 'auth_rejected';

/**
 * Marks normalized credential failures only when the exact connection id and
 * config version still match (a rotation in between wins). Callers must not
 * invoke this for Anthropic 429, 5xx, network, timeout, or other retryable
 * failures. `configId` is the compat connection id (Task 6B).
 */
export async function markPartnerLlmError(input: {
  configId: string;
  configVersion: number;
  reason: PartnerLlmErrorReason;
}): Promise<boolean> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [updated] = await db
        .update(partnerAiConnections)
        .set({
          status: 'error',
          lastError: input.reason,
          updatedAt: new Date(),
        })
        .where(and(
          eq(partnerAiConnections.id, input.configId),
          eq(partnerAiConnections.configVersion, input.configVersion),
        ))
        .returning({ id: partnerAiConnections.id });
      return updated !== undefined;
    }),
  );
}

/**
 * Identifies the caller so a `llm_egress_events` row can name the code path
 * that made the outbound call. `orgId` is the audit's tenant axis: the table's
 * `org_id` is NOT NULL behind a composite `(org_id, partner_id)` FK, so a
 * caller with no org in hand (a partner-scoped actor enriching a catalog item,
 * for instance) cannot be attributed and is handled by the connection
 * factory's egress recorder (aiModels/connectionFactory.ts) rather than
 * silently writing a wrong org.
 */
export interface LlmClientCallerContext {
  surface: LlmEgressSurface;
  orgId: string | null;
}
