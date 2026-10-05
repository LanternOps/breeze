/**
 * Registry-native Anthropic API connection remaps (W03 #7601 Task 6B as
 * compatRemap.ts; W08 #7606: id-keyed).
 *
 * Connecting, disconnecting and switching an anthropic_byok / catalog
 * connection are OFFERING-ID REMAPS over rows that already exist — never a
 * re-projection, which would reset options and fallbacks. Every export runs
 * inside the CALLER's held system transaction (anthropicConnectionWrites.ts,
 * which takes the per-partner registry lock first), refuses a partner without
 * its registry rows, and pins the partner id in every statement.
 *
 * Kept from W03:
 * - patch_test runs on the platform key whatever the partner connects (#5557);
 * - stale-offering rule: an offering a remap moves every reference away from is
 *   disabled (enabled = false, never deleted) once nothing references it;
 * - disconnect is SOFT (#7700 review finding 1): the row stays as provenance,
 *   keyless, its offerings disabled — never deleted, because a delete cascades
 *   to offerings an in-flight reserved turn still has to settle on;
 * - a soft-disconnected connection is invisible to every lock here, so no
 *   write ever edits or revives one;
 * - a rotation or a disconnect revokes a key, so the frozen legacy copy of it
 *   goes in the same transaction (#7700 review finding 4).
 * Changed in W08:
 * - every operation names its connection (no singular "compat connection");
 * - no partner "pinned default model" (the per-connection legacy default): per-feature
 *   defaults (W04) replaced the /ai/provider default model it served;
 * - a BYOK <-> catalog switch is in place (same id, key and references);
 * - a model with no platform row falls back to the bootstrap default model,
 *   and a BYOK offering never gets a legacy rate (spec §8: no guessed price).
 */
import { sql, type SQL } from 'drizzle-orm';
import type { AiSurface, AnthropicApiConnectionKind } from '@breeze/shared';
import { db, getCurrentDbAccessContext } from '../../db';
import { hmacFingerprint } from '../secretCrypto';
import { createConnection, encryptConnectionKey } from './connections';
import { ensurePlatformModelRow, resolveBootstrapDefaultModelId } from './registryBootstrap';
import { RegistryWriteError } from './registryWriteErrors';

/** Never moved onto a partner connection (legacy: patch tests always use the platform key, #5557). */
export const PLATFORM_PINNED_SURFACES = ['patch_test'] as const satisfies readonly AiSurface[];

export class RegistryNotCutOverError extends Error {
  constructor(readonly partnerId: string) {
    super('The AI model registry has not been set up for this partner yet.');
    this.name = 'RegistryNotCutOverError';
  }
}

export class AnthropicConnectionMissingError extends Error {
  constructor() {
    super('The AI connection no longer exists.');
    this.name = 'AnthropicConnectionMissingError';
  }
}

export interface LockedAnthropicConnection {
  id: string;
  kind: AnthropicApiConnectionKind;
  catalogEntryId: string | null;
  configVersion: number;
  connectedBy: string | null;
  verifiedAt: Date | null;
}

type Target = { connectionId: null } | { connectionId: string; kind: AnthropicApiConnectionKind };

function assertSystemContext(): void {
  if (getCurrentDbAccessContext()?.scope !== 'system') {
    throw new Error('connectionRemap requires a held system DB context');
  }
}

async function rows<T>(query: SQL): Promise<T[]> {
  return [...(await db.execute(query))] as T[];
}

const list = (values: readonly string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);

/** The gate, on the caller's transaction: a native write needs the partner's registry (cutover) row. */
export async function assertPartnerCutOverInTx(partnerId: string): Promise<void> {
  const found = await rows(sql`SELECT 1 AS ok FROM ai_model_registry_partner_cutover WHERE partner_id = ${partnerId}::uuid`);
  if (found.length === 0) throw new RegistryNotCutOverError(partnerId);
}

/**
 * Every offering id that routes something for the partner: assignment
 * defaults / permitted / fallback arrays (optionally minus some surfaces),
 * agent bindings, live session bindings, and refusal fallbacks.
 */
