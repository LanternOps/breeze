// apps/api/src/services/aiModels/platformModels.ts
/**
 * AI model registry W01 (#7599): the platform model catalog
 * (`ai_platform_models`). Task 7 adds the type and the row mapper; Task 9 adds
 * the database functions to this file.
 */
import {
  emptyOptionSupport,
  optionRatesSchema,
  optionSupportSchema,
  type ModelLifecycle,
  type ModelRates,
  type OptionRates,
  type OptionSupport,
  type PromptProfile,
} from '@breeze/shared';
import { and, asc, eq, ne } from 'drizzle-orm';
import { db, runAfterDbContextExit, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiPlatformModels, type AiPlatformModelRow } from '../../db/schema';
import { derivePromptProfile } from '../aiModel';
import { deriveCapabilities, deriveOptionSupport, mergeDiscoveredOptionSupport } from './capabilities';
import { PlatformModelError, validatePlatformModelAdminPatch, type PlatformModelAdminPatch } from './platformModelAdmin';
import { setPlatformModelSnapshot } from './platformModelSnapshot';

export { PlatformModelError } from './platformModelAdmin';

export interface PlatformModel {
  id: string;
  provider: 'anthropic';
  modelId: string;
  displayName: string;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  /** Raw Models API capabilities tree (or the seed's stand-in until the first sync sees the model). */
  capabilities: unknown;
  /** All four standard rates, or null when any is unset (unpriced). */
  rates: ModelRates | null;
  optionRates: OptionRates | null;
  optionSupport: OptionSupport;
  minPlan: string | null;
  promptProfile: PromptProfile;
  platformOffered: boolean;
  isPlatformDefault: boolean;
  lifecycle: ModelLifecycle;
  missedSyncCount: number;
  operatorNotifiedAt: Date | null;
  firstSeenAt: Date;
  /** Null until a discovery sync has seen the model (seeded rows start null). */
  lastSeenAt: Date | null;
  updatedAt: Date;
}

function toNumber(value: number | string | null): number | null {
  if (value === null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function toPlatformModel(row: AiPlatformModelRow): PlatformModel {
  const input = toNumber(row.inputCentsPerM);
  const output = toNumber(row.outputCentsPerM);
  const cacheRead = toNumber(row.cacheReadCentsPerM);
  const cacheWrite = toNumber(row.cacheWriteCentsPerM);
  const rates = input !== null && output !== null && cacheRead !== null && cacheWrite !== null
    ? { inputCentsPerM: input, outputCentsPerM: output, cacheReadCentsPerM: cacheRead, cacheWriteCentsPerM: cacheWrite }
    : null;

  const support = optionSupportSchema.safeParse(row.optionSupport);
  if (!support.success) {
    console.warn(`[aiModels] ai_platform_models.option_support for "${row.modelId}" is malformed; treating it as empty`);
  }
  let optionRates: OptionRates | null = null;
  if (row.optionRates !== null) {
    const parsed = optionRatesSchema.safeParse(row.optionRates);
    if (parsed.success) optionRates = parsed.data;
    else console.warn(`[aiModels] ai_platform_models.option_rates for "${row.modelId}" is malformed; ignoring it`);
  }

  return {
    id: row.id,
    provider: 'anthropic',
    modelId: row.modelId,
    displayName: row.displayName,
    maxInputTokens: row.maxInputTokens,
    maxOutputTokens: row.maxOutputTokens,
    capabilities: row.capabilities ?? null,
    rates,
    optionRates,
    optionSupport: support.success ? support.data : emptyOptionSupport(),
    minPlan: row.minPlan,
    promptProfile: row.promptProfile,
    platformOffered: row.platformOffered,
    isPlatformDefault: row.isPlatformDefault,
    lifecycle: row.lifecycle,
    missedSyncCount: row.missedSyncCount,
    operatorNotifiedAt: row.operatorNotifiedAt,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Reads. withSystemDbAccessContext JOINS an ambient request context (no
// second pooled connection) and opens a system one otherwise. The table has
// no RLS, so either scope reads it.
// ---------------------------------------------------------------------------

export async function listPlatformModels(): Promise<PlatformModel[]> {
  return withSystemDbAccessContext(async () => {
    const rows = await db.select().from(aiPlatformModels).orderBy(asc(aiPlatformModels.displayName));
    return rows.map(toPlatformModel);
  }, 'aiModels.list');
}

export async function getPlatformModelById(id: string): Promise<PlatformModel | null> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(aiPlatformModels).where(eq(aiPlatformModels.id, id)).limit(1);
    return row ? toPlatformModel(row) : null;
  }, 'aiModels.getById');
}

export async function getPlatformModelByModelId(modelId: string): Promise<PlatformModel | null> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(aiPlatformModels).where(eq(aiPlatformModels.modelId, modelId)).limit(1);
    return row ? toPlatformModel(row) : null;
  }, 'aiModels.getByModelId');
}

