import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { partnerAiConnections, partnerLlmConfigs } from '../db/schema';
import { resolveDefaultModel } from './aiModel';
import { lockPartnerRegistryReconcile, reconcilePartnerFromLegacyInTx } from './aiModels/legacyReconcile';
import { isOfferablePlatformModel } from './aiModels/platformModels';
import { createAnthropicClient } from './aiModels/connectionFactory';
import { carriesQueryValues, formatSafeDbErrorDetail, safeDbErrorDetail } from './aiModels/safeDbError';
import {
  columnAad,
  encryptedColumnRegistry,
  type EncryptedColumnSpec,
} from './encryptedColumnRegistry';
import { LlmEgressViolationError } from './llm/guardedLlmFetch';
// Type-only: `llmConfigResolver.ts` imports `decryptPartnerLlmApiKey` (a value)
// from this file. Importing only the type + the flag *function* back keeps the
// two modules mutually referential at the type/declaration level without a
// runtime cycle — `isLlmProviderCatalogEnabled` is called from inside function
// bodies here, never at module-evaluation time, which is the condition ESM
// circular imports require to resolve safely.
import {
  buildCatalogEndpointSnapshot,
  isLlmProviderCatalogEnabled,
  type ResolvedLlmEndpoint,
} from './llm/llmConfigResolver';
import { getListedProviderByEntryId } from './llmProviderCatalog';
import { decryptSecret, encryptSecret, hmacFingerprint } from './secretCrypto';
import { captureException } from './sentry';

const API_KEY_SPEC: EncryptedColumnSpec = (() => {
  const spec = encryptedColumnRegistry.find(
    (entry) => entry.table === 'partner_llm_configs' && entry.column === 'api_key_encrypted',
  );
  if (!spec) throw new Error('partner_llm_configs.api_key_encrypted is missing from encryptedColumnRegistry');
  return spec;
})();

export class PartnerLlmError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 409 | 500 | 503,
  ) {
    super(message);
    this.name = 'PartnerLlmError';
  }
}

/**
 * A database failure inside a provider write, reduced to what is safe to log
 * (the shared scrubber: aiModels/safeDbError.ts). A Drizzle query error's message and `params` (and a postgres.js error's
 * `query` / `parameters`) carry the statement's values — here the key
 * ciphertext and fingerprint — so they must never reach the route's error
 * handler, the console or Sentry. What survives: the class, the SQLSTATE
 * (Sentry tags it from `cause.code`), the constraint, and the Postgres primary
 * message — except for SQLSTATE class 22 (data exception), whose primary
 * message can quote the offending input value.
 */
function toSafeWriteError(error: unknown): PartnerLlmError {
  const safeDetail = safeDbErrorDetail(error);
  const { code, kind } = safeDetail;
  const detail = formatSafeDbErrorDetail(safeDetail);
  const cause = Object.assign(new Error(`AI provider write failed: ${kind}${detail ? ` (${detail})` : ''}`), code ? { code } : {});
  const safe = new PartnerLlmError('Could not save the AI provider configuration.', 500);
  safe.cause = cause;
  return safe;
}

/**
 * #7600 W02 SCAFFOLDING: the legacy table stays the routing source until W03,
 * and the registry is its projection. Every /ai/provider mutation runs its
 * legacy write and the reconcile in ONE system transaction, so both stores
 * commit or roll back together. W03 Task 6B replaces this with registry-native
 * remaps and must NOT keep calling the reconcile (it would revert native
 * edits). Partner pinning comes from the route (BILLING_MANAGE +
 * canManagePartnerWidePolicies); every statement below filters on partnerId.
 *
 * The reconcile's advisory lock is taken FIRST, before the legacy write: the
 * legacy UPDATE fires the mirror trigger, which row-locks the partner's
 * connection; holding that row lock while waiting for the advisory lock held
 * by a concurrent boot-sweep reconcile (which wants the same row) deadlocks.
 * Probes never run in here — no transaction is held across the network.
 */
async function inRegistryWrite<T>(partnerId: string, write: () => Promise<T>): Promise<T> {
  try {
    return await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        await lockPartnerRegistryReconcile(partnerId);
        const result = await write();
        await reconcilePartnerFromLegacyInTx(partnerId);
        return result;
      }, 'aiProvider.registryWrite'));
  } catch (error) {
    if (error instanceof PartnerLlmError) throw error;
    // Only errors that carry SQL values are rewritten. Anything else (a
    // projection invariant, a TypeError) keeps its message and stack so a
    // blocked /ai/provider write stays diagnosable in Sentry.
    if (carriesQueryValues(error)) throw toSafeWriteError(error);
    throw error;
  }
}

