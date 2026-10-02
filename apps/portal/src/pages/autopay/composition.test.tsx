// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import AutopaySetupPage from '../../components/portal/AutopaySetupPage';
import PaymentMethodsPage from '../../components/portal/PaymentMethodsPage';
vi.mock('@/lib/api', () => ({ apiGet: vi.fn(async () => ({ data: { partnerName: 'Example MSP', enrollment: null, method: null } })), apiPost: vi.fn() }));
afterEach(cleanup);
it.each(['./[token].astro', './return.astro', './[token]/stop.astro'])('%s mounts the public module inside the public shell', path => {
  const source = readFileSync(resolve(__dirname, path), 'utf8');
  expect(source).toContain('PublicDocumentLayout'); expect(source).toContain('<AutopaySetupPage'); expect(source).toContain('client:load');
  render(<AutopaySetupPage mode="return" />); expect(screen.getByTestId('autopay-setup-page')).toBeTruthy();
});
it('mounts payment methods in the authenticated shell', async () => {
  const source = readFileSync(resolve(__dirname, '../payment-methods/index.astro'), 'utf8');
  expect(source).toContain('<PortalLayout'); expect(source).toContain('<PaymentMethodsPage');
  render(<PaymentMethodsPage />); expect(await screen.findByTestId('autopay-payment-methods')).toBeTruthy();
});
