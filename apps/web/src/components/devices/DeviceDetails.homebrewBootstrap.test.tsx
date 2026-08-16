import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceDetails from './DeviceDetails';
import type { Device } from './DeviceList';

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: fetchWithAuthMock };
});

const useExtensionSlotDescriptorsMock = vi.hoisted(() => vi.fn());
vi.mock('../extensions/ExtensionSlotHost', () => ({
  useExtensionSlotDescriptors: (...a: unknown[]) => useExtensionSlotDescriptorsMock(...a),
  default: () => <div data-testid="extension-slot-host-stub" />,
}));

const macDevice: Device = {
  id: 'device-1',
  hostname: 'mac-01',
  os: 'macos',
  osVersion: '15.0',
  status: 'online',
  cpuPercent: 12,
  ramPercent: 34,
  uptimeSeconds: 3600,
  lastSeen: '2026-08-15T10:00:00.000Z',
  orgId: 'org-1',
  orgName: 'Org One',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '1.0.0',
} as Device;

const windowsDevice: Device = { ...macDevice, os: 'windows' } as Device;

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 404): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

// The Install Homebrew entry lives in the header overflow ("…") menu, which is
// the LAST button in the action bar.
async function openOverflowMenu(user: ReturnType<typeof userEvent.setup>) {
  const actionBar = screen.getByText('Run Script').closest('div')!.parentElement!;
  const buttons = Array.from(actionBar.querySelectorAll('button'));
  await user.click(buttons[buttons.length - 1]!);
}

beforeEach(() => {
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockResolvedValue(makeJsonResponse({}, false, 404));
  useExtensionSlotDescriptorsMock.mockReset();
  useExtensionSlotDescriptorsMock.mockReturnValue([]);
  window.location.hash = '';
});

afterEach(() => {
  window.location.hash = '';
  vi.clearAllMocks();
});

describe('DeviceDetails Homebrew bootstrap action', () => {
  it('offers Install Homebrew on a macOS device', async () => {
    const user = userEvent.setup();
    render(<DeviceDetails device={macDevice} />);

    await openOverflowMenu(user);

    expect(await screen.findByTestId('device-install-homebrew')).toBeTruthy();
  });

  it('does not offer Install Homebrew on a non-macOS device', async () => {
    const user = userEvent.setup();
    render(<DeviceDetails device={windowsDevice} />);

    await openOverflowMenu(user);

    expect(screen.queryByTestId('device-install-homebrew')).toBeNull();
  });

  it('confirms before dispatching, explaining the console-user requirement', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<DeviceDetails device={macDevice} onAction={onAction} />);

    await openOverflowMenu(user);
    await user.click(await screen.findByTestId('device-install-homebrew'));

    expect(
      screen.getByText(
        'Installs Homebrew as the currently signed-in user using a pinned, checksum-verified copy of ' +
          'the official installer. Requires an admin console session with an active or passwordless ' +
          'sudo credential; otherwise the install fails and the error is reported back.',
      ),
    ).toBeTruthy();
    // Nothing dispatched until the user confirms.
    expect(onAction).not.toHaveBeenCalled();

    await user.click(screen.getAllByRole('button', { name: /Install Homebrew/i }).at(-1)!);

    expect(onAction).toHaveBeenCalledWith('install-homebrew', macDevice);
  });
});
