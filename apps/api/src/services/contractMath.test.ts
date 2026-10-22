import { describe, it, expect } from 'vitest';
import { addMonthsClamped, computePeriod, periodIndexFor, nextBillingDate, isExpired, addDaysISO, duePeriodStartFor, isWithinNoticeWindow, extendTermThrough, billingRunPeriods, isAutoRenewing, contractInTermForReporting, isPastEndForReporting } from './contractMath';

describe('addMonthsClamped', () => {
  it('preserves day-of-month when valid', () => {
    expect(addMonthsClamped('2026-01-15', 1)).toBe('2026-02-15');
    expect(addMonthsClamped('2026-01-15', 3)).toBe('2026-04-15');
  });
  it('clamps to last valid day on overflow', () => {
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsClamped('2028-01-31', 1)).toBe('2028-02-29'); // leap year
  });
  it('rolls the year', () => {
    expect(addMonthsClamped('2026-12-01', 1)).toBe('2027-01-01');
    expect(addMonthsClamped('2026-06-01', 12)).toBe('2027-06-01');
  });
});

describe('computePeriod', () => {
  it('period 0 starts at start_date', () => {
    expect(computePeriod('2026-07-01', 1, 0)).toEqual({ periodStart: '2026-07-01', periodEnd: '2026-08-01' });
  });
  it('quarterly steps by 3 months', () => {
    expect(computePeriod('2026-01-15', 3, 1)).toEqual({ periodStart: '2026-04-15', periodEnd: '2026-07-15' });
  });
  it('annual steps by 12', () => {
    expect(computePeriod('2026-01-01', 12, 2)).toEqual({ periodStart: '2028-01-01', periodEnd: '2029-01-01' });
  });
});

describe('periodIndexFor', () => {
  it('returns the index of the period containing a date', () => {
    expect(periodIndexFor('2026-07-01', 1, '2026-07-01')).toBe(0);
    expect(periodIndexFor('2026-07-01', 1, '2026-07-20')).toBe(0);
    expect(periodIndexFor('2026-07-01', 1, '2026-08-01')).toBe(1);
    expect(periodIndexFor('2026-07-01', 1, '2026-09-15')).toBe(2);
  });
  it('clamps to 0 before the start', () => {
    expect(periodIndexFor('2026-07-01', 1, '2026-06-01')).toBe(0);
  });
});

describe('nextBillingDate', () => {
  it('advance fires at period start', () => {
    expect(nextBillingDate({ startDate: '2026-07-01', intervalMonths: 1, billingTiming: 'advance', periodIndex: 0 })).toBe('2026-07-01');
    expect(nextBillingDate({ startDate: '2026-07-01', intervalMonths: 1, billingTiming: 'advance', periodIndex: 1 })).toBe('2026-08-01');
  });
  it('arrears fires at period end', () => {
    expect(nextBillingDate({ startDate: '2026-07-01', intervalMonths: 1, billingTiming: 'arrears', periodIndex: 0 })).toBe('2026-08-01');
  });
});

describe('isExpired', () => {
  it('true when period start is on/after end date', () => {
    expect(isExpired({ endDate: '2026-12-01', periodStart: '2026-12-01' })).toBe(true);
    expect(isExpired({ endDate: '2026-12-01', periodStart: '2027-01-01' })).toBe(true);
  });
  it('false when period start is before end date', () => {
    expect(isExpired({ endDate: '2026-12-01', periodStart: '2026-11-01' })).toBe(false);
  });
  it('false when no end date', () => {
    expect(isExpired({ endDate: null, periodStart: '2099-01-01' })).toBe(false);
  });
});

