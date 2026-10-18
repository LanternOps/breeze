import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceCard from './DeviceCard';
import type { Device } from './DeviceList';
import { fetchWithAuth } from '../../stores/auth';

// #9038: grid cards carry the same alert/ticket pills as the list's Attention
// column, coalesced into one batched request for every card on screen.

vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: () => true }),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const zeroAlerts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };

const base: Device = {
  id: 'device-a',
  hostname: 'edge-01',
  os: 'windows',
  osVersion: '11',
  status: 'online',
  cpuPercent: 10,
  ramPercent: 10,
  lastSeen: '2026-02-09T10:00:00.000Z',
  orgId: 'org-1',
  orgName: 'Org One',
  siteId: 'site-1',
  siteName: 'HQ',
  agentVersion: '1.0.0',
  tags: [],
};

const attentionCalls = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/devices/attention-counts'));

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith('/devices/attention-counts')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          counts: { 'device-a': { alerts: { ...zeroAlerts, high: 1, low: 2 }, tickets: 2 } },
        }),
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({ metrics: [] }) } as unknown as Response;
  });
});
afterEach(() => vi.restoreAllMocks());

describe('DeviceCard — attention pills (#9038)', () => {
  it('shows the highest-severity alert pill and a ticket pill, linked to the device tabs', async () => {
    render(<DeviceCard device={base} />);

    const alerts = await screen.findByTestId('device-device-a-attention-alerts');
    expect(alerts.textContent).toBe('1 high');
    expect(within(alerts).getByRole('link').getAttribute('href')).toBe('/devices/device-a#alerts');

    const tickets = screen.getByTestId('device-device-a-attention-tickets');
    expect(tickets.textContent).toBe('2 open tickets');
    expect(within(tickets).getByRole('link').getAttribute('href')).toBe('/devices/device-a#tickets');
  });

  it('shows nothing extra for a card with nothing open', async () => {
    render(<DeviceCard device={{ ...base, id: 'device-b' }} />);
    await waitFor(() => expect(attentionCalls()).toHaveLength(1));
    expect(screen.queryByTestId('device-device-b-attention-alerts')).toBeNull();
    expect(screen.queryByTestId('device-device-b-attention-tickets')).toBeNull();
  });

  it('coalesces every card on screen into one request', async () => {
    render(
      <>
        <DeviceCard device={base} />
        <DeviceCard device={{ ...base, id: 'device-b' }} />
        <DeviceCard device={{ ...base, id: 'device-c' }} />
      </>,
    );
    await screen.findByTestId('device-device-a-attention-alerts');
    expect(attentionCalls()).toHaveLength(1);
  });

  it('does not ask for network or manual cards', async () => {
    render(
      <>
        <DeviceCard device={base} />
        <DeviceCard device={{ ...base, id: 'net-1', deviceClass: 'network' } as Device} />
        <DeviceCard device={{ ...base, id: 'manual-1', deviceClass: 'manual' } as Device} />
      </>,
    );
    // Positive control: the agent card's request went out and rendered.
    await screen.findByTestId('device-device-a-attention-alerts');
    expect(attentionCalls()).toHaveLength(1);
    const ids = new URL(attentionCalls()[0]![0] as string, 'http://x').searchParams.get('ids')!.split(',');
    expect(ids).toEqual(['device-a']);
  });
});
