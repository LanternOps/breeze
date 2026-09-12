import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import PamRequestsTab from './PamRequestsTab';
import { fetchWithAuth } from '../../stores/auth';
import type { ElevationRequest } from './types';

type Perm = { resource: string; action: string };

// Mirrors PamRulesTab.permissions.test.tsx. Covers the NEGATIVE gating branch
// (PR review fix): before this, canRespond/canRevoke were pure status checks
// with NO permission check at all, so any signed-in user who could reach the
// PAM tab saw Respond/Revoke on every eligible row regardless of pam:approve.
const state = vi.hoisted(() => ({ permissions: [] as Perm[] }));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: { user: { permissions: Perm[] } }) => unknown) => selector({ user: { permissions: state.permissions } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('../../stores/authenticator', () => ({
  getApprovalAssertion: vi
    .fn()
    .mockRejectedValue(Object.assign(new Error('No approver device'), { name: 'NoApproverDeviceError' })),
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

function makeJsonResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return { ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) } as unknown as Response;
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

function listResponse(requests: ElevationRequest[]): Response {
  return makeJsonResponse({ success: true, requests, pagination: { page: 1, limit: 50, total: requests.length } });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.permissions = [{ resource: 'devices', action: 'execute' }];
  fetchWithAuthMock.mockImplementation(async () => listResponse([pendingRequest]));
});

describe('PamRequestsTab — permission gating (pam:approve)', () => {
  it('without pam:approve: hides Respond/Revoke on an otherwise-eligible pending request', async () => {
    render(<PamRequestsTab liveTick={0} />);
    await waitFor(() => screen.getByTestId('pam-request-row-req-1'));

    expect(screen.queryByTestId('pam-respond-btn-req-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pam-revoke-btn-req-1')).not.toBeInTheDocument();
  });

  it('with pam:approve: shows Respond on an eligible pending request', async () => {
    state.permissions = [{ resource: 'pam', action: 'approve' }];
    render(<PamRequestsTab liveTick={0} />);
    await waitFor(() => screen.getByTestId('pam-request-row-req-1'));

    expect(screen.getByTestId('pam-respond-btn-req-1')).toBeInTheDocument();
  });

  it('without pam:manage_policy: hides the "Rule…" (create-rule-from-request) action', async () => {
    render(<PamRequestsTab liveTick={0} />);
    await waitFor(() => screen.getByTestId('pam-request-row-req-1'));

    expect(screen.queryByTestId('pam-create-rule-btn-req-1')).not.toBeInTheDocument();
  });

  it('with pam:manage_policy: shows the "Rule…" action', async () => {
    state.permissions = [{ resource: 'pam', action: 'manage_policy' }];
    render(<PamRequestsTab liveTick={0} />);
    await waitFor(() => screen.getByTestId('pam-request-row-req-1'));

    expect(screen.getByTestId('pam-create-rule-btn-req-1')).toBeInTheDocument();
  });
});
