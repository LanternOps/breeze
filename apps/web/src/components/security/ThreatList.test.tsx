import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchWithAuth, showToastMock } = vi.hoisted(() => ({
  fetchWithAuth: vi.fn(),
  showToastMock: vi.fn(),
}));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));
vi.mock('../shared/Toast', () => ({ showToast: showToastMock }));

import ThreatList from './ThreatList';

const fetchWithAuthMock = fetchWithAuth;

function ok(body: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as Response;
}

function makeJsonResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: async () => payload,
  } as Response;
}

const threatFixture = {
  id: 't1',
  deviceId: 'dev-1',
  deviceName: 'Workstation 1',
  name: 'Emotet',
  category: 'trojan',
  severity: 'critical',
  status: 'active',
  detectedAt: '2026-06-20T00:00:00Z',
  filePath: 'C:\\temp\\evil.exe',
};

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
  showToastMock.mockClear();
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

  it('toasts when a quarantine action fails', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [threatFixture] }));
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ error: 'device offline' }, false, 409),
    );
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [threatFixture] }));

    render(<ThreatList />);

    const desktop = within(await screen.findByTestId('responsive-table-desktop'));
    fireEvent.click(await desktop.findByTestId('threat-row-select-t1'));
    fireEvent.click(screen.getByTestId('threat-bulk-quarantine'));

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
    ));
  });

  it('toasts on success', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [threatFixture] }));
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: { id: threatFixture.id } }));
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [threatFixture] }));

    render(<ThreatList />);

    const desktop = within(await screen.findByTestId('responsive-table-desktop'));
    fireEvent.click(await desktop.findByTestId('threat-row-select-t1'));
    fireEvent.click(screen.getByTestId('threat-bulk-quarantine'));

    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success' }),
    ));
  });
});
