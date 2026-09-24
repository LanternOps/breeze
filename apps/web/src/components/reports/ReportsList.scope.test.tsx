import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

const fetchWithAuth = vi.fn();
const authUser = vi.hoisted(() => ({ canManagePartnerWide: undefined as boolean | undefined }));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  useAuthStore: (selector: (s: { user: { canManagePartnerWide?: boolean } }) => unknown) =>
    selector({ user: { canManagePartnerWide: authUser.canManagePartnerWide } }),
}));

vi.mock('./reportExport', () => ({
  exportReport: vi.fn(),
  downloadBlob: vi.fn(),
  getBrowserTimezone: () => 'UTC',
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const claims = vi.hoisted(() => ({
  value: { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } } as unknown,
}));
vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => claims.value }));
const org = vi.hoisted(() => ({ currentOrgId: null as string | null }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: org.currentOrgId }) }));

import ReportsList from './ReportsList';

const base = {
  type: 'ar_aging',
  schedule: 'monthly',
  format: 'pdf',
  config: {},
  portalSelfService: false,
  lastGeneratedAt: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};
const partnerOwned = { ...base, id: 'rep-p', name: 'All-clients AR', orgId: null, partnerId: 'p-1' };
const orgOwned = { ...base, id: 'rep-o', name: 'Acme AR', orgId: 'org-1', partnerId: null };

