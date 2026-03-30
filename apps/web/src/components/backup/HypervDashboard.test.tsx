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
    id: 'vm-1',
    deviceId: 'host-1',
    name: 'SQL-VM',
    state: 'Running',
    generation: 2,
    memoryMb: 8192,
    cpuCount: 4,
    vhdCount: 1,
    rctEnabled: true,
    hasPassthroughDisk: false,
    checkpoints: [],
  },
];

describe('HypervDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue(makeJsonResponse({ data: mockVms }));
  });

  it('renders loading state', () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));

    render(<HypervDashboard />);

    expect(screen.getByText('Loading Hyper-V VMs...')).toBeTruthy();
  });

  it('renders empty state when no VMs exist', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ data: [] }));

    render(<HypervDashboard />);

    await screen.findByText('No Hyper-V VMs found');
    expect(screen.getByText(/Run discovery on a Hyper-V host/i)).toBeTruthy();
  });

  it('renders alpha banner', async () => {
    render(<HypervDashboard />);

    await screen.findByText('Hyper-V Backup');
    expect(screen.getByText(/Hyper-V VM backup and restore is in early access/i)).toBeTruthy();
  });
});
