import '@/lib/i18n';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { fetchMock, mintMock, sitesMock, toastMock, orgState } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  mintMock: vi.fn(),
  sitesMock: vi.fn(),
  toastMock: vi.fn(),
  orgState: {
    organizations: [
      { id: 'org-a', name: 'Acme', status: 'active' },
      { id: 'org-archived', name: 'Old Co', status: 'archived' },
    ],
    fetchOrganizations: vi.fn(async () => undefined),
  },
}));

vi.mock('../../stores/auth', () => ({ fetchWithAuth: fetchMock }));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: typeof orgState) => unknown) => selector(orgState),
}));
vi.mock('@/lib/fetchAllSites', () => ({ fetchAllSites: sitesMock }));
vi.mock('../../lib/mfaStepUp', () => ({
  mintStepUpGrant: mintMock,
  StepUpMintError: class StepUpMintError extends Error {},
}));
vi.mock('../shared/Toast', () => ({ showToast: toastMock }));

import AssignParkedDeviceDialog, { type ParkedDeviceSummary } from './AssignParkedDeviceDialog';

const deviceA: ParkedDeviceSummary = {
  id: 'dev-a',
  hostname: 'LAPTOP-A',
  osType: 'windows',
  osVersion: '11',
  serialNumber: 'SER-A',
  manufacturer: 'Dell',
  model: 'XPS',
  primaryMacAddress: 'aa:bb:cc:dd:ee:01',
};
const deviceB: ParkedDeviceSummary = { ...deviceA, id: 'dev-b', hostname: 'LAPTOP-B', serialNumber: 'SER-B' };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

function renderDialog(devices: ParkedDeviceSummary[], onCompleted = vi.fn()) {
  render(
    <AssignParkedDeviceDialog
      open
      devices={devices}
      passkeyCount={0}
      mfaMethod="totp"
      onClose={vi.fn()}
      onCompleted={onCompleted}
    />,
  );
  return { onCompleted };
}

async function chooseDestination(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByTestId('assign-parked-target-org'), 'org-a');
  await waitFor(() => expect(screen.getByTestId('assign-parked-target-site')).toBeTruthy());
  await user.selectOptions(screen.getByTestId('assign-parked-target-site'), 'site-1');
}

beforeEach(() => {
  vi.clearAllMocks();
  sitesMock.mockResolvedValue([{ id: 'site-1', name: 'HQ' }]);
  mintMock.mockResolvedValue('grant-1');
});

