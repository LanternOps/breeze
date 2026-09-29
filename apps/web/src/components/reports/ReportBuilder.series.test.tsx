import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  registerOrgIdProvider: vi.fn(),
  useAuthStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector({ user: { canManagePartnerWide: true } }),
    { getState: () => ({}) },
  ),
}));
vi.mock('@/lib/authScope', () => ({
  useJwtClaims: () => ({ status: 'resolved', claims: { scope: 'partner', partnerId: 'p-1', orgId: null } }),
}));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...a: unknown[]) => navigateTo(...a) }));

// W01's real OrgPickerField / useReportTargetOrg run here: with two orgs and no
// focused org, its picker is visible and its org-required guard is armed.
import ReportBuilder from './ReportBuilder';
import { useOrgStore } from '../../stores/orgStore';

const ok = (payload: unknown, status = 200) =>
  Promise.resolve({ ok: true, status, json: () => Promise.resolve(payload) });

function calls(url: string, method: string) {
  return fetchWithAuth.mock.calls.filter(([u, i]) => u === url && (i as { method?: string } | undefined)?.method === method);
}

describe('ReportBuilder — one report per organization (W03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({
      currentOrgId: null,
      organizations: [
        { id: 'o-1', partnerId: 'p-1', name: 'Acme', status: 'active', createdAt: '' },
        { id: 'o-2', partnerId: 'p-1', name: 'Birch', status: 'active', createdAt: '' },
      ],
    });
    fetchWithAuth.mockImplementation((url: string, init?: { method?: string }) => {
      if (url === '/reports/series' && init?.method === 'POST') {
        return ok({ series: { id: 's-new' }, targets: [], orgs: [] }, 201);
      }
      if (url === '/reports/series/recipients/preview') {
        return ok({ totalCustomerRecipients: 2, orgCount: 2, orgsWithoutCustomerRecipient: [] });
      }
      if (url === '/reports' && init?.method === 'POST') return ok({ data: { id: 'rep-1' } }, 201);
      return ok({ data: { rows: [] } });
    });
  });

  it('creates a series: POST /reports/series with org-agnostic config, then opens its drill-down', async () => {
    const user = userEvent.setup();
    render(<ReportBuilder mode="create" defaultValues={{ filters: { siteIds: ['site-1'] } }} />);
    await user.click(await screen.findByTestId('covers-mode-series'));
    await user.type(screen.getByTestId('report-builder-name'), 'Monthly health');
    await user.click(screen.getByTestId('report-builder-submit'));

    await waitFor(() => expect(calls('/reports/series', 'POST')).toHaveLength(1));
    const body = JSON.parse((calls('/reports/series', 'POST')[0]![1] as { body: string }).body);
    expect(body).toMatchObject({
      name: 'Monthly health',
      type: 'device_inventory',
      targetMode: 'all',
      orgIds: [],
      recipientRule: { primaryContact: true, roles: [] },
      internalCc: [],
    });
    expect(body.config).not.toHaveProperty('emailRecipients');
    expect(body.config).not.toHaveProperty('legacyFilters');
    expect(body).not.toHaveProperty('orgId');
    expect(calls('/reports', 'POST')).toHaveLength(0);
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/reports#series/s-new'));
  });

  it('puts W01\'s org picker inside the Covers card in org mode, and hides it in series mode', async () => {
    const user = userEvent.setup();
    render(<ReportBuilder mode="create" />);
    const covers = await screen.findByTestId('report-builder-covers');
    expect(within(covers).getByTestId('report-org-picker')).toBeInTheDocument();
    expect(screen.getAllByTestId('report-org-picker')).toHaveLength(1);
    await user.click(screen.getByTestId('covers-mode-series'));
    expect(screen.queryByTestId('report-org-picker')).toBeNull();
  });

  it('disables site/device/group filtering in series mode and says why', async () => {
    const user = userEvent.setup();
    render(<ReportBuilder mode="create" />);
    await user.click(await screen.findByTestId('covers-mode-series'));
    expect(screen.getByTestId('series-filters-disabled-note')).toBeInTheDocument();
    expect(screen.getByTestId('report-builder-filter-mode-advanced')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /add condition/i }));
    const field = screen.getByRole('combobox', { name: 'Filter field' });
    expect(within(field).queryByRole('option', { name: 'Site' })).toBeNull();
  });

  it('swaps the contact picker for the series recipients section', async () => {
    const user = userEvent.setup();
    render(<ReportBuilder mode="create" />);
    await user.click(await screen.findByTestId('covers-mode-series'));
    expect(screen.getByTestId('series-recipients')).toBeInTheDocument();
  });

  it('refuses Chosen organizations with nothing chosen, client-side', async () => {
    const user = userEvent.setup();
    render(<ReportBuilder mode="create" />);
    await user.click(await screen.findByTestId('covers-mode-series'));
    await user.click(screen.getByTestId('series-target-mode-selected'));
    await user.type(screen.getByTestId('report-builder-name'), 'X');
    await user.click(screen.getByTestId('report-builder-submit'));
    expect(await screen.findByText('Choose at least one organization.', { selector: 'div' })).toBeInTheDocument();
    expect(calls('/reports/series', 'POST')).toHaveLength(0);
  });

  // Review Focus 3.
  it('switching back to one organization posts /reports, never /reports/series', async () => {
    useOrgStore.setState({ currentOrgId: 'o-1' });
    const user = userEvent.setup();
    render(<ReportBuilder mode="create" />);
    await user.click(await screen.findByTestId('covers-mode-series'));
    await user.click(screen.getByTestId('covers-mode-org'));
    await user.type(screen.getByTestId('report-builder-name'), 'Single');
    await user.click(screen.getByTestId('report-builder-submit'));
    await waitFor(() => expect(calls('/reports', 'POST')).toHaveLength(1));
    const body = JSON.parse((calls('/reports', 'POST')[0]![1] as { body: string }).body);
    expect(body).not.toHaveProperty('targetMode');
    expect(body).not.toHaveProperty('recipientRule');
    expect(body.orgId).toBe('o-1');
    expect(calls('/reports/series', 'POST')).toHaveLength(0);
  });
});
