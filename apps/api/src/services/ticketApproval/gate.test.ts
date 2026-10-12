import { describe, it, expect } from 'vitest';
import { evaluateApprovalGate, entryAmountMinor, type GateInput, type GateResult } from './gate';

const base = (): GateInput => ({
  settings: { enabled: true, budgetTrigger: true, afterHoursTrigger: true, enforcement: 'soft' },
  ticket: { budgetMinutes: 120, budgetAmount: null, budgetCurrencyCode: null },
  consumed: { minutes: 90, amountMinor: 0 },
  approvedExtensions: { minutes: 0, amountMinor: 0 },
  entry: {
    isBillable: true, coverage: 'billable', minutes: 30, hourlyRate: '100.00', currencyCode: 'USD',
    isAfterHoursWorkType: false,
  },
  afterHoursCovered: false,
  pendingBudgetRequest: false,
  operation: 'create_finished',
});
const w = (f: (i: GateInput) => void) => { const i = base(); f(i); return i; };
const amountBudget = (i: GateInput) => { i.ticket = { budgetMinutes: null, budgetAmount: '100.00', budgetCurrencyCode: 'USD' }; };
const hold = (trigger: 'budget' | 'after_hours', overMinutes = 0, overAmountMinor = 0): GateResult =>
  ({ kind: 'hold', trigger, overMinutes, overAmountMinor });

