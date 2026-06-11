import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PamRequestsTab from './PamRequestsTab';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
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
const navigateToMock = vi.mocked(navigateTo);

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

  it('treats a 409 respond as already-actioned: refetches with only the runAction error toast', async () => {
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

    // runAction surfaces the server message as the single piece of feedback…
    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: 'Request is not pending' }),
      );
    });
    // …and the modal must NOT stack a contradictory success toast on top.
    expect(showToastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success' }),
    );
    expect(showToastMock).toHaveBeenCalledTimes(1);
    // The list is still refetched (initial load + respond + refetch).
    await waitFor(() => {
      expect(fetchWithAuthMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });

  it('shows a risk tier badge for ai_tool_action rows and not for executable rows', async () => {
    const toolRequest: ElevationRequest = {
      ...pendingRequest,
      id: 'req-9',
      flowType: 'ai_tool_action',
      toolName: 'run_script',
      riskTier: 2,
      targetExecutablePath: null,
    };
    fetchWithAuthMock.mockResolvedValueOnce(listResponse([pendingRequest, toolRequest]));
    render(<PamRequestsTab liveTick={0} />);
    await waitFor(() => screen.getByTestId('pam-request-row-req-9'));
    expect(screen.getByTestId('pam-risk-tier-req-9')).toHaveTextContent('T2');
    expect(screen.queryByTestId('pam-risk-tier-req-1')).toBeNull();
  });

  it('fetches page=2 on Next and updates the footer range', async () => {
    fetchWithAuthMock.mockImplementation(async (url) => {
      const requestedPage = Number(
        new URLSearchParams(String(url).split('?')[1] ?? '').get('page') ?? '1',
      );
      return listResponseAt(requestedPage);
    });
    function listResponseAt(page: number): Response {
      return makeJsonResponse({
        success: true,
        requests: [{ ...pendingRequest, id: `req-p${page}` }],
        pagination: { page, limit: 50, total: 80 },
      });
    }

    render(<PamRequestsTab liveTick={0} />);
    await waitFor(() => {
      expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => {
      expect(
        fetchWithAuthMock.mock.calls.some((c) => String(c[0]).includes('page=2')),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
    });
  });

  it('redirects to /login when the list fetch returns 401', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({}, false, 401));
    render(<PamRequestsTab liveTick={0} />);
    await waitFor(() => {
      expect(navigateToMock).toHaveBeenCalledWith('/login', { replace: true });
    });
  });

  it('refetches with flowType=ai_tool_action when the flow filter changes', async () => {
    fetchWithAuthMock.mockResolvedValue(listResponse([]));
    render(<PamRequestsTab liveTick={0} />);
    await waitFor(() => screen.getByTestId('pam-filter-flow'));
    fireEvent.change(screen.getByTestId('pam-filter-flow'), {
      target: { value: 'ai_tool_action' },
    });
    await waitFor(() => {
      expect(
        fetchWithAuthMock.mock.calls.some((c) =>
          String(c[0]).includes('flowType=ai_tool_action'),
        ),
      ).toBe(true);
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
