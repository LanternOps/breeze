import {beforeEach,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({rows:[] as unknown[],latest:vi.fn(),archived:vi.fn(),decrypt:vi.fn(),construct:vi.fn()}));
vi.mock('../db',()=>({db:{select:()=>({from:()=>({where:()=>({limit:async()=>h.rows})})})}}));
vi.mock('./partnerStripe',()=>({PartnerStripeError:class extends Error {constructor(message:string,readonly code:string){super(message);}}}));
vi.mock('./secretCrypto',()=>({decryptSecret:h.decrypt}));
vi.mock('./stripeCredentialArchive',()=>({findLatestArchivedCredentialForAccount:h.latest,getSupersededStripeCredential:h.archived}));
vi.mock('stripe',()=>({default:class { constructor(key:string){h.construct(key);} }}));
import {getPartnerStripeClient} from './partnerStripeClient';
beforeEach(()=>{vi.clearAllMocks();h.rows=[];h.decrypt.mockReturnValue('synthetic_live');});
it('preserves candidate, stored and explicit archive overloads',async()=>{
  await getPartnerStripeClient('p',{candidateApiKey:'synthetic_candidate'});
  expect(h.construct).toHaveBeenCalledWith('synthetic_candidate');
  h.rows=[{status:'connected',apiKey:'cipher',stripeAccountId:'acct_live',defaultCurrency:'USD'}];
  expect(await getPartnerStripeClient('p')).toMatchObject({stripeAccountId:'acct_live',defaultCurrency:'USD'});
  h.archived.mockResolvedValue({stripe:{},partnerId:'p',stripeAccountId:'acct_old'});
  expect(await getPartnerStripeClient('p',{archivedCredentialId:'old',reason:'autopay_org_merge_detach'}))
    .toMatchObject({stripeAccountId:'acct_old'});
  expect(h.archived).toHaveBeenCalledWith('old',{reason:'autopay_org_merge_detach',invoiceStripePaymentId:undefined});
});
it('uses the original account and checks both archive identities',async()=>{
  h.rows=[{status:'connected',apiKey:'cipher',stripeAccountId:'acct_new',defaultCurrency:'USD'}];
  h.latest.mockResolvedValue({id:'old'});
  h.archived.mockResolvedValue({stripe:{},partnerId:'p',stripeAccountId:'acct_old'});
  const source={reconciliationAccountId:'acct_old',reason:'autopay_outcome' as const};
  expect(await getPartnerStripeClient('p',source)).toMatchObject({stripeAccountId:'acct_old'});
  expect(h.construct).not.toHaveBeenCalled();
  for(const mismatch of [{partnerId:'other',stripeAccountId:'acct_old'},{partnerId:'p',stripeAccountId:'acct_wrong'}]){
    h.archived.mockResolvedValue({stripe:{},...mismatch});
    await expect(getPartnerStripeClient('p',source)).rejects.toThrow('Stripe account mismatch');
  }
});
it('honors a pinned archive even with a connected same-account live key',async()=>{
  h.rows=[{status:'connected',apiKey:'cipher',stripeAccountId:'acct_old'}];
  h.archived.mockResolvedValue({stripe:{},partnerId:'p',stripeAccountId:'acct_old'});
  await getPartnerStripeClient('p',{reconciliationAccountId:'acct_old',archivedCredentialId:'pinned',
    invoiceStripePaymentId:'mapping',reason:'payment_intent_settlement'});
  expect(h.latest).not.toHaveBeenCalled();expect(h.construct).not.toHaveBeenCalled();
  expect(h.archived).toHaveBeenCalledWith('pinned',{reason:'payment_intent_settlement',invoiceStripePaymentId:'mapping'});
});

it('rejects explicit archives from another partner', async () => {
  h.archived.mockResolvedValue({ stripe: {}, partnerId: 'other', stripeAccountId: 'acct_old' });
  await expect(getPartnerStripeClient('p', { archivedCredentialId: 'old' }))
    .rejects.toThrow('Archived credential belongs to another partner');
  expect(h.construct).not.toHaveBeenCalled();
});
it('uses a connected matching live account for unpinned reconciliation', async () => {
  h.rows = [{ status: 'connected', apiKey: 'cipher', stripeAccountId: 'acct_live', defaultCurrency: 'USD' }];
  await expect(getPartnerStripeClient('p', { reconciliationAccountId: 'acct_live', reason: 'autopay_recovery' }))
    .resolves.toMatchObject({ stripeAccountId: 'acct_live', defaultCurrency: 'USD' });
  expect(h.construct).toHaveBeenCalledWith('synthetic_live');
  expect(h.latest).not.toHaveBeenCalled();
  expect(h.archived).not.toHaveBeenCalled();
});
it('permits historical reconciliation after disconnect but refuses new live authority', async () => {
  h.rows = [{ status: 'disconnected', apiKey: null, stripeAccountId: 'acct_old' }];
  h.latest.mockResolvedValue({ id: 'old' });
  h.archived.mockResolvedValue({ stripe: {}, partnerId: 'p', stripeAccountId: 'acct_old' });
  await expect(getPartnerStripeClient('p')).rejects.toMatchObject({ code: 'NO_STRIPE_KEY' });
  await expect(getPartnerStripeClient('p', { reconciliationAccountId: 'acct_old', reason: 'financial_event_poll' }))
    .resolves.toMatchObject({ stripeAccountId: 'acct_old' });
  expect(h.latest).toHaveBeenCalledWith('p', 'acct_old');
  expect(h.archived).toHaveBeenCalledWith('old', { reason: 'financial_event_poll', invoiceStripePaymentId: undefined });
});
it('fails closed without an original-account archive', async () => {
  h.rows = [{ status: 'connected', apiKey: 'cipher', stripeAccountId: 'acct_new' }];
  h.latest.mockResolvedValue(null);
  await expect(getPartnerStripeClient('p', { reconciliationAccountId: 'acct_old', reason: 'client_confirmation' }))
    .rejects.toMatchObject({ code: 'NO_STRIPE_KEY' });
  expect(h.construct).not.toHaveBeenCalled();
});
it.each([null, 'throws'])('preserves unreadable stored-key rejection: %s', async result => {
  h.rows = [{ status: 'connected', apiKey: 'cipher', stripeAccountId: 'acct_live' }];
  h.decrypt.mockImplementation(() => { if (result === 'throws') throw new Error('synthetic decrypt failure'); return result; });
  await expect(getPartnerStripeClient('p')).rejects.toMatchObject({ code: 'STRIPE_KEY_UNREADABLE' });
  expect(h.construct).not.toHaveBeenCalled();
});
