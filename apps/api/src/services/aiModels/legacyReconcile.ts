/**
 * W02 sync point: make the registry the projection of the legacy config for
 * one partner (spec §10). Idempotent; serialized per partner by a
 * transaction-scoped advisory lock, so concurrent boots and /ai/provider writes
 * converge. Runs only in a held SYSTEM context: it reads and writes every org
 * of the partner, and must never see a tenant slice. Every statement pins the
 * partner id or the partner's org ids explicitly.
 *
 * W03 (Task 6A) calls reconcilePartnerFromLegacyInTx ONCE per partner, in the
 * same transaction as a durable per-partner cutover row (gated in resolveModel,
 * plus a leased post-serve() sweep — services/aiModels/registryCutover.ts),
 * no longer runs reconcileAllPartnersFromLegacy at boot, and never re-projects
 * a cut-over partner.
 */
import { and, asc, eq, inArray, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { ModelRates } from '@breeze/shared';
import { AI_SCRIPT_REVIEWER_MODEL } from '../../config/env';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  aiAgents,
  aiBudgets,
  aiModelAssignments,
  aiPlatformModels,
  aiScriptPolicies,
  aiSessions,
  clientAiOrgPolicies,
  llmProviderCatalog,
  organizations,
  partnerAiConnections,
  partnerAiModels,
  partnerLlmConfigs,
  partners,
} from '../../db/schema';
// The leaf module, not aiAgentSdk.ts: that one drags the chat route graph into
// every importer (worker entrypoint closure, partnerLlmConfig cycle).
import { SESSION_IDLE_TIMEOUT_MS, SESSION_MAX_AGE_MS } from '../aiAgentSessionLimits';
import { resolveDefaultModel } from '../aiModel';
import {
  buildDesiredRegistryState,
  type DesiredRegistryState,
  type LegacyProjectionEnv,
  type LegacySnapshot,
  type OfferingKey,
} from './legacyProjection';
import { getLegacyModelRates, legacyExtensionModel } from './legacySurfaceModels';
import { lockPartnerRegistry, partnerRegistryLockKey } from './registryWriteLock';
import { safeErrorMessage } from './safeDbError';

// W08 (#7606): the per-partner registry lock lives in registryWriteLock.ts. The
// old names stay exported for this file's remaining importers until Task 7
// deletes the file.
export { partnerRegistryLockKey as partnerRegistryReconcileLockKey, lockPartnerRegistry as lockPartnerRegistryReconcile };

export interface ReconcileReport {
  partnerId: string;
  connection: 'created' | 'updated' | 'unchanged' | 'removed' | 'none';
  offeringsUpserted: number;
  assignmentsUpserted: number;
  assignmentsDeleted: number;
  agentsRebound: number;
  sessionsRebound: number;
  bootstrapPlatformModels: string[];
  /** Tenant-typed ids with no platform row, dropped instead of bootstrapped (legacyProjection onPlatform). */
  unknownPlatformModelsSkipped: number;
  /**
   * Every offering id the FINAL projection pass upserted (sorted, unique) —
   * exactly the partner's projected offering set. The W03 cutover disables
   * every other enabled offering of the partner (registryCutover.ts).
   */
  producedOfferingIds: string[];
}

export function readLegacyProjectionEnv(): LegacyProjectionEnv {
  return {
    defaultModel: resolveDefaultModel(),
    reviewerModel: AI_SCRIPT_REVIEWER_MODEL,
    extensionModel: legacyExtensionModel(undefined),
    legacyRates: (model) => getLegacyModelRates(model).rates,
  };
}

function assertSystemContext(): void {
  if (getCurrentDbAccessContext()?.scope !== 'system') {
    throw new Error('legacyReconcile requires a held system DB context');
  }
}

const priced = (row: { input: unknown; output: unknown; read: unknown; write: unknown }) =>
  [row.input, row.output, row.read, row.write].every((v) => v !== null && v !== undefined);

