import { render, screen, waitFor } from '@testing-library/react';
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

  it('(f) "Load more" issues a request containing cursor=abc', async () => {
    // First page advertises another page via nextCursor='abc'.
    fetchWithAuthMock.mockResolvedValueOnce(page([change()], true, 'abc'));
    render(<DeviceChangeHistoryTab deviceId="dev-1" />);
    await screen.findByText('Google Chrome');

    fetchWithAuthMock.mockResolvedValueOnce(page([change({ id: 'c2', subject: 'Firefox' })]));
    await userEvent.click(screen.getByTestId('change-history-load-more'));
    await waitFor(() => expect(lastUrl()).toContain('cursor=abc'));
    expect(await screen.findByText('Firefox')).toBeInTheDocument();
  });
});