function refsCte(partnerId: string, skipSurfaces: readonly string[] = []): SQL {
  const skip = skipSurfaces.length ? sql` AND surface NOT IN (${list(skipSurfaces)})` : sql``;
  return sql`WITH assignment_rows AS (
      SELECT default_offering_id, permitted_offering_ids, fallback_offering_ids
        FROM ai_model_assignments WHERE offering_partner_id = ${partnerId}::uuid${skip}
    ), refs AS (
      SELECT default_offering_id AS id FROM assignment_rows
      UNION SELECT unnest(permitted_offering_ids) FROM assignment_rows
      UNION SELECT unnest(fallback_offering_ids) FROM assignment_rows
      UNION SELECT offering_id FROM ai_agents WHERE offering_partner_id = ${partnerId}::uuid
      UNION SELECT offering_id FROM ai_sessions WHERE offering_partner_id = ${partnerId}::uuid AND status = 'active'
      UNION SELECT refusal_fallback_offering_id FROM partner_ai_models WHERE partner_id = ${partnerId}::uuid
    ) `;
}

/**
 * `array_replace(column, from, to)` with any duplicate it creates collapsed,
 * first occurrence kept (W08a review): a list already holding `to` next to
 * `from` would otherwise trip ai_model_assignments_offering_ownership_guard's
 * "contains a duplicate" (23514). A NULL list stays NULL; nothing else in the
 * list moves.
 */
const replaceDedup = (column: SQL, from: string, to: string) => sql`CASE WHEN ${column} IS NULL THEN NULL ELSE ARRAY(
    SELECT x FROM unnest(array_replace(${column}, ${from}::uuid, ${to}::uuid)) WITH ORDINALITY AS t(x, n)
     GROUP BY x ORDER BY min(n)) END`;

export async function remapPartnerOfferings(
  partnerId: string,
  mapping: ReadonlyMap<string, string>,
  opts: { skipSurfaces?: readonly string[] } = {},
): Promise<{ assignments: number; agents: number; sessions: number; offerings: number }> {
  assertSystemContext();
  const skip = opts.skipSurfaces?.length ? sql` AND surface NOT IN (${list(opts.skipSurfaces)})` : sql``;
  let assignments = 0, agents = 0, sessions = 0, offerings = 0;
  for (const [from, to] of mapping) {
    // W09 (#7607): the fallback list is preserved verbatim (the W03 authority
    // contract), even when the remap lands the default on an offering already
    // in it: ai_model_assignments_fallback_shape_chk caps the list but allows
    // that inert self-entry (the resolver's walk skips the primary). Only an
    // exact duplicate id WITHIN one list collapses (replaceDedup).
    assignments += (await rows(sql`UPDATE ai_model_assignments SET
        default_offering_id = CASE WHEN default_offering_id = ${from}::uuid THEN ${to}::uuid ELSE default_offering_id END,
        permitted_offering_ids = ${replaceDedup(sql`permitted_offering_ids`, from, to)},
        fallback_offering_ids = ${replaceDedup(sql`fallback_offering_ids`, from, to)},
        updated_at = now()
      WHERE offering_partner_id = ${partnerId}::uuid${skip}
        AND (default_offering_id = ${from}::uuid OR ${from}::uuid = ANY(permitted_offering_ids) OR ${from}::uuid = ANY(fallback_offering_ids))
      RETURNING id`)).length;
    agents += (await rows(sql`UPDATE ai_agents SET offering_id = ${to}::uuid
      WHERE offering_partner_id = ${partnerId}::uuid AND offering_id = ${from}::uuid RETURNING id`)).length;
    sessions += (await rows(sql`UPDATE ai_sessions SET offering_id = ${to}::uuid
      WHERE offering_partner_id = ${partnerId}::uuid AND offering_id = ${from}::uuid AND status = 'active' RETURNING id`)).length;
    // A refusal fallback must sit on its offering's connection
    // (partner_ai_models_integrity_guard, 23514). Only rows on the TARGET's
    // connection move; a row left on the other connection keeps its
    // same-connection fallback, which stays valid (W08a review).
    offerings += (await rows(sql`UPDATE partner_ai_models SET refusal_fallback_offering_id = ${to}::uuid, updated_at = now()
      WHERE partner_id = ${partnerId}::uuid AND refusal_fallback_offering_id = ${from}::uuid
        AND connection_id IS NOT DISTINCT FROM (SELECT t.connection_id FROM partner_ai_models t
                                                 WHERE t.id = ${to}::uuid AND t.partner_id = ${partnerId}::uuid)
      RETURNING id`)).length;
  }
  return { assignments, agents, sessions, offerings };
}