/** Every query is ORDER BY a stable key, so the projection (and its key order) is deterministic. */
export async function loadLegacySnapshot(partnerId: string): Promise<LegacySnapshot> {
  assertSystemContext();
  const orgRows = await db.select({ id: organizations.id }).from(organizations)
    .where(eq(organizations.partnerId, partnerId)).orderBy(asc(organizations.id));
  const orgIds = orgRows.map((o) => o.id);
  const inOrgs = (column: AnyPgColumn) => (orgIds.length ? inArray(column, orgIds) : sql`false`);

  // FOR SHARE: connections must be exact at all times. A legacy writer that
  // does not take the reconcile lock (markPartnerLlmError's runtime error
  // stamp) waits for this transaction instead of committing between this read
  // and the mirror write, where the mirror would put the stale status back.
  // It never deadlocks against the reconcile: that writer holds no lock the
  // reconcile wants until its own UPDATE on this row is granted.
  const [config] = await db
    .select({ id: partnerLlmConfigs.id, status: partnerLlmConfigs.status, defaultModel: partnerLlmConfigs.defaultModel, catalogEntryId: partnerLlmConfigs.catalogEntryId })
    .from(partnerLlmConfigs).where(eq(partnerLlmConfigs.partnerId, partnerId)).orderBy(asc(partnerLlmConfigs.id)).limit(1)
    .for('share');

  const platformRows = await db
    .select({ id: aiPlatformModels.id, modelId: aiPlatformModels.modelId, input: aiPlatformModels.inputCentsPerM, output: aiPlatformModels.outputCentsPerM, read: aiPlatformModels.cacheReadCentsPerM, write: aiPlatformModels.cacheWriteCentsPerM })
    .from(aiPlatformModels).orderBy(asc(aiPlatformModels.modelId));

  const scriptRows = await db
    .select({ orgId: aiScriptPolicies.orgId, partnerId: aiScriptPolicies.partnerId, reviewerModel: aiScriptPolicies.reviewerModel })
    .from(aiScriptPolicies)
    .where(or(and(isNull(aiScriptPolicies.orgId), eq(aiScriptPolicies.partnerId, partnerId)), inOrgs(aiScriptPolicies.orgId)))
    .orderBy(asc(aiScriptPolicies.id));

  const officeRows = await db
    .select({ orgId: clientAiOrgPolicies.orgId, allowedModels: clientAiOrgPolicies.allowedModels })
    .from(clientAiOrgPolicies).where(inOrgs(clientAiOrgPolicies.orgId)).orderBy(asc(clientAiOrgPolicies.orgId));

  const agentRows = await db
    .select({ id: aiAgents.id, kind: aiAgents.kind, orgId: aiAgents.orgId, model: aiAgents.model })
    .from(aiAgents)
    .where(and(isNull(aiAgents.disabledAt), or(and(isNull(aiAgents.orgId), eq(aiAgents.partnerId, partnerId)), inOrgs(aiAgents.orgId))))
    .orderBy(asc(aiAgents.id));

  const budgetRows = await db
    .select({ orgId: aiBudgets.orgId, allowedModels: aiBudgets.allowedModels })
    .from(aiBudgets).where(inOrgs(aiBudgets.orgId)).orderBy(asc(aiBudgets.orgId));

  // Cutoffs on the DB clock (the same clock that stamped the rows).
  const sessionRows = await db
    .select({ id: aiSessions.id, orgId: aiSessions.orgId, model: aiSessions.model })
    .from(aiSessions)
    .where(and(
      inOrgs(aiSessions.orgId),
      eq(aiSessions.status, 'active'),
      sql`${aiSessions.createdAt} > now() - make_interval(secs => ${SESSION_MAX_AGE_MS / 1000})`,
      sql`${aiSessions.lastActivityAt} > now() - make_interval(secs => ${SESSION_IDLE_TIMEOUT_MS / 1000})`,
    ))
    .orderBy(asc(aiSessions.id));

  return {
    partnerId,
    orgIds,
    config: config ? { id: config.id, status: config.status, defaultModel: config.defaultModel, catalogEntryId: config.catalogEntryId } : null,
    platformModels: platformRows.map((r) => ({ id: r.id, modelId: r.modelId, priced: priced(r) })),
    partnerReviewerModel: scriptRows.find((r) => r.orgId === null)?.reviewerModel ?? null,
    orgReviewerModels: Object.fromEntries(scriptRows.filter((r) => r.orgId !== null).map((r) => [r.orgId!, r.reviewerModel])),
    officeAllowedModels: Object.fromEntries(officeRows.map((r) => [
      r.orgId,
      Array.isArray(r.allowedModels) ? (r.allowedModels as unknown[]).filter((m): m is string => typeof m === 'string') : [],
    ])),
    agents: agentRows.map((a) => ({ id: a.id, kind: a.kind, orgId: a.orgId, model: a.model })),
    budgetAllowedModels: Object.fromEntries(budgetRows.map((r) => [r.orgId, r.allowedModels])),
    liveSessions: sessionRows.map((s) => ({ id: s.id, orgId: s.orgId, model: s.model })),
  };
}

