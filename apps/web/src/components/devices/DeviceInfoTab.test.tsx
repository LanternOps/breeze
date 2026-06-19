import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceInfoTab from './DeviceInfoTab';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

// runAction calls showToast; mock it so we can assert error surfaces without
// rendering a real toast.
vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const showToastMock = vi.mocked(showToast);

const deviceId = '11111111-1111-1111-1111-111111111111';

const baseDeviceInfoPayload = {
  hostname: 'TST-LAPTOP-01',
  displayName: null,
  osType: 'windows',
  osVersion: '11',
  tags: [],
  status: 'online',
};

function makeJsonResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

function mockInitialLoad(displayName: string | null) {
  fetchWithAuthMock.mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === `/devices/${deviceId}` && method === 'GET') {
      return makeJsonResponse({
        ...baseDeviceInfoPayload,
        displayName,
      });
    }
    if (url === '/custom-fields') {
      return makeJsonResponse({ data: [] });
    }
    return makeJsonResponse({}, false, 404);
  });
}

describe('DeviceInfoTab — OS version display', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('omits redundant macOS text from the OS Version row', async () => {
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === `/devices/${deviceId}` && method === 'GET') {
        return makeJsonResponse({
          hostname: 'MACBOOK-PRO',
          displayName: null,
          osType: 'macos',
          osVersion: 'darwin 26.5.1',
          osBuild: '25.5.0',
          architecture: 'amd64',
          tags: [],
          status: 'online',
        });
      }
      if (url === '/custom-fields') return makeJsonResponse({ data: [] });
      return makeJsonResponse({}, false, 404);
    });

    render(<DeviceInfoTab deviceId={deviceId} />);

    await screen.findByText('Operating System');
    expect(screen.getByText('macOS')).toBeInTheDocument();
    expect(screen.getByText('26.5.1')).toBeInTheDocument();
    expect(screen.queryByText('macOS 26.5.1')).toBeNull();
  });

  it('capitalizes Linux distro names in the OS Version row', async () => {
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === `/devices/${deviceId}` && method === 'GET') {
        return makeJsonResponse({
          hostname: 'RAMPHEX-PI-P52',
          displayName: null,
          osType: 'linux',
          osVersion: 'raspbian 13.5',
          osBuild: '6.18.33+rpt-rpi-v8',
          architecture: 'arm64',
          tags: [],
          status: 'online',
        });
      }
      if (url === '/custom-fields') return makeJsonResponse({ data: [] });
      return makeJsonResponse({}, false, 404);
    });

    render(<DeviceInfoTab deviceId={deviceId} />);

    await screen.findByText('Operating System');
    expect(screen.getByText('Raspbian 13.5')).toBeInTheDocument();
    expect(screen.queryByText('raspbian 13.5')).toBeNull();
  });
});

describe('DeviceInfoTab — hardware summary display', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders semicolon-delimited GPU models as a vertical list', async () => {
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === `/devices/${deviceId}` && method === 'GET') {
        return makeJsonResponse({
          ...baseDeviceInfoPayload,
          hardware: {
            gpuModel: 'SudoMaker Virtual Display Adapter; Intel(R) Graphics; NVIDIA GeForce RTX 5090',
          },
        });
      }
      if (url === '/custom-fields') return makeJsonResponse({ data: [] });
      return makeJsonResponse({}, false, 404);
    });

    render(<DeviceInfoTab deviceId={deviceId} />);

    await screen.findByText('Hardware Summary');
    expect(screen.getByText('SudoMaker Virtual Display Adapter')).toBeInTheDocument();
    expect(screen.getByText('Intel(R) Graphics')).toBeInTheDocument();
    expect(screen.getByText('NVIDIA GeForce RTX 5090')).toBeInTheDocument();
    expect(
      screen.queryByText('SudoMaker Virtual Display Adapter; Intel(R) Graphics; NVIDIA GeForce RTX 5090'),
    ).toBeNull();
  });

  it('hides placeholder hardware identity values from custom Windows builds', async () => {
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === `/devices/${deviceId}` && method === 'GET') {
        return makeJsonResponse({
          ...baseDeviceInfoPayload,
          hardware: {
            serialNumber: 'System Serial Number',
            manufacturer: 'ASUS',
            model: 'System Product Name',
          },
        });
      }
      if (url === '/custom-fields') return makeJsonResponse({ data: [] });
      return makeJsonResponse({}, false, 404);
    });

    render(<DeviceInfoTab deviceId={deviceId} />);

    await screen.findByText('Hardware Summary');
    expect(screen.getByText('ASUS')).toBeInTheDocument();
    expect(screen.queryByText('System Serial Number')).toBeNull();
    expect(screen.queryByText('System Product Name')).toBeNull();
  });

  it('renders motherboard details in the hardware summary', async () => {
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === `/devices/${deviceId}` && method === 'GET') {
        return makeJsonResponse({
          ...baseDeviceInfoPayload,
          hardware: {
            motherboardManufacturer: 'ASUS',
            motherboardProduct: 'ASUS ROG STRIX Z790-E GAMING WIFI',
            motherboardVersion: 'Rev 1.xx',
          },
        });
      }
      if (url === '/custom-fields') return makeJsonResponse({ data: [] });
      return makeJsonResponse({}, false, 404);
    });

    render(<DeviceInfoTab deviceId={deviceId} />);

    await screen.findByText('Hardware Summary');
    expect(screen.getByText('Motherboard')).toBeInTheDocument();
    expect(screen.getByText('ASUS ROG STRIX Z790-E GAMING WIFI Rev 1.xx')).toBeInTheDocument();
  });
});

