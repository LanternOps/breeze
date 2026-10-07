import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, within, waitFor, fireEvent } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

const orgScopeState: { scope: 'org' | 'all'; orgId: string | null } = { scope: 'org', orgId: 'org-1' };
vi.mock('@/hooks/useOrgScope', () => ({
  useOrgScope: () => ({
    ready: true,
    status: 'resolved',
    scope: orgScopeState.scope,
    orgId: orgScopeState.orgId,
    org: null,
    error: null,
  }),
}));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (a: unknown) => showToast(a) }));

const { mintStepUpGrant, StepUpMintError } = vi.hoisted(() => {
  const mintStepUpGrant = vi.fn();
  class StepUpMintError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.name = 'StepUpMintError';
    }
  }
  return { mintStepUpGrant, StepUpMintError };
});
vi.mock('../../lib/mfaStepUp', () => ({
  mintStepUpGrant: (...a: unknown[]) => mintStepUpGrant(...a),
  StepUpMintError,
}));

import ScriptAuthoringPage from './ScriptAuthoringPage';

function renderPage() {
  const { container, ...utils } = render(<ScriptAuthoringPage />);
  return { container, ...utils, ...within(container) };
}

function jsonRes(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const EFFECTIVE = {
  proposingEnabled: true,
  unattendedEnabled: false,
  maxUnattendedRiskTier: 'low' as const,
  unattendedAllowedClasses: ['temp_files', 'printing'],
  maxUnattendedPerHour: 10,
};

const LANE_CLOSED = {
  state: 'closed' as const,
  consecutiveFailedVerifications: 0,
  openedAt: null,
  openedReason: null,
  resetAt: null,
};

const LANE_OPEN = {
  state: 'open' as const,
  consecutiveFailedVerifications: 3,
  openedAt: '2026-09-10T00:00:00.000Z',
  openedReason: 'Three consecutive unattended verifications failed.',
  resetAt: null,
};

function orgGetBody(overrides: Partial<{ policy: unknown; effective: unknown; partnerCeilingPresent: boolean; laneState: unknown }> = {}) {
  return {
    policy: null,
    effective: EFFECTIVE,
    partnerCeilingPresent: true,
    laneState: LANE_CLOSED,
    ...overrides,
  };
}

function partnerGetBody(canManage: boolean, policy: unknown = null) {
  return { policy, canManage, partnerId: PARTNER_ID };
}

const PARTNER_ID = '22222222-2222-4222-8222-222222222222';
const STEP_UP_403 = { error: 'Step-up required', code: 'STEP_UP_REQUIRED' };

/** A PUT handler that 403s STEP_UP_REQUIRED unless the body carries a grant —
 *  what a 2FA-on API answers for an enabling/widening save. */
function grantGatedPut(init: RequestInit): Promise<Response> {
  const body = JSON.parse(String(init.body));
  return Promise.resolve(body.stepUpGrant ? jsonRes({ policy: body }, 200) : jsonRes(STEP_UP_403, 403));
}

function putCalls(url: string) {
  return fetchWithAuth.mock.calls
    .filter(([u, init]) => u === url && (init as RequestInit | undefined)?.method === 'PUT')
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)) as Record<string, any>);
}

const PARTNER_POLICY_ALLOWED = {
  ownerScope: 'partner',
  proposingEnabled: true,
  unattendedAllowed: true,
  maxUnattendedRiskTier: 'low',
  unattendedAllowedClasses: ['temp_files'],
  maxUnattendedPerHour: 5,
  protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
  unattendedEnabledAt: null,
};

