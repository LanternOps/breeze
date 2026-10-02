/**
 * Partner AI connections (#7600 W02, spec §5.2): how a partner's models are
 * reached. Reads never select key material; only `getConnectionKeyMaterial`
 * (W03's connection factory) and `decryptConnectionKey` touch it.
 *
 * W02: the only production writer is the legacy reconcile (byte-copy of
 * partner_llm_configs) and the legacy-UPDATE mirror trigger (Task 2 migration);
 * `createConnection` is the W04 entry point, gated at its route.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { partnerAiConnections, type PartnerAiConnectionRow } from '../../db/schema';
import { columnAad, encryptedColumnRegistry, type EncryptedColumnSpec } from '../encryptedColumnRegistry';
import { decryptSecret, encryptSecret, hmacFingerprint } from '../secretCrypto';

export const PARTNER_AI_CONNECTION_KEY_SPEC: EncryptedColumnSpec = (() => {
  const spec = encryptedColumnRegistry.find(
    (entry) => entry.table === 'partner_ai_connections' && entry.column === 'api_key_encrypted',
  );
  if (!spec) throw new Error('partner_ai_connections.api_key_encrypted is missing from encryptedColumnRegistry');
  return spec;
})();

export type PartnerAiConnection = Omit<PartnerAiConnectionRow, 'apiKeyEncrypted' | 'keyFingerprint'>;

export class ConnectionKeyError extends Error {
  constructor(message: string, readonly code: 'key_missing' | 'key_empty' | 'key_rejected') {
    super(message);
    this.name = 'ConnectionKeyError';
  }
}

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

export function encryptConnectionKey(id: string, apiKey: string): string {
  const sealed = encryptSecret(apiKey, { aad: columnAad(PARTNER_AI_CONNECTION_KEY_SPEC, id) });
  if (!sealed) throw new ConnectionKeyError('Could not encrypt the connection key.', 'key_rejected');
  return sealed;
}

export function decryptConnectionKey(conn: { id: string; apiKeyEncrypted: string | null }): string {
  if (!conn.apiKeyEncrypted) throw new ConnectionKeyError('This connection has no stored key.', 'key_missing');
  const apiKey = decryptSecret(conn.apiKeyEncrypted, { aad: columnAad(PARTNER_AI_CONNECTION_KEY_SPEC, conn.id) });
  if (!apiKey) throw new ConnectionKeyError('The stored connection key decrypted to an empty value.', 'key_empty');
  return apiKey;
}

export async function listConnections(partnerId: string): Promise<PartnerAiConnection[]> {
  return db
    .select(PUBLIC_COLUMNS)
    .from(partnerAiConnections)
    .where(eq(partnerAiConnections.partnerId, partnerId))
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
  const [created] = await db
    .insert(partnerAiConnections)
    .values({
      id,
      partnerId: input.partnerId,
      kind: input.kind,
      name: input.name,
      inferenceGeo: input.inferenceGeo ?? null,
      apiKeyEncrypted: encryptConnectionKey(id, apiKey),
      keyLast4: apiKey.slice(-4),
      keyFingerprint: hmacFingerprint(apiKey),
      catalogEntryId: input.kind === 'catalog' ? input.catalogEntryId! : null,
      status: 'active',
      configVersion: 1,
      verifiedAt: input.verifiedAt,
      connectedBy: input.connectedBy,
    })
    .returning(PUBLIC_COLUMNS);
  if (!created) throw new Error('Could not create the connection.');
  return created;
}
