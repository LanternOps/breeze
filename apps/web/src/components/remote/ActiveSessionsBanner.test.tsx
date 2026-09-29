import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ActiveSessionsBanner, { ACTIVE_SESSIONS_POLL_MS } from './ActiveSessionsBanner';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);
const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const DENIED_DEVICE_ID = '33333333-3333-4333-8333-333333333333';

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

function respond(status: number, body: unknown) {
  fetchMock.mockImplementation(async () => jsonResponse(status, body));
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    type: 'desktop',
    status: 'active',
    elapsedSeconds: 12 * 60,
    isCurrentUser: false,
    userKey: 0,
    user: { name: 'Colleague', email: 'colleague@example.com' },
    ...overrides,
  };
}

async function advancePoll(times = 1) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ACTIVE_SESSIONS_POLL_MS * times);
  });
}

describe('ActiveSessionsBanner', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows who else is connected and for how long', async () => {
    respond(200, { data: [session()] });

    render(<ActiveSessionsBanner deviceId={DEVICE_ID} deviceStatus="online" />);

    expect(await screen.findByTestId('device-active-sessions-banner')).toBeTruthy();
    expect(screen.getByText('Someone else has a session on this device')).toBeTruthy();
    expect(screen.getByTestId('device-active-session-row-0').textContent).toBe('Colleague — Desktop, 12 min');
    expect(fetchMock).toHaveBeenCalledWith(`/remote/devices/${DEVICE_ID}/active-sessions`);
  });

  it('lists each user once, joining their session types with a localized list', async () => {
    respond(200, {
      data: [session(), session({ type: 'terminal', elapsedSeconds: 30 * 60 })],
    });

    render(<ActiveSessionsBanner deviceId={DEVICE_ID} />);

    const rows = await screen.findAllByTestId(/^device-active-session-row-/);
    expect(rows).toHaveLength(1);
    // Duration comes from the user's longest active session.
    expect(rows[0]!.textContent).toBe('Colleague — Desktop and Terminal, 30 min');
  });

  it('keeps same-named colleagues (and unreadable users) as separate rows', async () => {
    respond(200, {
      data: [
        session({ userKey: 0, user: { name: 'Sam', email: null } }),
        session({ userKey: 1, user: { name: 'Sam', email: null } }),
        session({ userKey: 2, user: { name: null, email: null } }),
        session({ userKey: 3, user: { name: null, email: null } }),
      ],
    });

    render(<ActiveSessionsBanner deviceId={DEVICE_ID} />);

    expect(await screen.findByText('4 other people have sessions on this device')).toBeTruthy();
    expect(screen.getAllByTestId(/^device-active-session-row-/)).toHaveLength(4);
  });

  it("does not warn the caller about their own session", async () => {
    respond(200, { data: [session({ isCurrentUser: true })] });

    render(<ActiveSessionsBanner deviceId={DEVICE_ID} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByTestId('device-active-sessions-banner')).toBeNull();
  });

  it('renders nothing on 403 (no remote:access) and stops polling for good', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // The real body for a missing permission carries no code.
    respond(403, { error: 'Permission denied' });

    // Own device id: a permanent denial is remembered per device for the page.
    render(<ActiveSessionsBanner deviceId={DENIED_DEVICE_ID} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await advancePoll(3);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('device-active-sessions-banner')).toBeNull();
  });

  it('keeps the last good warning through a transient error', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock
      .mockImplementationOnce(async () => jsonResponse(200, { data: [session()] }))
      .mockImplementationOnce(async () => jsonResponse(502, {}))
      .mockImplementationOnce(async () => {
        throw new TypeError('network error');
      })
      // A non-JSON 403 (an edge/proxy page) says nothing about this route.
      .mockImplementationOnce(async () => new Response('<html>Forbidden</html>', { status: 403 }))
      .mockImplementation(async () => jsonResponse(200, { data: [] }));

    render(<ActiveSessionsBanner deviceId={DEVICE_ID} />);
    expect(await screen.findByTestId('device-active-sessions-banner')).toBeTruthy();

    await advancePoll(); // 502
    expect(screen.getByTestId('device-active-sessions-banner')).toBeTruthy();
    await advancePoll(); // network error
    expect(screen.getByTestId('device-active-sessions-banner')).toBeTruthy();
    await advancePoll(); // non-JSON 403
    expect(screen.getByTestId('device-active-sessions-banner')).toBeTruthy();

    await advancePoll(); // colleague left
    await waitFor(() => expect(screen.queryByTestId('device-active-sessions-banner')).toBeNull());
  });

  it('refreshes immediately when the tab becomes visible again', async () => {
    respond(200, { data: [] });

    render(<ActiveSessionsBanner deviceId={DEVICE_ID} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

});
