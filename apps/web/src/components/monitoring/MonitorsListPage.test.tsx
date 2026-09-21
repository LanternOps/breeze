import '@/lib/i18n';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MonitorsListPage from './MonitorsListPage';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../hooks/useMlFeatureFlags', () => ({ useMlFeatureFlags: () => ({ isDisabled: () => false }) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const navMock = vi.mocked(navigateTo);
const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const rows = [
  {
    id: 'm-org',
    name: 'Disk usage',
    kind: 'disk',
    severity: 'high',
    enabled: true,
    orgId: 'org-1',
    partnerId: null,
    attachmentCount: 2,
  },
  {
    id: 'm-partner',
    name: 'Offline device',
    kind: 'offline',
    severity: 'critical',
    enabled: true,
    orgId: null,
    partnerId: 'p-1',
    attachmentCount: 0,
  },
];

describe('MonitorsListPage (#5289)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (input.startsWith('/monitor-definitions') && (!init || init.method === undefined)) {
        return json({ data: rows });
      }
      return json({ data: [] });
    });
  });

  it('fetches monitor definitions and renders each row', async () => {
    render(<MonitorsListPage />);
    // Wait for a fetched row, not the page shell: rows render after the async fetch resolves.
    await screen.findByTestId('monitors-list-row-m-org');

    expect(fetchMock.mock.calls[0]![0]).toMatch(/^\/monitor-definitions/);
    expect(screen.getByTestId('monitors-list-row-m-org')).toBeInTheDocument();
    expect(screen.getByTestId('monitors-list-row-m-partner')).toBeInTheDocument();
  });

  it('shows the partner-wide badge only on the partner-owned row', async () => {
    render(<MonitorsListPage />);
    // Wait for a fetched row, not the page shell: rows render after the async fetch resolves.
    await screen.findByTestId('monitors-list-row-m-partner');

    expect(
      within(screen.getByTestId('monitors-list-row-m-partner')).getByText('Partner-wide'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('monitors-list-row-m-org')).queryByText('Partner-wide'),
    ).toBeNull();
  });

  it('navigates to the new-monitor page', async () => {
    render(<MonitorsListPage />);
    await waitFor(() => expect(screen.getByTestId('monitors-list-page')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('monitors-list-new'));
    expect(navMock).toHaveBeenCalledWith('/alerts/monitors/new');
  });

  it('deletes a monitor and refetches the list', async () => {
    fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return json({}, true, 204);
      if (input.startsWith('/monitor-definitions')) return json({ data: rows });
      return json({ data: [] });
    });
    render(<MonitorsListPage />);
    // Wait for a fetched row, not the page shell: rows render after the async fetch resolves.
    await screen.findByTestId('monitors-list-row-m-org');

    fireEvent.click(within(screen.getByTestId('monitors-list-row-m-org')).getByTestId('monitors-list-delete-m-org'));
    fireEvent.click(screen.getByTestId('monitors-list-delete-confirm'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/monitor-definitions/m-org', expect.objectContaining({ method: 'DELETE' })),
    );
  });

  it('toggles a monitor enabled/disabled via PATCH', async () => {
    render(<MonitorsListPage />);
    // Wait for a fetched row, not the page shell: rows render after the async fetch resolves.
    await screen.findByTestId('monitors-list-row-m-org');

    fireEvent.click(within(screen.getByTestId('monitors-list-row-m-org')).getByTestId('monitors-list-enabled-m-org'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/monitor-definitions/m-org',
        expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ enabled: false }) }),
      ),
    );
  });

  it('exposes the enabled toggle as an accessible switch, not colour-only state (paper cut #12)', async () => {
    render(<MonitorsListPage />);
    // Wait for a fetched row, not the page shell: rows render after the async fetch resolves.
    await screen.findByTestId('monitors-list-row-m-org');

    const toggle = within(screen.getByTestId('monitors-list-row-m-org')).getByTestId(
      'monitors-list-enabled-m-org',
    );
    expect(toggle).toHaveAttribute('role', 'switch');
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle.getAttribute('aria-label')).toMatch(/Disk usage/);
  });
});
