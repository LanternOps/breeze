import '@/lib/i18n';

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceDetailPage from './DeviceDetailPage';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '@/stores/orgStore';
import type { Device } from './DeviceList';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('../../hooks/useEventStream', () => ({ useEventStream: () => ({ subscribe: vi.fn() }) }));
vi.mock('@/stores/aiStore', () => ({ useAiStore: () => vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('./DeviceDetails', () => ({
  default: ({ device }: { device: Device }) => (
    <span data-testid="device-prop">
      {JSON.stringify({
        manufacturer: device.manufacturer,
        model: device.model,
        serialNumber: device.serialNumber,
        lanIp: device.lanIp,
      })}
    </span>
  ),
}));
vi.mock('./ChangeSiteModal', () => ({ default: () => null }));
vi.mock('./MoveDeviceOrgDialog', () => ({ default: () => null }));
vi.mock('./ScriptPickerModal', () => ({ default: () => null }));

const DEVICE_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

const base = {
  id: DEVICE_ID,
  hostname: 'adrianna',
  osType: 'windows',
  status: 'online',
  orgId: 'org-1',
  orgName: 'Castellini Law',
  siteId: 'site-1',
  siteName: 'Main',
};

async function renderedDevice(payload: Record<string, unknown>) {
  const body = JSON.stringify({ ...base, ...payload });
  // A Response body can be read once: every call gets its own instance.
  vi.mocked(fetchWithAuth).mockImplementation(async () => new Response(body, { status: 200 }));
  render(<DeviceDetailPage deviceId={DEVICE_ID} />);
  return JSON.parse((await screen.findByTestId('device-prop')).textContent ?? '{}');
}

// The header identity strip reads model / serial / LAN IP off the Device the
// page builds. That transform is an explicit whitelist, so a field it drops
// silently never reaches the header while DeviceDetails tests stay green.
describe('DeviceDetailPage → header identity fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({ currentOrgId: null, allOrgs: true } as never);
  });

  it('carries hardware identity and the picked LAN IP through the transform', async () => {
    const d = await renderedDevice({
      hardware: { manufacturer: 'Dell Inc.', model: 'OptiPlex 7060', serialNumber: '4XK9P2' },
      networkInterfaces: [
        { interfaceName: 'Bluetooth', ipAddress: '169.254.1.1', ipType: 'ipv4', isPrimary: false },
        { interfaceName: 'Ethernet 2', ipAddress: '10.0.4.21', ipType: 'ipv4', isPrimary: false },
      ],
    });
    expect(d).toEqual({ manufacturer: 'Dell Inc.', model: 'OptiPlex 7060', serialNumber: '4XK9P2', lanIp: '10.0.4.21' });
  });

  it('drops SMBIOS placeholders and tolerates a payload with no hardware or interfaces', async () => {
    const d = await renderedDevice({
      hardware: { manufacturer: 'System manufacturer', model: 'To Be Filled By O.E.M.', serialNumber: 'Default string' },
    });
    expect(d).toEqual({ manufacturer: null, model: null, serialNumber: null, lanIp: null });
  });
});
