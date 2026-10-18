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

function routeStatus(s1: unknown, huntress: unknown, coverage?: unknown) {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url.startsWith('/s1/status')) return Promise.resolve(ok(s1));
    if (url.startsWith('/huntress/status')) return Promise.resolve(ok(huntress));
    if (url.startsWith('/edr/security-agents/coverage') && coverage !== undefined) {
      return Promise.resolve(ok(coverage));
    }
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

const huntressConfigured = {
  integration: { id: 'h1' },
  coverage: { totalAgents: 5, mappedAgents: 5, unmappedAgents: 0, offlineAgents: 0 },
  incidents: { open: 0, bySeverity: [], byStatus: [] }
};
const s1Unconfigured = {
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
};
const huntressUnconfigured = {
  integration: null,
  coverage: { totalAgents: 0, mappedAgents: 0, unmappedAgents: 0, offlineAgents: 0 },
  incidents: { open: 0, bySeverity: [], byStatus: [] }
};
const coveragePayload = {
  summary: [
    {
      vendor: 'huntress',
      total: 6,
      counts: {
        covered: 1,
        gap: 2,
        vendor_only: 0,
        vendor_offline: 3,
        mismatched_org: 4,
        not_applicable: 5,
        pending: 7
      }
    }
  ],
  data: [],
  pagination: { limit: 50, offset: 0, total: 6 }
};

describe('EdrSummaryPanel security agent coverage', () => {
  it('renders per-vendor coverage counts and keeps the existing cards', async () => {
    routeStatus(s1Unconfigured, huntressConfigured, coveragePayload);
    render(<EdrSummaryPanel />);
    const section = await screen.findByTestId('edr-security-agent-coverage');
    expect(section).toHaveTextContent('Huntress');
    expect(screen.getByTestId('coverage-count-huntress-covered')).toHaveTextContent('1');
    expect(screen.getByTestId('coverage-count-huntress-gap')).toHaveTextContent('2');
    expect(screen.getByTestId('coverage-count-huntress-vendor_offline')).toHaveTextContent('3');
    expect(screen.getByTestId('coverage-count-huntress-mismatched_org')).toHaveTextContent('4');
    expect(screen.getByTestId('coverage-count-huntress-not_applicable')).toHaveTextContent('5');
    expect(screen.getByTestId('coverage-count-huntress-vendor_only')).toHaveTextContent('0');
    expect(screen.getByTestId('coverage-count-huntress-pending')).toHaveTextContent('7');
    expect(section).toHaveTextContent(/mismatched org/i);
    expect(screen.getByTestId('edr-card-huntress-coverage')).toBeInTheDocument();
  });

  it('renders the coverage section even when neither integration is configured', async () => {
    routeStatus(s1Unconfigured, huntressUnconfigured, coveragePayload);
    render(<EdrSummaryPanel />);
    expect(await screen.findByTestId('edr-security-agent-coverage')).toBeInTheDocument();
  });

  it('omits the section when the coverage summary is empty', async () => {
    routeStatus(s1Unconfigured, huntressConfigured, { summary: [], data: [], pagination: { limit: 50, offset: 0, total: 0 } });
    render(<EdrSummaryPanel />);
    await screen.findByTestId('edr-card-huntress-coverage');
    expect(screen.queryByTestId('edr-security-agent-coverage')).toBeNull();
  });

  it('logs and omits the section when the coverage fetch fails, leaving the panel intact', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchWithAuth.mockImplementation((url: string) => {
      if (url.startsWith('/s1/status')) return Promise.resolve(ok(s1Unconfigured));
      if (url.startsWith('/huntress/status')) return Promise.resolve(ok(huntressConfigured));
      return Promise.resolve({ ok: false, status: 500, statusText: 'err', json: async () => ({}) } as Response);
    });
    render(<EdrSummaryPanel />);
    expect(await screen.findByTestId('edr-card-huntress-coverage')).toBeInTheDocument();
    expect(screen.queryByTestId('edr-security-agent-coverage')).toBeNull();
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('security-agents/coverage'))).toBe(true);
    errSpy.mockRestore();
  });
});