describe('addDaysISO', () => {
  it('adds and subtracts days across month/year boundaries (UTC)', () => {
    expect(addDaysISO('2026-07-01', -30)).toBe('2026-06-01');
    expect(addDaysISO('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysISO('2028-02-28', 1)).toBe('2028-02-29'); // leap
  });
});

describe('duePeriodStartFor', () => {
  it('advance ⇒ nextBillingAt itself', () => {
    expect(duePeriodStartFor('advance', '2027-07-01', 1)).toBe('2027-07-01');
  });
  it('arrears ⇒ nextBillingAt minus one interval', () => {
    expect(duePeriodStartFor('arrears', '2027-08-01', 1)).toBe('2027-07-01');
    expect(duePeriodStartFor('arrears', '2027-10-01', 3)).toBe('2027-07-01');
  });
});

describe('isWithinNoticeWindow', () => {
  it('true inside [endDate - noticeDays, endDate)', () => {
    expect(isWithinNoticeWindow('2026-06-15', '2026-07-01', 30)).toBe(true); // 16 days out
    expect(isWithinNoticeWindow('2026-06-01', '2026-07-01', 30)).toBe(true); // exactly at window start
  });
  it('false before the window and on/after endDate', () => {
    expect(isWithinNoticeWindow('2026-05-31', '2026-07-01', 30)).toBe(false);
    expect(isWithinNoticeWindow('2026-07-01', '2026-07-01', 30)).toBe(false);
  });
});

describe('extendTermThrough (#9243: the term renews ON end_date, never a billing interval early)', () => {
  it('rolls endDate by one term on the renewal day itself (end_date is exclusive)', () => {
    expect(extendTermThrough({ endDate: '2027-07-01', asOfISO: '2027-07-01', termMonths: 12 }))
      .toEqual({ newEndDate: '2028-07-01', renewed: true });
  });
  it('no-op the day before end_date, even when billing has already invoiced the final period', () => {
    expect(extendTermThrough({ endDate: '2027-07-01', asOfISO: '2027-06-30', termMonths: 12 }))
      .toEqual({ newEndDate: '2027-07-01', renewed: false });
  });
  it('catches up multiple terms after an outage (term < gap), one term at a time from the old end', () => {
    expect(extendTermThrough({ endDate: '2027-07-01', asOfISO: '2027-09-01', termMonths: 1 }))
      .toEqual({ newEndDate: '2027-10-01', renewed: true });
  });
  it('clamps month-end ends the same way successive single renewals would', () => {
    // 01-31 + 1 = 02-28; + 1 = 03-28 (addMonthsClamped from the previous end).
    expect(extendTermThrough({ endDate: '2027-01-31', asOfISO: '2027-03-01', termMonths: 1 }))
      .toEqual({ newEndDate: '2027-03-28', renewed: true });
  });
  it('never renews (and never spins) on a non-positive term', () => {
    expect(extendTermThrough({ endDate: '2027-07-01', asOfISO: '2027-08-01', termMonths: 0 }))
      .toEqual({ newEndDate: '2027-07-01', renewed: false });
    expect(extendTermThrough({ endDate: '2027-07-01', asOfISO: '2027-08-01', termMonths: -3 }))
      .toEqual({ newEndDate: '2027-07-01', renewed: false });
  });
});

describe('isAutoRenewing (#9243)', () => {
  it.each([
    [{ autoRenew: true, renewalTermMonths: 12 }, true],
    [{ autoRenew: true, renewalTermMonths: 1 }, true],
    [{ autoRenew: false, renewalTermMonths: 12 }, false],
    [{ autoRenew: true, renewalTermMonths: null }, false],
    [{ autoRenew: true, renewalTermMonths: 0 }, false],
  ])('%j -> %s', (c, expected) => {
    expect(isAutoRenewing(c)).toBe(expected);
  });
});

describe('billingRunPeriods (#9243: the one due/next period computation generateDueInvoice uses)', () => {
  const c = (over: Record<string, unknown>) => ({
    startDate: '2026-01-01', intervalMonths: 1, billingTiming: 'advance', nextBillingAt: '2026-12-01', ...over,
  }) as Parameters<typeof billingRunPeriods>[0];

  it('advance: bills the period starting at the pointer; next is the one after', () => {
    expect(billingRunPeriods(c({}))).toEqual({
      idx: 11,
      due: { periodStart: '2026-12-01', periodEnd: '2027-01-01' },
      next: { periodStart: '2027-01-01', periodEnd: '2027-02-01' },
    });
  });
  it('arrears: bills the period ending at the pointer', () => {
    expect(billingRunPeriods(c({ billingTiming: 'arrears', nextBillingAt: '2027-01-01' }))).toEqual({
      idx: 11,
      due: { periodStart: '2026-12-01', periodEnd: '2027-01-01' },
      next: { periodStart: '2027-01-01', periodEnd: '2027-02-01' },
    });
  });
  it('arrears never goes below period 0', () => {
    expect(billingRunPeriods(c({ billingTiming: 'arrears', nextBillingAt: '2026-01-01' })).idx).toBe(0);
  });
  it('walks month-end periods from the START date (03-31 monthly arrears, pointer 05-31 -> due 04-30)', () => {
    expect(billingRunPeriods(c({ startDate: '2026-03-31', billingTiming: 'arrears', nextBillingAt: '2026-05-31' })).due)
      .toEqual({ periodStart: '2026-04-30', periodEnd: '2026-05-31' });
  });
});

// The invariant that keeps the two code paths from drifting: once the renewal
// sweep has run on day D, the period billing is due to bill on D is never past
// end_date, for every billing shape. So billing's due-check can only meet an
// un-renewed auto-renew contract when the sweep did not run first.
describe('renewal sweep ⟹ billing never sees an expired due period (#9243 invariant)', () => {
  const shapes: { startDate: string; intervalMonths: number; billingTiming: 'advance' | 'arrears'; termMonths: number }[] = [];
  for (const startDate of ['2026-01-01', '2026-01-31', '2026-03-31', '2026-02-28'])
    for (const intervalMonths of [1, 3, 12])
      for (const billingTiming of ['advance', 'arrears'] as const)
        for (const termMonths of [1, 12])
          shapes.push({ startDate, intervalMonths, billingTiming, termMonths });

  // end_date on a period boundary, and inside a period (±10 days off it).
  it.each(shapes.flatMap((s) => [-10, 0, 10].map((offsetDays) => ({ ...s, offsetDays }))))('%j', ({ startDate, intervalMonths, billingTiming, termMonths, offsetDays }) => {
    const endDate = addDaysISO(addMonthsClamped(startDate, 12), offsetDays);
    for (let k = 0; k < 30; k++) {
      // Every pointer billing can produce (a period boundary), on its due day and up to 40 days late.
      const nextBillingAt = nextBillingDate({ startDate, intervalMonths, billingTiming, periodIndex: k });
      for (const lateDays of [0, 1, 15, 40]) {
        const today = addDaysISO(nextBillingAt, lateDays);
        const { newEndDate } = extendTermThrough({ endDate, asOfISO: today, termMonths });
        const { due } = billingRunPeriods({ startDate, intervalMonths, billingTiming, nextBillingAt });
        expect(isExpired({ endDate: newEndDate, periodStart: due.periodStart }), `${nextBillingAt} on ${today}`).toBe(false);
      }
    }
  });
});

import { advancePastClaimed, firstUnclaimedPeriodStart, todayISO } from './contractMath';

describe('todayISO (#4547 W03)', () => {
  it('is the UTC calendar date', () => {
    expect(todayISO(new Date('2026-10-06T23:59:59Z'))).toBe('2026-10-06');
    expect(todayISO(new Date('2026-10-07T00:00:00Z'))).toBe('2026-10-07');
  });
});

describe('firstUnclaimedPeriodStart — index C9 (#4547 W03)', () => {
  const c = (over: Record<string, unknown>) => ({
    status: 'active', startDate: '2026-06-01', intervalMonths: 1, billingTiming: 'advance', nextBillingAt: '2026-07-01', ...over,
  }) as Parameters<typeof firstUnclaimedPeriodStart>[0];

  it.each([
    ['active advance, added mid-June (June already claimed without the fee) -> NEXT period', c({}), '2026-07-01'],
    ['active arrears, added mid-June (June is billed at its end WITH the fee) -> period IN PROGRESS', c({ billingTiming: 'arrears' }), '2026-06-01'],
    ['active quarterly advance', c({ startDate: '2026-04-01', intervalMonths: 3, nextBillingAt: '2026-10-01' }), '2026-10-01'],
    ['active quarterly arrears', c({ startDate: '2026-04-01', intervalMonths: 3, billingTiming: 'arrears', nextBillingAt: '2026-10-01' }), '2026-07-01'],
    ['draft: provisional stamp is the first period', c({ status: 'draft', nextBillingAt: null }), '2026-06-01'],
    ['draft with a past start date is still its first period (activation re-stamps it)', c({ status: 'draft', startDate: '2025-01-01', nextBillingAt: null }), '2025-01-01'],
    ['draft ignores a stale pointer', c({ status: 'draft', nextBillingAt: '2026-09-01' }), '2026-06-01'],
    ['active with no pointer cannot be stamped', c({ nextBillingAt: null }), null],
    // S5: month-end starts. Periods of a 03-31 monthly contract: 03-31, 04-30, 05-31, 06-30 (each from the START date).
    ['03-31 monthly ARREARS, pointer 04-30: the period in progress starts 03-31 (duePeriodStartFor would say 03-30)', c({ startDate: '2026-03-31', billingTiming: 'arrears', nextBillingAt: '2026-04-30' }), '2026-03-31'],
    ['03-31 monthly ARREARS, pointer 05-31: period in progress starts 04-30', c({ startDate: '2026-03-31', billingTiming: 'arrears', nextBillingAt: '2026-05-31' }), '2026-04-30'],
    ['03-31 monthly ADVANCE, pointer 04-30: the next period', c({ startDate: '2026-03-31', nextBillingAt: '2026-04-30' }), '2026-04-30'],
  ])('%s', (_name, contract, expected) => {
    expect(firstUnclaimedPeriodStart(contract)).toBe(expected);
  });
});

describe('advancePastClaimed — pause -> resume lands the pointer on a claimed period (#4547 W03, I3)', () => {
  it.each([
    ['unclaimed candidate is returned as is', '2026-07-01', [], '2026-07-01'],
    ['one claimed period (June claimed before the pause) -> July', '2026-06-01', ['2026-06-01'], '2026-07-01'],
    ['two consecutive claimed periods -> August', '2026-06-01', ['2026-06-01', '2026-07-01'], '2026-08-01'],
    ['a claimed period later than the gap does not matter', '2026-06-01', ['2026-08-01'], '2026-06-01'],
  ])('%s', (_name, candidate, claimed, expected) => {
    expect(advancePastClaimed(candidate as string, new Set(claimed as string[]), '2026-06-01', 1)).toBe(expected);
  });

  it('walks month-end boundaries from the START date (03-31 contract)', () => {
    expect(advancePastClaimed('2026-03-31', new Set(['2026-03-31']), '2026-03-31', 1)).toBe('2026-04-30');
    expect(advancePastClaimed('2026-03-31', new Set(['2026-03-31', '2026-04-30']), '2026-03-31', 1)).toBe('2026-05-31');
  });
});

// #9220 (spec #9218 trap T8): `expired` does not mean ended. generateDueInvoice
// flips an ADVANCE contract to expired the moment it bills the final period, so
// "in term" for reporting is judged on the dates plus a billed covering period,
// never on the status alone.
describe('contractInTermForReporting (#9220)', () => {
  const annualAdvance = {
    status: 'active', billingTiming: 'advance' as const, intervalMonths: 12,
    startDate: '2026-01-01', endDate: '2027-01-01', nextBillingAt: '2027-01-01',
  };
  // What generateDueInvoice leaves behind after billing the only (final) period.
  const billedAndFlipped = { ...annualAdvance, status: 'expired', nextBillingAt: null };

  it('counts an active contract mid-term', () => {
    // Two-year term: after the first annual bill the pointer (2027-01-01) is still before end.
    expect(contractInTermForReporting({ ...annualAdvance, endDate: '2028-01-01' }, '2026-06-15', false)).toBe('active');
  });

  it('counts an advance contract flipped to expired by its final invoice while a billed period covers asOf', () => {
    expect(contractInTermForReporting(billedAndFlipped, '2026-01-01', true)).toBe('billed_final_term');
    expect(contractInTermForReporting(billedAndFlipped, '2026-06-15', true)).toBe('billed_final_term');
    expect(contractInTermForReporting(billedAndFlipped, '2026-12-31', true)).toBe('billed_final_term');
  });

  it('drops the billed final term on and after end_date (end_date is exclusive, like isExpired)', () => {
    expect(contractInTermForReporting(billedAndFlipped, '2027-01-01', true)).toBeNull();
    expect(contractInTermForReporting(billedAndFlipped, '2027-03-01', true)).toBeNull();
  });

  it('does not count an expired contract with no billed period covering asOf', () => {
    expect(contractInTermForReporting(billedAndFlipped, '2026-06-15', false)).toBeNull();
  });

  it('excludes a contract that has not started yet, whatever its status', () => {
    expect(contractInTermForReporting({ ...annualAdvance, startDate: '2026-11-01', nextBillingAt: '2026-11-01' }, '2026-10-18', false)).toBeNull();
    expect(contractInTermForReporting({ ...billedAndFlipped, startDate: '2026-11-01' }, '2026-10-18', true)).toBeNull();
  });

  it('excludes an active arrears contract whose term is over but whose last period is not yet billed', () => {
    const arrears = {
      status: 'active', billingTiming: 'arrears' as const, intervalMonths: 1,
      startDate: '2026-01-01', endDate: '2026-10-01', nextBillingAt: '2026-10-01',
    };
    expect(contractInTermForReporting(arrears, '2026-09-30', false)).toBe('active');
    expect(contractInTermForReporting(arrears, '2026-10-01', false)).toBeNull();
  });

  it('keeps the billing-pointer guard for active contracts (isPastEndForReporting)', () => {
    const pastPointer = { ...annualAdvance, endDate: '2026-07-31', nextBillingAt: '2026-07-01' , intervalMonths: 1 };
    // Next billed period starts 2026-07-01 < end → still billing → in term.
    expect(contractInTermForReporting(pastPointer, '2026-07-15', false)).toBe('active');
    // Pointer at/after end_date: billing will expire it, never bill it.
    const ended = { ...pastPointer, nextBillingAt: '2026-08-01' };
    expect(isPastEndForReporting(ended, '2026-07-15')).toBe(true);
    expect(contractInTermForReporting(ended, '2026-07-15', false)).toBeNull();
  });

  it('counts an ACTIVE auto-renew contract in its billed final period (pointer at end_date, #9243)', () => {
    // generateDueInvoice no longer expires an auto-renewing contract on its final
    // invoice: it stays active with the pointer at end_date until the sweep renews it.
    const finalTerm = { ...annualAdvance, intervalMonths: 1, nextBillingAt: '2027-01-01' };
    expect(isPastEndForReporting(finalTerm, '2026-12-15')).toBe(true);
    expect(contractInTermForReporting(finalTerm, '2026-12-15', true)).toBe('billed_final_term');
    expect(contractInTermForReporting(finalTerm, '2026-12-15', false)).toBeNull();
    expect(contractInTermForReporting(finalTerm, '2027-01-01', true)).toBeNull();
  });

  it('keeps an open-ended active contract in term', () => {
    expect(contractInTermForReporting({ ...annualAdvance, endDate: null, nextBillingAt: '2030-01-01' }, '2030-01-01', false)).toBe('active');
  });

  it('never counts paused, cancelled or draft contracts, even with a billed covering period', () => {
    for (const status of ['paused', 'cancelled', 'draft']) {
      expect(contractInTermForReporting({ ...annualAdvance, endDate: '2028-01-01', status }, '2026-06-15', true)).toBeNull();
    }
  });
});
