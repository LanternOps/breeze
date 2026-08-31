import Anthropic from '@anthropic-ai/sdk';
import { and, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizations, partnerLlmConfigs } from '../../db/schema';
import type { LlmEgressSurface } from '../../db/schema/llmEgressEvents';
import type { CatalogPricingSnapshot } from '../aiCostTracker';
import { resolveDefaultModel } from '../aiModel';
import { getListedProviderByEntryId, type ListedProvider } from '../llmProviderCatalog';
import { decryptPartnerLlmApiKey } from '../partnerLlmConfig';
import { SecretKeyMaterialError } from '../secretCrypto';
import { captureException, captureMessage } from '../sentry';
import { buildGuardedLlmFetch, type GuardedLlmFetchAttempt } from './guardedLlmFetch';
import { recordLlmEgressEvent } from './llmEgressRecorder';

const SENTRY_CAPTURE_THROTTLE_MS = 60 * 60 * 1000;
const sentryCaptureTimestamps = new Map<string, number>();

function captureAtMostHourly(key: string, capture: () => void): void {
  const now = Date.now();
  const lastCapture = sentryCaptureTimestamps.get(key);
  if (lastCapture !== undefined && now - lastCapture < SENTRY_CAPTURE_THROTTLE_MS) return;
  sentryCaptureTimestamps.set(key, now);
  capture();
}

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
       * on the snapshot lets {@link resolveWireModel} translate (or fail
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

export class LlmUnavailableError extends Error {
  readonly status = 503;
  readonly code = 'ai_unavailable';

  constructor(message = 'AI is unavailable until the Anthropic API key is reconnected.') {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

export class LlmOrgResolutionError extends Error {
  readonly orgId: string;

  constructor(orgId: string) {
    super(`Organization ${orgId} could not be resolved for AI configuration.`);
    this.name = 'LlmOrgResolutionError';
    this.orgId = orgId;
  }
}

async function readOrganizationPartnerId(orgId: string): Promise<string | null | undefined> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [organization] = await db
        .select({ partnerId: organizations.partnerId })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);
      return organization?.partnerId;
    }),
  );
}

async function readPartnerLlmConfig(partnerId: string) {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [row] = await db
        .select({
          id: partnerLlmConfigs.id,
          partnerId: partnerLlmConfigs.partnerId,
          apiKeyEncrypted: partnerLlmConfigs.apiKeyEncrypted,
          defaultModel: partnerLlmConfigs.defaultModel,
          catalogEntryId: partnerLlmConfigs.catalogEntryId,
          status: partnerLlmConfigs.status,
          configVersion: partnerLlmConfigs.configVersion,
        })
        .from(partnerLlmConfigs)
        .where(eq(partnerLlmConfigs.partnerId, partnerId))
        .limit(1);
      return row;
    }),
  );
}

async function partnerLlmConfigExists(partnerId: string): Promise<boolean> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [row] = await db
        .select({ id: partnerLlmConfigs.id })
        .from(partnerLlmConfigs)
        .where(eq(partnerLlmConfigs.partnerId, partnerId))
        .limit(1);
      return row !== undefined;
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
  // adding a key; and the `models[logicalModel]` gate below (and in
  // `resolveWireModel`) skips its fail-closed throw.
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

/**
 * Translates a logical (platform) model id into what actually goes on the wire
 * for this resolved config, plus the pricing that must be used to meter it.
 *
 * Every surface that sends a model id to the provider MUST route it through
 * here. A catalog endpoint speaks its own ids (`anthropic/claude-sonnet-4-6`
 * on OpenRouter, a deployment name on a self-hosted gateway), so sending the
 * platform id verbatim 404s at the provider; and the returned
 * `catalogPricing` is what keeps catalog traffic metered from the revision
 * snapshot instead of Anthropic list rates.
 *
 * Fails CLOSED for a model the pinned revision has not mapped AND verified —
 * silently re-pointing such a request at the partner's default model would run
 * a model nobody asked for while the ledger recorded the one that never ran.
 */
