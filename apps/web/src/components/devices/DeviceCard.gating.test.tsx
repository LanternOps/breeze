import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceCard from './DeviceCard';
import type { Device, DeviceStatus } from './DeviceList';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown): Response =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue(payload)
  }) as unknown as Response;

const baseDevice: Device = {
  id: 'device-1',
  hostname: 'edge-01',
  os: 'windows',
  osVersion: '11',
  status: 'online',
  cpuPercent: 58,
  ramPercent: 71,
  lastSeen: '2026-02-09T10:00:00.000Z',
  orgId: 'org-1',
  orgName: 'Org One',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '1.0.0',
  tags: []
};

function openCardMenu(status: DeviceStatus, onAction = vi.fn()) {
  const device: Device = { ...baseDevice, status };
  render(<DeviceCard device={device} onAction={onAction} />);
  fireEvent.click(screen.getByLabelText(`Actions for ${device.hostname}`));
  return { onAction };
}

const terminalBtn = () => screen.getByRole('button', { name: /remote terminal/i });
const runScriptBtn = () => screen.getByRole('button', { name: /run script/i });
const rebootBtn = () => screen.getByRole('button', { name: /^reboot/i });

// #2488: the grid DeviceCard menu previously had zero gating — Run Script fired
// on decommissioned devices (reproducing #2426 in grid view) and Remote
// Terminal fired doomed requests on offline devices.
describe('DeviceCard action gating (#2488)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ metrics: [] }));
  });

  it('online device: all command actions are enabled', () => {
    openCardMenu('online');
    expect(terminalBtn()).toBeEnabled();
    expect(runScriptBtn()).toBeEnabled();
    expect(rebootBtn()).toBeEnabled();
  });

  it('offline device: Remote Terminal (live session) is disabled; queued commands stay enabled', () => {
    const { onAction } = openCardMenu('offline');

    expect(terminalBtn()).toBeDisabled();
    // Queued commands run on reconnect, so offline devices keep them.
    expect(runScriptBtn()).toBeEnabled();
    expect(rebootBtn()).toBeEnabled();

    // The real failure mode is a disabled gate that still dispatches.
    fireEvent.click(terminalBtn());
    expect(onAction).not.toHaveBeenCalledWith('terminal', expect.anything());
  });

  it('decommissioned device: queued commands + live session all disabled and do not dispatch', () => {
    const { onAction } = openCardMenu('decommissioned');

    expect(runScriptBtn()).toBeDisabled();
    expect(rebootBtn()).toBeDisabled();
    expect(terminalBtn()).toBeDisabled();

    fireEvent.click(runScriptBtn());
    fireEvent.click(rebootBtn());
    fireEvent.click(terminalBtn());
    expect(onAction).not.toHaveBeenCalled();
  });
});
