import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ScansTab from './ScansTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('./CreateScanModal', () => ({ default: () => null }));

const fetchMock = vi.mocked(fetchWithAuth);
const res = (payload: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => payload }) as unknown as Response;

const SCAN = {
  id: 'scan-1',
  orgId: 'org-1',
  deviceId: 'dev-1',
  deviceName: 'stale-host-name',
  policyId: null,
  status: 'completed',
  startedAt: '2026-05-21T00:00:00Z',
  completedAt: '2026-05-21T00:05:00Z',
  createdAt: '2026-05-21T00:00:00Z',
};

describe('ScansTab access state (#9697)', () => {
  beforeEach(() => fetchMock.mockReset());

  it('shows the no-access state on a 403', async () => {
    fetchMock.mockResolvedValue(res({ error: 'denied' }, 403));
    render(<ScansTab />);
    expect(await screen.findByText(/You don't have access to this organization/i)).toBeInTheDocument();
    expect(screen.queryByText('Failed to fetch scans')).not.toBeInTheDocument();
  });

  it('drops previous rows when a refresh is denied, and recovers on the next good fetch', async () => {
    fetchMock.mockResolvedValueOnce(res({ data: [SCAN] }));
    render(<ScansTab />);
    expect(await screen.findByText('stale-host-name')).toBeInTheDocument();

    fetchMock.mockResolvedValueOnce(res({ error: 'denied' }, 403));
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    expect(await screen.findByText(/You don't have access to this organization/i)).toBeInTheDocument();
    expect(screen.queryByText('stale-host-name')).not.toBeInTheDocument();
  });

  it('drops previous rows when a refresh fails with a server error', async () => {
    fetchMock.mockResolvedValueOnce(res({ data: [SCAN] }));
    render(<ScansTab />);
    expect(await screen.findByText('stale-host-name')).toBeInTheDocument();

    fetchMock.mockResolvedValueOnce(res({ error: 'boom' }, 500));
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    expect(await screen.findByText('Failed to fetch scans')).toBeInTheDocument();
    expect(screen.queryByText('stale-host-name')).not.toBeInTheDocument();
  });
});
