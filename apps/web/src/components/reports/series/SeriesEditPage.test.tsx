import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({
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
const showToast = vi.fn();
vi.mock('../../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));
const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...a: unknown[]) => navigateTo(...a) }));

import SeriesEditPage from './SeriesEditPage';
import { useOrgStore } from '../../../stores/orgStore';

const DETAIL = {
  series: {
    id: 's-1', name: 'Monthly health', type: 'device_inventory', format: 'pdf', schedule: 'monthly',
    config: { schedule: { time: '07:30', day: 'monday', date: '1' } }, targetMode: 'all',
    recipientRule: { primaryContact: true, roles: [] }, internalCc: [], revision: 3, enabled: true,
    ownerUserId: 'u-1', createdAt: '', updatedAt: '',
  },
  targets: [],
  orgs: [],
};
const res = (payload: unknown, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(payload) });
const callsTo = (url: string, method: string) =>
  fetchWithAuth.mock.calls.filter(([u, i]) => u === url && (i as { method?: string } | undefined)?.method === method);

function routes(overrides: Record<string, () => Promise<unknown>> = {}) {
  fetchWithAuth.mockImplementation((url: string, init?: { method?: string }) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    if (overrides[key]) return overrides[key]!();
    if (key === 'GET /reports/series/s-1') return res(DETAIL);
    if (key === 'PATCH /reports/series/s-1') return res(DETAIL);
    if (key === 'PUT /reports/series/s-1/targets') return res(DETAIL);
    if (url === '/reports/series/recipients/preview') return res({ totalCustomerRecipients: 0, orgCount: 0, orgsWithoutCustomerRecipient: [] });
    return res({ data: { rows: [] } });
  });
}

describe('SeriesEditPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({
      currentOrgId: null,
      organizations: [
        { id: 'o-1', partnerId: 'p-1', name: 'Acme', status: 'active', createdAt: '' },
        { id: 'o-2', partnerId: 'p-1', name: 'Birch', status: 'active', createdAt: '' },
      ],
    });
  });

  it('saves shared fields with PATCH only when the targets did not change', async () => {
    routes();
    const user = userEvent.setup();
    render(<SeriesEditPage seriesId="s-1" />);
    expect(await screen.findByDisplayValue('Monthly health')).toBeInTheDocument();
    await user.click(screen.getByTestId('report-builder-submit'));
    await waitFor(() => expect(callsTo('/reports/series/s-1', 'PATCH')).toHaveLength(1));
    const body = JSON.parse((callsTo('/reports/series/s-1', 'PATCH')[0]![1] as { body: string }).body);
    expect(body).toMatchObject({ name: 'Monthly health', format: 'pdf', schedule: 'monthly' });
    expect(body).not.toHaveProperty('type');
    expect(body.config.schedule).toMatchObject({ time: '07:30' });
    expect(callsTo('/reports/series/s-1/targets', 'PUT')).toHaveLength(0);
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/reports#series/s-1'));
  });

  it('replaces the targets after the PATCH when an org is excluded', async () => {
    routes();
    const user = userEvent.setup();
    render(<SeriesEditPage seriesId="s-1" />);
    await user.click(await screen.findByTestId('series-target-org-o-2'));
    await user.click(screen.getByTestId('report-builder-submit'));
    await waitFor(() => expect(callsTo('/reports/series/s-1/targets', 'PUT')).toHaveLength(1));
    expect(JSON.parse((callsTo('/reports/series/s-1/targets', 'PUT')[0]![1] as { body: string }).body))
      .toEqual({ targetMode: 'all', orgIds: ['o-2'] });
  });

  // Review Focus 4.
  it('stays on the page when the targets update fails after the settings saved', async () => {
    routes({ 'PUT /reports/series/s-1/targets': () => res({ error: 'boom' }, 500) });
    const user = userEvent.setup();
    render(<SeriesEditPage seriesId="s-1" />);
    await user.click(await screen.findByTestId('series-target-org-o-2'));
    await user.click(screen.getByTestId('report-builder-submit'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(navigateTo).not.toHaveBeenCalled();
    expect(screen.getByTestId('report-builder-submit')).not.toBeDisabled();
  });

  it('shows not-found for a deleted series', async () => {
    routes({ 'GET /reports/series/s-1': () => res({ error: 'series_not_found' }, 404) });
    render(<SeriesEditPage seriesId="s-1" />);
    expect(await screen.findByTestId('series-edit-not-found')).toBeInTheDocument();
  });
});
