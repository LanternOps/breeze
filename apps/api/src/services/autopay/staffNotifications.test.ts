import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ rows: [] as unknown[][], inserts: vi.fn(), send: vi.fn(), claimed: new Set<string>(),predicates:[] as unknown[] }));
vi.mock('../../db', () => ({
  runOutsideDbContext: (f: () => unknown) => f(),
  withSystemDbAccessContext: (f: () => unknown) => f(),
  db: {
    execute: async (query:any) => { const {PgDialect}=await import('drizzle-orm/pg-core');const key=String(new PgDialect().sqlToQuery(query).params[0]);if(h.claimed.has(key))return [];h.claimed.add(key);return [{id:'enrollment'}]; },
    select: () => { const q: any = {}; for (const k of ['from','innerJoin','where','limit']) q[k] = (value:unknown) => {if(k==='where')h.predicates.push(value);return q;};
      q.then = (f: (x: unknown) => unknown) => Promise.resolve(h.rows.shift() ?? []).then(f); return q; },
    insert: () => ({ values: (v: unknown) => { h.inserts(v); return { onConflictDoNothing: async () => [] }; } }),
  },
}));
vi.mock('../email', () => ({ getEmailService: () => ({ sendEmail: h.send }) }));
import { notifyAutopayStaff } from './staffNotifications';
describe('autopay staff notifications', () => {
  beforeEach(() => { vi.clearAllMocks(); h.rows.length = 0; h.claimed.clear(); h.send.mockResolvedValue({}); });
  it('uses billing type and stable event payload, sends only to partner billing address', async () => {
    h.rows.push([{ userId: '11111111-1111-4111-8111-111111111111' }], [{ userId: '11111111-1111-4111-8111-111111111111' }, { userId: '22222222-2222-4222-8222-222222222222' }],
      [{ name: 'Example client' }], [{ billingEmail: 'billing@example.test' }], [{ name: 'Example client' }]);
    await notifyAutopayStaff({ orgId: '33333333-3333-4333-8333-333333333333', partnerId: '44444444-4444-4444-8444-444444444444', event: 'autopay.enrolled',
      dedupeKey: 'enrollment:1:activated', message: 'Example client enabled automatic payments.' });
    expect(h.inserts).toHaveBeenCalledWith([
      expect.objectContaining({ userId: '11111111-1111-4111-8111-111111111111', type: 'billing', metadata: { event: 'autopay.enrolled' } }),
      expect.objectContaining({ userId: '22222222-2222-4222-8222-222222222222', type: 'billing', metadata: { event: 'autopay.enrolled' } }),
    ]);
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'billing@example.test', purpose: 'staff.autopay' }));
  });
  it('does not fall back to the customer contact when the MSP billing address is blank', async () => {
    h.rows.push([], [], [{ billingEmail: null }]);
    await notifyAutopayStaff({ orgId: '33333333-3333-4333-8333-333333333333', partnerId: '44444444-4444-4444-8444-444444444444', event: 'autopay.stopped',
      dedupeKey: 'enrollment:1:stopped', message: 'Automatic payments stopped.' });
    expect(h.send).not.toHaveBeenCalled();
  });
  it('reports staff delivery failure to its post-commit caller', async () => {
    h.rows.push([], [], [{ billingEmail: 'billing@example.test' }]);
    h.send.mockRejectedValue(new Error('provider unavailable'));
    await expect(notifyAutopayStaff({ orgId: '33333333-3333-4333-8333-333333333333', partnerId: '44444444-4444-4444-8444-444444444444',
      event: 'autopay.needs_attention', dedupeKey: 'method:1:unusable', message: 'Update method.' }))
      .rejects.toThrow('provider unavailable');
  });
});

import { db } from '../../db';
import { enqueueAutopayStaffNotifications, sendAutopayStaffEmail } from './staffNotifications';
it('separates transactional in-app inserts from staff email', async () => {
  vi.clearAllMocks(); h.rows.length = 0; h.claimed.clear(); h.send.mockResolvedValue({});
  const input = { orgId: '33333333-3333-4333-8333-333333333333', partnerId: '44444444-4444-4444-8444-444444444444', event: 'autopay.stopped' as const, dedupeKey: 'stopped:1', message: 'Stopped.' };
  h.rows.push([{ userId: '11111111-1111-4111-8111-111111111111' }], []);
  await enqueueAutopayStaffNotifications(db, input);
  expect(h.inserts).toHaveBeenCalledTimes(1);
  expect(h.send).not.toHaveBeenCalled();
  h.rows.push([{ billingEmail: 'billing@example.test' }]);
  await sendAutopayStaffEmail(input);
  expect(h.inserts).toHaveBeenCalledTimes(1);
  expect(h.send).toHaveBeenCalledTimes(1);
});
it('claims one durable staff email for repeated dedupe keys',async()=>{
 vi.clearAllMocks();h.rows.length=0;h.claimed.clear();
 const input={orgId:'33333333-3333-4333-8333-333333333333',partnerId:'44444444-4444-4444-8444-444444444444',event:'autopay.needs_attention' as const,dedupeKey:'same-failure',message:'Update method.'};
 for(let i=0;i<2;i++){
  h.rows.push([],[],[{billingEmail:'billing@example.test'}]);
  await notifyAutopayStaff(input);
 }
 expect(h.send).toHaveBeenCalledTimes(1);
});

