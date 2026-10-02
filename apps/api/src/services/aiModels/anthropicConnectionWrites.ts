/**
 * Anthropic API connection writes (W08 #7606): the id-keyed successor of the
 * retired /ai/provider facade (services/partnerLlmConfig.ts, W03 Task 6B).
 *
 * The probe runs OUTSIDE any transaction (connectionProbe.ts); the write then
 * runs in ONE system transaction behind the blocking per-partner registry lock
 * and re-checks, under that lock, that the connection it probed is still the
 * one it writes. Routes (routes/aiModels/connections.ts) own the gates:
 * BILLING_MANAGE + MFA + canManagePartnerWidePolicies, the partner id from auth,
 * and registryWrite's registry gate. Discovery is queued only after commit.
 *
 * A soft-disconnected connection (#7700) is provenance only: every read here
 * and every lock in connectionRemap.ts treats it as absent, so no write edits
 * or revives it.
 */
import { and, eq, inArray, ne } from 'drizzle-orm';
import { ANTHROPIC_API_CONNECTION_KINDS, isAnthropicApiConnectionKind } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { partnerAiConnections } from '../../db/schema';
// `isLlmProviderCatalogEnabled` is called from inside function bodies here,
// never at module-evaluation time.
import { buildCatalogEndpointSnapshot, isLlmProviderCatalogEnabled, type ResolvedLlmEndpoint } from '../llm/llmConfigResolver';
import { getListedProviderByEntryId } from '../llmProviderCatalog';
import {
  AnthropicConnectionMissingError,
  bumpConnectionConfigVersion,
  connectAnthropicConnection,
  disconnectAnthropicConnection,
  lockAnthropicConnection,
  lockAnthropicConnectionIds,
  partnerChatDefaultModelId,
  RegistryNotCutOverError,
  rotateAnthropicConnectionKey,
  setAnthropicConnectionCatalogEntry,
  switchAnthropicConnectionKind,
} from './connectionRemap';
import { ConnectionCheckError, probeAnthropicKey, resolveCatalogEndpointForSelection } from './connectionProbe';
import { ConnectionKeyError, decryptConnectionKey, getConnection, getConnectionKeyMaterial, type PartnerAiConnection } from './connections';
import { ensurePartnerCutover } from './registryCutover';
import { RegistryWriteError, toRegistryWriteError } from './registryWriteErrors';
import { lockPartnerRegistry } from './registryWriteLock';
import { safeErrorMessage } from './safeDbError';

/** R1 cap: one Anthropic API connection per partner while partner_ai_connections_compat_uq exists. W08b Task 14 removes it with the index. */
export const MAX_ANTHROPIC_API_CONNECTIONS_PER_PARTNER = 1;

const notCutOver = () => new ConnectionCheckError('AI configuration is being upgraded. Try again in a moment.', 503);
const configChanged = () => new ConnectionCheckError('The AI provider configuration changed. Reload and try again.', 409);

/**
 * A registry write failure as these writes report it (#7602 BD-5). Raw
 * database errors go through the one registry mapper (registryWriteErrors.ts),
 * which scrubs query values — key ciphertext and fingerprint from
 * createConnection's insert or the rotation's update — so they never reach the
 * route's error handler, the console or Sentry. A unique violation or a stale
 * write means another write won the race: 409, reload; the one actionable 409
 * (no platform model to move features back to) keeps its text. Anything else
 * is a safe 500. The scrubbed cause (SQLSTATE, constraint, primary message) is
 * kept for Sentry.
 */
function fromRegistryWriteError(error: RegistryWriteError): ConnectionCheckError {
  const mapped = error.code === 'conflict' || error.code === 'stale_write'
    ? (error.status === 409 && error.message.startsWith('No platform AI model') ? new ConnectionCheckError(error.message, 409) : configChanged())
    : new ConnectionCheckError('Could not save the AI provider configuration.', 500);
  mapped.cause = error.cause;
  return mapped;
}

