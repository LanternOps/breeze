import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import CisHardeningPage from './CisHardeningPage';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));

const orgStoreState: {
  currentOrgId: string | null;
  organizations: unknown[];
  organizationsLoaded: boolean;
  allOrgs: boolean;
  error: string | null;
} = {
  currentOrgId: 'org-1',
  organizations: [{ id: 'org-1', name: 'Acme' }],
  organizationsLoaded: true,
  allOrgs: false,
  error: null
};

vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector?: (s: typeof orgStoreState) => unknown) =>
    selector ? selector(orgStoreState) : orgStoreState
}));

// The tabs fetch on their own; isolate the page's three summary requests.
vi.mock('./CisComplianceTab', () => ({ default: () => null }));
vi.mock('./CisBaselinesTab', () => ({ default: () => null }));
vi.mock('./CisRemediationsTab', () => ({ default: () => null }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

function urls(): string[] {
  return fetchWithAuthMock.mock.calls.map((call) => String(call[0]));
}

describe('CisHardeningPage summary org scoping', () => {
  beforeEach(() => {
    orgStoreState.currentOrgId = 'org-1';
    fetchWithAuthMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ summary: null, pagination: { total: 0 } })
    } as unknown as Response);
  });

  // The summary is the one place building the org query by string concatenation
  // across three URLs. A fourth card added later without the param would show
  // fleet-wide totals above a single-org table — two contradictory numbers on
  // one screen, with no error.
  it('scopes all three summary requests to the selected org', async () => {
    render(<CisHardeningPage />);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(3));
    for (const url of urls()) {
      expect(new URL(url, 'http://x').searchParams.get('orgId')).toBe('org-1');
    }
  });

  it('keeps the other query params intact alongside orgId', async () => {
    render(<CisHardeningPage />);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(3));
    const parsed = urls().map((u) => new URL(u, 'http://x').searchParams);
    expect(parsed.map((p) => p.get('limit'))).toEqual(['1', '1', '1']);
    expect(parsed.some((p) => p.get('active') === 'true')).toBe(true);
    expect(parsed.some((p) => p.get('status') === 'pending_approval')).toBe(true);
  });

  it('refetches the summary when the org resolves', async () => {
    orgStoreState.currentOrgId = null;
    const { rerender } = render(<CisHardeningPage />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(3));
    expect(new URL(urls()[0], 'http://x').searchParams.has('orgId')).toBe(false);

    orgStoreState.currentOrgId = 'org-1';
    rerender(<CisHardeningPage />);

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(6));
    for (const url of urls().slice(3)) {
      expect(new URL(url, 'http://x').searchParams.get('orgId')).toBe('org-1');
    }
  });

  // The cold-session refetch above puts two bursts in flight. The unscoped one
  // is slower (it aggregates every accessible org), so without an abort guard
  // it lands last and overwrites the org-scoped totals.
  it('aborts the superseded burst so it cannot overwrite org-scoped totals', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    fetchWithAuthMock.mockImplementation((_url: string, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ summary: null, pagination: { total: 0 } })
      } as unknown as Response);
    });

    orgStoreState.currentOrgId = null;
    const { rerender } = render(<CisHardeningPage />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(3));

    orgStoreState.currentOrgId = 'org-1';
    rerender(<CisHardeningPage />);
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledTimes(6));

    // Every request carries a signal, the first burst's is aborted, and the
    // surviving burst's is not.
    expect(signals).toHaveLength(6);
    expect(signals.every((s) => s !== undefined)).toBe(true);
    expect(signals.slice(0, 3).every((s) => s!.aborted)).toBe(true);
    expect(signals.slice(3).some((s) => s!.aborted)).toBe(false);
  });
});
