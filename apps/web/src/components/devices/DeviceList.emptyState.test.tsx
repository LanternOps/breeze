import { fireEvent, render, screen } from '@testing-library/react';
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

const agent: Device = {
  id: '11111111-1111-1111-1111-111111111111',
  deviceClass: 'agent',
  hostname: 'win-box',
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

describe('DeviceList — no-match state (#9036 c)', () => {
  afterEach(() => window.localStorage.clear());

  it('says the filters matched nothing and offers Clear filters', () => {
    const onClearFilters = vi.fn();
    render(
      <DeviceList
        devices={[agent]}
        listFilters={{ search: 'zzz-no-such-host', vpn: 'all' }}
        onListFiltersChange={vi.fn()}
        onClearFilters={onClearFilters}
      />,
    );
    const empty = screen.getByTestId('device-list-no-matches');
    expect(empty).toHaveTextContent('No devices match these filters');
    fireEvent.click(screen.getByTestId('device-list-clear-filters'));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it('omits the button when the caller has no filters to clear', () => {
    render(
      <DeviceList devices={[agent]} listFilters={{ search: 'zzz-no-such-host', vpn: 'all' }} onListFiltersChange={vi.fn()} />,
    );
    expect(screen.getByTestId('device-list-no-matches')).toBeInTheDocument();
    expect(screen.queryByTestId('device-list-clear-filters')).toBeNull();
  });
});
