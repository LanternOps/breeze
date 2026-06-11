import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PamOverviewTab from './PamOverviewTab';
import { fetchWithAuth } from '../../stores/auth';
import type { ElevationRequest } from './types';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('@/lib/navigation', () => ({
  navigateTo: vi.fn(),
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

const activeElevation: ElevationRequest = {
  id: 'act-1',
  orgId: 'org-1',
  deviceId: 'dev-1',
  deviceHostname: 'SRV-BRAVO',
  flowType: 'tech_jit_admin',
  subjectUsername: 'tech1',
  reason: 'Patch window',
  status: 'approved',
  requestedAt: '2026-06-10T12:00:00.000Z',
  expiresAt: new Date(Date.now() + 30 * 60000).toISOString(),
};

describe('PamOverviewTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders stat cards and active elevations from the three queries', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url === '/pam/active') {
        return makeJsonResponse({ success: true, active: [activeElevation] });
      }
      if (url.includes('status=pending')) {
        return makeJsonResponse({
          success: true,
          requests: [],
          pagination: { page: 1, limit: 1, total: 4 },
        });
      }
      return makeJsonResponse({
        success: true,
        requests: [{ ...activeElevation, id: 'dec-1', status: 'denied' }],
        pagination: { page: 1, limit: 10, total: 1 },
      });
    });

    render(<PamOverviewTab liveTick={0} />);
    await waitFor(() => {
      expect(screen.getByTestId('pam-stat-active')).toHaveTextContent('1');
    });
    expect(screen.getByTestId('pam-stat-pending')).toHaveTextContent('4');
    expect(screen.getByTestId('pam-active-row-act-1')).toHaveTextContent('SRV-BRAVO');
  });

  it('shows empty states when nothing is active', async () => {
    fetchWithAuthMock.mockImplementation(async () =>
      makeJsonResponse({
        success: true,
        active: [],
        requests: [],
        pagination: { page: 1, limit: 10, total: 0 },
      }),
    );
    render(<PamOverviewTab liveTick={0} />);
    await waitFor(() => {
      expect(screen.getByText('No active elevations')).toBeInTheDocument();
    });
    expect(screen.getByText('No decided requests yet.')).toBeInTheDocument();
  });

  it('surfaces an error banner when a query fails', async () => {
    fetchWithAuthMock.mockImplementation(async () => makeJsonResponse({}, false, 500));
    render(<PamOverviewTab liveTick={0} />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('HTTP 500');
    });
  });
});
