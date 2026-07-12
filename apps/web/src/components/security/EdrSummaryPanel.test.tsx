import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { fetchWithAuth } = vi.hoisted(() => ({
  fetchWithAuth: vi.fn()
}));

vi.mock('../../stores/auth', () => ({
  fetchWithAuth
}));

import EdrSummaryPanel from './EdrSummaryPanel';

function ok(b: unknown) {
  return { ok: true, status: 200, json: async () => b } as Response;
}

function routeStatus(s1: unknown, huntress: unknown) {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url.startsWith('/s1/status')) return Promise.resolve(ok(s1));
    if (url.startsWith('/huntress/status')) return Promise.resolve(ok(huntress));
    return Promise.resolve(ok({}));
  });
}

beforeEach(() => {
  fetchWithAuth.mockReset();
});

describe('EdrSummaryPanel', () => {
  it('renders S1 + Huntress cards from both status endpoints', async () => {
    routeStatus(
      {
        integration: { id: 'i1' },
        summary: {
          totalAgents: 10,
          mappedDevices: 8,
          infectedAgents: 2,
          activeThreats: 3,
          highOrCriticalThreats: 1,
          pendingActions: 0,
          reportedThreatCount: 5
        }
      },
      {
        integration: { id: 'h1' },
        coverage: {
          totalAgents: 12,
          mappedAgents: 9,
          unmappedAgents: 3,
          offlineAgents: 1
        },
        incidents: { open: 4, bySeverity: [], byStatus: [] }
      }
    );
    render(<EdrSummaryPanel />);
    expect(await screen.findByTestId('edr-card-s1-active-threats')).toHaveTextContent('3');
    expect(screen.getByTestId('edr-card-huntress-open-incidents')).toHaveTextContent('4');
    expect(screen.getByTestId('edr-card-huntress-coverage')).toHaveTextContent('9/12');
  });

  it('hides a provider whose integration is null', async () => {
    routeStatus(
      {
        integration: null,
        summary: {
          totalAgents: 0,
          mappedDevices: 0,
          infectedAgents: 0,
          activeThreats: 0,
          highOrCriticalThreats: 0,
          pendingActions: 0,
          reportedThreatCount: 0
        }
      },
      {
        integration: { id: 'h1' },
        coverage: {
          totalAgents: 5,
          mappedAgents: 5,
          unmappedAgents: 0,
          offlineAgents: 0
        },
        incidents: { open: 0, bySeverity: [], byStatus: [] }
      }
    );
    render(<EdrSummaryPanel />);
    expect(await screen.findByTestId('edr-card-huntress-open-incidents')).toBeInTheDocument();
    expect(screen.queryByTestId('edr-card-s1-active-threats')).toBeNull();
  });

  it('renders nothing when both integrations are unconfigured', async () => {
    routeStatus(
      {
        integration: null,
        summary: {
          totalAgents: 0,
          mappedDevices: 0,
          infectedAgents: 0,
          activeThreats: 0,
          highOrCriticalThreats: 0,
          pendingActions: 0,
          reportedThreatCount: 0
        }
      },
      {
        integration: null,
        coverage: { totalAgents: 0, mappedAgents: 0, unmappedAgents: 0, offlineAgents: 0 },
        incidents: { open: 0, bySeverity: [], byStatus: [] }
      }
    );
    const { container } = render(<EdrSummaryPanel />);
    await waitFor(() =>
      expect(screen.queryByText(/loading edr posture/i)).toBeNull()
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/edr status couldn't be loaded/i)).toBeNull();
  });

  it('shows an unavailable note instead of vanishing when both status fetches fail', async () => {
    fetchWithAuth.mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 500,
        statusText: 'err',
        json: async () => ({})
      } as Response)
    );
    render(<EdrSummaryPanel />);
    expect(
      await screen.findByText(/edr status couldn't be loaded/i)
    ).toBeInTheDocument();
  });

  it('renders Huntress cards even when /s1/status fails (allSettled)', async () => {
    fetchWithAuth.mockImplementation((url: string) => {
      if (url.startsWith('/s1/status')) {
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: 'err',
          json: async () => ({})
        } as Response);
      }
      if (url.startsWith('/huntress/status')) {
        return Promise.resolve(
          ok({
            integration: { id: 'h1' },
            coverage: {
              totalAgents: 5,
              mappedAgents: 5,
              unmappedAgents: 0,
              offlineAgents: 0
            },
            incidents: { open: 2, bySeverity: [], byStatus: [] }
          })
        );
      }
      return Promise.resolve(ok({}));
    });
    render(<EdrSummaryPanel />);
    await waitFor(() =>
      expect(screen.getByTestId('edr-card-huntress-open-incidents')).toHaveTextContent('2')
    );
    expect(screen.queryByTestId('edr-card-s1-active-threats')).toBeNull();
  });
});
