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

import { AI_INVOCATION_RETENTION_DEFAULT_DAYS, pruneAiInvocations } from './aiInvocationRetention';
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

  it('reports a backlog when the batch cap stops a full batch', async () => {
    state.batches.push(3, 3);
    expect(await pruneAiInvocations({ retentionDays: 30, batchSize: 3, maxBatches: 2 })).toMatchObject({ batches: 2, hasMore: true });
  });

  it('falls back to the default window on a nonsense env value', async () => {
    process.env.AI_INVOCATIONS_RETENTION_DAYS = 'forever';
    expect((await pruneAiInvocations({ batchSize: 3, maxBatches: 1 })).retentionDays).toBe(AI_INVOCATION_RETENTION_DEFAULT_DAYS);
  });
});
