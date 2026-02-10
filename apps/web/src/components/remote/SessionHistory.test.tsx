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
});