export function resolveWireModel(
  resolved: UsableLlmConfig,
  logicalModel: string,
): { model: string; catalogPricing?: CatalogPricingSnapshot } {
  if (resolved.source !== 'partner' || resolved.endpoint.kind !== 'catalog') {
    return { model: logicalModel };
  }
  // `Object.hasOwn` first: `logicalModel` is free-form client input, and a
  // snapshot that crossed a serialization boundary may have regained
  // Object.prototype even though the builder gives it a null one.
  const binding = Object.hasOwn(resolved.endpoint.models, logicalModel)
    ? resolved.endpoint.models[logicalModel]
    : undefined;
  if (!binding) {
    throw new LlmUnavailableError(
      `The selected AI provider endpoint has no verified mapping for model "${logicalModel}".`,
    );
  }
  return { model: binding.providerModel, catalogPricing: binding.pricing };
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
    apiKey = decryptPartnerLlmApiKey({ id: row.id, apiKeyEncrypted: row.apiKeyEncrypted });
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

export async function resolveLlmConfigForOrg(orgId: string): Promise<ResolvedLlmConfig> {
  const partnerId = await readOrganizationPartnerId(orgId);
  if (partnerId === undefined) throw new LlmOrgResolutionError(orgId);
  return resolveLlmConfig(partnerId ?? null);
}

export async function getLlmBillingSourceForOrg(
  orgId: string,
): Promise<'platform' | 'partner_key'> {
  try {
    const partnerId = await readOrganizationPartnerId(orgId);
    if (!partnerId) return 'platform';
    return await partnerLlmConfigExists(partnerId) ? 'partner_key' : 'platform';
  } catch (error) {
    try {
      captureAtMostHourly(`billing-source:${orgId}`, () => {
        captureException(error, undefined, { service: 'llmConfigResolver', orgId });
      });
    } catch {
      // Telemetry must not break this conservative, read-only billing fallback.
    }
    return 'platform';
  }
}

export type PartnerLlmErrorReason = 'decrypt_failed' | 'auth_rejected';

/**
 * Marks normalized credential failures only when the exact config row id and
 * version still match. Callers must not invoke this for Anthropic 429, 5xx,
 * network, timeout, or other retryable failures.
 */
export async function markPartnerLlmError(input: {
  configId: string;
  configVersion: number;
  reason: PartnerLlmErrorReason;
}): Promise<boolean> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const [updated] = await db
        .update(partnerLlmConfigs)
        .set({
          status: 'error',
          lastError: input.reason,
          updatedAt: new Date(),
        })
        .where(and(
          eq(partnerLlmConfigs.id, input.configId),
          eq(partnerLlmConfigs.configVersion, input.configVersion),
        ))
        .returning({ id: partnerLlmConfigs.id });
      return updated !== undefined;
    }),
  );
}

/**
 * Identifies the caller so a `llm_egress_events` row can name the code path
 * that made the outbound call. `orgId` is the audit's tenant axis: the table's
 * `org_id` is NOT NULL behind a composite `(org_id, partner_id)` FK, so a
 * caller with no org in hand (a partner-scoped actor enriching a catalog item,
 * for instance) cannot be attributed and is handled by
 * {@link buildCatalogEgressRecorder} rather than silently writing a wrong org.
 */
export interface LlmClientCallerContext {
  surface: LlmEgressSurface;
  orgId: string | null;
}

/**
 * Bridges the guarded fetch's synchronous, fire-and-forget attempt callback to
 * the queued egress recorder, stamping the caller's surface and the endpoint's
 * catalog provenance onto every attempt.
 *
 * With no `orgId` the attempt cannot be persisted (see the FK note above). It
 * warns ONCE per client rather than per request — a partner-scoped caller
 * makes many calls and a per-request warning would bury the signal — and lets
 * the request proceed: the security controls (origin pin, connect-time SSRF
 * pin, no redirects) are enforced inside the guarded fetch itself and are
 * entirely unaffected by whether the audit row lands. Refusing the call here
 * would take AI away from a legitimate partner for a bookkeeping gap.
 */
