import { describe, it, expect } from 'vitest';
import { EVENT_TYPES } from '../eventBus';

describe('run progress event type', () => {
  it('is registered on the event bus under the ai.agent namespace', () => {
    expect(EVENT_TYPES.AI_AGENT_RUN_PROGRESS).toBe('ai.agent.run.progress');
  });

  it('keeps the existing completed event name unchanged', () => {
    expect(EVENT_TYPES.AI_AGENT_RUN_COMPLETED).toBe('ai.agent.run.completed');
  });
});

import { beforeEach, vi } from 'vitest';
import { emitRunProgress, readRunProgress, runProgressKey, __resetRunProgressOrdinals, RUN_PROGRESS_MAX_ENTRIES } from './runProgress';

const published: Array<{ type: string; orgId: string; payload: Record<string, unknown> }> = [];
vi.mock('../eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../eventBus')>();
  return {
    ...actual,
    publishEvent: vi.fn(async (type: string, orgId: string, payload: Record<string, unknown>) => {
      published.push({ type, orgId, payload });
      return 'evt-1';
    }),
  };
});

const store = new Map<string, string[]>();
vi.mock('../redis', () => ({
  getRedis: () => ({
    async rpush(key: string, value: string) { const l = store.get(key) ?? []; l.push(value); store.set(key, l); return l.length; },
    async ltrim(key: string, start: number, stop: number) { const l = store.get(key) ?? []; store.set(key, l.slice(start, stop === -1 ? undefined : stop + 1)); return 'OK'; },
    async expire() { return 1; },
    async lrange(key: string) { return store.get(key) ?? []; },
  }),
}));

describe('emitRunProgress', () => {
  beforeEach(() => { published.length = 0; store.clear(); __resetRunProgressOrdinals(); });

  it('publishes ai.agent.run.progress with a monotonic per-run ordinal', async () => {
    const ctx = { orgId: 'org-1', runId: 'run-1' };
    await emitRunProgress(ctx, 'export', 'Exported event_logs');
    await emitRunProgress(ctx, 'export', 'Exported metrics');
    expect(published.map((p) => p.type)).toEqual(['ai.agent.run.progress', 'ai.agent.run.progress']);
    expect(published.map((p) => p.payload.ordinal)).toEqual([1, 2]);
    expect(published[0]!.payload).toMatchObject({ runId: 'run-1', step: 'export', label: 'Exported event_logs' });
  });

  it('mirrors entries into the run progress ring, readable back in order', async () => {
    await emitRunProgress({ orgId: 'org-1', runId: 'run-2' }, 'admitted', 'Run admitted');
    await emitRunProgress({ orgId: 'org-1', runId: 'run-2' }, 'export', 'Exported agent_logs');
    const entries = await readRunProgress('run-2');
    expect(entries.map((e) => e.label)).toEqual(['Run admitted', 'Exported agent_logs']);
    expect(entries.map((e) => e.ordinal)).toEqual([1, 2]);
    expect(store.has(runProgressKey('run-2'))).toBe(true);
  });

  it('caps the ring at RUN_PROGRESS_MAX_ENTRIES', async () => {
    for (let i = 0; i < RUN_PROGRESS_MAX_ENTRIES + 5; i += 1) {
      await emitRunProgress({ orgId: 'org-1', runId: 'run-3' }, 'export', `step ${i}`);
    }
    const entries = await readRunProgress('run-3');
    expect(entries.length).toBe(RUN_PROGRESS_MAX_ENTRIES);
    expect(entries[entries.length - 1]!.label).toBe(`step ${RUN_PROGRESS_MAX_ENTRIES + 4}`);
  });

  it('never throws when the event bus fails — telemetry must not fail a run', async () => {
    const { publishEvent } = await import('../eventBus');
    (publishEvent as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('redis down'));
    await expect(emitRunProgress({ orgId: 'org-1', runId: 'run-4' }, 'export', 'x')).resolves.toBeUndefined();
  });
});
