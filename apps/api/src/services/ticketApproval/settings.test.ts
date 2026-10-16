import { describe, it, expect } from 'vitest';
import { pickEffectiveTicketApprovalSettings, TICKET_APPROVAL_SETTINGS_DEFAULTS } from './settings';

describe('pickEffectiveTicketApprovalSettings', () => {
  const blank = { enabled: null, budgetTrigger: null, afterHoursTrigger: null, enforcement: null, requestTtlHours: null };

  it('falls back to defaults with no rows', () => {
    const r = pickEffectiveTicketApprovalSettings(undefined, undefined);
    expect(r.enabled).toEqual({ value: false, source: 'default' });
    expect(r.budgetTrigger).toEqual({ value: true, source: 'default' });
    expect(r.afterHoursTrigger).toEqual({ value: true, source: 'default' });
    expect(r.enforcement).toEqual({ value: 'soft', source: 'default' });
    expect(r.requestTtlHours).toEqual({ value: 72, source: 'default' });
    expect(TICKET_APPROVAL_SETTINGS_DEFAULTS).toEqual({
      enabled: false, budgetTrigger: true, afterHoursTrigger: true, enforcement: 'soft', requestTtlHours: 72,
    });
  });

  it('treats all-null rows as inherit, not as values', () => {
    const r = pickEffectiveTicketApprovalSettings(blank, blank);
    expect(r.enabled.source).toBe('default');
    expect(r.requestTtlHours.source).toBe('default');
  });

  it('org overrides partner per field; null inherits', () => {
    const partner = { ...blank, enabled: true, enforcement: 'hard' as const, requestTtlHours: 24 };
    const org = { ...blank, enforcement: 'soft' as const };
    const r = pickEffectiveTicketApprovalSettings(org, partner);
    expect(r.enabled).toEqual({ value: true, source: 'partner' });
    expect(r.enforcement).toEqual({ value: 'soft', source: 'org' });
    expect(r.requestTtlHours).toEqual({ value: 24, source: 'partner' });
    expect(r.budgetTrigger).toEqual({ value: true, source: 'default' });
  });

  it('org false beats partner true (false is a value, not inherit)', () => {
    const r = pickEffectiveTicketApprovalSettings(
      { ...blank, enabled: false, afterHoursTrigger: false },
      { ...blank, enabled: true, afterHoursTrigger: true },
    );
    expect(r.enabled).toEqual({ value: false, source: 'org' });
    expect(r.afterHoursTrigger).toEqual({ value: false, source: 'org' });
  });
});
