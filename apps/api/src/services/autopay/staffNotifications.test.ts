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
      [{ billingEmail: 'billing@example.test' }]);
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