export interface PartnerLlmStatus {
  configured: boolean;
  provider: 'anthropic';
  keyLast4: string | null;
  defaultModel: string | null;
  status: 'platform' | 'active' | 'error';
  verifiedAt: Date | null;
  lastError: string | null;
  /** The platform-catalog endpoint this partner has selected, or null for direct Anthropic (#3922 W3). */
  catalogEntryId: string | null;
}

function encryptPartnerLlmApiKey(id: string, apiKey: string): string {
  const encrypted = encryptSecret(apiKey, { aad: columnAad(API_KEY_SPEC, id) });
  if (!encrypted) throw new PartnerLlmError('Could not encrypt the Anthropic API key.', 500);
  return encrypted;
}

export function decryptPartnerLlmApiKey(row: { id: string; apiKeyEncrypted: string }): string {
  const apiKey = decryptSecret(row.apiKeyEncrypted, { aad: columnAad(API_KEY_SPEC, row.id) });
  if (!apiKey) throw new Error('Stored Anthropic API key decrypted to an empty value');
  return apiKey;
}

/**
 * Maps a probe's thrown error to the typed `PartnerLlmError` phase-1
 * semantics expect, for BOTH probe targets (direct Anthropic and a catalog
 * endpoint reached through the guarded client). A blocked-egress refusal is
 * mapped to a transient 503 — it says nothing about the key itself, only that
 * the pinned endpoint could not be reached right now. Anything else that
 * isn't an `Anthropic.APIError` is returned as-is so the caller can rethrow
 * it unwrapped (a genuine programming error must not masquerade as a probe
 * rejection).
 */
function mapProbeError(error: unknown): unknown {
  if (error instanceof LlmEgressViolationError) {
    return new PartnerLlmError('Could not reach that endpoint to verify the key. Try again shortly.', 503);
  }
  if (!(error instanceof Anthropic.APIError)) return error;
  const status = error.status;
  if (status === 401) {
    return new PartnerLlmError('That Anthropic API key was rejected. Check the key and try again.', 400);
  }
  if (status === 403) {
    return new PartnerLlmError('Anthropic denied access for that API key. Check its permissions and try again.', 409);
  }
  if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
    captureException(error, undefined, { service: 'partnerLlmConfig' });
    return new PartnerLlmError(
      `Anthropic rejected the verification request (HTTP ${status}). ` +
      'The probe model may be unavailable — contact support if this persists.',
      400,
    );
  }
  return new PartnerLlmError('Anthropic could not verify the API key right now. Try again later.', 503);
}

/**
 * Verifies a key against the endpoint it will actually be used with. Defaults
 * to direct Anthropic so every existing call site (and every existing test)
 * keeps behaving byte-for-byte; a `kind: 'catalog'` endpoint routes the same
 * ping through the guarded fetch, pinned to the catalog revision's origin,
 * with no partner-level org to attribute the audit event to (see
 * {@link buildProbeEgressRecorder}).
 */
async function probeAnthropicKey(apiKey: string, endpoint: ResolvedLlmEndpoint = { kind: 'anthropic' }): Promise<void> {
  const model = endpoint.kind === 'catalog' ? endpoint.providerModel : resolveDefaultModel();
  // Probe through the connection factory, against the target the key will be
  // used with: a partner key is pinned to the public API (previously
  // `{ apiKey }`, which honoured an ambient ANTHROPIC_BASE_URL and could send
  // a partner key to a self-host gateway); a catalog key goes through the
  // guarded fetch with exactly one credential header.
  const client = createAnthropicClient({
    apiKey,
    target: endpoint.kind === 'catalog'
      ? { kind: 'endpoint', baseUrl: endpoint.baseUrl, authMode: endpoint.authMode, recordEgress: buildProbeEgressRecorder() }
      : { kind: 'anthropic' },
  });
  try {
    await runOutsideDbContext(() => client.messages.create({
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    }));
  } catch (error) {
    throw mapProbeError(error);
  }
}

