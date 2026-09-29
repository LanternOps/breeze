import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  useAuthStore: (selector: (s: { user: { canManagePartnerWide?: boolean } }) => unknown) =>
    selector({ user: {} }),
}));
vi.mock('./reportExport', () => ({
  exportReport: vi.fn(),
  downloadBlob: vi.fn(),
  getBrowserTimezone: () => 'UTC',
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/authScope', () => ({
  useJwtClaims: () => ({ status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } }),
}));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: null }) }));

import ReportsList from './ReportsList';

// W03: a partner-wide user on All organizations lists children-free rows
// (`/reports?series=exclude`) alongside `/reports/series`.
const isListUrl = (u: string) => u === '/reports' || u === '/reports?series=exclude';

const base = {
  type: 'device_inventory',
  schedule: 'weekly',
  format: 'pdf',
  config: {},
  portalSelfService: false,
  lastGeneratedAt: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};
const acme = { ...base, id: 'rep-a', name: 'Acme inventory', orgId: 'org-a', partnerId: null, orgName: 'Acme Dental', lastDeliveryStatus: 'no_recipients' };
const bravo = { ...base, id: 'rep-b', name: 'Bravo inventory', orgId: 'org-b', partnerId: null, orgName: 'Bravo Law', lastDeliveryStatus: 'sent' };
const combined = { ...base, type: 'ar_aging', id: 'rep-p', name: 'All-clients AR', orgId: null, partnerId: 'p-1', orgName: null, lastDeliveryStatus: null };
const runBase = { status: 'completed', startedAt: null, completedAt: null, outputUrl: null, errorMessage: null, createdAt: '2026-09-02T00:00:00Z' };
const runs = [
  { ...runBase, id: 'run-a', reportId: 'rep-a', reportName: 'Acme inventory', reportType: 'device_inventory', orgId: 'org-a', orgName: 'Acme Dental', deliveryStatus: 'no_recipients', recipientCount: 0 },
  { ...runBase, id: 'run-p', reportId: 'rep-p', reportName: 'All-clients AR', reportType: 'ar_aging', orgId: null, orgName: null, deliveryStatus: 'sent', recipientCount: 0 },
];

function mockApi() {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url === '/reports/series') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data: [] }) });
    if (isListUrl(url)) return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [acme, bravo, combined] }) });
    if (url.startsWith('/reports/runs?')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: runs }) });
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

describe('ReportsList org visibility (multi-org report series W01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApi();
  });

  it('shows a Covers column: the org name, or All organizations · Combined', async () => {
    render(<ReportsList />);

    expect(await screen.findByRole('columnheader', { name: 'Covers' })).toBeInTheDocument();
    const acmeCovers = within(screen.getByTestId('report-row-rep-a')).getByTestId('report-covers-rep-a');
    expect(acmeCovers).toHaveAttribute('data-covers-kind', 'org');
    expect(acmeCovers).toHaveTextContent('Acme Dental');
    const combinedCovers = within(screen.getByTestId('report-row-rep-p')).getByTestId('report-covers-rep-p');
    expect(combinedCovers).toHaveAttribute('data-covers-kind', 'combined');
    expect(combinedCovers).toHaveTextContent('All organizations · Combined');
  });

  it('warns on a row whose latest scheduled run reached nobody, and only there', async () => {
    render(<ReportsList />);

    const chip = await screen.findByTestId('report-no-recipients-rep-a');
    expect(chip).toHaveTextContent('No recipients');
    expect(chip).toHaveAttribute('data-delivery-status', 'no_recipients');
    expect(screen.queryByTestId('report-no-recipients-rep-b')).toBeNull();
    expect(screen.queryByTestId('report-no-recipients-rep-p')).toBeNull();
  });

  it('adds an Org column and a delivery warning to Recent Runs', async () => {
    render(<ReportsList />);
    await screen.findByTestId('report-row-rep-a');
    await userEvent.setup().click(screen.getByTestId('reports-tab-runs'));

    expect(await screen.findByRole('columnheader', { name: 'Organization' })).toBeInTheDocument();
    expect(screen.getByTestId('report-run-covers-run-a')).toHaveTextContent('Acme Dental');
    expect(screen.getByTestId('report-run-covers-run-p')).toHaveAttribute('data-covers-kind', 'combined');
    expect(screen.getByTestId('report-run-delivery-run-a')).toHaveTextContent('No recipients');
    expect(screen.queryByTestId('report-run-delivery-run-p')).toBeNull();
  });
});
