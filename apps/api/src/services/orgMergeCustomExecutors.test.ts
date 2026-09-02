/**
 * Mocked-DB unit tests for org-merge custom executors whose behavior depends
 * on row counts and compiled SQL predicates, rather than the pure SQL
 * builders covered in `orgMergeExecutors.test.ts` or the real-Postgres
 * behavior covered in
 * `__tests__/integration/orgMergeCustomExecutors.integration.test.ts`.
 *
 * Task 17 (A2-7, #4192) — "org merge must not carry graduated authority": a
 * repoint alone would hand the survivor org an `ai_agents.act_assets
 * .supervisedActionKeys` grant nobody on the survivor ever earned, while the
 * evidence that justified it stays on the merged-away loser shell
 * (`ai_agent_op_evidence` is `leave-for-erasure`, per `orgMergeRegistry.ts`).
 * `mergeAiAgents` must clear the loser's supervised keys BEFORE repointing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const executeMock = vi.fn();

vi.mock('../db', () => ({
  db: { execute: (...args: unknown[]) => executeMock(...args) },
}));

import { CUSTOM_EXECUTORS } from './orgMergeCustomExecutors';

const dialect = new PgDialect();
const L = '11111111-1111-1111-1111-111111111111';
const S = '22222222-2222-2222-2222-222222222222';

const mergeAiAgents = CUSTOM_EXECUTORS.ai_agents!;

describe('mergeAiAgents — clears graduated supervised keys before repointing (#4192 Task 17)', () => {
  afterEach(() => {
    executeMock.mockReset();
  });

  it('clears supervised keys on loser agents that had them and reports the count in a note', async () => {
    executeMock
      .mockResolvedValueOnce({ rowCount: 0 }) // disable-collision UPDATE — no collisions
      .mockResolvedValueOnce({ rowCount: 1 }) // clear-supervised-keys UPDATE — one agent had keys
      .mockResolvedValueOnce({ rowCount: 2 }); // buildRepoint UPDATE — both loser agents move

    const outcome = await mergeAiAgents(L, S);

    expect(outcome.moved).toBe(2);
    expect(outcome.dropped).toBe(0);
    expect(outcome.notes.join('\n')).toMatch(
      /ai_agents: cleared graduated supervised action keys on 1 agent\(s\) from the merged-away org — a survivor org must re-earn them \(evidence is leave-for-erasure\)/,
    );
    expect(executeMock).toHaveBeenCalledTimes(3);
  });

  it('produces no clear-keys note when no loser agent had supervised keys', async () => {
    executeMock
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 0 }) // nothing to clear
      .mockResolvedValueOnce({ rowCount: 1 });

    const outcome = await mergeAiAgents(L, S);

    expect(outcome.notes).toEqual([]);
  });

  it('leaves the disable-collision note unchanged and independent of the clear-keys note', async () => {
    executeMock
      .mockResolvedValueOnce({ rowCount: 1 }) // one collision disabled
      .mockResolvedValueOnce({ rowCount: 1 }) // one agent had keys cleared
      .mockResolvedValueOnce({ rowCount: 2 });

    const outcome = await mergeAiAgents(L, S);

    expect(outcome.notes).toHaveLength(2);
    expect(outcome.notes.join('\n')).toMatch(/ai_agents: disabled 1 agent/);
    expect(outcome.notes.join('\n')).toMatch(/ai_agents: cleared graduated supervised action keys on 1 agent/);
  });

  it('scopes the clear-keys UPDATE to the loser org only — partner-wide rows (org_id IS NULL) are never touched', async () => {
    executeMock
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 });

    await mergeAiAgents(L, S);

    // Call order: [0] disable-collision, [1] clear-supervised-keys, [2] buildRepoint.
    const clearKeysStatement = executeMock.mock.calls[1]?.[0] as SQL;
    const compiled = dialect.sqlToQuery(clearKeysStatement);

    // Pin the exact write shape — a wrong jsonb_set path, a wrong replacement
    // value, or a missing/relocated array-length guard must fail this test
    // even though it would still satisfy a loose `/supervisedActionKeys/`
    // match.
    expect(compiled.sql).toMatch(/jsonb_set\(coalesce\(act_assets,\s*'\{\}'::jsonb\)/);
    expect(compiled.sql).toMatch(/'\{supervisedActionKeys\}',\s*'\[\]'::jsonb\)/);
    expect(compiled.sql).toMatch(/jsonb_array_length\(coalesce\(act_assets\s*->\s*'supervisedActionKeys',\s*'\[\]'::jsonb\)\)\s*>\s*0/);
    expect(compiled.sql).toMatch(/org_id\s*=\s*\$1::uuid/);
    expect(compiled.params[0]).toBe(L);
    // The predicate must be an equality on the loser org, never an
    // `org_id IS NULL` branch that would reach partner-wide rows.
    expect(compiled.sql).not.toMatch(/org_id\s+is\s+null/i);
    expect(compiled.sql).not.toMatch(/partner_id/i);
  });

  it('clears keys on an agent the SAME call just disabled — the clear-keys UPDATE carries no disabled_at predicate', async () => {
    executeMock
      .mockResolvedValueOnce({ rowCount: 1 }) // disable-collision — this agent gets disabled
      .mockResolvedValueOnce({ rowCount: 1 }) // clear-supervised-keys — the SAME agent, disabled or not
      .mockResolvedValueOnce({ rowCount: 2 });

    const outcome = await mergeAiAgents(L, S);

    // Both the disable-count and the clear-count are 1 for what is, in the
    // real-Postgres case this models, the SAME row: a disabled agent's
    // graduated keys must still be cleared before the repoint, or the
    // survivor inherits an authority nobody on the survivor earned.
    expect(outcome.notes.join('\n')).toMatch(/disabled 1 agent/);
    expect(outcome.notes.join('\n')).toMatch(/cleared graduated supervised action keys on 1 agent/);

    const clearKeysStatement = executeMock.mock.calls[1]?.[0] as SQL;
    const compiled = dialect.sqlToQuery(clearKeysStatement);
    expect(compiled.sql).not.toMatch(/disabled_at/i);
  });
});
