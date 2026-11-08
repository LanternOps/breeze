import { describe, expect, it } from 'vitest';
import type { WispState } from '@/stores/aiStore';
import { pickWispHeaderNotice } from './WispHeaderNotice';

type Wisp = NonNullable<WispState>;
const RESETS = '2099-01-01T00:00:00.000Z';
const wisp = (over: Partial<Wisp> = {}): Wisp => ({
  grantId: 'g-1', threadId: 't-1', scopeOrgId: null, focusOrgId: null, focusOrgName: null, status: 'active',
  expiresAt: '2027-01-01T00:00:00.000Z', summary: '', budgetCentsPerDay: 200, floorTickMinutes: 30, wideningAvailable: false,
  ...over,
});
const overBudget = { spentTodayCents: 250, budgetResetsAt: RESETS };
const everything = { wideningAvailable: true, showRefreshHint: true, creditsExhausted: true };

describe('pickWispHeaderNotice: one notice, by priority', () => {
  it.each([
    ['partner switch beats everything', wisp({ status: 'paused', pausedReason: 'partner_disabled', ...overBudget }), everything, 'systemPaused'],
    ['a system pause beats everything', wisp({ status: 'paused', pausedReason: 'grantor_suspended', ...overBudget }), everything, 'systemPaused'],
    ['a user pause beats budget, widening, the hint and credits', wisp({ status: 'paused', pausedReason: 'user_paused', ...overBudget }), everything, 'userPaused'],
    ['a pause whose reason is still being looked up still shows', wisp({ status: 'paused' }), everything, 'userPaused'],
    ['budget beats widening, the hint and credits', wisp(overBudget), everything, 'budget'],
    ['widening beats the hint and credits', wisp(), everything, 'widening'],
    ['the refresh hint beats credits', wisp(), { wideningAvailable: false, showRefreshHint: true, creditsExhausted: true }, 'refreshHint'],
    ['credits last', wisp(), { wideningAvailable: false, showRefreshHint: false, creditsExhausted: true }, 'credits'],
  ] as const)('%s', (_label, w, flags, kind) => {
    expect(pickWispHeaderNotice({ wisp: w, ...flags })).toBe(kind);
  });

  it('a healthy grant has no notice', () => {
    expect(pickWispHeaderNotice({ wisp: wisp({ spentTodayCents: 10, budgetResetsAt: RESETS }), wideningAvailable: false, showRefreshHint: false, creditsExhausted: false })).toBeNull();
  });

  it('spend without a reset instant is not enough for the budget notice (the meter needs both fields)', () => {
    expect(pickWispHeaderNotice({ wisp: wisp({ spentTodayCents: 250 }), wideningAvailable: false, showRefreshHint: false, creditsExhausted: false })).toBeNull();
  });
});
