import '@/lib/i18n';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makePolicyView } from '../portalAccess/viewFixture';
import { usePartnerSettingsDraftStore } from './partnerSettingsDraftStore';
import PartnerCustomerPortalTab from './PartnerCustomerPortalTab';
import type { PortalAccessPolicyUnitValue } from './units/portalAccessPolicyUnit';

const fetchWithAuth = vi.fn();
vi.mock('@/stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a), handleSessionExpired: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;

function route(opts: { view?: ReturnType<typeof makePolicyView>; summary?: unknown; summaryStatus?: number }) {
  fetchWithAuth.mockImplementation(async (url: string) => {
    if (url.endsWith('/portal-access-policy')) return json(200, { data: opts.view ?? makePolicyView({ kind: 'partner' }) });
    if (url.endsWith('/portal-access-requests/summary')) {
      return json(opts.summaryStatus ?? 200, { data: opts.summary ?? { pendingTotal: 0, orgs: [] } });
    }
    return json(404, {});
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  usePartnerSettingsDraftStore.getState().reset();
  usePartnerSettingsDraftStore.getState().setPartner('p1');
});

describe('PartnerCustomerPortalTab', () => {
  it('selected-orgs partner user sees the form read-only', async () => {
    route({ view: makePolicyView({ kind: 'partner', canEdit: false }) });
    render(<PartnerCustomerPortalTab />);
    expect(await screen.findByTestId('portal-access-policy-read-only')).toBeTruthy();
    expect((await screen.findByTestId('portal-access-policy-password-allowed') as HTMLInputElement).disabled).toBe(true);
  });

  it('editing the form writes the change into the unit draft', async () => {
    route({ view: makePolicyView({ kind: 'partner', capabilities: { selfRegistration: true } }) });
    render(<PartnerCustomerPortalTab />);
    fireEvent.click(await screen.findByTestId('portal-access-policy-self-registration-approval'));
    const slice = usePartnerSettingsDraftStore.getState().slices.portalAccessPolicy;
    expect((slice.draft as PortalAccessPolicyUnitValue).draft).toEqual({ selfRegistrationMode: 'approval' });
  });

  it('summary lists orgs with pending counts and links', async () => {
    route({ summary: { pendingTotal: 4, orgs: [{ orgId: 'o1', orgName: 'Acme', pending: 3 }, { orgId: 'o2', orgName: 'Globex', pending: 1 }] } });
    render(<PartnerCustomerPortalTab />);
    const row = await screen.findByTestId('partner-portal-requests-org-o1');
    expect(row.textContent).toContain('Acme');
    expect(row.textContent).toContain('3');
    expect(row.querySelector('a')?.getAttribute('href')).toBe('/settings/organizations/o1#portal');
    expect(screen.getByTestId('partner-portal-requests-org-o2').querySelector('a')?.getAttribute('href')).toBe('/settings/organizations/o2#portal');
  });

  it('shows the empty state when nothing is pending', async () => {
    route({});
    render(<PartnerCustomerPortalTab />);
    expect(await screen.findByTestId('partner-portal-requests-empty')).toBeTruthy();
  });

  it('a malformed summary body (200, data is not a summary) shows the error, and Retry refetches and shows the list', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let summaryCalls = 0;
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url.endsWith('/portal-access-policy')) return json(200, { data: makePolicyView({ kind: 'partner' }) });
      if (url.endsWith('/portal-access-requests/summary')) {
        summaryCalls += 1;
        return summaryCalls === 1
          ? json(200, { data: [] })
          : json(200, { data: { pendingTotal: 2, orgs: [{ orgId: 'o1', orgName: 'Acme', pending: 2 }] } });
      }
      return json(404, {});
    });
    render(<PartnerCustomerPortalTab />);
    const err = await screen.findByTestId('partner-portal-requests-error');
    expect(screen.queryByTestId('partner-portal-requests-empty')).toBeNull();
    fireEvent.click(within(err).getByRole('button'));
    expect(await screen.findByTestId('partner-portal-requests-org-o1')).toBeTruthy();
    expect(screen.queryByTestId('partner-portal-requests-error')).toBeNull();
    expect(summaryCalls).toBe(2);
    warn.mockRestore();
  });

  it('shows a load error when the summary fails', async () => {
    route({ summaryStatus: 500 });
    render(<PartnerCustomerPortalTab />);
    await waitFor(() => expect(screen.getByTestId('partner-portal-requests-error')).toBeTruthy());
  });
});
