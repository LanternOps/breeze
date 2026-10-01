import Anthropic from '@anthropic-ai/sdk';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { partnerAiConnections } from '../db/schema';
import { resolveDefaultModel } from './aiModel';
import {
  bumpCompatConfigVersion,
  changeCompatDefaultModel,
  CompatConnectionMissingError,
  connectCompat,
  disconnectCompat,
  lockCompatConnection,
  RegistryNotCutOverError,
  rotateCompatKey,
  setCompatCatalogEntry,
  switchCompatKind,
} from './aiModels/compatRemap';
import { createAnthropicClient } from './aiModels/connectionFactory';
import {
  ConnectionKeyError,
  decryptConnectionKey,
  getCompatConnection,
  getConnectionKeyMaterial,
  type PartnerAiConnection,
} from './aiModels/connections';
import { lockPartnerRegistryReconcile } from './aiModels/legacyReconcile';
import { isOfferablePlatformModel } from './aiModels/platformModels';
import { ensurePartnerCutover } from './aiModels/registryCutover';
import { safeErrorMessage } from './aiModels/safeDbError';
import { RegistryWriteError, toRegistryWriteError } from './aiModels/registryWriteErrors';
import { LlmEgressViolationError } from './llm/guardedLlmFetch';
// `isLlmProviderCatalogEnabled` is called from inside function bodies here,
// never at module-evaluation time.
import {
  buildCatalogEndpointSnapshot,
  isLlmProviderCatalogEnabled,
  type ResolvedLlmEndpoint,
} from './llm/llmConfigResolver';
import { getListedProviderByEntryId } from './llmProviderCatalog';
import { captureException } from './sentry';

export class PartnerLlmError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 409 | 500 | 503,
  ) {
    super(message);
    this.name = 'PartnerLlmError';
  }
}

const notCutOver = () => new PartnerLlmError('AI configuration is being upgraded. Try again in a moment.', 503);
const configChanged = () => new PartnerLlmError('The AI provider configuration changed. Reload and try again.', 409);

/**
 * A registry write failure as the facade reports it (#7602 BD-5). Raw database
 * errors go through the one registry mapper (aiModels/registryWriteErrors.ts),
 * which scrubs query values — key ciphertext and fingerprint from
 * createConnection's insert or the rotation's update — so they never reach the
 * route's error handler, the console or Sentry. A unique violation or a stale
 * write means another write won the race: 409, reload. Anything else is a safe
 * 500. The registry error's own message is never surfaced; the scrubbed cause
 * (SQLSTATE, constraint, primary message) is kept for Sentry.
 */
function fromRegistryWriteError(error: RegistryWriteError): PartnerLlmError {
  const mapped = error.code === 'conflict' || error.code === 'stale_write'
    ? configChanged()
    : new PartnerLlmError('Could not save the AI provider configuration.', 500);
  mapped.cause = error.cause;
  return mapped;
}

/**
 * #7601 W03 Task 6B — the authority flip. For a cut-over partner the registry
 * is the authority: every /ai/provider mutation is a registry-native edit
 * (aiModels/compatRemap.ts: offering-id remaps), never a re-projection of
 * legacy config, and partner_llm_configs is no longer written.
 *
 * Gate first: a partner that has not been cut over yet gets its ONE projection
 * (registryCutover.ts) before anything is edited natively; if that cannot
 * happen now the write is refused (503, retryable). compatRemap re-checks the
 * cutover row inside the write transaction.
 *
 * The write runs in ONE system transaction behind the per-partner registry
 * lock (the lock the cutover takes too), so concurrent writes and a cutover
 * serialize. Partner pinning comes from the route (BILLING_MANAGE +
 * canManagePartnerWidePolicies); every statement filters on partnerId. Probes
 * never run in here — no transaction is held across the network.
 */
async function ensureCutOver(partnerId: string): Promise<void> {
  if (!(await ensurePartnerCutover(partnerId))) throw notCutOver();
}

async function inRegistryWrite<T>(partnerId: string, write: () => Promise<T>): Promise<T> {
  try {
    return await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        await lockPartnerRegistryReconcile(partnerId);
        return write();
      }, 'aiProvider.registryWrite'));
  } catch (error) {
    if (error instanceof PartnerLlmError) throw error;
    if (error instanceof RegistryNotCutOverError) throw notCutOver();
    if (error instanceof CompatConnectionMissingError) throw configChanged();
    if (error instanceof ConnectionKeyError) throw new PartnerLlmError('Could not store the API key.', 500);
    // Only registry errors and errors that carry SQL values are rewritten:
    // toRegistryWriteError rethrows anything else (a remap invariant, a
    // TypeError) untouched, keeping its message and stack so a blocked
    // /ai/provider write stays diagnosable in Sentry.
    try {
      toRegistryWriteError(error, 'Could not save the AI provider configuration.');
    } catch (mapped) {
      if (mapped instanceof RegistryWriteError) throw fromRegistryWriteError(mapped);
      throw mapped;
    }
  }
}

