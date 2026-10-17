import { describe, expect, it } from 'vitest';
import type { FilterConditionGroup } from '@breeze/shared';

import { describeFilterConditions } from './filterMigration';
import { FILTER_FIELDS } from '../filters/filterFields';
import { customFieldToFilterField } from './filterFields';

const ASSET_DISPOSITION = customFieldToFilterField({
  id: 'cf-1',
  orgId: null,
  partnerId: 'p-1',
  name: 'Asset disposition',
  fieldKey: 'asset_disposition',
  type: 'dropdown',
  options: { choices: ['In service', 'Retired'] },
  required: false,
  defaultValue: null,
  deviceTypes: null,
});

const FILTER: FilterConditionGroup = {
  operator: 'AND',
  conditions: [
    { field: 'hostname', operator: 'contains', value: 'web' },
    {
      operator: 'OR',
      conditions: [
        { field: 'custom.asset_disposition', operator: 'equals', value: 'Retired' },
        { field: 'custom.asset_disposition', operator: 'isNull', value: '' },
      ],
    },
  ],
};

describe('describeFilterConditions — field labels (#8843)', () => {
  it('resolves custom.<key> conditions, including nested ones, to the definition name', () => {
    expect(describeFilterConditions(FILTER, [...FILTER_FIELDS, ASSET_DISPOSITION])).toEqual([
      'Hostname contains web',
      '(Asset disposition equals Retired OR Asset disposition is empty)',
    ]);
  });

  it('falls back to the raw key when the catalog has no matching field', () => {
    expect(describeFilterConditions(FILTER)).toEqual([
      'Hostname contains web',
      '(custom.asset_disposition equals Retired OR custom.asset_disposition is empty)',
    ]);
  });
});
