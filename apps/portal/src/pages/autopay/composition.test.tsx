// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import AutopaySetupPage from '../../components/portal/AutopaySetupPage';
import PaymentMethodsPage from '../../components/portal/PaymentMethodsPage';
import { buildPortalNavItems } from '../../lib/navItems';
import { apiGet } from '../../lib/api';
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

it.each([{live:true,statusCode:200},{live:false,statusCode:404}])('disabled-partner page and nav honor endpoint access (live=$live)',async({live,statusCode})=>{
  // Astro templates use source contracts in this suite; React behavior is rendered below.
  const page=readFileSync(resolve(__dirname,'../payment-methods/index.astro'),'utf8');
  const layout=readFileSync(resolve(__dirname,'../../layouts/PortalLayout.astro'),'utf8');
  expect(page).toContain("apiGet('/portal/payment-methods'");
  expect(page).toContain("if (response.statusCode === 404) return new Response('Not Found', { status: 404 })");
  expect(layout).toContain('buildPortalNavItems(branding, paymentMethods.statusCode === 200)');
  expect(buildPortalNavItems({},statusCode===200).some(item=>item.href==='/payment-methods')).toBe(live);
  vi.mocked(apiGet).mockResolvedValueOnce(live
    ?{statusCode,data:{stopOnly:true,partnerName:'Example MSP',enrollment:{status:'active'},method:null}}
    :{statusCode,error:'Automatic payments are not enabled'});
  render(<PaymentMethodsPage/>);
  await screen.findByTestId(live?'autopay-payment-methods':'autopay-payment-methods-error');
  expect(Boolean(screen.queryByTestId('autopay-portal-stop'))).toBe(live);
  expect(screen.queryByTestId('autopay-update-method')).toBeNull();
});
