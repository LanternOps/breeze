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
const mergeReports = CUSTOM_EXECUTORS.reports!;
const mergeCustomFieldDefinitions = CUSTOM_EXECUTORS.custom_field_definitions!;

describe('mergeReports — dedupes portal self-service definitions and recipients', () => {
  afterEach(() => {
    executeMock.mockReset();
  });

  it('restricts portal collisions to flagged definitions and dedupes recipients before repointing them', async () => {
    executeMock
      .mockResolvedValueOnce({ rowCount: 0 }) // narrative report_runs re-home
      .mockResolvedValueOnce({ rowCount: 0 }) // narrative recipient delete
      .mockResolvedValueOnce({ rowCount: 0 }) // narrative recipient re-home
      .mockResolvedValueOnce({ rowCount: 0 }) // narrative duplicate delete
      .mockResolvedValueOnce({ rowCount: 1 }) // portal report_runs re-home
      .mockResolvedValueOnce({ rowCount: 1 }) // colliding recipient delete
      .mockResolvedValueOnce({ rowCount: 1 }) // non-colliding recipient re-home
      .mockResolvedValueOnce({ rowCount: 1 }) // portal duplicate delete
      .mockResolvedValueOnce({ rowCount: 2 }); // remaining reports repoint

    const outcome = await mergeReports(L, S);

    expect(outcome).toMatchObject({ moved: 2, dropped: 1 });
    expect(executeMock).toHaveBeenCalledTimes(9);

    const reportRunSql = dialect.sqlToQuery(executeMock.mock.calls[4]![0] as SQL).sql;
    const recipientDeleteSql = dialect.sqlToQuery(executeMock.mock.calls[5]![0] as SQL).sql;
    const recipientRepointSql = dialect.sqlToQuery(executeMock.mock.calls[6]![0] as SQL).sql;
    const reportDeleteSql = dialect.sqlToQuery(executeMock.mock.calls[7]![0] as SQL).sql;

    for (const statement of [reportRunSql, recipientDeleteSql, recipientRepointSql, reportDeleteSql]) {
      expect(statement).toMatch(/t\.portal_self_service\s*=\s*true/i);
      expect(statement).toMatch(/s\.portal_self_service\s*=\s*true/i);
    }
    expect(recipientDeleteSql).toMatch(/delete from "?report_schedule_recipients"?/i);
    expect(recipientDeleteSql).toMatch(/contact_id/i);
    expect(recipientRepointSql).toMatch(/update "?report_schedule_recipients"?/i);
    expect(outcome.notes.join('\n')).toMatch(/report_schedule_recipients: 1 deduplicated, 1 re-homed/);
  });

  it('dedupes and re-homes narrative recipients before deleting the duplicate definition', async () => {
    executeMock
      .mockResolvedValueOnce({ rowCount: 1 }) // narrative report_runs re-home
      .mockResolvedValueOnce({ rowCount: 1 }) // colliding narrative recipient delete
      .mockResolvedValueOnce({ rowCount: 2 }) // remaining narrative recipients re-home
      .mockResolvedValueOnce({ rowCount: 1 }) // narrative duplicate delete
      .mockResolvedValueOnce({ rowCount: 0 }) // portal report_runs re-home
      .mockResolvedValueOnce({ rowCount: 0 }) // portal recipient delete
      .mockResolvedValueOnce({ rowCount: 0 }) // portal recipient re-home
      .mockResolvedValueOnce({ rowCount: 0 }) // portal duplicate delete
      .mockResolvedValueOnce({ rowCount: 3 }); // remaining reports repoint

    const outcome = await mergeReports(L, S);

    expect(executeMock).toHaveBeenCalledTimes(9);
    const recipientDeleteSql = dialect.sqlToQuery(executeMock.mock.calls[1]![0] as SQL).sql;
    const recipientRepointSql = dialect.sqlToQuery(executeMock.mock.calls[2]![0] as SQL).sql;
    const reportDeleteSql = dialect.sqlToQuery(executeMock.mock.calls[3]![0] as SQL).sql;

    expect(recipientDeleteSql).toMatch(/delete from "?report_schedule_recipients"?/i);
    expect(recipientDeleteSql).toMatch(/source_ai_agent_schedule_id/i);
    expect(recipientDeleteSql).toMatch(/contact_id/i);
    expect(recipientRepointSql).toMatch(/update "?report_schedule_recipients"?/i);
    expect(recipientRepointSql).toMatch(/source_ai_agent_schedule_id/i);
    expect(reportDeleteSql).toMatch(/delete from "?reports"?/i);
    expect(outcome).toMatchObject({ moved: 3, dropped: 1 });
    expect(outcome.notes.join('\n')).toMatch(
      /report_schedule_recipients: 1 deduplicated, 2 re-homed/,
    );
  });
});

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

