import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '../../lib/i18n';
import BillingConnectionsTab from './BillingConnectionsTab';

it('links to Integrations → Accounting for Stripe/QuickBooks — never a second editor', async () => {
  render(<I18nextProvider i18n={i18n}><BillingConnectionsTab /></I18nextProvider>);
  const link = await screen.findByTestId('billing-connections-accounting-link');
  expect(link).toHaveAttribute('href', '/integrations#accounting');
});

it('links to Catalog and Distributors', async () => {
  render(<I18nextProvider i18n={i18n}><BillingConnectionsTab /></I18nextProvider>);
  expect(screen.getByTestId('billing-connections-catalog-link')).toHaveAttribute('href', '/settings/catalog');
  expect(screen.getByTestId('billing-connections-distributors-link')).toHaveAttribute('href', '/integrations#distributors');
});