export async function getPlatformDefaultModel(): Promise<PlatformModel | null> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(aiPlatformModels).where(eq(aiPlatformModels.isPlatformDefault, true)).limit(1);
    return row ? toPlatformModel(row) : null;
  }, 'aiModels.getDefault');
}

/** Replaces OFFERABLE_AI_MODELS: offered on the platform key and currently served (spec §8). */
export async function listOfferableModelIds(): Promise<string[]> {
  return withSystemDbAccessContext(async () => {
    const rows = await db
      .select({ modelId: aiPlatformModels.modelId })
      .from(aiPlatformModels)
      .where(and(eq(aiPlatformModels.platformOffered, true), eq(aiPlatformModels.lifecycle, 'available')))
      .orderBy(asc(aiPlatformModels.modelId));
    return rows.map((row) => row.modelId);
  }, 'aiModels.listOfferable');
}

export async function isOfferablePlatformModel(modelId: string): Promise<boolean> {
  return withSystemDbAccessContext(async () => {
    const rows = await db
      .select({ id: aiPlatformModels.id })
      .from(aiPlatformModels)
      .where(and(
        eq(aiPlatformModels.modelId, modelId),
        eq(aiPlatformModels.platformOffered, true),
        eq(aiPlatformModels.lifecycle, 'available'),
      ))
      .limit(1);
    return rows.length > 0;
  }, 'aiModels.isOfferable');
}

/** Logical ids a catalog revision's model_map may key (spec §6): any registry model that is not retired. */
export async function listCatalogMappableModelIds(): Promise<string[]> {
  return withSystemDbAccessContext(async () => {
    const rows = await db
      .select({ modelId: aiPlatformModels.modelId })
      .from(aiPlatformModels)
      .where(ne(aiPlatformModels.lifecycle, 'retired'))
      .orderBy(asc(aiPlatformModels.modelId));
    return rows.map((row) => row.modelId);
  }, 'aiModels.listCatalogMappable');
}

// ---------------------------------------------------------------------------
// Writes: discovery (system scope) and /admin/ai-models (platform admin + MFA).
// ---------------------------------------------------------------------------

export interface DiscoveredModelInput {
  id: string;
  displayName: string;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  capabilities: unknown;
}

/**
 * Discovery upsert (spec §6). Never touches prices, option rates,
 * platform_offered, is_platform_default, min_plan or prompt_profile on an
 * existing row. A new row lands unpriced and unoffered. Marks the row seen
 * now: lifecycle 'available', missed counter reset.
 */
export async function upsertDiscoveredPlatformModel(
  apiModel: DiscoveredModelInput,
  now: Date = new Date(),
): Promise<{ row: PlatformModel; inserted: boolean; previousLifecycle: ModelLifecycle | null }> {
  return withSystemDbAccessContext(async () => {
    const [existingRow] = await db
      .select()
      .from(aiPlatformModels)
      .where(eq(aiPlatformModels.modelId, apiModel.id))
      .for('update')
      .limit(1);

    if (!existingRow) {
      const derived = deriveCapabilities(apiModel.capabilities);
      const [inserted] = await db.insert(aiPlatformModels).values({
        provider: 'anthropic',
        modelId: apiModel.id,
        displayName: apiModel.displayName.trim() || apiModel.id,
        maxInputTokens: apiModel.maxInputTokens,
        maxOutputTokens: apiModel.maxOutputTokens,
        capabilities: apiModel.capabilities ?? null,
        optionSupport: deriveOptionSupport(derived),
        promptProfile: derivePromptProfile(apiModel.id),
        lifecycle: 'available',
        missedSyncCount: 0,
        firstSeenAt: now,
        lastSeenAt: now,
        updatedAt: now,
      }).returning();
      return { row: toPlatformModel(inserted!), inserted: true, previousLifecycle: null };
    }

    const existing = toPlatformModel(existingRow);
    // A listing without capabilities never erases a tree we already hold.
    const capabilities = apiModel.capabilities ?? existing.capabilities;
    const [updated] = await db.update(aiPlatformModels).set({
      displayName: apiModel.displayName.trim() || existing.displayName,
      maxInputTokens: apiModel.maxInputTokens ?? existing.maxInputTokens,
      maxOutputTokens: apiModel.maxOutputTokens ?? existing.maxOutputTokens,
      capabilities,
      optionSupport: mergeDiscoveredOptionSupport(existing.optionSupport, deriveCapabilities(capabilities)),
      lifecycle: 'available',
      missedSyncCount: 0,
      lastSeenAt: now,
      updatedAt: now,
    }).where(eq(aiPlatformModels.id, existing.id)).returning();
    return { row: toPlatformModel(updated!), inserted: false, previousLifecycle: existing.lifecycle };
  }, 'aiModels.upsertDiscovered');
}

