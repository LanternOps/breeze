import '@/lib/i18n';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { moveMock, mintMock, fetchMock, canMock, orgState } = vi.hoisted(() => ({
  moveMock: vi.fn(),
  mintMock: vi.fn(),
  fetchMock: vi.fn(),
  canMock: vi.fn(),
  orgState: {
    organizations: [
      { id: 'o1', name: 'Current Org', status: 'active' },
      { id: 'o2', name: 'Target Org', status: 'active' },
      { id: 'o3', name: 'Archived Org', status: 'archived' },
    ],
    fetchOrganizations: vi.fn(async () => undefined),
  },
}));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: fetchMock }));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: typeof orgState) => unknown) => selector(orgState),
}));
vi.mock('@/lib/permissions', () => ({ usePermissions: () => ({ permissions: [], can: canMock }) }));
vi.mock('../../services/deviceActions', () => ({
  moveDeviceOrg: moveMock,
  DeviceActionError: class DeviceActionError extends Error {
    constructor(message: string, readonly status: number, readonly code?: string, readonly details?: unknown) {
      super(message);
    }
  },
}));
vi.mock('../../lib/mfaStepUp', () => ({
  mintStepUpGrant: mintMock,
  StepUpMintError: class StepUpMintError extends Error {
    constructor(readonly code: string, message: string) {
      super(message);
    }
  },
}));

import MoveDeviceOrgDialog from './MoveDeviceOrgDialog';

const DEVICE = { id: 'd1', hostname: 'host-a', orgId: 'o1', orgName: 'Current Org' };
const stepUpDenial = Object.assign(new Error('Step-up required'), { status: 403, code: 'STEP_UP_REQUIRED' });
const RESOURCE = { deviceId: 'd1', targetOrgId: 'o2', targetSiteId: 's2', acceptCurrencyMismatch: false };

function renderDialog(props: Partial<React.ComponentProps<typeof MoveDeviceOrgDialog>> = {}) {
  return render(
    <MoveDeviceOrgDialog open device={DEVICE} onClose={vi.fn()} onCompleted={vi.fn()} {...props} />,
  );
}

async function chooseTarget() {
  await userEvent.selectOptions(screen.getByTestId('move-org-target-org'), 'o2');
  await userEvent.selectOptions(await screen.findByTestId('move-org-target-site'), 's2');
}

