// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { SupportUsageDto } from '@breeze/shared';
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
