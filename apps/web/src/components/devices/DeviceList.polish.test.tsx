import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import DeviceList, { type Device } from './DeviceList';

vi.mock('../../stores/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../stores/auth')>()),
  fetchWithAuth: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: [], total: 0 }) })),
}));
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null; allOrgs: boolean }) => unknown) =>
    selector({ currentOrgId: null, allOrgs: true }),
}));
vi.mock('../remote/ConnectDesktopButton', () => ({ default: () => null }));
vi.mock('@/lib/formatTime', () => ({ formatLastSeen: () => 'just now' }));

function device(n: number, overrides: Partial<Device> = {}): Device {
  return {
    id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
    deviceClass: 'agent',
    hostname: `host-${String(n).padStart(2, '0')}`,
    os: 'windows',
    osVersion: '11',
    status: 'online',
    cpuPercent: n,
    ramPercent: 1,
    lastSeen: new Date().toISOString(),
    orgId: 'org-1',
    orgName: 'Acme',
    siteId: 'site-1',
    siteName: 'HQ',
    agentVersion: '0.70.0',
    tags: [],
    ...overrides,
  };
}

afterEach(() => {
  window.localStorage.clear();
  history.replaceState(null, '', '/');
});

describe('DeviceList polish (#9037)', () => {
  describe('row keyboard model', () => {
    it('keeps the cell links out of the tab order and labels the row', () => {
      const d = device(1);
      const { container } = render(<DeviceList devices={[d]} />);
      const row = container.querySelector('tbody tr') as HTMLElement;
      expect(row).toHaveAttribute('tabindex', '0');
      expect(row).toHaveAttribute('aria-label', 'host-01, Online');
      for (const testId of ['device-record-link', 'org-record-link', 'site-record-link']) {
        const link = within(row).getByTestId(testId);
        expect(link).toHaveAttribute('tabindex', '-1');
        // Still a real anchor for middle-click / context menu.
        expect(link.tagName).toBe('A');
        expect(link).toHaveAttribute('href');
      }
    });

    it('opens the device on Enter from the row', () => {
      const onSelect = vi.fn();
      const d = device(1);
      const { container } = render(<DeviceList devices={[d]} onSelect={onSelect} />);
      fireEvent.keyDown(container.querySelector('tbody tr') as HTMLElement, { key: 'Enter' });
      expect(onSelect).toHaveBeenCalledWith(d);
    });

    it('does not open the device when Space or Enter lands on the checkbox', () => {
      const onSelect = vi.fn();
      render(<DeviceList devices={[device(1)]} onSelect={onSelect} />);
      const box = screen.getByLabelText('Select host-01');
      fireEvent.keyDown(box, { key: ' ' });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(onSelect).not.toHaveBeenCalled();
    });
  });

  it('labels the pager buttons', () => {
    render(<DeviceList devices={Array.from({ length: 12 }, (_, i) => device(i + 1))} />);
    const pager = screen.getByTestId('device-list-pagination');
    expect(within(pager).getByRole('button', { name: 'Previous page' })).toBeDisabled();
    expect(within(pager).getByRole('button', { name: 'Next page' })).toBeEnabled();
  });

  describe('Bulk Actions menu', () => {
    it('advertises its popup and closes on Escape, returning focus', () => {
      render(<DeviceList devices={[device(1)]} />);
      fireEvent.click(screen.getByLabelText('Select host-01'));
      const trigger = screen.getByTestId('bulk-actions-trigger');
      expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(trigger);
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
      fireEvent.keyDown(screen.getByTestId('bulk-actions-menu'), { key: 'Escape' });
      expect(screen.queryByTestId('bulk-actions-menu')).toBeNull();
      expect(trigger).toHaveFocus();
    });

    it('closes on an outside click', () => {
      render(<DeviceList devices={[device(1)]} />);
      fireEvent.click(screen.getByLabelText('Select host-01'));
      fireEvent.click(screen.getByTestId('bulk-actions-trigger'));
      fireEvent.mouseDown(document.body);
      expect(screen.queryByTestId('bulk-actions-menu')).toBeNull();
    });
  });

  describe('sort state in the URL hash', () => {
    it('writes the sort into the hash, keeping other keys', () => {
      history.replaceState(null, '', '/devices#deviceClass=agent');
      render(<DeviceList devices={[device(1), device(2)]} sortInHash />);
      fireEvent.click(screen.getByTitle('Sort by CPU usage'));
      expect(window.location.hash).toContain('deviceClass=agent');
      expect(window.location.hash).toContain('sort=cpu.asc');
      fireEvent.click(screen.getByTitle('Sort by CPU usage'));
      expect(window.location.hash).toContain('sort=cpu.desc');
    });

    it('restores the sort from the hash on mount', () => {
      history.replaceState(null, '', '/devices#sort=cpu.desc');
      const { container } = render(<DeviceList devices={[device(1), device(2)]} sortInHash />);
      const cpuHeader = screen.getByTitle('Sort by CPU usage').closest('th');
      expect(cpuHeader).toHaveAttribute('aria-sort', 'descending');
      const firstHost = container.querySelector('tbody tr td:nth-child(2) > div > span:first-child');
      expect(firstHost).toHaveTextContent('host-02');
    });

    it('ignores an unknown sort column in the hash', () => {
      history.replaceState(null, '', '/devices#sort=bogus.desc');
      render(<DeviceList devices={[device(1)]} sortInHash />);
      expect(screen.getByTitle('Sort by CPU usage').closest('th')).toHaveAttribute('aria-sort', 'none');
    });

    it('leaves the hash alone without sortInHash (the org record owns its hash)', () => {
      history.replaceState(null, '', '/organizations/o1#devices');
      render(<DeviceList devices={[device(1), device(2)]} />);
      fireEvent.click(screen.getByTitle('Sort by CPU usage'));
      expect(window.location.hash).toBe('#devices');
    });
  });

  describe('"Advanced filter active" pill', () => {
    const ids = (ds: Device[]) => new Set(ds.map((d) => d.id));

    it('stays hidden for a chip-bar filter (flat AND group), which the chips already show', () => {
      const ds = [device(1)];
      render(
        <DeviceList
          devices={ds}
          serverFilterIds={ids(ds)}
          advancedFilter={{ operator: 'AND', conditions: [{ field: 'status', operator: 'equals', value: 'online' }] }}
        />,
      );
      expect(screen.queryByText(/Advanced filter active/i)).toBeNull();
    });

    it('shows for a builder-only group (OR or nested)', () => {
      const ds = [device(1)];
      render(
        <DeviceList
          devices={ds}
          serverFilterIds={ids(ds)}
          advancedFilter={{
            operator: 'OR',
            conditions: [
              { field: 'status', operator: 'equals', value: 'online' },
              { field: 'status', operator: 'equals', value: 'offline' },
            ],
          }}
        />,
      );
      expect(screen.getByText(/Advanced filter active/i)).toBeInTheDocument();
    });
  });

  it('keeps CPU % / RAM % headers on one line', () => {
    render(<DeviceList devices={[device(1)]} />);
    expect(screen.getByTitle('Sort by CPU usage').closest('th')).toHaveClass('whitespace-nowrap');
    expect(screen.getByTitle('Sort by RAM usage').closest('th')).toHaveClass('whitespace-nowrap');
  });

  it('lets the Organization cell grow instead of capping it at 160px', () => {
    const { container } = render(<DeviceList devices={[device(1, { orgName: 'A very long organization name indeed' })]} />);
    const orgLink = within(container.querySelector('tbody tr') as HTMLElement).getByTestId('org-record-link');
    const cell = orgLink.closest('td') as HTMLElement;
    expect(cell.className).not.toContain('max-w-[160px]');
    expect(cell).toHaveClass('min-w-0');
  });

  it('separates the row hover tint from the header tint', () => {
    const { container } = render(<DeviceList devices={[device(1)]} />);
    const thead = container.querySelector('thead') as HTMLElement;
    const row = container.querySelector('tbody tr') as HTMLElement;
    const headTint = thead.className.match(/bg-muted\/(\d+)/)?.[1];
    const hoverTint = row.className.match(/hover:bg-muted\/(\d+)/)?.[1];
    expect(headTint).toBeDefined();
    expect(hoverTint).toBeDefined();
    expect(Number(hoverTint) - Number(headTint)).toBeGreaterThanOrEqual(20);
  });

  it('renders no text below 11px for pills (class, source, status, reboot)', () => {
    const { container } = render(
      <DeviceList
        networkDevicesEnabled
        devices={[
          device(1, { pendingReboot: true }),
          device(2, { deviceClass: 'network', assetType: 'printer', source: 'scan' }),
          device(3, { deviceClass: 'manual', assetType: 'workstation' }),
        ]}
      />,
    );
    expect(container.innerHTML).not.toContain('text-[10px]');
  });
});