/**
 * Bootstrap the platform row for a DEPLOYMENT-sourced id (the env default /
 * reviewer / extension model) that has none. Legacy served that id on the
 * platform key and billed it at `rates` (getLegacyModelRates: its listed rate,
 * else the default-rate fallback), so the row is created OFFERED at exactly
 * those rates (#7601 gap A: otherwise a self-hosted gateway model loses AI at
 * cutover). Capabilities stay null; the candidate loader resolves unknown
 * capabilities on the platform key as legacy ran the id. An existing row is
 * never touched (ON CONFLICT DO NOTHING): seeded and operator-edited rows win.
 */
export async function ensureLegacyPlatformModel(modelId: string, rates: ModelRates): Promise<string> {
  assertSystemContext();
  await db.execute(sql`
    INSERT INTO ai_platform_models (provider, model_id, display_name, platform_offered, is_platform_default, lifecycle,
                                    input_cents_per_m, output_cents_per_m, cache_read_cents_per_m, cache_write_cents_per_m)
    VALUES ('anthropic', ${modelId}, ${modelId}, true, false, 'available',
            ${rates.inputCentsPerM}, ${rates.outputCentsPerM}, ${rates.cacheReadCentsPerM}, ${rates.cacheWriteCentsPerM})
    ON CONFLICT (model_id) DO NOTHING`);
  const [row] = await db.select({ id: aiPlatformModels.id }).from(aiPlatformModels).where(eq(aiPlatformModels.modelId, modelId)).limit(1);
  if (!row) throw new Error(`could not bootstrap ai_platform_models row for ${modelId}`);
  return row.id;
}

async function mirrorConnection(snapshot: LegacySnapshot): Promise<ReconcileReport['connection']> {
  if (!snapshot.config) return 'none';
  // FOR SHARE (see loadLegacySnapshot): already held by this transaction; re-stated so the mirror never reads an unlocked row.
  const [legacy] = await db.select().from(partnerLlmConfigs)
    .where(and(eq(partnerLlmConfigs.id, snapshot.config.id), eq(partnerLlmConfigs.partnerId, snapshot.partnerId))).limit(1)
    .for('share');
  if (!legacy) return 'none';
  const kind = legacy.catalogEntryId ? 'catalog' as const : 'anthropic_byok' as const;
  const mirrored = {
    kind,
    apiKeyEncrypted: legacy.apiKeyEncrypted,   // byte copy: same id + legacy AAD tag
    keyLast4: legacy.keyLast4,
    keyFingerprint: legacy.keyFingerprint,
    catalogEntryId: legacy.catalogEntryId,
    status: legacy.status,
    lastError: legacy.lastError,
    verifiedAt: legacy.verifiedAt,
    configVersion: legacy.configVersion,
    connectedBy: legacy.connectedBy,
    legacyDefaultModel: legacy.defaultModel,
  };
  const [existing] = await db.select().from(partnerAiConnections)
    .where(and(eq(partnerAiConnections.id, legacy.id), eq(partnerAiConnections.partnerId, snapshot.partnerId))).limit(1);
  if (!existing) {
    let name = 'Anthropic API key';
    if (legacy.catalogEntryId) {
      const [entry] = await db.select({ name: llmProviderCatalog.name }).from(llmProviderCatalog).where(eq(llmProviderCatalog.id, legacy.catalogEntryId)).limit(1);
      name = entry?.name ?? 'Catalog endpoint';
    }
    // Any previous compat connection was an orphan and has already been removed
    // by reconcilePartnerFromLegacyInTx, so partner_ai_connections_compat_uq is free.
    await db.insert(partnerAiConnections).values({ id: legacy.id, partnerId: legacy.partnerId, name, ...mirrored, createdAt: legacy.createdAt, updatedAt: legacy.updatedAt });
    return 'created';
  }
  const changed = (Object.keys(mirrored) as Array<keyof typeof mirrored>).some((k) => {
    const a = existing[k]; const b = mirrored[k];
    return a instanceof Date || b instanceof Date ? (a as Date | null)?.getTime() !== (b as Date | null)?.getTime() : a !== b;
  });
  if (!changed) return 'unchanged';
  await db.update(partnerAiConnections).set({ ...mirrored, updatedAt: new Date() })
    .where(and(eq(partnerAiConnections.id, legacy.id), eq(partnerAiConnections.partnerId, snapshot.partnerId)));
  return 'updated';
}