async function loadTarget(partnerId: string, connectionId: string | null): Promise<Target> {
  if (connectionId === null) return { connectionId: null };
  const [conn] = await rows<{ kind: AnthropicApiConnectionKind }>(sql`SELECT kind FROM partner_ai_connections
    WHERE id = ${connectionId}::uuid AND partner_id = ${partnerId}::uuid`);
  if (!conn) throw new Error('connectionRemap: target connection not found for partner');
  return { connectionId, kind: conn.kind };
}

/** The platform row for `modelId`; a model with none falls back to the bootstrap default (a tenant id never creates a global row). */
async function platformRowFor(modelId: string): Promise<string> {
  const [row] = await rows<{ id: string }>(sql`SELECT id FROM ai_platform_models WHERE model_id = ${modelId}`);
  if (row) return row.id;
  const fallback = await ensurePlatformModelRow(await resolveBootstrapDefaultModelId());
  if (!fallback) {
    throw new RegistryWriteError(
      'No platform AI model is available to move these features to. Ask an operator to price the platform default model on Admin → AI models, then try again.',
      'conflict', 409,
    );
  }
  return fallback.id;
}

/** Find-or-create the offering for `modelId` on `target`. A BYOK model with no platform row is created disabled: it has no resolvable price (spec §8). */
async function ensureOffering(partnerId: string, target: Target, modelId: string): Promise<string> {
  if (target.connectionId === null) {
    const platformModelId = await platformRowFor(modelId);
    const [row] = await rows<{ id: string }>(sql`INSERT INTO partner_ai_models (partner_id, platform_model_id, source, enabled)
      VALUES (${partnerId}::uuid, ${platformModelId}::uuid, 'platform', true)
      ON CONFLICT (partner_id, platform_model_id) WHERE connection_id IS NULL DO UPDATE SET enabled = true, updated_at = now()
      RETURNING id`);
    return row!.id;
  }
  let source: 'discovered' | 'manual' | 'catalog' = 'catalog';
  let platformModelId: string | null = null;
  let enabled = true;
  if (target.kind === 'anthropic_byok') {
    const [platform] = await rows<{ id: string }>(sql`SELECT id FROM ai_platform_models WHERE model_id = ${modelId}`);
    source = platform ? 'discovered' : 'manual';
    platformModelId = platform?.id ?? null;
    enabled = Boolean(platform);
  }
  const [row] = await rows<{ id: string }>(sql`INSERT INTO partner_ai_models
      (partner_id, connection_id, model_id, source, platform_model_id, enabled)
    VALUES (${partnerId}::uuid, ${target.connectionId}::uuid, ${modelId}, ${source}, ${platformModelId}::uuid, ${enabled})
    ON CONFLICT (connection_id, model_id) WHERE connection_id IS NOT NULL
      DO UPDATE SET enabled = partner_ai_models.enabled OR EXCLUDED.enabled, updated_at = now()
    RETURNING id`);
  return row!.id;
}

/**
 * For every offering on `from` that something routes to (minus
 * `skipSurfaces` assignment rows), find or create the same logical model's
 * offering on `to`, enabled. Returns the from → to id map.
 */
export async function ensureSameModelOfferings(
  partnerId: string,
  from: { connectionId: string | null },
  to: { connectionId: string | null },
  opts: { skipSurfaces?: readonly string[] } = {},
): Promise<Map<string, string>> {
  assertSystemContext();
  const onFrom = from.connectionId === null ? sql`m.connection_id IS NULL` : sql`m.connection_id = ${from.connectionId}::uuid`;
  const referenced = await rows<{ id: string; model_id: string }>(sql`${refsCte(partnerId, opts.skipSurfaces)}
    SELECT m.id, COALESCE(m.model_id, pm.model_id) AS model_id
      FROM partner_ai_models m LEFT JOIN ai_platform_models pm ON pm.id = m.platform_model_id
     WHERE m.partner_id = ${partnerId}::uuid AND ${onFrom} AND m.id IN (SELECT id FROM refs WHERE id IS NOT NULL)
     ORDER BY m.id`);
  const target = await loadTarget(partnerId, to.connectionId);
  const mapping = new Map<string, string>();
  for (const offering of referenced) {
    const toId = await ensureOffering(partnerId, target, offering.model_id);
    if (toId !== offering.id) mapping.set(offering.id, toId);
  }
  return mapping;
}

