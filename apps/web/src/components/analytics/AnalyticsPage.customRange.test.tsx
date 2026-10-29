import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AnalyticsPage from './AnalyticsPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);

const HINT = 'Choose a start and end date, start first and at most 366 days apart, to apply a custom range.';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;

const okResponse = (): Response =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => '{}',
    json: async () => ({})
  }) as unknown as Response;

/** The query string of every request to `path` (exact path match, query stripped). */
const queriesFor = (path: string) =>
  fetchMock.mock.calls
    .map(([input]) => String(input))
    .filter((url) => url.split('?')[0] === path)
    .map((url) => new URLSearchParams(url.split('?')[1] ?? ''));

// #9649: "Custom range" used to send no `range`, so the API silently served
// its 30-day default under a "Custom range" label.
describe('AnalyticsPage custom range (#9649)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => okResponse());
  });

  it('never requests the trend or capacity charts with neither a preset nor dates', async () => {
    render(<AnalyticsPage />);
    await waitFor(() => expect(queriesFor('/metrics/trends')).toHaveLength(1));

    fireEvent.change(screen.getByRole('combobox', { name: 'Date range' }), { target: { value: 'custom' } });

    await waitFor(() => expect(queriesFor('/metrics/trends').length).toBeGreaterThan(1));
    for (const path of ['/metrics/trends', '/analytics/capacity']) {
      for (const params of queriesFor(path)) {
        const hasPreset = params.has('range');
        const hasDates = params.has('startDate') && params.has('endDate');
        expect(hasPreset || hasDates, `${path}?${params.toString()}`).toBe(true);
      }
    }
  });

  it('sends the picked dates to the trend and capacity charts', async () => {
    render(<AnalyticsPage />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Date range' }), { target: { value: 'custom' } });

    fireEvent.change(await screen.findByLabelText('Start date'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-01-31' } });

    await waitFor(() => {
      for (const path of ['/metrics/trends', '/analytics/capacity']) {
        const last = queriesFor(path).at(-1);
        expect(last?.get('startDate')).toBe('2026-01-01');
        expect(last?.get('endDate')).toBe('2026-01-31');
        expect(last?.has('range')).toBe(false);
      }
    });
  });

  it('does not refetch an incomplete custom range and says why', async () => {
    render(<AnalyticsPage />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Date range' }), { target: { value: 'custom' } });
    const end = await screen.findByLabelText('End date');
    await waitFor(() => expect(queriesFor('/metrics/trends').length).toBeGreaterThan(1));
    const before = queriesFor('/metrics/trends').length;

    fireEvent.change(end, { target: { value: '' } });

    expect(await screen.findByText(HINT)).toBeInTheDocument();
    expect(queriesFor('/metrics/trends')).toHaveLength(before);
  });

  it.each([
    ['an end before the start', '2026-02-01', '2026-01-01'],
    ['a span over the API cap', '2025-01-01', '2026-01-31']
  ])('does not send %s', async (_label, start, end) => {
    render(<AnalyticsPage />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Date range' }), { target: { value: 'custom' } });
    const endInput = await screen.findByLabelText('End date');
    await waitFor(() => expect(queriesFor('/metrics/trends').length).toBeGreaterThan(1));
    const before = queriesFor('/metrics/trends').length;

    // End first: against the seeded start (today - 30) every end below is
    // already inverted, so no intermediate state is a valid range.
    fireEvent.change(endInput, { target: { value: end } });
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: start } });

    expect(await screen.findByText(HINT)).toBeInTheDocument();
    expect(queriesFor('/metrics/trends')).toHaveLength(before);
  });
});
