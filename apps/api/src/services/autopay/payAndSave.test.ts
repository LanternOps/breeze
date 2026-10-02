import {describe,expect,it,vi} from 'vitest';
import {payAndSaveSchema,cardSaveStripeFields} from './payAndSave';
describe('pay-and-save request',()=>{
 it('defaults to an ordinary payment and refuses implicit authorization',()=>{
  expect(payAndSaveSchema.parse({})).toEqual({saveForAutopay:false});
  expect(payAndSaveSchema.safeParse({saveForAutopay:true}).success).toBe(false);
  expect(payAndSaveSchema.safeParse({saveForAutopay:true,consentAccepted:false,disclosureHash:'a'.repeat(64)}).success).toBe(false);
 });
 it('adds only customer and off-session card authority',()=>{
  expect(cardSaveStripeFields(null)).toEqual({});
  expect(cardSaveStripeFields({id:'attempt',stripeCustomerId:'cus_one'})).toEqual({customer:'cus_one',
   payment_intent_data:{setup_future_usage:'off_session',metadata:{autopay_setup_attempt_id:'attempt'}}});
 });
});

const m = vi.hoisted(() => ({ rows: [] as unknown[][], client: vi.fn(), session: vi.fn(), intent: vi.fn(),
  method: vi.fn(), persist: vi.fn(), record: vi.fn(), held: false,predicates:[] as unknown[] }));
vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  for (const name of ['select', 'from', 'innerJoin', 'where', 'limit']) chain[name] = (value:unknown) => {if(name==='where')m.predicates.push(value);return chain;};
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(m.rows.shift() ?? []).then(resolve);
  return { db: chain, hasDbAccessContext: () => m.held, withSystemDbAccessContext: (fn: () => unknown) => fn(),
    runOutsideDbContext: (fn: () => unknown) => fn() };
});
vi.mock('../partnerStripe', () => ({ getPartnerStripeClient: m.client }));
vi.mock('../stripeReconcile', () => ({ recordStripePayment: m.record }));
vi.mock('./paymentMethods',()=>({enqueueRejectedAutopayMethod:vi.fn()}));
vi.mock('./setupSession', () => ({ prepareAutopayCapture: vi.fn() }));
vi.mock('./setupCompletion', () => ({ persistCapturedAutopayMethod: m.persist }));
import { beforeEach } from 'vitest';
import { finishCardPayAndSave } from './payAndSave';
import { HeldDbContextForStripeError, settleCheckoutSession } from '../stripeSettle';
const attempt = { id:'attempt',orgId:'org',stripeAccountId:'acct_one',stripeCustomerId:'cus_one',consentSnapshot:{invoiceId:'invoice',checkoutKey:'key',version:'v1',text:'Consent',hash:'hash',textHash:'textHash',partnerName:'MSP',scheduleText:'Schedule',feeText:'No fee',achMode:'card_only',scheduleTerms:{offsetDays:0,rule:'later',cap:{enabled:false}},feeTerms:{methodType:'card',cardFeeBps:0,achFeeAmount:'0.00',feeAttested:false,currency:'USD'},source:'pay_and_save',contactEmail:'billing@example.test',ip:null,userAgent:null} };
function queueBooked() {
  m.rows.push([{ mapping: { stripeAccountId: 'acct_one', invoicePaymentId: 'payment' }, invoice: { id: 'invoice', orgId: 'org' } }], [attempt]);
}
beforeEach(() => {
  vi.clearAllMocks(); m.rows.length = 0;m.predicates=[]; m.held = false;
  m.persist.mockReset();m.persist.mockResolvedValue({outcome:'activated',orgId:'org'});
  m.client.mockResolvedValue({ stripeAccountId: 'acct_one', stripe: { checkout: { sessions: { retrieve: m.session } },
    paymentIntents: { retrieve: m.intent }, paymentMethods: { retrieve: m.method } } });
  m.session.mockResolvedValue({ id: 'cs_one', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_one', amount_total: 10000, currency: 'usd' });
  m.intent.mockResolvedValue({ metadata: { autopay_setup_attempt_id: 'attempt' }, setup_future_usage: 'off_session',
    status: 'succeeded', customer: 'cus_one', payment_method: 'pm_one' });
  m.method.mockResolvedValue({ id: 'pm_one', type: 'card', customer: 'cus_one' });
  m.record.mockResolvedValue({ invoiceId: 'invoice' });
});
describe('booked card capture', () => {
  it('saves a booked, explicitly authorized card', async () => {
    queueBooked(); expect(await finishCardPayAndSave('partner', 'cs_one')).toEqual({outcome:'activated',orgId:'org'});
    expect(m.persist).toHaveBeenCalledWith('attempt', { id: 'pm_one', type: 'card', customer: 'cus_one' }, 'activated', null, null);
  });
  it('does not contact Stripe without a booked mapping', async () => {
    m.rows.push([]); expect(await finishCardPayAndSave('partner', 'cs_one')).toEqual({outcome:'not_saved'});
    expect(m.client).not.toHaveBeenCalled(); expect(m.persist).not.toHaveBeenCalled();
  });
  it.each(['invoice', 'off_session', 'succeeded', 'customer', 'card', 'account', 'attempt', 'paid'])('refuses a mismatched %s binding', async binding => {
    queueBooked();
    if (binding === 'invoice') m.rows[1] = [{ ...attempt, consentSnapshot: {...attempt.consentSnapshot,invoiceId:'another-invoice'} }];
    if (binding === 'attempt') m.rows[1] = [];
    if (binding === 'off_session') m.intent.mockResolvedValue({ ...await m.intent(), setup_future_usage: null });
    if (binding === 'succeeded') m.intent.mockResolvedValue({ ...await m.intent(), status: 'processing' });
    if (binding === 'customer') m.intent.mockResolvedValue({ ...await m.intent(), customer: 'cus_other' });
    if (binding === 'card') m.method.mockResolvedValue({ id: 'pm_one', type: 'us_bank_account' });
    if (binding === 'account') m.rows[0] = [{ mapping: { stripeAccountId: 'acct_other' }, invoice: { id: 'invoice' } }];
    if (binding === 'paid') m.session.mockResolvedValue({ ...await m.session(), payment_status: 'unpaid' });
    if (['customer', 'card', 'account'].includes(binding)) await expect(finishCardPayAndSave('partner', 'cs_one')).rejects.toThrow();
    else await finishCardPayAndSave('partner', 'cs_one');
    expect(m.persist).not.toHaveBeenCalled();
  });
  it('preserves the booked response, reports a failed save, and leaves capture unfinished', async () => {
    queueBooked(); const error = new Error('consent write failed'); m.persist.mockRejectedValue(error);
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(settleCheckoutSession('partner', 'cs_one')).resolves.toEqual({ settled: true, invoiceId: 'invoice' });
      expect(m.persist).toHaveBeenCalledTimes(1);
      expect(m.record.mock.invocationCallOrder[0]).toBeLessThan(m.persist.mock.invocationCallOrder[0]!);
      expect(report).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ partnerId: 'partner', sessionId: 'cs_one', err: error }));
    } finally { report.mockRestore(); }
  });
  it('rethrows held-context programming errors from saving after booking', async () => {
    queueBooked(); m.persist.mockRejectedValue(new HeldDbContextForStripeError('held context'));
    await expect(settleCheckoutSession('partner', 'cs_one')).rejects.toBeInstanceOf(HeldDbContextForStripeError);
  });
});
it('queues a paid capture rejected because no invoice payment was booked',async()=>{
 m.rows.push([{mapping:{stripeAccountId:'acct_one',invoicePaymentId:null},invoice:{id:'invoice',orgId:'org'}}],[attempt]);
 const {enqueueRejectedAutopayMethod}=await import('./paymentMethods');
 expect(await finishCardPayAndSave('partner','cs_one')).toEqual({outcome:'not_saved'});
 expect(enqueueRejectedAutopayMethod).toHaveBeenCalledWith(expect.anything(),attempt,expect.objectContaining({id:'pm_one'}));
 expect(m.persist).not.toHaveBeenCalled();
});