/** enabled = false on the candidates nothing routes to any more. Never deletes. */
export async function disableUnreferencedOfferings(partnerId: string, candidateIds: readonly string[]): Promise<number> {
  assertSystemContext();
  if (candidateIds.length === 0) return 0;
  return (await rows(sql`${refsCte(partnerId)}
    UPDATE partner_ai_models SET enabled = false, updated_at = now()
     WHERE partner_id = ${partnerId}::uuid AND enabled AND id IN (${list(candidateIds)})
       AND id NOT IN (SELECT id FROM refs WHERE id IS NOT NULL)
    RETURNING id`)).length;
}

const LOCKED_COLUMNS = sql`id, kind, catalog_entry_id, config_version, connected_by, verified_at`;
type LockedRow = {
  id: string; kind: AnthropicApiConnectionKind; catalog_entry_id: string | null; config_version: number;
  connected_by: string | null; verified_at: Date | string | null;
};
const toLocked = (r: LockedRow): LockedAnthropicConnection => ({
  id: r.id, kind: r.kind, catalogEntryId: r.catalog_entry_id, configVersion: Number(r.config_version),
  connectedBy: r.connected_by, verifiedAt: r.verified_at === null ? null : new Date(r.verified_at),
});

/**
 * One live Anthropic API connection of this partner, row-locked for the
 * transaction; null when it is gone, belongs elsewhere, or is soft-disconnected
 * (provenance only: no write may edit or revive it).
 */
export async function lockAnthropicConnection(partnerId: string, connectionId: string): Promise<LockedAnthropicConnection | null> {
  assertSystemContext();
  const [row] = await rows<LockedRow>(sql`SELECT ${LOCKED_COLUMNS} FROM partner_ai_connections
    WHERE id = ${connectionId}::uuid AND partner_id = ${partnerId}::uuid AND kind IN ('anthropic_byok', 'catalog')
      AND status <> 'disconnected'
    FOR UPDATE`);
  return row ? toLocked(row) : null;
}

/** Every live Anthropic API connection id of the partner, row-locked (the create cap and "first connection" check). */
export async function lockAnthropicConnectionIds(partnerId: string): Promise<string[]> {
  assertSystemContext();
  return (await rows<{ id: string }>(sql`SELECT id FROM partner_ai_connections
    WHERE partner_id = ${partnerId}::uuid AND kind IN ('anthropic_byok', 'catalog') AND status <> 'disconnected'
    ORDER BY created_at FOR UPDATE`)).map((r) => r.id);
}

async function connectionName(kind: AnthropicApiConnectionKind, catalogEntryId: string | null): Promise<string> {
  if (kind === 'anthropic_byok' || !catalogEntryId) return 'Anthropic API key';
  const [entry] = await rows<{ name: string }>(sql`SELECT name FROM llm_provider_catalog WHERE id = ${catalogEntryId}::uuid`);
  return entry?.name ?? 'Catalog endpoint';
}

/**
 * #7700 review finding 4: the legacy partner_llm_configs row is frozen at the
 * partner's cutover, but it still holds that partner's key ciphertext. A
 * rotation or a disconnect revokes the key, so the row goes in the same
 * transaction: a revoked key must not persist anywhere. Rollback-safe across
 * W08b, which drops the table: the delete runs only while the table exists.
 * W08b removes this helper together with the table.
 */
async function purgeRetiredLegacyKeyCopy(partnerId: string): Promise<void> {
  const [table] = await rows<{ present: boolean }>(sql`SELECT to_regclass('public.partner_llm_configs') IS NOT NULL AS present`);
  if (!table?.present) return;
  await db.execute(sql`DELETE FROM partner_llm_configs WHERE partner_id = ${partnerId}::uuid`);
}