describe('DeviceInfoTab — display name inline edit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves a non-empty display name via PATCH', async () => {
    mockInitialLoad('Old Name');
    render(<DeviceInfoTab deviceId={deviceId} />);
    await screen.findByText('Old Name');

    // Wire the PATCH response BEFORE the click.
    fetchWithAuthMock.mockImplementationOnce(async () => makeJsonResponse({ ok: true }));

    fireEvent.click(screen.getByTitle('Edit display name'));
    const input = screen.getByPlaceholderText('Leave blank to clear') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'New Name' } });
    fireEvent.click(screen.getByTitle('Save'));

    await waitFor(() => {
      const patchCall = fetchWithAuthMock.mock.calls.find(
        ([, init]) => init?.method === 'PATCH',
      );
      expect(patchCall).toBeDefined();
      expect(patchCall?.[0]).toBe(`/devices/${deviceId}`);
      expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({ displayName: 'New Name' });
    });

    // After save, modal collapses and the new value renders.
    await waitFor(() => expect(screen.getByText('New Name')).toBeInTheDocument());
  });

  it('CLEARING the display name sends PATCH {displayName: null} (the headline use case)', async () => {
    mockInitialLoad('Existing Name');
    render(<DeviceInfoTab deviceId={deviceId} />);
    await screen.findByText('Existing Name');

    fetchWithAuthMock.mockImplementationOnce(async () => makeJsonResponse({ ok: true }));

    fireEvent.click(screen.getByTitle('Edit display name'));
    const input = screen.getByPlaceholderText('Leave blank to clear') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByTitle('Save'));

    await waitFor(() => {
      const patchCall = fetchWithAuthMock.mock.calls.find(
        ([, init]) => init?.method === 'PATCH',
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse(String(patchCall?.[1]?.body));
      expect(body).toEqual({ displayName: null });
    });

    await waitFor(() => expect(screen.getByText('Not set')).toBeInTheDocument());
  });

  it('whitespace-only input is treated as clearing (trimmed → null)', async () => {
    mockInitialLoad('Existing');
    render(<DeviceInfoTab deviceId={deviceId} />);
    await screen.findByText('Existing');

    fetchWithAuthMock.mockImplementationOnce(async () => makeJsonResponse({ ok: true }));

    fireEvent.click(screen.getByTitle('Edit display name'));
    const input = screen.getByPlaceholderText('Leave blank to clear') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.click(screen.getByTitle('Save'));

    await waitFor(() => {
      const patchCall = fetchWithAuthMock.mock.calls.find(
        ([, init]) => init?.method === 'PATCH',
      );
      const body = JSON.parse(String(patchCall?.[1]?.body));
      expect(body).toEqual({ displayName: null });
    });
  });

  it('Cancel reverts to the original value without firing a PATCH', async () => {
    mockInitialLoad('Original');
    render(<DeviceInfoTab deviceId={deviceId} />);
    await screen.findByText('Original');

    fireEvent.click(screen.getByTitle('Edit display name'));
    const input = screen.getByPlaceholderText('Leave blank to clear') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Discarded edit' } });
    fireEvent.click(screen.getByTitle('Cancel'));

    expect(screen.getByText('Original')).toBeInTheDocument();
    const patchCall = fetchWithAuthMock.mock.calls.find(
      ([, init]) => init?.method === 'PATCH',
    );
    expect(patchCall).toBeUndefined();
  });

  it('surfaces an error toast when the API rejects the save (runAction integration)', async () => {
    mockInitialLoad('Old');
    render(<DeviceInfoTab deviceId={deviceId} />);
    await screen.findByText('Old');

    fetchWithAuthMock.mockImplementationOnce(async () =>
      makeJsonResponse({ error: 'Invalid display name' }, false, 400),
    );

    fireEvent.click(screen.getByTitle('Edit display name'));
    const input = screen.getByPlaceholderText('Leave blank to clear') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'New' } });
    fireEvent.click(screen.getByTitle('Save'));

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: 'Invalid display name' }),
      );
    });
    // The editor should NOT collapse on error — user keeps the chance to fix the value.
    expect(screen.getByPlaceholderText('Leave blank to clear')).toBeInTheDocument();
  });

  it('renders the inline error message at the top of the page (visible even with no custom fields)', async () => {
    mockInitialLoad('Old');
    render(<DeviceInfoTab deviceId={deviceId} />);
    await screen.findByText('Old');

    fetchWithAuthMock.mockImplementationOnce(async () =>
      makeJsonResponse({ error: 'Conflict — name already used' }, false, 409),
    );

    fireEvent.click(screen.getByTitle('Edit display name'));
    fireEvent.change(screen.getByPlaceholderText('Leave blank to clear'), {
      target: { value: 'Dup' },
    });
    fireEvent.click(screen.getByTitle('Save'));

    // The hoisted role="alert" container should render the message regardless
    // of whether the Custom Fields section is present.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Conflict — name already used');
  });
});

