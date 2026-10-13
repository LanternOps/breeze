import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ statements: [] as string[], batches: [] as number[], contexts: 0 }));
vi.mock('../db', () => ({
  db: {
    execute: vi.fn(async (q: unknown) => {
      const text = JSON.stringify(q);
      state.statements.push(text);
      return [{ folded: state.batches.shift() ?? 0, rollups: 0 }];
    }),
  },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => { state.contexts += 1; return fn(); },
}));
vi.mock('../services/retentionMetrics', () => ({ recordRetentionRun: vi.fn() }));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureMessage: vi.fn() }));

import { LLM_EGRESS_RETENTION_DEFAULT_DAYS, foldAndPruneLlmEgressEvents } from './llmEgressRetention';
import { recordRetentionRun } from '../services/retentionMetrics';

beforeEach(() => {
  state.statements.length = 0;
  state.batches.length = 0;
  state.contexts = 0;
  delete process.env.LLM_EGRESS_EVENTS_RETENTION_DAYS;
});

describe('foldAndPruneLlmEgressEvents (#4120)', () => {
  it('folds in batches, one fresh system context per batch, stopping on a short batch', async () => {
    state.batches.push(3, 3, 1);
    const result = await foldAndPruneLlmEgressEvents({ retentionDays: 30, batchSize: 3, maxBatches: 10 });
    expect(result).toEqual({ folded: 7, batches: 3, hasMore: false, retentionDays: 30 });
    expect(state.contexts).toBe(3);
    expect(recordRetentionRun).toHaveBeenCalledWith('llm_egress_retention', { rowsDeleted: 7 });
  });

  it('deletes and upserts the rollup in the SAME statement, adding rather than overwriting counts', async () => {
    state.batches.push(0);
    await foldAndPruneLlmEgressEvents({ retentionDays: 30, batchSize: 3, maxBatches: 1 });
    expect(state.statements).toHaveLength(1);
    const stmt = state.statements[0]!;
    expect(stmt).toContain('DELETE FROM llm_egress_events');
    expect(stmt).toContain('INSERT INTO llm_egress_daily_rollups');
    expect(stmt).toContain('r.request_count + EXCLUDED.request_count');
    expect(stmt).toContain("AT TIME ZONE 'UTC'");
  });

  it('reports a backlog when the batch cap stops on a full batch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      state.batches.push(3, 3);
      expect(await foldAndPruneLlmEgressEvents({ retentionDays: 30, batchSize: 3, maxBatches: 2 }))
        .toMatchObject({ batches: 2, hasMore: true });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/\[LlmEgressRetention\].*batch cap/));
    } finally {
      warn.mockRestore();
    }
  });

  it('measures the cutoff from the injected clock and the configured window', async () => {
    process.env.LLM_EGRESS_EVENTS_RETENTION_DAYS = '14';
    state.batches.push(0);
    const now = new Date('2026-12-26T18:38:00Z');
    const result = await foldAndPruneLlmEgressEvents({ batchSize: 3, maxBatches: 1, now });
    expect(result.retentionDays).toBe(14);
    expect(state.statements[0]).toContain(new Date(now.getTime() - 14 * 86_400_000).toISOString());
  });

  it('throws (rather than silently reporting 0) when the count row is missing', async () => {
    const { db } = await import('../db');
    vi.mocked(db.execute).mockResolvedValueOnce([] as never);
    await expect(foldAndPruneLlmEgressEvents({ retentionDays: 30, batchSize: 3, maxBatches: 5 }))
      .rejects.toThrow(/\[LlmEgressRetention\].*folded/);
  });

  it('reads batch size and cap from the env knobs', async () => {
    process.env.LLM_EGRESS_EVENTS_RETENTION_BATCH_SIZE = '2';
    process.env.LLM_EGRESS_EVENTS_RETENTION_MAX_BATCHES = '2';
    try {
      state.batches.push(2, 2, 2);
      expect(await foldAndPruneLlmEgressEvents({ retentionDays: 30 })).toMatchObject({ folded: 4, batches: 2, hasMore: true });
    } finally {
      delete process.env.LLM_EGRESS_EVENTS_RETENTION_BATCH_SIZE;
      delete process.env.LLM_EGRESS_EVENTS_RETENTION_MAX_BATCHES;
    }
  });

  it('defaults to 90 days and falls back to it on a nonsense env value', async () => {
    expect(LLM_EGRESS_RETENTION_DEFAULT_DAYS).toBe(90);
    process.env.LLM_EGRESS_EVENTS_RETENTION_DAYS = 'forever';
    expect((await foldAndPruneLlmEgressEvents({ batchSize: 3, maxBatches: 1 })).retentionDays).toBe(90);
  });
});
