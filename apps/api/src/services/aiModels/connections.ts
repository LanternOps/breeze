/**
 * Partner AI connections (#7600 W02, spec §5.2): how a partner's models are
 * reached. Reads never select key material; only `getConnectionKeyMaterial`
 * (W03's connection factory) and `decryptConnectionKey` touch it.
 *
 * Writers: the one-time per-partner cutover (legacyReconcile.ts byte-copy of
 * partner_llm_configs) and, since W03 Task 6B, the /ai/provider facade's
 * registry-native writes (compatRemap.ts, which uses `createConnection`).
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { db } from '../../db';
import { partnerAiConnections, type PartnerAiConnectionRow } from '../../db/schema';
import { hmacFingerprint } from '../secretCrypto';
import { ConnectionKeyError, encryptConnectionKey } from './connectionKeys';
import { toRegistryWriteError } from './registryWriteErrors';

export {
  ConnectionKeyError,
  decryptConnectionKey,
  encryptConnectionKey,
  PARTNER_AI_CONNECTION_KEY_SPEC,
} from './connectionKeys';

export type PartnerAiConnection = Omit<PartnerAiConnectionRow, 'apiKeyEncrypted' | 'keyFingerprint'>;

export interface CreateConnectionInput {
  id?: string;
  partnerId: string;
  kind: 'anthropic_byok' | 'catalog';
  name: string;
  apiKey: string;
  catalogEntryId?: string | null;
  inferenceGeo?: string | null;
  connectedBy: string | null;
  verifiedAt: Date | null;
}

const PUBLIC_COLUMNS = {
  id: partnerAiConnections.id,
  partnerId: partnerAiConnections.partnerId,
  kind: partnerAiConnections.kind,
  name: partnerAiConnections.name,
  inferenceGeo: partnerAiConnections.inferenceGeo,
  providerConfig: partnerAiConnections.providerConfig,
  keyLast4: partnerAiConnections.keyLast4,
  catalogEntryId: partnerAiConnections.catalogEntryId,
  baseUrl: partnerAiConnections.baseUrl,
  status: partnerAiConnections.status,
  lastError: partnerAiConnections.lastError,
  verifiedAt: partnerAiConnections.verifiedAt,
  configVersion: partnerAiConnections.configVersion,
  connectedBy: partnerAiConnections.connectedBy,
  lastDiscoveredAt: partnerAiConnections.lastDiscoveredAt,
  discoveryError: partnerAiConnections.discoveryError,
  legacyDefaultModel: partnerAiConnections.legacyDefaultModel,
  createdAt: partnerAiConnections.createdAt,
  updatedAt: partnerAiConnections.updatedAt,
} as const;

/** A disconnected connection is provenance only (#7700 finding 1): never listed, never the compat one. */
const LIVE = ne(partnerAiConnections.status, 'disconnected');

export async function listConnections(partnerId: string): Promise<PartnerAiConnection[]> {
  return db
    .select(PUBLIC_COLUMNS)
    .from(partnerAiConnections)
    .where(and(eq(partnerAiConnections.partnerId, partnerId), LIVE))
    .orderBy(asc(partnerAiConnections.createdAt));
}

export async function getConnection(id: string): Promise<PartnerAiConnection | null> {
  const [row] = await db.select(PUBLIC_COLUMNS).from(partnerAiConnections).where(eq(partnerAiConnections.id, id)).limit(1);
  return row ?? null;
}

export async function getCompatConnection(partnerId: string): Promise<PartnerAiConnection | null> {
  // partner_ai_connections_compat_uq guarantees at most one such row (W02–W03).
  const [row] = await db
    .select(PUBLIC_COLUMNS)
    .from(partnerAiConnections)
    .where(and(
      eq(partnerAiConnections.partnerId, partnerId),
      inArray(partnerAiConnections.kind, ['anthropic_byok', 'catalog']),
      LIVE,
    ))
    .limit(1);
  return row ?? null;
}

export async function getConnectionKeyMaterial(
  id: string,
): Promise<{ id: string; partnerId: string; apiKeyEncrypted: string | null } | null> {
  const [row] = await db
    .select({ id: partnerAiConnections.id, partnerId: partnerAiConnections.partnerId, apiKeyEncrypted: partnerAiConnections.apiKeyEncrypted })
    .from(partnerAiConnections)
    .where(eq(partnerAiConnections.id, id))
    .limit(1);
  return row ?? null;
}

export async function createConnection(input: CreateConnectionInput): Promise<PartnerAiConnection> {
  const apiKey = input.apiKey.trim();
  if (apiKey.startsWith('enc:')) {
    throw new ConnectionKeyError('Keys must not start with the encrypted-value prefix.', 'key_rejected');
  }
  if (input.kind === 'catalog' && !input.catalogEntryId) {
    throw new Error('A catalog connection needs a catalog entry.');
  }
  const id = input.id ?? randomUUID();
  // Sealed before the insert so a sealing failure stays a ConnectionKeyError
  // (the /ai/provider facade answers it as "Could not store the API key.").
  const apiKeyEncrypted = encryptConnectionKey(id, apiKey);
  let created: PartnerAiConnection | undefined;
  try {
    [created] = await db
      .insert(partnerAiConnections)
      .values({
        id,
        partnerId: input.partnerId,
        kind: input.kind,
        name: input.name,
        inferenceGeo: input.inferenceGeo ?? null,
        apiKeyEncrypted,
        keyLast4: apiKey.slice(-4),
        keyFingerprint: hmacFingerprint(apiKey),
        catalogEntryId: input.kind === 'catalog' ? input.catalogEntryId! : null,
        status: 'active',
        configVersion: 1,
        verifiedAt: input.verifiedAt,
        connectedBy: input.connectedBy,
      })
      .returning(PUBLIC_COLUMNS);
  } catch (error) {
    // PR #7665 handoff: a failed insert's query params carry the key ciphertext
    // and fingerprint. Scrub at the source so every caller (W03 connectCompat,
    // W04 routes, W06/W07) gets a RegistryWriteError, never the raw error.
    toRegistryWriteError(error, 'Could not save the AI connection.');
  }
  if (!created) throw new Error('Could not create the connection.');
  return created;
}
