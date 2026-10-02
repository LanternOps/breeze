/**
 * Gateway-kind connection writes and manual model entry (W06 #7604, Task 10).
 *
 * Never goes through the /ai/provider compat facade (Anthropic-only, bound to
 * partner_ai_connections_compat_uq, whose predicate excludes gateway kinds).
 *
 * Every write follows the W04 model (offeringWrites.inPartnerRegistryWrite):
 * its own system transaction behind the partner registry try-lock (503
 * registry_busy), every statement pinned to `partnerId` (from auth, never the
 * body), failures mapped through toRegistryWriteError. A base URL is validated
 * (DNS) BEFORE that transaction opens and outside any held request context
 * (urlSafety's #1105 tripwire): an unbounded lookup must never pin a pooled
 * connection. The registry write itself does no network I/O.
 *
 * Rules (plan Task 10, adapted to W03's soft-disconnect):
 * - A disconnected connection is provenance only: never edited, re-activated,
 *   given a model or disconnected again — all 404, as if absent.
 * - An env-managed connection (provider_config.managedBy = 'env', Task 15) is
 *   read-only here: 409 managed_by_env. That includes hand-entered models on
 *   it. A RELEASED one (variables unset, envReleasedAt set) still holds the
 *   operator's endpoint and key: it stays read-only, and the partner may only
 *   disconnect it. Only the bootstrap (allowManaged) writes either.
 * - A base-URL change (origin or path) must carry the key for the new URL in
 *   the same write (a string, or null = keyless): the stored key never follows
 *   a connection to a new endpoint. 422 key_required_for_new_endpoint.
 * - Every endpoint/key change bumps config_version (live sessions rebuild) and
 *   clears last_error. A base-URL change makes each offering's verification
 *   stale by fingerprint (gatewayCapabilities.endpointFingerprint) — offerings
 *   are never written for it. A key rotation leaves verification valid.
 * - "Delete" is a soft-disconnect (compatRemap.disconnectCompat shape): status
 *   'disconnected', key triplet NULL, config_version bumped, offerings
 *   disabled, base_url kept (shape_chk). Never a hard delete: a reserved turn
 *   on one of its offerings must still settle (ai_invocations provenance
 *   guard). Refused while an offering is an assignment default.
 * - No write here ever sets partner_ai_models.capabilities: only the Task 12
 *   verifier writes a verification record.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { BYO_MODEL_ID_PATTERN, isGatewayConnectionKind, type AiSurface, type ModelRates } from '@breeze/shared';
import { db, runOutsideDbContext } from '../../db';
import { aiModelAssignments, partnerAiConnections, partnerAiModels } from '../../db/schema';
import {
  CONNECTION_PUBLIC_COLUMNS,
  createGatewayConnectionRow,
  gatewayKeyColumns,
  type PartnerAiConnection,
} from './connections';
import { validateByoBaseUrl } from './gateway/byoEndpointPolicy';
import { inPartnerRegistryWrite, type OfferingInUse } from './offeringWrites';
import type { Offering } from './offerings';
import { RegistryWriteError } from './registryWriteErrors';

export interface CreateGatewayConnectionInput {
  partnerId: string;
  name: string;
  baseUrl: string;
  /** Absent = keyless (a local endpoint). */
  apiKey?: string;
  connectedBy: string | null;
  /** Task 15 env bootstrap only. */
  managedBy?: 'env';
}

export interface UpdateGatewayConnectionInput {
  partnerId: string;
  connectionId: string;
  baseUrl?: string;
  /** A string rotates the key; `null` clears it (keyless); absent leaves it. */
  apiKey?: string | null;
  expectedConfigVersion: number;
  /** Task 15 env bootstrap only: lets it rewrite its own env-managed row. */
  allowManaged?: boolean;
}

export interface DeleteGatewayConnectionInput {
  partnerId: string;
  connectionId: string;
  /** Task 15 env bootstrap only. */
  allowManaged?: boolean;
}

export interface CreateManualOfferingInput {
  partnerId: string;
  connectionId: string;
  modelId: string;
  displayName?: string;
  prices?: ModelRates | null;
  /** Task 15 env bootstrap only: adds the env model to its own env-managed connection. */
  allowManaged?: boolean;
}

const NOT_FOUND = 'Connection not found.';
const MANAGED_BY_ENV = 'This connection is managed by the MCP_LLM_* environment variables. Change them and restart Breeze.';
const RELEASED_BY_ENV = 'This connection was set up from the MCP_LLM_* environment variables, which are no longer set. It cannot be edited; you can disconnect it.';
const KEY_REQUIRED = 'Enter the key for the new URL (or remove the key).';
const STALE = 'This connection changed since you opened it. Reload and try again.';
const MAX_DISPLAY_NAME = 120;

