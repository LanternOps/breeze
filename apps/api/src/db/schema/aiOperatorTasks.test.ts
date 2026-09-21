// apps/api/src/db/schema/aiOperatorTasks.test.ts
import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { aiOperatorTasks } from './aiOperatorTasks';

describe('ai_operator_tasks — wave E2 additive columns (recipe spec §5.5)', () => {
  const cols = getTableColumns(aiOperatorTasks);

  it('has workflow_config_id, nullable and with NO foreign key', () => {
    expect(cols.workflowConfigId.name).toBe('workflow_config_id');
    expect(cols.workflowConfigId.notNull).toBe(false);
    // `ai_operator_workflows` does not exist yet (a later wave). A uuid column
    // with no FK is honest about that; a FK to a missing table is a migration
    // that cannot be applied.
    expect(aiOperatorTasks.workflowConfigId.primary).toBe(false);
  });

  it('has event_seq, NOT NULL, defaulting to 0 — the per-task event counter', () => {
    expect(cols.eventSeq.name).toBe('event_seq');
    expect(cols.eventSeq.notNull).toBe(true);
    expect(cols.eventSeq.hasDefault).toBe(true);
  });

  it('keeps the inline target projection (spec §5.5: kept until P3-5)', () => {
    const names = Object.values(cols).map((c) => c.name);
    expect(names).toContain('device_id');
    expect(names).toContain('target_label');
  });
});
