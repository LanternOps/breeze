import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const fetchWithAuth = vi.fn();
const authUser = vi.hoisted(() => ({ canManagePartnerWide: true as boolean | undefined }));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  useAuthStore: (selector: (s: { user: { canManagePartnerWide?: boolean } }) => unknown) =>
    selector({ user: { canManagePartnerWide: authUser.canManagePartnerWide } }),
}));
vi.mock('./reportExport', () => ({ exportReport: vi.fn(), downloadBlob: vi.fn(), getBrowserTimezone: () => 'UTC' }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const claims = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => claims.value }));
const org = vi.hoisted(() => ({ currentOrgId: null as string | null }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: org.currentOrgId, organizations: [] }) }));
vi.mock('./series/CombineBanner', () => ({ default: () => <div data-testid="combine-banner-stub" /> }));

import ReportsList from './ReportsList';

const row = {
  id: 'rep-o', name: 'Acme alerts', type: 'alert_summary', schedule: 'weekly', format: 'pdf', config: {},
  orgId: 'org-1', partnerId: null, portalSelfService: false, lastGeneratedAt: null,
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};

function mockList() {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url === '/reports' || url.startsWith('/reports?')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [row] }) });
    if (url.startsWith('/reports/runs?')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

describe('ReportsList Combine banner mount (series W04)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claims.value = { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } };
    org.currentOrgId = null;
    authUser.canManagePartnerWide = true;
    mockList();
  });

  it('shows the banner to a full-access partner user under All organizations', async () => {
    render(<ReportsList />);
    await screen.findByTestId('report-row-rep-o');
    expect(screen.getByTestId('combine-banner-stub')).toBeInTheDocument();
  });

  it('hides it when one organization is focused', async () => {
    org.currentOrgId = 'org-1';
    render(<ReportsList />);
    await screen.findByTestId('report-row-rep-o');
    expect(screen.queryByTestId('combine-banner-stub')).toBeNull();
  });

  it('hides it from a partner user without partner-wide access', async () => {
    authUser.canManagePartnerWide = false;
    render(<ReportsList />);
    await screen.findByTestId('report-row-rep-o');
    expect(screen.queryByTestId('combine-banner-stub')).toBeNull();
  });

  it('hides it from an organization-scope user', async () => {
    claims.value = { status: 'resolved', claims: { scope: 'organization', orgId: 'org-1', partnerId: 'p-1' } };
    render(<ReportsList />);
    await screen.findByTestId('report-row-rep-o');
    expect(screen.queryByTestId('combine-banner-stub')).toBeNull();
  });
});