/**
 * Spec §6: a new connection, or a key/endpoint change on one, gets a model
 * discovery run (`ai-model-discovery` / `sync-connection`). Called only after
 * the write committed, outside any DB context (the instrumented queue asserts
 * it, #3127). Never awaited: a Redis outage must not fail (or hang) a save
 * that already committed; the daily fan-out catches up. Lazy import keeps
 * BullMQ out of this module's import graph.
 */
function scheduleConnectionDiscovery(connectionId: string): void {
  void runOutsideDbContext(async () => {
    const { enqueueConnectionSync } = await import('../jobs/aiModelDiscoveryWorker');
    await enqueueConnectionSync(connectionId);
  }).catch((error: unknown) => {
    console.error(`[partnerLlmConfig] model discovery enqueue failed for connection ${connectionId} (non-fatal): ${safeErrorMessage(error)}`);
  });
}

/** The partner's compat connection (no key material), read in system scope. */
function readCompatConnection(partnerId: string): Promise<PartnerAiConnection | null> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() => getCompatConnection(partnerId), 'aiProvider.readConnection'));
}

/** A connection's stored key, decrypted (row-bound AAD, same tag as the legacy column). */
async function readConnectionKey(connectionId: string): Promise<string> {
  const material = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() => getConnectionKeyMaterial(connectionId), 'aiProvider.readConnectionKey'));
  if (!material) throw configChanged();
  return decryptConnectionKey(material);
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
 * to direct Anthropic; a `kind: 'catalog'` endpoint routes the same ping
 * through the guarded fetch, pinned to the catalog revision's origin, with no
 * partner-level org to attribute the audit event to (see
 * {@link buildProbeEgressRecorder}).
 */
async function probeAnthropicKey(apiKey: string, endpoint: ResolvedLlmEndpoint = { kind: 'anthropic' }): Promise<void> {
  const model = endpoint.kind === 'catalog' ? endpoint.providerModel : resolveDefaultModel();
  // Probe through the connection factory, against the target the key will be
  // used with: a partner key is pinned to the public API; a catalog key goes
  // through the guarded fetch with exactly one credential header.
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
 * `catalogEgressRecorder` in `aiModels/connectionFactory.ts` for the same
 * no-org posture). The guarded fetch's security controls — origin pinning,
 * connect-time SSRF pinning, no redirects — are unaffected by whether the
 * attempt is audited. Warns once per probe rather than once per HTTP attempt.
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
 * Joins a catalog entry + model to a probeable `ResolvedLlmEndpoint`, or
 * throws a typed, fail-loud `PartnerLlmError` explaining why it cannot.
 * Shared by the key-rotation probe target and {@link updatePartnerLlmEndpoint}
 * so the two paths can never disagree about what "selectable" means. Never
 * falls back to probing api.anthropic.com with a key meant for a third-party
 * endpoint.
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
  await ensureCutOver(input.partnerId);

  // Probe against the endpoint the key will be used with: the selected catalog
  // entry if there is one, otherwise direct Anthropic.
  const existing = await readCompatConnection(input.partnerId);
  const probeEndpoint: ResolvedLlmEndpoint = existing?.catalogEntryId
    ? await resolveCatalogEndpointForSelection(existing.catalogEntryId, existing.legacyDefaultModel ?? resolveDefaultModel())
    : { kind: 'anthropic' };
  await probeAnthropicKey(apiKey, probeEndpoint);

  const verifiedAt = new Date();
  const stored = await inRegistryWrite(input.partnerId, async () => {
    const current = await lockCompatConnection(input.partnerId);
    if (!current) {
      // First key: a new BYOK connection; platform references move onto it.
      const connectionId = await connectCompat(input.partnerId, {
        kind: 'anthropic_byok', apiKey, catalogEntryId: null, connectedBy: input.userId, defaultModel: null, verifiedAt,
      });
      return { configVersion: 1, defaultModel: null as string | null, connectionId };
    }
    // The probe targeted the endpoint read above; a concurrent kind switch makes it stale.
    if ((current.catalogEntryId ?? null) !== (existing?.catalogEntryId ?? null)) throw configChanged();
    const rotated = await rotateCompatKey(input.partnerId, { apiKey, connectedBy: input.userId, verifiedAt });
    return { ...rotated, connectionId: current.id };
  });
  scheduleConnectionDiscovery(stored.connectionId);

  return {
    last4: apiKey.slice(-4),
    model: stored.defaultModel ?? resolveDefaultModel(),
    verifiedAt,
    configVersion: stored.configVersion,
  };
}