function mockList(rows: unknown[]) {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url === '/reports') return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: rows }) });
    if (url.startsWith('/reports/runs?')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

describe('ReportsList ownership (#3198 W03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claims.value = { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } };
    org.currentOrgId = null;
    authUser.canManagePartnerWide = undefined;
  });

  it('tags every row and badges only the partner-owned (all-organizations) one', async () => {
    mockList([partnerOwned, orgOwned]);
    render(<ReportsList />);

    const partnerRow = await screen.findByTestId('report-row-rep-p');
    const orgRow = screen.getByTestId('report-row-rep-o');
    const badge = within(partnerRow).getByTestId('report-scope-badge-rep-p');
    expect(within(badge).getByTestId('scope-badge')).toBeInTheDocument();
    expect(within(orgRow).queryByTestId('report-scope-badge-rep-o')).toBeNull();
    expect(within(orgRow).queryByTestId('scope-badge')).toBeNull();
  });

  it('keeps the ambient org injection on the list request (no skipOrgIdInjection)', async () => {
    mockList([orgOwned]);
    render(<ReportsList />);
    await screen.findByTestId('report-row-rep-o');
    const listCall = fetchWithAuth.mock.calls.find(([url]) => url === '/reports');
    expect(listCall).toBeDefined();
    expect(listCall?.[1]).toBeUndefined();
  });

  it('keeps the recent-runs panel cross-org: GET /reports/runs is not ambient-org scoped (#6771)', async () => {
    // #6771 made GET /reports/runs honor ?orgId= (single-org run listing, the
    // way inactive-org report history is read). The ambient org injection
    // would otherwise silently narrow this panel — and drop partner-owned
    // runs — whenever the switcher points at one org.
    org.currentOrgId = 'org-1';
    mockList([orgOwned]);
    render(<ReportsList />);
    await screen.findByTestId('report-row-rep-o');
    await waitFor(() =>
      expect(fetchWithAuth.mock.calls.some(([url]) => String(url).startsWith('/reports/runs?limit='))).toBe(true),
    );
    const runsCall = fetchWithAuth.mock.calls.find(([url]) => String(url).startsWith('/reports/runs?limit='));
    expect((runsCall?.[1] as { skipOrgIdInjection?: boolean } | undefined)?.skipOrgIdInjection).toBe(true);
  });

  it('merges partner-owned reports into an org-focused list for a partner-scope user', async () => {
    org.currentOrgId = 'org-1';
    const otherOrgOwned = { ...base, id: 'rep-x', name: 'Other org AR', orgId: 'org-2', partnerId: null };
    fetchWithAuth.mockImplementation((url: string, opts?: { skipOrgIdInjection?: boolean }) => {
      if (url.startsWith('/reports?') && opts?.skipOrgIdInjection) {
        // The server-filtered partner-owned listing. A misbehaving response that
        // also carried org-owned rows must still merge only the partner row.
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [partnerOwned, orgOwned, otherOrgOwned], pagination: { page: 1, limit: 100, total: 3 } }) });
      }
      if (url === '/reports') return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [orgOwned] }) });
      if (url.startsWith('/reports/runs?')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    });
    render(<ReportsList />);

    const partnerRow = await screen.findByTestId('report-row-rep-p');
    expect(within(partnerRow).getByTestId('report-scope-badge-rep-p')).toBeInTheDocument();
    // Deduped: the focused org's row renders once; another org's row never leaks in.
    expect(screen.getAllByTestId('report-row-rep-o')).toHaveLength(1);
    expect(screen.queryByTestId('report-row-rep-x')).toBeNull();
    // It asks the server for partner-owned rows only, never every org's reports.
    const wide = fetchWithAuth.mock.calls.filter(([url, o]) => String(url).startsWith('/reports?') && (o as { skipOrgIdInjection?: boolean } | undefined)?.skipOrgIdInjection);
    expect(wide).toHaveLength(1);
    const q = new URLSearchParams(String(wide[0]![0]).split('?')[1]);
    expect(q.get('ownerScope')).toBe('partner');
    expect(q.get('page')).toBe('1');
    expect(q.get('limit')).toBe('100');
  });

  it('still renders the org list when the partner-wide fetch fails', async () => {
    org.currentOrgId = 'org-1';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchWithAuth.mockImplementation((url: string, opts?: { skipOrgIdInjection?: boolean }) => {
      if (url.startsWith('/reports?') && opts?.skipOrgIdInjection) return Promise.reject(new Error('boom'));
      if (url === '/reports') return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [orgOwned] }) });
      if (url.startsWith('/reports/runs?')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    });
    render(<ReportsList />);
    expect(await screen.findByTestId('report-row-rep-o')).toBeInTheDocument();
    await waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });

  it('makes one list fetch on the All-organizations view', async () => {
    mockList([partnerOwned]);
    render(<ReportsList />);
    await screen.findByTestId('report-row-rep-p');
    expect(fetchWithAuth.mock.calls.filter(([url]) => url === '/reports')).toHaveLength(1);
  });

  it('does no partner-wide fetch for an organization-scope user or while the token is unresolved', async () => {
    org.currentOrgId = 'org-1';
    claims.value = { status: 'resolved', claims: { scope: 'organization', orgId: 'org-1', partnerId: 'p-1' } };
    mockList([orgOwned]);
    const { unmount } = render(<ReportsList />);
    await screen.findByTestId('report-row-rep-o');
    expect(fetchWithAuth.mock.calls.filter(([url]) => url === '/reports')).toHaveLength(1);
    unmount();

    fetchWithAuth.mockClear();
    claims.value = { status: 'unresolved' };
    render(<ReportsList />);
    await waitFor(() => expect(screen.getByTestId('report-row-rep-o')).toBeInTheDocument());
    expect(fetchWithAuth.mock.calls.filter(([url]) => url === '/reports')).toHaveLength(1);
  });

  it('pages the all-organizations listing so partner-owned rows past page 1 are merged', async () => {
    org.currentOrgId = 'org-1';
    const partnerOwned2 = { ...partnerOwned, id: 'rep-p2', name: 'Older all-clients AR' };
    const wideUrls: string[] = [];
    fetchWithAuth.mockImplementation((url: string, opts?: { skipOrgIdInjection?: boolean }) => {
      if (url.startsWith('/reports?') && opts?.skipOrgIdInjection) {
        wideUrls.push(url);
        const page = Number(new URLSearchParams(url.split('?')[1]).get('page'));
        const fullPage = [partnerOwned, ...Array.from({ length: 99 }, (_, i) => ({ ...partnerOwned, id: `rep-p-${i}` }))];
        const data = page === 1 ? fullPage : page === 2 ? [partnerOwned2] : [];
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data, pagination: { page, limit: 100, total: 101 } }) });
      }
      if (url === '/reports') return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [orgOwned] }) });
      if (url.startsWith('/reports/runs?')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    });
    render(<ReportsList />);

    expect(await screen.findByTestId('report-row-rep-p2')).toBeInTheDocument();
    expect(screen.getByTestId('report-row-rep-p')).toBeInTheDocument();
    expect(wideUrls).toHaveLength(2);
    expect(wideUrls.every((u) => new URLSearchParams(u.split('?')[1]).get('limit') === '100')).toBe(true);
  });

  it('stops paging at the page cap and says so on the page', async () => {
    org.currentOrgId = 'org-1';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let wideCalls = 0;
    fetchWithAuth.mockImplementation((url: string, opts?: { skipOrgIdInjection?: boolean }) => {
      if (url.startsWith('/reports?') && opts?.skipOrgIdInjection) {
        wideCalls += 1;
        const page = Number(new URLSearchParams(url.split('?')[1]).get('page'));
        const data = Array.from({ length: 100 }, (_, i) => ({ ...partnerOwned, id: `rep-p-${page}-${i}` }));
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data, pagination: { page, limit: 100, total: 100000 } }) });
      }
      if (url === '/reports') return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [orgOwned] }) });
      if (url.startsWith('/reports/runs?')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    });
    render(<ReportsList />);

    // 2,000 rows render: generous timeouts so a loaded CI box does not flake.
    expect(await screen.findByTestId('reports-partner-wide-incomplete', {}, { timeout: 15000 })).toBeInTheDocument();
    expect(wideCalls).toBe(20);
    expect(screen.getByTestId('report-row-rep-p-20-99')).toBeInTheDocument();
    warn.mockRestore();
  }, 30000);

  it('keeps paging a full page when the response has no pagination.total, and stops on a short page', async () => {
    org.currentOrgId = 'org-1';
    const wideUrls: string[] = [];
    fetchWithAuth.mockImplementation((url: string, opts?: { skipOrgIdInjection?: boolean }) => {
      if (url.startsWith('/reports?') && opts?.skipOrgIdInjection) {
        wideUrls.push(url);
        const page = Number(new URLSearchParams(url.split('?')[1]).get('page'));
        const data = page === 1
          ? Array.from({ length: 100 }, (_, i) => ({ ...partnerOwned, id: `rep-p-${i}` }))
          : [{ ...partnerOwned, id: 'rep-p-last' }];
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data }) });
      }
      if (url === '/reports') return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [orgOwned] }) });
      if (url.startsWith('/reports/runs?')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    });
    render(<ReportsList />);

    expect(await screen.findByTestId('report-row-rep-p-last')).toBeInTheDocument();
    expect(wideUrls).toHaveLength(2);
    expect(screen.queryByTestId('reports-partner-wide-incomplete')).toBeNull();
  });

  it('shows what it has, and says the list is incomplete, when a later page fails', async () => {
    org.currentOrgId = 'org-1';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchWithAuth.mockImplementation((url: string, opts?: { skipOrgIdInjection?: boolean }) => {
      if (url.startsWith('/reports?') && opts?.skipOrgIdInjection) {
        const page = Number(new URLSearchParams(url.split('?')[1]).get('page'));
        if (page === 2) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
        const data = Array.from({ length: 100 }, (_, i) => ({ ...partnerOwned, id: `rep-p-${i}` }));
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data, pagination: { page, limit: 100, total: 150 } }) });
      }
      if (url === '/reports') return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [orgOwned] }) });
      if (url.startsWith('/reports/runs?')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    });
    render(<ReportsList />);

    expect(await screen.findByTestId('report-row-rep-p-99')).toBeInTheDocument();
    expect(screen.getByTestId('report-row-rep-o')).toBeInTheDocument();
    expect(await screen.findByTestId('reports-partner-wide-incomplete')).toBeInTheDocument();
    warn.mockRestore();
  });

  it('says the list is incomplete when the partner-wide fetch throws', async () => {
    org.currentOrgId = 'org-1';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchWithAuth.mockImplementation((url: string, opts?: { skipOrgIdInjection?: boolean }) => {
      if (url.startsWith('/reports?') && opts?.skipOrgIdInjection) return Promise.reject(new Error('boom'));
      if (url === '/reports') return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [orgOwned] }) });
      if (url.startsWith('/reports/runs?')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    });
    render(<ReportsList />);
    expect(await screen.findByTestId('report-row-rep-o')).toBeInTheDocument();
    expect(await screen.findByTestId('reports-partner-wide-incomplete')).toBeInTheDocument();
    warn.mockRestore();
  });

  it('renders a partner-owned row once when paging returns it twice (rows shifted between pages)', async () => {
    org.currentOrgId = 'org-1';
    fetchWithAuth.mockImplementation((url: string, opts?: { skipOrgIdInjection?: boolean }) => {
      if (url.startsWith('/reports?') && opts?.skipOrgIdInjection) {
        const page = Number(new URLSearchParams(url.split('?')[1]).get('page'));
        const data = page === 1
          ? [partnerOwned, ...Array.from({ length: 99 }, (_, i) => ({ ...partnerOwned, id: `rep-p-${i}` }))]
          : [partnerOwned];
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data, pagination: { page, limit: 100, total: 101 } }) });
      }
      if (url === '/reports') return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [orgOwned] }) });
      if (url.startsWith('/reports/runs?')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ReportsList />);

    await screen.findByTestId('report-row-rep-p-98');
    expect(screen.getAllByTestId('report-row-rep-p')).toHaveLength(1);
    // No duplicate-key warning from React.
    expect(errors.mock.calls.some((c) => String(c[0]).includes('same key'))).toBe(false);
    errors.mockRestore();
  });

  it('does no partner-wide fetch for a partner user without partner-wide access (orgAccess "selected")', async () => {
    org.currentOrgId = 'org-1';
    authUser.canManagePartnerWide = false;
    mockList([orgOwned]);
    render(<ReportsList />);
    await screen.findByTestId('report-row-rep-o');
    const wide = fetchWithAuth.mock.calls.filter(([url, o]) => String(url).startsWith('/reports?') && (o as { skipOrgIdInjection?: boolean } | undefined)?.skipOrgIdInjection);
    expect(wide).toHaveLength(0);
  });

  it('switching from a focused org to All organizations refetches once, unmerged, with no stale rows', async () => {
    org.currentOrgId = 'org-1';
    const otherOrgOwned = { ...base, id: 'rep-x', name: 'Other org AR', orgId: 'org-2', partnerId: null };
    fetchWithAuth.mockImplementation((url: string, opts?: { skipOrgIdInjection?: boolean }) => {
      if (url.startsWith('/reports?') && opts?.skipOrgIdInjection) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [partnerOwned], pagination: { page: 1, limit: 100, total: 1 } }) });
      }
      if (url === '/reports') {
        // The ambient org injection lives in fetchWithAuth; model it with the store.
        const rows = org.currentOrgId ? [orgOwned] : [partnerOwned, orgOwned, otherOrgOwned];
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: rows }) });
      }
      if (url.startsWith('/reports/runs?')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    });
    const { rerender } = render(<ReportsList />);
    expect(await screen.findByTestId('report-row-rep-p')).toBeInTheDocument();
    expect(screen.queryByTestId('report-row-rep-x')).toBeNull();

    fetchWithAuth.mockClear();
    org.currentOrgId = null;
    rerender(<ReportsList />);

    expect(await screen.findByTestId('report-row-rep-x')).toBeInTheDocument();
    expect(screen.getAllByTestId('report-row-rep-p')).toHaveLength(1);
    expect(screen.getAllByTestId('report-row-rep-o')).toHaveLength(1);
    expect(screen.getAllByTestId(/^report-row-/)).toHaveLength(3);
    expect(fetchWithAuth.mock.calls.filter(([url]) => url === '/reports')).toHaveLength(1);
    const wide = fetchWithAuth.mock.calls.filter(([url, o]) => String(url).startsWith('/reports?') && (o as { skipOrgIdInjection?: boolean } | undefined)?.skipOrgIdInjection);
    expect(wide).toHaveLength(0);
  });

  it('ignores a stale unmerged list response that lands after the merged one', async () => {
    org.currentOrgId = 'org-1';
    claims.value = { status: 'unresolved' };
    let releaseStale: () => void = () => {};
    let ownCalls = 0;
    fetchWithAuth.mockImplementation((url: string, opts?: { skipOrgIdInjection?: boolean }) => {
      if (url.startsWith('/reports?') && opts?.skipOrgIdInjection) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [partnerOwned], pagination: { page: 1, limit: 100, total: 1 } }) });
      }
      if (url === '/reports') {
        ownCalls += 1;
        const ok = { ok: true, json: () => Promise.resolve({ data: [orgOwned] }) };
        if (ownCalls === 1) return new Promise((resolve) => { releaseStale = () => resolve(ok); });
        return Promise.resolve(ok);
      }
      if (url.startsWith('/reports/runs?')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    });
    const { rerender } = render(<ReportsList />);
    await waitFor(() => expect(ownCalls).toBe(1));

    // The token resolves: the merge flag flips and the list is refetched.
    claims.value = { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } };
    rerender(<ReportsList />);
    expect(await screen.findByTestId('report-row-rep-p')).toBeInTheDocument();

    // The first (unmerged) response lands late — it must not clobber the merge.
    releaseStale();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId('report-row-rep-p')).toBeInTheDocument();
    // The runs list is not refetched just because the merge flag flipped.
    expect(fetchWithAuth.mock.calls.filter(([url]) => String(url).startsWith('/reports/runs?'))).toHaveLength(1);
  });
});
