/**
 * AI model registry (spec §6): Anthropic model discovery. W01 covers the
 * platform key (`syncPlatformModels`); W03 adds `syncConnectionModels` for
 * BYOK.
 *
 * Discovery NEVER enables, prices, deletes, or changes an assignment. New ids
 * land unpriced and unoffered, and the operator is alerted.
 */
import Anthropic from '@anthropic-ai/sdk';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { ModelLifecycle } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiPlatformModels } from '../../db/schema';
import { sendOpsAlert } from '../opsAlerts';
import { captureException } from '../sentry';
import { refreshPlatformModelSnapshot, upsertDiscoveredPlatformModel, type DiscoveredModelInput } from './platformModels';

export const ANTHROPIC_API_ORIGIN = 'https://api.anthropic.com';
export type AnthropicModelInfo = DiscoveredModelInput;

/** A plain model identifier; anything else is skipped rather than shown to operators. */
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

export async function discoverAnthropicModels(apiKey: string | undefined): Promise<AnthropicModelInfo[]> {
  const key = apiKey?.trim();
  if (!key) throw new Error('discoverAnthropicModels: an API key is required');
  // Forced origin and no auth token: the SDK would otherwise pick up
  // ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN from the environment.
  const client = new Anthropic({ apiKey: key, authToken: null, baseURL: ANTHROPIC_API_ORIGIN, timeout: 30_000, maxRetries: 2 });
  const models: AnthropicModelInfo[] = [];
  for await (const model of client.models.list({ limit: 100 })) {
    if (typeof model.id !== 'string' || !MODEL_ID_PATTERN.test(model.id)) {
      console.warn(`[aiModels] skipping a listed model with an unexpected id: ${JSON.stringify(String(model.id)).slice(0, 140)}`);
      continue;
    }
    models.push({
      id: model.id,
      displayName: typeof model.display_name === 'string' ? model.display_name : '',
      maxInputTokens: model.max_input_tokens ?? null,
      maxOutputTokens: model.max_tokens ?? null,
      capabilities: model.capabilities ?? null,
    });
  }
  return models;
}

export const LIFECYCLE_MISSING_AFTER_SYNCS = 3;
export const LIFECYCLE_MISSING_MIN_ABSENT_MS = 48 * 3_600_000;
export const LIFECYCLE_RETIRED_AFTER_MS = 14 * 86_400_000;

export function computeLifecycleAfterSync(
  row: { lifecycle: ModelLifecycle; missedSyncCount: number; lastSeenAt: Date | null },
  seen: boolean,
  now: Date,
): { lifecycle: ModelLifecycle; missedSyncCount: number } {
  if (seen) return { lifecycle: 'available', missedSyncCount: 0 };
  // Never observed by a sync (seeded row, e.g. an alias the listing omits): leave it alone.
  if (row.lastSeenAt === null) return { lifecycle: row.lifecycle, missedSyncCount: row.missedSyncCount };
  const missedSyncCount = row.missedSyncCount + 1;
  if (row.lifecycle === 'retired') return { lifecycle: 'retired', missedSyncCount };
  const absentMs = now.getTime() - row.lastSeenAt.getTime();
  if (missedSyncCount >= LIFECYCLE_MISSING_AFTER_SYNCS && absentMs >= LIFECYCLE_RETIRED_AFTER_MS) {
    return { lifecycle: 'retired', missedSyncCount };
  }
  if (missedSyncCount >= LIFECYCLE_MISSING_AFTER_SYNCS && absentMs >= LIFECYCLE_MISSING_MIN_ABSENT_MS) {
    return { lifecycle: 'missing', missedSyncCount };
  }
  return { lifecycle: row.lifecycle, missedSyncCount };
}

export type SyncReport =
  | { status: 'skipped'; reason: 'no_platform_key' | 'custom_base_url' }
  | { status: 'failed'; error: string }
  | {
    status: 'ok';
    discovered: number;
    inserted: string[];
    restored: string[];
    markedMissing: string[];
    retired: string[];
    operatorNotified: boolean;
  };

export interface SyncPlatformModelsOptions {
  env?: NodeJS.ProcessEnv;
  discover?: (apiKey: string) => Promise<AnthropicModelInfo[]>;
  now?: () => Date;
}