function mockRoutes(opts: {
  org?: unknown;
  orgStatus?: number;
  partner?: unknown;
  partnerStatus?: number;
  usersMe?: unknown;
  passkeys?: unknown;
  orgPutGated?: boolean;
  partnerPutGated?: boolean;
}) {
  const {
    org = orgGetBody(),
    orgStatus = 200,
    partner = partnerGetBody(false),
    partnerStatus = 200,
    usersMe = { mfaMethod: null },
    passkeys = { passkeys: [{ id: 'pk-1' }] },
    orgPutGated = false,
    partnerPutGated = false,
  } = opts;

  fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/ai/script-policy' && (!init || init.method === undefined)) {
      return Promise.resolve(jsonRes(org, orgStatus));
    }
    if (url === '/ai/script-policy' && init?.method === 'PUT') {
      if (orgPutGated) return grantGatedPut(init);
      return Promise.resolve(jsonRes({ policy: JSON.parse(String(init.body)) }, 200));
    }
    if (url === '/partner/ai/script-policy' && (!init || init.method === undefined)) {
      return Promise.resolve(jsonRes(partner, partnerStatus));
    }
    if (url === '/partner/ai/script-policy' && init?.method === 'PUT') {
      if (partnerPutGated) return grantGatedPut(init);
      return Promise.resolve(jsonRes({ policy: JSON.parse(String(init.body)) }, 200));
    }
    if (url === '/ai/script-lane/reset') {
      return Promise.resolve(jsonRes({ laneState: LANE_CLOSED }, 200));
    }
    if (url === '/users/me') return Promise.resolve(jsonRes(usersMe));
    if (url === '/auth/passkeys') return Promise.resolve(jsonRes(passkeys));
    return Promise.resolve(jsonRes({}, 404));
  });
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  showToast.mockReset();
  mintStepUpGrant.mockReset();
  mintStepUpGrant.mockResolvedValue('grant-1');
  orgScopeState.scope = 'org';
  orgScopeState.orgId = 'org-1';
});

