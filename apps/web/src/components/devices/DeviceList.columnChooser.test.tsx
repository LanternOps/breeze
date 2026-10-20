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

function device(id: string, hostname: string, overrides: Partial<Device> = {}): Device {
  return {
    id,
    deviceClass: 'agent',
    hostname,
    os: 'windows',
    osVersion: '11',
    status: 'online',
    cpuPercent: 1,
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

const agent = device('11111111-1111-1111-1111-111111111111', 'win-box');

describe('DeviceList — column chooser wiring (#9034)', () => {
  afterEach(() => window.localStorage.clear());

  it('shows the default-on Class column as gated, not checked, in an agent-only fleet', () => {
    const { container } = render(<DeviceList devices={[agent]} networkDevicesEnabled />);
    // Class is in the default set but not drawn: no header for it.
    expect(within(container.querySelector('thead') as HTMLElement).queryByText('Class')).toBeNull();

    fireEvent.click(screen.getByTestId('column-chooser-trigger'));
    const option = screen.getByTestId('column-chooser-option-class');
    expect(within(option).getByRole('checkbox')).toBeDisabled();
    expect(within(option).getByRole('checkbox')).not.toBeChecked();
    expect(option).toHaveTextContent('Hidden for agent-only fleets');
  });

  it('draws Class and lists it as shown once a network row is present', () => {
    const printer = device('22222222-2222-2222-2222-222222222222', 'printer-01', {
      deviceClass: 'network',
      assetType: 'printer',
    });
    render(<DeviceList devices={[agent, printer]} networkDevicesEnabled />);
    fireEvent.click(screen.getByTestId('column-chooser-trigger'));
    const shown = screen.getByTestId('column-chooser-shown');
    expect(within(shown).getByTestId('column-chooser-option-class')).toBeInTheDocument();
  });

  it('cannot hide the Device column', () => {
    const { container } = render(<DeviceList devices={[agent]} />);
    fireEvent.click(screen.getByTestId('column-chooser-trigger'));
    const box = within(screen.getByTestId('column-chooser-option-hostname')).getByRole('checkbox');
    fireEvent.click(box);
    expect(container.querySelector('thead')).toHaveTextContent('Device');
  });

  it('hides a column from the table when unticked', () => {
    const { container } = render(<DeviceList devices={[agent]} />);
    expect(container.querySelector('thead')).toHaveTextContent('Site');
    fireEvent.click(screen.getByTestId('column-chooser-trigger'));
    fireEvent.click(within(screen.getByTestId('column-chooser-option-site')).getByRole('checkbox'));
    expect(container.querySelector('thead')).not.toHaveTextContent('Site');
  });

  it('moves a column past a class-gated neighbour so the swap is visible (#9034 review)', () => {
    // Default order: hostname, class (gated off: agent-only fleet), type, organization…
    const { container } = render(<DeviceList devices={[agent]} networkDevicesEnabled />);
    const headers = () =>
      Array.from(container.querySelectorAll('thead th')).map((th) => th.textContent?.trim()).filter(Boolean);
    expect(headers().slice(0, 2)).toEqual(['Device', 'Organization']);
    fireEvent.click(screen.getByTestId('column-chooser-trigger'));
    fireEvent.click(
      within(screen.getByTestId('column-chooser-option-organization')).getByRole('button', { name: 'Move Organization up' }),
    );
    expect(headers().slice(0, 2)).toEqual(['Organization', 'Device']);
  });
});