describe('AssignParkedDeviceDialog', () => {
  it('labels the identity fields as reported by the device', () => {
    renderDialog([deviceA]);
    expect(screen.getByTestId('assign-parked-identity').textContent).toContain('SER-A');
    expect(screen.getByTestId('assign-parked-identity-caption').textContent).toMatch(/reported by the device/i);
  });

  it('offers only live organizations', () => {
    renderDialog([deviceA]);
    const options = Array.from((screen.getByTestId('assign-parked-target-org') as HTMLSelectElement).options).map((o) => o.value);
    expect(options).toContain('org-a');
    expect(options).not.toContain('org-archived');
  });

  it('keeps submit disabled until the possession checkbox is ticked', async () => {
    const user = userEvent.setup();
    renderDialog([deviceA]);
    await chooseDestination(user);
    const submit = screen.getByTestId('assign-parked-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await user.click(screen.getByTestId('assign-parked-possession'));
    expect(submit.disabled).toBe(false);
  });

  it('single: asks for step-up when the server does, then mints a grant bound to the device and destination', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(json(403, { error: 'Step-up required', code: 'STEP_UP_REQUIRED' }))
      .mockResolvedValueOnce(json(200, { success: true, deviceId: 'dev-a', orgId: 'org-a', siteId: 'site-1' }));
    const { onCompleted } = renderDialog([deviceA]);
    await chooseDestination(user);
    await user.click(screen.getByTestId('assign-parked-possession'));
    await user.click(screen.getByTestId('assign-parked-submit'));

    await waitFor(() => expect(screen.getByTestId('assign-parked-stepup-code')).toBeTruthy());
    const firstCall = fetchMock.mock.calls[0]!;
    expect(firstCall[0]).toBe('/pre-assignment/devices/dev-a/assign');
    expect(JSON.parse(firstCall[1].body)).toEqual({ orgId: 'org-a', siteId: 'site-1', possessionConfirmed: true });

    await user.type(screen.getByTestId('assign-parked-stepup-code'), '123456');
    await user.click(screen.getByTestId('assign-parked-submit'));
    await waitFor(() => expect(onCompleted).toHaveBeenCalled());
    expect(mintMock).toHaveBeenCalledWith({
      operation: 'parked_device_assign',
      resource: { deviceId: 'dev-a', targetOrgId: 'org-a', targetSiteId: 'site-1' },
      reauth: { method: 'totp', code: '123456' },
    });
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({
      orgId: 'org-a', siteId: 'site-1', possessionConfirmed: true, stepUpGrant: 'grant-1',
    });
  });

  it('bulk: mints ONE grant for the whole batch with the bulk operation', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(json(403, { error: 'Step-up required', code: 'STEP_UP_REQUIRED' }))
      .mockResolvedValueOnce(json(200, { results: [{ deviceId: 'dev-a', ok: true }, { deviceId: 'dev-b', ok: false, code: 'DEVICE_IDENTITY_COLLISION' }] }));
    const { onCompleted } = renderDialog([deviceA, deviceB]);
    await chooseDestination(user);
    await user.click(screen.getByTestId('assign-parked-possession'));
    await user.click(screen.getByTestId('assign-parked-submit'));
    await waitFor(() => expect(screen.getByTestId('assign-parked-stepup-code')).toBeTruthy());
    expect(fetchMock.mock.calls[0]![0]).toBe('/pre-assignment/devices/assign-bulk');

    await user.type(screen.getByTestId('assign-parked-stepup-code'), '654321');
    await user.click(screen.getByTestId('assign-parked-submit'));
    await waitFor(() => expect(screen.getByTestId('assign-parked-results')).toBeTruthy());
    expect(mintMock).toHaveBeenCalledTimes(1);
    expect(mintMock).toHaveBeenCalledWith({
      operation: 'parked_device_assign_bulk',
      resource: {
        items: [
          { deviceId: 'dev-a', targetOrgId: 'org-a', targetSiteId: 'site-1' },
          { deviceId: 'dev-b', targetOrgId: 'org-a', targetSiteId: 'site-1' },
        ],
      },
      reauth: { method: 'totp', code: '654321' },
    });
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({
      items: [
        { deviceId: 'dev-a', orgId: 'org-a', siteId: 'site-1' },
        { deviceId: 'dev-b', orgId: 'org-a', siteId: 'site-1' },
      ],
      possessionConfirmed: true,
      stepUpGrant: 'grant-1',
    });
    expect(screen.getByTestId('assign-parked-result-dev-b').textContent).toMatch(/hostname/i);
    expect(onCompleted).toHaveBeenCalled();
  });

  it('single: offers to accept a hostname collision the server reports', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(json(409, { error: 'A device with this hostname already exists at the target site', code: 'DEVICE_IDENTITY_COLLISION', collidingDeviceIds: ['other'] }))
      .mockResolvedValueOnce(json(200, { success: true }));
    const { onCompleted } = renderDialog([deviceA]);
    await chooseDestination(user);
    await user.click(screen.getByTestId('assign-parked-possession'));
    await user.click(screen.getByTestId('assign-parked-submit'));
    await waitFor(() => expect(screen.getByTestId('assign-parked-accept-collision')).toBeTruthy());
    await user.click(screen.getByTestId('assign-parked-accept-collision'));
    await user.click(screen.getByTestId('assign-parked-submit'));
    await waitFor(() => expect(onCompleted).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toMatchObject({ acceptIdentityCollision: true });
  });

  it('single: after a collision refusal, the accept retry reuses the still-valid grant instead of asking again', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(json(403, { error: 'Step-up required', code: 'STEP_UP_REQUIRED' }))
      .mockResolvedValueOnce(json(409, { error: 'collision', code: 'DEVICE_IDENTITY_COLLISION', collidingDeviceIds: ['other'] }))
      .mockResolvedValueOnce(json(200, { success: true }));
    const { onCompleted } = renderDialog([deviceA]);
    await chooseDestination(user);
    await user.click(screen.getByTestId('assign-parked-possession'));
    await user.click(screen.getByTestId('assign-parked-submit'));
    await waitFor(() => expect(screen.getByTestId('assign-parked-stepup-code')).toBeTruthy());
    await user.type(screen.getByTestId('assign-parked-stepup-code'), '123456');
    await user.click(screen.getByTestId('assign-parked-submit'));
    await waitFor(() => expect(screen.getByTestId('assign-parked-accept-collision')).toBeTruthy());
    await user.click(screen.getByTestId('assign-parked-accept-collision'));
    await user.click(screen.getByTestId('assign-parked-submit'));
    await waitFor(() => expect(onCompleted).toHaveBeenCalled());
    expect(mintMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[2]![1].body)).toEqual({
      orgId: 'org-a', siteId: 'site-1', possessionConfirmed: true, stepUpGrant: 'grant-1', acceptIdentityCollision: true,
    });
  });

  it('single: a reused grant the server no longer accepts falls back to a fresh step-up', async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(json(403, { error: 'Step-up required', code: 'STEP_UP_REQUIRED' }))
      .mockResolvedValueOnce(json(409, { error: 'collision', code: 'DEVICE_IDENTITY_COLLISION' }))
      .mockResolvedValueOnce(json(403, { error: 'Step-up required', code: 'STEP_UP_REQUIRED' }));
    renderDialog([deviceA]);
    await chooseDestination(user);
    await user.click(screen.getByTestId('assign-parked-possession'));
    await user.click(screen.getByTestId('assign-parked-submit'));
    await waitFor(() => expect(screen.getByTestId('assign-parked-stepup-code')).toBeTruthy());
    await user.type(screen.getByTestId('assign-parked-stepup-code'), '123456');
    await user.click(screen.getByTestId('assign-parked-submit'));
    await waitFor(() => expect(screen.getByTestId('assign-parked-accept-collision')).toBeTruthy());
    await user.click(screen.getByTestId('assign-parked-accept-collision'));
    await user.click(screen.getByTestId('assign-parked-submit'));
    await waitFor(() => expect(screen.getByTestId('assign-parked-stepup-code')).toBeTruthy());
    expect((screen.getByTestId('assign-parked-stepup-code') as HTMLInputElement).value).toBe('');
  });
});
