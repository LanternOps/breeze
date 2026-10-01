// apps/api/src/__tests__/integration/aiPlatformModels.integration.test.ts
import './setup';
import { readFileSync } from 'node:fs';
import { toPlatformModel } from '../../services/aiModels/platformModels';
import { SEEDED_PLATFORM_MODELS, W00_OFFERABLE_AI_MODELS } from '../../services/aiModels/__fixtures__/seededPlatformModels';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { inArray, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { aiPlatformModels } from '../../db/schema';
import { pgErrorCode, pgErrorConstraint } from '../../utils/pgErrors';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const RATES = { inputCentsPerM: 100, outputCentsPerM: 500, cacheReadCentsPerM: 10, cacheWriteCentsPerM: 125 };

function testModelId(): string {
  return `w01-test-${randomUUID()}`;
}

function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

/** Runs `fn` in its own system transaction and returns the Postgres error it raised. The failure rolls the transaction back. */
async function pgFailure(fn: () => Promise<unknown>): Promise<{ code: string | undefined; constraint: string | undefined }> {
  try {
    await withSystemDbAccessContext(async () => {
      await fn();
    });
  } catch (error) {
    return { code: pgErrorCode(error), constraint: pgErrorConstraint(error) };
  }
  throw new Error('expected a Postgres error');
}

describe('ai_platform_models: posture and constraint backstops (W01 #7599)', () => {
  runDb('carries no RLS: the route layer is the only gate (mirrors llm_provider_catalog)', async () => {
    const rows = (await withSystemDbAccessContext(() => db.execute(sql`
      SELECT c.relrowsecurity AS rls_on, c.relforcerowsecurity AS force_on
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'ai_platform_models'
    `))) as unknown as Array<{ rls_on: boolean; force_on: boolean }>;
    expect(rows).toEqual([{ rls_on: false, force_on: false }]);
  });

  runDb('an org-scoped request context can read it (hot-path price and capability lookups)', async () => {
    const org = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      return createOrganization({ partnerId: partner.id });
    });
    const rows = await withDbAccessContext(orgContext(org.id), () =>
      db.select({ n: sql<number>`count(*)::int` }).from(aiPlatformModels),
    );
    expect(typeof rows[0]?.n).toBe('number');
  });

  runDb('rejects platform_offered without all four prices (23514)', async () => {
    expect(await pgFailure(() => db.insert(aiPlatformModels).values({
      modelId: testModelId(), displayName: 'unpriced', platformOffered: true, inputCentsPerM: 100,
    }))).toEqual({ code: '23514', constraint: 'ai_platform_models_offered_priced_chk' });
  });

  runDb('rejects a platform default that is not offered (23514)', async () => {
    expect(await pgFailure(async () => {
      await db.update(aiPlatformModels).set({ isPlatformDefault: false }).where(sql`is_platform_default`);
      await db.insert(aiPlatformModels).values({
        modelId: testModelId(), displayName: 'default not offered', isPlatformDefault: true, ...RATES,
      });
    })).toEqual({ code: '23514', constraint: 'ai_platform_models_default_offered_chk' });
  });

  runDb('allows at most one platform default (23505)', async () => {
    expect(await pgFailure(async () => {
      await db.update(aiPlatformModels).set({ isPlatformDefault: false }).where(sql`is_platform_default`);
      for (let i = 0; i < 2; i += 1) {
        await db.insert(aiPlatformModels).values({
          modelId: testModelId(), displayName: `default ${i}`, platformOffered: true, isPlatformDefault: true, ...RATES,
        });
      }
    })).toEqual({ code: '23505', constraint: 'ai_platform_models_one_default_uq' });
  });

  runDb.each([
    ['a negative price', { inputCentsPerM: -1 }, 'ai_platform_models_prices_nonneg_chk'],
    ['an unknown lifecycle', { lifecycle: 'gone' }, 'ai_platform_models_lifecycle_chk'],
    ['an unknown prompt profile', { promptProfile: 'tiny' }, 'ai_platform_models_prompt_profile_chk'],
    ['a non-object option_support', { optionSupport: sql`'[]'::jsonb` }, 'ai_platform_models_option_support_obj_chk'],
  ] as const)('rejects %s (23514)', async (_label, values, constraint) => {
    expect(await pgFailure(() => db.insert(aiPlatformModels).values({
      modelId: testModelId(), displayName: 'bad', ...(values as Record<string, unknown>),
    } as typeof aiPlatformModels.$inferInsert))).toEqual({ code: '23514', constraint });
  });

  runDb('rejects a duplicate model_id (23505)', async () => {
    const modelId = testModelId();
    expect(await pgFailure(async () => {
      await db.insert(aiPlatformModels).values({ modelId, displayName: 'one' });
      await db.insert(aiPlatformModels).values({ modelId, displayName: 'two' });
    })).toEqual({ code: '23505', constraint: 'ai_platform_models_model_id_uq' });
  });
});

