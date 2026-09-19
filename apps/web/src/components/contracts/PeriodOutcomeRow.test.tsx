/**
 * #3205 W07 — summary values cost no request; the full digests load on expand.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PeriodOutcomeRow from './PeriodOutcomeRow';
import * as api from '../../lib/api/contracts';
import type { ContractBillingPeriod } from '../../lib/api/contracts';

vi.mock('../../lib/api/contracts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api/contracts')>();
  return { ...actual, fetchPeriodOutcome: vi.fn() };
});

const fetchSpy = vi.mocked(api.fetchPeriodOutcome);
const period = (over: Partial<ContractBillingPeriod> = {}): ContractBillingPeriod => ({
  id: 'p1', contractId: 'c1', orgId: 'o1', periodStart: '2026-07-01', periodEnd: '2026-07-31', invoiceId: 'inv1',
  generatedAt: '2026-07-01T00:00:00.000Z', snapshotDeviceTotal: 12, uncoveredTotal: 0,
  flaggedTotal: 0, billedOverageTotal: 0, ...over,
});

describe('PeriodOutcomeRow (#3205 W07)', () => {
  beforeEach(() => {
    fetchSpy.mockReset();
    window.location.hash = '';
  });

  it('renders "Not recorded" for a pre-W07 period (null scalars) and does not expand', () => {
    render(<table><tbody><tr><PeriodOutcomeRow contractId="c1" orgId="o1" period={period({
      snapshotDeviceTotal: null, uncoveredTotal: null, flaggedTotal: null, billedOverageTotal: null,
    })} /></tr></tbody></table>);
    expect(screen.getByTestId('period-outcome-summary-p1').textContent).toContain('Not recorded');
    expect(screen.queryByTestId('period-outcome-toggle-p1')).toBeNull();
  });

  it('renders "No device lines" when snapshotDeviceTotal is 0', () => {
    render(<table><tbody><tr><PeriodOutcomeRow contractId="c1" orgId="o1" period={period({ snapshotDeviceTotal: 0 })} /></tr></tbody></table>);
    expect(screen.getByTestId('period-outcome-summary-p1').textContent).toContain('No device lines');
  });

  it('renders "All billed" when nothing was uncovered or flagged', () => {
    render(<table><tbody><tr><PeriodOutcomeRow contractId="c1" orgId="o1" period={period()} /></tr></tbody></table>);
    expect(screen.getByTestId('period-outcome-summary-p1').textContent).toContain('All billed');
  });

  it('renders the uncovered and flagged counts from the summary, with no fetch until expand', () => {
    render(<table><tbody><tr><PeriodOutcomeRow contractId="c1" orgId="o1" period={period({ snapshotDeviceTotal: 40, uncoveredTotal: 37, flaggedTotal: 3 })} /></tr></tbody></table>);
    const summary = screen.getByTestId('period-outcome-summary-p1').textContent!;
    expect(summary).toContain('37');
    expect(summary).toContain('3');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('expands to the full outcome, fetching once', async () => {
    fetchSpy.mockResolvedValue({ recorded: true, outcome: {
      contractBillingPeriodId: 'p1', invoiceId: 'inv1', snapshotDeviceTotal: 40,
      uncoveredTotal: 37, flaggedTotal: 3, billedOverageTotal: 0,
      uncoveredByRole: { printer: 37 },
      overages: [{ contractLineId: 'cl1', invoiceLineId: null, description: 'Endpoints', counted: 30, included: 27, overage: 3, mode: 'flag' }],
      generatedAt: '2026-07-01T00:00:00.000Z',
    } });
    render(<table><tbody><tr><PeriodOutcomeRow contractId="c1" orgId="o1" period={period({ snapshotDeviceTotal: 40, uncoveredTotal: 37, flaggedTotal: 3 })} /></tr></tbody></table>);
    await userEvent.click(screen.getByTestId('period-outcome-toggle-p1'));
    await waitFor(() => expect(screen.getByTestId('period-outcome-p1')).toBeTruthy());
    expect(screen.getByTestId('contract-coverage-warning')).toBeTruthy();
    expect(screen.getByTestId('contract-overage-flagged')).toBeTruthy();
    await userEvent.click(screen.getByTestId('period-outcome-toggle-p1'));
    await userEvent.click(screen.getByTestId('period-outcome-toggle-p1'));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('two rows stay independently expanded — expanding a second period does not force-close the first (hash isolation, #3205 W07 review)', async () => {
    fetchSpy.mockResolvedValue({ recorded: true, outcome: {
      contractBillingPeriodId: 'p', invoiceId: 'inv1', snapshotDeviceTotal: 10,
      uncoveredTotal: 0, flaggedTotal: 0, billedOverageTotal: 0,
      uncoveredByRole: {}, overages: [], generatedAt: '2026-07-01T00:00:00.000Z',
    } });
    render(
      <table><tbody>
        <tr><PeriodOutcomeRow contractId="c1" orgId="o1" period={period({ id: 'p1' })} /></tr>
        <tr><PeriodOutcomeRow contractId="c1" orgId="o1" period={period({ id: 'p2' })} /></tr>
      </tbody></table>,
    );
    await userEvent.click(screen.getByTestId('period-outcome-toggle-p1'));
    await waitFor(() => expect(screen.getByTestId('period-outcome-p1')).toBeTruthy());

    await userEvent.click(screen.getByTestId('period-outcome-toggle-p2'));
    await waitFor(() => expect(screen.getByTestId('period-outcome-p2')).toBeTruthy());

    // Expanding p2 must not have collapsed p1.
    expect(screen.getByTestId('period-outcome-p1')).toBeTruthy();
    expect(window.location.hash).toContain('p1');
    expect(window.location.hash).toContain('p2');

    // Collapsing p1 must leave p2 open.
    await userEvent.click(screen.getByTestId('period-outcome-toggle-p1'));
    await waitFor(() => expect(screen.queryByTestId('period-outcome-p1')).toBeNull());
    expect(screen.getByTestId('period-outcome-p2')).toBeTruthy();
  });

  it('renders an explicit "Not recorded" panel when the API returns recorded:false for an expandable period', async () => {
    fetchSpy.mockResolvedValue({ recorded: false, outcome: null });
    render(<table><tbody><tr><PeriodOutcomeRow contractId="c1" orgId="o1" period={period()} /></tr></tbody></table>);
    await userEvent.click(screen.getByTestId('period-outcome-toggle-p1'));
    await waitFor(() => expect(screen.getByTestId('period-outcome-not-recorded-p1')).toBeTruthy());
    expect(screen.getByTestId('period-outcome-not-recorded-p1').textContent).toContain('Not recorded');
  });

  it('surfaces a load failure with a discoverable testid', async () => {
    fetchSpy.mockRejectedValue(new Error('boom'));
    render(<table><tbody><tr><PeriodOutcomeRow contractId="c1" orgId="o1" period={period()} /></tr></tbody></table>);
    await userEvent.click(screen.getByTestId('period-outcome-toggle-p1'));
    await waitFor(() => expect(screen.getByTestId('period-outcome-error-p1')).toBeTruthy());
  });

  it('preserves an unrelated hash segment already present when opening/closing', async () => {
    window.location.hash = '#somethingElse';
    fetchSpy.mockResolvedValue({ recorded: true, outcome: {
      contractBillingPeriodId: 'p1', invoiceId: 'inv1', snapshotDeviceTotal: 10,
      uncoveredTotal: 0, flaggedTotal: 0, billedOverageTotal: 0,
      uncoveredByRole: {}, overages: [], generatedAt: '2026-07-01T00:00:00.000Z',
    } });
    render(<table><tbody><tr><PeriodOutcomeRow contractId="c1" orgId="o1" period={period()} /></tr></tbody></table>);
    await userEvent.click(screen.getByTestId('period-outcome-toggle-p1'));
    await waitFor(() => expect(screen.getByTestId('period-outcome-p1')).toBeTruthy());
    expect(window.location.hash).toContain('somethingElse');
    expect(window.location.hash).toContain('p1');

    await userEvent.click(screen.getByTestId('period-outcome-toggle-p1'));
    await waitFor(() => expect(screen.queryByTestId('period-outcome-p1')).toBeNull());
    expect(window.location.hash).toContain('somethingElse');
    expect(window.location.hash).not.toContain('periodOutcomes=');
  });
});
