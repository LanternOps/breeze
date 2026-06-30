import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...a: unknown[]) => navigateTo(...a) }));
import IncidentsPage from './IncidentsPage';

function feed(rows: unknown[]) {
  return { ok: true, status: 200, json: async () => ({ data: rows, pagination: { page: 1, limit: 25, total: rows.length } }) } as Response;
}

const trackedRow = { kind: 'tracked', source: 'breeze', sourceId: 'i1', title: 'War room', severity: 'p1', edrStatus: null, status: 'analyzing', deviceId: null, detectedAt: '2026-06-20T00:00:00Z', trackedIncidentId: 'inc-123', linkOut: null };
const findingRow = { kind: 'finding', source: 'huntress', sourceId: 'hunt-1', title: 'Huntress: Bad login', severity: 'p2', edrStatus: 'open', status: null, deviceId: 'd1', detectedAt: '2026-06-19T00:00:00Z', trackedIncidentId: null, linkOut: null };
const findingRowWithLink = { ...findingRow, linkOut: 'https://huntress.io/portal/incident/hunt-1' };

beforeEach(() => {
  fetchWithAuth.mockReset();
  navigateTo.mockReset();
});

describe('IncidentsPage feed', () => {
  it('renders source badges for tracked and finding rows', async () => {
    fetchWithAuth.mockResolvedValueOnce(feed([trackedRow, findingRow]));
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

  it('navigates to the tracked incident detail when a tracked row is clicked', async () => {
    fetchWithAuth.mockResolvedValueOnce(feed([trackedRow]));
    render(<IncidentsPage />);
    await waitFor(() => expect(screen.getByText('War room')).toBeInTheDocument());

    fireEvent.click(screen.getByText('War room'));
    expect(navigateTo).toHaveBeenCalledWith('/incidents/inc-123');
  });

  it('does not navigate when a finding row is clicked', async () => {
    fetchWithAuth.mockResolvedValueOnce(feed([findingRow]));
    render(<IncidentsPage />);
    await waitFor(() => expect(screen.getByText('Bad login', { exact: false })).toBeInTheDocument());

    fireEvent.click(screen.getByText('Bad login', { exact: false }));
    expect(navigateTo).not.toHaveBeenCalled();
  });

  it('passes kind=finding to the feed endpoint when the kind filter is set to Findings', async () => {
    fetchWithAuth.mockResolvedValue(feed([]));
    render(<IncidentsPage />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'finding' } });
    await waitFor(() => {
      const lastUrl = fetchWithAuth.mock.calls[fetchWithAuth.mock.calls.length - 1][0] as string;
      expect(lastUrl).toContain('kind=finding');
    });
  });

  it('passes kind=tracked to the feed endpoint when the kind filter is set to Tracked', async () => {
    fetchWithAuth.mockResolvedValue(feed([]));
    render(<IncidentsPage />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'tracked' } });
    await waitFor(() => {
      const lastUrl = fetchWithAuth.mock.calls[fetchWithAuth.mock.calls.length - 1][0] as string;
      expect(lastUrl).toContain('kind=tracked');
    });
  });

  it('renders "View in Huntress" anchor when linkOut is set on a finding row', async () => {
    fetchWithAuth.mockResolvedValueOnce(feed([findingRowWithLink]));
    render(<IncidentsPage />);
    await waitFor(() => expect(screen.getByText('Bad login', { exact: false })).toBeInTheDocument());

    const link = screen.getByRole('link', { name: /View in Huntress/ });
    expect(link).toHaveAttribute('href', 'https://huntress.io/portal/incident/hunt-1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders the static hint when linkOut is null on a finding row', async () => {
    fetchWithAuth.mockResolvedValueOnce(feed([findingRow]));
    render(<IncidentsPage />);
    await waitFor(() => expect(screen.getByText('Bad login', { exact: false })).toBeInTheDocument());

    expect(screen.getByText('Promote from the EDR view')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /View in/ })).toBeNull();
  });
});
