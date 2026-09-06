import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceEventLogViewer from './DeviceEventLogViewer';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const activity = (id: string, overrides: Partial<{ result: string }> = {}) => ({
  id,
  timestamp: new Date().toISOString(),
  action: 'device.update',
  message: `Event ${id}`,
  category: 'device',
  result: 'success',
  actor: { type: 'user', name: 'Ada', email: null },
  resource: { type: 'device', id: 'dev-1', name: 'host-1' },
  initiatedBy: 'manual',
  details: null,
  errorMessage: null,
  ipAddress: null,
  ...overrides,
});

function pageFromUrl(url: string): number {
  return Number(new URL(url, 'http://example.test').searchParams.get('page') ?? '1');
}

// #4834: the API caps the withTotal count at FEED_TOTAL_CAP and reports
// pagination.totalIsLowerBound instead of walking a device's whole audit
// history. This viewer is the only caller that renders a total (it always
// sends withTotal=true; DeviceActivityFeed does not and is untouched by this
// change) and must (a) show "10,000+" instead of an exact-looking number past
// the cap, and (b) let the tech keep paging past the cap when the last page
// came back full — the only signal there might be more.
describe('DeviceEventLogViewer — capped total (#4834)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the exact total when totalIsLowerBound is false', async () => {
    fetchWithAuthMock.mockResolvedValue(
      jsonResponse({
        data: [activity('e1'), activity('e2'), activity('e3')],
        pagination: { page: 1, limit: 50, total: 3, totalIsLowerBound: false },
      }),
    );
    render(<DeviceEventLogViewer deviceId="dev-1" />);
    const total = await screen.findByTestId('event-log-total');
    expect(total).toHaveTextContent('3');
    expect(total).not.toHaveTextContent('+');
  });

  it('renders "10,000+" instead of an exact number when totalIsLowerBound is true', async () => {
    fetchWithAuthMock.mockResolvedValue(
      jsonResponse({
        data: Array.from({ length: 50 }, (_, i) => activity(`e${i}`)),
        pagination: { page: 1, limit: 50, total: 10000, totalIsLowerBound: true },
      }),
    );
    render(<DeviceEventLogViewer deviceId="dev-1" />);
    const total = await screen.findByTestId('event-log-total');
    expect(total).toHaveTextContent('10,000+');
  });

  it('keeps Next enabled past the reported total when the last page came back full', async () => {
    fetchWithAuthMock.mockImplementation((url: string) => {
      const page = pageFromUrl(url);
      return Promise.resolve(
        jsonResponse({
          // Both pages come back full — the API can't say whether there is a
          // page 3, only that page 2 wasn't the end.
          data: Array.from({ length: 50 }, (_, i) => activity(`p${page}-${i}`)),
          pagination: { page, limit: 50, total: 100, totalIsLowerBound: true },
        }),
      );
    });
    render(<DeviceEventLogViewer deviceId="dev-1" />);
    await screen.findByTestId('event-log-total');
    const next = screen.getByTestId('event-log-next-page');
    expect(next).not.toBeDisabled();

    await userEvent.click(next);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(2));
    // page is now 2 === totalPages (ceil(100/50)); a plain page<totalPages
    // check would disable Next here. It must stay enabled because the
    // just-fetched page 2 came back full and totalIsLowerBound is true.
    await waitFor(() => expect(screen.getByTestId('event-log-next-page')).not.toBeDisabled());
  });

  it('disables Next once a page comes back partial, even when totalIsLowerBound is true', async () => {
    fetchWithAuthMock.mockImplementation((url: string) => {
      const page = pageFromUrl(url);
      const rows = page === 1 ? 50 : 20; // page 2 is the true end of the feed
      return Promise.resolve(
        jsonResponse({
          data: Array.from({ length: rows }, (_, i) => activity(`p${page}-${i}`)),
          pagination: { page, limit: 50, total: 100, totalIsLowerBound: true },
        }),
      );
    });
    render(<DeviceEventLogViewer deviceId="dev-1" />);
    await screen.findByTestId('event-log-total');
    await userEvent.click(screen.getByTestId('event-log-next-page'));
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('event-log-next-page')).toBeDisabled());
  });

  it('handles an empty page past the cap without an inverted range, and disables Next', async () => {
    // The true total lands exactly on a page-size boundary above the cap
    // (e.g. 10,050 with a 50-row page): the last full page (page 1 here)
    // still reports totalIsLowerBound, so Next stays enabled and the tech
    // pages to page 2, which is genuinely past the end and comes back empty.
    fetchWithAuthMock.mockImplementation((url: string) => {
      const page = pageFromUrl(url);
      const rows = page === 1 ? 50 : 0;
      return Promise.resolve(
        jsonResponse({
          data: Array.from({ length: rows }, (_, i) => activity(`p${page}-${i}`)),
          pagination: { page, limit: 50, total: 10000, totalIsLowerBound: true },
        }),
      );
    });
    render(<DeviceEventLogViewer deviceId="dev-1" />);
    await screen.findByTestId('event-log-total');
    await userEvent.click(screen.getByTestId('event-log-next-page'));
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(2));

    const status = await screen.findByTestId('event-log-pagination-status');
    // No inverted "10051–10050 of 10,000+" range on the empty page.
    await waitFor(() => expect(status).toHaveTextContent('No more activity'));
    expect(status).not.toHaveTextContent('–');
    await waitFor(() => expect(screen.getByTestId('event-log-next-page')).toBeDisabled());
  });
});

// #4405 follow-through: the API writes audit_logs.result = 'dispatched' for a
// just-dispatched patch/command. resultConfig had no 'dispatched' entry, so
// the unrecognized-result fallback (`resultConfig[activity.result] ??
// resultConfig.success`) badged a dispatched command "Success" — the exact
// symptom of #4223. Any other unrecognized result hit the same fallback.
describe('DeviceEventLogViewer — result badge (#4405 follow-through)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('labels a dispatched command "Dispatched", not "Success"', async () => {
    fetchWithAuthMock.mockResolvedValue(
      jsonResponse({
        data: [activity('e1', { result: 'dispatched' })],
        pagination: { page: 1, limit: 50, total: 1, totalIsLowerBound: false },
      }),
    );
    render(<DeviceEventLogViewer deviceId="dev-1" />);
    const badge = await screen.findByTestId('event-log-result-badge-e1');
    expect(badge).toHaveTextContent('Dispatched');
    expect(badge).not.toHaveTextContent('Success');
  });

  it('renders the raw result text for an unrecognized result instead of defaulting to "Success"', async () => {
    fetchWithAuthMock.mockResolvedValue(
      jsonResponse({
        data: [activity('e1', { result: 'quarantined' })],
        pagination: { page: 1, limit: 50, total: 1, totalIsLowerBound: false },
      }),
    );
    render(<DeviceEventLogViewer deviceId="dev-1" />);
    const badge = await screen.findByTestId('event-log-result-badge-e1');
    expect(badge).toHaveTextContent('quarantined');
    expect(badge).not.toHaveTextContent('Success');
  });
});
