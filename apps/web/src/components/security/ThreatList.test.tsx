import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));

import ThreatList from './ThreatList';

function ok(body: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as Response;
}

type ThreatFixture = {
  id: string;
  deviceId: string;
  deviceName: string;
  name: string;
  category: string;
  severity: string;
  status: string;
  detectedAt: string;
  filePath: string;
};

function routeFetch(rows: ThreatFixture[] = []) {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url.startsWith('/security/threats')) {
      return Promise.resolve(ok({ data: rows }));
    }
    return Promise.resolve(ok({ data: [] }));
  });
}

function getThreatUrls() {
  return fetchWithAuth.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.startsWith('/security/threats'));
}

beforeEach(() => {
  fetchWithAuth.mockReset();
});

describe('ThreatList', () => {
  it('renders threats returned by the API with the default (all) filters', async () => {
    routeFetch([
      {
        id: 't1',
        deviceId: 'dev-1',
        deviceName: 'Workstation 1',
        name: 'Emotet',
        category: 'trojan',
        severity: 'critical',
        status: 'active',
        detectedAt: '2026-06-20T00:00:00Z',
        filePath: 'C:\\temp\\evil.exe',
      },
      {
        id: 't2',
        deviceId: 'dev-2',
        deviceName: 'Workstation 2',
        name: 'Blocked script',
        category: 'script',
        severity: 'medium',
        status: 'quarantined',
        detectedAt: '2026-06-21T00:00:00Z',
        filePath: 'C:\\temp\\script.ps1',
      },
    ]);

    render(<ThreatList />);

    const desktop = within(await screen.findByTestId('responsive-table-desktop'));
    expect(await desktop.findByText('Emotet')).toBeInTheDocument();
    expect(desktop.getByText('Blocked script')).toBeInTheDocument();
    expect(desktop.queryByText('No threats found.')).toBeNull();
  });

  it('omits severity/status params on the initial (all) fetch and adds them once selected', async () => {
    routeFetch([
      {
        id: 't1',
        deviceId: 'dev-1',
        deviceName: 'Workstation 1',
        name: 'Emotet',
        category: 'trojan',
        severity: 'critical',
        status: 'active',
        detectedAt: '2026-06-20T00:00:00Z',
        filePath: 'C:\\temp\\evil.exe',
      },
    ]);

    render(<ThreatList />);

    await waitFor(() => expect(getThreatUrls().length).toBeGreaterThan(0));
    const initialUrl = getThreatUrls()[0];
    const initialParams = new URL(initialUrl, 'http://localhost').searchParams;
    expect(initialParams.get('severity')).toBeNull();
    expect(initialParams.get('status')).toBeNull();

    fetchWithAuth.mockClear();
    const selects = screen.getAllByRole('combobox');
    const [severitySelect, statusSelect] = selects;

    fireEvent.change(severitySelect, { target: { value: 'high' } });
    fireEvent.change(statusSelect, { target: { value: 'quarantined' } });

    await waitFor(() => {
      const latestUrl = getThreatUrls().at(-1) ?? '';
      const params = new URL(latestUrl, 'http://localhost').searchParams;
      expect(params.get('severity')).toBe('high');
      expect(params.get('status')).toBe('quarantined');
    });

    fetchWithAuth.mockClear();
    fireEvent.change(severitySelect, { target: { value: 'all' } });
    fireEvent.change(statusSelect, { target: { value: 'all' } });

    await waitFor(() => {
      const latestUrl = getThreatUrls().at(-1) ?? '';
      const params = new URL(latestUrl, 'http://localhost').searchParams;
      expect(params.get('severity')).toBeNull();
      expect(params.get('status')).toBeNull();
    });
  });

  it('shows all fetched threats when the device filter is left at "all"', async () => {
    routeFetch([
      {
        id: 't1',
        deviceId: 'dev-1',
        deviceName: 'Workstation 1',
        name: 'Emotet',
        category: 'trojan',
        severity: 'critical',
        status: 'active',
        detectedAt: '2026-06-20T00:00:00Z',
        filePath: 'C:\\temp\\evil.exe',
      },
      {
        id: 't2',
        deviceId: 'dev-2',
        deviceName: 'Workstation 2',
        name: 'Blocked script',
        category: 'script',
        severity: 'medium',
        status: 'quarantined',
        detectedAt: '2026-06-21T00:00:00Z',
        filePath: 'C:\\temp\\script.ps1',
      },
    ]);

    render(<ThreatList />);

    const desktop = within(await screen.findByTestId('responsive-table-desktop'));
    await desktop.findByText('Emotet');
    await desktop.findByText('Blocked script');

    const selects = screen.getAllByRole('combobox');
    const deviceSelect = selects[2];
    expect(deviceSelect).toHaveValue('all');
  });
});
