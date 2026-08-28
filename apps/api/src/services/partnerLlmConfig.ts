import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { partnerLlmConfigs } from '../db/schema';
import { resolveDefaultModel } from './aiModel';
import { OFFERABLE_AI_MODELS } from './aiCostTracker';
import {
  columnAad,
  encryptedColumnRegistry,
  type EncryptedColumnSpec,
} from './encryptedColumnRegistry';
import { buildGuardedLlmFetch, LlmEgressViolationError } from './llm/guardedLlmFetch';
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
  const client = endpoint.kind === 'catalog'
    ? new Anthropic({
        baseURL: endpoint.baseUrl,
        // Exactly one credential header, the other explicitly nulled — same
        // invariant as the resolved catalog client in llmConfigResolver.ts.
        ...(endpoint.authMode === 'x-api-key'
          ? { apiKey, authToken: null }
          : { authToken: apiKey, apiKey: null }),
        fetch: buildGuardedLlmFetch({
          allowedOrigin: new URL(endpoint.baseUrl).origin,
          recordEgress: buildProbeEgressRecorder(),
        }),
      })
    : new Anthropic({ apiKey });
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

  const stored = await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
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
    }),
  );

  return {
    last4,
    model: stored.defaultModel ?? resolveDefaultModel(),
    verifiedAt,
    configVersion: stored.configVersion,
  };
}

export async function getPartnerLlmStatus(partnerId: string): Promise<PartnerLlmStatus> {
  const [row] = await db
    .select({
      provider: partnerLlmConfigs.provider,
      keyLast4: partnerLlmConfigs.keyLast4,
      defaultModel: partnerLlmConfigs.defaultModel,
      status: partnerLlmConfigs.status,
      verifiedAt: partnerLlmConfigs.verifiedAt,
      lastError: partnerLlmConfigs.lastError,
      catalogEntryId: partnerLlmConfigs.catalogEntryId,
    })
    .from(partnerLlmConfigs)
    .where(eq(partnerLlmConfigs.partnerId, partnerId))
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
  if (input.defaultModel !== null && !OFFERABLE_AI_MODELS.includes(input.defaultModel)) {
    throw new PartnerLlmError('Unsupported Anthropic model.', 400);
  }

  const [updated] = await db
    .update(partnerLlmConfigs)
    .set({
      defaultModel: input.defaultModel,
      configVersion: sql`${partnerLlmConfigs.configVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(partnerLlmConfigs.partnerId, input.partnerId))
    .returning({ configVersion: partnerLlmConfigs.configVersion });
  if (!updated) {
    throw new PartnerLlmError('Connect an Anthropic API key before selecting a model.', 409);
  }

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
    const [updated] = await db
      .update(partnerLlmConfigs)
      .set({
        catalogEntryId: null,
        configVersion: sql`${partnerLlmConfigs.configVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(partnerLlmConfigs.partnerId, input.partnerId))
      .returning({ configVersion: partnerLlmConfigs.configVersion });
    if (!updated) {
      throw new PartnerLlmError('Could not update the endpoint selection.', 500);
    }
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

  const [updated] = await db
    .update(partnerLlmConfigs)
    .set({
      catalogEntryId: provider.entryId,
      configVersion: sql`${partnerLlmConfigs.configVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(partnerLlmConfigs.partnerId, input.partnerId))
    .returning({ configVersion: partnerLlmConfigs.configVersion });
  if (!updated) {
    throw new PartnerLlmError('Could not update the endpoint selection.', 500);
  }

  return {
    catalogEntryId: provider.entryId,
    configVersion: updated.configVersion,
    slug: provider.slug,
    revision: provider.revision,
  };
}

export async function deletePartnerLlmConfig(partnerId: string): Promise<boolean> {
  const [deleted] = await db
    .delete(partnerLlmConfigs)
    .where(eq(partnerLlmConfigs.partnerId, partnerId))
    .returning({ id: partnerLlmConfigs.id });
  return deleted !== undefined;
}
