import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ rows: [] as unknown[][], updates: [] as unknown[], audit: vi.fn(), wheres: [] as unknown[], joins: [] as string[] }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const name of ['select', 'from', 'innerJoin', 'leftJoin', 'where', 'limit', 'orderBy', 'update']) chain[name] = vi.fn(() => chain);
  chain.where = (value: unknown) => { h.wheres.push(value); return chain; };
  for (const name of ['innerJoin', 'leftJoin']) chain[name] = () => { h.joins.push(name); return chain; };
  chain.set = (value: unknown) => { h.updates.push(value); return chain; };
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(h.rows.shift() ?? []).then(resolve);
  return { db: chain };
});
vi.mock('./auditEvents', () => ({ writeAuditEventAsync: h.audit, requestLikeFromSnapshot: () => ({}) }));
import { eraseExpiredStripeCredentials } from './stripeCredentialArchive';
const now = new Date('2026-10-01T00:00:00Z');
const expired = { id: 'credential', partnerId: 'partner', stripeAccountId: 'acct_original', generation: 1, eraseHardCapAt: new Date('2025-01-01T00:00:00Z') };
beforeEach(() => { vi.clearAllMocks(); h.rows.length = 0; h.updates.length = 0; h.wheres.length = 0; h.joins.length = 0; });
describe('credential retention for active collection', () => {
  it('an active attempt overrides even the historical 400-day erase cap', async () => {
    h.rows.push([expired], [{ id: 'active-attempt' }]);
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    expect(await eraseExpiredStripeCredentials(now)).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ skipped: 1 }));
    log.mockRestore();
    expect(h.updates).toHaveLength(0);
  });
  it('erases after the hard cap once no active attempt remains', async () => {
    h.rows.push([expired], [], []);
    expect(await eraseExpiredStripeCredentials(now)).toBe(1);
    expect(h.updates).toContainEqual({ apiKey: null, erasedAt: now, updatedAt: now });
  });
});
it.each(['reserved','requires_action','unapplied'])('retains %s history beyond the hard cap',async state=>{
  h.rows.push([expired],[{id:'attempt',state,paymentMethodId:state==='unapplied'?null:'method'}]);
  expect(await eraseExpiredStripeCredentials(now)).toBe(0);
  expect(h.updates).toHaveLength(0);
});

it('binds mapped history through its invoice and mapping, with optional method/enrollment joins', async () => {
  h.rows.push([expired], [{ id: 'attempt', state: 'unapplied', paymentMethodId: null }]);
  expect(await eraseExpiredStripeCredentials(now)).toBe(0);
  expect(h.joins).toEqual(['innerJoin', 'leftJoin', 'leftJoin', 'leftJoin']);
  const query = new PgDialect().sqlToQuery(h.wheres[1] as import('drizzle-orm').SQL);
  expect(query.params).toEqual(['partner', 'reserved', 'created', 'confirming', 'processing', 'requires_action', 'unapplied', 'acct_original', 'partner', 'acct_original']);
  expect(query.sql).toContain('"invoices"."partner_id"');
  expect(query.sql).toContain('("invoice_stripe_payments"."stripe_account_id" =');
  expect(query.sql).toContain('or ("invoice_collection_attempts"."invoice_stripe_payment_id" is null and');
});
