import '@/lib/i18n';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { fetchMock, toastMock, orgState, capability } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  toastMock: vi.fn(),
  capability: { canReattach: true },
  orgState: {
    organizations: [{ id: 'org-a', name: 'Acme', status: 'active' }],
    fetchOrganizations: vi.fn(async () => undefined),
  },
}));

vi.mock('../../stores/auth', () => ({ fetchWithAuth: fetchMock }));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: typeof orgState) => unknown) => selector(orgState),
}));
vi.mock('@/lib/fetchAllSites', () => ({ fetchAllSites: vi.fn(async () => [{ id: 'site-1', name: 'HQ' }]) }));
vi.mock('../../lib/reattachCapability', () => ({ useCanReattachDevice: () => capability.canReattach }));
vi.mock('../../lib/mfaStepUp', () => ({
  mintStepUpGrant: vi.fn(),
  StepUpMintError: class StepUpMintError extends Error {},
}));
vi.mock('../shared/Toast', () => ({ showToast: toastMock }));

import AssignParkedDeviceDialog, { type ParkedDeviceSummary } from './AssignParkedDeviceDialog';
import type { ReinstallCandidatesView } from '../../lib/deviceReattach';
import {
  SOURCE_ID,
  TARGET_ID,
  candidatesView,
  json,
  reattachSource,
  requestedIntent,
} from './__tests__/reattachFixtures';

const parked: ParkedDeviceSummary = {
  id: SOURCE_ID,
  hostname: 'LAPTOP-NEW',
  osType: 'windows',
  osVersion: '11',
  serialNumber: 'SER-1',
  manufacturer: 'Dell',
  model: 'XPS 13',
  primaryMacAddress: 'aa:bb:cc:dd:ee:01',
};

const parkedView = (overrides: Partial<ReinstallCandidatesView> = {}) =>
  candidatesView({ source: reattachSource({ parked: true }), ...overrides });

function route(view: ReinstallCandidatesView | null, reattach?: Response) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === `/devices/${SOURCE_ID}/reinstall-candidates`) {
      return view ? json(200, view) : json(404, { error: 'Device not found' });
    }
    if (url === `/devices/${SOURCE_ID}/reattach` && init?.method === 'POST') return reattach ?? json(500, {});
    throw new Error(`unexpected fetch ${url}`);
  });
}

function renderDialog(props: { offerReattach?: boolean; devices?: ParkedDeviceSummary[] } = {}) {
  const onCompleted = vi.fn();
  const onClose = vi.fn();
  render(
    <AssignParkedDeviceDialog
      open
      devices={props.devices ?? [parked]}
      passkeyCount={0}
      mfaMethod="totp"
      onClose={onClose}
      onCompleted={onCompleted}
      offerReattach={props.offerReattach ?? true}
    />,
  );
  return { onCompleted, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  capability.canReattach = true;
});

describe('AssignParkedDeviceDialog reattach (#8318)', () => {
  it('offers Reattach to X beside Assign as new, with the side-by-side comparison', async () => {
    const user = userEvent.setup();
    route(parkedView());
    renderDialog();
    await user.click(await screen.findByTestId(`assign-parked-mode-reattach-${TARGET_ID}`));
    expect(screen.getByTestId('reattach-comparison')).toBeTruthy();
    expect(screen.getByTestId('reattach-compare-place-source').textContent).toBe('Holding area');
    // The assign form gives way to the reattach form.
    expect(screen.queryByTestId('assign-parked-target-org')).toBeNull();
    await user.click(screen.getByTestId('assign-parked-mode-assign'));
    expect(screen.getByTestId('assign-parked-target-org')).toBeTruthy();
  });

  it('requests the reattach and reports completion to the page', async () => {
    const user = userEvent.setup();
    route(parkedView(), json(202, { intent: requestedIntent }));
    const { onCompleted } = renderDialog();
    await user.click(await screen.findByTestId(`assign-parked-mode-reattach-${TARGET_ID}`));
    await user.click(screen.getByTestId('reattach-possession'));
    await user.type(screen.getByTestId('reattach-confirm-name'), 'laptop-old');
    await user.click(screen.getByTestId('reattach-submit'));
    await waitFor(() => expect(screen.getByTestId('reattach-pending')).toBeTruthy());
    expect(onCompleted).toHaveBeenCalled();
    // The choice is made: the mode radios give way to the pending view.
    expect(screen.queryByTestId('assign-parked-mode')).toBeNull();
  });

  it('with a pending reattach, assigning as new needs an explicit confirmation that it cancels it', async () => {
    const user = userEvent.setup();
    route(parkedView({
      openIntent: { intentId: 'intent-1', state: 'requested', targetDeviceId: TARGET_ID, expiresAt: requestedIntent.expiresAt },
    }));
    renderDialog();
    await screen.findByTestId('assign-parked-reattach-pending');
    expect(screen.queryByTestId('assign-parked-mode')).toBeNull();
    await user.selectOptions(screen.getByTestId('assign-parked-target-org'), 'org-a');
    await waitFor(() => expect(screen.getByTestId('assign-parked-target-site')).toBeTruthy());
    await user.selectOptions(screen.getByTestId('assign-parked-target-site'), 'site-1');
    await user.click(screen.getByTestId('assign-parked-possession'));
    const submit = screen.getByTestId('assign-parked-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.getByTestId('assign-parked-reattach-pending').textContent).toMatch(/cancels its pending reattach/);
    await user.click(screen.getByTestId('assign-parked-cancel-reattach'));
    expect(submit.disabled).toBe(false);
  });

  it('locks the mode choice while the reattach form is submitting', async () => {
    const user = userEvent.setup();
    let resolvePost: (r: Response) => void = () => undefined;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === `/devices/${SOURCE_ID}/reinstall-candidates`) return json(200, parkedView());
      if (init?.method === 'POST') return new Promise<Response>((resolve) => { resolvePost = resolve; });
      throw new Error(`unexpected fetch ${url}`);
    });
    renderDialog();
    await user.click(await screen.findByTestId(`assign-parked-mode-reattach-${TARGET_ID}`));
    await user.click(screen.getByTestId('reattach-possession'));
    await user.type(screen.getByTestId('reattach-confirm-name'), 'LAPTOP-OLD');
    await user.click(screen.getByTestId('reattach-submit'));
    const assignRadio = screen.getByTestId('assign-parked-mode-assign') as HTMLInputElement;
    await waitFor(() => expect(assignRadio.disabled).toBe(true));
    await user.click(assignRadio);
    expect(screen.getByTestId('reattach-form')).toBeTruthy();
    resolvePost(json(409, { error: 'unknown', code: 'liveness_unknown' }));
    await waitFor(() => expect(assignRadio.disabled).toBe(false));
  });

  it('offers no reattach choice to a user without devices:write + devices:delete', async () => {
    capability.canReattach = false;
    route(parkedView());
    renderDialog();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/devices/${SOURCE_ID}/reinstall-candidates`));
    expect(screen.queryByTestId('assign-parked-mode')).toBeNull();
  });

  it('without candidates (or a refused read) it is the plain assign dialog', async () => {
    route(null);
    renderDialog();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/devices/${SOURCE_ID}/reinstall-candidates`));
    expect(screen.queryByTestId('assign-parked-mode')).toBeNull();
    expect(screen.getByTestId('assign-parked-target-org')).toBeTruthy();
  });

  it('reads no candidates unless asked to, nor for a batch', async () => {
    route(parkedView());
    renderDialog({ offerReattach: false });
    renderDialog({ devices: [parked, { ...parked, id: 'dev-b', hostname: 'B' }] });
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
