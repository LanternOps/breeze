import { describe, expect, it, vi, beforeEach } from 'vitest';

const executed = vi.hoisted(() => ({ statements: [] as string[], counts: [] as number[] }));
vi.mock('../db', () => ({
  db: {
    execute: vi.fn(async (statement: { queryChunks?: unknown[] }) => {
      executed.statements.push(JSON.stringify(statement.queryChunks ?? statement));
      return { rowCount: executed.counts.shift() ?? 0 };
    }),
  },
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));

import { CUSTOM_EXECUTORS, CUSTOM_WOULD_DROP_COUNTS } from './orgMergeCustomExecutors';

const LOSER = '11111111-1111-4111-8111-111111111111';
const SURVIVOR = '22222222-2222-4222-8222-222222222222';

describe('trust_pages merge executor', () => {
  beforeEach(() => { executed.statements.length = 0; executed.counts.length = 0; });

  it('always deletes the loser page and clears the survivor evaluation marker', async () => {
    executed.counts.push(1, 1); // DELETE loser page → 1; UPDATE survivor → 1
    const out = await CUSTOM_EXECUTORS.trust_pages!(LOSER, SURVIVOR);
    expect(out.dropped).toBe(1);
    expect(out.moved).toBe(0);
    expect(executed.statements[0]).toMatch(/DELETE FROM trust_pages/);
    expect(executed.statements[1]).toMatch(/UPDATE trust_pages/);
    // A loser/survivor swap would delete the survivor's public page: pin which
    // org id each statement binds.
    expect(executed.statements[0]).toContain(LOSER);
    expect(executed.statements[0]).not.toContain(SURVIVOR);
    expect(executed.statements[1]).toContain(SURVIVOR);
    expect(executed.statements[1]).not.toContain(LOSER);
    expect(out.notes.join(' ')).toMatch(/retired/);
  });

  it('is a no-op note when the loser had no page', async () => {
    executed.counts.push(0, 0);
    const out = await CUSTOM_EXECUTORS.trust_pages!(LOSER, SURVIVOR);
    expect(out).toMatchObject({ dropped: 0, moved: 0 });
  });

  it('reports the would-drop count for the merge preview', async () => {
    expect(typeof CUSTOM_WOULD_DROP_COUNTS.trust_pages).toBe('function');
  });
});
