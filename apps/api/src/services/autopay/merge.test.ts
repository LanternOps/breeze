import { beforeEach, describe, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({ execute:vi.fn(), getClient:vi.fn(), retrieve:vi.fn(), detach:vi.fn() }));
vi.mock('../../db',()=>({db:{execute:m.execute},withSystemDbAccessContext:async(fn:()=>Promise<unknown>)=>fn(),runOutsideDbContext:async(fn:()=>Promise<unknown>)=>fn()}));
vi.mock('../partnerStripe',()=>({getPartnerStripeClient:m.getClient}));
import { drainAutopayMethodDetaches } from './merge';

beforeEach(()=>{
  vi.clearAllMocks();
  m.execute.mockResolvedValueOnce([{id:'00000000-0000-4000-8000-000000000001',partner_id:'00000000-0000-4000-8000-000000000002',stripe_account_id:'acct_original',stripe_customer_id:'cus_original',stripe_payment_method_id:'pm_original'}]).mockResolvedValue([]);
  m.getClient.mockResolvedValue({stripeAccountId:'acct_original',stripe:{paymentMethods:{retrieve:m.retrieve,detach:m.detach}}});
  m.retrieve.mockResolvedValue({id:'pm_original',customer:'cus_original'});
  m.detach.mockResolvedValue({id:'pm_original',customer:null});
});
describe('durable removed-method detach queue',()=>{
  it('detaches only the original account and customer, then acknowledges the row',async()=>{
    await drainAutopayMethodDetaches();
    expect(m.detach).toHaveBeenCalledWith('pm_original'); expect(m.execute).toHaveBeenCalledTimes(2);
  });
  it('leaves a failed detach queued for retry',async()=>{
    m.detach.mockRejectedValueOnce(new Error('network error'));
    await drainAutopayMethodDetaches(); expect(m.execute).toHaveBeenCalledTimes(2);
  });
  it('does not detach a method attached to another customer',async()=>{
    m.retrieve.mockResolvedValueOnce({customer:'cus_other'});
    await drainAutopayMethodDetaches(); expect(m.detach).not.toHaveBeenCalled(); expect(m.execute).toHaveBeenCalledTimes(2);
  });
  it('does not reuse a replacement Stripe account',async()=>{
    m.getClient.mockResolvedValueOnce({stripeAccountId:'acct_replacement',stripe:{paymentMethods:{retrieve:m.retrieve,detach:m.detach}}});
    await drainAutopayMethodDetaches(); expect(m.retrieve).not.toHaveBeenCalled(); expect(m.detach).not.toHaveBeenCalled();
  });
  it('acknowledges a method already detached without issuing a second detach',async()=>{
    m.retrieve.mockResolvedValueOnce({customer:null});
    await drainAutopayMethodDetaches(); expect(m.detach).not.toHaveBeenCalled(); expect(m.execute).toHaveBeenCalledTimes(2);
  });
});
