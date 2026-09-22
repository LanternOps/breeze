/**
 * The AI Operator merge fence's human-work arm (Recipe Library wave E3).
 *
 * Org merge re-points the loser org's tickets — and therefore its checklist
 * items — at the survivor, while task and step `org_id` stay on the loser.
 * The link FK is plain and single-column, so nothing raises; the fence has to
 * null the pointer itself, in the RESOLVE phase, or a fenced task carries a
 * cross-tenant pointer for as long as it exists. Asserted from the compiled
 * SQL so a later edit cannot quietly drop the org or the settled_at guard.
 */
import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const executeMock = vi.fn(async () => ({ rowCount: 0 }));

vi.mock('../db', () => ({
  db: { execute: (...args: unknown[]) => executeMock(...(args as [])) },
}));

import { CUSTOM_RESOLVE_EXECUTORS } from './orgMergeCustomExecutors';

const dialect = new PgDialect();
const L = '11111111-1111-1111-1111-111111111111';
const S = '22222222-2222-2222-2222-222222222222';

describe('fenceAiOperatorTasks — human-work link detach (E3)', () => {
  it('nulls checklist_item_id on every UNSETTLED loser-org step, in the resolve phase', async () => {
    executeMock.mockResolvedValue({ rowCount: 0 });
    const fence = CUSTOM_RESOLVE_EXECUTORS.ai_operator_tasks!;
    await fence(L, S);

    const statements = executeMock.mock.calls.map((c) => dialect.sqlToQuery((c as unknown as [SQL])[0]));
    const detach = statements.find((q) => /update\s+ai_operator_task_steps/i.test(q.sql));
    expect(detach).toBeDefined();
    expect(detach!.sql).toMatch(/set\s+checklist_item_id\s*=\s*null/i);
    // Scoped to the LOSER's steps: the survivor's own human work is untouched.
    expect(detach!.sql).toMatch(/org_id\s*=\s*\$\d+::uuid/i);
    expect(detach!.params).toContain(L);
    // Only live steps: a settled step's pointer is history and may stay.
    expect(detach!.sql).toMatch(/settled_at\s+is\s+null/i);
  });

  it('reports the detach count in the merge notes when any link was cut', async () => {
    executeMock.mockImplementation(async (statement: unknown) => {
      const sql = dialect.sqlToQuery(statement as SQL).sql;
      return { rowCount: /update\s+ai_operator_task_steps/i.test(sql) ? 2 : 0 };
    });
    const fence = CUSTOM_RESOLVE_EXECUTORS.ai_operator_tasks!;
    const outcome = await fence(L, S);
    expect(outcome.notes.join('\n')).toMatch(/ai_operator_task_steps: detached 2 .*human-work/i);
  });
});