async function upsertOfferings(desired: DesiredRegistryState, partnerId: string, report: ReconcileReport): Promise<Map<OfferingKey, string>> {
  const ids = new Map<OfferingKey, string>();
  for (const o of desired.offerings) {
    if (o.connectionId === null) {
      let platformModelId = o.platformModelId;
      if (!platformModelId) {
        // Only deployment-sourced ids reach here (projection invariant): a
        // tenant-typed id must never create a global catalog row.
        if (!o.needsBootstrapPlatformRow || !o.price) throw new Error(`legacyReconcile: platform offering ${o.key} has no platform row and is not bootstrappable`);
        platformModelId = await ensureLegacyPlatformModel(o.modelId, o.price);
        report.bootstrapPlatformModels.push(o.modelId);
      }
      const [row] = await db.insert(partnerAiModels)
        .values({ partnerId, platformModelId, source: 'platform', enabled: true })
        .onConflictDoUpdate({
          target: [partnerAiModels.partnerId, partnerAiModels.platformModelId],
          targetWhere: sql`connection_id IS NULL`,
          set: { enabled: true, updatedAt: new Date() },
        })
        .returning({ id: partnerAiModels.id });
      ids.set(o.key, row!.id);
    } else {
      const price = o.price
        ? { priceInputCentsPerM: o.price.inputCentsPerM, priceOutputCentsPerM: o.price.outputCentsPerM, priceCacheReadCentsPerM: o.price.cacheReadCentsPerM, priceCacheWriteCentsPerM: o.price.cacheWriteCentsPerM }
        : { priceInputCentsPerM: null, priceOutputCentsPerM: null, priceCacheReadCentsPerM: null, priceCacheWriteCentsPerM: null };
      const [row] = await db.insert(partnerAiModels)
        .values({ partnerId, connectionId: o.connectionId, modelId: o.modelId, source: o.source, platformModelId: o.platformModelId, enabled: true, ...price })
        .onConflictDoUpdate({
          target: [partnerAiModels.connectionId, partnerAiModels.modelId],
          targetWhere: sql`connection_id IS NOT NULL`,
          set: { source: o.source, platformModelId: o.platformModelId, enabled: true, ...price, updatedAt: new Date() },
        })
        .returning({ id: partnerAiModels.id });
      ids.set(o.key, row!.id);
    }
    report.offeringsUpserted += 1;
  }
  return ids;
}

function offeringId(ids: ReadonlyMap<OfferingKey, string>, key: OfferingKey): string {
  const id = ids.get(key);
  if (!id) throw new Error(`legacyReconcile: offering ${key} was not upserted`);
  return id;
}

