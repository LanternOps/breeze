// apps/api/src/__tests__/integration/aiPlatformModels.integration.test.ts
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
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