/**
 * A key-verification probe is a partner-level action — there is no
 * organization in scope to attribute an `llm_egress_events` row to (the
 * table's `org_id` is `NOT NULL` behind a composite FK; see
 * `buildCatalogEgressRecorder` in `llm/llmConfigResolver.ts` for the same
 * no-org posture on catalog-egress calls made outside a request's org
 * context). The guarded fetch's security controls — origin pinning,
 * connect-time SSRF pinning, no redirects — are entirely unaffected by
 * whether the attempt is audited; this only means the probe itself leaves no
 * `llm_egress_events` row. Warns once per probe rather than once per HTTP
 * attempt.
 */
function buildProbeEgressRecorder(): (attempt: { host: string; resolvedIp: string | null; blocked: boolean }) => void {
  let warned = false;
  return () => {
    if (!warned) {
      warned = true;
      console.warn(
        '[partnerLlmConfig] catalog endpoint probe egress could not be audited: probes run without an organization context.',
      );
    }
  };
}

/**
 * Which endpoint a key rotation (`savePartnerLlmKey`) or a fresh
 * connect should be probed against: the partner's currently-selected catalog
 * entry if one is set, otherwise direct Anthropic. Fails loud — never falls
 * back to probing api.anthropic.com with a key meant for a third-party
 * endpoint, which would produce a misleading "key rejected" error instead of
 * the true reason (disabled/delisted).
 */
async function resolveProbeEndpointForPartner(partnerId: string): Promise<ResolvedLlmEndpoint> {
  const [existing] = await db
    .select({
      catalogEntryId: partnerLlmConfigs.catalogEntryId,
      defaultModel: partnerLlmConfigs.defaultModel,
    })
    .from(partnerLlmConfigs)
    .where(eq(partnerLlmConfigs.partnerId, partnerId))
    .limit(1);
  if (!existing?.catalogEntryId) return { kind: 'anthropic' };
  return resolveCatalogEndpointForSelection(
    existing.catalogEntryId,
    existing.defaultModel ?? resolveDefaultModel(),
  );
}

/**
 * Joins a catalog entry + model to a probeable `ResolvedLlmEndpoint`, or
 * throws a typed, fail-loud `PartnerLlmError` explaining why it cannot.
 * Shared by both the key-rotation probe target lookup above and
 * {@link updatePartnerLlmEndpoint} below so the two paths can never disagree
 * about what "selectable" means.
 */
async function resolveCatalogEndpointForSelection(
  catalogEntryId: string,
  model: string,
): Promise<ResolvedLlmEndpoint> {
  if (!isLlmProviderCatalogEnabled()) {
    throw new PartnerLlmError('Catalog endpoint selection is currently disabled on this deployment.', 409);
  }
  const provider = await getListedProviderByEntryId(catalogEntryId);
  if (!provider) {
    throw new PartnerLlmError('That endpoint was delisted and is no longer available for selection.', 409);
  }
  const endpoint = buildCatalogEndpointSnapshot(provider, model);
  if (!endpoint) {
    throw new PartnerLlmError(
      'That endpoint does not currently support your configured AI model. Choose a different model or endpoint.',
      409,
    );
  }
  return endpoint;
}