describe('evaluateApprovalGate', () => {
  it.each<[string, GateInput, GateResult]>([
    ['disabled policy passes', w(i => { i.settings.enabled = false; i.entry.minutes = 999; }), { kind: 'pass' }],
    ['exactly at ceiling passes', base(), { kind: 'pass' }],
    ['one minute over holds', w(i => { i.entry.minutes = 31; }), hold('budget', 1)],
    ['approved extension lifts ceiling', w(i => { i.entry.minutes = 60; i.approvedExtensions.minutes = 30; }), { kind: 'pass' }],
    ['non-billable never held', w(i => { i.entry.isBillable = false; i.entry.minutes = 999; }), { kind: 'pass' }],
    ['included coverage never held', w(i => { i.entry.coverage = 'included'; i.entry.minutes = 999; }), { kind: 'pass' }],
    ['no budget, no budget hold', w(i => { i.ticket.budgetMinutes = null; i.entry.minutes = 999; }), { kind: 'pass' }],
    ['budget trigger off', w(i => { i.settings.budgetTrigger = false; i.entry.minutes = 999; }), { kind: 'pass' }],
    ['amount ceiling: 0.30h at 100 over a 100.00 budget with 80.00 consumed holds 10.00', w(i => {
      amountBudget(i); i.consumed = { minutes: 0, amountMinor: 8000 }; i.entry.minutes = 18; }),
      hold('budget', 0, 1000)],
    ['amount ceiling exactly met passes', w(i => {
      amountBudget(i); i.consumed = { minutes: 0, amountMinor: 7000 }; i.entry.minutes = 18; }), { kind: 'pass' }],
    ['approved amount extension lifts the money ceiling', w(i => {
      amountBudget(i); i.consumed = { minutes: 0, amountMinor: 8000 }; i.entry.minutes = 18; i.approvedExtensions.amountMinor = 1000; }),
      { kind: 'pass' }],
    ['amount budget + missing rate holds (an unknown price cannot be shown to fit)', w(i => {
      amountBudget(i); i.consumed = { minutes: 0, amountMinor: 0 }; i.entry.hourlyRate = null; i.entry.minutes = 1; }),
      hold('budget')],
    ['amount budget + entry in another currency holds', w(i => {
      amountBudget(i); i.consumed = { minutes: 0, amountMinor: 0 }; i.entry.currencyCode = 'EUR'; i.entry.minutes = 1; }),
      hold('budget')],
    ['minute AND money ceilings: both overages are reported', w(i => {
      i.ticket = { budgetMinutes: 60, budgetAmount: '100.00', budgetCurrencyCode: 'USD' };
      i.consumed = { minutes: 60, amountMinor: 10000 }; i.entry.minutes = 6; }),
      hold('budget', 6, 1000)],
    ['after-hours uncovered holds before budget', w(i => { i.entry.isAfterHoursWorkType = true; i.entry.minutes = 999; }), hold('after_hours')],
    ['after-hours trigger off falls through to budget', w(i => {
      i.settings.afterHoursTrigger = false; i.entry.isAfterHoursWorkType = true; i.entry.minutes = 31; }), hold('budget', 1)],
    ['after-hours covered falls through to budget', w(i => {
      i.entry.isAfterHoursWorkType = true; i.afterHoursCovered = true; i.entry.minutes = 31; }), hold('budget', 1)],
    ['running timer (null minutes) never held at start in soft', w(i => {
      i.operation = 'start_timer'; i.entry.minutes = null; i.consumed.minutes = 500; }), { kind: 'pass' }],
    ['hard: start at ceiling refused', w(i => {
      i.settings.enforcement = 'hard'; i.operation = 'start_timer'; i.entry.minutes = null; i.consumed.minutes = 120; }),
      { kind: 'refuse', trigger: 'budget' }],
    ['hard: start under ceiling allowed', w(i => {
      i.settings.enforcement = 'hard'; i.operation = 'start_timer'; i.entry.minutes = null; i.consumed.minutes = 119; }),
      { kind: 'pass' }],
    ['hard: start at the money ceiling refused', w(i => {
      amountBudget(i); i.settings.enforcement = 'hard'; i.operation = 'start_timer'; i.entry.minutes = null;
      i.consumed = { minutes: 0, amountMinor: 10000 }; }),
      { kind: 'refuse', trigger: 'budget' }],
    ['hard: non-billable start at the ceiling allowed', w(i => {
      i.settings.enforcement = 'hard'; i.operation = 'start_timer'; i.entry.minutes = null; i.consumed.minutes = 500;
      i.entry.isBillable = false; }),
      { kind: 'pass' }],
    ['hard: start uncovered after-hours refused', w(i => {
      i.settings.enforcement = 'hard'; i.operation = 'start_timer'; i.entry.minutes = null; i.entry.isAfterHoursWorkType = true; }),
      { kind: 'refuse', trigger: 'after_hours' }],
    ['soft: start uncovered after-hours allowed (held at stop)', w(i => {
      i.operation = 'start_timer'; i.entry.minutes = null; i.entry.isAfterHoursWorkType = true; }), { kind: 'pass' }],
    ['hard mode never refuses a completed entry', w(i => { i.settings.enforcement = 'hard'; i.entry.minutes = 999; }), hold('budget', 969)],
    ['hard mode never refuses a stop', w(i => {
      i.settings.enforcement = 'hard'; i.operation = 'stop'; i.entry.minutes = 999; }), hold('budget', 969)],
    ['hard mode never refuses an update', w(i => {
      i.settings.enforcement = 'hard'; i.operation = 'update'; i.entry.minutes = 999; i.entry.isAfterHoursWorkType = true; }),
      hold('after_hours')],
    ['queue rule: pending request holds an entry that would fit', w(i => {
      i.pendingBudgetRequest = true; i.consumed.minutes = 0; i.entry.minutes = 5; }), hold('budget')],
    ['queue rule needs a budget: no ceiling, no queue', w(i => {
      i.pendingBudgetRequest = true; i.ticket.budgetMinutes = null; i.entry.minutes = 5; }), { kind: 'pass' }],
    ['queue rule: hard start refused while pending', w(i => {
      i.settings.enforcement = 'hard'; i.pendingBudgetRequest = true; i.operation = 'start_timer'; i.entry.minutes = null; i.consumed.minutes = 0; }),
      { kind: 'refuse', trigger: 'budget' }],
    ['queue rule: soft start allowed while pending', w(i => {
      i.pendingBudgetRequest = true; i.operation = 'start_timer'; i.entry.minutes = null; i.consumed.minutes = 0; }),
      { kind: 'pass' }],
    ['running timer edited onto after-hours work type is not held until stop', w(i => {
      i.operation = 'update'; i.entry.minutes = null; i.entry.isAfterHoursWorkType = true; }), { kind: 'pass' }],
    ['running timer over budget after an update is not held until stop', w(i => {
      i.operation = 'update'; i.entry.minutes = null; i.consumed.minutes = 500; }), { kind: 'pass' }],
  ])('%s', (_name, input, expected) => {
    expect(evaluateApprovalGate(input)).toEqual(expected);
  });
});

describe('entryAmountMinor', () => {
  it('uses the invoice quantity derivation (hours to 2 dp, one half-up round)', () => {
    // 20 min = 0.33h (toFixed(2)), not 0.3333h: 0.33 × 100.00 = 33.00
    expect(entryAmountMinor({ minutes: 20, hourlyRate: '100.00', currencyCode: 'USD' }, 'USD')).toBe(3300);
    // 7 min = 0.12h × 7.25 = 0.87
    expect(entryAmountMinor({ minutes: 7, hourlyRate: '7.25', currencyCode: 'USD' }, 'USD')).toBe(87);
  });
  it('is unknown (null) without a rate or in another currency', () => {
    expect(entryAmountMinor({ minutes: 20, hourlyRate: null, currencyCode: 'USD' }, 'USD')).toBeNull();
    expect(entryAmountMinor({ minutes: 20, hourlyRate: '1.00', currencyCode: 'EUR' }, 'USD')).toBeNull();
    expect(entryAmountMinor({ minutes: null, hourlyRate: '1.00', currencyCode: 'USD' }, 'USD')).toBeNull();
  });
  it('is currency-aware for zero-decimal currencies', () => {
    expect(entryAmountMinor({ minutes: 60, hourlyRate: '1000.00', currencyCode: 'JPY' }, 'JPY')).toBe(1000);
  });
});
