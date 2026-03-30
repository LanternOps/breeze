import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import MssqlDashboard from './MssqlDashboard';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const mockInstances = [
  {
    id: 'instance-1',
    deviceId: 'device-1',
    instanceName: 'MSSQLSERVER',
    version: '2022',
    edition: 'Standard',
    port: 1433,
    status: 'online',
    databases: [],
  },
];

describe('MssqlDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/mssql/instances') {
        return makeJsonResponse({ data: mockInstances });
      }
      if (url === '/backup/mssql/chains') {
        return makeJsonResponse({ data: [] });
      }
      return makeJsonResponse({});
    });
  });

  it('renders loading state', () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));

    render(<MssqlDashboard />);

    expect(screen.getByText('Loading SQL Server instances...')).toBeTruthy();
  });

  it('renders empty state when no instances exist', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/mssql/instances' || url === '/backup/mssql/chains') {
        return makeJsonResponse({ data: [] });
      }
      return makeJsonResponse({});
    });

    render(<MssqlDashboard />);

    await screen.findByText('No SQL Server instances found');
    expect(screen.getByText(/Run discovery on a device with SQL Server/i)).toBeTruthy();
  });

  it('renders alpha banner', async () => {
    render(<MssqlDashboard />);

    await screen.findByText('SQL Server Backup');
    expect(screen.getByText(/SQL Server backup and restore is in early access/i)).toBeTruthy();
  });
});
