import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
const navigateTo = vi.fn();

vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));

import HuntressIncidentList from './HuntressIncidentList';

function ok(body: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as Response;
}

type IncidentFixture = {
  id: string;
  deviceId?: string | null;
  deviceHostname?: string | null;
  title: string;
  severity?: string | null;
  status: string;
  category?: string | null;
  reportedAt?: string | null;
};

function routeFetch(rows: IncidentFixture[] = [], total = rows.length) {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url.startsWith('/huntress/incidents')) {
      return Promise.resolve(ok({ data: rows, total, limit: 100, offset: 0 }));
    }
    return Promise.resolve(ok({ data: [] }));
  });
}

function getHuntressUrls() {
  return fetchWithAuth.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.startsWith('/huntress/incidents'));
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  navigateTo.mockReset();
});

describe('HuntressIncidentList', () => {
  it('lists incidents from the flat envelope and navigates rows to the device', async () => {
    routeFetch([
      {
        id: 'i1',
        deviceId: 'dev-3',
        deviceHostname: 'SRV-2',
        title: 'Persistence',
        severity: 'critical',
        status: 'open',
        category: 'malware',
        reportedAt: '2026-06-21T00:00:00Z',
      },
    ]);

    render(<HuntressIncidentList />);

    const desktop = within(await screen.findByTestId('responsive-table-desktop'));
    expect(desktop.getByText('Persistence')).toBeInTheDocument();
    fireEvent.click(await desktop.findByTestId('huntress-row-i1'));

    expect(navigateTo).toHaveBeenCalledWith('/devices/dev-3');
    const firstUrl = getHuntressUrls()[0];
    expect(firstUrl).toContain('/huntress/incidents');
    expect(firstUrl).toContain('limit=100');
    expect(firstUrl).not.toContain('orgId=');
  });

  it('sends the status filter in the query', async () => {
    routeFetch([]);

    render(<HuntressIncidentList />);
    await waitFor(() => expect(getHuntressUrls().length).toBeGreaterThan(0));
    fetchWithAuth.mockClear();

    fireEvent.change(screen.getByTestId('huntress-filter-status'), { target: { value: 'open' } });

    await waitFor(() => {
      const latestUrl = getHuntressUrls().at(-1) ?? '';
      const params = new URL(latestUrl, 'http://localhost').searchParams;
      expect(params.get('status')).toBe('open');
      expect(params.get('orgId')).toBeNull();
    });
  });
});
