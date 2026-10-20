import { render, screen, within } from '@testing-library/react';
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

function device(n: number): Device {
  const id = `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  return {
    id,
    deviceClass: 'agent',
    hostname: `host-${String(n).padStart(2, '0')}`,
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
  };
}

const fleet = (count: number) => Array.from({ length: count }, (_, i) => device(i + 1));

describe('DeviceList — table header strip (#9035)', () => {
  afterEach(() => window.localStorage.clear());

  it('puts the count line, Columns and per-page in one strip inside the table card', () => {
    // 12 devices: above the smallest page size, so the per-page picker has a job (#9023).
    render(<DeviceList devices={fleet(12)} />);
    const card = screen.getByTestId('device-list-table-card');
    const strip = within(card).getByTestId('device-list-header-strip');
    expect(card.querySelector('table')).not.toBeNull();
    expect(within(strip).getByTestId('device-list-count')).toHaveTextContent('12 of 12 devices');
    expect(within(strip).getByTestId('column-chooser-trigger')).toBeInTheDocument();
    expect(within(strip).getByLabelText('Devices per page')).toBeInTheDocument();
  });

  it('renders page-supplied header actions (the view toggle) in the strip', () => {
    render(<DeviceList devices={fleet(2)} headerActions={<button type="button">Grid view</button>} />);
    const strip = screen.getByTestId('device-list-header-strip');
    expect(within(strip).getByRole('button', { name: 'Grid view' })).toBeInTheDocument();
  });

  it('drops the duplicate "Showing 1 to N of N" line on a single page', () => {
    const { container } = render(<DeviceList devices={fleet(2)} />);
    expect(container).not.toHaveTextContent(/Showing 1 to 2 of 2/);
    expect(screen.queryByTestId('device-list-pagination')).toBeNull();
  });

  it('keeps the range and the pager when there is more than one page', () => {
    render(<DeviceList devices={fleet(12)} />);
    const pager = screen.getByTestId('device-list-pagination');
    expect(pager).toHaveTextContent('Showing 1 to 10 of 12');
    expect(pager).toHaveTextContent('Page 1 of 2');
  });

  it('pluralises the count line', () => {
    render(<DeviceList devices={fleet(1)} />);
    expect(screen.getByTestId('device-list-count')).toHaveTextContent('1 of 1 device');
    expect(screen.getByTestId('device-list-count')).not.toHaveTextContent('1 of 1 devices');
  });
});
