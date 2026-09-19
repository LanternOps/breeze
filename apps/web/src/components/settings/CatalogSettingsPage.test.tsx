import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '../../lib/i18n';

vi.mock('../../lib/authScope', () => ({
  getJwtClaims: () => ({ scope: 'partner', orgId: null, partnerId: 'partner-1' }),
}));
vi.mock('./CatalogItemsTab', () => ({ default: () => <div data-testid="stub-catalog-items-tab" /> }));
const fetchMock = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...args: unknown[]) => fetchMock(...args) }));

beforeEachSetup();
function beforeEachSetup() {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30, defaultMarkupPercent: null, autoTaxHardware: true, catalogAiStyle: null }),
  });
}

import CatalogSettingsPage from './CatalogSettingsPage';

function renderPage() {
  return render(<I18nextProvider i18n={i18n}><CatalogSettingsPage /></I18nextProvider>);
}

it('mounts CatalogDefaultsCard above the item list for a partner-scoped user (M4)', async () => {
  renderPage();
  expect(await screen.findByTestId('catalog-defaults-card')).toBeInTheDocument();
  expect(screen.getByTestId('catalog-settings-page')).toBeInTheDocument();
});

it('links to Distributors under Integrations', () => {
  renderPage();
  expect(screen.getByTestId('catalog-distributors-link')).toHaveAttribute('href', '/integrations#distributors');
});
