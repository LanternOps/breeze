// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, cleanup, waitFor } from '@testing-library/react';
import type { PublicInvoiceDetail } from '@/lib/api';

vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import { PublicInvoiceView } from './PublicInvoiceView';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function detail(overrides: Partial<PublicInvoiceDetail> = {}): PublicInvoiceDetail {
  return {
    invoice: {
      id: 'inv-1', invoiceNumber: 'INV-2026-0001', status: 'sent', currencyCode: 'USD',
      issueDate: '2026-08-01', dueDate: '2026-08-31', total: '100.00', amountPaid: '0.00',
      balance: '100.00', depositDue: null, subtotal: '100.00', taxTotal: '0.00', taxRate: null,
    },
    lines: [],
    chargeNow: { amount: '100.00', isDeposit: false },
    payable: true,
    branding: { partnerName: 'Lantern MSP', contactEmail: null, logoUrl: null, primaryColor: null, theme: 'classic', pageSize: 'letter' },
    ...overrides,
  } as PublicInvoiceDetail;
}


it('loads the server bank offer and starts setup only after consent',async()=>{
 const {portalApi,apiPost}=await import('@/lib/api');
 const offer={available:true,principal:'100.00',fee:'0.00',currency:'USD',consentText:'Authorize bank payment.',disclosureHash:'a'.repeat(64),methodStatus:null};
 vi.spyOn(portalApi,'getPublicInvoice').mockResolvedValue({data:{data:detail({bankAutopay:offer})}});
 const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({data:{url:'https://checkout.stripe.com/c/setup/example'}}),{status:200,headers:{'Content-Type':'application/json'}}));
 render(<PublicInvoiceView token="token-1"/>);
 const button=await screen.findByTestId('autopay-bank-pay');expect((button as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByTestId('autopay-bank-consent'));fireEvent.click(button);
 await waitFor(()=>expect(fetch).toHaveBeenCalled());
 const payment=fetch.mock.calls.find(([url])=>String(url).endsWith('/invoices/public/token-1/pay'));
 expect(payment).toBeDefined();expect(JSON.parse(payment![1]!.body as string)).toMatchObject({phase:'setup',consentAccepted:true});
});
