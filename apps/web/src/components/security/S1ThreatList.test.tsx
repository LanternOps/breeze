import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
const navigateTo = vi.fn();

vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

import S1ThreatList from './S1ThreatList';

function ok(body: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as Response;
}

type ThreatFixture = {
  id: string;
  orgId: string;
  deviceId?: string | null;
  deviceName?: string | null;
  threatName?: string | null;
  severity?: string | null;
  status: string;
  detectedAt?: string | null;
};

function routeFetch(rows: ThreatFixture[] = [], total = rows.length) {
  fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
    if (url.startsWith('/s1/threats')) {
      return Promise.resolve(ok({ data: rows, pagination: { total, limit: 100, offset: 0 } }));
    }
    if (url === '/s1/threat-action' && init?.method === 'POST') {
      return Promise.resolve(ok({ success: true }));
    }
    return Promise.resolve(ok({ data: [] }));
  });
}

function getS1ThreatUrls() {
  return fetchWithAuth.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.startsWith('/s1/threats'));
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  navigateTo.mockReset();
});

describe('S1ThreatList', () => {
  it('fetches fleet threats without orgId and navigates rows to the device', async () => {
    routeFetch([
      {
        id: 't1',
        orgId: 'org-1',
        deviceId: 'dev-1',
        deviceName: 'Workstation 1',
        threatName: 'Emotet',
        severity: 'critical',
        status: 'active',
        detectedAt: '2026-06-20T00:00:00Z',
      },
    ]);

    render(<S1ThreatList />);

    const desktop = within(await screen.findByTestId('responsive-table-desktop'));
    fireEvent.click(await desktop.findByTestId('s1-row-t1'));

    expect(navigateTo).toHaveBeenCalledWith('/devices/dev-1');
    const firstUrl = getS1ThreatUrls()[0];
    expect(firstUrl).toContain('/s1/threats');
    expect(firstUrl).toContain('limit=100');
    expect(firstUrl).not.toContain('orgId=');
  });

  it('re-runs reads with non-empty filters and omits all/empty filters', async () => {
    routeFetch([
      {
        id: 't2',
        orgId: 'org-2',
        deviceId: 'dev-2',
        threatName: 'Blocked script',
        severity: 'medium',
        status: 'in_progress',
        detectedAt: '2026-06-21T00:00:00Z',
      },
    ]);

    render(<S1ThreatList />);
    await waitFor(() => expect(getS1ThreatUrls().length).toBeGreaterThan(0));
    fetchWithAuth.mockClear();

    fireEvent.change(screen.getByTestId('s1-filter-search'), { target: { value: 'script' } });
    fireEvent.change(screen.getByTestId('s1-filter-severity'), { target: { value: 'high' } });
    fireEvent.change(screen.getByTestId('s1-filter-status'), { target: { value: 'active' } });
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-06-01' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-06-25' } });

    await waitFor(() => {
      const latestUrl = getS1ThreatUrls().at(-1) ?? '';
      const params = new URL(latestUrl, 'http://localhost').searchParams;
      expect(params.get('search')).toBe('script');
      expect(params.get('severity')).toBe('high');
      expect(params.get('status')).toBe('active');
      expect(params.get('start')).toBeTruthy();
      expect(params.get('end')).toBeTruthy();
      expect(params.get('orgId')).toBeNull();
    });

    fireEvent.change(screen.getByTestId('s1-filter-severity'), { target: { value: 'all' } });

    await waitFor(() => {
      const latestUrl = getS1ThreatUrls().at(-1) ?? '';
      const params = new URL(latestUrl, 'http://localhost').searchParams;
      expect(params.get('severity')).toBeNull();
      expect(params.get('search')).toBe('script');
    });
  });

  it('POSTs a threat action with the threat row orgId', async () => {
    let body: unknown;
    fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/s1/threats')) {
        return Promise.resolve(ok({
          data: [
            {
              id: 't1',
              orgId: 'org-7',
              deviceId: 'dev-9',
              threatName: 'X',
              severity: 'high',
              status: 'active',
              detectedAt: '2026-06-20T00:00:00Z',
            },
          ],
          pagination: { total: 1, limit: 100, offset: 0 },
        }));
      }
      if (url === '/s1/threat-action' && init?.method === 'POST') {
        body = JSON.parse(String(init.body));
        return Promise.resolve(ok({ success: true }));
      }
      return Promise.resolve(ok({ data: [] }));
    });

    render(<S1ThreatList />);

    const desktop = within(await screen.findByTestId('responsive-table-desktop'));
    fireEvent.click(await desktop.findByTestId('s1-threat-quarantine-t1'));

    await waitFor(() =>
      expect(body).toEqual({ orgId: 'org-7', action: 'quarantine', threatIds: ['t1'] }),
    );
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it('promotes a threat to an incident and navigates', async () => {
    let body: unknown;
    fetchWithAuth.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/s1/threats')) {
        return Promise.resolve(ok({
          data: [
            {
              id: 't1',
              orgId: 'org-7',
              deviceId: 'dev-9',
              threatName: 'X',
              severity: 'high',
              status: 'active',
              detectedAt: '2026-06-20T00:00:00Z',
            },
          ],
          pagination: { total: 1, limit: 100, offset: 0 },
        }));
      }
      if (url === '/incidents') {
        body = JSON.parse(String(init?.body));
        return Promise.resolve({ ok: true, status: 201, json: async () => ({ id: 'inc-2' }) } as Response);
      }
      return Promise.resolve(ok({ data: [] }));
    });

    render(<S1ThreatList />);

    const desktop = within(await screen.findByTestId('responsive-table-desktop'));
    fireEvent.click(await desktop.findByTestId('s1-promote-t1'));

    await waitFor(() => expect((body as any).orgId).toBe('org-7'));
    expect((body as any).classification).toBe('sentinelone-threat');
    expect(navigateTo).toHaveBeenCalledWith('/incidents/inc-2');
    expect(navigateTo).not.toHaveBeenCalledWith('/devices/dev-9');
  });

  it('renders no remediation buttons for non-active threats', async () => {
    routeFetch([
      {
        id: 't9',
        orgId: 'org-9',
        deviceId: 'dev-9',
        threatName: 'Resolved item',
        severity: 'low',
        status: 'resolved',
        detectedAt: '2026-06-20T00:00:00Z',
      },
    ]);

    render(<S1ThreatList />);

    const desktop = within(await screen.findByTestId('responsive-table-desktop'));
    await desktop.findByTestId('s1-row-t9');
    expect(desktop.queryByTestId('s1-threat-kill-t9')).toBeNull();
    expect(desktop.queryByTestId('s1-threat-quarantine-t9')).toBeNull();
    expect(desktop.queryByTestId('s1-threat-rollback-t9')).toBeNull();
    expect(desktop.getByTestId('s1-promote-t9')).toBeInTheDocument();
  });

  it('shows empty and error states', async () => {
    routeFetch([]);
    const { unmount } = render(<S1ThreatList />);
    expect(await screen.findAllByText('No SentinelOne threats found.')).toHaveLength(2);
    unmount();

    fetchWithAuth.mockReset();
    fetchWithAuth.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      json: async () => ({}),
    } as Response);

    render(<S1ThreatList />);
    expect(await screen.findByTestId('s1-error')).toHaveTextContent('Server error');
  });
});
