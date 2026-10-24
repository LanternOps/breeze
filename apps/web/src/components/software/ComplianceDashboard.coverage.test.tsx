import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/authScope', async () => {
  const actual = await vi.importActual<typeof import('@/lib/authScope')>('@/lib/authScope');
  return { ...actual, getJwtClaims: () => ({ scope: 'organization', partnerId: null, orgId: 'org-1' }) };
});
vi.mock('../../stores/orgStore', () => {
  const state = { currentOrgId: 'org-1', allOrgs: false, organizations: [] };
  return { useOrgStore: (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state) };
});

import ComplianceDashboard from './ComplianceDashboard';
import { fetchWithAuth } from '../../stores/auth';

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const row = (over: Record<string, unknown>) => ({
  id: 'c-x',
  orgId: 'org-1',
  deviceId: 'dev-x',
  deviceName: 'Device-01',
  vendor: 'huntress',
  state: 'gap',
  reasonCode: 'install_failed',
  detail: null,
  lastEvaluatedAt: '2026-06-22T00:00:00Z',
  stateChangedAt: '2026-06-21T00:00:00Z',
  ...over,
});

const coverage = {
  summary: [
    {
      vendor: 'huntress',
      total: 3,
      counts: { covered: 1, gap: 1, vendor_only: 1, vendor_offline: 0, mismatched_org: 0, not_applicable: 0, pending: 0 },
    },
  ],
  data: [
    row({ id: 'c1', deviceName: 'Device-01', state: 'gap', reasonCode: 'install_failed' }),
    row({ id: 'c2', deviceName: 'Device-02', state: 'covered', reasonCode: null }),
    row({ id: 'c3', deviceId: null, deviceName: null, state: 'vendor_only', reasonCode: null }),
  ],
  pagination: { limit: 200, offset: 0, total: 3 },
};

// Mirrors the API: rows honor the state filter, summary always covers all states.
function serverCoverage(total?: number) {
  return (url: string) => {
    const st = new URL(url, 'http://x').searchParams.get('state');
    const data = st ? coverage.data.filter((r) => r.state === st) : coverage.data;
    return Promise.resolve(json({ ...coverage, data, pagination: { limit: 200, offset: 0, total: total ?? data.length } }));
  };
}

function route(cov: (url: string) => Promise<Response>) {
  fetchMock.mockImplementation((url: string) => {
    if (url.startsWith('/software-policies/compliance/overview')) return Promise.resolve(json({ total: 0, compliant: 0, violations: 0, unknown: 0 }));
    if (url.startsWith('/software-policies/violations')) return Promise.resolve(json({ data: [] }));
    if (url.startsWith('/software-policies?')) return Promise.resolve(json({ data: [] }));
    if (url.startsWith('/edr/security-agents/coverage')) return cov(url);
    return Promise.resolve(json({ data: [] }));
  });
}

