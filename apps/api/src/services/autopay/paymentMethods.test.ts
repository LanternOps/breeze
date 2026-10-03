import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Tx } from './types';
const m = vi.hoisted(() => ({ rows: [] as unknown[][], execute: vi.fn(), detach: vi.fn(), retrieve: vi.fn(), client: vi.fn(), archive: vi.fn(), held: false, calls: [] as Array<{ op: string; value: unknown }> }));
vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  for (const op of ['insert','values','onConflictDoNothing','innerJoin','select', 'from', 'where', 'limit', 'for', 'update', 'set', 'returning']) {
    chain[op] = (value: unknown) => { m.calls.push({ op, value }); return chain; };
  }
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(m.rows.shift() ?? []).then(resolve);
  return { runAfterDbContextExit:vi.fn(), db: { ...chain, execute: m.execute }, runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn(), hasDbAccessContext: () => m.held };
});
vi.mock('../partnerStripe', () => ({ getPartnerStripeClient: m.client, PartnerStripeError: class extends Error {} }));
vi.mock('../stripeCredentialArchive', () => ({ findLatestArchivedCredentialForAccount: m.archive }));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));
import { db } from '../../db';
import { getAutopayMethod, markPaymentMethodUnusable, detachPaymentMethodPostCommit } from './paymentMethods';
import { drainAutopayMethodDetaches } from './merge';
const query = (sql: SQL) => new PgDialect().sqlToQuery(sql);
const row = { id: 'method', org_id: 'org', partner_id: 'partner', stripe_payment_method_id: 'pm_one', stripe_account_id: 'acct_one', stripe_customer_id: 'cus_one', detach_attempts: 0 };
beforeEach(() => {
  vi.resetAllMocks(); m.rows = []; m.calls = []; m.held = false;
  m.execute.mockResolvedValueOnce([row]).mockResolvedValue([]);
  m.client.mockResolvedValue({ stripeAccountId: 'acct_one', stripe: { paymentMethods: { retrieve: m.retrieve, detach: m.detach } } });
  m.retrieve.mockResolvedValue({ id: 'pm_one', customer: 'cus_one' });
  m.archive.mockResolvedValue(null);
});
describe('payment method usability', () => {
  it('accepts database and raw transaction executors', () => {
    expectTypeOf<Parameters<typeof getAutopayMethod>[0]>().toEqualTypeOf<Tx>();
    expectTypeOf<Parameters<typeof markPaymentMethodUnusable>[0]>().toEqualTypeOf<Tx>();
  });
  it('scopes selection to the org and usable designated methods', async () => {
    m.rows.push([{ id: 'method' }]);
    expect(await getAutopayMethod(db, 'org')).toEqual({ id: 'method' });
    const q = query(m.calls.find(c => c.op === 'where')!.value as SQL);
    expect(q.params).toEqual(['org', true, 'active', 'pending_verification']);
    expect(q.sql).toContain('"org_id"');
    expect(await getAutopayMethod(db, 'other-org')).toBeNull();
  });
  it.each([undefined, { status: 'removed' }])('does not revive a missing/removed method: %j', async method => {
    m.rows.push(method ? [method] : []);
    await markPaymentMethodUnusable(db, 'method', 'mandate_revoked');
    expect(m.calls.some(c => c.op === 'update')).toBe(false);
  });
  it.each([false, true])('locks enrollment before update and flags only a changed autopay method (%s)', async designated => {
    m.rows.push([{ enrollmentId: 'enrollment', status: 'active' }], [{ id: 'enrollment' }], [{ isAutopayMethod: designated }], []);
    await markPaymentMethodUnusable(db, 'method', 'mandate_revoked');
    const lockIndex = m.calls.findIndex(c => c.op === 'for' && c.value === 'update');
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(lockIndex).toBeLessThan(m.calls.findIndex(c => c.op === 'update'));
    expect(m.calls.filter(c => c.op === 'set').map(c => c.value)).toEqual([
      { status: 'unusable', unusableReason: 'mandate_revoked' }, ...(designated ? [{ needsAttentionReason: 'method_unusable' }] : []),
    ]);
    const predicates = m.calls.filter(c => c.op === 'where').map(c => query(c.value as SQL).params);
    expect(predicates[2]).toEqual(['method', 'active', 'pending_verification']);
    if (designated) expect(predicates[3]).toEqual(['enrollment', 'active', 'paused']);
  });
  it('does not flag enrollment when the conditional update loses a race', async () => {
    m.rows.push([{ enrollmentId: 'enrollment', status: 'active' }], [{ id: 'enrollment' }], []);
    await markPaymentMethodUnusable(db, 'method', 'reason');
    expect(m.calls.filter(c => c.op === 'update')).toHaveLength(1);
  });
  it('does nothing when the enrollment is invisible', async () => {
    m.rows.push([{ enrollmentId: 'enrollment', status: 'active' }], []);
    await markPaymentMethodUnusable(db, 'method', 'reason');
    expect(m.calls.some(c => c.op === 'update')).toBe(false);
  });
});
describe('durable post-commit detach', () => {
  it('checks committed removed state, tenant, backoff and terminal state before Stripe', async () => {
    m.execute.mockReset().mockResolvedValue([]);
    await detachPaymentMethodPostCommit('partner', 'method');
    expect(m.client).not.toHaveBeenCalled();
    const q = query(m.execute.mock.calls[0]![0]);
    expect(q.sql).toContain("m.status='removed'");
    expect(q.sql).toContain('m.detach_failed_at IS NULL');
    expect(q.sql).toContain('m.detach_next_attempt_at<=now()');
    expect(q.sql).toContain("NOT LIKE '%:detached'");
    expect(q.sql).toContain('e.partner_id='); expect(q.sql).toContain('m.id=');
    expect(q.params).toEqual(['partner', 'method']);
  });
  it('rejects held contexts before opening another connection', async () => {
    m.held = true;
    await expect(detachPaymentMethodPostCommit('partner', 'method')).rejects.toThrow(/outside any DB access context/);
    expect(m.execute).not.toHaveBeenCalled(); expect(m.client).not.toHaveBeenCalled();
  });
  it('preserves W02 removal reasons when acknowledging and drains them through the existing queue', async () => {
    await drainAutopayMethodDetaches();
    const selection = query(m.execute.mock.calls[0]![0]).sql;
    expect(selection).toContain("COALESCE(m.unusable_reason,'') NOT LIKE '%:detached'");
    expect(selection).not.toContain("m.unusable_reason='org_merged'");
    expect(m.detach).toHaveBeenCalledWith('pm_one');
    expect(query(m.execute.mock.calls[1]![0]).sql).toContain("COALESCE(unusable_reason,'removed') || ':detached'");
  });
  it.each(['cus_other', { id: 'cus_other' }])('refuses another customer %j and records retry', async customer => {
    m.retrieve.mockResolvedValue({ id: 'pm_one', customer });
    await detachPaymentMethodPostCommit('partner', 'method');
    expect(m.detach).not.toHaveBeenCalled();
    expect(query(m.execute.mock.calls[1]![0]).sql).toContain('detach_attempts=detach_attempts+1');
  });
  it('never uses a replacement account without an original credential', async () => {
    m.client.mockResolvedValueOnce({ stripeAccountId: 'acct_other' });
    await detachPaymentMethodPostCommit('partner', 'method');
    expect(m.retrieve).not.toHaveBeenCalled(); expect(m.detach).not.toHaveBeenCalled();
    expect(m.execute).toHaveBeenCalledTimes(2);
  });
  it('recovers the original account from the credential archive', async () => {
    m.client.mockResolvedValueOnce({ stripeAccountId: 'acct_other' }); m.archive.mockResolvedValue({ id: 'archive' });
    await detachPaymentMethodPostCommit('partner', 'method');
    expect(m.client).toHaveBeenLastCalledWith('partner', { archivedCredentialId: 'archive', reason: 'autopay_org_merge_detach' });
    expect(m.detach).toHaveBeenCalledWith('pm_one');
  });
  it.each(['detached', 'missing'])('acknowledges an already %s method', async state => {
    if (state === 'detached') m.retrieve.mockResolvedValue({ id: 'pm_one', customer: null });
    else m.retrieve.mockRejectedValue(Object.assign(new Error('missing'), { code: 'resource_missing' }));
    await detachPaymentMethodPostCommit('partner', 'method');
    expect(m.detach).not.toHaveBeenCalled();
    expect(query(m.execute.mock.calls[1]![0]).sql).toContain(':detached');
  });
  it('retains exponential backoff and terminal failure without restoring local authority', async () => {
    m.detach.mockRejectedValue(new Error('network error'));
    await detachPaymentMethodPostCommit('partner', 'method');
    const q = query(m.execute.mock.calls[1]![0]).sql;
    expect(q).toContain('detach_attempts+1>=8'); expect(q).toContain('power(2,LEAST(detach_attempts,9))');
    expect(q).not.toContain("status='active'");
  });
});
it('queues rejected captures with immutable provider identity after commit',async()=>{
 const {enqueueRejectedAutopayMethod}=await import('./paymentMethods');
 m.rows.push([],[{id:'rejected'}]);
 await enqueueRejectedAutopayMethod(db,{id:'attempt',orgId:'org',partnerId:'partner',enrollmentId:'enrollment',stripeAccountId:'acct_original',stripeCustomerId:'cus_original'},
  {id:'pm_rejected',type:'card',customer:'cus_original'} as any);
 expect(m.calls.filter(c=>c.op==='values').map(c=>c.value)).toContainEqual(expect.objectContaining({
  stripePaymentMethodId:'pm_rejected',status:'removed',isAutopayMethod:false,detachStripeAccountId:'acct_original',detachStripeCustomerId:'cus_original'}));
 expect(m.detach).not.toHaveBeenCalled();
});
it('never queues a current active method rejected by another capture',async()=>{
 const {enqueueRejectedAutopayMethod}=await import('./paymentMethods');
 m.rows.push([{id:'existing',status:'active'}]);
 await enqueueRejectedAutopayMethod(db,{id:'attempt',orgId:'org',partnerId:'partner',enrollmentId:'enrollment',stripeAccountId:'acct_original',stripeCustomerId:'cus_original'},
  {id:'pm_current',type:'card',customer:'cus_original'} as any);
 expect(m.calls.some(c=>c.op==='insert'||c.op==='update')).toBe(false);
});
it('queues a failed verification without changing its unusable status',async()=>{
 const {enqueueRejectedAutopayMethod}=await import('./paymentMethods');
 m.rows.push([{id:'existing',status:'unusable',enrollmentId:'enrollment'}],[{id:'existing'}]);
 await enqueueRejectedAutopayMethod(db,{id:'attempt',orgId:'org',partnerId:'partner',enrollmentId:'enrollment',stripeAccountId:'acct_original',stripeCustomerId:'cus_original'},
  {id:'pm_failed',type:'us_bank_account',customer:'cus_original'} as any);
 expect(m.calls.filter(c=>c.op==='set').map(c=>c.value)).toContainEqual(expect.objectContaining({
  isAutopayMethod:false,removedAt:expect.any(Date),detachStripeAccountId:'acct_original',detachStripeCustomerId:'cus_original'}));
 expect(m.calls.filter(c=>c.op==='set').map(c=>c.value)).not.toContainEqual(expect.objectContaining({status:'removed'}));
 await drainAutopayMethodDetaches();
 expect(query(m.execute.mock.calls[0]![0]).sql).toContain("m.status='unusable' AND m.removed_at IS NOT NULL AND m.detach_stripe_account_id IS NOT NULL");
});