export interface ConnectAnthropicInput {
  kind: AnthropicApiConnectionKind;
  apiKey: string;
  catalogEntryId: string | null;
  connectedBy: string | null;
  verifiedAt?: Date | null;
  /** True for the partner's first Anthropic API connection: its platform traffic moves onto the key (W03 semantics). */
  movePlatformReferences: boolean;
}

/**
 * Create the connection; for the partner's first one, move every platform
 * reference (except platform-pinned surfaces) onto the same model on it and
 * disable the platform offerings left routing nothing. Options,
 * allow_user_choice and rows are untouched; nothing is deleted.
 */
export async function connectAnthropicConnection(partnerId: string, input: ConnectAnthropicInput): Promise<string> {
  assertSystemContext();
  await assertPartnerCutOverInTx(partnerId);
  const conn = await createConnection({
    partnerId,
    kind: input.kind,
    name: await connectionName(input.kind, input.catalogEntryId),
    apiKey: input.apiKey,
    catalogEntryId: input.catalogEntryId,
    connectedBy: input.connectedBy,
    verifiedAt: input.verifiedAt ?? new Date(),
  });
  if (input.movePlatformReferences) {
    const skipSurfaces = PLATFORM_PINNED_SURFACES;
    const mapping = await ensureSameModelOfferings(partnerId, { connectionId: null }, { connectionId: conn.id }, { skipSurfaces });
    await remapPartnerOfferings(partnerId, mapping, { skipSurfaces });
    await disableUnreferencedOfferings(partnerId, [...mapping.keys()]);
  }
  return conn.id;
}

/**
 * Disconnect ONE connection: every reference to its offerings goes back to the
 * same model's platform offering (created/enabled if missing); references on
 * any other connection are untouched. The connection is then SOFT-disconnected
 * (#7700 review finding 1): status 'disconnected', key material NULLed
 * (revocation removes the secret), config_version bumped, its offerings
 * disabled. Never deleted — a delete cascades to the offerings, and a turn
 * already reserved and dispatched on one could then never settle
 * (ai_invocations' provenance guard needs the offering). False when the id is
 * not a live Anthropic connection of this partner.
 */
export async function disconnectAnthropicConnection(partnerId: string, connectionId: string): Promise<boolean> {
  assertSystemContext();
  await assertPartnerCutOverInTx(partnerId);
  const conn = await lockAnthropicConnection(partnerId, connectionId);
  if (!conn) return false;
  const mapping = await ensureSameModelOfferings(partnerId, { connectionId: conn.id }, { connectionId: null });
  await remapPartnerOfferings(partnerId, mapping);
  await db.execute(sql`UPDATE partner_ai_connections SET
      status = 'disconnected', last_error = NULL,
      api_key_encrypted = NULL, key_last4 = NULL, key_fingerprint = NULL,
      config_version = config_version + 1, updated_at = now()
    WHERE id = ${conn.id}::uuid AND partner_id = ${partnerId}::uuid`);
  await db.execute(sql`UPDATE partner_ai_models SET enabled = false, updated_at = now()
    WHERE partner_id = ${partnerId}::uuid AND connection_id = ${conn.id}::uuid AND enabled`);
  await purgeRetiredLegacyKeyCopy(partnerId);
  return true;
}

/** Same-kind key rotation: the connection is updated in place, no remap; the revoked key's legacy copy is purged. */
export async function rotateAnthropicConnectionKey(
  partnerId: string,
  connectionId: string,
  input: { apiKey: string; connectedBy: string | null; verifiedAt: Date },
): Promise<{ configVersion: number }> {
  assertSystemContext();
  await assertPartnerCutOverInTx(partnerId);
  const conn = await lockAnthropicConnection(partnerId, connectionId);
  if (!conn) throw new AnthropicConnectionMissingError();
  const apiKey = input.apiKey.trim();
  const [updated] = await rows<{ config_version: number }>(sql`UPDATE partner_ai_connections SET
      api_key_encrypted = ${encryptConnectionKey(conn.id, apiKey)},
      key_last4 = ${apiKey.slice(-4)},
      key_fingerprint = ${hmacFingerprint(apiKey)},
      status = 'active', last_error = NULL,
      verified_at = ${input.verifiedAt.toISOString()}::timestamptz,
      connected_by = ${input.connectedBy}::uuid,
      config_version = config_version + 1, updated_at = now()
    WHERE id = ${conn.id}::uuid AND partner_id = ${partnerId}::uuid RETURNING config_version`);
  await purgeRetiredLegacyKeyCopy(partnerId);
  return { configVersion: Number(updated!.config_version) };
}

