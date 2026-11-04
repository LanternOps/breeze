import '@/lib/i18n';
import { describe, expect, it } from 'vitest';
import { FILTER_FIELDS } from '../filters/filterFields';
import { i18n } from '@/lib/i18n';
import { groupApiErrorMessage, partnerGroupFilterFields, partnerGroupFilterHasRefusedField } from './partnerGroups';

describe('partner group filters', () => {
  it('removes only unsupported field definitions', () => {
    const fields = partnerGroupFilterFields(FILTER_FIELDS);
    expect(fields.map((field) => field.key)).not.toContain('orgId');
    expect(fields.map((field) => field.key)).not.toContain('groupId');
    expect(fields).toContain(FILTER_FIELDS.find((field) => field.key === 'hostname'));
  });
  it.each(['orgId', 'groupId'])('rejects nested %s conditions', (field) => {
    expect(partnerGroupFilterHasRefusedField({ operator: 'AND', conditions: [{ operator: 'OR', conditions: [{ field, operator: 'equals', value: 'id' }] }] })).toBe(true);
  });
  it('accepts supported filters and absent filters', () => {
    expect(partnerGroupFilterHasRefusedField({ operator: 'AND', conditions: [{ field: 'hostname', operator: 'contains', value: 'orgId' }] })).toBe(false);
    expect(partnerGroupFilterHasRefusedField(null)).toBe(false);
  });
  it('prefers localized error codes and falls back to structured API details', () => {
    expect(groupApiErrorMessage({ code: 'PARTNER_GROUP_FILTER_UNSUPPORTED', error: 'raw' }, 'fallback')).toBe(i18n.t('errors:PARTNER_GROUP_FILTER_UNSUPPORTED'));
    expect(groupApiErrorMessage({ code: 'UNKNOWN_CODE', error: 'Specific failure' }, 'fallback')).toBe('Specific failure');
    expect(groupApiErrorMessage(null, 'fallback')).toBe('fallback');
  });
});
