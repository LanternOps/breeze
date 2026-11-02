import '@/lib/i18n';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
    fireEvent.click(screen.getByTestId('analytics-custom-range-apply'));

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

/** Every request the page has made so far, of any path. */
const requestCount = () => fetchMock.mock.calls.length;

/** Lets any wrongly scheduled effect or timer fire before a "nothing happened" assertion. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 50));

/** Switch the picker to Custom range and wait for that one load round to finish. */
const switchToCustom = async () => {
  await waitFor(() => expect(queriesFor('/metrics/trends')).toHaveLength(1));
  fireEvent.change(screen.getByRole('combobox', { name: 'Date range' }), { target: { value: 'custom' } });
  await waitFor(() => expect(queriesFor('/metrics/trends')).toHaveLength(2));
  await screen.findByText(/^Updated /);
  await flush();
};

// #9942: every keystroke in a custom-range date input reloaded every card
// (~9 requests). Edits are now a draft; only Apply (or Enter) loads a range.
describe('AnalyticsPage custom range is applied explicitly (#9942)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => okResponse());
  });

  it('switching to Custom range loads the seeded window exactly once', async () => {
    render(<AnalyticsPage />);
    await switchToCustom();

    expect(queriesFor('/metrics/trends')).toHaveLength(2);
    const seeded = queriesFor('/metrics/trends').at(-1);
    expect(seeded?.get('startDate')).toBe((screen.getByLabelText('Start date') as HTMLInputElement).value);
    expect(seeded?.get('endDate')).toBe((screen.getByLabelText('End date') as HTMLInputElement).value);
  });

  it('editing either date fires no request until Apply, then exactly one load round', async () => {
    render(<AnalyticsPage />);
    await switchToCustom();
    const before = requestCount();

    const start = screen.getByLabelText('Start date');
    const end = screen.getByLabelText('End date');
    for (const value of ['2026-01-01', '2026-01-02', '2026-01-03']) {
      fireEvent.change(start, { target: { value } });
    }
    for (const value of ['2026-01-29', '2026-01-30', '2026-01-31']) {
      fireEvent.change(end, { target: { value } });
    }
    fireEvent.blur(end);
    await flush();
    expect(requestCount()).toBe(before);

    fireEvent.click(screen.getByTestId('analytics-custom-range-apply'));
    await waitFor(() => expect(queriesFor('/metrics/trends')).toHaveLength(3));
    await flush();
    expect(queriesFor('/metrics/trends')).toHaveLength(3);
    const last = queriesFor('/metrics/trends').at(-1);
    expect(last?.get('startDate')).toBe('2026-01-03');
    expect(last?.get('endDate')).toBe('2026-01-31');
  });

  it('Enter in a date input (form submit) applies the range', async () => {
    render(<AnalyticsPage />);
    await switchToCustom();

    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-03-01' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-03-31' } });
    fireEvent.submit(screen.getByTestId('analytics-custom-range-form'));

    await waitFor(() => expect(queriesFor('/metrics/trends')).toHaveLength(3));
    expect(queriesFor('/metrics/trends').at(-1)?.get('startDate')).toBe('2026-03-01');
  });

  it('Apply is disabled for an unchanged or invalid draft, and submitting one sends nothing', async () => {
    render(<AnalyticsPage />);
    await switchToCustom();
    const apply = screen.getByTestId('analytics-custom-range-apply');
    expect(apply).toBeDisabled();

    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2000-01-01' } });
    expect(apply).toBeDisabled();
    expect(await screen.findByText(HINT)).toBeInTheDocument();

    const before = requestCount();
    fireEvent.submit(screen.getByTestId('analytics-custom-range-form'));
    await flush();
    expect(requestCount()).toBe(before);
  });

  it('Refresh reloads the applied range, not an unapplied draft', async () => {
    render(<AnalyticsPage />);
    await switchToCustom();
    const applied = queriesFor('/metrics/trends').at(-1);

    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-02-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(queriesFor('/metrics/trends')).toHaveLength(3));
    expect(queriesFor('/metrics/trends').at(-1)?.get('startDate')).toBe(applied?.get('startDate'));
  });

  it('submitting an unchanged draft sends nothing', async () => {
    render(<AnalyticsPage />);
    await switchToCustom();
    const before = requestCount();

    fireEvent.submit(screen.getByTestId('analytics-custom-range-form'));
    await flush();
    expect(requestCount()).toBe(before);
  });

  it('labels the button "Apply" and re-disables it once the edit is applied', async () => {
    render(<AnalyticsPage />);
    await switchToCustom();
    const apply = screen.getByRole('button', { name: 'Apply' });

    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-03-01' } });
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    expect(apply).toBeDisabled();
  });

  it('custom -> preset -> custom restores the applied range, drops unapplied edits, loads once per switch', async () => {
    render(<AnalyticsPage />);
    await switchToCustom();
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-03-01' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-03-31' } });
    fireEvent.click(screen.getByTestId('analytics-custom-range-apply'));
    await waitFor(() => expect(queriesFor('/metrics/trends')).toHaveLength(3));
    await flush();

    // An edit that is never applied.
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-03-15' } });

    const range = screen.getByRole('combobox', { name: 'Date range' });
    fireEvent.change(range, { target: { value: '30d' } });
    await waitFor(() => expect(queriesFor('/metrics/trends')).toHaveLength(4));
    const preset = queriesFor('/metrics/trends').at(-1);
    expect(preset?.get('range')).toBe('30d');
    expect(preset?.has('startDate')).toBe(false);
    await flush();

    fireEvent.change(range, { target: { value: 'custom' } });
    await waitFor(() => expect(queriesFor('/metrics/trends')).toHaveLength(5));
    await flush();
    expect(queriesFor('/metrics/trends')).toHaveLength(5);
    const restored = queriesFor('/metrics/trends').at(-1);
    expect(restored?.get('startDate')).toBe('2026-03-01');
    expect(restored?.get('endDate')).toBe('2026-03-31');
    expect(screen.getByLabelText('Start date')).toHaveValue('2026-03-01');
    expect(screen.getByLabelText('End date')).toHaveValue('2026-03-31');
    expect(screen.getByTestId('analytics-custom-range-apply')).toBeDisabled();
  });
});

