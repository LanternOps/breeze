import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    databases: [
      {
        name: 'AppDb',
        recoveryModel: 'full',
        sizeMb: 512,
        tdeEnabled: false,
      },
    ],
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
      if (url === '/backup/mssql/discovery-targets') {
        return makeJsonResponse({
          data: [{ id: 'device-1', displayName: 'Server 01', osType: 'windows', status: 'online', eligible: true }],
        });
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
      if (url === '/backup/mssql/discovery-targets') {
        return makeJsonResponse({
          data: [{ id: 'device-1', displayName: 'Server 01', osType: 'windows', status: 'online', eligible: true }],
        });
      }
      return makeJsonResponse({});
    });

    render(<MssqlDashboard />);

    await screen.findByText('No SQL Server instances found');
    expect(screen.getByText(/Run discovery on Server 01 to detect SQL Server instances/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Run discovery/i })).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('explains when no protected SQL discovery targets exist', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/mssql/instances' || url === '/backup/mssql/chains') {
        return makeJsonResponse({ data: [] });
      }
      if (url === '/backup/mssql/discovery-targets') {
        return makeJsonResponse({ data: [] });
      }
      return makeJsonResponse({});
    });

    render(<MssqlDashboard />);

    await screen.findByText('No SQL discovery targets available');
    expect(screen.getByText(/Assign an SQL Server backup policy to a Windows device/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Run discovery/i })).toBeNull();
  });

  it('renders alpha banner', async () => {
    render(<MssqlDashboard />);

    await screen.findByText('SQL Server Backup');
    expect(screen.getByText(/SQL Server backup is in early access/i)).toBeTruthy();
  });

  it('sends the provider-backed MSSQL backup payload expected by the API', async () => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';

      if (url === '/backup/mssql/instances') {
        return makeJsonResponse({ data: mockInstances });
      }
      if (url === '/backup/mssql/chains') {
        return makeJsonResponse({ data: [] });
      }
      if (url === '/backup/mssql/discovery-targets') {
        return makeJsonResponse({
          data: [{ id: 'device-1', displayName: 'Server 01', osType: 'windows', status: 'online', eligible: true }],
        });
      }
      if (url === '/backup/mssql/backup' && method === 'POST') {
        return makeJsonResponse({ data: { backupJobId: 'job-1' } });
      }
      return makeJsonResponse({});
    });

    render(<MssqlDashboard />);

    await screen.findByText('MSSQLSERVER');
    fireEvent.click(screen.getByRole('button', { name: /Expand/i }));
    fireEvent.click(screen.getByRole('button', { name: /Backup Now/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/backup/mssql/backup',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: 'device-1',
          instance: 'MSSQLSERVER',
          database: 'AppDb',
          backupType: 'full',
        }),
      })
    ));
    expect(await screen.findByText('Backup started for AppDb.')).toBeTruthy();
  });
});
