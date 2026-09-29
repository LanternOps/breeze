import { describe, expect, it } from 'vitest';
import { orgStatusEnum } from '../../db/schema';
import { isUsableOrgStatus } from '../tenantStatus';
import {
  parseSeriesRecipientRule,
  recipientRuleIsActive,
  SERIES_ELIGIBLE_ORG_STATUSES,
  seriesManagedRefusal,
} from './types';

describe('series eligibility', () => {
  it('SERIES_ELIGIBLE_ORG_STATUSES is exactly the statuses isUsableOrgStatus admits', () => {
    const usable = orgStatusEnum.enumValues.filter((status) => isUsableOrgStatus(status));
    expect([...SERIES_ELIGIBLE_ORG_STATUSES].sort()).toEqual([...usable].sort());
  });
});

describe('parseSeriesRecipientRule', () => {
  it('reads a stored rule', () => {
    expect(parseSeriesRecipientRule({ primaryContact: false, roles: ['billing', 'owner'] }))
      .toEqual({ primaryContact: false, roles: ['billing', 'owner'] });
  });
  it('fails closed to "nobody" on a malformed value (never the primary-contact default)', () => {
    for (const bad of [null, 'x', 42, [], { primaryContact: 'yes', roles: 'billing' }]) {
      expect(parseSeriesRecipientRule(bad)).toEqual({ primaryContact: false, roles: [] });
    }
  });
  it('drops non-string and blank roles and dedupes', () => {
    expect(parseSeriesRecipientRule({ primaryContact: true, roles: ['a', 3, ' ', 'a'] }))
      .toEqual({ primaryContact: true, roles: ['a'] });
  });
});

describe('recipientRuleIsActive', () => {
  it('is true for the primary-contact rule or any role', () => {
    expect(recipientRuleIsActive({ primaryContact: true, roles: [] })).toBe(true);
    expect(recipientRuleIsActive({ primaryContact: false, roles: ['billing'] })).toBe(true);
    expect(recipientRuleIsActive({ primaryContact: false, roles: [] })).toBe(false);
  });
});

describe('seriesManagedRefusal', () => {
  it('names the series and the two allowed ways out', () => {
    const body = seriesManagedRefusal('44444444-4444-4444-8444-444444444444');
    expect(body.error).toBe('series_managed');
    expect(body.seriesId).toBe('44444444-4444-4444-8444-444444444444');
    expect(body.message).toMatch(/multi-org report/i);
    expect(body.message).toMatch(/detach/i);
  });
});
