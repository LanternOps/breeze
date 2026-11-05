import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

function serveViolations(violations: unknown[]) {
  fetchMock.mockImplementation((url: string) => {
    if (url.startsWith('/software-policies/compliance/overview'))
      return Promise.resolve(json({ total: 1, compliant: 0, violations: 1, unknown: 0 }));
    if (url.startsWith('/software-policies/violations'))
      return Promise.resolve(
        json({
          data: [
            {
              device: { id: 'd1', hostname: 'host-1' },
              compliance: { policyId: 'p1', violations, lastChecked: '2026-10-22T10:00:00Z' },
            },
          ],
        }),
      );
    return Promise.resolve(json({ data: [] }));
  });
}

// #6958 PR D: the compliance bridge (PR E) emits not_running /
// service_unverified; the recent-violations row now breaks its count down by type.
describe('ComplianceDashboard — per-type violation breakdown (#6958)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders a labelled badge per violation type with counts, service name in the title', async () => {
    serveViolations([
      {
        type: 'not_running',
        severity: 'high',
        service: { name: 'ctrld', observedStatus: 'stopped', observedAt: '2026-10-22T09:59:00Z' },
      },
      { type: 'service_unverified', severity: 'low' },
      { type: 'missing' },
      { type: 'missing' },
    ]);
    render(<ComplianceDashboard />);
    await waitFor(() => expect(screen.getByText('host-1')).toBeInTheDocument());

    const breakdown = screen.getByTestId('violation-types-d1');
    const notRunning = within(breakdown).getByTestId('violation-type-not_running');
    expect(notRunning.textContent).toBe('Not running');
    expect(notRunning.getAttribute('title')).toBe('Service: ctrld');
    expect(notRunning.className).toContain('bg-red-100');

    const unverified = within(breakdown).getByTestId('violation-type-service_unverified');
    expect(unverified.textContent).toBe('Service unverified');
    expect(unverified.className).toContain('bg-muted');
    expect(unverified.getAttribute('title')).toBeNull();

    expect(within(breakdown).getByTestId('violation-type-missing').textContent).toBe('Missing ×2');
    // The existing count line stays.
    expect(screen.getByText('4 violations')).toBeInTheDocument();
  });

  it('falls back to the raw type for an unknown value', async () => {
    serveViolations([{ type: 'prohibited' }, { type: 'unauthorized' }]);
    render(<ComplianceDashboard />);
    await waitFor(() => expect(screen.getByText('host-1')).toBeInTheDocument());
    const breakdown = screen.getByTestId('violation-types-d1');
    expect(within(breakdown).getByTestId('violation-type-prohibited').textContent).toBe('prohibited');
    expect(within(breakdown).getByTestId('violation-type-unauthorized').textContent).toBe('Unauthorized');
  });

  it('renders no breakdown when the row has no violations array', async () => {
    serveViolations(undefined as unknown as unknown[]);
    render(<ComplianceDashboard />);
    await waitFor(() => expect(screen.getByText('host-1')).toBeInTheDocument());
    expect(screen.queryByTestId('violation-types-d1')).toBeNull();
  });
});
