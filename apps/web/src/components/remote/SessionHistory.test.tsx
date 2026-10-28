import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SessionHistory, { normalizeRemoteSession } from './SessionHistory';
import { fetchWithAuth } from '@/stores/auth';

vi.mock('@/stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

describe('SessionHistory filter selects accessible name (#7156)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gives the type/user/date filter selects a real accessible name', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [], pagination: { page: 1, limit: 100, total: 0 } }));
    render(<SessionHistory />);

    expect(await screen.findByRole('combobox', { name: 'Session type' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'User' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Date range' })).toBeInTheDocument();
  });
});

describe('SessionHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads session history with fetchWithAuth and renders rows', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        data: [
          {
            id: 'session-1',
            deviceId: 'device-1',
            userId: 'user-1',
            type: 'terminal',
            status: 'disconnected',
            startedAt: '2026-02-08T10:00:00.000Z',
            endedAt: '2026-02-08T10:05:00.000Z',
            durationSeconds: 300,
            bytesTransferred: 2048,
            createdAt: '2026-02-08T10:00:00.000Z',
            device: { hostname: 'host-1', osType: 'linux' },
            user: { name: 'Alex', email: 'alex@example.com' }
          }
        ],
        pagination: { page: 1, limit: 100, total: 1 }
      })
    );

    render(<SessionHistory />);

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith('/remote/sessions/history?limit=100');
    });

    expect(await screen.findByText('host-1')).toBeTruthy();
    expect(await screen.findByText('alex@example.com')).toBeTruthy();
  });

  // #5537 — a session whose terminal decision committed but whose
  // stop the agent has not yet acknowledged (terminationPhase = 'pending') is
  // labelled distinctly from a confirmed end.
  it('labels a pending teardown distinctly from a confirmed end', async () => {
    const base = {
      deviceId: 'device-1',
      userId: 'user-1',
      type: 'desktop',
      status: 'disconnected',
      startedAt: '2026-02-08T10:00:00.000Z',
      endedAt: '2026-02-08T10:05:00.000Z',
      durationSeconds: 300,
      bytesTransferred: 2048,
      createdAt: '2026-02-08T10:00:00.000Z',
      user: { name: 'Alex', email: 'alex@example.com' }
    };
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        data: [
          { ...base, id: 'session-pending', terminationPhase: 'pending', device: { hostname: 'host-pending', osType: 'linux' } },
          { ...base, id: 'session-confirmed', terminationPhase: 'confirmed', device: { hostname: 'host-confirmed', osType: 'linux' } },
          { ...base, id: 'session-legacy', device: { hostname: 'host-legacy', osType: 'linux' } }
        ],
        pagination: { page: 1, limit: 100, total: 3 }
      })
    );

    render(<SessionHistory />);

    expect(await screen.findByText('host-pending')).toBeTruthy();
    const pendingRow = screen.getByText('host-pending').closest('tr')!;
    const confirmedRow = screen.getByText('host-confirmed').closest('tr')!;
    const legacyRow = screen.getByText('host-legacy').closest('tr')!;

    expect(pendingRow.textContent).toMatch(/Ending/);
    expect(pendingRow.textContent).not.toMatch(/Disconnected/);
    expect(confirmedRow.textContent).toMatch(/Disconnected/);
    expect(confirmedRow.textContent).not.toMatch(/Ending/);
    expect(legacyRow.textContent).toMatch(/Disconnected/);
    expect(legacyRow.textContent).not.toMatch(/Ending/);
  });
});

describe('SessionHistory end reason (#10190)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const base = {
    deviceId: 'device-1',
    userId: 'user-1',
    type: 'desktop',
    status: 'disconnected',
    startedAt: '2026-02-08T10:00:00.000Z',
    endedAt: '2026-02-08T10:05:00.000Z',
    durationSeconds: 300,
    bytesTransferred: 2048,
    createdAt: '2026-02-08T10:00:00.000Z',
    user: { name: 'Alex', email: 'alex@example.com' }
  };

  it('shows Ended by the user only on rows whose endReason is ended_by_user', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({
        data: [
          { ...base, id: 's-user', endReason: 'ended_by_user', device: { hostname: 'host-user', osType: 'linux' } },
          { ...base, id: 's-null', endReason: null, device: { hostname: 'host-null', osType: 'linux' } },
          { ...base, id: 's-legacy', device: { hostname: 'host-legacy', osType: 'linux' } }
        ],
        pagination: { page: 1, limit: 100, total: 3 }
      })
    );
    render(<SessionHistory />);

    expect(await screen.findByText('host-user')).toBeTruthy();
    expect(screen.getByText('host-user').closest('tr')!.textContent).toMatch(/Ended by the user/);
    expect(screen.getByText('host-null').closest('tr')!.textContent).not.toMatch(/Ended by the user/);
    expect(screen.getByText('host-legacy').closest('tr')!.textContent).not.toMatch(/Ended by the user/);
  });

  it('normalizeRemoteSession maps endReason, defaulting to null', () => {
    const api = { ...base, id: 'x', type: 'desktop' as const, status: 'disconnected' as const };
    expect(normalizeRemoteSession({ ...api, endReason: 'ended_by_user' }).endReason).toBe('ended_by_user');
    expect(normalizeRemoteSession({ ...api, endReason: null }).endReason).toBeNull();
    expect(normalizeRemoteSession(api).endReason).toBeNull();
  });
});
