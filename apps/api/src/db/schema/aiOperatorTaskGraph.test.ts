// apps/api/src/db/schema/aiOperatorTaskGraph.test.ts
import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import {
  AI_OPERATOR_ACCOUNT_PROVIDERS,
  AI_OPERATOR_STEP_KINDS,
  AI_OPERATOR_TARGET_KINDS,
  aiOperatorTaskEvents,
  aiOperatorTaskSteps,
  aiOperatorTaskTargetAccounts,
  aiOperatorTaskTargets,
} from './aiOperatorTaskGraph';

const names = (t: Parameters<typeof getTableColumns>[0]) =>
  Object.values(getTableColumns(t)).map((c) => c.name).sort();

describe('AI Operator task-graph Drizzle schema (recipe spec §5.1-§5.3)', () => {
  it('ai_operator_task_targets has exactly the spec columns', () => {
    expect(getTableName(aiOperatorTaskTargets)).toBe('ai_operator_task_targets');
    expect(names(aiOperatorTaskTargets)).toEqual([
      'contact_id', 'created_at', 'detached_at', 'detached_reason', 'device_id',
      'id', 'org_id', 'state', 'target_kind', 'target_label', 'target_ordinal',
      'task_id', 'ticket_id', 'updated_at',
    ]);
  });

  it('ai_operator_task_target_accounts splits the connection pointer by provider', () => {
    expect(getTableName(aiOperatorTaskTargetAccounts)).toBe('ai_operator_task_target_accounts');
    const cols = names(aiOperatorTaskTargetAccounts);
    expect(cols).toContain('m365_connection_id');
    expect(cols).toContain('google_connection_id');
    // A single polymorphic connection_id could reference neither table with a
    // real FK — that is how a cross-tenant connection pointer gets in.
    expect(cols).not.toContain('connection_id');
    expect(cols).toEqual([
      'created_at', 'external_id', 'google_connection_id', 'id',
      'm365_connection_id', 'org_id', 'principal_label', 'provider',
      'target_id', 'task_id', 'updated_at',
    ]);
  });

  it('ai_operator_task_steps carries step_kind and no checklist column (that is wave E3)', () => {
    expect(getTableName(aiOperatorTaskSteps)).toBe('ai_operator_task_steps');
    const cols = names(aiOperatorTaskSteps);
    expect(cols).toContain('step_kind');
    expect(cols).not.toContain('checklist_item_id');
  });

  it('ai_operator_task_events has NO jsonb column and NO update timestamp', () => {
    expect(getTableName(aiOperatorTaskEvents)).toBe('ai_operator_task_events');
    const cols = getTableColumns(aiOperatorTaskEvents);
    for (const column of Object.values(cols)) {
      expect(column.columnType).not.toBe('PgJsonb');
    }
    // Append-only: there is nothing to update, so there is no updated_at.
    expect(names(aiOperatorTaskEvents)).not.toContain('updated_at');
  });

  it('every org_id is NOT NULL (Shape 1, auto-discovered by the RLS contract)', () => {
    for (const table of [
      aiOperatorTaskTargets, aiOperatorTaskTargetAccounts,
      aiOperatorTaskSteps, aiOperatorTaskEvents,
    ]) {
      expect(getTableColumns(table).orgId.notNull).toBe(true);
    }
  });

  it('exports the CHECK value lists the migration constrains on', () => {
    expect([...AI_OPERATOR_TARGET_KINDS]).toEqual(['device', 'ticket', 'contact']);
    expect([...AI_OPERATOR_ACCOUNT_PROVIDERS]).toEqual(['m365', 'google']);
    expect(AI_OPERATOR_STEP_KINDS).toHaveLength(6);
  });
});