function buildCatalogEgressRecorder(input: {
  caller: LlmClientCallerContext;
  partnerId: string;
  catalogEntryId: string;
  revisionId: string;
}): (attempt: GuardedLlmFetchAttempt) => void {
  let warnedAboutMissingOrg = false;
  return (attempt) => {
    if (!input.caller.orgId) {
      if (!warnedAboutMissingOrg) {
        warnedAboutMissingOrg = true;
        console.warn(
          '[llmConfigResolver] catalog LLM egress could not be audited: no organization in ' +
            `context for partner ${input.partnerId} (surface ${input.caller.surface}).`,
        );
      }
      return;
    }
    recordLlmEgressEvent({
      orgId: input.caller.orgId,
      partnerId: input.partnerId,
      surface: input.caller.surface,
      host: attempt.host,
      resolvedIp: attempt.resolvedIp,
      blocked: attempt.blocked,
      catalogEntryId: input.catalogEntryId,
      revisionId: input.revisionId,
    });
  };
}

export async function getAnthropicClientForPartner(
  partnerId: string | null,
  caller: LlmClientCallerContext,
): Promise<{
  client: Anthropic;
  resolved: UsableLlmConfig;
}> {
  const resolved = await resolveLlmConfig(partnerId);
  if (resolved.source === 'unavailable') {
    throw new LlmUnavailableError();
  }
  if (!resolved.apiKey?.trim()) {
    const error = new LlmUnavailableError('AI is not configured on this deployment.');
    captureAtMostHourly('blank-platform-key:platform', () => {
      captureMessage('AI is not configured on this deployment.', {
        eventCode: 'llm_platform_key_missing',
      });
    });
    throw error;
  }

  if (resolved.source === 'partner' && resolved.endpoint.kind === 'catalog') {
    const { endpoint } = resolved;
    return {
      client: new Anthropic({
        baseURL: endpoint.baseUrl,
        // Exactly one credential header, and the other explicitly nulled so the
        // SDK cannot fall back to an inherited ANTHROPIC_API_KEY /
        // ANTHROPIC_AUTH_TOKEN and leak the platform's credential to a third
        // party.
        ...(endpoint.authMode === 'x-api-key'
          ? { apiKey: resolved.apiKey, authToken: null }
          : { authToken: resolved.apiKey, apiKey: null }),
        fetch: buildGuardedLlmFetch({
          allowedOrigin: new URL(endpoint.baseUrl).origin,
          recordEgress: buildCatalogEgressRecorder({
            caller,
            partnerId: resolved.partnerId,
            catalogEntryId: endpoint.catalogEntryId,
            revisionId: endpoint.revisionId,
          }),
        }),
      }),
      resolved,
    };
  }

  return { client: buildAnthropicClient(resolved), resolved };
}

/**
 * Construct the Anthropic client for an already-resolved config. The partner
 * branch pins `baseURL` and clears `authToken` so a partner key can never be
 * sent through a proxy base URL or alongside an ambient bearer token — that
 * pinning is a security control, so callers that resolve for themselves
 * (`resolveLlmConfigForOrg`) MUST come back through here rather than
 * constructing their own client.
 *
 * A catalog-routed partner is REFUSED rather than served here (#3922 W3): that
 * partner's stored key belongs to a third-party provider, so pinning it at
 * api.anthropic.com would ship someone else's credential to Anthropic, and the
 * catalog path additionally needs the guarded fetch + egress audit that only
 * {@link getAnthropicClientForPartner} can wire (it needs the caller's
 * surface/orgId). Callers wanting catalog support must go through that.
 */
export function buildAnthropicClient(resolved: UsableLlmConfig): Anthropic {
  if (resolved.source === 'partner' && resolved.endpoint.kind !== 'anthropic') {
    throw new LlmUnavailableError(
      'This AI surface does not yet support a custom provider endpoint.',
    );
  }
  return resolved.source === 'partner'
    ? new Anthropic({
        apiKey: resolved.apiKey,
        authToken: null,
        baseURL: 'https://api.anthropic.com',
      })
    : new Anthropic({ apiKey: resolved.apiKey });
}
