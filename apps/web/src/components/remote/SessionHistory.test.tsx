import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SessionHistory from './SessionHistory';
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

  // SEC-038 W06 (#5537): a session whose terminal decision committed but whose
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
