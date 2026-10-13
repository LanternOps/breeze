import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PamPage from './PamPage';
import { fetchWithAuth } from '../../stores/auth';
import { useEventStream } from '../../hooks/useEventStream';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  // usePermissions() (PAM RBAC UI gating, PR review fix) is read by the tab
  // components PamPage renders (PamRulesTab, PamSignerGroupsTab,
  // PamRequestsTab) — grant the admin wildcard so this file's tab-switching
  // tests keep exercising full functionality regardless of gating.
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));

vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

const subscribeMock = vi.fn();
const unsubscribeMock = vi.fn();
const streamState = vi.hoisted(() => ({ connected: true }));
vi.mock('../../hooks/useEventStream', () => ({
  useEventStream: vi.fn(() => ({
    connected: streamState.connected,
    subscribe: subscribeMock,
    unsubscribe: unsubscribeMock,
  })),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

function makeJsonResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

function emptyListResponse(): Response {
  return makeJsonResponse({
    success: true,
    requests: [],
    active: [],
    rules: [],
    pagination: { page: 1, limit: 50, total: 0 },
  });
}

describe('PamPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
    streamState.connected = true;
    fetchWithAuthMock.mockImplementation(async () => emptyListResponse());
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders the heading, live indicator, and overview tab by default', async () => {
    render(<PamPage />);
    expect(screen.getByTestId('pam-heading')).toBeInTheDocument();
    expect(screen.getByTestId('pam-live-indicator')).toHaveTextContent('Live');
    await waitFor(() => {
      expect(screen.getByTestId('pam-stat-active')).toBeInTheDocument();
    });
  });

  it('subscribes to elevation events on mount', () => {
    render(<PamPage />);
    expect(subscribeMock).toHaveBeenCalledWith(
      expect.arrayContaining(['elevation.requested', 'elevation.approved', 'elevation.revoked']),
    );
  });

  it('switches tabs via the tab bar and updates the hash', async () => {
    render(<PamPage />);
    fireEvent.click(screen.getByTestId('pam-tab-rules'));
    expect(window.location.hash).toBe('#rules');
    await waitFor(() => {
      expect(screen.getByTestId('pam-add-rule-btn')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('pam-tab-requests'));
    expect(window.location.hash).toBe('#requests');
    await waitFor(() => {
      expect(screen.getByTestId('pam-filter-status')).toBeInTheDocument();
    });
  });

  it('honors a deep-link hash on first render', async () => {
    window.location.hash = '#audit';
    render(<PamPage />);
    await waitFor(() => {
      expect(screen.getByTestId('pam-audit-export-btn')).toBeInTheDocument();
    });
  });

  it.each([
    { connected: false, interval: 10_000 },
    { connected: true, interval: 30_000 },
  ])('refreshes visible data with connected=$connected even when no event arrives', async ({ connected, interval }) => {
    vi.useFakeTimers();
    streamState.connected = connected;
    let pendingTotal = 0;
    fetchWithAuthMock.mockImplementation(async () => makeJsonResponse({
      requests: [], active: [], pagination: { page: 1, limit: 50, total: pendingTotal },
    }));
    await act(async () => { render(<PamPage />); });
    expect(screen.getByTestId('pam-stat-pending')).toHaveTextContent('0');
    pendingTotal = 1;
    await act(async () => { await vi.advanceTimersByTimeAsync(interval); });
    expect(screen.getByTestId('pam-stat-pending')).toHaveTextContent('1');
  });

  it('refreshes on reconnect and coalesces elevation bursts without delaying the first refresh', async () => {
    vi.useFakeTimers();
    await act(async () => { render(<PamPage />); });
    fetchWithAuthMock.mockClear();
    await act(async () => { vi.mocked(useEventStream).mock.calls.at(-1)![0].onConnected?.(); });
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(3);
    fetchWithAuthMock.mockClear();
    const event = { type: 'elevation.requested', orgId: 'org-a', payload: {}, metadata: {} };
    act(() => vi.mocked(useEventStream).mock.calls.at(-1)![0].onEvent(event));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    act(() => vi.mocked(useEventStream).mock.calls.at(-1)![0].onEvent(event));
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(3);
  });

  it('pauses background refresh and catches up when the page becomes visible or focused', async () => {
    vi.useFakeTimers();
    streamState.connected = false;
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('visible');
    await act(async () => { render(<PamPage />); });
    fetchWithAuthMock.mockClear();
    visibility.mockReturnValue('hidden');
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    await act(async () => { fireEvent(document, new Event('visibilitychange')); });
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(3);
    fetchWithAuthMock.mockClear();
    await act(async () => { fireEvent(window, new Event('focus')); });
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(3);
  });

  it('clears refresh timers and listeners on unmount', async () => {
    vi.useFakeTimers();
    let unmount!: () => void;
    await act(async () => { ({ unmount } = render(<PamPage />)); });
    act(() => vi.mocked(useEventStream).mock.calls.at(-1)![0].onEvent({
      type: 'elevation.requested', orgId: 'org-a', payload: {}, metadata: {},
    }));
    unmount();
    fetchWithAuthMock.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
      fireEvent(window, new Event('focus'));
      fireEvent(document, new Event('visibilitychange'));
    });
    expect(fetchWithAuthMock).not.toHaveBeenCalled();
    expect(unsubscribeMock).toHaveBeenCalled();
  });
});
