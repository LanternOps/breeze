import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { aiDataPolicies } from './aiDataPolicies';

describe('ai_data_policies schema', () => {
  it('is dual-owner: both axes nullable, both value columns nullable', () => {
    expect(getTableName(aiDataPolicies)).toBe('ai_data_policies');
    const cols = getTableColumns(aiDataPolicies);
    expect(cols.orgId.notNull).toBe(false);
    expect(cols.partnerId.notNull).toBe(false);
    expect(cols.deviceFileReadLevel.notNull).toBe(false);
    expect(cols.toolOutputRetentionDays.notNull).toBe(false);
  });
});