describe('ScriptAuthoringPage', () => {
  it('renders the partner ceiling card and the org grant card', async () => {
    mockRoutes({});
    const { getByTestId } = renderPage();
    await waitFor(() => expect(getByTestId('script-authoring-org-card')).toBeInTheDocument());
    expect(getByTestId('script-authoring-partner-card')).toBeInTheDocument();
  });

  it('disables a class the partner ceiling does not allow, and says why', async () => {
    mockRoutes({});
    const { getByTestId } = renderPage();
    await waitFor(() => expect(getByTestId('script-authoring-org-card')).toBeInTheDocument());

    // "packages" is not in EFFECTIVE.unattendedAllowedClasses, so the partner
    // ceiling forbids it even though it isn't hard-denied.
    const checkbox = getByTestId('script-class-packages') as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
    const reason = getByTestId('script-class-packages-reason');
    expect(reason.textContent?.toLowerCase()).toContain('partner');
  });

  it('never offers a hard-denied class as selectable', async () => {
    mockRoutes({});
    const { getByTestId } = renderPage();
    await waitFor(() => expect(getByTestId('script-authoring-org-card')).toBeInTheDocument());

    const checkbox = getByTestId('script-class-credentials') as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
  });

  it('mints a step-up grant before enabling, and sends it with the PUT', async () => {
    mockRoutes({ usersMe: { mfaMethod: null }, passkeys: { passkeys: [{ id: 'pk-1' }] } });
    const { getByTestId } = renderPage();
    await waitFor(() => expect(getByTestId('script-authoring-org-card')).toBeInTheDocument());

    fireEvent.click(getByTestId('script-unattended-enabled'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/users/me'));

    fireEvent.click(getByTestId('script-authoring-save'));

    await waitFor(() => expect(mintStepUpGrant).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'ai_script_lane_grant' }),
    ));

    await waitFor(() => {
      const putCall = fetchWithAuth.mock.calls.find(
        ([url, init]) => url === '/ai/script-policy' && (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(String((putCall![1] as RequestInit).body));
      expect(body).toEqual(expect.objectContaining({ unattendedEnabled: true, stepUpGrant: 'grant-1' }));
    });
  });

  it('binds the enable grant to the exact values the PUT saves, so the server digest matches (#7873)', async () => {
    mockRoutes({ usersMe: { mfaMethod: null }, passkeys: { passkeys: [{ id: 'pk-1' }] } });
    const { getByTestId } = renderPage();
    await waitFor(() => expect(getByTestId('script-authoring-org-card')).toBeInTheDocument());

    fireEvent.click(getByTestId('script-unattended-enabled'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith('/users/me'));
    fireEvent.click(getByTestId('script-authoring-save'));

    let putBody: Record<string, any> | undefined;
    await waitFor(() => {
      const putCall = fetchWithAuth.mock.calls.find(
        ([url, init]) => url === '/ai/script-policy' && (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      putBody = JSON.parse(String((putCall![1] as RequestInit).body));
    });

    // The server's enable branch hashes the FULL effective values being saved
    // into the grant digest; a grant minted without them never matches.
    expect(mintStepUpGrant).toHaveBeenCalledTimes(1);
    const { resource } = mintStepUpGrant.mock.calls[0]![0] as { resource: Record<string, unknown> };
    const pr = putBody!.protectedResources as Record<string, string[]>;
    expect(resource).toEqual({
      orgId: 'org-1',
      unattendedEnabled: true,
      widening: {
        maxUnattendedRiskTier: putBody!.maxUnattendedRiskTier,
        unattendedAllowedClasses: putBody!.unattendedAllowedClasses,
        maxUnattendedPerHour: putBody!.maxUnattendedPerHour,
        protectedResourcesEmptied: Object.values(pr).every((list) => list.length === 0),
        proposingEnabled: putBody!.proposingEnabled,
      },
    });
  });

  it('does not mint a grant when turning the lane off', async () => {
    mockRoutes({
      org: orgGetBody({ policy: {
        ownerScope: 'organization',
        proposingEnabled: true,
        unattendedEnabled: true,
        maxUnattendedRiskTier: 'low',
        unattendedAllowedClasses: ['temp_files'],
        maxUnattendedPerHour: 5,
        protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
        unattendedEnabledAt: '2026-09-01T00:00:00.000Z',
      } }),
    });
    const { getByTestId } = renderPage();
    await waitFor(() => expect(getByTestId('script-authoring-org-card')).toBeInTheDocument());

    const checkbox = getByTestId('script-unattended-enabled') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);

    fireEvent.click(getByTestId('script-authoring-save'));

    await waitFor(() => {
      const putCall = fetchWithAuth.mock.calls.find(
        ([url, init]) => url === '/ai/script-policy' && (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(String((putCall![1] as RequestInit).body));
      expect(body.unattendedEnabled).toBe(false);
      expect(body.stepUpGrant).toBeUndefined();
    });
    expect(mintStepUpGrant).not.toHaveBeenCalled();
  });

  it('omits unattendedEnabled from a save that leaves an already-enabled lane on (#7873)', async () => {
    // The server treats `unattendedEnabled: true` in a body as the enable
    // transition and demands a step-up grant for it. Re-sending the unchanged
    // value would 403 every later save of an enabled lane, even a tightening one.
    mockRoutes({
      org: orgGetBody({ policy: {
        ownerScope: 'organization',
        proposingEnabled: true,
        unattendedEnabled: true,
        maxUnattendedRiskTier: 'low',
        unattendedAllowedClasses: ['temp_files'],
        maxUnattendedPerHour: 5,
        protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
        unattendedEnabledAt: '2026-09-01T00:00:00.000Z',
      } }),
    });
    const { getByTestId } = renderPage();
    await waitFor(() => expect(getByTestId('script-authoring-org-card')).toBeInTheDocument());
    expect((getByTestId('script-unattended-enabled') as HTMLInputElement).checked).toBe(true);

    fireEvent.click(getByTestId('script-authoring-save'));

    await waitFor(() => {
      const putCall = fetchWithAuth.mock.calls.find(
        ([url, init]) => url === '/ai/script-policy' && (init as RequestInit | undefined)?.method === 'PUT',
      );
      expect(putCall).toBeDefined();
      const body = JSON.parse(String((putCall![1] as RequestInit).body));
      expect(body).not.toHaveProperty('unattendedEnabled');
      expect(body.stepUpGrant).toBeUndefined();
      expect(body.maxUnattendedPerHour).toBe(5);
    });
    expect(mintStepUpGrant).not.toHaveBeenCalled();
  });

  it('shows the paused banner with the reason and a reset button when the lane is open', async () => {
    mockRoutes({ org: orgGetBody({ laneState: LANE_OPEN }) });
    const { getByTestId } = renderPage();
    await waitFor(() => expect(getByTestId('script-lane-banner')).toBeInTheDocument());
    expect(getByTestId('script-lane-banner').textContent).toContain(LANE_OPEN.openedReason);
    expect(getByTestId('script-lane-reset')).toBeInTheDocument();
  });

  it('hides the reset button when the lane is closed', async () => {
    mockRoutes({ org: orgGetBody({ laneState: LANE_CLOSED }) });
    const { queryByTestId, getByTestId } = renderPage();
    await waitFor(() => expect(getByTestId('script-authoring-org-card')).toBeInTheDocument());
    expect(queryByTestId('script-lane-banner')).toBeNull();
    expect(queryByTestId('script-lane-reset')).toBeNull();
  });

  it('asks a TOTP approver for a code before resetting an open lane, and sends it', async () => {
    mockRoutes({
      org: orgGetBody({
        laneState: LANE_OPEN,
        policy: {
          ownerScope: 'organization',
          proposingEnabled: true,
          unattendedEnabled: true,
          maxUnattendedRiskTier: 'low',
          unattendedAllowedClasses: ['temp_files'],
          maxUnattendedPerHour: 5,
          protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
          unattendedEnabledAt: '2026-09-01T00:00:00.000Z',
        },
      }),
      usersMe: { mfaMethod: 'totp' },
      passkeys: { passkeys: [] },
    });
    const { getByTestId } = renderPage();
    await waitFor(() => expect(getByTestId('script-lane-banner')).toBeInTheDocument());

    // First click resolves the factor and reveals the code box — it must NOT
    // mint with an empty code (issue #5683: the mint 400s `Invalid code`).
    fireEvent.click(getByTestId('script-lane-reset'));

    const codeInput = await waitFor(() =>
      within(getByTestId('script-lane-banner')).getByTestId('approver-stepup-code'),
    ) as HTMLInputElement;
    expect(mintStepUpGrant).not.toHaveBeenCalled();

    fireEvent.change(codeInput, { target: { value: '123456' } });
    fireEvent.click(getByTestId('script-lane-reset'));

    await waitFor(() => expect(mintStepUpGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'ai_script_lane_grant',
        reauth: { method: 'totp', code: '123456' },
      }),
    ));

    await waitFor(() => {
      const resetCall = fetchWithAuth.mock.calls.find(([url]) => url === '/ai/script-lane/reset');
      expect(resetCall).toBeDefined();
      expect(JSON.parse(String((resetCall![1] as RequestInit).body))).toEqual({ stepUpGrant: 'grant-1' });
    });
  });

  it('disables the reset button while it resolves the reauth factor', async () => {
    let releaseUsersMe: (() => void) | null = null;
    const usersMeGate = new Promise<void>((resolve) => { releaseUsersMe = resolve; });
    mockRoutes({
      org: orgGetBody({ laneState: LANE_OPEN }),
      usersMe: { mfaMethod: 'totp' },
      passkeys: { passkeys: [] },
    });
    const base = fetchWithAuth.getMockImplementation()!;
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/users/me') { await usersMeGate; }
      return base(url, init);
    });

    const { getByTestId } = renderPage();
    await waitFor(() => expect(getByTestId('script-lane-banner')).toBeInTheDocument());

    fireEvent.click(getByTestId('script-lane-reset'));
    // The factor round trip happens BEFORE the mint, so the button must read as
    // busy for it — otherwise a double-click fires concurrent resets (#5683).
    await waitFor(() => expect((getByTestId('script-lane-reset') as HTMLButtonElement).disabled).toBe(true));
    releaseUsersMe!();
    await waitFor(() => expect((getByTestId('script-lane-reset') as HTMLButtonElement).disabled).toBe(false));
    expect(mintStepUpGrant).not.toHaveBeenCalled();
  });

  it('surfaces a save failure instead of failing silently', async () => {
    mockRoutes({});
    fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/ai/script-policy' && init?.method === 'PUT') {
        return Promise.resolve(jsonRes({ error: 'above_partner_ceiling', field: 'maxUnattendedPerHour' }, 422));
      }
      if (url === '/ai/script-policy') return Promise.resolve(jsonRes(orgGetBody()));
      if (url === '/partner/ai/script-policy') return Promise.resolve(jsonRes(partnerGetBody(false)));
      return Promise.resolve(jsonRes({}, 404));
    });
    const { getByTestId } = renderPage();
    await waitFor(() => expect(getByTestId('script-authoring-org-card')).toBeInTheDocument());

    fireEvent.click(getByTestId('script-authoring-save'));

    await waitFor(() => expect(getByTestId('script-authoring-error')).toBeInTheDocument());
  });

  it('renders the partner card read-only for an org-scoped user', async () => {
    mockRoutes({ partnerStatus: 403, partner: { error: 'forbidden' } });
    const { getByTestId, queryByTestId } = renderPage();
    await waitFor(() => expect(getByTestId('script-authoring-partner-card')).toBeInTheDocument());
    expect(queryByTestId('script-partner-save')).toBeNull();
  });

  it('replaces both reviewer model fields with the script_reviewer pointer', async () => {
    mockRoutes({ partner: partnerGetBody(true) });
    const { getByTestId, queryByTestId, findAllByTestId } = renderPage();
    await waitFor(() => expect(getByTestId('script-authoring-org-card')).toBeInTheDocument());
    expect(queryByTestId('script-reviewer-model')).toBeNull();
    expect(document.querySelectorAll('input[type="text"]:not([data-testid])').length).toBe(0);
    // One pointer in the org card, one in the partner card.
    expect((await findAllByTestId('model-defaults-link-script_reviewer')).length).toBe(2);
  });

  it('org and partner saves no longer send reviewerModel', async () => {
    mockRoutes({ partner: partnerGetBody(true) });
    const { getByTestId } = renderPage();
    await waitFor(() => expect(getByTestId('script-authoring-org-card')).toBeInTheDocument());

    fireEvent.click(getByTestId('script-authoring-save'));
    await waitFor(() => expect(fetchWithAuth.mock.calls.some(
      ([url, init]) => url === '/ai/script-policy' && (init as RequestInit | undefined)?.method === 'PUT')).toBe(true));
    fireEvent.click(getByTestId('script-partner-save'));
    await waitFor(() => expect(fetchWithAuth.mock.calls.some(
      ([url, init]) => url === '/partner/ai/script-policy' && (init as RequestInit | undefined)?.method === 'PUT')).toBe(true));

    for (const target of ['/ai/script-policy', '/partner/ai/script-policy']) {
      const put = fetchWithAuth.mock.calls.find(([url, init]) => url === target && (init as RequestInit | undefined)?.method === 'PUT');
      const body = JSON.parse(String((put![1] as RequestInit).body));
      expect(body).toHaveProperty('maxUnattendedPerHour');
      expect(body).not.toHaveProperty('reviewerModel');
    }
  });

  describe('partner ceiling step-up (#8112)', () => {
    it('reveals the TOTP code box when the server asks for step-up, then mints a ceiling grant bound to the saved values', async () => {
      mockRoutes({ partner: partnerGetBody(true), partnerPutGated: true, usersMe: { mfaMethod: 'totp' }, passkeys: { passkeys: [] } });
      const { getByTestId, queryByTestId } = renderPage();
      await waitFor(() => expect(getByTestId('script-partner-save')).toBeInTheDocument());

      fireEvent.click(getByTestId('script-partner-unattended-allowed'));
      fireEvent.click(getByTestId('script-partner-save'));

      // First attempt carries no grant; the 403 opens the prompt, not a toast.
      await waitFor(() => expect(getByTestId('script-partner-stepup')).toBeInTheDocument());
      expect(putCalls('/partner/ai/script-policy')[0]).not.toHaveProperty('stepUpGrant');
      expect(showToast).not.toHaveBeenCalled();
      expect(queryByTestId('script-authoring-error')).toBeNull();
      expect(mintStepUpGrant).not.toHaveBeenCalled();

      // Saving with an empty code does nothing — the box is already showing.
      fireEvent.click(getByTestId('script-partner-save'));
      expect(mintStepUpGrant).not.toHaveBeenCalled();

      fireEvent.change(within(getByTestId('script-partner-stepup')).getByTestId('approver-stepup-code'), { target: { value: '123456' } });
      fireEvent.click(getByTestId('script-partner-save'));

      await waitFor(() => expect(putCalls('/partner/ai/script-policy')).toHaveLength(2));
      const second = putCalls('/partner/ai/script-policy')[1]!;
      expect(second).toMatchObject({ unattendedAllowed: true, stepUpGrant: 'grant-1' });
      expect(mintStepUpGrant).toHaveBeenCalledTimes(1);
      expect(mintStepUpGrant).toHaveBeenCalledWith({
        operation: 'ai_partner_script_ceiling_grant',
        reauth: { method: 'totp', code: '123456' },
        resource: {
          partnerId: PARTNER_ID,
          unattendedAllowed: true,
          widening: {
            maxUnattendedRiskTier: second.maxUnattendedRiskTier,
            unattendedAllowedClasses: second.unattendedAllowedClasses,
            maxUnattendedPerHour: second.maxUnattendedPerHour,
            protectedResourcesEmptied: true,
            proposingEnabled: second.proposingEnabled,
          },
        },
      });
      await waitFor(() => expect(queryByTestId('script-partner-stepup')).toBeNull());
    });

    it('a passkey approver gets the ceremony note and the grant mints with the passkey', async () => {
      mockRoutes({ partner: partnerGetBody(true), partnerPutGated: true, usersMe: { mfaMethod: null }, passkeys: { passkeys: [{ id: 'pk-1' }] } });
      const { getByTestId } = renderPage();
      await waitFor(() => expect(getByTestId('script-partner-save')).toBeInTheDocument());

      fireEvent.click(getByTestId('script-partner-unattended-allowed'));
      fireEvent.click(getByTestId('script-partner-save'));
      await waitFor(() => expect(within(getByTestId('script-partner-stepup')).getByTestId('approver-stepup-passkey-note')).toBeInTheDocument());

      fireEvent.click(getByTestId('script-partner-save'));
      await waitFor(() => expect(putCalls('/partner/ai/script-policy')).toHaveLength(2));
      expect(mintStepUpGrant).toHaveBeenCalledWith(expect.objectContaining({
        operation: 'ai_partner_script_ceiling_grant',
        reauth: { method: 'passkey' },
      }));
      expect(putCalls('/partner/ai/script-policy')[1]).toMatchObject({ stepUpGrant: 'grant-1' });
    });

    it('binds a widening save of an already-allowed ceiling to the widening delta, and omits the unchanged switch', async () => {
      mockRoutes({ partner: partnerGetBody(true, PARTNER_POLICY_ALLOWED), partnerPutGated: true, usersMe: { mfaMethod: 'totp' }, passkeys: { passkeys: [] } });
      const { getByTestId } = renderPage();
      await waitFor(() => expect(getByTestId('script-partner-save')).toBeInTheDocument());

      fireEvent.click(getByTestId('script-partner-class-printing'));
      fireEvent.click(getByTestId('script-partner-save'));
      await waitFor(() => expect(getByTestId('script-partner-stepup')).toBeInTheDocument());
      fireEvent.change(within(getByTestId('script-partner-stepup')).getByTestId('approver-stepup-code'), { target: { value: '654321' } });
      fireEvent.click(getByTestId('script-partner-save'));

      await waitFor(() => expect(putCalls('/partner/ai/script-policy')).toHaveLength(2));
      for (const body of putCalls('/partner/ai/script-policy')) expect(body).not.toHaveProperty('unattendedAllowed');
      const { resource } = mintStepUpGrant.mock.calls[0]![0] as { resource: Record<string, unknown> };
      expect(resource).toEqual({
        partnerId: PARTNER_ID,
        unattendedAllowed: true,
        widening: {
          maxUnattendedRiskTier: 'low',
          unattendedAllowedClasses: ['temp_files', 'printing'],
          maxUnattendedPerHour: 5,
          // The widen branch hashes the non-empty → empty TRANSITION, which
          // did not happen here — not "is empty" as the enable branch does.
          protectedResourcesEmptied: false,
          proposingEnabled: true,
        },
      });
    });

    it('a non-widening save of an allowed ceiling goes straight through with no grant', async () => {
      mockRoutes({ partner: partnerGetBody(true, PARTNER_POLICY_ALLOWED) });
      const { getByTestId } = renderPage();
      await waitFor(() => expect(getByTestId('script-partner-save')).toBeInTheDocument());

      fireEvent.click(getByTestId('script-partner-save'));
      await waitFor(() => expect(putCalls('/partner/ai/script-policy')).toHaveLength(1));
      const body = putCalls('/partner/ai/script-policy')[0]!;
      expect(body).not.toHaveProperty('unattendedAllowed');
      expect(body).not.toHaveProperty('stepUpGrant');
      expect(mintStepUpGrant).not.toHaveBeenCalled();
    });

    it('a 2FA-off deployment (no STEP_UP_REQUIRED) enables the ceiling in one save with no prompt', async () => {
      mockRoutes({ partner: partnerGetBody(true) });
      const { getByTestId, queryByTestId } = renderPage();
      await waitFor(() => expect(getByTestId('script-partner-save')).toBeInTheDocument());

      fireEvent.click(getByTestId('script-partner-unattended-allowed'));
      fireEvent.click(getByTestId('script-partner-save'));
      await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
      expect(putCalls('/partner/ai/script-policy')).toHaveLength(1);
      expect(putCalls('/partner/ai/script-policy')[0]).toMatchObject({ unattendedAllowed: true });
      expect(mintStepUpGrant).not.toHaveBeenCalled();
      expect(queryByTestId('script-partner-stepup')).toBeNull();
    });

    it('surfaces a repeat STEP_UP_REQUIRED instead of silently re-opening the prompt', async () => {
      // No partnerId from the GET (version skew): the page cannot build a grant,
      // so the second Save is grant-less again and the server 403s again.
      mockRoutes({ partner: { ...partnerGetBody(true), partnerId: undefined }, partnerPutGated: true, usersMe: { mfaMethod: null }, passkeys: { passkeys: [{ id: 'pk-1' }] } });
      const { getByTestId } = renderPage();
      await waitFor(() => expect(getByTestId('script-partner-save')).toBeInTheDocument());

      fireEvent.click(getByTestId('script-partner-unattended-allowed'));
      fireEvent.click(getByTestId('script-partner-save'));
      await waitFor(() => expect(getByTestId('script-partner-stepup')).toBeInTheDocument());
      expect(showToast).not.toHaveBeenCalled();

      fireEvent.click(getByTestId('script-partner-save'));
      await waitFor(() => expect(putCalls('/partner/ai/script-policy')).toHaveLength(2));
      await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
      expect(getByTestId('script-authoring-error')).toBeInTheDocument();
      expect(mintStepUpGrant).not.toHaveBeenCalled();
    });

    it('does not blame the account when factor discovery itself fails', async () => {
      mockRoutes({ partner: partnerGetBody(true), partnerPutGated: true, usersMe: { mfaMethod: 'totp' } });
      const base = fetchWithAuth.getMockImplementation()!;
      fetchWithAuth.mockImplementation((url: string, init?: RequestInit) =>
        url === '/users/me' ? Promise.resolve(jsonRes({}, 500)) : base(url, init));
      const { getByTestId } = renderPage();
      await waitFor(() => expect(getByTestId('script-partner-save')).toBeInTheDocument());

      fireEvent.click(getByTestId('script-partner-unattended-allowed'));
      fireEvent.click(getByTestId('script-partner-save'));
      await waitFor(() => expect(getByTestId('script-authoring-error')).toBeInTheDocument());
      expect(getByTestId('script-authoring-error').textContent).not.toMatch(/authenticator app or passkey/);
    });

    it('tells an account with no usable factor why instead of showing an unusable prompt', async () => {
      mockRoutes({ partner: partnerGetBody(true), partnerPutGated: true, usersMe: { mfaMethod: null }, passkeys: { passkeys: [] } });
      const { getByTestId, queryByTestId } = renderPage();
      await waitFor(() => expect(getByTestId('script-partner-save')).toBeInTheDocument());

      fireEvent.click(getByTestId('script-partner-unattended-allowed'));
      fireEvent.click(getByTestId('script-partner-save'));
      await waitFor(() => expect(getByTestId('script-authoring-error')).toBeInTheDocument());
      expect(queryByTestId('script-partner-stepup')).toBeNull();
      expect(mintStepUpGrant).not.toHaveBeenCalled();
    });
  });

  it('reveals the org step-up on a WIDENING save the server gates, and binds the grant to the widening delta (#8096)', async () => {
    mockRoutes({
      org: orgGetBody({ policy: {
        ownerScope: 'organization',
        proposingEnabled: true,
        unattendedEnabled: true,
        maxUnattendedRiskTier: 'low',
        unattendedAllowedClasses: ['temp_files'],
        maxUnattendedPerHour: 5,
        protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
        unattendedEnabledAt: '2026-09-01T00:00:00.000Z',
      } }),
      orgPutGated: true,
      usersMe: { mfaMethod: 'totp' },
      passkeys: { passkeys: [] },
    });
    const { getByTestId } = renderPage();
    await waitFor(() => expect(getByTestId('script-authoring-org-card')).toBeInTheDocument());

    fireEvent.click(getByTestId('script-class-printing'));
    fireEvent.click(getByTestId('script-authoring-save'));
    await waitFor(() => expect(getByTestId('script-org-stepup')).toBeInTheDocument());
    expect(showToast).not.toHaveBeenCalled();
    expect(mintStepUpGrant).not.toHaveBeenCalled();

    fireEvent.change(within(getByTestId('script-org-stepup')).getByTestId('approver-stepup-code'), { target: { value: '111222' } });
    fireEvent.click(getByTestId('script-authoring-save'));
    await waitFor(() => expect(putCalls('/ai/script-policy')).toHaveLength(2));
    expect(putCalls('/ai/script-policy')[1]).toMatchObject({ stepUpGrant: 'grant-1' });
    expect(putCalls('/ai/script-policy')[1]).not.toHaveProperty('unattendedEnabled');
    expect(mintStepUpGrant).toHaveBeenCalledWith({
      operation: 'ai_script_lane_grant',
      reauth: { method: 'totp', code: '111222' },
      resource: {
        orgId: 'org-1',
        unattendedEnabled: true,
        widening: {
          maxUnattendedRiskTier: 'low',
          unattendedAllowedClasses: ['temp_files', 'printing'],
          maxUnattendedPerHour: 5,
          protectedResourcesEmptied: false,
          proposingEnabled: true,
        },
      },
    });
  });
});
