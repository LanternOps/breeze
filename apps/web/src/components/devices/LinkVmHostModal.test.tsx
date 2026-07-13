import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import LinkVmHostModal from './LinkVmHostModal';
import type { Device } from './DeviceList';

const mk = (id: string, hostname: string): Device => ({
  id,
  hostname,
  os: 'windows',
  osVersion: '2022',
  status: 'online',
  cpuPercent: 0,
  ramPercent: 0,
  lastSeen: '2026-01-01T00:00:00.000Z',
  orgId: 'org-1',
  orgName: 'Org',
  siteId: 'site-1',
  siteName: 'Site',
  agentVersion: '1.0.0',
  tags: [],
});

describe('LinkVmHostModal (#2308)', () => {
  const devices = [mk('dev-a', 'hv-01'), mk('dev-b', 'vm-web'), mk('dev-c', 'vm-db')];

  it('disables confirm until a host is picked, then confirms with the picked id', () => {
    const onConfirm = vi.fn();
    render(
      <LinkVmHostModal isOpen devices={devices} onConfirm={onConfirm} onClose={() => {}} />,
    );

    const confirm = screen.getByTestId('vm-host-confirm');
    expect(confirm).toBeDisabled();

    fireEvent.click(screen.getByTestId('vm-host-option-dev-a').querySelector('input')!);
    expect(confirm).not.toBeDisabled();

    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith('dev-a');
  });

  it('lists every selected device as a host option', () => {
    render(
      <LinkVmHostModal isOpen devices={devices} onConfirm={() => {}} onClose={() => {}} />,
    );
    for (const d of devices) {
      expect(screen.getByTestId(`vm-host-option-${d.id}`)).toBeInTheDocument();
    }
  });

  it('cancel closes without confirming', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <LinkVmHostModal isOpen devices={devices} onConfirm={onConfirm} onClose={onClose} />,
    );
    fireEvent.click(screen.getByTestId('vm-host-cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