async function applyAssignments(desired: DesiredRegistryState, partnerId: string, orgIds: readonly string[], ids: ReadonlyMap<OfferingKey, string>, report: ReconcileReport): Promise<void> {
  const keep = new Set<string>();
  for (const a of desired.assignments) {
    const values = {
      offeringPartnerId: partnerId,
      surface: a.surface,
      role: a.role,
      defaultOfferingId: a.defaultOfferingKey === null ? null : offeringId(ids, a.defaultOfferingKey),
      permittedOfferingIds: a.permittedOfferingKeys ? a.permittedOfferingKeys.map((k) => offeringId(ids, k)) : null,
      allowUserChoice: a.allowUserChoice,
      fallbackMayCrossFunding: a.fallbackMayCrossFunding,
      options: null,
      fallbackOfferingIds: null,
      updatedAt: new Date(),
    };
    const [row] = a.orgId === null
      ? await db.insert(aiModelAssignments).values({ ...values, partnerId, orgId: null })
          .onConflictDoUpdate({ target: [aiModelAssignments.partnerId, aiModelAssignments.surface, aiModelAssignments.role], targetWhere: sql`org_id IS NULL`, set: values })
          .returning({ id: aiModelAssignments.id })
      : await db.insert(aiModelAssignments).values({ ...values, orgId: a.orgId, partnerId: null })
          .onConflictDoUpdate({ target: [aiModelAssignments.orgId, aiModelAssignments.surface, aiModelAssignments.role], targetWhere: sql`org_id IS NOT NULL`, set: values })
          .returning({ id: aiModelAssignments.id });
    keep.add(row!.id);
    report.assignmentsUpserted += 1;
  }
  const owned = or(
    and(isNull(aiModelAssignments.orgId), eq(aiModelAssignments.partnerId, partnerId)),
    orgIds.length ? inArray(aiModelAssignments.orgId, [...orgIds]) : sql`false`,
  );
  const deleted = await db.delete(aiModelAssignments)
    .where(keep.size ? and(owned, notInArray(aiModelAssignments.id, [...keep])) : owned)
    .returning({ id: aiModelAssignments.id });
  report.assignmentsDeleted += deleted.length;
}

/**
 * Rebind statements pin the partner (agents: partner rows of this partner or
 * rows of its orgs; sessions: rows of its orgs). A row that moved to another
 * partner after the snapshot is skipped instead of tripping the composite
 * (org_id, offering_partner_id) FK and aborting the whole reconcile.
 */
async function rebind(desired: DesiredRegistryState, partnerId: string, orgIds: readonly string[], ids: ReadonlyMap<OfferingKey, string>, report: ReconcileReport): Promise<void> {
  const agentOwned = or(
    and(isNull(aiAgents.orgId), eq(aiAgents.partnerId, partnerId)),
    orgIds.length ? inArray(aiAgents.orgId, [...orgIds]) : sql`false`,
  );
  const sessionOwned = orgIds.length ? inArray(aiSessions.orgId, [...orgIds]) : sql`false`;
  for (const [agentId, key] of Object.entries(desired.agentOfferingKeys)) {
    const bound = key === null ? null : offeringId(ids, key);
    const updated = await db.update(aiAgents)
      .set({ offeringId: bound, offeringPartnerId: bound ? partnerId : null })
      .where(and(eq(aiAgents.id, agentId), agentOwned, sql`${aiAgents.offeringId} IS DISTINCT FROM ${bound}::uuid`))
      .returning({ id: aiAgents.id });
    report.agentsRebound += updated.length;
  }
  for (const [sessionId, key] of Object.entries(desired.sessionOfferingKeys)) {
    const bound = key === null ? null : offeringId(ids, key);
    const updated = await db.update(aiSessions)
      .set({ offeringId: bound, offeringPartnerId: bound ? partnerId : null })
      .where(and(eq(aiSessions.id, sessionId), sessionOwned, sql`${aiSessions.offeringId} IS DISTINCT FROM ${bound}::uuid`))
      .returning({ id: aiSessions.id });
    report.sessionsRebound += updated.length;
  }
}

/**
 * Remove compat connections whose id has no legacy row. Their offerings
 * cascade; bound sessions/agents SET NULL. Callers must have re-pointed every
 * assignment first (default_offering_id has no ON DELETE, and
 * permitted_offering_ids is an unchecked array).
 */
async function deleteOrphanConnections(partnerId: string, orphanIds: readonly string[]): Promise<void> {
  // partner_ai_models_refusal_fallback_fk has no ON DELETE: drop every
  // reference INTO the doomed offerings before the cascade removes them.
  await db.update(partnerAiModels)
    .set({ refusalFallbackOfferingId: null, updatedAt: new Date() })
    .where(and(
      eq(partnerAiModels.partnerId, partnerId),
      inArray(partnerAiModels.refusalFallbackOfferingId,
        db.select({ id: partnerAiModels.id }).from(partnerAiModels)
          .where(and(eq(partnerAiModels.partnerId, partnerId), inArray(partnerAiModels.connectionId, [...orphanIds])))),
    ));
  await db.delete(partnerAiConnections)
    .where(and(eq(partnerAiConnections.partnerId, partnerId), inArray(partnerAiConnections.id, [...orphanIds])));
}

