/**
 * Wisp companion W02a Task 2 — `recordThreadPost`. Drizzle is mocked: the
 * concern read resolves to the queued rows and the insert chain records its
 * values, its ON CONFLICT target and its RETURNING. The real-DB arbiter
 * (the unique index actually matches the target) is pinned in
 * __tests__/integration/wispThreadPostsRls.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTableColumns } from 'drizzle-orm';

const h = vi.hoisted(() => ({
  concernRows: [] as Array<{ partnerId: string }>,
  insertReturning: [] as Array<{ id: string }>,
  calls: [] as string[],
  inserted: [] as unknown[],
  conflictTargets: [] as unknown[],
}));

vi.mock('../../db', async () => {
  const { getTableName } = await import('drizzle-orm');
  const select = vi.fn(() => {
    const chain: Record<string, unknown> = {};
    chain.from = (t: Parameters<typeof getTableName>[0]) => { h.calls.push(`select:${getTableName(t)}`); return chain; };
    for (const m of ['where', 'limit']) chain[m] = () => chain;
    chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve([...h.concernRows]).then(res, rej);
    return chain;
  });
  const insert = vi.fn((t: Parameters<typeof getTableName>[0]) => {
    h.calls.push(`insert:${getTableName(t)}`);
    const chain: Record<string, unknown> = {};
    chain.values = (v: unknown) => { h.inserted.push(v); return chain; };
    chain.onConflictDoNothing = (cfg: { target: unknown }) => { h.conflictTargets.push(cfg.target); return chain; };
    chain.returning = () => Promise.resolve([...h.insertReturning]);
    return chain;
  });
  return { db: { select, insert } };
});

import { wispThreadPosts } from '../../db/schema/wispThreadPosts';
import { recordThreadPost, ThreadPostConcernError, type ThreadPostInput } from './threadPosts';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '11111111-1111-4111-8111-222222222222';
const T1 = '77777777-7777-4777-8777-777777777777';
const G1 = '99999999-9999-4999-8999-999999999999';
const O1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const C1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const N1 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const POST = 'abababab-abab-4bab-8bab-abababababab';

const input = (over: Partial<ThreadPostInput> = {}): ThreadPostInput => ({
  threadId: T1, partnerId: P1, grantId: G1, orgId: O1, kind: 'nudge',
  title: 'Greenwood: ticket waiting 3 days', body: 'Waiting on the customer.', link: `/ai/wisp/thread/${T1}#concern=${C1}`,
  sections: null, concernId: C1, notificationId: N1, dedupeKey: `wisp.nudge:${C1}:${G1}:first`,
  ...over,
});

beforeEach(() => {
  h.concernRows = [{ partnerId: P1 }];
  h.insertReturning = [{ id: POST }];
  h.calls = [];
  h.inserted = [];
  h.conflictTargets = [];
});

describe('recordThreadPost', () => {
  it('inserts the post field by field with ON CONFLICT (thread_id, dedupe_key) DO NOTHING and returns created=true with the id', async () => {
    expect(await recordThreadPost(input())).toEqual({ created: true, id: POST });
    expect(h.calls).toEqual(['select:wisp_concerns', 'insert:wisp_thread_posts']);
    expect(h.inserted).toEqual([{
      threadId: T1, partnerId: P1, grantId: G1, orgId: O1, kind: 'nudge',
      title: 'Greenwood: ticket waiting 3 days', body: 'Waiting on the customer.', link: `/ai/wisp/thread/${T1}#concern=${C1}`,
      sections: null, concernId: C1, notificationId: N1, dedupeKey: `wisp.nudge:${C1}:${G1}:first`,
    }]);
    const cols = getTableColumns(wispThreadPosts);
    expect(h.conflictTargets).toEqual([[cols.threadId, cols.dedupeKey]]);
  });

  it('conflict returns created=false, id=null', async () => {
    h.insertReturning = [];
    expect(await recordThreadPost(input())).toEqual({ created: false, id: null });
  });

  it('a concern under another partner throws and writes nothing', async () => {
    h.concernRows = [{ partnerId: P2 }];
    await expect(recordThreadPost(input())).rejects.toBeInstanceOf(ThreadPostConcernError);
    expect(h.calls).toEqual(['select:wisp_concerns']);
  });

  it('a missing concern throws and writes nothing', async () => {
    h.concernRows = [];
    await expect(recordThreadPost(input())).rejects.toBeInstanceOf(ThreadPostConcernError);
    expect(h.inserted).toEqual([]);
  });

  it('a post without a concern reads no concern; the brief keeps its sections', async () => {
    const sections = [{ heading: 'Needs you', lines: ['Greenwood: ticket waiting 3 days'] }];
    await recordThreadPost(input({ kind: 'brief', orgId: null, concernId: null, sections, dedupeKey: `wisp.brief:${T1}:2026-10-25` }));
    expect(h.calls).toEqual(['insert:wisp_thread_posts']);
    expect(h.inserted[0]).toMatchObject({ kind: 'brief', orgId: null, concernId: null, sections });
  });

  it('truncates the title to 255 code points (varchar(255) counts characters), never splitting a surrogate pair', async () => {
    const title = `${'a'.repeat(254)}😀😀`;
    await recordThreadPost(input({ title }));
    const written = (h.inserted[0] as { title: string }).title;
    expect(Array.from(written)).toHaveLength(255);
    expect(written.endsWith('😀')).toBe(true);
  });
});
