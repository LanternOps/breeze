/**
 * Registry-native /ai/provider writes (#7601 Task 6B; W02 handoff item 2 as
 * revised by R3 / review finding 9).
 *
 * After a partner's one-time cutover (registryCutover.ts) the registry is the
 * authority. The legacy semantics of connect / disconnect / rotate / change
 * default model are expressed here as OFFERING-ID REMAPS over the rows that
 * already exist — never as a re-projection, which would reset assignment
 * options and fallbacks, delete rows the projection does not produce and
 * rebind sessions from legacy model strings (reverting registry-native edits).
 *
 * Every export runs inside the CALLER's held system transaction (the facade,
 * services/partnerLlmConfig.ts, which also takes the per-partner registry lock
 * first) and refuses to write for a partner that has not been cut over. Every
 * statement pins the partner id.
 *
 * Legacy invariants kept:
 * - patch_test runs on the platform key whatever the partner configures
 *   (#5557): connecting never moves it onto a connection.
 * - Only the surfaces whose legacy model IS the partner default follow a
 *   default-model change; script_reviewer and extension_content have their own
 *   defaults, and org rows are deliberate overrides.
 *
 * Stale-offering rule (as in the 6A cutover): an offering a remap moves every
 * reference away from is disabled (enabled = false, never deleted) once
 * nothing references it, so an `all` permitted set never exposes a model on a
 * funding path legacy would not have used.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { AiSurface } from '@breeze/shared';
import { db, getCurrentDbAccessContext } from '../../db';
import { getLegacyModelRates } from './legacySurfaceModels';
import { resolveDefaultModel } from '../aiModel';
import { hmacFingerprint } from '../secretCrypto';
import { createConnection, encryptConnectionKey } from './connections';
import { ensureLegacyPlatformModel } from './legacyReconcile';

/** Never moved onto a partner connection (legacy: patch tests always use the platform key, #5557). */
export const PLATFORM_PINNED_SURFACES = ['patch_test'] as const satisfies readonly AiSurface[];

/** Surfaces whose legacy model is the partner default (legacyProjection.ts `P`). */
export const DEFAULT_FOLLOWING_SURFACES = [
  'chat', 'helper', 'script_builder', 'office_chat', 'office_ticket', 'ai_agents', 'catalog_enrichment',
] as const satisfies readonly AiSurface[];

export class RegistryNotCutOverError extends Error {
  constructor(readonly partnerId: string) {
    super('The AI model registry has not been cut over for this partner yet.');
    this.name = 'RegistryNotCutOverError';
  }
}

export class CompatConnectionMissingError extends Error {
  constructor() {
    super('The partner has no AI provider connection.');
    this.name = 'CompatConnectionMissingError';
  }
}

export interface LockedCompatConnection {
  id: string;
  kind: 'anthropic_byok' | 'catalog';
  catalogEntryId: string | null;
  legacyDefaultModel: string | null;
  configVersion: number;
  connectedBy: string | null;
  verifiedAt: Date | null;
}

type Target = { connectionId: null } | { connectionId: string; kind: 'anthropic_byok' | 'catalog' };

function assertSystemContext(): void {
  if (getCurrentDbAccessContext()?.scope !== 'system') {
    throw new Error('compatRemap requires a held system DB context');
  }
}

async function rows<T>(query: SQL): Promise<T[]> {
  return [...(await db.execute(query))] as T[];
}

const list = (values: readonly string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);

/** The gate, on the caller's transaction: a native write needs the partner's cutover row. */
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
    // that inert self-entry (the resolver's walk skips the primary).
    assignments += (await rows(sql`UPDATE ai_model_assignments SET
        default_offering_id = CASE WHEN default_offering_id = ${from}::uuid THEN ${to}::uuid ELSE default_offering_id END,
        permitted_offering_ids = array_replace(permitted_offering_ids, ${from}::uuid, ${to}::uuid),
        fallback_offering_ids = array_replace(fallback_offering_ids, ${from}::uuid, ${to}::uuid),
        updated_at = now()
      WHERE offering_partner_id = ${partnerId}::uuid${skip}
        AND (default_offering_id = ${from}::uuid OR ${from}::uuid = ANY(permitted_offering_ids) OR ${from}::uuid = ANY(fallback_offering_ids))
      RETURNING id`)).length;
    agents += (await rows(sql`UPDATE ai_agents SET offering_id = ${to}::uuid
      WHERE offering_partner_id = ${partnerId}::uuid AND offering_id = ${from}::uuid RETURNING id`)).length;
    sessions += (await rows(sql`UPDATE ai_sessions SET offering_id = ${to}::uuid
      WHERE offering_partner_id = ${partnerId}::uuid AND offering_id = ${from}::uuid AND status = 'active' RETURNING id`)).length;
    offerings += (await rows(sql`UPDATE partner_ai_models SET refusal_fallback_offering_id = ${to}::uuid, updated_at = now()
      WHERE partner_id = ${partnerId}::uuid AND refusal_fallback_offering_id = ${from}::uuid RETURNING id`)).length;
  }
  return { assignments, agents, sessions, offerings };
}