it('selects only active org staff and this partner with all or selected-org access',async()=>{
 h.rows=[];h.predicates=[];
 await enqueueAutopayStaffNotifications(db,{orgId:'org',partnerId:'partner',event:'autopay.enrolled',dedupeKey:'test',message:'Enabled'});
 const {PgDialect}=await import('drizzle-orm/pg-core');const queries=h.predicates.map(p=>new PgDialect().sqlToQuery(p as import('drizzle-orm').SQL));
 expect(queries[0]!.params).toEqual(['org','active']);expect(queries[0]!.sql).toContain('"organization_users"."org_id"');
 expect(queries[1]!.params).toEqual(['partner','active','all','selected','org']);
 expect(queries[1]!.sql).toContain('"partner_users"."partner_id"');expect(queries[1]!.sql).toContain('ANY(');
});

it('links payment attention to its invoice independently of enrollment rollout',async()=>{
  const invoiceId='55555555-5555-4555-8555-555555555555';
  h.rows.push([{userId:'11111111-1111-4111-8111-111111111111'}],[],[{name:'Example client'}],[{billingEmail:null}]);
  await notifyAutopayStaff({orgId:'33333333-3333-4333-8333-333333333333',partnerId:'44444444-4444-4444-8444-444444444444',
    invoiceId,event:'payment.unapplied',dedupeKey:'attempt:unapplied',message:'Review captured money.'});
  expect(h.inserts).toHaveBeenCalledWith([expect.objectContaining({link:`/billing/invoices/${invoiceId}`,priority:'high',
    dedupeKey:'attempt:unapplied:11111111-1111-4111-8111-111111111111'})]);
});

it('keeps partner-only configuration attention out of customer notifications',async()=>{
 vi.clearAllMocks();h.rows.length=0;
 h.rows.push([{userId:'partner-staff'}]);
 await enqueueAutopayStaffNotifications(db,{orgId:'org',partnerId:'partner',partnerOnly:true,
  event:'autopay.needs_attention',dedupeKey:'autopay:charging_disabled:partner:2026-10-03',message:'Automatic payments are disabled.'});
 expect(h.rows).toEqual([]);
 expect(h.inserts).toHaveBeenCalledWith([expect.objectContaining({userId:'partner-staff',
  dedupeKey:'autopay:charging_disabled:partner:2026-10-03:partner-staff'})]);
});

