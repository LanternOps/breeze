// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PortalHourBlockDto, SupportUsageDto } from '@breeze/shared';
import { SupportUsagePanel } from './SupportUsagePanel';

const usage: SupportUsageDto = {
  asOf: '2026-09-02T12:00:00Z',
  month: '2026-09',
  timezone: 'America/Denver',
  dataStatus: 'ok',
  totals: {
    billed: { minutes: 60, hours: 1 },
    toBeBilled: { minutes: 30, hours: 0.5 },
    coveredByContract: { minutes: 45, hours: 0.75 },
    pendingReview: { minutes: 15, hours: 0.25 },
  },
  tickets: [
    {
      ticketNumber: 'T-1',
      title: 'My printer',
      billedMinutes: 60,
      toBeBilledMinutes: 0,
      coveredByContractMinutes: 0,
      pendingReviewMinutes: 0,
    },
    {
      ticketNumber: 'T-2',
      title: null,
      billedMinutes: 0,
      toBeBilledMinutes: 30,
      coveredByContractMinutes: 45,
      pendingReviewMinutes: 15,
    },
  ],
};

it('renders all buckets and never reveals another submitter title', () => {
  render(<SupportUsagePanel usage={{ ...usage }} />);

  expect(screen.getByTestId('portal-support-usage-billed').textContent).toContain('60');
  expect(screen.getByTestId('portal-support-usage-contract').textContent).toContain('45');
  expect(screen.getByText('My printer')).toBeTruthy();
  expect(screen.getByText('Ticket #T-2')).toBeTruthy();
  expect(screen.queryByText('Another user secret title')).toBeNull();
});

it('names the period in plain English, not the API month key', () => {
  render(<SupportUsagePanel usage={{ ...usage }} />);

  const period = screen.getByTestId('portal-support-usage-period');
  expect(period.textContent).toBe('September 2026');
});

it('says so when the month is bucketed in UTC rather than the reader own zone', () => {
  render(<SupportUsagePanel usage={{ ...usage, timezone: 'UTC' }} />);

  expect(screen.getByTestId('portal-support-usage-period').textContent).toBe(
    'September 2026 (UTC)',
  );
});

it('labels every minute column so no figure is unexplained', () => {
  render(<SupportUsagePanel usage={{ ...usage }} />);

  const table = screen.getByTestId('portal-support-usage-tickets');
  expect(table.querySelector('thead')).toBeTruthy();
  const headers = Array.from(
    table.querySelectorAll('th[scope="col"]'),
  ).map((th) => th.textContent);
  expect(headers).toEqual([
    'Request',
    'Billed',
    'To be billed',
    'Covered',
    'Pending review',
  ]);
});

it('renders honest no-data copy', () => {
  render(<SupportUsagePanel usage={{
    asOf: '2026-09-02T12:00:00.000Z',
    month: '2026-09',
    timezone: 'UTC',
    dataStatus: 'no_data',
    totals: {
      billed: { minutes: 0, hours: 0 },
      toBeBilled: { minutes: 0, hours: 0 },
      coveredByContract: { minutes: 0, hours: 0 },
      pendingReview: { minutes: 0, hours: 0 },
    },
    tickets: [],
  }} />);
  expect(screen.getByTestId('portal-support-usage-empty').textContent).toContain(
    'No billable support time has been recorded this month',
  );
});

const hourBlock: PortalHourBlockDto = {
  periodStart: '2026-09-01', periodEnd: '2026-10-01', includedHours: 10, carriedInHours: 0,
  usedHours: 4, remainingHours: 6, overageHours: 0, overageRate: '150.00',
  currencyCode: 'USD', billingTiming: 'advance',
};

