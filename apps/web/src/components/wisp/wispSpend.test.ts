import { describe, expect, it } from 'vitest';
import { atBudgetCeiling, canPause, canResume, hoursUntil, spendMeterState, systemPauseKind } from './wispSpend';

describe('spendMeterState (w00 A32)', () => {
  it('is ok below 80 %, warn from 80 %, exhausted at 100 %', () => {
    expect(spendMeterState(0, 200)).toBe('ok');
    expect(spendMeterState(159, 200)).toBe('ok');
    expect(spendMeterState(160, 200)).toBe('warn');
    expect(spendMeterState(199, 200)).toBe('warn');
    expect(spendMeterState(200, 200)).toBe('exhausted');
    expect(spendMeterState(260, 200)).toBe('exhausted');
  });

  it('treats a zero budget as exhausted, never as a divide-by-zero ok', () => {
    expect(spendMeterState(0, 0)).toBe('exhausted');
  });
});

describe('hoursUntil', () => {
  const now = new Date('2026-10-24T18:00:00.000Z');
  it('rounds up to whole hours and never goes negative', () => {
    expect(hoursUntil('2026-10-25T00:00:00.000Z', now)).toBe(6);
    expect(hoursUntil('2026-10-24T18:10:00.000Z', now)).toBe(1);
    expect(hoursUntil('2026-10-24T17:00:00.000Z', now)).toBe(0);
  });
  it('is null for an unparseable instant', () => {
    expect(hoursUntil('not-a-date', now)).toBeNull();
  });
});

describe('pause / resume gating (w00 A29)', () => {
  it('pauses only an active grant', () => {
    expect(canPause('active')).toBe(true);
    expect(canPause('paused')).toBe(false);
    expect(canPause('revoked')).toBe(false);
  });
  it('resumes only a grant the user paused', () => {
    expect(canResume('paused', 'user_paused')).toBe(true);
    expect(canResume('paused', 'entitlement_lapsed')).toBe(false);
    expect(canResume('paused', null)).toBe(false);
    expect(canResume('paused', undefined)).toBe(false);
    expect(canResume('active', 'user_paused')).toBe(false);
  });
});

describe('systemPauseKind (#10106)', () => {
  it('names the known system reasons', () => {
    for (const r of ['budget_exhausted', 'grantor_access_lost', 'grantor_suspended', 'factor_expired', 'entitlement_lost'] as const) {
      expect(systemPauseKind('paused', r)).toBe(r);
    }
  });

  it('has no system reason for a user pause, a partner switch, a pending lookup, or a live grant', () => {
    expect(systemPauseKind('paused', 'user_paused')).toBeNull();
    expect(systemPauseKind('paused', 'partner_disabled')).toBeNull();
    expect(systemPauseKind('paused', undefined)).toBeNull();
    expect(systemPauseKind('active', 'budget_exhausted')).toBeNull();
  });

  it('reads a null, unrecognised or prototype-key reason as unknown', () => {
    expect(systemPauseKind('paused', null)).toBe('unknown');
    expect(systemPauseKind('paused', 'entitlement_lapsed')).toBe('unknown');
    expect(systemPauseKind('paused', 'toString')).toBe('unknown');
    expect(systemPauseKind('paused', 'constructor')).toBe('unknown');
  });
});

describe('atBudgetCeiling (#10106)', () => {
  it('is true at or above the ceiling, false below it or when the ceiling is unknown', () => {
    expect(atBudgetCeiling(2500, 2500)).toBe(true);
    expect(atBudgetCeiling(2600, 2500)).toBe(true);
    expect(atBudgetCeiling(2499, 2500)).toBe(false);
    expect(atBudgetCeiling(2500, null)).toBe(false);
    expect(atBudgetCeiling(2500, undefined)).toBe(false);
  });
});
