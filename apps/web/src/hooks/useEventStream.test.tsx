import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOrgStore } from '../stores/orgStore';
import { useJwtClaims } from '../lib/authScope';
import { fetchWithAuth } from '../stores/auth';
import { useEventStream, useEventStreamScope } from './useEventStream';

vi.mock('../stores/orgStore', () => ({ useOrgStore: vi.fn() }));
vi.mock('../lib/authScope', () => ({ useJwtClaims: vi.fn() }));
vi.mock('../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);
const sockets: MockWebSocket[] = [];

class MockWebSocket {
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 3; this.onclose?.(); });
  constructor(public url: string) { sockets.push(this); }
  open() { this.readyState = MockWebSocket.OPEN; this.onopen?.(); }
}

function response(ticket: string) {
  return { ok: true, json: async () => ({ ticket }) } as Response;
}

beforeEach(() => {
  vi.mocked(useJwtClaims).mockReturnValue({ status: 'resolved', claims: { scope: 'partner', partnerId: 'partner-a', orgId: null } });
  vi.mocked(useOrgStore).mockReturnValue(null);
  window.history.replaceState({}, '', '/');
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(response('ticket'));
  sockets.length = 0;
  vi.stubGlobal('WebSocket', MockWebSocket);
  useEventStreamScope.getState().setPartnerId(undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('useEventStream partner scope', () => {
  it('preserves the default ticket URL without a selected partner', async () => {
    renderHook(() => useEventStream({ onEvent: vi.fn() }));
    await waitFor(() => expect(sockets).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledWith('/events/ws-ticket', { method: 'POST' });
  });

  it('waits for a system session to select its partner before requesting a ticket', async () => {
    window.history.replaceState({}, '', '/organizations');
    vi.mocked(useJwtClaims).mockReturnValue({ status: 'unresolved' });
    const { rerender } = renderHook(() => useEventStream({ onEvent: vi.fn() }));
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();

    vi.mocked(useJwtClaims).mockReturnValue({ status: 'resolved', claims: { scope: 'system', partnerId: null, orgId: null } });
    rerender();
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => useEventStreamScope.getState().setPartnerId('partner-a'));
    await waitFor(() => expect(sockets).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/events/ws-ticket?partnerId=partner-a', { method: 'POST', skipOrgIdInjection: true });
  });

  it('preserves ticket requests for system sessions with an explicitly selected organization', async () => {
    vi.mocked(useJwtClaims).mockReturnValue({ status: 'resolved', claims: { scope: 'system', partnerId: null, orgId: null } });
    vi.mocked(useOrgStore).mockReturnValue('selected-org');
    renderHook(() => useEventStream({ onEvent: vi.fn() }));
    await waitFor(() => expect(sockets).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/events/ws-ticket', { method: 'POST' });
  });

  it('sends the selected partner in the ticket request', async () => {
    useEventStreamScope.getState().setPartnerId('partner/a');
    renderHook(() => useEventStream({ onEvent: vi.fn() }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/events/ws-ticket?partnerId=partner%2Fa', { method: 'POST', skipOrgIdInjection: true },
    ));
  });

  it('closes the old socket and reconnects subscriptions for the new partner', async () => {
    useEventStreamScope.getState().setPartnerId('partner-a');
    const { result } = renderHook(() => useEventStream({ onEvent: vi.fn() }));
    await waitFor(() => expect(sockets).toHaveLength(1));
    act(() => { sockets[0]!.open(); result.current.subscribe(['organization.updated']); });
    act(() => useEventStreamScope.getState().setPartnerId('partner-b'));
    await waitFor(() => expect(sockets).toHaveLength(2));
    expect(sockets[0]!.close).toHaveBeenCalledOnce();
    expect(result.current.connected).toBe(false);
    expect(fetchMock).toHaveBeenLastCalledWith('/events/ws-ticket?partnerId=partner-b', { method: 'POST', skipOrgIdInjection: true });
    act(() => sockets[1]!.open());
    expect(sockets[1]!.send).toHaveBeenCalledWith(JSON.stringify({ action: 'subscribe', types: ['organization.updated'] }));
  });

  it('ignores a ticket resolving after the selected partner changes', async () => {
    let resolveOld!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { resolveOld = resolve; }));
    fetchMock.mockResolvedValueOnce(response('new-ticket'));
    useEventStreamScope.getState().setPartnerId('partner-a');
    renderHook(() => useEventStream({ onEvent: vi.fn() }));
    act(() => useEventStreamScope.getState().setPartnerId('partner-b'));
    await waitFor(() => expect(sockets).toHaveLength(1));
    await act(async () => resolveOld(response('old-ticket')));
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toContain('ticket=new-ticket');
  });

  it('retries only the current partner and clears retry timers on unmount', async () => {
    vi.useFakeTimers();
    useEventStreamScope.getState().setPartnerId('partner-a');
    const { unmount } = renderHook(() => useEventStream({ onEvent: vi.fn() }));
    await act(async () => {});
    act(() => sockets[0]!.onclose?.());
    act(() => useEventStreamScope.getState().setPartnerId('partner-b'));
    await act(async () => {});
    act(() => sockets.at(-1)!.onclose?.());
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(fetchMock).toHaveBeenLastCalledWith('/events/ws-ticket?partnerId=partner-b', { method: 'POST', skipOrgIdInjection: true });
    unmount();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
