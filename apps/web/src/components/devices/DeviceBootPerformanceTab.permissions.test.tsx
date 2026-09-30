import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceBootPerformanceTab from './DeviceBootPerformanceTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  registerOrgIdProvider: vi.fn(),
}));

const perms = vi.hoisted(() => ({ granted: new Set<string>(['devices:read', 'devices:execute']) }));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ permissions: [], can: (r: string, a: string) => perms.granted.has(`${r}:${a}`) }),
}));

// recharts measures its container; jsdom has no layout.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  };
});

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const DEVICE_ID = '11111111-1111-1111-1111-111111111111';

const jsonResponse = (payload: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const BOOT = {
  id: 'boot-1',
  bootTimestamp: '2026-09-20T08:00:00Z',
  biosSeconds: 5,
  osLoaderSeconds: 3,
  desktopReadySeconds: 20,
  totalBootSeconds: 28,
  startupItemCount: 1,
  startupItems: [
    { name: 'Agent', type: 'service', path: 'C:\\agent.exe', enabled: true, cpuTimeMs: 10, diskIoBytes: 0, impactScore: 3 },
  ],
};

describe('DeviceBootPerformanceTab — Collect now needs devices:execute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    perms.granted = new Set(['devices:read', 'devices:execute']);
  });

  // Collect now sends a live command to the device (POST
  // /devices/:id/collect-boot-metrics, devices.execute on the API). The stored
  // boot history stays readable with devices.read.
  it.each([
    ['with boot history', { boots: [BOOT], summary: null }],
    ['with no boot history yet', { boots: [], summary: null }],
  ])('hides Collect now from read-only roles (%s)', async (_label, payload) => {
    fetchWithAuthMock.mockResolvedValue(jsonResponse(payload));

    perms.granted = new Set(['devices:read']);
    const { unmount } = render(<DeviceBootPerformanceTab deviceId={DEVICE_ID} />);
    await screen.findByTestId(payload.boots.length > 0 ? 'boot-performance-refresh' : 'boot-performance-empty');
    expect(screen.queryByTestId('boot-performance-collect')).toBeNull();
    unmount();

    perms.granted = new Set(['devices:read', 'devices:execute']);
    render(<DeviceBootPerformanceTab deviceId={DEVICE_ID} />);
    expect(await screen.findByTestId('boot-performance-collect')).toBeInTheDocument();
  });
});
