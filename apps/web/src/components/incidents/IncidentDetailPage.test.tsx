import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../layout/usePageItemName', () => ({ usePageItemName: () => undefined }));
import IncidentDetailPage from './IncidentDetailPage';

const incident = {
  id: 'inc-1', title: 'War room', severity: 'p1', status: 'analyzing', classification: null,
  summary: null, detectedAt: '2026-06-20T00:00:00Z', containedAt: null, resolvedAt: null, closedAt: null,
};

function mockDetail(timeline: unknown[], actions: unknown[] = []) {
  fetchWithAuth.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ incident, timeline, actions, evidence: [] }),
  } as Response);
}

beforeEach(() => fetchWithAuth.mockReset());

describe('IncidentDetailPage actor labels (#9663)', () => {
  it('shows human labels for timeline actors instead of the raw enum', async () => {
    mockDetail([
      { at: '2026-06-20T01:00:00Z', type: 'a', actor: 'brain', summary: 'Isolated host' },
      { at: '2026-06-20T02:00:00Z', type: 'b', actor: 'user', summary: 'Closed ticket' },
      { at: '2026-06-20T03:00:00Z', type: 'c', actor: 'system', summary: 'Escalated' },
    ]);
    render(<IncidentDetailPage incidentId="inc-1" />);
    expect(await screen.findByText('Breeze AI')).toBeInTheDocument();
    expect(screen.getByText('Technician')).toBeInTheDocument();
    expect(screen.getByText('System')).toBeInTheDocument();
    expect(screen.queryByText('brain')).toBeNull();
  });

  it('shows human labels for action executors', async () => {
    mockDetail([], [
      { id: 'a1', actionType: 'isolate', description: 'Isolate', executedBy: 'brain', status: 'completed', executedAt: '2026-06-20T01:00:00Z' },
    ]);
    render(<IncidentDetailPage incidentId="inc-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /actions/i }));
    expect(await screen.findByText('Breeze AI')).toBeInTheDocument();
    expect(screen.queryByText('brain')).toBeNull();
  });

  it('passes unknown actors through and tolerates null actor / executedBy', async () => {
    mockDetail(
      [
        { at: '2026-06-20T01:00:00Z', type: 'a', actor: 'ai-assistant', summary: 'Unknown actor step' },
        { at: '2026-06-20T02:00:00Z', type: 'b', actor: null, summary: 'No actor step' },
      ],
      [{ id: 'a1', actionType: 'x', description: 'X', executedBy: null, status: 'completed', executedAt: '2026-06-20T01:00:00Z' }],
    );
    render(<IncidentDetailPage incidentId="inc-1" />);
    expect(await screen.findByText('ai-assistant')).toBeInTheDocument();
    expect(screen.getByText('No actor step')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /actions/i }));
    expect(await screen.findByText('-')).toBeInTheDocument();
  });

  it('only hides the exact legacy enricher entry', async () => {
    mockDetail([
      { at: '2026-06-20T01:00:00Z', type: 'timeline_enriched', actor: 'system', summary: 'Added real context' },
      { at: '2026-06-20T02:00:00Z', type: 'a', actor: 'user', summary: 'Added baseline timeline context for open incident' },
    ]);
    render(<IncidentDetailPage incidentId="inc-1" />);
    expect(await screen.findByText('Added real context')).toBeInTheDocument();
    expect(screen.getByText(/baseline timeline context/)).toBeInTheDocument();
  });

  it('hides legacy empty enricher entries', async () => {
    mockDetail([
      { at: '2026-06-20T01:00:00Z', type: 'timeline_enriched', actor: 'system', summary: 'Added baseline timeline context for open incident' },
      { at: '2026-06-20T02:00:00Z', type: 'a', actor: 'user', summary: 'Real step' },
    ]);
    render(<IncidentDetailPage incidentId="inc-1" />);
    expect(await screen.findByText('Real step')).toBeInTheDocument();
    expect(screen.queryByText(/baseline timeline context/)).toBeNull();
  });
});
