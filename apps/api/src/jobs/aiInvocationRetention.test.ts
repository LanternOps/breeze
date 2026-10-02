import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ statements: [] as string[], batches: [] as number[] }));
vi.mock('../db', () => ({
  db: {
    execute: vi.fn(async (q: { queryChunks?: unknown[] }) => {
      const text = JSON.stringify(q);
      state.statements.push(text);
      if (text.includes('DELETE FROM ai_invocations')) return { count: state.batches.shift() ?? 0 };
      return [];
    }),
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../services/retentionMetrics', () => ({ recordRetentionRun: vi.fn() }));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn() }));

import { AI_INVOCATION_RETENTION_DEFAULT_DAYS, CHARGEBACK_RETENTION_FLOOR_DAYS, pruneAiInvocations } from './aiInvocationRetention';
import { CHARGEBACK_LOOKBACK_DAYS } from '../services/aiChargeback/chargePeriods';
import { recordRetentionRun } from '../services/retentionMetrics';

beforeEach(() => { state.statements.length = 0; state.batches.length = 0; delete process.env.AI_INVOCATIONS_RETENTION_DAYS; });

describe('pruneAiInvocations (#7600 W02)', () => {
  it('deletes in batches as breeze_audit_admin with the retention GUC, stopping on a short batch', async () => {
    state.batches.push(3, 3, 1);
    const result = await pruneAiInvocations({ retentionDays: 30, batchSize: 3, maxBatches: 10 });
    expect(result).toEqual({ deleted: 7, batches: 3, hasMore: false, retentionDays: 30 });
    const perBatch = state.statements.filter((s) => s.includes('SET LOCAL ROLE breeze_audit_admin')).length;
    expect(perBatch).toBe(3);
    expect(state.statements.filter((s) => s.includes("breeze.allow_audit_retention = '1'")).length).toBe(3);
    expect(recordRetentionRun).toHaveBeenCalledWith('ai_invocation_retention', { rowsDeleted: 7 });
  });

  it('reports a backlog when the batch cap stops a full batch, and warns about it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      state.batches.push(3, 3);
      expect(await pruneAiInvocations({ retentionDays: 30, batchSize: 3, maxBatches: 2 })).toMatchObject({ batches: 2, hasMore: true });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/\[AiInvocationRetention\].*backlog/));
      warn.mockClear();
      state.batches.push(3, 1);
      await pruneAiInvocations({ retentionDays: 30, batchSize: 3, maxBatches: 2 });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('falls back to the default window on a nonsense env value', async () => {
    process.env.AI_INVOCATIONS_RETENTION_DAYS = 'forever';
    expect((await pruneAiInvocations({ batchSize: 3, maxBatches: 1 })).retentionDays).toBe(AI_INVOCATION_RETENTION_DEFAULT_DAYS);
  });
});

describe('the AI chargeback retention floor (#7608)', () => {
  it('covers the lookback plus TWO longest months: the close of P counts rows aging out of P-1\'s lookback', () => {
    expect(CHARGEBACK_RETENTION_FLOOR_DAYS).toBeGreaterThanOrEqual(CHARGEBACK_LOOKBACK_DAYS + 62);
  });
  it('measures the window and the floor from the injected clock', async () => {
    state.batches.push(0);
    const now = new Date('2026-12-01T05:28:00Z');
    await pruneAiInvocations({ retentionDays: 7, batchSize: 3, maxBatches: 1, now });
    const del = state.statements.find((s) => s.includes('DELETE FROM ai_invocations'))!;
    const day = 86_400_000;
    expect(del).toContain(new Date(now.getTime() - 7 * day).toISOString());
    expect(del).toContain(new Date(now.getTime() - CHARGEBACK_RETENTION_FLOOR_DAYS * day).toISOString());
  });
});
