import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import { fetchWithAuth } from '@/stores/auth';
import CleanupRunHistory from './CleanupRunHistory';

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const run = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'files',
  status: 'executed',
  scanPath: 'C:\\',
  requestedAt: '2026-09-19T10:00:00.000Z',
  approvedAt: '2026-09-19T10:01:00.000Z',
  bytesReclaimed: 2048,
  error: null,
  candidateCount: 3,
  estimatedBytes: 4096,
  actionCount: 2,
  ...over,
});

describe('CleanupRunHistory', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders the first page and asks for the default limit', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: { runs: [run('r1')], nextCursor: null } }));

    render(<CleanupRunHistory deviceId="dev-1" refreshToken={0} />);

    expect(await screen.findByTestId('cleanup-run-r1')).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0][0])).toBe('/devices/dev-1/filesystem/cleanup-runs?limit=20');
  });

  it('labels the kind and the status from the catalog, not from the raw token', async () => {
    fetchMock.mockResolvedValue(json({
      success: true,
      data: {
        runs: [run('r1'), run('r2', { kind: 'system', status: 'failed', bytesReclaimed: 0, error: 'timed out' })],
        nextCursor: null,
      },
    }));

    render(<CleanupRunHistory deviceId="dev-1" refreshToken={0} />);

    const first = await screen.findByTestId('cleanup-run-r1');
    expect(within(first).getByText('File cleanup')).toBeInTheDocument();
    expect(within(first).getByText('Executed')).toBeInTheDocument();
    expect(within(first).getByText('2.0 KB reclaimed')).toBeInTheDocument();

    const second = screen.getByTestId('cleanup-run-r2');
    expect(within(second).getByText('System cleanup')).toBeInTheDocument();
    expect(within(second).getByText('Failed')).toBeInTheDocument();
    expect(within(second).getByText(/timed out/)).toBeInTheDocument();
  });

  it('shows the empty state when the device has no runs', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: { runs: [], nextCursor: null } }));
    render(<CleanupRunHistory deviceId="dev-1" refreshToken={0} />);
    expect(await screen.findByText('No cleanup runs recorded yet.')).toBeInTheDocument();
    expect(screen.queryByTestId('cleanup-run-history-more')).not.toBeInTheDocument();
  });

  it('appends the next page on Load more and passes the cursor through', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ success: true, data: { runs: [run('r1')], nextCursor: '2026-09-19T10:00:00.000Z|r1' } }))
      .mockResolvedValueOnce(json({ success: true, data: { runs: [run('r2')], nextCursor: null } }));

    render(<CleanupRunHistory deviceId="dev-1" refreshToken={0} />);
    await screen.findByTestId('cleanup-run-r1');

    await userEvent.click(screen.getByTestId('cleanup-run-history-more'));

    await waitFor(() => expect(screen.getByTestId('cleanup-run-r2')).toBeInTheDocument());
    // The first page is still on screen — Load more appends, it does not replace.
    expect(screen.getByTestId('cleanup-run-r1')).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[1][0]))
      .toBe('/devices/dev-1/filesystem/cleanup-runs?limit=20&cursor=2026-09-19T10%3A00%3A00.000Z%7Cr1');
    // Nothing left to walk: the button is gone.
    expect(screen.queryByTestId('cleanup-run-history-more')).not.toBeInTheDocument();
  });

  it('restarts the walk when refreshToken changes', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: { runs: [run('r1')], nextCursor: 'c1' } }));
    const { rerender } = render(<CleanupRunHistory deviceId="dev-1" refreshToken={0} />);
    await screen.findByTestId('cleanup-run-r1');

    fetchMock.mockResolvedValue(json({ success: true, data: { runs: [run('r9')], nextCursor: null } }));
    rerender(<CleanupRunHistory deviceId="dev-1" refreshToken={1} />);

    await waitFor(() => expect(screen.getByTestId('cleanup-run-r9')).toBeInTheDocument());
    expect(screen.queryByTestId('cleanup-run-r1')).not.toBeInTheDocument();
    // The restart must not carry the previous walk's cursor.
    expect(String(fetchMock.mock.calls.at(-1)![0])).not.toContain('cursor=');
  });

  it('renders an error banner instead of an empty list on a failed page', async () => {
    fetchMock.mockResolvedValue(json({ success: false, error: 'boom' }, 500));
    render(<CleanupRunHistory deviceId="dev-1" refreshToken={0} />);

    const banner = await screen.findByTestId('cleanup-run-history-error');
    expect(banner).toHaveAttribute('role', 'alert');
    expect(banner).toHaveTextContent('Failed to load cleanup history');
  });

  it('aborts the in-flight page request on unmount', async () => {
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>(() => {});
    });

    const { unmount } = render(<CleanupRunHistory deviceId="dev-1" refreshToken={0} />);
    await waitFor(() => expect(signals.length).toBeGreaterThan(0));

    unmount();

    expect(signals.every((s) => s.aborted)).toBe(true);
  });
});
