import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PamRequestsTab from './PamRequestsTab';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import type { ElevationRequest } from './types';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  // usePermissions() (PAM RBAC UI gating, PR review fix) reads grants off the
  // store; grant the admin wildcard here so this file's existing tests (which
  // predate the gating) keep exercising full functionality. Negative gating
  // is covered in the sibling PamRulesTab.permissions.test.tsx-style suite.
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: { resource: string; action: string }[] } }) => unknown) =>
      selector({ user: { permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));

// PamRequestsTab imports PamRespondModal, which calls getApprovalAssertion in the
// approve flow (Breeze Authenticator step-up). Mock it to the graceful "no approver
// device" path so it never runs the real WebAuthn ceremony or issues its own
// fetchWithAuth — an unmocked call would desequence the shared fetch mock queue and
// (because vi.clearAllMocks doesn't drain mockResolvedValueOnce) cascade into later
// tests, leaving their request lists empty.
vi.mock('../../stores/authenticator', () => ({
  getApprovalAssertion: vi
    .fn()
    .mockRejectedValue(
      Object.assign(new Error('No approver device'), { name: 'NoApproverDeviceError' }),
    ),
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

  it('keeps request rows visible during a background refresh and displays the new status', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(listResponse([pendingRequest]));
    const { rerender } = render(<PamRequestsTab liveTick={0} />);
    await waitFor(() => screen.getByTestId('pam-request-row-req-1'));
    let resolveRefresh!: (response: Response) => void;
    fetchWithAuthMock.mockReturnValueOnce(new Promise<Response>((resolve) => { resolveRefresh = resolve; }));
    rerender(<PamRequestsTab liveTick={1} />);
    expect(screen.getByTestId('pam-request-row-req-1')).toBeInTheDocument();
    expect(screen.getByTestId('pam-respond-btn-req-1')).toBeInTheDocument();
    await act(async () => resolveRefresh(listResponse([{ ...pendingRequest, status: 'denied' }])));
    expect(screen.getByTestId('pam-request-row-req-1')).toBeInTheDocument();
    expect(screen.queryByTestId('pam-respond-btn-req-1')).not.toBeInTheDocument();
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

  it('shows who decided a request, preferring the joined display name', async () => {
    const denied: ElevationRequest = {
      ...pendingRequest,
      id: 'req-3',
      status: 'denied',
      deniedByUserId: 'deadbeef-0000-4000-8000-000000000001',
      deniedByName: 'Jane Admin',
    };
    const approvedNoName: ElevationRequest = {
      ...pendingRequest,
      id: 'req-4',
      status: 'approved',
      approvedByUserId: 'deadbeef-0000-4000-8000-000000000001',
    };
    fetchWithAuthMock.mockResolvedValueOnce(listResponse([denied, approvedNoName]));
    render(<PamRequestsTab liveTick={0} />);
    await waitFor(() => screen.getByTestId('pam-request-row-req-3'));
    expect(screen.getByTestId('pam-decided-by-req-3')).toHaveTextContent('by Jane Admin');
    expect(screen.getByTestId('pam-decided-by-req-3')).not.toHaveTextContent('deadbeef');
    // Older cached rows without the join still show the truncated id.
    expect(screen.getByTestId('pam-decided-by-req-4')).toHaveTextContent('by deadbeef…');
  });

  it('attributes an auto-approved request to its PAM rule', async () => {
    const autoApproved: ElevationRequest = {
      ...pendingRequest,
      id: 'req-rule',
      status: 'auto_approved',
      decisionSource: 'pam_rule',
      pamRuleName: 'Allow signed installers',
    };
    fetchWithAuthMock.mockResolvedValueOnce(listResponse([autoApproved]));
    render(<PamRequestsTab liveTick={0} />);
    await waitFor(() => screen.getByTestId('pam-request-row-req-rule'));
    expect(screen.getByTestId('pam-decided-by-req-rule')).toHaveTextContent(
      'Rule · Allow signed installers',
    );
  });

  it('attributes a denied request to the matched software policy', async () => {
    const denied: ElevationRequest = {
      ...pendingRequest,
      id: 'req-policy',
      status: 'denied',
      decisionSource: 'software_policy',
      matchedPolicyName: 'Engineering Blocklist',
      denialReason: 'Blocked by software policy',
    };
    fetchWithAuthMock.mockResolvedValueOnce(listResponse([denied]));
    render(<PamRequestsTab liveTick={0} />);
    await waitFor(() => screen.getByTestId('pam-request-row-req-policy'));
    expect(screen.getByTestId('pam-decided-by-req-policy')).toHaveTextContent(
      'Policy · Engineering Blocklist',
    );
    // The raw denialReason is redundant once the policy is named, so it is hidden.
    expect(screen.queryByText('Blocked by software policy')).toBeNull();
  });

  it('attributes a human revoke over the original auto-decision', async () => {
    const revoked: ElevationRequest = {
      ...pendingRequest,
      id: 'req-revoked',
      status: 'revoked',
      decisionSource: 'pam_rule',
      pamRuleName: 'Allow signed installers',
      revokedByName: 'Jane Admin',
    };
    fetchWithAuthMock.mockResolvedValueOnce(listResponse([revoked]));
    render(<PamRequestsTab liveTick={0} />);
    await waitFor(() => screen.getByTestId('pam-request-row-req-revoked'));
    expect(screen.getByTestId('pam-decided-by-req-revoked')).toHaveTextContent('by Jane Admin');
  });

  // #9517: the agent reported it could not act; the request was closed as
  // expired, so it leaves the default Pending view and shows under Expired.
  it('shows why the device could not act, with the agent detail as the tooltip', async () => {
    const pendingOnly = listResponse([{ ...pendingRequest, id: 'req-ok' }]);
    const expiredRows = listResponse([
      {
        ...pendingRequest,
        id: 'req-unable',
        status: 'expired',
        deviceUnableAt: '2026-06-10T12:00:05.000Z',
        deviceUnableReason: 'session_unavailable',
        deviceUnableDetail: 'session 7 cannot host a SYSTEM helper (not active or connected)',
      },
      { ...pendingRequest, id: 'req-future', status: 'expired', deviceUnableAt: '2026-06-10T12:00:05.000Z', deviceUnableReason: 'some_new_category' },
    ]);
    fetchWithAuthMock.mockImplementation(async (url) => {
      const requested = new URLSearchParams(String(url).split('?')[1] ?? '').get('status');
      return requested === 'expired' ? expiredRows : pendingOnly;
    });
    render(<PamRequestsTab liveTick={0} />);

    // The default Pending view no longer lists the closed request.
    await screen.findByTestId('pam-request-row-req-ok');
    expect(screen.queryByTestId('pam-request-row-req-unable')).not.toBeInTheDocument();
    expect(screen.getByTestId('pam-respond-btn-req-ok')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('pam-filter-status'), { target: { value: 'expired' } });
    const line = await screen.findByTestId('pam-device-unable-req-unable');
    expect(line).toHaveTextContent("Device could not act: user's session unavailable");
    expect(line).toHaveAttribute('title', 'session 7 cannot host a SYSTEM helper (not active or connected)');
    // An unknown category from a newer agent still says the device could not act.
    expect(screen.getByTestId('pam-device-unable-req-future')).toHaveTextContent('Device could not act on this request');
    expect(screen.queryByTestId('pam-device-unable-req-ok')).not.toBeInTheDocument();
    expect(String(fetchWithAuthMock.mock.calls.at(-1)?.[0])).toContain('status=expired');
    // A closed request offers no Respond action.
    expect(screen.queryByTestId('pam-respond-btn-req-unable')).not.toBeInTheDocument();
  });

  // #8971: a request the device user declined (or ignored) is withdrawn.
  it('offers a Withdrawn status filter and shows the withdraw reason under the badge', async () => {
    const pendingOnly = listResponse([{ ...pendingRequest, id: 'req-ok' }]);
    const at = '2026-06-10T12:00:05.000Z';
    const withdrawnRows = listResponse([
      { ...pendingRequest, id: 'w-denied', status: 'withdrawn', withdrawnAt: at, withdrawnReason: 'user_denied' },
      { ...pendingRequest, id: 'w-timeout', status: 'withdrawn', withdrawnAt: at, withdrawnReason: 'user_timeout' },
      { ...pendingRequest, id: 'w-error', status: 'withdrawn', withdrawnAt: at, withdrawnReason: 'dialog_error' },
    ]);
    fetchWithAuthMock.mockImplementation(async (url) => {
      const requested = new URLSearchParams(String(url).split('?')[1] ?? '').get('status');
      return requested === 'withdrawn' ? withdrawnRows : pendingOnly;
    });
    render(<PamRequestsTab liveTick={0} />);
    await screen.findByTestId('pam-request-row-req-ok');

    const filter = screen.getByTestId('pam-filter-status') as HTMLSelectElement;
    expect(Array.from(filter.options).map((o) => o.value)).toContain('withdrawn');
    fireEvent.change(filter, { target: { value: 'withdrawn' } });

    expect(await screen.findByTestId('pam-withdraw-reason-w-denied')).toHaveTextContent('Declined by the user');
    expect(screen.getByTestId('pam-withdraw-reason-w-timeout')).toHaveTextContent('No answer on the device');
    expect(screen.getByTestId('pam-withdraw-reason-w-error')).toHaveTextContent('Prompt failed on the device');
    expect(screen.getAllByText('Withdrawn').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('pam-respond-btn-w-denied')).not.toBeInTheDocument();
  });

  it('shows the device-side decline line on approved and auto_approved rows', async () => {
    const approvedRows = listResponse([
      { ...pendingRequest, id: 'a-declined', status: 'approved', enforcementReason: 'user_declined' },
      { ...pendingRequest, id: 'a-auto', status: 'auto_approved', enforcementReason: 'user_declined' },
      { ...pendingRequest, id: 'a-pending', status: 'approved', enforcementReason: 'user_decision_pending' },
      { ...pendingRequest, id: 'a-untrusted', status: 'approved', enforcementReason: 'user_decline_record_untrusted' },
      { ...pendingRequest, id: 'a-clean', status: 'approved', enforcementReason: null },
    ]);
    fetchWithAuthMock.mockImplementation(async (url) => {
      const requested = new URLSearchParams(String(url).split('?')[1] ?? '').get('status');
      return requested === 'approved' ? approvedRows : listResponse([{ ...pendingRequest, id: 'req-ok' }]);
    });
    render(<PamRequestsTab liveTick={0} />);
    await screen.findByTestId('pam-request-row-req-ok');
    fireEvent.change(screen.getByTestId('pam-filter-status'), { target: { value: 'approved' } });

    expect(await screen.findByTestId('pam-enforcement-reason-a-declined')).toHaveTextContent('Declined on the device');
    expect(screen.getByTestId('pam-enforcement-reason-a-auto')).toHaveTextContent('Declined on the device');
    expect(screen.getByTestId('pam-enforcement-reason-a-pending')).toHaveTextContent('No answer on the device');
    expect(screen.getByTestId('pam-enforcement-reason-a-untrusted')).toHaveTextContent(
      'Refused: device decision record unavailable',
    );
    expect(screen.queryByTestId('pam-enforcement-reason-a-clean')).not.toBeInTheDocument();
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

  it('shows a Rule… action on every row and opens the rule modal pre-filled', async () => {
    const signedPending: ElevationRequest = {
      ...pendingRequest,
      id: 'req-signed',
      targetExecutableSigner: 'Acme Corp',
      targetExecutablePath: 'C:\\Temp\\installer.exe',
    };
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/orgs/organizations')) return makeJsonResponse({ data: [{ id: 'org-1', name: 'Acme' }] });
      if (url.startsWith('/orgs/sites')) return makeJsonResponse({ data: [] });
      return listResponse([signedPending]);
    });

    render(<PamRequestsTab liveTick={0} />);
    await waitFor(() => screen.getByTestId('pam-request-row-req-signed'));
    // Every row has a create-rule button regardless of status.
    expect(screen.getByTestId('pam-create-rule-btn-req-signed')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('pam-create-rule-btn-req-signed'));
    // The rule modal opens in create mode, seeded from the request.
    await waitFor(() => {
      expect(screen.getByTestId('pam-rule-submit')).toHaveTextContent('Create rule');
    });
    await waitFor(() => {
      expect((screen.getByTestId('pam-rule-signer') as HTMLInputElement).value).toBe('Acme Corp');
    });
  });

  it('seeds the rule modal org select from the request org for multi-org users', async () => {
    // pendingRequest.orgId is 'org-1'; with two accessible orgs the modal must
    // default the org select to the request's org, not items[0] (#1286 Fix A).
    const signedPending: ElevationRequest = {
      ...pendingRequest,
      id: 'req-org',
      orgId: 'org-2',
      targetExecutableSigner: 'Acme Corp',
    };
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/orgs/organizations'))
        return makeJsonResponse({
          data: [
            { id: 'org-1', name: 'Acme' },
            { id: 'org-2', name: 'Globex' },
          ],
        });
      if (url.startsWith('/orgs/sites')) return makeJsonResponse({ data: [] });
      return listResponse([signedPending]);
    });

    render(<PamRequestsTab liveTick={0} />);
    await waitFor(() => screen.getByTestId('pam-create-rule-btn-req-org'));
    fireEvent.click(screen.getByTestId('pam-create-rule-btn-req-org'));

    await waitFor(() => {
      expect((screen.getByTestId('pam-rule-org') as HTMLSelectElement).value).toBe('org-2');
    });
  });

  it('offers a create-rule link in the respond modal that swaps to the rule modal', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/orgs/organizations')) return makeJsonResponse({ data: [{ id: 'org-1', name: 'Acme' }] });
      if (url.startsWith('/orgs/sites')) return makeJsonResponse({ data: [] });
      return listResponse([pendingRequest]);
    });

    render(<PamRequestsTab liveTick={0} />);
    await waitFor(() => screen.getByTestId('pam-respond-btn-req-1'));
    fireEvent.click(screen.getByTestId('pam-respond-btn-req-1'));
    await waitFor(() => screen.getByTestId('pam-respond-create-rule'));

    fireEvent.click(screen.getByTestId('pam-respond-create-rule'));
    await waitFor(() => {
      expect(screen.getByTestId('pam-rule-submit')).toHaveTextContent('Create rule');
    });
    // The respond modal is dismissed when switching to the rule modal.
    expect(screen.queryByTestId('pam-respond-submit')).toBeNull();
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
