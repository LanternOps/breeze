/**
 * Partner AI connections (#7600 W02, spec §5.2): how a partner's models are
 * reached. Reads never select key material; only `getConnectionKeyMaterial`
 * (W03's connection factory) and `decryptConnectionKey` touch it.
 *
 * Writers: the one-time per-partner cutover (legacyReconcile.ts byte-copy of
 * partner_llm_configs), the id-keyed Anthropic connection writes
 * (anthropicConnectionWrites.ts → connectionRemap.ts, which uses
 * `createConnection`; W03 Task 6B, id-keyed since W08), and
 * since W06 the gateway-kind write service (gatewayConnections.ts, which uses
 * `createGatewayConnectionRow` and `gatewayKeyColumns`).
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import type { GatewayConnectionKind } from '@breeze/shared';
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

/** Every column except key material (ciphertext, fingerprint). Writers return rows through it. */
export const CONNECTION_PUBLIC_COLUMNS = {
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
const PUBLIC_COLUMNS = CONNECTION_PUBLIC_COLUMNS;

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

export interface ConnectionKeyMaterial {
  id: string;
  partnerId: string;
  status: string;
  kind: string;
  baseUrl: string | null;
  configVersion: number;
  apiKeyEncrypted: string | null;
}

/**
 * `status` is read in the SAME row read as the key (W06): a gateway kind may be
 * legitimately keyless, so a NULL key is only "keyless" while the row is
 * active — a disconnected row also has a NULL key (disconnected_keyless_chk).
 * The routing fields (kind, base_url, config_version) come from the same row
 * read too: a caller that already holds a routing snapshot compares them
 * (gatewayCandidate.sameRoutingSnapshot) so a key is never paired with a URL
 * it was not stored for.
 */
export async function getConnectionKeyMaterial(id: string): Promise<ConnectionKeyMaterial | null> {
  const [row] = await db
    .select({
      id: partnerAiConnections.id,
      partnerId: partnerAiConnections.partnerId,
      status: partnerAiConnections.status,
      kind: partnerAiConnections.kind,
      baseUrl: partnerAiConnections.baseUrl,
      configVersion: partnerAiConnections.configVersion,
      apiKeyEncrypted: partnerAiConnections.apiKeyEncrypted,
    })
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

/**
 * W06: a gateway key must be at least this long. The gateway's scrubber
 * redacts secrets of 8+ characters wherever an endpoint echoes them, so a
 * shorter key could leak into stored error text (Codex review #2).
 */
export const MIN_GATEWAY_KEY_LENGTH = 8;

export interface ConnectionKeyColumns {
  apiKeyEncrypted: string | null;
  keyLast4: string | null;
  keyFingerprint: string | null;
}

/**
 * The key triplet for a gateway-kind row: sealed to the row id (row-bound
 * AAD), last 4 and HMAC fingerprint, exactly as for anthropic_byok. `null`
 * means keyless (a local endpoint) — all three NULL, as
 * partner_ai_connections_key_triplet_chk requires. Throws ConnectionKeyError
 * (never echoing the key) for an encrypted-envelope paste or a short key.
 */
export function gatewayKeyColumns(id: string, apiKey: string | null): ConnectionKeyColumns {
  if (apiKey === null) return { apiKeyEncrypted: null, keyLast4: null, keyFingerprint: null };
  const key = apiKey.trim();
  if (key.startsWith('enc:')) {
    throw new ConnectionKeyError('Keys must not start with the encrypted-value prefix.', 'key_rejected');
  }
  if (key.length < MIN_GATEWAY_KEY_LENGTH) {
    throw new ConnectionKeyError(`A key must be at least ${MIN_GATEWAY_KEY_LENGTH} characters.`, 'key_rejected');
  }
  return { apiKeyEncrypted: encryptConnectionKey(id, key), keyLast4: key.slice(-4), keyFingerprint: hmacFingerprint(key) };
}

export interface CreateGatewayConnectionRowInput {
  id?: string;
  partnerId: string;
  kind: GatewayConnectionKind;
  name: string;
  /** Must already have passed validateByoBaseUrl: this helper does no DNS (it runs inside the write transaction). */
  baseUrl: string;
  /** Absent/null = keyless. */
  apiKey?: string | null;
  providerConfig?: Record<string, unknown> | null;
  connectedBy: string | null;
}

/**
 * Inserts one gateway-kind connection (W06), beside `createConnection` (which
 * stays Anthropic-dialect only). The plain insert: callers own validation, the
 * registry lock and the transaction (gatewayConnections.ts; Task 15's env
 * bootstrap under the same lock). Insert failures are scrubbed into a
 * RegistryWriteError at the source: their params carry the key ciphertext.
 */
export async function createGatewayConnectionRow(input: CreateGatewayConnectionRowInput): Promise<PartnerAiConnection> {
  const id = input.id ?? randomUUID();
  // Sealed before the insert: a sealing failure stays a ConnectionKeyError.
  const keyColumns = gatewayKeyColumns(id, input.apiKey ?? null);
  let created: PartnerAiConnection | undefined;
  try {
    [created] = await db
      .insert(partnerAiConnections)
      .values({
        id,
        partnerId: input.partnerId,
        kind: input.kind,
        name: input.name,
        inferenceGeo: null,
        providerConfig: input.providerConfig ?? null,
        ...keyColumns,
        catalogEntryId: null,
        baseUrl: input.baseUrl,
        status: 'active',
        configVersion: 1,
        verifiedAt: null,
        connectedBy: input.connectedBy,
      })
      .returning(PUBLIC_COLUMNS);
  } catch (error) {
    toRegistryWriteError(error, 'Could not save the AI connection.');
  }
  if (!created) throw new Error('Could not create the connection.');
  return created;
}