describe('DeviceInfoTab — watchdog version display', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the watchdog version when the watchdog has reported one', async () => {
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === `/devices/${deviceId}` && method === 'GET') {
        return makeJsonResponse({
          ...baseDeviceInfoPayload,
          agentVersion: '0.70.0',
          watchdogVersion: '0.70.1',
        });
      }
      if (url === '/custom-fields') return makeJsonResponse({ data: [] });
      return makeJsonResponse({}, false, 404);
    });

    render(<DeviceInfoTab deviceId={deviceId} />);

    await screen.findByText('Watchdog Version');
    expect(screen.getByText('0.70.1')).toBeInTheDocument();
    expect(screen.queryByText('Not Installed')).not.toBeInTheDocument();
  });

  it('shows Not Installed when no watchdog version has ever been reported', async () => {
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === `/devices/${deviceId}` && method === 'GET') {
        return makeJsonResponse({
          ...baseDeviceInfoPayload,
          agentVersion: '0.70.0',
          watchdogVersion: null,
        });
      }
      if (url === '/custom-fields') return makeJsonResponse({ data: [] });
      return makeJsonResponse({}, false, 404);
    });

    render(<DeviceInfoTab deviceId={deviceId} />);

    await screen.findByText('Watchdog Version');
    expect(screen.getByText('Not Installed')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// runAction adoption on the other two mutating handlers in this file.
// ---------------------------------------------------------------------------

describe('DeviceInfoTab — role + custom-field mutations also use runAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Device Role save fires success toast via runAction', async () => {
    // Initial load with a windows device that supports role editing.
    fetchWithAuthMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (url === `/devices/${deviceId}` && method === 'GET') {
        return makeJsonResponse({
          ...baseDeviceInfoPayload,
          displayName: null,
          deviceRole: 'workstation',
          deviceRoleSource: 'auto',
        });
      }
      if (url === '/custom-fields') return makeJsonResponse({ data: [] });
      return makeJsonResponse({}, false, 404);
    });

    render(<DeviceInfoTab deviceId={deviceId} />);
    await screen.findByText('TST-LAPTOP-01');

    // PATCH succeeds with 200.
    fetchWithAuthMock.mockImplementationOnce(async () => makeJsonResponse({ ok: true }));

    const editRoleBtn = screen.getByTitle('Change role');
    fireEvent.click(editRoleBtn);
    // Find the role <select> and pick a non-current value.
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'server' } });
    fireEvent.click(screen.getByTitle('Save'));

    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', message: 'Device role saved' }),
      );
    });
  });
});
