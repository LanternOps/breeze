import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '../../lib/i18n';
import CatalogDefaultsCard from './CatalogDefaultsCard';

const fetchMock = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...args: unknown[]) => fetchMock(...args) }));

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30,
      defaultMarkupPercent: '12.50', autoTaxHardware: true, catalogAiStyle: 'Concise',
    }),
  });
});

function renderCard() {
  return render(<I18nextProvider i18n={i18n}><CatalogDefaultsCard /></I18nextProvider>);
}

it('loads and renders the three catalog defaults', async () => {
  renderCard();
  expect(await screen.findByTestId('catalog-defaults-markup')).toHaveValue(12.5);
  expect(screen.getByTestId('catalog-defaults-auto-tax-hardware')).toBeChecked();
});

it('PATCHes the three required base fields alongside the three catalog fields', async () => {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) }); // the PATCH response
  // save() reloads on success, so a third GET follows the PATCH.
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30,
      defaultMarkupPercent: '12.50', autoTaxHardware: true, catalogAiStyle: 'Concise',
    }),
  });
  renderCard();
  await screen.findByTestId('catalog-defaults-markup');
  await userEvent.click(screen.getByTestId('catalog-defaults-save'));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  const [, patchInit] = fetchMock.mock.calls[1];
  const body = JSON.parse((patchInit as RequestInit).body as string);
  expect(body).toMatchObject({
    currencyCode: 'USD', invoiceNumberPrefix: 'INV', invoiceTermsDays: 30,
    defaultMarkupPercent: 12.5, autoTaxHardware: true, catalogAiStyle: 'Concise',
  });
});