async function loadTarget(partnerId: string, connectionId: string | null): Promise<Target> {
  if (connectionId === null) return { connectionId: null };
  const [conn] = await rows<{ kind: 'anthropic_byok' | 'catalog' }>(sql`SELECT kind FROM partner_ai_connections
    WHERE id = ${connectionId}::uuid AND partner_id = ${partnerId}::uuid`);
  if (!conn) throw new Error('compatRemap: target connection not found for partner');
  return { connectionId, kind: conn.kind };
}

/** Find-or-create the ENABLED offering for `modelId` on `target`, mirroring the W02 projection's shapes. */
async function ensureOffering(partnerId: string, target: Target, modelId: string): Promise<string> {
  if (target.connectionId === null) {
    let [platform] = await rows<{ id: string }>(sql`SELECT id FROM ai_platform_models WHERE model_id = ${modelId}`);
    if (!platform) {
      const deploymentDefault = resolveDefaultModel();
      // A tenant-typed id never creates a global platform row (W02 bootstrap
      // provenance): fall back to the deployment default, which may.
      if (modelId !== deploymentDefault) return ensureOffering(partnerId, target, deploymentDefault);
      platform = { id: await ensureLegacyPlatformModel(modelId, getLegacyModelRates(modelId).rates) };
    }
    const [row] = await rows<{ id: string }>(sql`INSERT INTO partner_ai_models (partner_id, platform_model_id, source, enabled)
      VALUES (${partnerId}::uuid, ${platform.id}::uuid, 'platform', true)
      ON CONFLICT (partner_id, platform_model_id) WHERE connection_id IS NULL DO UPDATE SET enabled = true, updated_at = now()
      RETURNING id`);
    return row!.id;
  }

  let source: 'discovered' | 'manual' | 'catalog' = 'catalog';
  let platformModelId: string | null = null;
  let price: { input: number; output: number; read: number; write: number } | null = null;
  if (target.kind === 'anthropic_byok') {
    const [platform] = await rows<{
      id: string; input_cents_per_m: unknown; output_cents_per_m: unknown; cache_read_cents_per_m: unknown; cache_write_cents_per_m: unknown;
    }>(sql`SELECT id, input_cents_per_m, output_cents_per_m, cache_read_cents_per_m, cache_write_cents_per_m
      FROM ai_platform_models WHERE model_id = ${modelId}`);
    source = platform ? 'discovered' : 'manual';
    platformModelId = platform?.id ?? null;
    const priced = platform && [platform.input_cents_per_m, platform.output_cents_per_m, platform.cache_read_cents_per_m, platform.cache_write_cents_per_m]
      .every((v) => v !== null && v !== undefined);
    if (!priced) {
      const r = getLegacyModelRates(modelId).rates;
      price = { input: r.inputCentsPerM, output: r.outputCentsPerM, read: r.cacheReadCentsPerM, write: r.cacheWriteCentsPerM };
    }
  }
  const [row] = await rows<{ id: string }>(sql`INSERT INTO partner_ai_models
      (partner_id, connection_id, model_id, source, platform_model_id, enabled,
       price_input_cents_per_m, price_output_cents_per_m, price_cache_read_cents_per_m, price_cache_write_cents_per_m)
    VALUES (${partnerId}::uuid, ${target.connectionId}::uuid, ${modelId}, ${source}, ${platformModelId}::uuid, true,
       ${price?.input ?? null}, ${price?.output ?? null}, ${price?.read ?? null}, ${price?.write ?? null})
    ON CONFLICT (connection_id, model_id) WHERE connection_id IS NOT NULL DO UPDATE SET enabled = true, updated_at = now()
    RETURNING id`);
  return row!.id;
}