export async function getPartnerLlmStatus(partnerId: string): Promise<PartnerLlmStatus> {
  // legacy_default_model is the partner's pin (null = tracks the deployment
  // default); partner_ai_connections_compat_uq guarantees one row.
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
      ne(partnerAiConnections.status, 'disconnected'),
    ))
    .limit(1);

  // The query excludes disconnected rows; the guard narrows the type.
  if (!row || row.status === 'disconnected') {
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
  await ensureCutOver(input.partnerId);

  // A throw inside the write rolls the transaction back: a 409 writes nothing.
  const updated = await inRegistryWrite(input.partnerId, async () => {
    if (!(await lockCompatConnection(input.partnerId))) {
      throw new PartnerLlmError('Connect an Anthropic API key before selecting a model.', 409);
    }
    return changeCompatDefaultModel(input.partnerId, input.defaultModel);
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
 *
 * Registry-native (Task 6B): a same-kind change edits the connection in place;
 * a kind switch (direct ↔ catalog) is disconnect + connect with the same key.
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
  await ensureCutOver(input.partnerId);
  const existing = await readCompatConnection(input.partnerId);
  if (!existing) {
    throw new PartnerLlmError('Connect an Anthropic API key before selecting an endpoint.', 409);
  }
  /** The write must act on the connection that was validated (and probed) above. */
  const assertUnchanged = async () => {
    const current = await lockCompatConnection(input.partnerId);
    if (!current || current.id !== existing.id) throw configChanged();
    return current;
  };

  if (input.catalogEntryId === null) {
    const apiKey = existing.kind === 'catalog' ? await readConnectionKey(existing.id) : null;
    const updated = await inRegistryWrite(input.partnerId, async (): Promise<{ configVersion: number; connectionId?: string }> => {
      await assertUnchanged();
      if (apiKey === null) return bumpCompatConfigVersion(input.partnerId);
      return switchCompatKind(input.partnerId, {
        kind: 'anthropic_byok', apiKey, catalogEntryId: null, defaultModel: existing.legacyDefaultModel,
      });
    });
    // A kind switch is a new connection; a bare version bump changes no key or endpoint.
    if (updated.connectionId) scheduleConnectionDiscovery(updated.connectionId);
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

  const model = existing.legacyDefaultModel ?? resolveDefaultModel();
  const endpoint = buildCatalogEndpointSnapshot(provider, model);
  if (!endpoint) {
    throw new PartnerLlmError(
      'That endpoint does not currently support your configured AI model. Choose a different model or endpoint.',
      409,
    );
  }

  const apiKey = await readConnectionKey(existing.id);
  await probeAnthropicKey(apiKey, endpoint);

  // The probe above ran outside any transaction; only the write is held.
  // #7587: the model just validated against this revision is pinned — a
  // catalog revision serves only the models it mapped AND verified.
  const updated = await inRegistryWrite(input.partnerId, async () => {
    const current = await assertUnchanged();
    if (current.kind === 'catalog') {
      const edited = await setCompatCatalogEntry(input.partnerId, { catalogEntryId: provider.entryId, pinnedModel: model });
      return { ...edited, connectionId: current.id };
    }
    return switchCompatKind(input.partnerId, {
      kind: 'catalog', apiKey, catalogEntryId: provider.entryId, defaultModel: model,
    });
  });
  scheduleConnectionDiscovery(updated.connectionId);

  return {
    catalogEntryId: provider.entryId,
    configVersion: updated.configVersion,
    slug: provider.slug,
    revision: provider.revision,
  };
}

/**
 * Disconnect: every surface and binding goes back to the same model's platform
 * offering and the connection is removed, in one transaction.
 */
export async function deletePartnerLlmConfig(partnerId: string): Promise<boolean> {
  await ensureCutOver(partnerId);
  return inRegistryWrite(partnerId, () => disconnectCompat(partnerId));
}
