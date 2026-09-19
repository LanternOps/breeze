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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const executeMock = vi.fn();

vi.mock('../db', () => ({
  db: { execute: (...args: unknown[]) => executeMock(...args) },
}));

import { CUSTOM_EXECUTORS, CUSTOM_RESOLVE_EXECUTORS, CUSTOM_WOULD_DROP_COUNTS } from './orgMergeCustomExecutors';
import { getOrgMergePolicies } from './orgMergeRegistry';

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
      .mockResolvedValueOnce({ rowCount: 0 }) // fleet-design report_runs re-home
      .mockResolvedValueOnce({ rowCount: 0 }) // fleet-design recipient delete
      .mockResolvedValueOnce({ rowCount: 0 }) // fleet-design recipient re-home
      .mockResolvedValueOnce({ rowCount: 0 }) // fleet-design duplicate delete
      .mockResolvedValueOnce({ rowCount: 2 }); // remaining reports repoint

    const outcome = await mergeReports(L, S);

    expect(outcome).toMatchObject({ moved: 2, dropped: 1 });
    expect(executeMock).toHaveBeenCalledTimes(13);

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
      .mockResolvedValueOnce({ rowCount: 0 }) // fleet-design report_runs re-home
      .mockResolvedValueOnce({ rowCount: 0 }) // fleet-design recipient delete
      .mockResolvedValueOnce({ rowCount: 0 }) // fleet-design recipient re-home
      .mockResolvedValueOnce({ rowCount: 0 }) // fleet-design duplicate delete
      .mockResolvedValueOnce({ rowCount: 3 }); // remaining reports repoint

    const outcome = await mergeReports(L, S);

    expect(executeMock).toHaveBeenCalledTimes(13);
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

  it('dedupes ai_fleet_design definitions by type when both orgs have one', async () => {
    executeMock
      .mockResolvedValueOnce({ rowCount: 0 }) // narrative report_runs re-home
      .mockResolvedValueOnce({ rowCount: 0 }) // narrative recipient delete
      .mockResolvedValueOnce({ rowCount: 0 }) // narrative recipient re-home
      .mockResolvedValueOnce({ rowCount: 0 }) // narrative duplicate delete
      .mockResolvedValueOnce({ rowCount: 0 }) // portal report_runs re-home
      .mockResolvedValueOnce({ rowCount: 0 }) // portal recipient delete
      .mockResolvedValueOnce({ rowCount: 0 }) // portal recipient re-home
      .mockResolvedValueOnce({ rowCount: 0 }) // portal duplicate delete
      .mockResolvedValueOnce({ rowCount: 1 }) // fleet-design report_runs re-home
      .mockResolvedValueOnce({ rowCount: 1 }) // fleet-design colliding recipient delete
      .mockResolvedValueOnce({ rowCount: 1 }) // fleet-design non-colliding recipient re-home
      .mockResolvedValueOnce({ rowCount: 1 }) // fleet-design duplicate delete
      .mockResolvedValueOnce({ rowCount: 2 }); // remaining reports repoint

    const outcome = await mergeReports(L, S);

    expect(outcome).toMatchObject({ moved: 2, dropped: 1 });
    expect(executeMock).toHaveBeenCalledTimes(13);

    const reportRunSql = dialect.sqlToQuery(executeMock.mock.calls[8]![0] as SQL).sql;
    const recipientDeleteSql = dialect.sqlToQuery(executeMock.mock.calls[9]![0] as SQL).sql;
    const recipientRepointSql = dialect.sqlToQuery(executeMock.mock.calls[10]![0] as SQL).sql;
    const reportDeleteSql = dialect.sqlToQuery(executeMock.mock.calls[11]![0] as SQL).sql;

    for (const statement of [reportRunSql, recipientDeleteSql, recipientRepointSql, reportDeleteSql]) {
      expect(statement).toMatch(/t\.type\s*=\s*'ai_fleet_design'/i);
      expect(statement).toMatch(/s\.type\s*=\s*'ai_fleet_design'/i);
    }
    expect(recipientDeleteSql).toMatch(/delete from "?report_schedule_recipients"?/i);
    expect(recipientDeleteSql).toMatch(/contact_id/i);
    expect(recipientRepointSql).toMatch(/update "?report_schedule_recipients"?/i);
    expect(reportDeleteSql).toMatch(/delete from "?reports"?/i);
    expect(outcome.notes.join('\n')).toMatch(/Fleet Design/);
    expect(outcome.notes.join('\n')).toMatch(/report_schedule_recipients: 1 deduplicated, 1 re-homed/);
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
describe('m365 tenant sync merge disposition', () => {
  afterEach(() => {
    executeMock.mockReset();
  });

  it('classifies all seven tables, deleting snapshots and preserving history', () => {
    const policies = getOrgMergePolicies();
    for (const table of [
      'm365_sync_state', 'm365_users', 'm365_intune_devices',
      'm365_ca_policies', 'm365_license_skus',
    ]) {
      expect(policies.get(table)?.kind, `${table} must be custom`).toBe('custom');
      expect(CUSTOM_EXECUTORS[table], `${table} needs a move half`).toBeDefined();
      expect(CUSTOM_RESOLVE_EXECUTORS[table], `${table} needs a resolve half`).toBeDefined();
      expect(CUSTOM_WOULD_DROP_COUNTS[table], `${table} must be visible in the preview`).toBeDefined();
    }
    expect(policies.get('m365_secure_score_snapshots')).toEqual({
      kind: 'repoint-dedupe', key: ['score_date'],
    });
    expect(policies.get('m365_posture_rollups')).toEqual({
      kind: 'repoint-dedupe', key: ['rollup_date'],
    });
  });

  it('the resolve half deletes every loser-org row and the move half is a no-op', async () => {
    executeMock.mockResolvedValueOnce({ rowCount: 3 });

    const resolved = await CUSTOM_RESOLVE_EXECUTORS.m365_sync_state!(L, S);
    expect(resolved).toMatchObject({ moved: 0, dropped: 3 });

    const compiled = dialect.sqlToQuery(executeMock.mock.calls[0]![0] as SQL);
    expect(compiled.sql).toMatch(/delete from "?m365_sync_state"?/i);
    expect(compiled.sql).toMatch(/org_id\s*=/i);
    // Assert on the BOUND param, not on the SQL text — the org id is a
    // placeholder in the compiled statement, so a text-only assertion would
    // pass against a statement that deletes the survivor's rows.
    expect(compiled.params).toContain(L);

    const moved = await CUSTOM_EXECUTORS.m365_sync_state!(L, S);
    expect(moved).toEqual({ moved: 0, dropped: 0, notes: [] });
    expect(executeMock, 'the move half must issue no SQL').toHaveBeenCalledTimes(1);
  });
});

describe('moveAiRunArtifacts — split disposition by anchor (execution-plane W01)', () => {
  afterEach(() => {
    executeMock.mockReset();
  });

  it('re-points ONLY session-anchored rows, leaving run-anchored evidence with the loser shell', async () => {
    executeMock.mockResolvedValueOnce({ rowCount: 4 });

    const outcome = await CUSTOM_EXECUTORS.ai_run_artifacts!(L, S);

    expect(outcome).toMatchObject({ moved: 4, dropped: 0 });
    expect(executeMock, 'exactly one statement — the scoped repoint').toHaveBeenCalledTimes(1);

    const compiled = dialect.sqlToQuery(executeMock.mock.calls[0]![0] as SQL);
    expect(compiled.sql).toMatch(/update\s+ai_run_artifacts/i);
    // The anchor split IS the fix: without this predicate the statement would
    // also drag run-anchored rows off their immutable ai_agent_runs org and
    // 23503 the whole merge at COMMIT.
    expect(compiled.sql).toMatch(/run_id\s+is\s+null/i);
    expect(compiled.sql).not.toMatch(/run_id\s+is\s+not\s+null/i);
    // Bound params, not SQL text: a text-only assertion would pass against a
    // statement that moved rows the wrong way.
    expect(compiled.params).toContain(L);
    expect(compiled.params).toContain(S);
    // Survivor is the value being written, loser the row filter.
    expect(compiled.params.indexOf(S)).toBeLessThan(compiled.params.indexOf(L));
  });

  it('is registered as a custom policy, not leave-for-erasure', () => {
    expect(getOrgMergePolicies().get('ai_run_artifacts')?.kind).toBe('custom');
  });
});

// ============================================================================
// #5022 W01 Task 14 — script_executions detaches its AI origin on merge.
//
// It was a plain `repoint`. It still repoints org_id, but a merged execution
// must not keep pointing at an `ai_agent_runs` row: runs are
// `leave-for-erasure` (org_id is trigger-immutable), so the run stays with the
// loser shell and dies with it while the execution moves to the survivor.
//
// `ai_session_id` is NOT actually at risk here — `ai_sessions` is itself in
// REPOINT_TABLES and follows — but it is nulled together with the run id so
// merge and device-move behave identically and "the fact survives, the pointer
// does not" is ONE rule, not two. Do not "simplify" it back.
// ============================================================================
describe('script_executions merge policy detaches AI origin pointers (#5022 W01)', () => {
  afterEach(() => {
    executeMock.mockReset();
  });

  it('is classified custom, with a registered move executor', () => {
    const policies = getOrgMergePolicies();

    expect(policies.get('script_executions')).toMatchObject({ kind: 'custom' });
    expect(CUSTOM_EXECUTORS.script_executions).toBeTypeOf('function');
  });

  it('repoints org_id AND nulls both origin pointers in one statement', async () => {
    executeMock.mockResolvedValueOnce({ rowCount: 3 });

    const result = await CUSTOM_EXECUTORS.script_executions!(L, S);

    expect(executeMock).toHaveBeenCalledTimes(1);
    const sqlText = dialect.sqlToQuery(executeMock.mock.calls[0]![0] as SQL).sql.replace(/\s+/g, ' ');
    expect(sqlText).toMatch(/UPDATE script_executions/);
    expect(sqlText).toMatch(/set org_id =|SET org_id =/i);
    expect(sqlText).toMatch(/ai_session_id = NULL/i);
    expect(sqlText).toMatch(/ai_agent_run_id = NULL/i);
    // ai_initiator_kind is RETAINED.
    expect(sqlText).not.toMatch(/ai_initiator_kind\s*=\s*NULL/i);
    expect(result.moved).toBe(3);
    expect(result.dropped).toBe(0);
  });

  it('is NOT listed as an executor that never writes org_id — it does write it', () => {
    // Guards against a copy-paste into CUSTOM_EXECUTORS_THAT_NEVER_WRITE_ORG_ID
    // in orgMergeRegistry.integration.test.ts, which would suppress the
    // assertion that this executor re-tenants its rows at all.
    const src = readFileSync(
      fileURLToPath(new URL('./orgMergeCustomExecutors.ts', import.meta.url)),
      'utf8',
    ).replace(/\s+/g, ' ');

    expect(src).toMatch(/UPDATE script_executions SET org_id =/);
    expect(src).toMatch(/ai_agent_run_id = NULL/);
  });
});

/**
 * Tool catalog (#5215 / #5216). `tool_sources_org_slug_uq (org_id, slug)
 * WHERE org_id IS NOT NULL` means two orgs may each own a source with the same
 * slug; a plain repoint would violate it and abort the whole merge. Dropping
 * the loser's registration instead would silently remove a working integration
 * (and its enabled tools) with no signal, so the executor RENAMES on collision.
 * The rename has to carry into `tool_source_tools.qualified_name`, which
 * embeds the slug — otherwise the resolver would keep advertising a name that
 * no longer splits back to a real source.
 */
describe('mergeToolSources / mergeToolSourceTools', () => {
  afterEach(() => {
    executeMock.mockReset();
  });

  it('classifies both tables as custom with registered move executors', () => {
    const policies = getOrgMergePolicies();

    expect(policies.get('tool_sources')).toMatchObject({ kind: 'custom' });
    expect(policies.get('tool_source_tools')).toMatchObject({ kind: 'custom' });
    expect(CUSTOM_EXECUTORS.tool_sources).toBeTypeOf('function');
    expect(CUSTOM_EXECUTORS.tool_source_tools).toBeTypeOf('function');
  });

  it('renames a colliding slug, rewrites the child qualified names, then repoints', async () => {
    executeMock
      .mockResolvedValueOnce({ rowCount: 1 }) // slug rename
      .mockResolvedValueOnce({ rowCount: 4 }) // qualified_name rewrite
      .mockResolvedValueOnce({ rowCount: 2 }); // repoint

    const result = await CUSTOM_EXECUTORS.tool_sources!(L, S);

    expect(executeMock).toHaveBeenCalledTimes(3);
    const renameSql = dialect.sqlToQuery(executeMock.mock.calls[0]![0] as SQL).sql.replace(/\s+/g, ' ');
    expect(renameSql).toMatch(/UPDATE tool_sources/i);
    // Only on an actual collision under the survivor.
    expect(renameSql).toMatch(/EXISTS/i);
    // The suffix must stay inside tool_sources_slug_chk (^[a-z][a-z0-9]{1,23}$):
    // no underscore, no hyphen, and capped at 24 characters.
    expect(renameSql).not.toMatch(/\|\|\s*'_/);
    expect(renameSql).toMatch(/left\(/i);

    const qualifiedSql = dialect.sqlToQuery(executeMock.mock.calls[1]![0] as SQL).sql.replace(/\s+/g, ' ');
    expect(qualifiedSql).toMatch(/UPDATE tool_source_tools/i);
    expect(qualifiedSql).toMatch(/qualified_name/i);
    expect(qualifiedSql).toMatch(/name_not_addressable/);

    const repointSql = dialect.sqlToQuery(executeMock.mock.calls[2]![0] as SQL).sql.replace(/\s+/g, ' ');
    expect(repointSql).toMatch(/UPDATE "?tool_sources"? SET org_id =/i);

    expect(result.moved).toBe(2);
    expect(result.dropped).toBe(0);
    expect(result.notes.join(' ')).toMatch(/renamed 1/);
  });

  it('emits no note when nothing collided', async () => {
    executeMock
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rowCount: 5 });

    const result = await CUSTOM_EXECUTORS.tool_sources!(L, S);

    expect(result.moved).toBe(5);
    expect(result.notes).toEqual([]);
  });

  it('repoints tool_source_tools org_id so the owner guard still matches the parent', async () => {
    executeMock.mockResolvedValueOnce({ rowCount: 7 });

    const result = await CUSTOM_EXECUTORS.tool_source_tools!(L, S);

    expect(executeMock).toHaveBeenCalledTimes(1);
    const sqlText = dialect.sqlToQuery(executeMock.mock.calls[0]![0] as SQL).sql.replace(/\s+/g, ' ');
    expect(sqlText).toMatch(/UPDATE tool_source_tools/i);
    expect(sqlText).toMatch(/SET org_id =/i);
    expect(result.moved).toBe(7);
    expect(result.dropped).toBe(0);
  });
});
