/**
 * Wisp W04 Task 2 — the deterministic thread summary. The pure helpers are
 * tested directly; `finalizeWispSessionSummary` runs over a mocked Drizzle
 * chain (system context recorded) with `updateThreadSummary` mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

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

import {
  THREAD_SUMMARY_MAX_CHARS, finalizeWispSessionSummary, summaryFromMessages, truncateSummary,
} from './threadSummary';

const THREAD = '00000000-0000-4000-8000-000000000101';
const SESSION = '00000000-0000-4000-8000-000000000201';

const sqlOf = (where: unknown) => {
  const q = new PgDialect().sqlToQuery(where as never);
  return { text: q.sql.toLowerCase(), params: q.params };
};

describe('summaryFromMessages', () => {
  it('summaryFromMessages returns the last paragraph of the last assistant message', () => {
    expect(summaryFromMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Para one.\n\nPara two.' },
      { role: 'tool_result', content: 'x' },
    ])).toBe('Para two.');
  });

  it('returns null when no assistant message has content', () => {
    expect(summaryFromMessages([{ role: 'assistant', content: null }])).toBeNull();
  });

  it('skips a later whitespace-only assistant message and ignores trailing blank lines', () => {
    expect(summaryFromMessages([
      { role: 'assistant', content: 'First.\n\n  Last para.  \n\n\n' },
      { role: 'assistant', content: '   ' },
    ])).toBe('Last para.');
  });

  it('returns null for an empty list and for user-only content', () => {
    expect(summaryFromMessages([])).toBeNull();
    expect(summaryFromMessages([{ role: 'user', content: 'only me' }])).toBeNull();
  });
});

describe('truncateSummary', () => {
  it('truncateSummary keeps ≤ 4000 chars, ends with …, and is deterministic', () => {
    const long = 'word '.repeat(1200);
    const a = truncateSummary(long);
    expect(a.length).toBeLessThanOrEqual(4000);
    expect(a.endsWith('…')).toBe(true);
    expect(truncateSummary(long)).toBe(a);
  });

  it('truncateSummary leaves short text unchanged', () => {
    expect(truncateSummary('  ok  ')).toBe('ok');
  });

  it('cuts at the last whitespace at or after 3500 when there is one', () => {
    const text = `${'a'.repeat(3600)} ${'b'.repeat(1000)}`;
    expect(truncateSummary(text)).toBe(`${'a'.repeat(3600)}…`);
  });

  it('hard-cuts at 3999 + … when no whitespace sits at or after 3500', () => {
    const text = `${'a'.repeat(100)} ${'b'.repeat(5000)}`;
    const out = truncateSummary(text);
    expect(out.length).toBe(THREAD_SUMMARY_MAX_CHARS);
    expect(out).toBe(`${text.slice(0, 3999)}…`);
  });

  it('keeps exactly-4000 text as is and never splits a surrogate pair', () => {
    const exact = 'x'.repeat(4000);
    expect(truncateSummary(exact)).toBe(exact);
    const astral = `${'a'.repeat(3998)}😀${'b'.repeat(100)}`; // 😀 occupies UTF-16 units 3998..3999
    const out = truncateSummary(astral);
    expect(out).toBe(`${'a'.repeat(3998)}…`);
    expect(out.length).toBeLessThanOrEqual(4000);
  });
});

describe('finalizeWispSessionSummary', () => {
  beforeEach(() => {
    h.rows = {};
    h.selects.length = 0;
    h.updateThreadSummary.mockClear();
  });

  it('is a no-op when the session is not attached to a thread', async () => {
    await expect(finalizeWispSessionSummary(SESSION)).resolves.toEqual({ updated: false });
    expect(h.selects.map((s) => s.table)).toEqual(['wisp_thread_sessions']);
    expect(h.updateThreadSummary).not.toHaveBeenCalled();
  });

  it("reads only that session's messages in system context and writes the computed summary", async () => {
    h.rows.wisp_thread_sessions = [{ threadId: THREAD }];
    h.rows.ai_messages = [{ role: 'assistant', content: 'Checked the backups.\n\nAll three sites are green.' }];
    h.rows.wisp_threads = [{ summary: 'older summary' }];

    await expect(finalizeWispSessionSummary(SESSION)).resolves.toEqual({ updated: true });

    expect(h.updateThreadSummary).toHaveBeenCalledWith(THREAD, 'All three sites are green.');
    expect(h.selects.every((s) => s.system)).toBe(true);
    const link = sqlOf(h.selects.find((s) => s.table === 'wisp_thread_sessions')!.where);
    expect(link.text).toContain('"session_id"');
    expect(link.params).toContain(SESSION);
    const msgs = sqlOf(h.selects.find((s) => s.table === 'ai_messages')!.where);
    expect(msgs.text).toContain('"ai_messages"."session_id"');
    expect(msgs.params).toContain(SESSION);
  });

  it('does not write when the computed summary equals the stored one (idempotent)', async () => {
    h.rows.wisp_thread_sessions = [{ threadId: THREAD }];
    h.rows.ai_messages = [{ role: 'assistant', content: 'Same.' }];
    h.rows.wisp_threads = [{ summary: 'Same.' }];
    await expect(finalizeWispSessionSummary(SESSION)).resolves.toEqual({ updated: false });
    expect(h.updateThreadSummary).not.toHaveBeenCalled();
  });

  it('compares the truncated form, so an over-long reply is not rewritten on every finalize', async () => {
    const long = 'word '.repeat(1200);
    h.rows.wisp_thread_sessions = [{ threadId: THREAD }];
    h.rows.ai_messages = [{ role: 'assistant', content: long }];
    h.rows.wisp_threads = [{ summary: truncateSummary(long) }];
    await expect(finalizeWispSessionSummary(SESSION)).resolves.toEqual({ updated: false });
    expect(h.updateThreadSummary).not.toHaveBeenCalled();
  });

  it('does not write when the session has no assistant content', async () => {
    h.rows.wisp_thread_sessions = [{ threadId: THREAD }];
    h.rows.ai_messages = [];
    h.rows.wisp_threads = [{ summary: 'kept' }];
    await expect(finalizeWispSessionSummary(SESSION)).resolves.toEqual({ updated: false });
    expect(h.updateThreadSummary).not.toHaveBeenCalled();
  });
});
