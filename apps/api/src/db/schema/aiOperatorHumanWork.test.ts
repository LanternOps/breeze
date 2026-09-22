/**
 * Recipe Library spec §5.3, wave E3 — the human-work link, asserted from the
 * DRIZZLE SCHEMA rather than from a live database so it fails in the unit job
 * (`Test API`) rather than only under `Integration Tests`.
 *
 * WHAT THIS FILE IS REALLY GUARDING is decision D1: ONE owning FK, and it is
 * the STEP's. The reverse pointer is provenance with no reference at all,
 * because `ticket_checklist_items.org_id` is re-stamped by both org movers
 * (services/ticketOrgMoveLockOrder.ts) while `ai_operator_task_steps.org_id`
 * is immutable task history — so a composite org FK in either direction would
 * abort a ticket org-move with 23503. If a later change adds a `.references()`
 * to `operatorStepId`, this suite is what says no.
 */
import { describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { ticketChecklistItems, ticketChecklistItemSourceEnum } from './ticketChecklists';
import { aiOperatorTaskSteps, AI_OPERATOR_TASK_EVENT_TYPES } from './aiOperatorTaskGraph';

describe('human-work link columns (recipe spec §5.3)', () => {
  it('the STEP carries the owning pointer at the checklist item', () => {
    const columns = getTableConfig(aiOperatorTaskSteps).columns.map((c) => c.name);
    expect(columns).toContain('checklist_item_id');
  });

  it('the step carries its own reminder clock, with a separate sent-stamp', () => {
    const columns = getTableConfig(aiOperatorTaskSteps).columns.map((c) => c.name);
    // Two columns, not one: the reconciler tick runs every 15 s, so without a
    // sent-stamp an overdue step would post a ticket comment four times a
    // minute for the life of the step.
    expect(columns).toContain('remind_after_at');
    expect(columns).toContain('reminded_at');
  });

  it('the checklist item carries the reverse pointer as PROVENANCE, with no FK', () => {
    const config = getTableConfig(ticketChecklistItems);
    expect(config.columns.map((c) => c.name)).toContain('operator_step_id');
    // Same ruling as source_template_item_id, for a stronger reason: after a
    // ticket org-move the two rows legitimately live in different orgs, so no
    // composite org FK is even expressible.
    const referencing = config.foreignKeys.flatMap((fk) =>
      fk.reference().columns.map((c) => c.name),
    );
    expect(referencing).not.toContain('operator_step_id');
    // Inline `.references()` on a column shows up here too.
    const inline = config.columns.filter((c) => c.name === 'operator_step_id');
    expect(inline).toHaveLength(1);
  });

  it('never gives the step link a COMPOSITE org FK — that would 23503 every ticket org-move', () => {
    const fks = getTableConfig(aiOperatorTaskSteps).foreignKeys;
    const linkFks = fks.filter((fk) =>
      fk.reference().columns.some((c) => c.name === 'checklist_item_id'),
    );
    expect(linkFks).toHaveLength(1);
    expect(linkFks[0]!.reference().columns).toHaveLength(1);
    expect(linkFks[0]!.onDelete).toBe('set null');
  });

  it('the pgEnum mirrors the shipped label order with operator_task appended', () => {
    expect([...ticketChecklistItemSourceEnum.enumValues]).toEqual([
      'manual', 'deliverable', 'checklist_template', 'operator_task',
    ]);
  });

  it('the schema copy of the event-type list carries human_work_unticked before task_settled', () => {
    const list = [...AI_OPERATOR_TASK_EVENT_TYPES];
    expect(list.at(-2)).toBe('human_work_unticked');
    expect(list.at(-1)).toBe('task_settled');
  });
});
