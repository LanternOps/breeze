import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PamRequestsTab from './PamRequestsTab';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import type { ElevationRequest } from './types';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

vi.mock('@/lib/navigation', () => ({
  navigateTo: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const showToastMock = vi.mocked(showToast);

function makeJsonResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

const pendingRequest: ElevationRequest = {
  id: 'req-1',
  orgId: 'org-1',
  deviceId: 'dev-1',
  deviceHostname: 'WS-ALPHA',
  flowType: 'uac_intercept',
  subjectUsername: 'CONTOSO\\jdoe',
  reason: 'Install printer driver',
  targetExecutablePath: 'C:\\Temp\\driver.exe',
  status: 'pending',
  requestedAt: '2026-06-10T12:00:00.000Z',
};

function listResponse(requests: ElevationRequest[], total = requests.length): Response {
  return makeJsonResponse({
    success: true,
    requests,
    pagination: { page: 1, limit: 50, total },
  });
}

describe('PamRequestsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the empty state when no requests match', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(listResponse([]));
    render(<PamRequestsTab liveTick={0} />);
    await waitFor(() => {
      expect(screen.getByText('No elevation requests')).toBeInTheDocument();
    });
  });

  it('shows an error banner when the list fails', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({}, false, 500));
    render(<PamRequestsTab liveTick={0} />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('HTTP 500');
    });
  });

  it('renders a pending request row with a respond action', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(listResponse([pendingRequest]));
    render(<PamRequestsTab liveTick={0} />);
    await waitFor(() => {
      expect(screen.getByTestId('pam-request-row-req-1')).toBeInTheDocument();
    });
    expect(screen.getByText('WS-ALPHA')).toBeInTheDocument();
    expect(screen.getByTestId('pam-respond-btn-req-1')).toBeInTheDocument();
  });

  it('approves a pending request through the modal and refetches', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(listResponse([pendingRequest]))
      .mockResolvedValueOnce(makeJsonResponse({ success: true, id: 'req-1', status: 'approved' }))
      .mockResolvedValueOnce(listResponse([]));

    render(<PamRequestsTab liveTick={0} />);
    await waitFor(() => screen.getByTestId('pam-respond-btn-req-1'));
    fireEvent.click(screen.getByTestId('pam-respond-btn-req-1'));
    fireEvent.click(screen.getByTestId('pam-respond-submit'));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/pam/elevation-requests/req-1/respond',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    const postCall = fetchWithAuthMock.mock.calls.find(
      (c) => c[0] === '/pam/elevation-requests/req-1/respond',
    );
    expect(JSON.parse((postCall?.[1] as RequestInit).body as string)).toEqual({
      decision: 'approve',
      durationMinutes: 15,
    });
    // refetch after action
    await waitFor(() => {
      expect(fetchWithAuthMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });

  it('treats a 409 respond as already-actioned and refetches gracefully', async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(listResponse([pendingRequest]))
      .mockResolvedValueOnce(
        makeJsonResponse({ success: false, error: 'Request is not pending' }, false, 409),
      )
      .mockResolvedValueOnce(listResponse([]));

    render(<PamRequestsTab liveTick={0} />);
    await waitFor(() => screen.getByTestId('pam-respond-btn-req-1'));
    fireEvent.click(screen.getByTestId('pam-respond-btn-req-1'));
    fireEvent.click(screen.getByTestId('pam-respond-submit'));

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('already actioned') }),
      );
    });
  });

  it('revokes an active elevation with a required reason', async () => {
    const active: ElevationRequest = { ...pendingRequest, id: 'req-2', status: 'approved' };
    fetchWithAuthMock
      .mockResolvedValueOnce(listResponse([active]))
      .mockResolvedValueOnce(makeJsonResponse({ success: true, id: 'req-2', status: 'revoked' }))
      .mockResolvedValueOnce(listResponse([]));

    render(<PamRequestsTab liveTick={0} />);
    await waitFor(() => screen.getByTestId('pam-revoke-btn-req-2'));
    fireEvent.click(screen.getByTestId('pam-revoke-btn-req-2'));

    const submit = screen.getByTestId('pam-revoke-submit');
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByTestId('pam-revoke-reason'), {
      target: { value: 'Window no longer needed' },
    });
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/pam/elevation-requests/req-2/revoke',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });
});