/** Same-kind catalog change (a different entry, or the same one re-selected), in place. */
export async function setAnthropicConnectionCatalogEntry(
  partnerId: string,
  connectionId: string,
  input: { catalogEntryId: string },
): Promise<{ configVersion: number }> {
  assertSystemContext();
  await assertPartnerCutOverInTx(partnerId);
  const conn = await lockAnthropicConnection(partnerId, connectionId);
  if (!conn || conn.kind !== 'catalog') throw new AnthropicConnectionMissingError();
  const [updated] = await rows<{ config_version: number }>(sql`UPDATE partner_ai_connections SET
      catalog_entry_id = ${input.catalogEntryId}::uuid, status = 'active', last_error = NULL,
      config_version = config_version + 1, updated_at = now()
    WHERE id = ${conn.id}::uuid AND partner_id = ${partnerId}::uuid RETURNING config_version`);
  return { configVersion: Number(updated!.config_version) };
}

/** A no-op edit that still advances config_version (clearing the endpoint of an already-direct connection). */
export async function bumpConnectionConfigVersion(partnerId: string, connectionId: string): Promise<{ configVersion: number }> {
  assertSystemContext();
  await assertPartnerCutOverInTx(partnerId);
  const conn = await lockAnthropicConnection(partnerId, connectionId);
  if (!conn) throw new AnthropicConnectionMissingError();
  const [updated] = await rows<{ config_version: number }>(sql`UPDATE partner_ai_connections
    SET config_version = config_version + 1, updated_at = now()
    WHERE id = ${conn.id}::uuid AND partner_id = ${partnerId}::uuid RETURNING config_version`);
  return { configVersion: Number(updated!.config_version) };
}

/**
 * BYOK ↔ catalog with the same key, IN PLACE (W08; W03 disconnected and
 * reconnected under a new id). The connection keeps its id, key ciphertext
 * (the AAD is bound to the row id) and every reference to its offerings, so
 * nothing routed anywhere else moves — correct with one connection or several,
 * and in every release combination (no second row ever coexists, so
 * partner_ai_connections_compat_uq never matters). The offerings on it are
 * converted to the new kind's shape (partner_ai_models_catalog_shape_chk:
 * catalog rows carry no platform link, capabilities or price); discovery
 * state is reset because the other kind's sync history does not apply.
 * config_version + 1 invalidates any live SDK query bound to the old shape
 * (spec §9.2). The caller queues discovery after commit.
 */
export async function switchAnthropicConnectionKind(
  partnerId: string,
  connectionId: string,
  input: { kind: AnthropicApiConnectionKind; catalogEntryId: string | null },
): Promise<{ connectionId: string; configVersion: number }> {
  assertSystemContext();
  await assertPartnerCutOverInTx(partnerId);
  const previous = await lockAnthropicConnection(partnerId, connectionId);
  if (!previous) throw new AnthropicConnectionMissingError();
  if (previous.kind === input.kind) throw new AnthropicConnectionMissingError();
  if (input.kind === 'catalog') {
    if (!input.catalogEntryId) throw new Error('switchAnthropicConnectionKind: a catalog connection needs a catalog entry');
    await db.execute(sql`UPDATE partner_ai_models SET
        source = 'catalog', platform_model_id = NULL, capabilities = NULL,
        price_input_cents_per_m = NULL, price_output_cents_per_m = NULL,
        price_cache_read_cents_per_m = NULL, price_cache_write_cents_per_m = NULL,
        missed_sync_count = 0, updated_at = now()
      WHERE partner_id = ${partnerId}::uuid AND connection_id = ${previous.id}::uuid`);
  } else {
    // Back to direct Anthropic: link each model to its platform row (price and
    // capabilities inherit from it, spec §8); a model with no platform row has
    // no resolvable price, so it is disabled until the admin prices it.
    await db.execute(sql`UPDATE partner_ai_models m SET
        source = CASE WHEN pm.id IS NULL THEN 'manual' ELSE 'discovered' END,
        platform_model_id = pm.id,
        enabled = m.enabled AND pm.id IS NOT NULL,
        missed_sync_count = 0, updated_at = now()
      FROM partner_ai_models m2 LEFT JOIN ai_platform_models pm ON pm.model_id = m2.model_id
      WHERE m.id = m2.id AND m.partner_id = ${partnerId}::uuid AND m.connection_id = ${previous.id}::uuid`);
  }
  const [updated] = await rows<{ config_version: number }>(sql`UPDATE partner_ai_connections SET
      kind = ${input.kind},
      catalog_entry_id = ${input.kind === 'catalog' ? input.catalogEntryId : null}::uuid,
      name = ${await connectionName(input.kind, input.catalogEntryId)},
      status = 'active', last_error = NULL, discovery_error = NULL, last_discovered_at = NULL,
      config_version = config_version + 1, updated_at = now()
    WHERE id = ${previous.id}::uuid AND partner_id = ${partnerId}::uuid RETURNING config_version`);
  return { connectionId: previous.id, configVersion: Number(updated!.config_version) };
}

