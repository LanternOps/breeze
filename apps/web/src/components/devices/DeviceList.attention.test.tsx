import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceList, { type Device } from './DeviceList';
import { DEFAULT_VISIBLE_COLUMNS, writeColumnVisibility } from './columnVisibility';
import { fetchWithAuth } from '../../stores/auth';

// #9038: the Attention column — open alerts by severity + open tickets, fetched
// once per page of rows from GET /devices/attention-counts.

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('@/stores/orgStore', () => ({
  useOrgStore: (selector: (s: { currentOrgId: string | null; allOrgs: boolean }) => unknown) =>
    selector({ currentOrgId: null, allOrgs: true }),
}));
vi.mock('../remote/ConnectDesktopButton', () => ({ default: () => null }));
vi.mock('@/lib/formatTime', () => ({ formatLastSeen: () => 'just now' }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: () => true }),
  hasPermission: () => true,
}));

const fetchMock = vi.mocked(fetchWithAuth);

const CRIT = '11111111-1111-4111-8111-111111111111';
const QUIET = '22222222-2222-4222-8222-222222222222';
const TICKETS_ONLY = '33333333-3333-4333-8333-333333333333';
const NETWORK = '44444444-4444-4444-8444-444444444444';
const MANUAL = '66666666-6666-4666-8666-666666666666';

const zeroAlerts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };

function device(id: string, hostname: string, overrides: Partial<Device> = {}): Device {
  return {
    id,
    deviceClass: 'agent',
    hostname,
    os: 'linux',
    osVersion: '22.04',
    status: 'online',
    cpuPercent: 1,
    ramPercent: 1,
    lastSeen: new Date().toISOString(),
    orgId: 'org-1',
    orgName: 'Acme',
    siteId: 'site-1',
    siteName: 'HQ',
    agentVersion: '0.110.0',
    tags: [],
    ...overrides,
  };
}

const devices = [
  device(CRIT, 'crit-box'),
  device(QUIET, 'quiet-box'),
  device(TICKETS_ONLY, 'ticket-box'),
];

const attentionCalls = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/devices/attention-counts'));

function respondWithCounts() {
  fetchMock.mockImplementation(async (url: string) => {
    if (!url.startsWith('/devices/attention-counts')) {
      return { ok: true, status: 200, json: async () => ({ data: [] }) } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        counts: {
          [CRIT]: { alerts: { ...zeroAlerts, critical: 2, high: 4 }, tickets: 3 },
          [TICKETS_ONLY]: { alerts: zeroAlerts, tickets: 1 },
        },
      }),
    } as unknown as Response;
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  writeColumnVisibility([...DEFAULT_VISIBLE_COLUMNS]);
});
afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('DeviceList — Attention column (#9038)', () => {
  it('renders the highest-severity alert pill and a ticket pill from one batched request', async () => {
    respondWithCounts();
    render(<DeviceList devices={devices} pageSize={50} />);

    expect(screen.getByRole('columnheader', { name: 'Attention' })).toBeTruthy();

    const alertsPill = await screen.findByTestId(`device-${CRIT}-attention-alerts`);
    expect(alertsPill.textContent).toBe('2 critical');
    expect(within(alertsPill).getByRole('link').getAttribute('href')).toBe(`/devices/${CRIT}#alerts`);

    const ticketsPill = screen.getByTestId(`device-${CRIT}-attention-tickets`);
    expect(ticketsPill.textContent).toBe('3 open tickets');
    expect(within(ticketsPill).getByRole('link').getAttribute('href')).toBe(`/devices/${CRIT}#tickets`);

    expect(screen.getByTestId(`device-${TICKETS_ONLY}-attention-tickets`).textContent).toBe('1 open ticket');
    expect(screen.queryByTestId(`device-${TICKETS_ONLY}-attention-alerts`)).toBeNull();

    // Nothing open → a dash, not a pill.
    const quiet = screen.getByTestId(`device-${QUIET}-attention-none`);
    expect(quiet.textContent).toContain('—');

    expect(attentionCalls()).toHaveLength(1);
    const ids = new URL(attentionCalls()[0]![0] as string, 'http://x').searchParams.get('ids')!.split(',');
    expect(ids.sort()).toEqual([CRIT, QUIET, TICKETS_ONLY].sort());
  });

  it('shows a loading skeleton until the counts arrive', async () => {
    respondWithCounts();
    render(<DeviceList devices={devices} pageSize={50} />);
    expect(screen.getByTestId(`device-${CRIT}-attention-loading`)).toBeTruthy();
    await screen.findByTestId(`device-${CRIT}-attention-alerts`);
    expect(screen.queryByTestId(`device-${CRIT}-attention-loading`)).toBeNull();
  });

  it('renders a dash silently when the request fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockImplementation(async (url: string) =>
      url.startsWith('/devices/attention-counts')
        ? ({ ok: false, status: 500, json: async () => ({}) } as unknown as Response)
        : ({ ok: true, status: 200, json: async () => ({ data: [] }) } as unknown as Response),
    );
    render(<DeviceList devices={devices} pageSize={50} />);

    const cell = await screen.findByTestId(`device-${CRIT}-attention-unavailable`);
    expect(cell.textContent).toContain('—');
    expect(screen.queryByTestId(`device-${CRIT}-attention-alerts`)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not request counts when the column is hidden', async () => {
    respondWithCounts();
    writeColumnVisibility(DEFAULT_VISIBLE_COLUMNS.filter((id) => id !== 'attention'));
    render(<DeviceList devices={devices} pageSize={50} />);
    await new Promise((r) => setTimeout(r, 300));
    expect(screen.queryByRole('columnheader', { name: 'Attention' })).toBeNull();
    expect(attentionCalls()).toHaveLength(0);
  });

  it('only asks for the rows on the current page', async () => {
    respondWithCounts();
    // Page sizes snap to PAGE_SIZE_OPTIONS (smallest 10), so 12 rows = 2 pages.
    const many = Array.from({ length: 12 }, (_, i) =>
      device(`55555555-5555-4555-8555-${i.toString().padStart(12, '0')}`, `host-${i}`),
    );
    render(<DeviceList devices={many} pageSize={10} />);
    await waitFor(() => expect(attentionCalls()).toHaveLength(1));
    const ids = new URL(attentionCalls()[0]![0] as string, 'http://x').searchParams.get('ids')!.split(',');
    expect(ids).toHaveLength(10);
  });

  it('does not ask for network or manual rows', async () => {
    respondWithCounts();
    const network = device(NETWORK, 'printer', { deviceClass: 'network' } as Partial<Device>);
    const manual = device(MANUAL, 'spare-laptop', { deviceClass: 'manual' } as Partial<Device>);
    render(<DeviceList devices={[...devices, network, manual]} pageSize={50} />);
    await waitFor(() => expect(attentionCalls()).toHaveLength(1));
    const ids = new URL(attentionCalls()[0]![0] as string, 'http://x').searchParams.get('ids')!.split(',');
    // Positive control: the agent rows are requested.
    expect(ids.sort()).toEqual([CRIT, QUIET, TICKETS_ONLY].sort());
  });
});
