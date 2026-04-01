import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import HypervDashboard from './HypervDashboard';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('./HypervVMActions', () => ({
  default: () => <div>Hyper-V VM Actions</div>,
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const mockVms = [
  {
    id: 'vm-row-1',
    deviceId: 'host-1',
    vmId: 'vm-1',
    vmName: 'SQL-VM',
    state: 'Running',
    generation: 2,
    memoryMb: 8192,
    processorCount: 4,
    vhdPaths: ['C:/VMs/SQL-VM.vhdx'],
    rctEnabled: true,
    hasPassthroughDisks: false,
    checkpoints: [],
  },
];

describe('HypervDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/hyperv/vms') {
        return makeJsonResponse({ vms: mockVms, total: 1 });
      }
      if (url === '/devices?limit=200') {
        return makeJsonResponse({
          data: [{ id: 'host-1', displayName: 'hyperv-01', osType: 'Windows Server 2022' }],
        });
      }
      return makeJsonResponse({}, false, 404);
    });
  });

  it('renders loading state', () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));

    render(<HypervDashboard />);

    expect(screen.getByText('Loading Hyper-V VMs...')).toBeTruthy();
  });

  it('renders empty state when no VMs exist', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/hyperv/vms') {
        return makeJsonResponse({ vms: [], total: 0 });
      }
      if (url === '/devices?limit=200') {
        return makeJsonResponse({
          data: [{ id: 'host-1', displayName: 'hyperv-01', osType: 'Windows Server 2022' }],
        });
      }
      return makeJsonResponse({}, false, 404);
    });

    render(<HypervDashboard />);

    await screen.findByText('No Hyper-V VMs found');
    expect(screen.getByText(/Select a Windows host and run discovery/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Run discovery/i })).toBeTruthy();
  });

  it('renders alpha banner', async () => {
    render(<HypervDashboard />);

    await screen.findByText('Hyper-V Backup');
    expect(screen.getByText(/Hyper-V VM backup and restore is in early access/i)).toBeTruthy();
  });

  it('renders VMs from the API vms payload shape used by the backend route', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ vms: mockVms, total: 1 }));

    render(<HypervDashboard />);

    expect(await screen.findByText('SQL-VM')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
  });
});