describe('ComplianceDashboard — security agent coverage strip', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.location.hash = '';
  });
  afterEach(() => {
    window.location.hash = '';
  });

  it('renders one chip per state with counts and fetches for the current org', async () => {
    route(serverCoverage());
    render(<ComplianceDashboard />);
    const strip = await screen.findByTestId('compliance-security-agent-coverage');
    expect(within(strip).getByTestId('coverage-chip-gap')).toHaveTextContent('1');
    expect(within(strip).getByTestId('coverage-chip-covered')).toHaveTextContent('1');
    expect(within(strip).getByTestId('coverage-chip-vendor_only')).toHaveTextContent('1');
    expect(within(strip).getByTestId('coverage-chip-pending')).toHaveTextContent('0');
    const url = fetchMock.mock.calls.map((c) => String(c[0])).find((u) => u.startsWith('/edr/security-agents/coverage'));
    expect(url).toContain('orgId=org-1');
  });

  it('clicking a chip writes #coverage=<state> and filters the table', async () => {
    route(serverCoverage());
    render(<ComplianceDashboard />);
    fireEvent.click(await screen.findByTestId('coverage-chip-vendor_only'));
    expect(window.location.hash).toBe('#coverage=vendor_only');
    await waitFor(() => expect(screen.getAllByTestId('coverage-row')).toHaveLength(1));
    const rows = screen.getAllByTestId('coverage-row');
    expect(rows[0]).toHaveTextContent('Vendor-only agent');
    expect(screen.queryByText('Device-01')).toBeNull();
    const urls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/edr/security-agents/coverage'));
    expect(urls.some((u) => new URL(u, 'http://x').searchParams.get('state') === 'vendor_only')).toBe(true);
  });

  it('refetches server-side so a filtered state is not limited to the unfiltered page', async () => {
    // Unfiltered page holds only gap rows; the covered row only exists server-side.
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith('/software-policies/compliance/overview')) return Promise.resolve(json({ total: 0, compliant: 0, violations: 0, unknown: 0 }));
      if (url.startsWith('/edr/security-agents/coverage')) {
        const st = new URL(url, 'http://x').searchParams.get('state');
        const data = st === 'covered' ? [row({ id: 'k1', deviceName: 'Device-09', state: 'covered', reasonCode: null })] : [coverage.data[0]];
        return Promise.resolve(json({ ...coverage, data, pagination: { limit: 200, offset: 0, total: data.length } }));
      }
      return Promise.resolve(json({ data: [] }));
    });
    render(<ComplianceDashboard />);
    fireEvent.click(await screen.findByTestId('coverage-chip-covered'));
    expect(await screen.findByText('Device-09')).toBeInTheDocument();
  });

  it('shows a "showing N of M" note when the server has more rows than shown', async () => {
    route(serverCoverage(600));
    render(<ComplianceDashboard />);
    fireEvent.click(await screen.findByTestId('coverage-chip-gap'));
    const note = await screen.findByTestId('coverage-rows-note');
    expect(note).toHaveTextContent('Showing 1 of 600');
  });

  it('shows no note when every row is displayed', async () => {
    route(serverCoverage());
    render(<ComplianceDashboard />);
    await screen.findAllByTestId('coverage-row');
    expect(screen.queryByTestId('coverage-rows-note')).toBeNull();
  });

  it('pre-selects the state from the initial hash', async () => {
    window.location.hash = '#coverage=gap';
    route(serverCoverage());
    render(<ComplianceDashboard />);
    const rows = await screen.findAllByTestId('coverage-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Device-01');
    expect(rows[0]).toHaveTextContent('Install failed');
    expect(screen.getByTestId('coverage-chip-gap')).toHaveAttribute('aria-pressed', 'true');
  });

  it('preserves unrelated hash pairs when writing the coverage filter', async () => {
    window.location.hash = '#tab=x';
    route(serverCoverage());
    render(<ComplianceDashboard />);
    fireEvent.click(await screen.findByTestId('coverage-chip-gap'));
    expect(window.location.hash).toContain('tab=x');
    expect(window.location.hash).toContain('coverage=gap');
  });

  it('renders no strip when the org has no coverage rows', async () => {
    route(() => Promise.resolve(json({ summary: [], data: [], pagination: { limit: 200, offset: 0, total: 0 } })));
    render(<ComplianceDashboard />);
    await waitFor(() => expect(screen.getByText('Create Policy')).toBeInTheDocument());
    expect(screen.queryByTestId('compliance-security-agent-coverage')).toBeNull();
  });

  it('logs and omits the strip when the coverage fetch fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    route(() => Promise.resolve({ ok: false, status: 500, statusText: 'err', json: async () => ({}) } as Response));
    render(<ComplianceDashboard />);
    await waitFor(() => expect(screen.getByText('Create Policy')).toBeInTheDocument());
    await waitFor(() => expect(errSpy).toHaveBeenCalled());
    expect(screen.queryByTestId('compliance-security-agent-coverage')).toBeNull();
    errSpy.mockRestore();
  });
});