const respondWithTrend = (trendData: Array<{ timestamp: string; value: number }>) => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    if (String(input).split('?')[0] !== '/analytics/executive-summary') return okResponse();
    const body = { data: { trendData, trendLabel: 'Weekly enrollments' } };
    return { ...okResponse(), text: async () => JSON.stringify(body), json: async () => body } as unknown as Response;
  });
};

// #9942 (second half): a fleet whose only recent enrollments fall in one week
// got "No data available" because the sparkline needs two points.
describe('AnalyticsPage weekly enrollments with a single week (#9942)', () => {
  // West of UTC, a UTC-midnight week bucket is the previous local evening;
  // the label must still name the bucket's own day.
  const originalTz = process.env.TZ;
  beforeAll(() => { process.env.TZ = 'America/Los_Angeles'; });
  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz;
  });

  it('renders the lone week instead of "No data available"', async () => {
    expect(new Date('2026-10-19T00:00:00.000Z').getTimezoneOffset()).toBeGreaterThan(0);
    respondWithTrend([{ timestamp: '2026-10-19T00:00:00.000Z', value: 5 }]);
    render(<AnalyticsPage />);
    const single = await screen.findByTestId('analytics-trend-single-week');
    expect(single).toHaveTextContent(/^5Week of Oct 19$/);
    expect(within(screen.getByTestId('analytics-trend-card')).queryByText('No data available')).not.toBeInTheDocument();
  });

  it('still says "No data available" for zero weeks', async () => {
    respondWithTrend([]);
    render(<AnalyticsPage />);
    await screen.findByText(/^Updated /);
    const card = screen.getByTestId('analytics-trend-card');
    expect(within(card).getByText('No data available')).toBeInTheDocument();
    expect(screen.queryByTestId('analytics-trend-single-week')).not.toBeInTheDocument();
  });

  it('draws the sparkline, not the single-week tile, for two or more weeks', async () => {
    respondWithTrend([
      { timestamp: '2026-10-12T00:00:00.000Z', value: 2 },
      { timestamp: '2026-10-19T00:00:00.000Z', value: 5 }
    ]);
    render(<AnalyticsPage />);
    await screen.findByText(/^Updated /);
    const card = screen.getByTestId('analytics-trend-card');
    await waitFor(() => expect(within(card).queryByText('No data available')).not.toBeInTheDocument());
    expect(screen.queryByTestId('analytics-trend-single-week')).not.toBeInTheDocument();
  });
});