export async function savePartnerLlmKey(input: {
  partnerId: string;
  apiKey: string;
  userId: string;
}): Promise<{
  last4: string;
  model: string;
  verifiedAt: Date;
  configVersion: number;
}> {
  const apiKey = input.apiKey.trim();
  if (apiKey.startsWith('enc:')) {
    throw new PartnerLlmError('Anthropic API keys must not start with the encrypted-value prefix.', 400);
  }

  const probeEndpoint = await resolveProbeEndpointForPartner(input.partnerId);
  await probeAnthropicKey(apiKey, probeEndpoint);

  const id = randomUUID();
  const last4 = apiKey.slice(-4);
  const fingerprint = hmacFingerprint(apiKey);
  const verifiedAt = new Date();

  // The legacy write and the registry reconcile commit together (see inRegistryWrite).
  const stored = await inRegistryWrite(input.partnerId, async () => {
    const [inserted] = await db
      .insert(partnerLlmConfigs)
      .values({
        id,
        partnerId: input.partnerId,
        apiKeyEncrypted: encryptPartnerLlmApiKey(id, apiKey),
        keyLast4: last4,
        keyFingerprint: fingerprint,
        status: 'active',
        configVersion: 1,
        lastError: null,
        verifiedAt,
        connectedBy: input.userId,
        updatedAt: verifiedAt,
      })
      .onConflictDoNothing({ target: partnerLlmConfigs.partnerId })
      .returning({ id: partnerLlmConfigs.id, configVersion: partnerLlmConfigs.configVersion });

    if (inserted) {
      return { configVersion: inserted.configVersion, defaultModel: null as string | null };
    }

    const [existing] = await db
      .select({
        id: partnerLlmConfigs.id,
        defaultModel: partnerLlmConfigs.defaultModel,
      })
      .from(partnerLlmConfigs)
      .where(eq(partnerLlmConfigs.partnerId, input.partnerId))
      .limit(1);
    if (!existing) {
      throw new PartnerLlmError('Could not replace the Anthropic API key.', 500);
    }

    const [updated] = await db
      .update(partnerLlmConfigs)
      .set({
        apiKeyEncrypted: encryptPartnerLlmApiKey(existing.id, apiKey),
        keyLast4: last4,
        keyFingerprint: fingerprint,
        status: 'active',
        configVersion: sql`${partnerLlmConfigs.configVersion} + 1`,
        lastError: null,
        verifiedAt,
        connectedBy: input.userId,
        updatedAt: verifiedAt,
      })
      .where(and(
        eq(partnerLlmConfigs.partnerId, input.partnerId),
        eq(partnerLlmConfigs.id, existing.id),
      ))
      .returning({ configVersion: partnerLlmConfigs.configVersion });
    if (!updated) {
      throw new PartnerLlmError('Could not replace the Anthropic API key.', 500);
    }
    return { configVersion: updated.configVersion, defaultModel: existing.defaultModel };
  });

  return {
    last4,
    model: stored.defaultModel ?? resolveDefaultModel(),
    verifiedAt,
    configVersion: stored.configVersion,
  };
}

export async function getPartnerLlmStatus(partnerId: string): Promise<PartnerLlmStatus> {
  // #7600 W02: read the registry. legacy_default_model is the exact compat
  // projection of partner_llm_configs.default_model (null = tracks the
  // deployment default); partner_ai_connections_compat_uq guarantees one row.
  const [row] = await db
    .select({
      keyLast4: partnerAiConnections.keyLast4,
      defaultModel: partnerAiConnections.legacyDefaultModel,
      status: partnerAiConnections.status,
      verifiedAt: partnerAiConnections.verifiedAt,
      lastError: partnerAiConnections.lastError,
      catalogEntryId: partnerAiConnections.catalogEntryId,
    })
    .from(partnerAiConnections)
    .where(and(
      eq(partnerAiConnections.partnerId, partnerId),
      inArray(partnerAiConnections.kind, ['anthropic_byok', 'catalog']),
    ))
    .limit(1);

  if (!row) {
    return {
      configured: false,
      provider: 'anthropic',
      keyLast4: null,
      defaultModel: null,
      status: 'platform',
      verifiedAt: null,
      lastError: null,
      catalogEntryId: null,
    };
  }

  return {
    configured: true,
    provider: 'anthropic',
    keyLast4: row.keyLast4,
    defaultModel: row.defaultModel,
    status: row.status,
    verifiedAt: row.verifiedAt,
    lastError: row.lastError,
    catalogEntryId: row.catalogEntryId,
  };
}

