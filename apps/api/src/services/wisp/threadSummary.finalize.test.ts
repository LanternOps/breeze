/**
 * Wisp W04 Task 5 — `finalizeWispSessionSummary` close-out contract (mocked
 * Drizzle chain, system context recorded, `updateThreadSummary` mocked).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';

const h = vi.hoisted(() => ({
  state: { inSystem: false },
  rows: {} as Record<string, unknown[]>,
  selects: [] as Array<{ table: string; where: unknown; system: boolean }>,
  updateThreadSummary: vi.fn(async (_threadId: string, _summary: string) => {}),
}));

vi.mock('../../db', () => {
  const select = vi.fn(() => {
    const entry = { table: '', where: undefined as unknown, system: h.state.inSystem };
    h.selects.push(entry);
    const chain: Record<string, unknown> = {};
    chain.from = (t: Parameters<typeof getTableName>[0]) => { entry.table = getTableName(t); return chain; };
    chain.where = (w: unknown) => { entry.where = w; return chain; };
    for (const m of ['orderBy', 'limit']) chain[m] = () => chain;
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(h.rows[entry.table] ?? []).then(res, rej);
    return chain;
  });
  return { db: { select }, runOutsideDbContext: vi.fn((fn: () => unknown) => fn()), withSystemDbAccessContext: vi.fn() };
});
vi.mock('./grantAuthority', () => ({
  inSystemContext: vi.fn(async (fn: () => Promise<unknown>) => {
    h.state.inSystem = true;
    try { return await fn(); } finally { h.state.inSystem = false; }
  }),
}));
vi.mock('./threads', () => ({ updateThreadSummary: h.updateThreadSummary }));

import { finalizeWispSessionSummary } from './threadSummary';

const THREAD = '00000000-0000-4000-8000-000000000101';
const SESSION = '00000000-0000-4000-8000-000000000201';

describe('finalizeWispSessionSummary (T5 close-out)', () => {
  beforeEach(() => {
    h.rows = {};
    h.selects.length = 0;
    h.updateThreadSummary.mockClear();
  });

  it('is a no-op for a session with no thread link', async () => {
    await expect(finalizeWispSessionSummary(SESSION)).resolves.toEqual({ updated: false });
    expect(h.updateThreadSummary).not.toHaveBeenCalled();
  });

  it('writes when the computed summary differs from the stored one', async () => {
    h.rows.wisp_thread_sessions = [{ threadId: THREAD }];
    h.rows.ai_messages = [{ role: 'assistant', content: 'One.\n\nTwo.' }];
    h.rows.wisp_threads = [{ summary: 'stale' }];
    await expect(finalizeWispSessionSummary(SESSION)).resolves.toEqual({ updated: true });
    expect(h.updateThreadSummary).toHaveBeenCalledWith(THREAD, 'Two.');
  });

  it('is idempotent when the stored summary already equals the computed one', async () => {
    h.rows.wisp_thread_sessions = [{ threadId: THREAD }];
    h.rows.ai_messages = [{ role: 'assistant', content: 'One.\n\nTwo.' }];
    h.rows.wisp_threads = [{ summary: 'Two.' }];
    await expect(finalizeWispSessionSummary(SESSION)).resolves.toEqual({ updated: false });
    await expect(finalizeWispSessionSummary(SESSION)).resolves.toEqual({ updated: false });
    expect(h.updateThreadSummary).not.toHaveBeenCalled();
  });
});