const SEED_SQL_PATH = new URL('../../../migrations/2026-11-13-100100-ai-platform-models-seed.sql', import.meta.url);
const SEEDED_IDS = SEEDED_PLATFORM_MODELS.map((m) => m.modelId);
class Rollback extends Error {}

function comparable(model: ReturnType<typeof toPlatformModel>) {
  return {
    provider: model.provider,
    modelId: model.modelId,
    displayName: model.displayName,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    capabilities: model.capabilities,
    rates: model.rates,
    optionRates: model.optionRates,
    optionSupport: model.optionSupport,
    minPlan: model.minPlan,
    promptProfile: model.promptProfile,
    platformOffered: model.platformOffered,
    isPlatformDefault: model.isPlatformDefault,
    lifecycle: model.lifecycle,
    missedSyncCount: model.missedSyncCount,
    lastSeenAt: model.lastSeenAt,
  };
}

async function seededRows() {
  return withSystemDbAccessContext(async () =>
    (await db.select().from(aiPlatformModels).where(inArray(aiPlatformModels.modelId, SEEDED_IDS))).map(toPlatformModel),
  );
}

describe('ai_platform_models seed (W01 #7599)', () => {
  runDb('matches the fixture row for row (W00 MODEL_PRICING / OFFERABLE_AI_MODELS)', async () => {
    const rows = await seededRows();
    expect(rows.map(comparable).sort((a, b) => a.modelId.localeCompare(b.modelId)))
      .toEqual(SEEDED_PLATFORM_MODELS.map(comparable).sort((a, b) => a.modelId.localeCompare(b.modelId)));
    for (const row of rows) expect(row.operatorNotifiedAt, row.modelId).not.toBeNull();
  });

  runDb('offers exactly the W00 offerable ids, and Sonnet 5.5 is the only platform default', async () => {
    const rows = await seededRows();
    expect(rows.filter((r) => r.platformOffered).map((r) => r.modelId).sort()).toEqual([...W00_OFFERABLE_AI_MODELS].sort());
    const defaults = await withSystemDbAccessContext(() =>
      db.select({ modelId: aiPlatformModels.modelId }).from(aiPlatformModels).where(sql`is_platform_default`),
    );
    expect(defaults).toEqual([{ modelId: 'claude-sonnet-5-5' }]);
  });

  runDb('re-running the seed is a no-op that never overwrites operator edits', async () => {
    await expect(withSystemDbAccessContext(async () => {
      await db.update(aiPlatformModels).set({ inputCentsPerM: 999 }).where(sql`model_id = 'claude-opus-4-8'`);
      await db.execute(sql.raw(readFileSync(SEED_SQL_PATH, 'utf8')));
      const [row] = await db.select().from(aiPlatformModels).where(sql`model_id = 'claude-opus-4-8'`);
      expect(toPlatformModel(row!).rates?.inputCentsPerM).toBe(999);
      const [{ n }] = (await db.execute(sql`SELECT count(*)::int AS n FROM ai_platform_models WHERE model_id IN ${SEEDED_IDS}`)) as unknown as Array<{ n: number }>;
      expect(n).toBe(SEEDED_IDS.length);
      throw new Rollback();
    })).rejects.toBeInstanceOf(Rollback);
  });
});