function isAnthropicApiOrigin(url: string): boolean {
  try {
    return new URL(url).origin === ANTHROPIC_API_ORIGIN;
  } catch {
    return false;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
}

interface SyncWrite {
  inserted: string[];
  restored: string[];
  markedMissing: string[];
  retired: string[];
  toNotify: Array<{ id: string; modelId: string }>;
  defaultProblem: { modelId: string; lifecycle: ModelLifecycle } | null;
}

function formatSyncAlert(write: SyncWrite): { title: string; body: string } {
  const lines: string[] = [];
  if (write.toNotify.length > 0) {
    lines.push(
      `New Anthropic model(s) discovered: ${write.toNotify.map((m) => m.modelId).join(', ')}.`,
      'They are unpriced and not offered to anyone until a platform admin sets a price and offers them on /admin/ai-models.',
    );
  }
  if (write.markedMissing.length > 0) lines.push(`No longer listed by the Models API (missing): ${write.markedMissing.join(', ')}.`);
  if (write.retired.length > 0) lines.push(`Retired after 14 days unlisted: ${write.retired.join(', ')}.`);
  if (write.defaultProblem) {
    lines.push(`The platform default model ${write.defaultProblem.modelId} is ${write.defaultProblem.lifecycle}; choose another default on /admin/ai-models.`);
  }
  const title = write.toNotify.length > 0
    ? `${write.toNotify.length} new Anthropic model(s) awaiting pricing`
    : 'Anthropic model availability changed';
  return { title, body: lines.join('\n') };
}

export async function syncPlatformModels(options: SyncPlatformModelsOptions = {}): Promise<SyncReport> {
  const env = options.env ?? process.env;
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return { status: 'skipped', reason: 'no_platform_key' };
  const baseUrl = env.ANTHROPIC_BASE_URL?.trim();
  if (baseUrl && !isAnthropicApiOrigin(baseUrl)) return { status: 'skipped', reason: 'custom_base_url' };

  // Network call: never inside a DB context (#1105).
  let discovered: AnthropicModelInfo[];
  try {
    discovered = await runOutsideDbContext(() => (options.discover ?? discoverAnthropicModels)(apiKey));
  } catch (error) {
    captureException(error instanceof Error ? error : new Error(String(error)));
    return { status: 'failed', error: describeError(error) };
  }
  if (discovered.length === 0) return { status: 'failed', error: 'the Models API returned no models' };

  const now = (options.now ?? (() => new Date()))();
  const seenIds = new Set(discovered.map((model) => model.id));

  const write = await runOutsideDbContext(() => withSystemDbAccessContext(async (): Promise<SyncWrite> => {
    // Serialise concurrent syncs (daily + manual + boot across replicas) so
    // missed-sync counts are never double-incremented by overlapping runs.
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('ai-model-discovery:sync-platform', 0))`);

    const inserted: string[] = [];
    const restored: string[] = [];
    for (const model of discovered) {
      const result = await upsertDiscoveredPlatformModel(model, now);
      if (result.inserted) inserted.push(model.id);
      else if (result.previousLifecycle && result.previousLifecycle !== 'available') restored.push(model.id);
    }

    const rows = await db
      .select({
        id: aiPlatformModels.id,
        modelId: aiPlatformModels.modelId,
        lifecycle: aiPlatformModels.lifecycle,
        missedSyncCount: aiPlatformModels.missedSyncCount,
        lastSeenAt: aiPlatformModels.lastSeenAt,
        isPlatformDefault: aiPlatformModels.isPlatformDefault,
      })
      .from(aiPlatformModels)
      .where(eq(aiPlatformModels.provider, 'anthropic'));

    const markedMissing: string[] = [];
    const retired: string[] = [];
    let defaultProblem: SyncWrite['defaultProblem'] = null;
    for (const row of rows) {
      if (seenIds.has(row.modelId)) continue;
      const next = computeLifecycleAfterSync(row, false, now);
      if (next.lifecycle !== row.lifecycle || next.missedSyncCount !== row.missedSyncCount) {
        await db.update(aiPlatformModels)
          .set({ lifecycle: next.lifecycle, missedSyncCount: next.missedSyncCount, updatedAt: now })
          .where(eq(aiPlatformModels.id, row.id));
      }
      if (next.lifecycle !== row.lifecycle) (next.lifecycle === 'missing' ? markedMissing : retired).push(row.modelId);
      if (row.isPlatformDefault && next.lifecycle !== 'available') defaultProblem = { modelId: row.modelId, lifecycle: next.lifecycle };
    }

    // New-to-the-operator ids: discovered by a sync (not seeded), not offered,
    // never successfully alerted. Includes earlier syncs' undelivered alerts.
    const toNotify = await db
      .select({ id: aiPlatformModels.id, modelId: aiPlatformModels.modelId })
      .from(aiPlatformModels)
      .where(and(
        eq(aiPlatformModels.platformOffered, false),
        isNull(aiPlatformModels.operatorNotifiedAt),
        isNotNull(aiPlatformModels.lastSeenAt),
      ));

    return { inserted, restored, markedMissing, retired, toNotify, defaultProblem };
  }, 'aiModels.syncPlatform'));

  let operatorNotified = false;
  if (write.toNotify.length > 0 || write.markedMissing.length > 0 || write.retired.length > 0 || write.defaultProblem) {
    operatorNotified = await sendOpsAlert(formatSyncAlert(write));
    if (!operatorNotified) {
      console.warn('[aiModels] model discovery alert was not delivered (ops alerting unconfigured or failing); new models are flagged on /admin/ai-models');
    }
    if (operatorNotified && write.toNotify.length > 0) {
      // The alert already went out. A failed mark must not fail the job:
      // BullMQ would retry the whole sync and send the same alert again. The
      // next daily sync re-alerts these ids at worst.
      try {
        await runOutsideDbContext(() => withSystemDbAccessContext(() =>
          db.update(aiPlatformModels)
            .set({ operatorNotifiedAt: now })
            .where(inArray(aiPlatformModels.id, write.toNotify.map((row) => row.id))),
        'aiModels.markNotified'));
      } catch (error) {
        console.warn('[aiModels] could not mark discovered models as notified; they will be re-alerted on the next sync:', error);
        captureException(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  try {
    await refreshPlatformModelSnapshot();
  } catch (error) {
    console.warn('[aiModels] snapshot refresh after sync failed; the periodic refresher will retry:', error);
  }

  return {
    status: 'ok',
    discovered: discovered.length,
    inserted: write.inserted,
    restored: write.restored,
    markedMissing: write.markedMissing,
    retired: write.retired,
    operatorNotified,
  };
}
