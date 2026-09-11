import { describe, expect, it } from 'vitest';
import { cadenceMonths, coveredPeriod, nthDueDate, planOccurrences, isInLeadWindow, isPastGrace } from './recurrence';

describe('recurrence', () => {
  it('maps cadence to months', () => {
    expect(cadenceMonths('monthly')).toBe(1);
    expect(cadenceMonths('quarterly')).toBe(3);
    expect(cadenceMonths('semiannual')).toBe(6);
    expect(cadenceMonths('annual')).toBe(12);
    expect(cadenceMonths('one_time')).toBeNull();
  });

  it('clamps a 31st anchor to month ends', () => {
    expect(nthDueDate('2026-01-31', 'monthly', 1)).toBe('2026-02-28');
    expect(nthDueDate('2026-01-31', 'monthly', 2)).toBe('2026-03-31');
    expect(nthDueDate('2026-01-31', 'quarterly', 1)).toBe('2026-04-30');
  });

  it('one_time has a single due date', () => {
    expect(nthDueDate('2026-06-01', 'one_time', 0)).toBe('2026-06-01');
    expect(nthDueDate('2026-06-01', 'one_time', 1)).toBeNull();
  });

  it('covered period ends on the due date and spans one cadence', () => {
    expect(coveredPeriod('2026-03-31', 'monthly')).toEqual({ periodStart: '2026-03-01', periodEnd: '2026-03-31' });
    expect(coveredPeriod('2026-06-30', 'quarterly')).toEqual({ periodStart: '2026-04-01', periodEnd: '2026-06-30' });
    expect(coveredPeriod('2026-06-01', 'one_time')).toEqual({ periodStart: '2026-06-01', periodEnd: '2026-06-01' });
  });

  it('plans only occurrences inside the lead window and effective range', () => {
    const plan = planOccurrences({
      anchorDueDate: '2026-10-31', cadence: 'monthly', effectiveFrom: '2026-10-01', effectiveUntil: null,
      leadDays: 7, graceDays: 14, today: '2026-10-25', existingDueDates: [],
    });
    expect(plan).toEqual([{ periodStart: '2026-10-01', periodEnd: '2026-10-31', dueAt: '2026-10-31', initialStatus: 'scheduled' }]);
  });

  it('skips due dates already materialized', () => {
    const plan = planOccurrences({
      anchorDueDate: '2026-10-31', cadence: 'monthly', effectiveFrom: '2026-10-01', effectiveUntil: null,
      leadDays: 7, graceDays: 14, today: '2026-11-25', existingDueDates: ['2026-10-31'],
    });
    expect(plan.map((p) => p.dueAt)).toEqual(['2026-11-30']);
  });

  it('marks catch-up occurrences past grace as missed and caps at 12', () => {
    const plan = planOccurrences({
      anchorDueDate: '2025-01-31', cadence: 'monthly', effectiveFrom: '2025-01-01', effectiveUntil: null,
      leadDays: 7, graceDays: 14, today: '2026-10-25', existingDueDates: [],
    });
    expect(plan).toHaveLength(12);
    expect(plan[0]!.dueAt).toBe('2025-01-31');
    expect(plan[0]!.initialStatus).toBe('missed');
  });

  it('stops at effective_until', () => {
    const plan = planOccurrences({
      anchorDueDate: '2026-10-31', cadence: 'monthly', effectiveFrom: '2026-10-01', effectiveUntil: '2026-11-15',
      leadDays: 30, graceDays: 14, today: '2026-12-01', existingDueDates: [],
    });
    expect(plan.map((p) => p.dueAt)).toEqual(['2026-10-31']);
  });

  it('never plans a due date before effective_from', () => {
    const plan = planOccurrences({
      anchorDueDate: '2026-01-31', cadence: 'monthly', effectiveFrom: '2026-06-01', effectiveUntil: null,
      leadDays: 7, graceDays: 14, today: '2026-06-28', existingDueDates: [],
    });
    expect(plan.map((p) => p.dueAt)).toEqual(['2026-06-30']);
  });

  it('window predicates', () => {
    expect(isInLeadWindow('2026-10-31', 7, '2026-10-24')).toBe(true);
    expect(isInLeadWindow('2026-10-31', 7, '2026-10-23')).toBe(false);
    expect(isPastGrace('2026-10-31', 14, '2026-11-14')).toBe(false);
    expect(isPastGrace('2026-10-31', 14, '2026-11-15')).toBe(true);
  });
});