describe('mergeCustomFieldDefinitions — reconciles duplicate field_key instead of 23505 (#3257 W02)', () => {
  afterEach(() => {
    executeMock.mockReset();
  });

  it('re-homes stored values onto the survivor definition BEFORE deleting the loser (#3257 W05)', async () => {
    // The single most important ordering in this executor. `definition_id` is
    // `ON DELETE CASCADE`, so a dedupe DELETE that ran first would destroy every
    // value stored under the loser's definition. W05 registered
    // device_custom_field_values in CUSTOM_FIELD_DEFINITION_CHILDREN precisely
    // so `rehomeChildrenThenDelete` moves them first.
    executeMock
      .mockResolvedValueOnce({ rowCount: 4 })  // child re-home UPDATE
      .mockResolvedValueOnce({ rowCount: 1 })  // dedupe DELETE
      .mockResolvedValueOnce({ rowCount: 2 }); // buildRepoint UPDATE

    const outcome = await mergeCustomFieldDefinitions(L, S);

    const rehomeSql = dialect.sqlToQuery(executeMock.mock.calls[0]![0] as SQL).sql;
    expect(rehomeSql).toMatch(/update "?device_custom_field_values"?/i);
    expect(rehomeSql).toMatch(/"?definition_id"?\s*=\s*s\."?id"?/i);
    const deleteSqlOrder = dialect.sqlToQuery(executeMock.mock.calls[1]![0] as SQL).sql;
    expect(deleteSqlOrder).toMatch(/delete from "?custom_field_definitions"?/i);

    expect(outcome.notes.join('\n')).toMatch(/re-homed its stored values/);
    expect(outcome.notes.join('\n')).toMatch(/device_custom_field_values: 4/);
  });

  it('drops a loser definition whose field_key already exists under the survivor, and repoints the rest', async () => {
    executeMock
      .mockResolvedValueOnce({ rowCount: 0 })  // child re-home UPDATE (#3257 W05)
      .mockResolvedValueOnce({ rowCount: 1 })  // dedupe DELETE
      .mockResolvedValueOnce({ rowCount: 2 }); // buildRepoint UPDATE

    const outcome = await mergeCustomFieldDefinitions(L, S);

    expect(outcome).toMatchObject({ moved: 2, dropped: 1 });
    expect(executeMock).toHaveBeenCalledTimes(3);

    const deleteSql = dialect.sqlToQuery(executeMock.mock.calls[1]![0] as SQL).sql;
    expect(deleteSql).toMatch(/delete from "?custom_field_definitions"?/i);
    expect(deleteSql).toMatch(/field_key/i);

    const repointSql = dialect.sqlToQuery(executeMock.mock.calls[2]![0] as SQL).sql;
    expect(repointSql).toMatch(/update "?custom_field_definitions"?/i);

    expect(outcome.notes.join('\n')).toMatch(/custom_field_definitions: dropped 1 duplicate/);
  });

  it('produces no note when the two orgs share no field_key', async () => {
    executeMock
      .mockResolvedValueOnce({ rowCount: 0 }) // child re-home — nothing to move
      .mockResolvedValueOnce({ rowCount: 0 }) // nothing collides
      .mockResolvedValueOnce({ rowCount: 3 });

    const outcome = await mergeCustomFieldDefinitions(L, S);

    expect(outcome).toMatchObject({ moved: 3, dropped: 0 });
    expect(outcome.notes).toEqual([]);
  });

  /**
   * The DELETE must be targeted by org_id on BOTH sides. custom_field_definitions
   * is dual-axis (#2135): a partner-wide definition has org_id NULL and belongs
   * to every org under the partner. An org merge that reached those rows would
   * delete a definition shared across the partner's whole book of business
   * because two of its orgs happened to merge.
   */
  it('never targets partner-wide rows — the collision predicate is org_id-equality on both sides', async () => {
    executeMock
      .mockResolvedValueOnce({ rowCount: 0 }) // child re-home (#3257 W05)
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 0 });

    await mergeCustomFieldDefinitions(L, S);

    const compiled = dialect.sqlToQuery(executeMock.mock.calls[1]![0] as SQL);
    expect(compiled.sql).toMatch(/t\.org_id\s*=\s*\$\d+::uuid/i);
    expect(compiled.sql).toMatch(/s\.org_id\s*=\s*\$\d+::uuid/i);
    expect(compiled.sql).not.toMatch(/org_id\s+is\s+null/i);
    expect(compiled.sql).not.toMatch(/partner_id/i);
    expect(compiled.params).toContain(L);
    expect(compiled.params).toContain(S);
  });

  /**
   * Uniqueness is per-owner, so the dedupe key is field_key ALONE. Widening it
   * (e.g. to (field_key, type)) would leave two same-keyed definitions of
   * different types under the survivor and re-introduce the 23505 the
   * custom_field_definitions_org_key_uq index raises.
   */
  it('dedupes on field_key alone, not on type or name', async () => {
    executeMock
      .mockResolvedValueOnce({ rowCount: 0 }) // child re-home (#3257 W05)
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 0 });

    await mergeCustomFieldDefinitions(L, S);

    const compiled = dialect.sqlToQuery(executeMock.mock.calls[1]![0] as SQL);
    expect(compiled.sql).toMatch(/s\.field_key\s*=\s*t\.field_key/i);
    expect(compiled.sql).not.toMatch(/\btype\b/i);
    expect(compiled.sql).not.toMatch(/s\.name\s*=\s*t\.name/i);
  });
});
