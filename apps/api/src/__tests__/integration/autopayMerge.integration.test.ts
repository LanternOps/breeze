import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { createPartner, createOrganization, createUser } from './db-utils';
import { executeOrgMerge, previewOrgMerge, collectMergeBlockers, runPolicy, OrgMergeBlockedError, buildMergeBlockedMessage } from '../../services/orgMerge';
import { getOrgMergePolicies } from '../../services/orgMergeRegistry';
import { RESERVING_COLLECTION_ATTEMPT_STATES } from '@breeze/shared';

const stripe = vi.hoisted(() => ({ getClient: vi.fn(), retrieve: vi.fn(), detach: vi.fn() }));
vi.mock('../../services/partnerStripe', () => ({ getPartnerStripeClient: stripe.getClient }));
import { drainAutopayMethodDetaches } from '../../services/autopay/merge';

const run = it.runIf(Boolean(process.env.DATABASE_URL));
async function seed() {
  return withSystemDbAccessContext(async () => {
    const p=await createPartner();
    const l=await createOrganization({partnerId:p.id});
    const s=await createOrganization({partnerId:p.id});
    const connection=randomUUID(), enrollment=randomUUID(), method=randomUUID(), invoice=randomUUID(), schedule=randomUUID(), attempt=randomUUID();
    await db.execute(sql`INSERT INTO stripe_connect_accounts(id,partner_id,stripe_account_id,api_key,key_last4) VALUES (${connection}::uuid,${p.id}::uuid,${'acct_'+connection},'enc:test-key','test')`);
    await db.execute(sql`INSERT INTO org_autopay_enrollments(id,org_id,partner_id,stripe_connection_id,stripe_account_id,status,effective_from) VALUES (${enrollment}::uuid,${l.id}::uuid,${p.id}::uuid,${connection}::uuid,${'acct_'+connection},'active',now())`);
    await db.execute(sql`INSERT INTO org_payment_methods(id,org_id,enrollment_id,stripe_payment_method_id,type,status,is_autopay_method) VALUES (${method}::uuid,${l.id}::uuid,${enrollment}::uuid,${'pm_'+method},'card','active',true)`);
    await db.execute(sql`INSERT INTO invoices(id,org_id,partner_id,currency_code) VALUES (${invoice}::uuid,${l.id}::uuid,${p.id}::uuid,'USD')`);
    await db.execute(sql`INSERT INTO invoice_autopay_schedules(id,org_id,invoice_id,enrollment_id,enrollment_generation,eligible,terms_snapshot,state,collect_on) VALUES (${schedule}::uuid,${l.id}::uuid,${invoice}::uuid,${enrollment}::uuid,1,true,'{"last4":"4242"}','scheduled',CURRENT_DATE)`);
    await db.execute(sql`INSERT INTO invoice_collection_attempts(id,org_id,invoice_id,schedule_id,attempt_no,payment_method_id,idempotency_key,principal_amount,currency,initiated_by,state) VALUES (${attempt}::uuid,${l.id}::uuid,${invoice}::uuid,${schedule}::uuid,1,${method}::uuid,${randomUUID()},10,'USD','scheduler','failed')`);
    await db.execute(sql`INSERT INTO billing_notice_outbox(org_id,invoice_id,enrollment_id,kind,seq,dedupe_key,to_email,rendered) VALUES (${l.id}::uuid,${invoice}::uuid,${enrollment}::uuid,'invoice_autopay',1,${randomUUID()},'client@example.com','{}'),(${l.id}::uuid,NULL,${enrollment}::uuid,'autopay_request',1,${randomUUID()},'client@example.com','{}')`);
    await db.execute(sql`INSERT INTO billing_link_tokens(org_id,invoice_id,enrollment_id,purpose,token_hash,token_ct,expires_at) VALUES (${l.id}::uuid,${invoice}::uuid,${enrollment}::uuid,'skip_invoice',${randomUUID()},'ct',now()+interval '1 day')`);
    await db.execute(sql`INSERT INTO org_autopay_consents(org_id,enrollment_id,generation,payment_method_id,consent_text_version,consent_text_hash,fee_terms,schedule_terms,contact_email,source) VALUES (${l.id}::uuid,${enrollment}::uuid,1,${method}::uuid,'v1','hash','{}','{}','client@example.com','setup_page')`);
    await db.execute(sql`INSERT INTO billing_payment_settings(org_id,autopay_offset_days) VALUES (${l.id}::uuid,15)`);
    const actor = await createUser({ partnerId: p.id });
    return {p,l,s,enrollment,method,invoice,schedule,attempt,actor};
  });
}
describe('autopay merge authority boundary',()=>{
  it('explains payment blockers without mislabeling them as PAM evidence',()=>{
    const payment={table:'invoice_collection_attempts',loserRows:2};
    expect(buildMergeBlockedMessage([payment])).toContain('2 payment collection attempt(s) are still in flight');
    expect(buildMergeBlockedMessage([payment])).not.toContain('PAM');
    expect(buildMergeBlockedMessage([payment,{table:'pam_actuations',loserRows:1}])).toContain('Audit-admin retention is not a merge mechanism');
  });
  for (const state of RESERVING_COLLECTION_ATTEMPT_STATES) run(`blocks an attempt in ${state} before moving any authority`,async()=>{
    const f=await seed();
    await withSystemDbAccessContext(()=>db.execute(sql`UPDATE invoice_collection_attempts SET state=${state}::collection_attempt_state WHERE id=${f.attempt}::uuid`));
    const blockers=await withSystemDbAccessContext(()=>collectMergeBlockers(f.l.id));
    expect(blockers).toContainEqual({table:'invoice_collection_attempts',loserRows:1});
    await expect(withSystemDbAccessContext(()=>runPolicy('invoice_collection_attempts',getOrgMergePolicies().get('invoice_collection_attempts')!,f.l.id,f.s.id,'resolve'))).rejects.toBeInstanceOf(OrgMergeBlockedError);
    const rows=await withSystemDbAccessContext(()=>db.execute(sql`SELECT org_id,status FROM org_autopay_enrollments WHERE id=${f.enrollment}::uuid`));
    expect(rows[0]).toMatchObject({org_id:f.l.id,status:'active'});
  });
  run('moves invoice history while cancelling and leaving loser authority, even when survivor has no settings',async()=>{
    const f=await seed();
    await withSystemDbAccessContext(async()=>{
      expect(await collectMergeBlockers(f.l.id)).toEqual([]);
      await db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      const tables=['billing_payment_settings','org_autopay_enrollments','org_payment_methods','invoice_autopay_schedules','invoice_collection_attempts','billing_notice_outbox','billing_link_tokens'];
      const policies=getOrgMergePolicies();
      for(const table of tables) await runPolicy(table,policies.get(table)!,f.l.id,f.s.id,'resolve');
      await db.execute(sql`UPDATE invoices SET org_id=${f.s.id}::uuid WHERE id=${f.invoice}::uuid`);
      for(const table of tables) await runPolicy(table,policies.get(table)!,f.l.id,f.s.id,'move');
      await db.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`);
      const [enrollment]=await db.execute(sql`SELECT org_id,status,cancel_source,cancel_reason FROM org_autopay_enrollments WHERE id=${f.enrollment}::uuid`);
      expect(enrollment).toMatchObject({org_id:f.l.id,status:'cancelled',cancel_source:'system',cancel_reason:'org_merged'});
      const [consent]=await db.execute(sql`SELECT org_id,enrollment_id,payment_method_id FROM org_autopay_consents WHERE enrollment_id=${f.enrollment}::uuid`);
      expect(consent).toMatchObject({org_id:f.l.id,enrollment_id:f.enrollment,payment_method_id:f.method});
      const [method]=await db.execute(sql`SELECT org_id,status,is_autopay_method FROM org_payment_methods WHERE id=${f.method}::uuid`);
      expect(method).toMatchObject({org_id:f.l.id,status:'removed',is_autopay_method:false});
      const [schedule]=await db.execute(sql`SELECT org_id,state,state_reason,enrollment_id,terms_snapshot FROM invoice_autopay_schedules WHERE id=${f.schedule}::uuid`);
      expect(schedule).toMatchObject({org_id:f.s.id,state:'cancelled',state_reason:'org_merged',enrollment_id:null,terms_snapshot:{last4:'4242'}});
      const [attempt]=await db.execute(sql`SELECT org_id,state,payment_method_id FROM invoice_collection_attempts WHERE id=${f.attempt}::uuid`);
      expect(attempt).toMatchObject({org_id:f.s.id,state:'failed',payment_method_id:null});
      const notices=await db.execute(sql`SELECT org_id,invoice_id,enrollment_id,status FROM billing_notice_outbox ORDER BY invoice_id NULLS LAST`);
      expect(notices).toEqual(expect.arrayContaining([expect.objectContaining({org_id:f.s.id,invoice_id:f.invoice,enrollment_id:null,status:'cancelled'}),expect.objectContaining({org_id:f.l.id,invoice_id:null,enrollment_id:f.enrollment,status:'cancelled'})]));
      const [token]=await db.execute(sql`SELECT org_id,enrollment_id,revoked_at FROM billing_link_tokens WHERE invoice_id=${f.invoice}::uuid`);
      expect(token).toMatchObject({org_id:f.s.id,enrollment_id:null}); expect(token!.revoked_at).not.toBeNull();
      expect(await db.execute(sql`SELECT id FROM billing_payment_settings WHERE org_id IN (${f.l.id}::uuid,${f.s.id}::uuid)`)).toHaveLength(0);
    });
  });
});

describe('durable detach retry scheduling', () => {
  run('reaches later rows and terminally fails the eighth detach attempt', async () => {
    const f = await seed();
    stripe.getClient.mockResolvedValue({stripeAccountId:'acct_original',stripe:{paymentMethods:{retrieve:stripe.retrieve,detach:stripe.detach}}});
    stripe.retrieve.mockResolvedValue({customer:'cus_original'});
    stripe.detach.mockImplementation(async (id: string) => {
      if (id !== 'pm_success') throw new Error('persistent provider failure');
      return {customer:null};
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await withSystemDbAccessContext(async () => {
        await db.execute(sql`UPDATE org_autopay_enrollments SET stripe_account_id='acct_original',stripe_customer_id='cus_original' WHERE id=${f.enrollment}::uuid`);
        await db.execute(sql`INSERT INTO org_payment_methods(org_id,enrollment_id,stripe_payment_method_id,type,status,unusable_reason,removed_at)
          SELECT ${f.l.id}::uuid,${f.enrollment}::uuid,'pm_fail_' || n,'card','removed','org_merged',now()-interval '1 day'
          FROM generate_series(1,100) n`);
        await db.execute(sql`INSERT INTO org_payment_methods(org_id,enrollment_id,stripe_payment_method_id,type,status,unusable_reason,removed_at)
          VALUES (${f.l.id}::uuid,${f.enrollment}::uuid,'pm_success','card','removed','org_merged',now())`);
      });
      await drainAutopayMethodDetaches();
      expect(stripe.detach).toHaveBeenCalledTimes(100);
      await drainAutopayMethodDetaches();
      expect(stripe.detach).toHaveBeenCalledWith('pm_success');
      expect(stripe.detach).toHaveBeenCalledTimes(101);
      await withSystemDbAccessContext(async () => {
        const [pending] = await db.execute(sql`SELECT count(*)::int AS n FROM org_payment_methods
          WHERE org_id=${f.l.id}::uuid AND unusable_reason='org_merged' AND detach_attempts=1
          AND detach_next_attempt_at BETWEEN now()+interval '45 seconds' AND now()+interval '65 seconds'`);
        expect(pending!.n).toBe(100);
        await db.execute(sql`UPDATE org_payment_methods SET detach_attempts=7,detach_next_attempt_at=now()-interval '1 second'
          WHERE org_id=${f.l.id}::uuid AND stripe_payment_method_id='pm_fail_1'`);
      });
      await drainAutopayMethodDetaches();
      await withSystemDbAccessContext(async () => {
        const [retry] = await db.execute(sql`SELECT detach_attempts,
          detach_failed_at IS NOT NULL AS terminal
          FROM org_payment_methods WHERE org_id=${f.l.id}::uuid AND stripe_payment_method_id='pm_fail_1'`);
        expect(retry).toMatchObject({detach_attempts:8,terminal:true});
      });
      const calls = stripe.detach.mock.calls.length;
      await drainAutopayMethodDetaches();
      expect(stripe.detach).toHaveBeenCalledTimes(calls);
    } finally { errors.mockRestore(); }
  });
});


describe('C2 real merge engine with autopay authority', () => {
  beforeEach(() => { vi.stubEnv('ORG_MERGE_FENCE_DRAIN_MS', '0'); stripe.getClient.mockClear(); });
  afterEach(() => vi.unstubAllEnvs());
  run('preview reports terminal attempts movable and settings dropped; real walk preserves authority/history separation', async () => {
    const f = await seed();
    await withSystemDbAccessContext(() => db.execute(sql`UPDATE invoice_collection_attempts SET state='succeeded' WHERE id=${f.attempt}::uuid`));
    // A setup/stop link can retain an optional invoice association; its
    // enrollment authority must remain on the loser when that invoice moves.
    await withSystemDbAccessContext(() => db.execute(sql`INSERT INTO billing_link_tokens(org_id,invoice_id,enrollment_id,purpose,token_hash,token_ct,expires_at) VALUES (${f.l.id}::uuid,${f.invoice}::uuid,${f.enrollment}::uuid,'stop_autopay',${randomUUID()},'ct',now()+interval '1 day')`));
    const preview = await previewOrgMerge(f.l.id, f.s.id, f.p.id);
    expect(preview.verdict).toBe('ok');
    expect(preview.tables).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: 'invoice_collection_attempts', loserRows: 1, wouldDrop: 0 }),
      expect.objectContaining({ table: 'billing_payment_settings', loserRows: 1, wouldDrop: 1 }),
    ]));
    await executeOrgMerge({ loserOrgId: f.l.id, survivorOrgId: f.s.id, partnerId: f.p.id, performedBy: f.actor.id });
    expect(stripe.getClient).not.toHaveBeenCalled();
    await withSystemDbAccessContext(async () => {
      const [authority] = await db.execute(sql`SELECT org_id,status,cancel_source FROM org_autopay_enrollments WHERE id=${f.enrollment}::uuid`);
      expect(authority).toMatchObject({ org_id: f.l.id, status: 'cancelled', cancel_source: 'system' });
      const [method] = await db.execute(sql`SELECT org_id,status,unusable_reason FROM org_payment_methods WHERE id=${f.method}::uuid`);
      expect(method).toMatchObject({ org_id: f.l.id, status: 'removed', unusable_reason: 'org_merged' });
      const [authorityLink] = await db.execute(sql`SELECT org_id,invoice_id,enrollment_id,revoked_at FROM billing_link_tokens WHERE purpose='stop_autopay' AND enrollment_id=${f.enrollment}::uuid`);
      expect(authorityLink).toMatchObject({ org_id: f.l.id, invoice_id: null, enrollment_id: f.enrollment });
      expect(authorityLink!.revoked_at).not.toBeNull();
      const [history] = await db.execute(sql`SELECT org_id,state,payment_method_id FROM invoice_collection_attempts WHERE id=${f.attempt}::uuid`);
      expect(history).toMatchObject({ org_id: f.s.id, state: 'succeeded', payment_method_id: null });
    });
  });
  for (const state of RESERVING_COLLECTION_ATTEMPT_STATES) run(`real walk refuses ${state} before changing rows`, async () => {
    const f = await seed();
    await withSystemDbAccessContext(() => db.execute(sql`UPDATE invoice_collection_attempts SET state=${state}::collection_attempt_state WHERE id=${f.attempt}::uuid`));
    const snapshot = () => withSystemDbAccessContext(async () => {
      const names = ['organizations','org_autopay_enrollments','org_payment_methods','invoices','invoice_autopay_schedules','invoice_collection_attempts','billing_notice_outbox','billing_link_tokens','billing_payment_settings','org_autopay_consents'];
      const rows = [];
      for (const name of names) rows.push(await db.execute(sql`SELECT to_jsonb(t) AS row FROM ${sql.identifier(name)} t ORDER BY id`));
      return rows;
    });
    const before = await snapshot();
    await expect(executeOrgMerge({ loserOrgId: f.l.id, survivorOrgId: f.s.id, partnerId: f.p.id, performedBy: f.actor.id })).rejects.toBeInstanceOf(OrgMergeBlockedError);
    expect(await snapshot()).toEqual(before);
    expect(stripe.getClient).not.toHaveBeenCalled();
  });
});