async function findOffering(partnerId: string, target: Target, modelId: string): Promise<string | null> {
  const [row] = target.connectionId === null
    ? await rows<{ id: string }>(sql`SELECT m.id FROM partner_ai_models m JOIN ai_platform_models pm ON pm.id = m.platform_model_id
        WHERE m.partner_id = ${partnerId}::uuid AND m.connection_id IS NULL AND pm.model_id = ${modelId}`)
    : await rows<{ id: string }>(sql`SELECT id FROM partner_ai_models
        WHERE partner_id = ${partnerId}::uuid AND connection_id = ${target.connectionId}::uuid AND model_id = ${modelId}`);
  return row?.id ?? null;
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

/**
 * Legacy "change the partner default": partner-level `default` rows of the
 * default-following surfaces still on the old default's offering move to the
 * new model's offering on the same target (created if missing).
 */
async function repointPartnerDefault(partnerId: string, target: Target, oldModel: string, newModel: string): Promise<void> {
  if (oldModel === newModel) return;
  const previous = await findOffering(partnerId, target, oldModel);
  if (!previous) return;
  const next = await ensureOffering(partnerId, target, newModel);
  // W09: the fallback list is left as is (see remapPartnerOfferings).
  await db.execute(sql`UPDATE ai_model_assignments SET default_offering_id = ${next}::uuid, updated_at = now()
    WHERE partner_id = ${partnerId}::uuid AND org_id IS NULL AND role = 'default'
      AND surface IN (${list(DEFAULT_FOLLOWING_SURFACES)}) AND default_offering_id = ${previous}::uuid`);
  await disableUnreferencedOfferings(partnerId, [previous]);
}

/** The partner's live compat (anthropic_byok | catalog) connection — never a disconnected one — row-locked for this transaction. */
export async function lockCompatConnection(partnerId: string): Promise<LockedCompatConnection | null> {
  assertSystemContext();
  const [row] = await rows<{
    id: string; kind: 'anthropic_byok' | 'catalog'; catalog_entry_id: string | null; legacy_default_model: string | null;
    config_version: number; connected_by: string | null; verified_at: Date | string | null;
  }>(sql`SELECT id, kind, catalog_entry_id, legacy_default_model, config_version, connected_by, verified_at
      FROM partner_ai_connections WHERE partner_id = ${partnerId}::uuid AND kind IN ('anthropic_byok', 'catalog')
        AND status <> 'disconnected'
      FOR UPDATE`);
  if (!row) return null;
  return {
    id: row.id, kind: row.kind, catalogEntryId: row.catalog_entry_id, legacyDefaultModel: row.legacy_default_model,
    configVersion: Number(row.config_version), connectedBy: row.connected_by,
    verifiedAt: row.verified_at === null ? null : new Date(row.verified_at),
  };
}

async function connectionName(kind: 'anthropic_byok' | 'catalog', catalogEntryId: string | null): Promise<string> {
  if (kind === 'anthropic_byok' || !catalogEntryId) return 'Anthropic API key';
  const [entry] = await rows<{ name: string }>(sql`SELECT name FROM llm_provider_catalog WHERE id = ${catalogEntryId}::uuid`);
  return entry?.name ?? 'Catalog endpoint';
}

export interface ConnectCompatInput {
  kind: 'anthropic_byok' | 'catalog';
  apiKey: string;
  catalogEntryId: string | null;
  connectedBy: string | null;
  defaultModel: string | null;
  verifiedAt?: Date | null;
}

/**
 * First compat connection: create it, move every platform reference (except
 * platform-pinned surfaces) onto the same model on the connection, apply a
 * pinned default, and disable the platform offerings left routing nothing.
 * Options, allow_user_choice and rows are untouched; nothing is deleted.
 */
export async function connectCompat(partnerId: string, input: ConnectCompatInput): Promise<string> {
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
  const skipSurfaces = PLATFORM_PINNED_SURFACES;
  const mapping = await ensureSameModelOfferings(partnerId, { connectionId: null }, { connectionId: conn.id }, { skipSurfaces });
  await remapPartnerOfferings(partnerId, mapping, { skipSurfaces });
  if (input.defaultModel !== null) {
    await db.execute(sql`UPDATE partner_ai_connections SET legacy_default_model = ${input.defaultModel}, updated_at = now()
      WHERE id = ${conn.id}::uuid AND partner_id = ${partnerId}::uuid`);
    // A new connection starts on the deployment default (legacy: P = row default ?? env default).
    await repointPartnerDefault(partnerId, { connectionId: conn.id, kind: input.kind }, resolveDefaultModel(), input.defaultModel);
  }
  await disableUnreferencedOfferings(partnerId, [...mapping.keys()]);
  return conn.id;
}

/**
 * #7700 review finding 4: the legacy partner_llm_configs row is frozen at the
 * cutover and read only to project a partner NOT yet cut over
 * (legacyReconcile, via cutoverPartner), so for a cut-over partner it is dead
 * weight — except that it still holds the key ciphertext. A disconnect or a
 * rotation revokes that key, so the row goes in the same transaction: the
 * revoked key must not persist anywhere.
 */
async function dropLegacyPartnerConfig(partnerId: string): Promise<void> {
  await db.execute(sql`DELETE FROM partner_llm_configs WHERE partner_id = ${partnerId}::uuid`);
}

/**
 * Disconnect the compat connection: every reference to its offerings goes back
 * to the same model's platform offering (created/enabled if missing), a pinned
 * default goes back to tracking the deployment default (legacy: no row = env
 * default), then the connection is SOFT-disconnected (#7700 review finding 1):
 * status 'disconnected', key material NULLed (revocation removes the secret),
 * config_version bumped, its offerings disabled. Never deleted — a delete
 * cascades to the offerings, and a turn already reserved and dispatched on one
 * could then never settle (ai_invocations' provenance guard needs the
 * offering).
 */
export async function disconnectCompat(partnerId: string): Promise<boolean> {
  assertSystemContext();
  await assertPartnerCutOverInTx(partnerId);
  const conn = await lockCompatConnection(partnerId);
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
  await dropLegacyPartnerConfig(partnerId);
  if (conn.legacyDefaultModel !== null) {
    await repointPartnerDefault(partnerId, { connectionId: null }, conn.legacyDefaultModel, resolveDefaultModel());
  }
  return true;
}

/** Same-kind key rotation: the connection is updated in place, no remap; the old key's legacy copy is dropped. */
export async function rotateCompatKey(
  partnerId: string,
  input: { apiKey: string; connectedBy: string | null; verifiedAt: Date },
): Promise<{ configVersion: number; defaultModel: string | null }> {
  assertSystemContext();
  await assertPartnerCutOverInTx(partnerId);
  const conn = await lockCompatConnection(partnerId);
  if (!conn) throw new CompatConnectionMissingError();
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
  await dropLegacyPartnerConfig(partnerId);
  return { configVersion: Number(updated!.config_version), defaultModel: conn.legacyDefaultModel };
}

/**
 * Same-kind catalog change (a different entry, or the same one re-selected):
 * in place, pinning the model just validated against the entry (#7587). The
 * pin equals the effective default it replaces, so nothing is re-pointed.
 */
export async function setCompatCatalogEntry(
  partnerId: string,
  input: { catalogEntryId: string; pinnedModel: string },
): Promise<{ configVersion: number }> {
  assertSystemContext();
  await assertPartnerCutOverInTx(partnerId);
  const conn = await lockCompatConnection(partnerId);
  if (!conn || conn.kind !== 'catalog') throw new CompatConnectionMissingError();
  const [updated] = await rows<{ config_version: number }>(sql`UPDATE partner_ai_connections SET
      catalog_entry_id = ${input.catalogEntryId}::uuid, legacy_default_model = ${input.pinnedModel},
      status = 'active', last_error = NULL,
      config_version = config_version + 1, updated_at = now()
    WHERE id = ${conn.id}::uuid AND partner_id = ${partnerId}::uuid RETURNING config_version`);
  return { configVersion: Number(updated!.config_version) };
}

/** A no-op edit that still advances config_version (legacy: reverting an already-direct partner to direct). */
export async function bumpCompatConfigVersion(partnerId: string): Promise<{ configVersion: number }> {
  assertSystemContext();
  await assertPartnerCutOverInTx(partnerId);
  const conn = await lockCompatConnection(partnerId);
  if (!conn) throw new CompatConnectionMissingError();
  const [updated] = await rows<{ config_version: number }>(sql`UPDATE partner_ai_connections
    SET config_version = config_version + 1, updated_at = now()
    WHERE id = ${conn.id}::uuid AND partner_id = ${partnerId}::uuid RETURNING config_version`);
  return { configVersion: Number(updated!.config_version) };
}

/**
 * BYOK ↔ catalog: disconnect, then connect with the same key, keeping who
 * connected it and when it was verified. config_version continues from the
 * old connection's so it never moves backwards for a reader.
 */
export async function switchCompatKind(
  partnerId: string,
  input: { kind: 'anthropic_byok' | 'catalog'; apiKey: string; catalogEntryId: string | null; defaultModel: string | null },
): Promise<{ connectionId: string; configVersion: number }> {
  assertSystemContext();
  await assertPartnerCutOverInTx(partnerId);
  const previous = await lockCompatConnection(partnerId);
  if (!previous) throw new CompatConnectionMissingError();
  await disconnectCompat(partnerId);
  const connectionId = await connectCompat(partnerId, {
    kind: input.kind,
    apiKey: input.apiKey,
    catalogEntryId: input.catalogEntryId,
    connectedBy: previous.connectedBy,
    defaultModel: input.defaultModel,
    verifiedAt: previous.verifiedAt,
  });
  const configVersion = previous.configVersion + 1;
  await db.execute(sql`UPDATE partner_ai_connections SET config_version = ${configVersion}
    WHERE id = ${connectionId}::uuid AND partner_id = ${partnerId}::uuid`);
  return { connectionId, configVersion };
}
