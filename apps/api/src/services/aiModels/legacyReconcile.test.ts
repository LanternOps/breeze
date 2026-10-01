import { describe, expect, it, vi } from 'vitest';

const ctx = vi.hoisted(() => ({ scope: undefined as string | undefined }));
const fakeDb = vi.hoisted(() => ({
  partnerIds: [] as Array<{ id: string }>,
  select: () => ({ from: () => ({ orderBy: async () => fakeDb.partnerIds }) }),
  failure: null as unknown,
  execute: async (): Promise<never> => {
    throw fakeDb.failure ?? new Error('Failed query: INSERT ... params: sealed-ciphertext', {
      cause: Object.assign(new Error('injected pg failure'), { code: '23503' }),
    });
  },
}));
vi.mock('../../db', () => ({
  db: fakeDb,
  getCurrentDbAccessContext: () => (ctx.scope ? { scope: ctx.scope } : undefined),
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../../config/env', () => ({ AI_SCRIPT_REVIEWER_MODEL: 'claude-reviewer-env' }));
vi.mock('../aiModel', () => ({ resolveDefaultModel: () => 'claude-default-env' }));

import { readLegacyProjectionEnv, reconcileAllPartnersFromLegacy, reconcilePartnerFromLegacyInTx } from './legacyReconcile';

describe('legacyReconcile guards (#7600 W02)', () => {
  it('reads the same env values the legacy call sites use', () => {
    const saved = process.env.WORKSPACE_CONTENT_LLM_MODEL;
    process.env.WORKSPACE_CONTENT_LLM_MODEL = 'claude-ext-env';
    try {
      const env = readLegacyProjectionEnv();
      expect(env).toMatchObject({ defaultModel: 'claude-default-env', reviewerModel: 'claude-reviewer-env', extensionModel: 'claude-ext-env' });
      expect(env.legacyRates('claude-sonnet-5-5').inputCentsPerM).toBe(200);
    } finally {
      if (saved === undefined) delete process.env.WORKSPACE_CONTENT_LLM_MODEL; else process.env.WORKSPACE_CONTENT_LLM_MODEL = saved;
    }
  });

  it('refuses to run outside a held system context (it would silently see a tenant slice)', async () => {
    ctx.scope = 'partner';
    await expect(reconcilePartnerFromLegacyInTx('p')).rejects.toThrow(/system DB context/);
    ctx.scope = undefined;
    await expect(reconcilePartnerFromLegacyInTx('p')).rejects.toThrow(/system DB context/);
  });

  it('the boot sweep records each partner failure by its Postgres cause (never the param-bearing query text) and moves on', async () => {
    ctx.scope = 'system';
    fakeDb.partnerIds = [{ id: 'p1' }, { id: 'p2' }];
    try {
      const result = await reconcileAllPartnersFromLegacy({ env: readLegacyProjectionEnv() });
      expect(result).toEqual({
        partners: 2,
        failures: [
          { partnerId: 'p1', error: 'Error (SQLSTATE 23503, injected pg failure)' },
          { partnerId: 'p2', error: 'Error (SQLSTATE 23503, injected pg failure)' },
        ],
      });
      expect(JSON.stringify(result)).not.toContain('sealed-ciphertext');
    } finally {
      ctx.scope = undefined;
      fakeDb.partnerIds = [];
    }
  });

  it('the boot sweep drops a class-22 primary message and keeps a non-query error\'s OWN message (never its cause\'s)', async () => {
    ctx.scope = 'system';
    fakeDb.partnerIds = [{ id: 'p1' }];
    try {
      fakeDb.failure = new Error('Failed query: select ... params: sealed-ciphertext', {
        cause: Object.assign(new Error('invalid input syntax for type uuid: "sealed-ciphertext"'), { code: '22P02' }),
      });
      expect((await reconcileAllPartnersFromLegacy({ env: readLegacyProjectionEnv() })).failures)
        .toEqual([{ partnerId: 'p1', error: 'Error (SQLSTATE 22P02)' }]);
      fakeDb.failure = new Error('legacyReconcile: offering platform:x was not upserted', { cause: new Error('inner') });
      expect((await reconcileAllPartnersFromLegacy({ env: readLegacyProjectionEnv() })).failures)
        .toEqual([{ partnerId: 'p1', error: 'legacyReconcile: offering platform:x was not upserted' }]);
    } finally {
      ctx.scope = undefined;
      fakeDb.partnerIds = [];
      fakeDb.failure = null;
    }
  });
});
