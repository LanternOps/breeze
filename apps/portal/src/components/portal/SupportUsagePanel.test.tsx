// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SupportUsagePanel } from './SupportUsagePanel';

it('renders all buckets and never reveals another submitter title', () => {
  render(<SupportUsagePanel usage={{
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
  }} />);

  expect(screen.getByTestId('portal-support-usage-billed').textContent).toContain('60');
  expect(screen.getByTestId('portal-support-usage-contract').textContent).toContain('45');
  expect(screen.getByText('My printer')).toBeTruthy();
  expect(screen.getByText('Ticket #T-2')).toBeTruthy();
  expect(screen.queryByText('Another user secret title')).toBeNull();
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