describe('staff notices name the client organization (D-13)', () => {
  const orgId = '33333333-3333-4333-8333-333333333333';
  const partnerId = '44444444-4444-4444-8444-444444444444';
  beforeEach(() => { vi.clearAllMocks(); h.rows.length = 0; h.claimed.clear(); h.predicates.length = 0; h.send.mockResolvedValue({}); });
  it('puts the organization name in the in-app title and body', async () => {
    h.rows.push([{ userId: 'staff' }], [], [{ name: 'Acme Dental' }]);
    await enqueueAutopayStaffNotifications(db, { orgId, partnerId, event: 'autopay.enrolled', dedupeKey: 'enrolled:1', message: 'Automatic payments enabled.' });
    expect(h.inserts).toHaveBeenCalledWith([expect.objectContaining({
      title: 'Automatic payments enabled: Acme Dental', message: 'Acme Dental: Automatic payments enabled.' })]);
  });
  it('does not repeat a name the caller message already carries', async () => {
    h.rows.push([{ userId: 'staff' }], [], [{ name: 'Acme Dental' }]);
    await enqueueAutopayStaffNotifications(db, { orgId, partnerId, event: 'autopay.stopped', dedupeKey: 'stopped:1', message: 'Automatic payments stopped for Acme Dental.' });
    expect(h.inserts).toHaveBeenCalledWith([expect.objectContaining({
      title: 'Automatic payments stopped: Acme Dental', message: 'Automatic payments stopped for Acme Dental.' })]);
  });
  it('keeps the title within the 255-character column for a long organization name', async () => {
    const long = 'A'.repeat(255);
    h.rows.push([{ userId: 'staff' }], [], [{ name: long }]);
    await enqueueAutopayStaffNotifications(db, { orgId, partnerId, event: 'autopay.needs_attention', dedupeKey: 'long:1', message: 'Update method.' });
    const [[rows]] = h.inserts.mock.calls as [[{ title: string }[]]];
    expect(Array.from(rows[0]!.title).length).toBeLessThanOrEqual(255);
    expect(rows[0]!.title.startsWith('Payment needs attention: AAA')).toBe(true);
  });
  it('reads the organization only through its id', async () => {
    h.rows.push([{ userId: 'staff' }], [], [{ name: 'Acme Dental' }]);
    await enqueueAutopayStaffNotifications(db, { orgId, partnerId, event: 'autopay.enrolled', dedupeKey: 'enrolled:2', message: 'Enabled.' });
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const query = new PgDialect().sqlToQuery(h.predicates[2] as import('drizzle-orm').SQL);
    expect(query.sql).toContain('"organizations"."id"'); expect(query.params).toEqual([orgId]);
  });
  it('names the organization in the staff email subject and body', async () => {
    h.rows.push([{ billingEmail: 'billing@example.test' }], [{ name: 'Acme <Dental>' }]);
    await sendAutopayStaffEmail({ orgId, partnerId, event: 'autopay.needs_attention', dedupeKey: 'attention:1', message: 'Update the payment method.' });
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({
      subject: 'Payment needs attention: Acme <Dental>',
      html: expect.stringContaining('Acme &lt;Dental&gt;'),
      text: expect.stringContaining('Client: Acme <Dental>'),
    }));
    expect(h.send.mock.calls[0]![0].text).toContain('Update the payment method.');
  });
  it('still sends a useful subject when the organization cannot be read', async () => {
    h.rows.push([{ billingEmail: 'billing@example.test' }], []);
    await sendAutopayStaffEmail({ orgId, partnerId, event: 'autopay.enrolled', dedupeKey: 'enrolled:3', message: 'Automatic payments enabled.' });
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Automatic payments enabled' }));
  });
});

describe('staff notices name the invoice by number, never by id (P-17)', () => {
  const orgId = '33333333-3333-4333-8333-333333333333';
  const partnerId = '44444444-4444-4444-8444-444444444444';
  const invoiceId = '55555555-5555-4555-8555-555555555555';
  beforeEach(() => { vi.clearAllMocks(); h.rows.length = 0; h.claimed.clear(); h.predicates.length = 0; h.send.mockResolvedValue({}); });
  it('adds the invoice number to the staff email and keeps the id out of it', async () => {
    h.rows.push([{ billingEmail: 'billing@example.test' }], [{ name: 'Acme Dental' }], [{ invoiceNumber: 'INV-2026-0008' }]);
    await sendAutopayStaffEmail({ orgId, partnerId, invoiceId, event: 'payment.failed_final', dedupeKey: 'final:1',
      message: 'Automatic payment has stopped retrying. The client can pay the invoice directly.' });
    const [[mail]] = h.send.mock.calls as [[{ text: string; html: string }]];
    expect(mail.text).toContain('Invoice: INV-2026-0008'); expect(mail.html).toContain('INV-2026-0008');
    expect(mail.text).not.toContain(invoiceId); expect(mail.html).not.toContain(invoiceId);
  });
  it('adds the invoice number to the in-app message', async () => {
    h.rows.push([{ userId: 'staff' }], [], [{ name: 'Acme Dental' }], [{ invoiceNumber: 'INV-2026-0008' }]);
    await enqueueAutopayStaffNotifications(db, { orgId, partnerId, invoiceId, event: 'payment.unapplied', dedupeKey: 'unapplied:1',
      message: 'Captured money could not be applied; review the Stripe payment.' });
    expect(h.inserts).toHaveBeenCalledWith([expect.objectContaining({
      message: 'Acme Dental: Captured money could not be applied; review the Stripe payment. Invoice INV-2026-0008.',
      link: `/billing/invoices/${invoiceId}` })]);
  });
  it('titles a method update as such, not as automatic payments enabled (P-17)', async () => {
    h.rows.push([{ userId: 'staff' }], [], [{ name: 'Acme Dental' }]);
    await enqueueAutopayStaffNotifications(db, { orgId, partnerId, event: 'autopay.method_updated', dedupeKey: 'updated:1', message: 'Payment method updated.' });
    expect(h.inserts).toHaveBeenCalledWith([expect.objectContaining({ title: 'Payment method updated: Acme Dental',
      metadata: { event: 'autopay.method_updated' } })]);
  });
});
