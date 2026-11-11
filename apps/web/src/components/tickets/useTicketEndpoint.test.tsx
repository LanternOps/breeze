import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useTicketEndpoint, type TicketEndpoint } from './useTicketEndpoint';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown): Response =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const device = (id: string, hostname: string) => ({
  id, hostname, displayName: null, status: 'online', osType: 'windows', osVersion: '11',
  lastSeenAt: new Date().toISOString(), lastUser: null, uptimeSeconds: 60, pendingReboot: false,
  desktopAccess: null, isHeadless: false, remoteAccessPolicy: null, helperLifecycleMode: null,
});

// Every render's answer, tagged with the device id it was asked about.
const renders: Array<{ deviceId: string | null; endpoint: TicketEndpoint }> = [];
function Probe({ deviceId }: { deviceId: string | null }) {
  const endpoint = useTicketEndpoint(deviceId, true);
  renders.push({ deviceId, endpoint });
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  renders.length = 0;
});

describe('useTicketEndpoint', () => {
  // j/k from ticket A to ticket B: B's endpoint panel must never paint A's
  // device, signed-in user or alerts, not even for the first frame.
  it('never answers for another device: a new device id reads as loading until its own state lands', async () => {
    let releaseB!: () => void;
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/devices/dev-a') return json(device('dev-a', 'a-host'));
      if (url === '/devices/dev-b') return new Promise<Response>((resolve) => { releaseB = () => resolve(json(device('dev-b', 'b-host'))); });
      if (url.endsWith('/sessions/active')) return json({ data: { activeUsers: [] } });
      if (url.includes('/alerts')) return json({ data: [{ id: 'al-1', title: 'Disk full', severity: 'high' }] });
      return json({});
    });

    const { rerender } = render(<Probe deviceId="dev-a" />);
    await waitFor(() => expect(renders.at(-1)?.endpoint.alerts).toEqual([{ id: 'al-1', title: 'Disk full', severity: 'high' }]));

    rerender(<Probe deviceId="dev-b" />);
    const forB = renders.filter((r) => r.deviceId === 'dev-b');
    expect(forB.length).toBeGreaterThan(0);
    for (const r of forB) {
      expect(r.endpoint.state).toEqual({ kind: 'loading' });
      expect(r.endpoint.session).toBeNull();
      expect(r.endpoint.alerts).toBeNull();
    }

    releaseB();
    await waitFor(() => {
      const last = renders.at(-1)!.endpoint.state;
      expect(last.kind === 'ready' && last.device.id).toBe('dev-b');
    });
  });
});
