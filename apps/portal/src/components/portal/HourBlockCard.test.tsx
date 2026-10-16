// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PortalHourBlockDto } from '@breeze/shared';
import { HourBlockCard, HourBlockStartsNotice } from './HourBlockCard';

const base: PortalHourBlockDto = {
  periodStart: '2026-12-01',
  periodEnd: '2027-01-01',
  includedHours: 10,
  carriedInHours: 0,
  usedHours: 6.5,
  remainingHours: 3.5,
  overageHours: 0,
  overageRate: '150.00',
  currencyCode: 'USD',
  billingTiming: 'advance',
};

describe('HourBlockStartsNotice', () => {
  it('says when the block starts instead of showing an empty balance', () => {
    render(<HourBlockStartsNotice startsOn="2026-12-01" />);
    expect(screen.getByTestId('portal-hour-block-starts').textContent).toContain('Your support hours start Dec 1, 2026.');
    expect(screen.queryByTestId('portal-hour-block')).toBeNull();
  });
});

describe('HourBlockCard', () => {
  it('shows used of total hours, the remainder and the inclusive period', () => {
    render(<HourBlockCard hourBlock={base} />);

    expect(screen.getByTestId('portal-hour-block-used').textContent).toBe('6.5 of 10 hours used');
    expect(screen.getByTestId('portal-hour-block-remaining').textContent).toBe('3.5 hours remaining');
    const period = screen.getByTestId('portal-hour-block-period').textContent ?? '';
    expect(period).toContain('Dec 1, 2026');
    // Half-open API end (Jan 1) is shown as the inclusive last day.
    expect(period).toContain('Dec 31, 2026');
    expect(period).not.toContain('Jan 1, 2027');
  });

  it('zero state: nothing used yet', () => {
    render(<HourBlockCard hourBlock={{ ...base, usedHours: 0, remainingHours: 10 }} />);

    expect(screen.getByTestId('portal-hour-block-used').textContent).toBe('0 of 10 hours used');
    expect(screen.getByTestId('portal-hour-block-remaining').textContent).toBe('10 hours remaining');
  });

  it('counts carried-over hours into the total and says so', () => {
    render(<HourBlockCard hourBlock={{ ...base, carriedInHours: 2, remainingHours: 5.5 }} />);

    expect(screen.getByTestId('portal-hour-block-used').textContent).toBe('6.5 of 12 hours used');
    expect(screen.getByTestId('portal-hour-block-carried').textContent)
      .toBe('Includes 2 hours carried over from last period');
  });

  it('singular hour wording', () => {
    render(<HourBlockCard hourBlock={{ ...base, includedHours: 1, usedHours: 0.5, remainingHours: 0.5 }} />);

    expect(screen.getByTestId('portal-hour-block-remaining').textContent).toBe('0.5 hours remaining');
    render(<HourBlockCard hourBlock={{ ...base, includedHours: 5, usedHours: 4, remainingHours: 1 }} />);
    expect(screen.getAllByTestId('portal-hour-block-remaining')[1]!.textContent).toBe('1 hour remaining');
  });

  it('over-block state names the overage and the contracted rate, never a computed amount', () => {
    render(<HourBlockCard hourBlock={{ ...base, usedHours: 12, remainingHours: 0, overageHours: 2 }} />);

    expect(screen.getByTestId('portal-hour-block-remaining').textContent).toBe('2 hours over your block');
    const note = screen.getByTestId('portal-hour-block-rate').textContent ?? '';
    expect(note).toContain('$150.00');
    expect(note).toContain('on the invoice for the following period');
    // 2 h x 150 = 300 must NOT be projected to the customer.
    expect(screen.getByTestId('portal-hour-block').textContent).not.toContain('300');
  });

  it('arrears wording ties overage to this period\'s invoice', () => {
    render(<HourBlockCard hourBlock={{ ...base, billingTiming: 'arrears' }} />);
    expect(screen.getByTestId('portal-hour-block-rate').textContent).toContain("on this period's invoice");
  });

  it('exposes progress accessibly and clamps the bar at 100%', () => {
    render(<HourBlockCard hourBlock={{ ...base, usedHours: 12, remainingHours: 0, overageHours: 2 }} />);

    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('100');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
  });
});