/**
 * /admin/ai-models patch. Validates against the locked current row, swaps
 * the platform default atomically (clear the old one, then set the new one,
 * in one transaction), and refreshes this process's snapshot once the
 * transaction settles.
 */
export async function updatePlatformModelAdmin(
  id: string,
  patch: PlatformModelAdminPatch,
  now: Date = new Date(),
): Promise<{ before: PlatformModel; after: PlatformModel }> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(aiPlatformModels).where(eq(aiPlatformModels.id, id)).for('update').limit(1);
    if (!row) throw new PlatformModelError('Platform model not found.', 404);
    const before = toPlatformModel(row);
    const next = validatePlatformModelAdminPatch(before, patch);

    if (next.isPlatformDefault && !before.isPlatformDefault) {
      await db.update(aiPlatformModels)
        .set({ isPlatformDefault: false, updatedAt: now })
        .where(and(eq(aiPlatformModels.isPlatformDefault, true), ne(aiPlatformModels.id, id)));
    }

    const [updated] = await db.update(aiPlatformModels).set({
      inputCentsPerM: next.rates?.inputCentsPerM ?? null,
      outputCentsPerM: next.rates?.outputCentsPerM ?? null,
      cacheReadCentsPerM: next.rates?.cacheReadCentsPerM ?? null,
      cacheWriteCentsPerM: next.rates?.cacheWriteCentsPerM ?? null,
      optionRates: next.optionRates,
      optionSupport: next.optionSupport,
      minPlan: next.minPlan,
      promptProfile: next.promptProfile,
      platformOffered: next.platformOffered,
      isPlatformDefault: next.isPlatformDefault,
      updatedAt: now,
    }).where(eq(aiPlatformModels.id, id)).returning();

    runAfterDbContextExit('aiModels.snapshotRefresh', () => refreshPlatformModelSnapshot());
    return { before, after: toPlatformModel(updated!) };
  }, 'aiModels.updateAdmin');
}

// ---------------------------------------------------------------------------
// In-process snapshot (platformModelSnapshot.ts) for synchronous hot paths.
// ---------------------------------------------------------------------------

export const PLATFORM_MODEL_SNAPSHOT_REFRESH_MS = 60_000;

export async function refreshPlatformModelSnapshot(): Promise<void> {
  setPlatformModelSnapshot(await listPlatformModels());
}

let refresher: { timer: ReturnType<typeof setInterval>; stop: () => void } | null = null;

/**
 * Started once at boot by index.ts and worker.ts. Loads immediately, then
 * every interval. A failed load keeps the previous snapshot. Ticks run
 * outside any DB context.
 */
export function startPlatformModelSnapshotRefresher(
  opts: { intervalMs?: number; load?: () => Promise<PlatformModel[]> } = {},
): () => void {
  if (refresher) return refresher.stop;
  const load = opts.load ?? listPlatformModels;
  const tick = (): void => {
    void runOutsideDbContext(async () => {
      try {
        setPlatformModelSnapshot(await load());
      } catch (error) {
        console.warn('[aiModels] platform model snapshot refresh failed; keeping the previous snapshot:', error);
      }
    });
  };
  const timer = setInterval(tick, opts.intervalMs ?? PLATFORM_MODEL_SNAPSHOT_REFRESH_MS);
  timer.unref?.();
  const stop = (): void => {
    clearInterval(timer);
    refresher = null;
  };
  refresher = { timer, stop };
  tick();
  return stop;
}