/**
 * Env-bootstrap ownership of a gateway connection (provider_config):
 *  - 'managed': kept in sync with MCP_LLM_* (managedBy = 'env');
 *  - 'released': the variables were unset (envReleasedAt set). It still holds
 *    the operator's endpoint and key, so it stays read-only for the partner —
 *    who may only disconnect it — until the bootstrap re-adopts it.
 */
export type EnvManagementState = 'managed' | 'released' | null;

export function envManagementState(providerConfig: Record<string, unknown> | null | undefined): EnvManagementState {
  const cfg = providerConfig as { managedBy?: unknown; envReleasedAt?: unknown } | null | undefined;
  if (cfg?.managedBy !== 'env') return null;
  return typeof cfg.envReleasedAt === 'string' ? 'released' : 'managed';
}

/** Hand-entered models per connection, counted under the registry lock. */
export const MAX_MANUAL_OFFERINGS_PER_CONNECTION = 200;

/** Env-managed, whether still synced or released: read-only for the partner either way. */
export function isEnvManaged(conn: Pick<PartnerAiConnection, 'providerConfig'>): boolean {
  return envManagementState(conn.providerConfig) !== null;
}

/** Env-managed but no longer synced (MCP_LLM_* unset): the partner may disconnect it, nothing else. */
export function isEnvReleased(conn: Pick<PartnerAiConnection, 'providerConfig'>): boolean {
  return envManagementState(conn.providerConfig) === 'released';
}

/** DNS-bearing validation, outside any held DB context and before the registry transaction. */
function validateOutsideDb(raw: string): Promise<string> {
  return runOutsideDbContext(() => validateByoBaseUrl(raw));
}

interface LockedGatewayConnection {
  id: string;
  kind: string;
  status: string;
  providerConfig: Record<string, unknown> | null;
  configVersion: number;
  baseUrl: string | null;
  /** Non-null exactly when a key is stored (key_triplet_chk). */
  keyLast4: string | null;
}

/**
 * The partner's own, live, gateway-kind connection, row-locked for this
 * transaction. Anything else — another partner's, an Anthropic-dialect kind
 * (the compat flows own it), a disconnected row — is 404.
 */
async function lockOwnGatewayConnection(partnerId: string, connectionId: string): Promise<LockedGatewayConnection> {
  const [row] = await db
    .select({
      id: partnerAiConnections.id,
      kind: partnerAiConnections.kind,
      status: partnerAiConnections.status,
      providerConfig: partnerAiConnections.providerConfig,
      configVersion: partnerAiConnections.configVersion,
      baseUrl: partnerAiConnections.baseUrl,
      keyLast4: partnerAiConnections.keyLast4,
    })
    .from(partnerAiConnections)
    .where(and(eq(partnerAiConnections.id, connectionId), eq(partnerAiConnections.partnerId, partnerId)))
    .for('update');
  if (!row || !isGatewayConnectionKind(row.kind) || row.status === 'disconnected') {
    throw new RegistryWriteError(NOT_FOUND, 'not_found', 404);
  }
  return row;
}

/**
 * Env-managed rows are the bootstrap's (allowManaged). A released one admits
 * exactly one partner write, the disconnect; a managed one admits none.
 */
function assertWritable(row: LockedGatewayConnection, allowManaged: boolean | undefined, write: 'edit' | 'disconnect' = 'edit'): void {
  if (allowManaged) return;
  const state = envManagementState(row.providerConfig);
  if (state === 'managed') throw new RegistryWriteError(MANAGED_BY_ENV, 'managed_by_env', 409);
  if (state === 'released' && write !== 'disconnect') throw new RegistryWriteError(RELEASED_BY_ENV, 'managed_by_env', 409);
}

