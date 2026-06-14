import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElevationRequest } from './types';

const { fetchWithAuthMock, getApprovalAssertionMock, showToastMock, navigateToMock } = vi.hoisted(
  () => ({
    fetchWithAuthMock: vi.fn(),
    getApprovalAssertionMock: vi.fn(),
    showToastMock: vi.fn(),
    navigateToMock: vi.fn(),
  }),
);

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: fetchWithAuthMock,
}));

vi.mock('../../stores/authenticator', () => ({
  getApprovalAssertion: getApprovalAssertionMock,
}));

vi.mock('../shared/Toast', () => ({
  showToast: showToastMock,
}));

vi.mock('@/lib/navigation', () => ({
  navigateTo: navigateToMock,
}));

import PamRespondModal from './PamRespondModal';

function makeJsonResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

const requestFixture = (over: Partial<ElevationRequest> = {}): ElevationRequest => ({
  id: 'er-9',
  orgId: 'org-1',
  siteId: null,
  deviceId: 'dev-1',
  flowType: 'uac_intercept',
  subjectUsername: 'ACME\\jdoe',
  reason: 'Install printer driver',
  status: 'pending',
  requestedAt: '2026-06-14T12:00:00.000Z',
  deviceHostname: 'WS-001',
  ...over,
});

const proofFixture = {
  credentialId: 'cred-1',
  authenticatorData: 'auth-data',
  clientDataJSON: 'client-data',
  signature: 'signature',
  userHandle: null,
};

/** Pull the parsed JSON body from a fetchWithAuth call to the respond endpoint. */
function respondBody(): Record<string, unknown> {
  const call = fetchWithAuthMock.mock.calls.find((c) =>
    String(c[0]).includes('/pam/elevation-requests/er-9/respond'),
  );
  if (!call) throw new Error('respond endpoint was not called');
  return JSON.parse((call[1] as RequestInit).body as string);
}

describe('PamRespondModal Windows Hello step-up', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ success: true }));
  });

  it('runs the assertion on approve and includes the proof in the respond body', async () => {
    getApprovalAssertionMock.mockResolvedValueOnce(proofFixture);

    render(
      <PamRespondModal request={requestFixture()} onClose={() => {}} onActioned={() => {}} />,
    );

    fireEvent.submit(screen.getByTestId('pam-respond-submit').closest('form')!);

    await waitFor(() =>
      expect(getApprovalAssertionMock).toHaveBeenCalledWith('/pam/elevation-requests', 'er-9'),
    );
    await waitFor(() => {
      const body = respondBody();
      expect(body.decision).toBe('approve');
      expect(body.proof).toEqual(proofFixture);
    });
  });

  it('does not request an assertion on deny', async () => {
    render(
      <PamRespondModal request={requestFixture()} onClose={() => {}} onActioned={() => {}} />,
    );

    fireEvent.click(screen.getByTestId('pam-respond-deny-toggle'));
    fireEvent.submit(screen.getByTestId('pam-respond-submit').closest('form')!);

    await waitFor(() => {
      const body = respondBody();
      expect(body.decision).toBe('deny');
    });
    expect(getApprovalAssertionMock).not.toHaveBeenCalled();
    expect(respondBody().proof).toBeUndefined();
  });

  it('surfaces an error and does not submit when the WebAuthn ceremony is cancelled', async () => {
    getApprovalAssertionMock.mockRejectedValueOnce(
      new DOMException('The operation was cancelled', 'NotAllowedError'),
    );

    render(
      <PamRespondModal request={requestFixture()} onClose={() => {}} onActioned={() => {}} />,
    );

    fireEvent.submit(screen.getByTestId('pam-respond-submit').closest('form')!);

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    // The respond endpoint must NOT have been called after a cancelled ceremony.
    expect(
      fetchWithAuthMock.mock.calls.some((c) =>
        String(c[0]).includes('/pam/elevation-requests/er-9/respond'),
      ),
    ).toBe(false);
  });
});
