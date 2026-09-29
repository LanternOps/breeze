import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  useAuthStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector({ user: { canManagePartnerWide: true } }),
    { getState: () => ({}) },
  ),
}));
vi.mock('@/lib/authScope', () => ({
  useJwtClaims: () => ({ status: 'resolved', claims: { scope: 'partner', partnerId: 'p-1', orgId: null } }),
}));
// Two orgs, none focused: W01's page picker is visible and nothing is picked.
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: () => ({
    currentOrgId: null,
    organizations: [
      { id: 'o-1', partnerId: 'p-1', name: 'Acme', status: 'active', createdAt: '' },
      { id: 'o-2', partnerId: 'p-1', name: 'Birch', status: 'active', createdAt: '' },
    ],
  }),
}));
const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...a: unknown[]) => navigateTo(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

import ReportTemplates from './ReportTemplates';

const ok = (payload: unknown, status = 200) => Promise.resolve({ ok: true, status, json: () => Promise.resolve(payload) });
const posts = (url: string) => fetchWithAuth.mock.calls.filter(([u, i]) => u === url && (i as { method?: string })?.method === 'POST');

async function useTemplate(name: string) {
  const heading = await screen.findByText(name);
  await userEvent.setup().click(within(heading.closest('div.group') as HTMLElement).getByRole('button', { name: /use template/i }));
}

describe('ReportTemplates — one report per organization (W03)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchWithAuth.mockImplementation((url: string, init?: { method?: string }) => {
      if (url === '/reports/series' && init?.method === 'POST') return ok({ series: { id: 's-t' }, targets: [], orgs: [] }, 201);
      if (url === '/reports/series/recipients/preview') return ok({ totalCustomerRecipients: 1, orgCount: 2, orgsWithoutCustomerRecipient: [] });
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    });
  });

  it('a partner-wide user opens a lifecycle template with no org picked and creates a series', async () => {
    const user = userEvent.setup();
    render(<ReportTemplates />);
    await useTemplate('Hardware Lifecycle Report');
    const covers = screen.getByTestId('template-covers-hardware_lifecycle');
    await user.click(within(covers).getByTestId('covers-mode-series'));
    // A recurring template pre-fills its own schedule.
    expect(within(covers).getByTestId('series-schedule-select')).toHaveValue('monthly');
    await user.click(screen.getByTestId('lifecycle-create-report'));
    await waitFor(() => expect(posts('/reports/series')).toHaveLength(1));
    const body = JSON.parse((posts('/reports/series')[0]![1] as { body: string }).body);
    expect(body).toMatchObject({
      type: 'hardware_lifecycle', schedule: 'monthly', targetMode: 'all', orgIds: [],
      recipientRule: { primaryContact: true, roles: [] },
      config: { replaceAgeYears: 4 },
    });
    expect(body).not.toHaveProperty('orgId');
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/reports#series/s-t'));
  });

  it('staying on one organization with none picked still sends nothing (W01 guard)', async () => {
    const user = userEvent.setup();
    render(<ReportTemplates />);
    await useTemplate('Hardware Lifecycle Report');
    expect(within(screen.getByTestId('template-covers-hardware_lifecycle')).getByTestId('template-covers-org-hint')).toBeInTheDocument();
    await user.click(screen.getByTestId('lifecycle-create-report'));
    expect(posts('/reports')).toHaveLength(0);
    expect(posts('/reports/series')).toHaveLength(0);
  });

  it('a one-time posture template leaves the series schedule empty and refuses to create until one is picked', async () => {
    const user = userEvent.setup();
    render(<ReportTemplates />);
    await useTemplate('Security & Compliance Posture (Insurance)');
    const covers = screen.getByTestId('template-covers-security_compliance_posture');
    await user.click(within(covers).getByTestId('covers-mode-series'));
    const select = within(covers).getByTestId('series-schedule-select');
    expect(select).toHaveValue('');
    expect(within(covers).getByTestId('series-schedule-hint')).toHaveTextContent("can't be one-time");
    await user.click(screen.getByTestId('posture-options-submit'));
    expect(posts('/reports/series')).toHaveLength(0);
    expect(within(covers).getByTestId('series-schedule-required')).toBeInTheDocument();
    await user.selectOptions(select, 'weekly');
    expect(within(covers).queryByTestId('series-schedule-required')).toBeNull();
    await user.click(screen.getByTestId('posture-options-submit'));
    await waitFor(() => expect(posts('/reports/series')).toHaveLength(1));
    expect(JSON.parse((posts('/reports/series')[0]![1] as { body: string }).body).schedule).toBe('weekly');
  });
});