export async function updatePartnerLlmConfig(input: {
  partnerId: string;
  defaultModel: string | null;
}): Promise<{ defaultModel: string | null; configVersion: number }> {
  if (input.defaultModel !== null && !(await isOfferablePlatformModel(input.defaultModel))) {
    throw new PartnerLlmError('Unsupported Anthropic model.', 400);
  }

  // A throw inside the write rolls the transaction back: a 409 writes nothing.
  const updated = await inRegistryWrite(input.partnerId, async () => {
    const [row] = await db
      .update(partnerLlmConfigs)
      .set({
        defaultModel: input.defaultModel,
        configVersion: sql`${partnerLlmConfigs.configVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(partnerLlmConfigs.partnerId, input.partnerId))
      .returning({ configVersion: partnerLlmConfigs.configVersion });
    if (!row) {
      throw new PartnerLlmError('Connect an Anthropic API key before selecting a model.', 409);
    }
    return row;
  });

  return {
    defaultModel: input.defaultModel,
    configVersion: updated.configVersion,
  };
}

/**
 * Selects (or clears) which platform-catalog endpoint a partner's AI traffic
 * routes through (#3922 W3, Task 3.4). `catalogEntryId: null` reverts to
 * direct Anthropic without a probe — the key was already verified against
 * Anthropic when connected. A non-null selection is verified end-to-end
 * before anything is written: listed + an active revision, consent
 * acknowledged when the revision carries a data note, the partner's
 * configured model mapped AND verified on the entry, then a live probe
 * through the guarded client. Any failure persists nothing — `config_version`
 * only advances on a success that a real request actually round-tripped.
 */
export async function updatePartnerLlmEndpoint(input: {
  partnerId: string;
  catalogEntryId: string | null;
  acknowledgeDataNote: boolean;
  userId: string;
}): Promise<{
  catalogEntryId: string | null;
  configVersion: number;
  slug: string | null;
  revision: number | null;
}> {
  const [existing] = await db
    .select({
      id: partnerLlmConfigs.id,
      apiKeyEncrypted: partnerLlmConfigs.apiKeyEncrypted,
      defaultModel: partnerLlmConfigs.defaultModel,
    })
    .from(partnerLlmConfigs)
    .where(eq(partnerLlmConfigs.partnerId, input.partnerId))
    .limit(1);
  if (!existing) {
    throw new PartnerLlmError('Connect an Anthropic API key before selecting an endpoint.', 409);
  }

  if (input.catalogEntryId === null) {
    const updated = await inRegistryWrite(input.partnerId, async () => {
      const [row] = await db
        .update(partnerLlmConfigs)
        .set({
          catalogEntryId: null,
          configVersion: sql`${partnerLlmConfigs.configVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(partnerLlmConfigs.partnerId, input.partnerId))
        .returning({ configVersion: partnerLlmConfigs.configVersion });
      if (!row) {
        throw new PartnerLlmError('Could not update the endpoint selection.', 500);
      }
      return row;
    });
    return { catalogEntryId: null, configVersion: updated.configVersion, slug: null, revision: null };
  }

  if (!isLlmProviderCatalogEnabled()) {
    throw new PartnerLlmError('Catalog endpoint selection is currently disabled on this deployment.', 409);
  }

  const provider = await getListedProviderByEntryId(input.catalogEntryId);
  if (!provider) {
    throw new PartnerLlmError('That endpoint was delisted and is no longer available for selection.', 409);
  }

  // Consent must be checked before the model-mapping check below: a partner
  // acknowledges the data note for the ENDPOINT, independent of which model
  // they currently have configured.
  if (provider.dataNote && !input.acknowledgeDataNote) {
    throw new PartnerLlmError(
      'You must acknowledge the data-handling note for this endpoint before selecting it.',
      400,
    );
  }

  const model = existing.defaultModel ?? resolveDefaultModel();
  const endpoint = buildCatalogEndpointSnapshot(provider, model);
  if (!endpoint) {
    throw new PartnerLlmError(
      'That endpoint does not currently support your configured AI model. Choose a different model or endpoint.',
      409,
    );
  }

  const apiKey = decryptPartnerLlmApiKey({ id: existing.id, apiKeyEncrypted: existing.apiKeyEncrypted });
  await probeAnthropicKey(apiKey, endpoint);

  // The probe above ran outside any transaction; only the write is held.
  const updated = await inRegistryWrite(input.partnerId, async () => {
    const [row] = await db
      .update(partnerLlmConfigs)
      .set({
        catalogEntryId: provider.entryId,
        // #7587: pin the model just validated against this revision. A catalog
        // revision serves only the models it mapped AND verified, so a partner
        // left tracking the moving platform default goes `model_unverified` the
        // moment that default changes.
        defaultModel: model,
        configVersion: sql`${partnerLlmConfigs.configVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(partnerLlmConfigs.partnerId, input.partnerId))
      .returning({ configVersion: partnerLlmConfigs.configVersion });
    if (!row) {
      throw new PartnerLlmError('Could not update the endpoint selection.', 500);
    }
    return row;
  });

  return {
    catalogEntryId: provider.entryId,
    configVersion: updated.configVersion,
    slug: provider.slug,
    revision: provider.revision,
  };
}

/**
 * The reconcile then sees no legacy row: it re-points every surface to
 * platform offerings, rebinds agents and live sessions, and removes the
 * connection, in the same transaction as the delete.
 */
export async function deletePartnerLlmConfig(partnerId: string): Promise<boolean> {
  return inRegistryWrite(partnerId, async () => {
    const [deleted] = await db
      .delete(partnerLlmConfigs)
      .where(eq(partnerLlmConfigs.partnerId, partnerId))
      .returning({ id: partnerLlmConfigs.id });
    return deleted !== undefined;
  });
}
