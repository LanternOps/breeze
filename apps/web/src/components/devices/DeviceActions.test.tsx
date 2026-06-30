import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceActions from './DeviceActions';
import type { Device } from './DeviceList';

// ConnectDesktopButton (rendered inside DeviceActions) imports fetchWithAuth and
// the Toast helper. Mock both so the action bar renders without touching the
// network or the toast store.
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../shared/Toast', async () => {
  const actual = await vi.importActual<typeof import('../shared/Toast')>('../shared/Toast');
  return {
    ...actual,
    showToast: vi.fn(),
  };
});

const baseDevice: Device = {
  id: 'device-1',
  hostname: 'edge-01',
  os: 'windows',
  osVersion: '11',
  status: 'online',
  cpuPercent: 10,
  ramPercent: 20,
  lastSeen: '2026-06-29T10:00:00.000Z',
  orgId: 'org-1',
  orgName: 'Org One',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '1.0.0',
  tags: [],
};

const onlineDevice: Device = { ...baseDevice, status: 'online' };
const offlineDevice: Device = { ...baseDevice, status: 'offline' };

// Native disabled buttons aren't reported as disabled via getByRole's name in
// every jsdom case, so query the DOM element directly and read its props.
const button = (name: RegExp) => screen.getByRole('button', { name });

describe('DeviceActions — offline gating (issue #2013)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('online device', () => {
    it('leaves Connect Desktop, Power, Run Script and Remote Tools all enabled', () => {
      render(<DeviceActions device={onlineDevice} />);

      expect(button(/run script/i)).not.toBeDisabled();
      expect(button(/^connect desktop$/i)).not.toBeDisabled();
      expect(button(/remote tools/i)).not.toBeDisabled();
      expect(button(/^power$/i)).not.toBeDisabled();
    });

    it('does not render the Wake button when the device is online', () => {
      render(<DeviceActions device={onlineDevice} />);
      expect(screen.queryByRole('button', { name: /^wake$/i })).toBeNull();
    });
  });

  describe('offline device', () => {
    it('disables Connect Desktop with the "Device is offline" tooltip', () => {
      render(<DeviceActions device={offlineDevice} />);

      const connect = button(/^connect desktop$/i);
      expect(connect).toBeDisabled();
      expect(connect).toHaveAttribute('title', 'Device is offline');
    });

    it('disables the Power button with the "Device is offline" tooltip', () => {
      render(<DeviceActions device={offlineDevice} />);

      const power = button(/^power$/i);
      expect(power).toBeDisabled();
      expect(power).toHaveAttribute('title', 'Device is offline');
    });

    it('keeps Run Script and Remote Tools disabled with the offline tooltip (existing behavior)', () => {
      render(<DeviceActions device={offlineDevice} />);

      const runScript = button(/run script/i);
      expect(runScript).toBeDisabled();
      expect(runScript).toHaveAttribute('title', 'Device is offline');

      const remoteTools = button(/remote tools/i);
      expect(remoteTools).toBeDisabled();
      expect(remoteTools).toHaveAttribute('title', 'Device is offline');
    });

    it('keeps Wake ENABLED — Wake-on-LAN is intended for offline devices', () => {
      render(<DeviceActions device={offlineDevice} />);

      const wake = button(/^wake$/i);
      expect(wake).toBeInTheDocument();
      expect(wake).not.toBeDisabled();
    });
  });

  // The compact variant duplicates the gating logic in its own menu, so it gets
  // its own coverage. The menu is collapsed until the trigger is clicked.
  describe('compact variant', () => {
    it('disables Connect Desktop when offline (with the offline tooltip) but keeps Wake enabled', () => {
      render(<DeviceActions device={offlineDevice} compact />);

      // Only the MoreHorizontal trigger is rendered until the menu opens.
      fireEvent.click(screen.getByRole('button'));

      const connect = button(/^connect desktop$/i);
      expect(connect).toBeDisabled();
      expect(connect).toHaveAttribute('title', 'Device is offline');

      const wake = button(/^wake$/i);
      expect(wake).toBeInTheDocument();
      expect(wake).not.toBeDisabled();
    });

    it('leaves Connect Desktop enabled when online', () => {
      render(<DeviceActions device={onlineDevice} compact />);

      fireEvent.click(screen.getByRole('button'));

      expect(button(/^connect desktop$/i)).not.toBeDisabled();
    });
  });
});