async function inRegistryWrite<T>(partnerId: string, write: () => Promise<T>): Promise<T> {
  try {
    return await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        await lockPartnerRegistry(partnerId);
        return write();
      }, 'aiModels.anthropicConnectionWrite'));
  } catch (error) {
    if (error instanceof ConnectionCheckError) throw error;
    if (error instanceof RegistryNotCutOverError) throw notCutOver();
    if (error instanceof AnthropicConnectionMissingError) throw configChanged();
    if (error instanceof ConnectionKeyError) throw new ConnectionCheckError('Could not store the API key.', 500);
    // Only registry errors and errors that carry SQL values are rewritten:
    // toRegistryWriteError rethrows anything else (a remap invariant, a
    // TypeError) untouched, keeping its message and stack for Sentry.
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
 * discovery run. Called only after the write committed, outside any DB context
 * (the instrumented queue asserts it, #3127). Never awaited: a Redis outage
 * must not fail (or hang) a save that already committed; the daily fan-out
 * catches up. Lazy import keeps BullMQ out of this module's import graph.
 */
function scheduleConnectionDiscovery(connectionId: string): void {
  void runOutsideDbContext(async () => {
    const { enqueueConnectionSync } = await import('../../jobs/aiModelDiscoveryWorker');
    await enqueueConnectionSync(connectionId);
  }).catch((error: unknown) => {
    console.error(`[aiModels] model discovery enqueue failed for connection ${connectionId} (non-fatal): ${safeErrorMessage(error)}`);
  });
}

const systemRead = <T>(fn: () => Promise<T>, label: string) =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

/** A live Anthropic API connection of this partner (no key material); anything else is "configuration changed". */
async function readAnthropicConnection(partnerId: string, connectionId: string): Promise<PartnerAiConnection> {
  const conn = await systemRead(() => getConnection(connectionId), 'aiModels.readAnthropicConnection');
  if (!conn || conn.partnerId !== partnerId || conn.status === 'disconnected' || !isAnthropicApiConnectionKind(conn.kind)) {
    throw configChanged();
  }
  return conn;
}

/** A connection's stored key, decrypted (row-bound AAD, same tag as the legacy column). */
async function readConnectionKey(connectionId: string): Promise<string> {
  const material = await systemRead(() => getConnectionKeyMaterial(connectionId), 'aiModels.readConnectionKey');
  if (!material) throw configChanged();
  return decryptConnectionKey(material);
}

const chatDefaultModel = (partnerId: string) =>
  systemRead(() => partnerChatDefaultModelId(partnerId), 'aiModels.chatDefaultModel');

/**
 * Gate first: a partner without its registry rows is bootstrapped
 * (registryCutover.ts) before anything is edited natively; if that cannot
 * happen now the write is refused (503, retryable). connectionRemap re-checks
 * the registry row inside the write transaction.
 */
async function gate(partnerId: string): Promise<void> {
  if (!(await ensurePartnerCutover(partnerId))) throw notCutOver();
}

function cleanKey(apiKey: string): string {
  const key = apiKey.trim();
  if (key.startsWith('enc:')) throw new ConnectionCheckError('Anthropic API keys must not start with the encrypted-value prefix.', 400);
  return key;
}

/** Route-level pre-check (outside any transaction) for the friendly 409; the cap is re-checked under the lock. Soft-disconnected rows do not count. */
export async function hasAnthropicConnection(partnerId: string): Promise<boolean> {
  const [row] = await systemRead(() => db.select({ id: partnerAiConnections.id }).from(partnerAiConnections)
    .where(and(
      eq(partnerAiConnections.partnerId, partnerId),
      inArray(partnerAiConnections.kind, [...ANTHROPIC_API_CONNECTION_KINDS]),
      ne(partnerAiConnections.status, 'disconnected'),
    ))
    .limit(1), 'aiModels.hasAnthropicConnection');
  return Boolean(row);
}

export async function createAnthropicKeyConnection(input: {
  partnerId: string; apiKey: string; userId: string;
}): Promise<{ connectionId: string; last4: string; configVersion: number }> {
  const apiKey = cleanKey(input.apiKey);
  await gate(input.partnerId);
  await probeAnthropicKey(apiKey, { kind: 'anthropic' });
  const verifiedAt = new Date();
  const connectionId = await inRegistryWrite(input.partnerId, async () => {
    const existing = await lockAnthropicConnectionIds(input.partnerId);
    if (existing.length >= MAX_ANTHROPIC_API_CONNECTIONS_PER_PARTNER) {
      throw new ConnectionCheckError('This partner already has an Anthropic connection. Rotate its key instead.', 409);
    }
    return connectAnthropicConnection(input.partnerId, {
      kind: 'anthropic_byok', apiKey, catalogEntryId: null, connectedBy: input.userId, verifiedAt,
      movePlatformReferences: existing.length === 0,
    });
  });
  scheduleConnectionDiscovery(connectionId);
  return { connectionId, last4: apiKey.slice(-4), configVersion: 1 };
}

export async function rotateAnthropicKey(input: {
  partnerId: string; connectionId: string; apiKey: string; userId: string;
}): Promise<{ last4: string; configVersion: number }> {
  const apiKey = cleanKey(input.apiKey);
  await gate(input.partnerId);
  const conn = await readAnthropicConnection(input.partnerId, input.connectionId);
  // Probe against the endpoint the key will be used with.
  const endpoint: ResolvedLlmEndpoint = conn.kind === 'catalog' && conn.catalogEntryId
    ? await resolveCatalogEndpointForSelection(conn.catalogEntryId, await chatDefaultModel(input.partnerId))
    : { kind: 'anthropic' };
  await probeAnthropicKey(apiKey, endpoint);
  const verifiedAt = new Date();
  const rotated = await inRegistryWrite(input.partnerId, async () => {
    const current = await lockAnthropicConnection(input.partnerId, input.connectionId);
    // The probe targeted the endpoint read above; a concurrent kind or endpoint switch makes it stale.
    if (!current || current.kind !== conn.kind || (current.catalogEntryId ?? null) !== (conn.catalogEntryId ?? null)) throw configChanged();
    return rotateAnthropicConnectionKey(input.partnerId, input.connectionId, { apiKey, connectedBy: input.userId, verifiedAt });
  });
  scheduleConnectionDiscovery(input.connectionId);
  return { last4: apiKey.slice(-4), configVersion: rotated.configVersion };
}

/**
 * Select (or clear) the platform-catalog endpoint a connection routes through
 * (#3922 W3). Clearing reverts to direct Anthropic without a probe — the key
 * was verified against Anthropic when connected. A selection is verified end
 * to end before anything is written: listed with an active revision, the data
 * note acknowledged, the partner's chat default model mapped AND verified on
 * the entry, then a live probe with the stored key. Any failure persists
 * nothing. A same-kind change edits the connection in place; a kind switch
 * converts it in place too (same id, key and references).
 */
export async function changeAnthropicEndpoint(input: {
  partnerId: string; connectionId: string; catalogEntryId: string | null; acknowledgeDataNote: boolean; userId: string;
}): Promise<{ connectionId: string; catalogEntryId: string | null; configVersion: number; slug: string | null; revision: number | null }> {
  await gate(input.partnerId);
  const existing = await readAnthropicConnection(input.partnerId, input.connectionId);
  /**
   * The write must act on the connection exactly as validated (and probed)
   * above: a concurrent rotation, switch or disconnect makes the validation stale.
   */
  const assertUnchanged = async () => {
    const current = await lockAnthropicConnection(input.partnerId, existing.id);
    if (!current || current.configVersion !== existing.configVersion) throw configChanged();
    return current;
  };

  if (input.catalogEntryId === null) {
    const switched = { value: false };
    const updated = await inRegistryWrite(input.partnerId, async (): Promise<{ connectionId: string; configVersion: number }> => {
      const current = await assertUnchanged();
      if (current.kind === 'anthropic_byok') return { connectionId: current.id, ...(await bumpConnectionConfigVersion(input.partnerId, current.id)) };
      switched.value = true;
      return switchAnthropicConnectionKind(input.partnerId, current.id, { kind: 'anthropic_byok', catalogEntryId: null });
    });
    // A kind switch changes the destination: rediscover. A bare version bump does not.
    if (switched.value) scheduleConnectionDiscovery(updated.connectionId);
    return { connectionId: updated.connectionId, catalogEntryId: null, configVersion: updated.configVersion, slug: null, revision: null };
  }

  if (!isLlmProviderCatalogEnabled()) {
    throw new ConnectionCheckError('Catalog endpoint selection is currently disabled on this deployment.', 409);
  }
  const provider = await getListedProviderByEntryId(input.catalogEntryId);
  if (!provider) throw new ConnectionCheckError('That endpoint was delisted and is no longer available for selection.', 409);
  // Consent must be checked before the model-mapping check below: a partner
  // acknowledges the data note for the ENDPOINT, independent of the model.
  if (provider.dataNote && !input.acknowledgeDataNote) {
    throw new ConnectionCheckError('You must acknowledge the data-handling note for this endpoint before selecting it.', 400);
  }
  const model = await chatDefaultModel(input.partnerId);
  const endpoint = buildCatalogEndpointSnapshot(provider, model);
  if (!endpoint) {
    throw new ConnectionCheckError(
      'That endpoint does not currently support your configured AI model. Choose a different model or endpoint.', 409,
    );
  }
  const apiKey = await readConnectionKey(existing.id);
  await probeAnthropicKey(apiKey, endpoint);

  // The probe above ran outside any transaction; only the write is held.
  const updated = await inRegistryWrite(input.partnerId, async (): Promise<{ connectionId: string; configVersion: number }> => {
    const current = await assertUnchanged();
    if (current.kind === 'catalog') {
      return { connectionId: current.id, ...(await setAnthropicConnectionCatalogEntry(input.partnerId, current.id, { catalogEntryId: provider.entryId })) };
    }
    return switchAnthropicConnectionKind(input.partnerId, current.id, { kind: 'catalog', catalogEntryId: provider.entryId });
  });
  scheduleConnectionDiscovery(updated.connectionId);
  return { connectionId: updated.connectionId, catalogEntryId: provider.entryId, configVersion: updated.configVersion, slug: provider.slug, revision: provider.revision };
}

/**
 * Disconnect: the connection's references go back to the same models on the
 * platform and the connection is soft-disconnected (keyless, its offerings
 * disabled), in one transaction. False when it was not a live connection.
 */
export async function deleteAnthropicConnection(input: { partnerId: string; connectionId: string }): Promise<boolean> {
  await gate(input.partnerId);
  return inRegistryWrite(input.partnerId, () => disconnectAnthropicConnection(input.partnerId, input.connectionId));
}
