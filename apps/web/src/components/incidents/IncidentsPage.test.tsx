import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
import IncidentsPage from './IncidentsPage';

function feed(rows: unknown[]) {
  return { ok: true, status: 200, json: async () => ({ data: rows, pagination: { page: 1, limit: 25, total: rows.length } }) } as Response;
}
beforeEach(() => fetchWithAuth.mockReset());

describe('IncidentsPage feed', () => {
  it('renders source badges for tracked and finding rows', async () => {
    fetchWithAuth.mockResolvedValueOnce(feed([
      { kind: 'tracked', source: 'breeze', sourceId: 'i1', title: 'War room', severity: 'p1', edrStatus: null, status: 'analyzing', deviceId: null, detectedAt: '2026-06-20T00:00:00Z', trackedIncidentId: 'i1' },
      { kind: 'finding', source: 'huntress', sourceId: 'hunt-1', title: 'Huntress: Bad login', severity: 'p2', edrStatus: 'open', status: null, deviceId: 'd1', detectedAt: '2026-06-19T00:00:00Z', trackedIncidentId: null },
    ]));
    render(<IncidentsPage />);
    await waitFor(() => expect(screen.getByText('War room')).toBeInTheDocument());
    expect(screen.getByText('Huntress')).toBeInTheDocument();
    expect(screen.getByText('Bad login', { exact: false })).toBeInTheDocument();
  });

  it('hits /incidents/feed', async () => {
    fetchWithAuth.mockResolvedValueOnce(feed([]));
    render(<IncidentsPage />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    expect(fetchWithAuth.mock.calls[0][0]).toContain('/incidents/feed');
  });
});