/**
 * The ONE model a connection's endpoint is validated and probed against (the
 * catalog-rotation probe and an endpoint change; R0 used the connection's own
 * pinned model). In order: (a) the partner-level `chat` default's model when
 * that offering is on this connection; (b) an enabled offering on it that
 * something routes to — an assignment default first, then oldest; (c) any
 * enabled offering on it, oldest; (d) partnerChatDefaultModelId. Never the
 * model of a chat default on another connection or the platform: a catalog
 * entry that does not map it would refuse the rotation of a leaked key.
 */
export async function connectionPrimaryModelId(partnerId: string, connectionId: string): Promise<string> {
  assertSystemContext();
  const [chat] = await rows<{ model_id: string | null }>(sql`SELECT COALESCE(m.model_id, pm.model_id) AS model_id
      FROM ai_model_assignments a
      JOIN partner_ai_models m ON m.id = a.default_offering_id AND m.partner_id = ${partnerId}::uuid
                              AND m.connection_id = ${connectionId}::uuid
      LEFT JOIN ai_platform_models pm ON pm.id = m.platform_model_id
     WHERE a.partner_id = ${partnerId}::uuid AND a.org_id IS NULL AND a.surface = 'chat' AND a.role = 'default'`);
  if (chat?.model_id) return chat.model_id;
  const [own] = await rows<{ model_id: string | null }>(sql`${refsCte(partnerId)}
    SELECT COALESCE(m.model_id, pm.model_id) AS model_id
      FROM partner_ai_models m LEFT JOIN ai_platform_models pm ON pm.id = m.platform_model_id
     WHERE m.partner_id = ${partnerId}::uuid AND m.connection_id = ${connectionId}::uuid AND m.enabled
       AND COALESCE(m.model_id, pm.model_id) IS NOT NULL
     ORDER BY (m.id IN (SELECT id FROM refs WHERE id IS NOT NULL)) DESC,
              (m.id IN (SELECT default_offering_id FROM assignment_rows WHERE default_offering_id IS NOT NULL)) DESC,
              m.created_at, m.id
     LIMIT 1`);
  if (own?.model_id) return own.model_id;
  return partnerChatDefaultModelId(partnerId);
}

/** The model of the partner-level `chat` default offering, else the bootstrap default (connectionPrimaryModelId's last resort). */
export async function partnerChatDefaultModelId(partnerId: string): Promise<string> {
  const [row] = await rows<{ model_id: string | null }>(sql`SELECT COALESCE(m.model_id, pm.model_id) AS model_id
      FROM ai_model_assignments a
      JOIN partner_ai_models m ON m.id = a.default_offering_id AND m.partner_id = ${partnerId}::uuid
      LEFT JOIN ai_platform_models pm ON pm.id = m.platform_model_id
     WHERE a.partner_id = ${partnerId}::uuid AND a.org_id IS NULL AND a.surface = 'chat' AND a.role = 'default'`);
  return row?.model_id ?? resolveBootstrapDefaultModelId();
}
