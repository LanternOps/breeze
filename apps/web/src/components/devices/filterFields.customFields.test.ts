import { beforeEach, describe, expect, it } from 'vitest';
import {
  V2_FILTER_FIELDS,
  customFieldToFilterField,
  setCustomFilterFields,
  getAllFilterFields,
  getFieldDef
} from './filterFields';
import type { CustomFieldDefinition } from '../../stores/customFieldDefinitions';

const CUSTOM_DEF: CustomFieldDefinition = {
  id: 'cf-1',
  orgId: null,
  partnerId: 'p1',
  name: 'Windows Activation',
  fieldKey: 'bdr_windows_activation',
  type: 'text',
  options: null,
  required: false,
  defaultValue: null,
  deviceTypes: ['windows']
};

describe('custom filter fields (#6594)', () => {
  beforeEach(() => {
    setCustomFilterFields([]);
  });

  it('customFieldToFilterField maps to a custom.<key> field matching the backend-valid string operator set', () => {
    const field = customFieldToFilterField(CUSTOM_DEF);
    expect(field.key).toBe('custom.bdr_windows_activation');
    expect(field.label).toBe('Windows Activation');
    expect(field.category).toBe('custom');
    expect(field.type).toBe('string');
    expect(field.operators).toContain('equals');
    expect(field.operators).not.toContain('greaterThan');
  });

  it('getAllFilterFields returns only the static catalog before any custom fields load', () => {
    expect(getAllFilterFields()).toEqual(V2_FILTER_FIELDS);
  });

  it('getAllFilterFields includes cached custom fields once set', () => {
    setCustomFilterFields([customFieldToFilterField(CUSTOM_DEF)]);
    const fields = getAllFilterFields();
    expect(fields).toHaveLength(V2_FILTER_FIELDS.length + 1);
    expect(fields.find(f => f.key === 'custom.bdr_windows_activation')).toBeDefined();
  });

  it('getFieldDef resolves a custom.<key> field once cached (the filter chip label bug)', () => {
    expect(getFieldDef('custom.bdr_windows_activation')).toBeUndefined();
    setCustomFilterFields([customFieldToFilterField(CUSTOM_DEF)]);
    expect(getFieldDef('custom.bdr_windows_activation')?.label).toBe('Windows Activation');
  });
});
