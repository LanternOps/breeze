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

function partnerGetBody(canManage: boolean) {
  return { policy: null, canManage };
}

function mockRoutes(opts: {
  org?: unknown;
  orgStatus?: number;
  partner?: unknown;
  partnerStatus?: number;
  usersMe?: unknown;
  passkeys?: unknown;
}) {
  const {
    org = orgGetBody(),
    orgStatus = 200,
    partner = partnerGetBody(false),
    partnerStatus = 200,
    usersMe = { mfaMethod: null },
    passkeys = { passkeys: [{ id: 'pk-1' }] },
  } = opts;

  fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/ai/script-policy' && (!init || init.method === undefined)) {
      return Promise.resolve(jsonRes(org, orgStatus));
    }
    if (url === '/ai/script-policy' && init?.method === 'PUT') {
      return Promise.resolve(jsonRes({ policy: JSON.parse(String(init.body)) }, 200));
    }
    if (url === '/partner/ai/script-policy' && (!init || init.method === undefined)) {
      return Promise.resolve(jsonRes(partner, partnerStatus));
    }
    if (url === '/partner/ai/script-policy' && init?.method === 'PUT') {
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
        reviewerModel: null,
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
});