describe('Support hours card inside the panel (block hours W04)', () => {
  it('is hidden when no block is passed (flag off / no live block) — the table is untouched', () => {
    render(<SupportUsagePanel usage={{ ...usage }} />);
    expect(screen.queryByTestId('portal-hour-block')).toBeNull();
    expect(screen.getByTestId('portal-support-usage-tickets')).toBeTruthy();

    render(<SupportUsagePanel usage={{ ...usage }} hourBlock={null} />);
    expect(screen.queryByTestId('portal-hour-block')).toBeNull();
  });

  it('is shown above the usage table, with figures, when a block is passed', () => {
    render(<SupportUsagePanel usage={{ ...usage }} hourBlock={hourBlock} />);

    const card = screen.getByTestId('portal-hour-block');
    const table = screen.getByTestId('portal-support-usage-tickets');
    expect(card.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('portal-hour-block-used').textContent).toBe('4 of 10 hours used');
  });

  it('still shows the card on a month with no support time recorded', () => {
    render(
      <SupportUsagePanel
        hourBlock={hourBlock}
        usage={{
          ...usage, dataStatus: 'no_data',
          totals: {
            billed: { minutes: 0, hours: 0 }, toBeBilled: { minutes: 0, hours: 0 },
            coveredByContract: { minutes: 0, hours: 0 }, pendingReview: { minutes: 0, hours: 0 },
          },
          tickets: [],
        }}
      />,
    );
    expect(screen.getByTestId('portal-hour-block')).toBeTruthy();
    expect(screen.getByTestId('portal-support-usage-empty')).toBeTruthy();
  });

  it('shows a load failure notice instead of silently dropping the card', () => {
    render(<SupportUsagePanel usage={{ ...usage }} hourBlockError="Your support hours could not be loaded right now." />);
    expect(screen.getByText('Your support hours could not be loaded right now.')).toBeTruthy();
    expect(screen.queryByTestId('portal-hour-block')).toBeNull();
  });

  it('shows "Your support hours start <date>" for a block that has not started, and no card', () => {
    render(<SupportUsagePanel usage={{ ...usage }} hourBlockStartsOn="2026-12-01" />);
    expect(screen.getByTestId('portal-hour-block-starts').textContent).toContain('Dec 1, 2026');
    expect(screen.queryByTestId('portal-hour-block')).toBeNull();
  });

  it('adds covered / over rows only when those buckets have time', () => {
    const { unmount } = render(
      <SupportUsagePanel
        usage={{
          ...usage,
          totals: { ...usage.totals, coveredByBlock: { minutes: 90, hours: 1.5 }, overBlock: { minutes: 30, hours: 0.5 } },
        }}
        hourBlock={hourBlock}
      />,
    );
    expect(screen.getByTestId('portal-support-usage-block').textContent).toContain('90');
    expect(screen.getByTestId('portal-support-usage-block').textContent).toContain('Covered by your support hours');
    expect(screen.getByTestId('portal-support-usage-over-block').textContent).toContain('30');
    expect(screen.getByTestId('portal-support-usage-over-block').textContent).toContain('Over your support hours');
    unmount();

    render(
      <SupportUsagePanel
        usage={{
          ...usage,
          totals: { ...usage.totals, coveredByBlock: { minutes: 0, hours: 0 }, overBlock: { minutes: 0, hours: 0 } },
        }}
        hourBlock={hourBlock}
      />,
    );
    expect(screen.queryByTestId('portal-support-usage-block')).toBeNull();
    expect(screen.queryByTestId('portal-support-usage-over-block')).toBeNull();
  });

  it('keeps the existing five column headers when the flag is off (no block buckets)', () => {
    render(<SupportUsagePanel usage={{ ...usage }} hourBlock={hourBlock} />);
    const headers = Array.from(
      screen.getByTestId('portal-support-usage-tickets').querySelectorAll('th[scope="col"]'),
    ).map((th) => th.textContent);
    expect(headers).toEqual(['Request', 'Billed', 'To be billed', 'Covered', 'Pending review']);
  });

  it('adds a per-ticket Support hours column (covered, plus how much is over) when the flag is on', () => {
    render(
      <SupportUsagePanel
        usage={{
          ...usage,
          totals: { ...usage.totals, coveredByBlock: { minutes: 150, hours: 2.5 }, overBlock: { minutes: 60, hours: 1 } },
          tickets: [
            { ...usage.tickets[0]!, coveredByBlockMinutes: 120, overBlockMinutes: 0 },
            { ...usage.tickets[1]!, coveredByBlockMinutes: 30, overBlockMinutes: 60 },
          ],
        }}
        hourBlock={hourBlock}
      />,
    );
    const table = screen.getByTestId('portal-support-usage-tickets');
    const headers = Array.from(table.querySelectorAll('th[scope="col"]')).map((th) => th.textContent);
    expect(headers).toEqual(['Request', 'Billed', 'To be billed', 'Covered', 'Support hours', 'Pending review']);
    expect(screen.getByTestId('portal-support-usage-ticket-T-1').textContent).toContain('120 min');
    const second = screen.getByTestId('portal-support-usage-ticket-T-2').textContent ?? '';
    expect(second).toContain('30 min');
    expect(second).toContain('+ 60 over');
  });
});