describe('MoveDeviceOrgDialog (device move-org step-up D5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canMock.mockReturnValue(false);
    fetchMock.mockImplementation(async (path: string) => ({
      ok: true,
      json: async () => {
        if (path === '/users/me') return { mfaMethod: 'totp' };
        if (path === '/auth/passkeys') return { passkeys: [] };
        if (path.startsWith('/orgs/sites?organizationId=o2')) return { data: [{ id: 's2', name: 'Site Two', orgId: 'o2' }] };
        return {};
      },
    }));
  });

  it('offers only OTHER active/trial organizations as targets', () => {
    renderDialog();
    const options = Array.from(screen.getByTestId('move-org-target-org').querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toContain('Target Org');
    expect(options).not.toContain('Current Org');
    expect(options).not.toContain('Archived Org');
  });

  it('loads the chosen organization\'s sites and disables submit until both are chosen', async () => {
    renderDialog();
    expect(screen.getByTestId('move-org-submit')).toBeDisabled();
    await userEvent.selectOptions(screen.getByTestId('move-org-target-org'), 'o2');
    // Without an explicit limit the route defaults to 50 (utils/pagination.ts),
    // so an org with more sites than that has targets the tech cannot select at
    // all. `fetchAllSites` (#6412) pages to exhaustion at the route's max
    // (100) instead of a single fixed limit, so the request carries explicit
    // `page`/`limit` params.
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/orgs/sites?organizationId=o2&page=1&limit=100', undefined),
    );
    expect(screen.getByTestId('move-org-submit')).toBeDisabled();
    await userEvent.selectOptions(await screen.findByTestId('move-org-target-site'), 's2');
    expect(screen.getByTestId('move-org-submit')).toBeEnabled();
  });

  it('submits WITHOUT a grant first, then reveals the factor step on 403 STEP_UP_REQUIRED', async () => {
    moveMock.mockRejectedValueOnce(stepUpDenial);
    renderDialog();
    await chooseTarget();
    await userEvent.click(screen.getByTestId('move-org-submit'));

    await waitFor(() => expect(screen.getByTestId('move-org-stepup-code')).toBeInTheDocument());
    expect(moveMock.mock.calls[0]).toEqual(['d1', { orgId: 'o2', siteId: 's2', acceptCurrencyMismatch: false }]);
    expect(mintMock).not.toHaveBeenCalled();
  });

  it('mints against the SAME canonical resource it submitted, then resubmits carrying the grant', async () => {
    moveMock.mockRejectedValueOnce(stepUpDenial).mockResolvedValueOnce({ success: true, device: null });
    mintMock.mockResolvedValueOnce('grant-1');
    const onCompleted = vi.fn();
    renderDialog({ onCompleted });
    await chooseTarget();
    await userEvent.click(screen.getByTestId('move-org-submit'));
    await userEvent.type(await screen.findByTestId('move-org-stepup-code'), '123456');
    await userEvent.click(screen.getByTestId('move-org-submit'));

    await waitFor(() => expect(moveMock).toHaveBeenCalledTimes(2));
    // Whole-object equality: an added or dropped field would change the server digest.
    expect(mintMock).toHaveBeenCalledWith({
      operation: 'device_move_org',
      resource: RESOURCE,
      reauth: { method: 'totp', code: '123456' },
    });
    expect(moveMock.mock.calls[1]).toEqual([
      'd1',
      { orgId: 'o2', siteId: 's2', acceptCurrencyMismatch: false, stepUpGrant: 'grant-1' },
    ]);
    await waitFor(() => expect(onCompleted).toHaveBeenCalledWith({ targetOrgId: 'o2', targetOrgName: 'Target Org' }));
  });

  it('a grant-carrying resubmit refused with STEP_UP_REQUIRED again says so instead of silently emptying the code', async () => {
    // The route answers a consumed / raced / epoch-bumped grant with the same
    // 403 body as a missing one (MoveOrgStepUpConsumedError in moveOrg.ts).
    moveMock.mockRejectedValueOnce(stepUpDenial).mockRejectedValueOnce(stepUpDenial);
    mintMock.mockResolvedValueOnce('grant-1');
    renderDialog();
    await chooseTarget();
    await userEvent.click(screen.getByTestId('move-org-submit'));
    await userEvent.type(await screen.findByTestId('move-org-stepup-code'), '123456');
    await userEvent.click(screen.getByTestId('move-org-submit'));

    await waitFor(() => expect(moveMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('move-org-error')).toHaveTextContent(/fresh/i);
    expect(screen.getByTestId('move-org-stepup-code')).toHaveValue('');
  });

  it('does not dispatch after cancellation during step-up', async () => {
    moveMock.mockRejectedValueOnce(stepUpDenial);
    let finish!: (grant: string) => void;
    mintMock.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const { unmount } = renderDialog();
    await chooseTarget();
    await userEvent.click(screen.getByTestId('move-org-submit'));
    await userEvent.type(await screen.findByTestId('move-org-stepup-code'), '123456');
    await userEvent.click(screen.getByTestId('move-org-submit'));
    await waitFor(() => expect(mintMock).toHaveBeenCalledOnce());
    unmount();
    await act(async () => finish('late-grant'));
    expect(moveMock).toHaveBeenCalledTimes(1);
  });

  it('shows the MFA copy, not the factor step, on 403 MFA_REQUIRED', async () => {
    moveMock.mockRejectedValueOnce(Object.assign(new Error('MFA required'), { status: 403, code: 'MFA_REQUIRED' }));
    renderDialog();
    await chooseTarget();
    await userEvent.click(screen.getByTestId('move-org-submit'));
    await waitFor(() => expect(screen.getByText(/complete mfa sign-in/i)).toBeInTheDocument());
    expect(screen.queryByTestId('move-org-stepup-code')).not.toBeInTheDocument();
  });

  it('a password-only account is only blocked after the server requests step-up', async () => {
    renderDialog({ passkeyCount: 0, mfaMethod: 'sms' });
    moveMock.mockRejectedValueOnce(stepUpDenial);
    await chooseTarget();
    await userEvent.click(screen.getByTestId('move-org-submit'));
    await screen.findByTestId('move-org-no-factor');
    expect(screen.getByText(/authenticator app or passkey/i)).toBeInTheDocument();
    expect(screen.queryByTestId('move-org-submit')).not.toBeInTheDocument();
  });

  it('discovers passkeys with omitted factor props and mints with the passkey ceremony', async () => {
    fetchMock.mockImplementation(async (path: string) => ({
      ok: true,
      json: async () => {
        if (path === '/users/me') return { mfaMethod: null };
        if (path === '/auth/passkeys') return { passkeys: [{ id: 'p1' }] };
        if (path.startsWith('/orgs/sites?organizationId=o2')) return { data: [{ id: 's2', name: 'Site Two', orgId: 'o2' }] };
        return {};
      },
    }));
    moveMock.mockRejectedValueOnce(stepUpDenial).mockResolvedValueOnce({ success: true, device: null });
    mintMock.mockResolvedValueOnce('passkey-grant');
    renderDialog();
    await chooseTarget();
    await userEvent.click(screen.getByTestId('move-org-submit'));
    await screen.findByTestId('move-org-stepup-passkey');
    expect(screen.queryByTestId('move-org-stepup-code')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('move-org-submit'));
    await waitFor(() => expect(mintMock).toHaveBeenCalledWith(expect.objectContaining({ reauth: { method: 'passkey' } })));
    expect(moveMock.mock.calls[1][1].stepUpGrant).toBe('passkey-grant');
  });

  it('shows discovery failure without guessing a factor or minting a grant', async () => {
    fetchMock.mockImplementation(async (path: string) =>
      path.startsWith('/orgs/sites')
        ? { ok: true, json: async () => ({ data: [{ id: 's2', name: 'Site Two', orgId: 'o2' }] }) }
        : { ok: false, json: async () => ({}) },
    );
    moveMock.mockRejectedValueOnce(stepUpDenial);
    renderDialog();
    await chooseTarget();
    await userEvent.click(screen.getByTestId('move-org-submit'));
    await screen.findByTestId('move-org-error');
    expect(screen.queryByTestId('move-org-stepup-code')).not.toBeInTheDocument();
    expect(mintMock).not.toHaveBeenCalled();
  });

  it('admits first-submit success without discovery even with no usable configured factor', async () => {
    moveMock.mockResolvedValueOnce({ success: true, device: null });
    const onCompleted = vi.fn();
    renderDialog({ passkeyCount: 0, mfaMethod: null, onCompleted });
    await chooseTarget();
    await userEvent.click(screen.getByTestId('move-org-submit'));
    await waitFor(() => expect(onCompleted).toHaveBeenCalled());
    expect(fetchMock).not.toHaveBeenCalledWith('/users/me');
    expect(mintMock).not.toHaveBeenCalled();
  });

  it('on 409 TICKET_MOVE_CURRENCY_BLOCKED offers the accept checkbox ONLY to invoices:write and re-mints against acceptCurrencyMismatch:true', async () => {
    canMock.mockImplementation((r: string, a: string) => r === 'invoices' && a === 'write');
    const details = { sourceCurrency: 'USD', targetCurrency: 'EUR', unbilledTimeEntries: 3, unbilledParts: 1, blockedByCurrency: [] };
    moveMock
      .mockRejectedValueOnce(Object.assign(new Error('Unbilled work'), { status: 409, code: 'TICKET_MOVE_CURRENCY_BLOCKED', details }))
      .mockRejectedValueOnce(stepUpDenial)
      .mockResolvedValueOnce({ success: true, device: null });
    mintMock.mockResolvedValueOnce('grant-2');
    renderDialog();
    await chooseTarget();
    await userEvent.click(screen.getByTestId('move-org-submit'));
    const accept = await screen.findByTestId('move-org-currency-accept');
    expect(screen.getByText(/USD → EUR/)).toBeInTheDocument();
    await userEvent.click(accept);
    await userEvent.click(screen.getByTestId('move-org-submit'));
    await userEvent.type(await screen.findByTestId('move-org-stepup-code'), '123456');
    await userEvent.click(screen.getByTestId('move-org-submit'));

    await waitFor(() => expect(moveMock).toHaveBeenCalledTimes(3));
    expect(moveMock.mock.calls[1][1]).toEqual({ orgId: 'o2', siteId: 's2', acceptCurrencyMismatch: true });
    expect(mintMock).toHaveBeenCalledWith(expect.objectContaining({ resource: { ...RESOURCE, acceptCurrencyMismatch: true } }));
    expect(moveMock.mock.calls[2][1]).toEqual({ orgId: 'o2', siteId: 's2', acceptCurrencyMismatch: true, stepUpGrant: 'grant-2' });
  });

  // The SHIPPED server order with 2FA on (routes/devices/moveOrg.ts): the grant
  // is validated and CONSUMED before the in-transaction currency guard runs, so
  // the 409 arrives on the resubmit that carried a grant — while the dialog is
  // in the step-up phase. The burned grant was bound to acceptCurrencyMismatch:
  // false, so the accept path needs a NEW grant for the new digest.
  it('a 409 currency block that arrives AFTER step-up returns to the form so the mismatch can be accepted and re-proved', async () => {
    canMock.mockImplementation((r: string, a: string) => r === 'invoices' && a === 'write');
    const details = { sourceCurrency: 'USD', targetCurrency: 'EUR', unbilledTimeEntries: 3, unbilledParts: 1, blockedByCurrency: [] };
    moveMock
      .mockRejectedValueOnce(stepUpDenial)
      .mockRejectedValueOnce(Object.assign(new Error('Unbilled work'), { status: 409, code: 'TICKET_MOVE_CURRENCY_BLOCKED', details }))
      .mockRejectedValueOnce(stepUpDenial)
      .mockResolvedValueOnce({ success: true, device: null });
    mintMock.mockResolvedValueOnce('grant-a').mockResolvedValueOnce('grant-b');
    const onCompleted = vi.fn();
    renderDialog({ onCompleted });
    await chooseTarget();
    await userEvent.click(screen.getByTestId('move-org-submit'));
    await userEvent.type(await screen.findByTestId('move-org-stepup-code'), '123456');
    await userEvent.click(screen.getByTestId('move-org-submit'));

    const accept = await screen.findByTestId('move-org-currency-accept');
    expect(accept).toBeEnabled();
    expect(screen.queryByTestId('move-org-stepup-code')).not.toBeInTheDocument();
    await userEvent.click(accept);
    await userEvent.click(screen.getByTestId('move-org-submit'));
    await userEvent.type(await screen.findByTestId('move-org-stepup-code'), '654321');
    await userEvent.click(screen.getByTestId('move-org-submit'));

    await waitFor(() => expect(onCompleted).toHaveBeenCalled());
    expect(mintMock.mock.calls[0][0].resource).toEqual(RESOURCE);
    expect(mintMock.mock.calls[1][0]).toEqual({
      operation: 'device_move_org',
      resource: { ...RESOURCE, acceptCurrencyMismatch: true },
      reauth: { method: 'totp', code: '654321' },
    });
    // The burned grant is never replayed; the accept submit goes out bare first.
    expect(moveMock.mock.calls[2][1]).toEqual({ orgId: 'o2', siteId: 's2', acceptCurrencyMismatch: true });
    expect(moveMock.mock.calls[3][1]).toEqual({ orgId: 'o2', siteId: 's2', acceptCurrencyMismatch: true, stepUpGrant: 'grant-b' });
  });

  it('on 409 TICKET_MOVE_CURRENCY_BLOCKED without invoices:write explains and offers no checkbox', async () => {
    const details = { sourceCurrency: 'USD', targetCurrency: 'EUR', unbilledTimeEntries: 3, unbilledParts: 1, blockedByCurrency: [] };
    moveMock.mockRejectedValueOnce(Object.assign(new Error('Unbilled work'), { status: 409, code: 'TICKET_MOVE_CURRENCY_BLOCKED', details }));
    renderDialog();
    await chooseTarget();
    await userEvent.click(screen.getByTestId('move-org-submit'));
    await screen.findByText(/invoice write permission/i);
    expect(screen.queryByTestId('move-org-currency-accept')).not.toBeInTheDocument();
  });

  it('surfaces a 409 PAM_DEVICE_MOVE_BLOCKED message verbatim', async () => {
    moveMock.mockRejectedValueOnce(Object.assign(
      new Error('Device organization move is blocked because durable PAM lifecycle evidence exists'),
      { status: 409, code: 'PAM_DEVICE_MOVE_BLOCKED' },
    ));
    renderDialog();
    await chooseTarget();
    await userEvent.click(screen.getByTestId('move-org-submit'));
    await waitFor(() => expect(screen.getByText(/durable PAM lifecycle evidence/)).toBeInTheDocument());
    expect(screen.queryByTestId('move-org-stepup-code')).not.toBeInTheDocument();
  });

  it('shows the no-other-org state when every other org is inactive', () => {
    orgState.organizations = [
      { id: 'o1', name: 'Current Org', status: 'active' },
      { id: 'o3', name: 'Archived Org', status: 'archived' },
    ];
    renderDialog();
    expect(screen.getByTestId('move-org-no-targets')).toBeInTheDocument();
    expect(screen.queryByTestId('move-org-submit')).not.toBeInTheDocument();
    orgState.organizations = [
      { id: 'o1', name: 'Current Org', status: 'active' },
      { id: 'o2', name: 'Target Org', status: 'active' },
      { id: 'o3', name: 'Archived Org', status: 'archived' },
    ];
  });
});
