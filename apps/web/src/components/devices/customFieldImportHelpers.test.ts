import { describe, it, expect } from 'vitest';
import { generateFieldKey, guessFieldType, guessValueColumnRoles } from './customFieldImportHelpers';

describe('generateFieldKey', () => {
  it('splits camelCase before lowercasing', () => {
    expect(generateFieldKey('backupPlan')).toBe('backup_plan');
    expect(generateFieldKey('assetTag2Id')).toBe('asset_tag2_id');
  });
  it('keeps existing behaviour for spaced/odd labels', () => {
    expect(generateFieldKey('Backup Plan')).toBe('backup_plan');
    expect(generateFieldKey('udf7')).toBe('udf7');
    expect(generateFieldKey('2nd Monitor')).toBe('f_2nd_monitor');
    expect(generateFieldKey('###')).toBe('f_untitled');
  });
});

describe('guessFieldType', () => {
  it.each([
    ['Number', 'number'],
    ['integer', 'number'],
    ['Checkbox', 'boolean'],
    ['Boolean', 'boolean'],
    ['Date', 'date'],
    ['DateTime', 'date'],
    ['Drop-down', 'dropdown'],
    ['select', 'dropdown'],
    ['String', 'text'],
    ['', 'text'],
    ['weird', 'text'],
  ])('%s -> %s', (raw, expected) => {
    expect(guessFieldType(raw)).toBe(expected);
  });
});

describe('guessValueColumnRoles', () => {
  const known = [
    { fieldKey: 'backup_plan', name: 'Backup Plan' },
    { fieldKey: 'asset_owner', name: 'Owner of asset' },
  ];
  it('maps identifier headers', () => {
    const { roles } = guessValueColumnRoles(['Serial Number', 'Hostname', 'Device ID', 'Notes'], known);
    expect(roles['Serial Number']).toBe('identifier:serialNumber');
    expect(roles['Hostname']).toBe('identifier:hostname');
    expect(roles['Device ID']).toBe('identifier:deviceId');
    expect(roles['Notes']).toBeUndefined();
  });
  it('maps headers matching an existing field key or name to customField with that key', () => {
    const { roles, fieldKeys } = guessValueColumnRoles(['backupPlan', 'Owner of asset', 'asset_owner2'], known);
    expect(roles['backupPlan']).toBe('customField');
    expect(fieldKeys['backupPlan']).toBe('backup_plan');
    expect(roles['Owner of asset']).toBe('customField');
    expect(fieldKeys['Owner of asset']).toBe('asset_owner');
    expect(roles['asset_owner2']).toBeUndefined();
  });
  it('maps a field to at most one column and prefers a key match over a name match', () => {
    const { roles, fieldKeys } = guessValueColumnRoles(['Backup Plan', 'backup_plan'], known);
    // Both normalize to the same field; only one column may claim it, and the
    // header that IS the key wins over the one that merely matches the name.
    expect(roles['backup_plan']).toBe('customField');
    expect(fieldKeys['backup_plan']).toBe('backup_plan');
    expect(roles['Backup Plan']).toBeUndefined();
  });
  it('does not guess time/multiselect as date/dropdown', () => {
    expect(guessFieldType('time')).toBe('text');
    expect(guessFieldType('multiselect')).toBe('text');
  });
  it('claims each identifier once', () => {
    const { roles } = guessValueColumnRoles(['hostname', 'Host Name'], known);
    expect(roles['hostname']).toBe('identifier:hostname');
    expect(roles['Host Name']).toBeUndefined();
  });
});
