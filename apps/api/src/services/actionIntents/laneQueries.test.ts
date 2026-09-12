import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../../db', () => ({ db: {} }));

const executed: SQL[] = [];
const selected: unknown[] = [];
const whereArgs: unknown[] = [];
const tx = {
  execute: (q: SQL) => { executed.push(q); return Promise.resolve([]); },
  select: () => ({
    from: () => ({
      where: (w: unknown) => {
        whereArgs.push(w);
        return { limit: async () => selected };
      },
    }),
  }),
} as never;

import { countRecentLaneIntents, countRunLaneIntents, lockScriptLane, readLaneState } from './laneQueries';

/** Renders a drizzle SQL object the way Postgres would receive it. */
function chunksOf(q: SQL): { text: string; params: unknown[] } {
  const { sql: text, params } = new PgDialect().sqlToQuery(q);
  return { text, params };
}

beforeEach(() => { executed.length = 0; selected.length = 0; whereArgs.length = 0; });

describe('laneQueries', () => {
  it('takes a per-ORG advisory xact lock keyed ai-script-lane:<orgId>, with the key BOUND not interpolated', async () => {
    await lockScriptLane(tx, 'org-1');
    const { text, params } = chunksOf(executed[0]!);
    expect(text).toContain('pg_advisory_xact_lock(hashtextextended(');
    expect(text).toContain(', 0))');
    expect(text).not.toContain('org-1');
    expect(params).toEqual(['ai-script-lane:org-1']);
  });

  it('counts script_reviewer intents in the last hour (pending included) and returns 0 on no row', async () => {
    selected.push({ n: 3 });
    await expect(countRecentLaneIntents(tx, 'org-1')).resolves.toBe(3);
    selected.length = 0;
    await expect(countRecentLaneIntents(tx, 'org-1')).resolves.toBe(0);
  });

  it('the hourly count predicate names decided_via = script_reviewer and a 1-hour window', async () => {
    selected.push({ n: 0 });
    await countRecentLaneIntents(tx, 'org-1');
    const { text, params } = chunksOf(whereArgs[0] as SQL);
    expect(text).toContain("interval '1 hour'");
    expect(params).toContain('script_reviewer');
    expect(params).toContain('org-1');
  });

  it('counts a run’s own lane admissions for the per-run action cap', async () => {
    selected.push({ n: 2 });
    await expect(countRunLaneIntents(tx, 'run-1')).resolves.toBe(2);
    const { params } = chunksOf(whereArgs[0] as SQL);
    expect(params).toEqual(expect.arrayContaining(['run-1', 'script_reviewer']));
  });

  it('readLaneState returns null when the org has never opened its lane', async () => {
    await expect(readLaneState(tx, 'org-1')).resolves.toBeNull();
    selected.push({ state: 'open', openedReason: 'x' });
    await expect(readLaneState(tx, 'org-1')).resolves.toEqual({ state: 'open', openedReason: 'x' });
  });
});
