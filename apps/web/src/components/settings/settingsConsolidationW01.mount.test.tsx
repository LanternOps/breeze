import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '../../lib/i18n';

// Each assertion below names one data-testid from a module this wave moved or
// newly mounted — the smoke test for "the page shell actually wires it up",
// per the "wave plans need an explicit mount task" lesson.

vi.mock('../../lib/authScope', () => ({
  getJwtClaims: () => ({ scope: 'partner', orgId: null, partnerId: 'partner-1' }),
  useJwtClaims: () => ({ status: 'resolved' as const, claims: { scope: 'partner', orgId: null, partnerId: 'partner-1' } }),
}));
vi.mock('../../lib/permissions', () => ({
  usePermissions: () => ({ can: () => true }),
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
// CatalogItemsTab is untouched by this wave and needs its own heavier data
// fetching/mocking (covered by its own test suites) — stub it here so this
// smoke test can focus on CatalogSettingsPage's own composition (the
// CatalogDefaultsCard mount + distributors link), the thing this wave changed.
vi.mock('./CatalogItemsTab', () => ({ default: () => <div data-testid="stub-catalog-items-tab" /> }));

const PARTNER_SHAPE = {
  id: 'partner-1', name: 'Acme MSP', slug: 'acme', type: 'partner', plan: 'pro',
  createdAt: '2026-02-09T00:00:00.000Z', serviceManagementMode: 'native',
  currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30,
  defaultMarkupPercent: null, autoTaxHardware: true, catalogAiStyle: null,
  settings: { timezone: 'UTC', dateFormat: 'MM/DD/YYYY', timeFormat: '12h', language: 'en', businessHours: { preset: 'business' }, contact: {}, address: {} },
};

const jsonResponse = (payload: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const fetchMock = vi.fn((path: string) => {
  if (path.startsWith('/orgs/partners/me')) return Promise.resolve(jsonResponse(PARTNER_SHAPE));
  return Promise.resolve(jsonResponse({ data: [] }));
});
vi.mock('../../stores/auth', () => ({
  registerOrgIdProvider: vi.fn(),
  fetchWithAuth: (...args: [string, ...unknown[]]) => fetchMock(...args),
}));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: Object.assign(
    ((selector?: (state: Record<string, unknown>) => unknown) => {
      const state = { currentPartnerId: 'partner-1', isLoading: false, setServiceManagementMode: vi.fn(), adoptPartnerId: vi.fn(), currentOrgId: null };
      return selector ? selector(state) : state;
    }) as unknown as (selector?: (state: unknown) => unknown) => unknown,
    { getState: () => ({ currentPartnerId: 'partner-1', currentOrgId: null }) },
  ),
}));

import TicketingHubPage from './TicketingHubPage';
import PartnerBillingSettingsPage from '../billing/PartnerBillingSettingsPage';
import CatalogSettingsPage from './CatalogSettingsPage';
import PartnerSettingsPage from './PartnerSettingsPage';

describe('W01 placement — every moved/mounted module renders from its new shell', () => {
  it('TicketingHubPage mounts the 7-tab TicketingSettingsTabs', async () => {
    render(<I18nextProvider i18n={i18n}><TicketingHubPage /></I18nextProvider>);
    expect(await screen.findByTestId('ticketing-settings-tabs')).toBeInTheDocument();
  });

  it('PartnerBillingSettingsPage mounts Defaults/Documents/Connections and the Connections tab reaches accounting/catalog/distributors links', async () => {
    render(<I18nextProvider i18n={i18n}><PartnerBillingSettingsPage /></I18nextProvider>);
    await userEvent.click(await screen.findByTestId('billing-settings-tab-connections'));
    expect(await screen.findByTestId('billing-connections-accounting-link')).toBeInTheDocument();
    expect(screen.getByTestId('billing-connections-catalog-link')).toBeInTheDocument();
    expect(screen.getByTestId('billing-connections-distributors-link')).toBeInTheDocument();
  });

  it('CatalogSettingsPage mounts CatalogDefaultsCard above the item list', async () => {
    render(<I18nextProvider i18n={i18n}><CatalogSettingsPage /></I18nextProvider>);
    expect(await screen.findByTestId('catalog-defaults-card')).toBeInTheDocument();
    expect(screen.getByTestId('catalog-distributors-link')).toBeInTheDocument();
  });

  it('PartnerSettingsPage: Ticketing tab is a link, Modules is its own tab', async () => {
    render(<I18nextProvider i18n={i18n}><PartnerSettingsPage /></I18nextProvider>);
    await userEvent.click(await screen.findByTestId('partner-settings-tab-ticketing'));
    expect(await screen.findByTestId('partner-settings-ticketing-link')).toHaveAttribute('href', '/settings/ticketing');
    await userEvent.click(screen.getByTestId('partner-settings-tab-modules'));
    expect(await screen.findByTestId('partner-modules-card')).toBeInTheDocument();
  });
});
