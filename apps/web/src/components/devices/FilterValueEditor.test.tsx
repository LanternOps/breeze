import { describe, expect, it } from 'vitest';
import type { FilterCondition, FilterFieldDefinition } from '@breeze/shared';

import { summarizeCondition } from './FilterValueEditor';

const statusField: FilterFieldDefinition = {
  key: 'status',
  label: 'Status',
  category: 'core',
  type: 'enum',
  operators: ['equals', 'notEquals', 'in', 'notIn'],
  enumValues: ['online', 'offline', 'maintenance', 'decommissioned', 'quarantined', 'updating', 'pending']
};

// #3987 fix wave 2: summarizeCondition / CHIP_VALUE_DISPLAY_OVERRIDES had no
// test at all, so nothing pinned the "Removed" chip-display override for
// `status = decommissioned`.
describe('summarizeCondition', () => {
  it('summarizes a single-value status=decommissioned condition as "Removed" (not the raw enum)', () => {
    const condition: FilterCondition = { field: 'status', operator: 'equals', value: 'decommissioned' };

    const summary = summarizeCondition(statusField, condition);

    expect(summary).toBe('Status is Removed');
    expect(summary).not.toContain('decommissioned');
  });

  it('applies the same override inside a multi-value (in) chip list', () => {
    const condition: FilterCondition = { field: 'status', operator: 'in', value: ['decommissioned', 'online'] };

    const summary = summarizeCondition(statusField, condition);

    expect(summary).toContain('Removed');
    expect(summary).not.toContain('decommissioned');
  });
});