/**
 * Throws on any failure and never returns a partial report. It never opens,
 * commits or rolls back a transaction: a failure aborts the CALLER's
 * transaction (W03 inserts its cutover row in that same transaction).
 */
export async function reconcilePartnerFromLegacyInTx(partnerId: string, env: LegacyProjectionEnv = readLegacyProjectionEnv()): Promise<ReconcileReport> {
  assertSystemContext();
  await lockPartnerRegistry(partnerId);
  const report: ReconcileReport = { partnerId, connection: 'none', offeringsUpserted: 0, assignmentsUpserted: 0, assignmentsDeleted: 0, agentsRebound: 0, sessionsRebound: 0, bootstrapPlatformModels: [], unknownPlatformModelsSkipped: 0, producedOfferingIds: [] };

  const snapshot = await loadLegacySnapshot(partnerId);
  // A compat connection whose id has no legacy row is an orphan (the legacy
  // config was deleted or replaced). It must leave BEFORE a replacement is
  // inserted (compat unique index) and AFTER nothing references its
  // offerings — so: re-point first using a projection without it, then delete.
  const orphans = await db.select({ id: partnerAiConnections.id }).from(partnerAiConnections)
    .where(and(
      eq(partnerAiConnections.partnerId, partnerId),
      inArray(partnerAiConnections.kind, ['anthropic_byok', 'catalog']),
      // Never a soft-disconnected row (#7700 finding 1): deleting it would
      // cascade away offerings the ledger may still reference.
      ne(partnerAiConnections.status, 'disconnected'),
      snapshot.config ? ne(partnerAiConnections.id, snapshot.config.id) : sql`true`,
    ))
    .orderBy(asc(partnerAiConnections.id));

  const desired = buildDesiredRegistryState(snapshot, env);
  report.unknownPlatformModelsSkipped = desired.skippedUnknownPlatformModels.length;
  if (orphans.length > 0) {
    // Interim pass: every assignment onto platform offerings (no connection),
    // so no assignment references an orphan offering when it cascades away.
    // Its counts are discarded; the real pass below reports.
    const scratch: ReconcileReport = { ...report, bootstrapPlatformModels: [] };
    const platformOnly = buildDesiredRegistryState({ ...snapshot, config: null }, env);
    const interimIds = await upsertOfferings(platformOnly, partnerId, scratch);
    await applyAssignments(platformOnly, partnerId, snapshot.orgIds, interimIds, scratch);
    await deleteOrphanConnections(partnerId, orphans.map((o) => o.id));
    report.connection = 'removed';
  }
  if (snapshot.config) report.connection = await mirrorConnection(snapshot);

  const ids = await upsertOfferings(desired, partnerId, report);
  report.producedOfferingIds = [...new Set(ids.values())].sort();
  await applyAssignments(desired, partnerId, snapshot.orgIds, ids, report);
  await rebind(desired, partnerId, snapshot.orgIds, ids, report);
  return report;
}

export function reconcilePartnerFromLegacy(partnerId: string, env?: LegacyProjectionEnv): Promise<ReconcileReport> {
  return runOutsideDbContext(() =>
    withSystemDbAccessContext(() => reconcilePartnerFromLegacyInTx(partnerId, env), 'aiModelRegistry.reconcilePartner'));
}

/** The W02 boot sweep: one fresh transaction per partner; a failure is recorded and the sweep moves on. */
export async function reconcileAllPartnersFromLegacy(opts: { env?: LegacyProjectionEnv } = {}): Promise<{ partners: number; failures: Array<{ partnerId: string; error: string }> }> {
  const env = opts.env ?? readLegacyProjectionEnv();
  const partnerIds = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() => db.select({ id: partners.id }).from(partners).orderBy(asc(partners.id)), 'aiModelRegistry.reconcileAll.list'));
  const failures: Array<{ partnerId: string; error: string }> = [];
  for (const { id } of partnerIds) {
    try {
      await reconcilePartnerFromLegacy(id, env);
    } catch (error) {
      // A Drizzle query error's own message embeds the SQL params (here: key
      // ciphertext, fingerprints): the shared scrubber keeps only safe fields.
      failures.push({ partnerId: id, error: safeErrorMessage(error) });
    }
  }
  return { partners: partnerIds.length, failures };
}