/** Origin + path, trailing slashes ignored; an unparsable value never equals anything. */
function endpointIdentity(url: string | null): string | null {
  if (url === null) return null;
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

function changesEndpoint(stored: string | null, next: string): boolean {
  const a = endpointIdentity(stored);
  return a === null || a !== endpointIdentity(next);
}

// ── create ──────────────────────────────────────────────────────────────────

export async function createGatewayConnection(input: CreateGatewayConnectionInput): Promise<PartnerAiConnection> {
  const name = input.name.trim();
  if (!name) throw new RegistryWriteError('Enter a name for the connection.', 'invalid', 422, { field: 'name' });
  const baseUrl = await validateOutsideDb(input.baseUrl);
  return inPartnerRegistryWrite(input.partnerId, 'aiModels.createGatewayConnection', 'Could not save the AI connection.', () =>
    createGatewayConnectionRow({
      partnerId: input.partnerId,
      kind: 'openai_compatible',
      name,
      baseUrl,
      apiKey: input.apiKey ?? null,
      providerConfig: input.managedBy ? { managedBy: input.managedBy } : null,
      connectedBy: input.connectedBy,
    }));
}

// ── update endpoint / key ───────────────────────────────────────────────────

export async function updateGatewayConnection(input: UpdateGatewayConnectionInput): Promise<PartnerAiConnection> {
  if (input.baseUrl === undefined && input.apiKey === undefined) {
    throw new RegistryWriteError('Change the URL or the key.', 'invalid', 422);
  }
  const baseUrl = input.baseUrl !== undefined ? await validateOutsideDb(input.baseUrl) : undefined;
  return inPartnerRegistryWrite(input.partnerId, 'aiModels.updateGatewayConnection', 'Could not save the AI connection.', () =>
    updateGatewayConnectionLocked({ ...input, baseUrl }));
}

/**
 * Inside a held registry write only (Task 15 calls it under its own lock).
 * `baseUrl`, when present, must already have passed validateByoBaseUrl.
 */
export async function updateGatewayConnectionLocked(input: UpdateGatewayConnectionInput): Promise<PartnerAiConnection> {
  const row = await lockOwnGatewayConnection(input.partnerId, input.connectionId);
  assertWritable(row, input.allowManaged);
  if (row.configVersion !== input.expectedConfigVersion) throw new RegistryWriteError(STALE, 'stale_write', 409);
  // Under the row lock, so the stored key and URL cannot change underneath.
  if (input.baseUrl !== undefined && input.apiKey === undefined && row.keyLast4 !== null && changesEndpoint(row.baseUrl, input.baseUrl)) {
    throw new RegistryWriteError(KEY_REQUIRED, 'key_required_for_new_endpoint', 422, { field: 'apiKey' });
  }

  const set: Partial<typeof partnerAiConnections.$inferInsert> = {
    configVersion: row.configVersion + 1,
    // Only 'active' or 'error' reach here (disconnected is refused above).
    status: 'active',
    lastError: null,
    updatedAt: new Date(),
  };
  if (input.baseUrl !== undefined) set.baseUrl = input.baseUrl;
  if (input.apiKey !== undefined) Object.assign(set, gatewayKeyColumns(row.id, input.apiKey));

  const [updated] = await db
    .update(partnerAiConnections)
    .set(set)
    .where(and(
      eq(partnerAiConnections.id, row.id),
      eq(partnerAiConnections.partnerId, input.partnerId),
      eq(partnerAiConnections.configVersion, input.expectedConfigVersion),
      ne(partnerAiConnections.status, 'disconnected'),
    ))
    .returning(CONNECTION_PUBLIC_COLUMNS);
  if (!updated) throw new RegistryWriteError(STALE, 'stale_write', 409);
  return updated;
}

// ── delete (soft-disconnect) ────────────────────────────────────────────────

/** Assignments (partner or org level) whose default is any offering on this connection. */
async function connectionDefaultUses(partnerId: string, connectionId: string): Promise<OfferingInUse[]> {
  const offerings = await db
    .select({ id: partnerAiModels.id })
    .from(partnerAiModels)
    .where(and(eq(partnerAiModels.partnerId, partnerId), eq(partnerAiModels.connectionId, connectionId)));
  if (offerings.length === 0) return [];
  const rows = await db
    .select({ surface: aiModelAssignments.surface, orgId: aiModelAssignments.orgId })
    .from(aiModelAssignments)
    .where(and(
      eq(aiModelAssignments.offeringPartnerId, partnerId),
      inArray(aiModelAssignments.defaultOfferingId, offerings.map((o) => o.id)),
    ));
  return rows.map((r) => ({ surface: r.surface as AiSurface, level: r.orgId === null ? 'partner' : 'org', orgId: r.orgId }));
}

export async function deleteGatewayConnection(input: DeleteGatewayConnectionInput): Promise<void> {
  return inPartnerRegistryWrite(input.partnerId, 'aiModels.deleteGatewayConnection', 'Could not remove the connection.', () =>
    deleteGatewayConnectionLocked(input));
}

/** Inside a held registry write only. Assignment writes take the same lock, so the in-use check cannot race one. */
export async function deleteGatewayConnectionLocked(input: DeleteGatewayConnectionInput): Promise<void> {
  const row = await lockOwnGatewayConnection(input.partnerId, input.connectionId);
  assertWritable(row, input.allowManaged, 'disconnect');
  const inUse = await connectionDefaultUses(input.partnerId, row.id);
  if (inUse.length > 0) {
    throw new RegistryWriteError(
      'A model on this connection is still the default for a feature. Choose another default first.',
      'connection_in_use', 409, { surfaces: [...new Set(inUse.map((u) => u.surface))], inUse },
    );
  }
  const now = new Date();
  await db
    .update(partnerAiConnections)
    .set({
      status: 'disconnected',
      lastError: null,
      apiKeyEncrypted: null,
      keyLast4: null,
      keyFingerprint: null,
      configVersion: row.configVersion + 1,
      updatedAt: now,
    })
    .where(and(eq(partnerAiConnections.id, row.id), eq(partnerAiConnections.partnerId, input.partnerId)));
  await db
    .update(partnerAiModels)
    .set({ enabled: false, updatedAt: now })
    .where(and(
      eq(partnerAiModels.partnerId, input.partnerId),
      eq(partnerAiModels.connectionId, row.id),
      eq(partnerAiModels.enabled, true),
    ));
}

// ── manual model entry ──────────────────────────────────────────────────────

export async function createManualOffering(input: CreateManualOfferingInput): Promise<Offering> {
  const modelId = input.modelId.trim();
  if (!BYO_MODEL_ID_PATTERN.test(modelId)) {
    throw new RegistryWriteError('Enter the model id exactly as the endpoint expects it.', 'invalid', 422, { field: 'modelId' });
  }
  const displayName = input.displayName?.trim() || null;
  if (displayName !== null && displayName.length > MAX_DISPLAY_NAME) {
    throw new RegistryWriteError('That name is too long.', 'invalid', 422, { field: 'displayName' });
  }
  return inPartnerRegistryWrite(input.partnerId, 'aiModels.createManualOffering', 'Could not add the model.', () =>
    createManualOfferingLocked({ ...input, modelId, displayName: displayName ?? undefined }));
}

/**
 * Inside a held registry write only (Task 15 adds the env model through it).
 * Lands disabled, unverified (capabilities NULL — never caller-supplied), and
 * unpriced unless prices are given (0 is a valid price for a local model).
 */
export async function createManualOfferingLocked(input: CreateManualOfferingInput): Promise<Offering> {
  const conn = await lockOwnGatewayConnection(input.partnerId, input.connectionId);
  // An env connection's models (and their prices) are the operator's.
  assertWritable(conn, input.allowManaged);
  const duplicate = () => new RegistryWriteError('That model is already listed on this connection.', 'duplicate_model', 409);
  const [existing] = await db
    .select({ id: partnerAiModels.id })
    .from(partnerAiModels)
    .where(and(
      eq(partnerAiModels.partnerId, input.partnerId),
      eq(partnerAiModels.connectionId, conn.id),
      eq(partnerAiModels.modelId, input.modelId),
    ))
    .limit(1);
  if (existing) throw duplicate();
  // Counted under the registry lock: concurrent adds for this partner serialise on it.
  const [counted] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(partnerAiModels)
    .where(and(
      eq(partnerAiModels.partnerId, input.partnerId),
      eq(partnerAiModels.connectionId, conn.id),
      eq(partnerAiModels.source, 'manual'),
    ));
  if (Number(counted?.n ?? 0) >= MAX_MANUAL_OFFERINGS_PER_CONNECTION) {
    throw new RegistryWriteError(
      `This connection already has the maximum of ${MAX_MANUAL_OFFERINGS_PER_CONNECTION} hand-entered models.`,
      'too_many_models', 409, { max: MAX_MANUAL_OFFERINGS_PER_CONNECTION },
    );
  }
  const p = input.prices ?? null;
  const [row] = await db
    .insert(partnerAiModels)
    .values({
      partnerId: input.partnerId,
      connectionId: conn.id,
      platformModelId: null,
      modelId: input.modelId,
      source: 'manual',
      displayName: input.displayName ?? null,
      capabilities: null,
      priceInputCentsPerM: p?.inputCentsPerM ?? null,
      priceOutputCentsPerM: p?.outputCentsPerM ?? null,
      priceCacheReadCentsPerM: p?.cacheReadCentsPerM ?? null,
      priceCacheWriteCentsPerM: p?.cacheWriteCentsPerM ?? null,
      enabled: false,
      lifecycle: 'available',
    })
    // partner_ai_models_connection_model_uq: a racing duplicate returns no row.
    .onConflictDoNothing()
    .returning();
  if (!row) throw duplicate();
  return row;
}
