import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceChangeHistoryTab from './DeviceChangeHistoryTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, ok = true): Response =>
  ({ ok, status: ok ? 200 : 500, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const change = (overrides: Record<string, unknown> = {}) => ({
  id: 'c1',
  deviceId: 'dev-1',
  hostname: 'host-1',
  timestamp: new Date('2026-07-01T12:00:00Z').toISOString(),
  changeType: 'software',
  changeAction: 'added',
  subject: 'Google Chrome',
  beforeValue: null,
  afterValue: { version: '120.0' },
  details: null,
  ...overrides,
});

const page = (changes: unknown[], hasMore = false, nextCursor: string | null = null) =>
  jsonResponse({ changes, total: changes.length, showing: changes.length, hasMore, nextCursor });

const lastUrl = () => String(fetchWithAuthMock.mock.calls.at(-1)![0]);

describe('DeviceChangeHistoryTab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('(a) shows the initial loading state before the first response resolves', () => {
    // Never-resolving promise keeps the component in its initial load.
    fetchWithAuthMock.mockReturnValue(new Promise<Response>(() => {}));
    render(<DeviceChangeHistoryTab deviceId="dev-1" />);
    expect(screen.getByTestId('change-history-loading')).toBeInTheDocument();
  });

  it('(b) renders rows from a mocked page and requests deviceId + limit', async () => {
    fetchWithAuthMock.mockResolvedValue(page([change()], true, 'abc'));
    render(<DeviceChangeHistoryTab deviceId="dev-1" />);
    expect(await screen.findByText('Google Chrome')).toBeInTheDocument();
    expect(screen.getByTestId('change-history-row')).toBeInTheDocument();
    const url = lastUrl();
    expect(url).toContain('deviceId=dev-1');
    expect(url).toContain('limit=100');
  });

  it('(c) shows the empty state when the page has no changes', async () => {
    fetchWithAuthMock.mockResolvedValue(page([]));
    render(<DeviceChangeHistoryTab deviceId="dev-1" />);
    expect(await screen.findByTestId('change-history-empty')).toBeInTheDocument();
  });

  it('(d) shows an error card and retries on a non-ok response', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(jsonResponse({}, false));
    render(<DeviceChangeHistoryTab deviceId="dev-1" />);
    expect(await screen.findByTestId('change-history-error')).toBeInTheDocument();

    // Retry re-issues the request; a good page clears the error.
    fetchWithAuthMock.mockResolvedValueOnce(page([change()]));
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Google Chrome')).toBeInTheDocument();
  });

  it('(e) refetches with changeType= in the URL when the type filter changes', async () => {
    fetchWithAuthMock.mockResolvedValue(page([change()]));
    render(<DeviceChangeHistoryTab deviceId="dev-1" />);
    await screen.findByText('Google Chrome');

    await userEvent.selectOptions(
      screen.getByTestId('change-history-type-filter'),
      'software',
    );
    await waitFor(() => expect(lastUrl()).toContain('changeType=software'));
  });

  it('(f) "Load more" issues a request containing cursor=abc and appends (keeps page 1)', async () => {
    // First page advertises another page via nextCursor='abc'.
    fetchWithAuthMock.mockResolvedValueOnce(page([change()], true, 'abc'));
    render(<DeviceChangeHistoryTab deviceId="dev-1" />);
    await screen.findByText('Google Chrome');

    fetchWithAuthMock.mockResolvedValueOnce(page([change({ id: 'c2', subject: 'Firefox' })]));
    await userEvent.click(screen.getByTestId('change-history-load-more'));
    await waitFor(() => expect(lastUrl()).toContain('cursor=abc'));
    expect(await screen.findByText('Firefox')).toBeInTheDocument();
    // Append must NOT replace the first page — a regression to replace-on-load-more fails here.
    expect(screen.getByText('Google Chrome')).toBeInTheDocument();
  });

  it('(g) a failed "Load more" surfaces an inline error and keeps loaded rows', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(page([change()], true, 'abc'));
    render(<DeviceChangeHistoryTab deviceId="dev-1" />);
    await screen.findByText('Google Chrome');

    fetchWithAuthMock.mockResolvedValueOnce(jsonResponse({}, false));
    await userEvent.click(screen.getByTestId('change-history-load-more'));

    // Inline, non-destructive error near the button; the full-screen error card
    // must NOT appear and the already-loaded row stays visible.
    expect(await screen.findByTestId('change-history-load-more-error')).toBeInTheDocument();
    expect(screen.queryByTestId('change-history-error')).toBeNull();
    expect(screen.getByText('Google Chrome')).toBeInTheDocument();
  });

  it('(h) a late "Load more" response after a filter change is dropped, not appended', async () => {
    // The append (cursor=abc) resolves only when we release it, AFTER a filter
    // change has superseded it with a fresh page 1.
    let releaseAppend!: (r: Response) => void;
    const appendPromise = new Promise<Response>((resolve) => {
      releaseAppend = resolve;
    });
    fetchWithAuthMock.mockImplementation((url: string) => {
      if (String(url).includes('cursor=abc')) return appendPromise;
      if (String(url).includes('changeType=network')) {
        return Promise.resolve(
          page([change({ id: 'c9', subject: 'Edge', changeType: 'network' })]),
        );
      }
      return Promise.resolve(page([change()], true, 'abc'));
    });

    render(<DeviceChangeHistoryTab deviceId="dev-1" />);
    await screen.findByText('Google Chrome');

    // Kick off the append (still in flight), then change the filter.
    await userEvent.click(screen.getByTestId('change-history-load-more'));
    await userEvent.selectOptions(
      screen.getByTestId('change-history-type-filter'),
      'network',
    );
    expect(await screen.findByText('Edge')).toBeInTheDocument();

    // Release the stale append; the generation guard must drop it.
    await act(async () => {
      releaseAppend(page([change({ id: 'c-stale', subject: 'StaleApp' })]));
    });
    expect(screen.queryByText('StaleApp')).toBeNull();
    expect(screen.getByText('Edge')).toBeInTheDocument();
    expect(screen.queryByText('Google Chrome')).toBeNull();
  });
});
