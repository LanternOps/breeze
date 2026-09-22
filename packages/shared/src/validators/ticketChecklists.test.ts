/**
 * Recipe Library spec §5.3: `ticket_checklist_items.source` gains a fourth
 * value, `operator_task`.
 *
 * Asserted as an ORDERED list of VALUES, not merely as a type: this array is
 * the single source for the `ticket_checklist_item_source` pgEnum
 * (apps/api/src/db/schema/ticketChecklists.ts), for the API's zod validation,
 * and for the web badge. A type-only union cannot be diffed against the
 * database label list that migration A adds.
 *
 * ORDER MATTERS AND IS APPEND-ONLY. Postgres enum labels have an ordinal, and
 * `ALTER TYPE ... ADD VALUE` without BEFORE/AFTER appends. Re-ordering this
 * array would make the Drizzle pgEnum declaration disagree with the shipped
 * type's label order, which `db:check-drift` reports and which no unit test
 * would otherwise catch.
 */
import { describe, expect, it } from 'vitest';
import { CHECKLIST_ITEM_SOURCES, checklistItemSourceSchema } from './ticketChecklists';

describe('CHECKLIST_ITEM_SOURCES (recipe spec §5.3)', () => {
  it('is exactly the four shipped values, with operator_task appended last', () => {
    expect([...CHECKLIST_ITEM_SOURCES]).toEqual([
      'manual',
      'deliverable',
      'checklist_template',
      'operator_task',
    ]);
  });

  it('accepts operator_task through the zod schema', () => {
    expect(checklistItemSourceSchema.parse('operator_task')).toBe('operator_task');
  });

  it('still rejects anything else', () => {
    expect(() => checklistItemSourceSchema.parse('operator')).toThrow();
  });
});
