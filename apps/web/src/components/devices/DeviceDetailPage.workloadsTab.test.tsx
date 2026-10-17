import '@/lib/i18n';

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceDetailPage from './DeviceDetailPage';

/**
 * Wiring coverage for the Workloads tab (#8193). DeviceDetailPage's
 * API-response → Device transform is an explicit whitelist, so dropping
 * `hostsWorkloads` there silently hides the tab on every workload host while
 * DeviceDetails' own tests (which pass a ready-made Device) stay green.
 */

const DEVICE_ID = '33333333-3333-3333-3333-333333333333';

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/auth')>();
  return { ...actual, fetchWithAuth: fetchWithAuthMock };
});

vi.mock('../extensions/ExtensionSlotHost', () => ({
  useExtensionSlotDescriptors: () => [],
  default: () => <div data-testid="extension-slot-host-stub" />,
}));

vi.mock('../../hooks/useEventStream', () => ({
  useEventStream: () => ({ subscribe: () => () => undefined }),
}));
vi.mock('@/stores/aiStore', () => ({
  useAiStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ setPageContext: () => undefined }),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 404): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const device = (extra: Record<string, unknown>) => ({
  id: DEVICE_ID,
  hostname: 'WIN-RETIRED-01',
  osType: 'windows',
  osVersion: '11',
  status: 'online',
  orgId: 'org-1',
  siteId: 'site-1',
  agentVersion: '1.0.0',
  tags: [],
  recentMetrics: [],
  ...extra,
});

function mockDetail(payload: Record<string, unknown>) {
  fetchWithAuthMock.mockImplementation((url: string) => {
    if (url === `/devices/${DEVICE_ID}`) return Promise.resolve(jsonResponse(payload));
    return Promise.resolve(jsonResponse({}, false, 404));
  });
}

beforeEach(() => {
  fetchWithAuthMock.mockReset();
  // Every incidental panel fetch 404s; only the device-detail fetch matters,
  // and the badge is required to render even when those 404.
  fetchWithAuthMock.mockResolvedValue(jsonResponse({}, false, 404));
});

async function tabLabels(): Promise<string[]> {
  const user = userEvent.setup();
  await user.click(await screen.findByText('More'));
  const dropdown = (await screen.findByText('Details')).closest('div')!;
  return within(dropdown)
    .getAllByRole('menuitem')
    .map((b) => b.textContent ?? '');
}

describe('DeviceDetailPage — carries `hostsWorkloads` through its transform (#8193)', () => {
  it('shows the Workloads tab when the API marks the device a workload host', async () => {
    mockDetail(device({ hostsWorkloads: true, workloadRuntimes: ['docker'] }));
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    const labels = await tabLabels();
    expect(labels.some((l) => l.includes('Workloads'))).toBe(true);
  });

  it('omits the tab when the API says the device hosts no workloads', async () => {
    mockDetail(device({ hostsWorkloads: false, workloadRuntimes: [] }));
    render(<DeviceDetailPage deviceId={DEVICE_ID} />);
    const labels = await tabLabels();
    expect(labels.some((l) => l.includes('Details'))).toBe(true);
    expect(labels.some((l) => l.includes('Workloads'))).toBe(false);
  });
});