it('fences invoice mapping and capture predicates by partner, org and account',async()=>{
 queueBooked();await finishCardPayAndSave('partner','cs_one');
 const {PgDialect}=await import('drizzle-orm/pg-core');
 const queries=m.predicates.map(p=>new PgDialect().sqlToQuery(p as import('drizzle-orm').SQL));
 expect(queries[0]!.params).toContain('partner');expect(queries[0]!.sql).toContain('"invoices"."partner_id"');
 expect(queries[1]!.params).toEqual(expect.arrayContaining(['partner','org','acct_one','pay_and_save']));
 expect(queries[1]!.sql).toContain('"autopay_setup_attempts"."org_id"');
});
it('detaches a discovered capture even when mapping publication never committed',async()=>{
 m.rows.push([],[{...attempt,stripeAccountId:'acct_one'}]);
 const {enqueueRejectedAutopayMethod}=await import('./paymentMethods');
 expect(await finishCardPayAndSave('partner','cs_one')).toEqual({outcome:'not_saved'});
 expect(enqueueRejectedAutopayMethod).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({id:'attempt'}),expect.objectContaining({id:'pm_one'}));
});
it('queues a session-bound capture rejected by a foreign org mapping',async()=>{
 m.rows.push([{mapping:{stripeAccountId:'acct_one',invoicePaymentId:'payment'},invoice:{id:'invoice_other',orgId:'org_other'}}],[],[{...attempt,orgId:'org',stripeAccountId:'acct_one'}]);
 const {enqueueRejectedAutopayMethod}=await import('./paymentMethods');
 expect(await finishCardPayAndSave('partner','cs_one')).toEqual({outcome:'not_saved'});
 expect(enqueueRejectedAutopayMethod).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({id:'attempt',orgId:'org'}),expect.objectContaining({id:'pm_one'}));
 expect(m.persist).not.toHaveBeenCalled();
});
