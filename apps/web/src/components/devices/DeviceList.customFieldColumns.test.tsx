import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import DeviceList, { type Device } from './DeviceList';
import { useCustomFieldDefinitionsStore } from '../../stores/customFieldDefinitions';
import { writeVisibleCustomFieldKeys } from './customFieldColumnVisibility';

const CUSTOM_DEFS = [
  {
    id: 'cf-1',
    orgId: null,
    partnerId: 'p1',
    name: 'Windows Activation',
    fieldKey: 'bdr_windows_activation',
    type: 'text',
    options: null,
    required: false,
    defaultValue: null,
    deviceTypes: ['windows'],
  },
];

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(async (url: string) => {
    if (url === '/custom-fields') {
      return { ok: true, status: 200, json: async () => ({ data: CUSTOM_DEFS, total: 1 }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }),
  registerOrgIdProvider: vi.fn(),
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

const populated = device('11111111-1111-1111-1111-111111111111', 'win-box', {
  customFields: { bdr_windows_activation: 'Notification' },
});
const empty = device('22222222-2222-2222-2222-222222222222', 'blank-box', {
  customFields: {},
});
// A real network/manual row never carries `customFields` at all (undefined,
// not `{}`) — the API only projects it for agent rows.
const networkRow = device('33333333-3333-3333-3333-333333333333', 'printer-01', {
  deviceClass: 'network',
  assetType: 'printer',
  customFields: undefined,
});

describe('DeviceList — custom field columns (#6594)', () => {
  beforeEach(() => {
    useCustomFieldDefinitionsStore.setState({ definitions: [], status: 'idle' });
  });
  afterEach(() => window.localStorage.clear());

  it('a custom field column is hidden by default even once definitions load', async () => {
    render(<DeviceList devices={[populated]} pageSize={50} />);
    await waitFor(() => {
      expect(useCustomFieldDefinitionsStore.getState().definitions).toHaveLength(1);
    });
    expect(screen.queryByTestId(`device-${populated.id}-custom-bdr_windows_activation`)).toBeNull();
  });

  it('renders the value once the column is opted in via localStorage', async () => {
    writeVisibleCustomFieldKeys(['bdr_windows_activation']);
    render(<DeviceList devices={[populated, empty]} pageSize={50} />);

    await waitFor(() => {
      expect(
        screen.getByTestId(`device-${populated.id}-custom-bdr_windows_activation`).textContent
      ).toBe('Notification');
    });
    expect(
      screen.getByTestId(`device-${empty.id}-custom-bdr_windows_activation`).textContent
    ).toContain('—');
  });

  it('the column picker lists the definition and toggling it shows the column', async () => {
    render(<DeviceList devices={[populated]} pageSize={50} />);
    await waitFor(() => {
      expect(useCustomFieldDefinitionsStore.getState().definitions).toHaveLength(1);
    });

    fireEvent.click(screen.getByText('Columns'));
    const toggle = await screen.findByTestId('custom-column-toggle-bdr_windows_activation');
    fireEvent.click(toggle);

    expect(
      screen.getByTestId(`device-${populated.id}-custom-bdr_windows_activation`).textContent
    ).toBe('Notification');
  });

  it('formats boolean and array custom field values (not just plain strings)', async () => {
    writeVisibleCustomFieldKeys(['bdr_windows_activation']);
    const boolTrue = device('44444444-4444-4444-4444-444444444444', 'bool-true', {
      customFields: { bdr_windows_activation: true },
    });
    const arrayVal = device('55555555-5555-5555-5555-555555555555', 'array-box', {
      customFields: { bdr_windows_activation: ['a', 'b'] },
    });
    render(<DeviceList devices={[boolTrue, arrayVal]} pageSize={50} />);

    await waitFor(() => {
      expect(
        screen.getByTestId(`device-${boolTrue.id}-custom-bdr_windows_activation`).textContent
      ).toBe('Yes');
    });
    expect(
      screen.getByTestId(`device-${arrayVal.id}-custom-bdr_windows_activation`).textContent
    ).toBe('a, b');
  });

  it('a network row with no customFields at all renders a dash, not a crash', async () => {
    writeVisibleCustomFieldKeys(['bdr_windows_activation']);
    render(<DeviceList devices={[networkRow]} pageSize={50} />);

    await waitFor(() => {
      expect(
        screen.getByTestId(`device-${networkRow.id}-custom-bdr_windows_activation`).textContent
      ).toContain('—');
    });
  });

  it('a stale visible key for a deleted custom field does not render a phantom column', async () => {
    // Definition was toggled on, then deleted — localStorage still has the key.
    writeVisibleCustomFieldKeys(['bdr_windows_activation', 'deleted_field']);
    render(<DeviceList devices={[populated]} pageSize={50} />);

    await waitFor(() => {
      expect(
        screen.getByTestId(`device-${populated.id}-custom-bdr_windows_activation`).textContent
      ).toBe('Notification');
    });
    expect(screen.queryByTestId(`device-${populated.id}-custom-deleted_field`)).toBeNull();
  });
});
