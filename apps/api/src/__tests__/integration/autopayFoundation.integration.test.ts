import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as autopaySchema from '../../db/schema/autopay';
import * as vocabulary from '@breeze/shared';
import { ensureAppRole } from '../../db/ensureAppRole';

import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { createPartner, createOrganization } from './db-utils';

const tables = ['billing_payment_settings', 'org_autopay_enrollments', 'org_autopay_consents', 'org_payment_methods', 'invoice_autopay_schedules', 'invoice_collection_attempts', 'billing_notice_outbox', 'billing_link_tokens'] as const;
const run = it.runIf(Boolean(process.env.DATABASE_URL));
const admin = postgres(process.env.DATABASE_URL ?? '', { max: 1 });
afterAll(async()=>{ await admin.end({timeout:5}); });

async function fixture() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const a = await createOrganization({ partnerId: partner.id });
    const b = await createOrganization({ partnerId: partner.id });
    const ctx: DbAccessContext = { scope: 'organization', orgId: a.id, currentPartnerId: partner.id, accessibleOrgIds: [a.id], accessiblePartnerIds: [], userId: null };
    const connection = randomUUID(), enrollment = randomUUID(), method = randomUUID(), invoice = randomUUID(), schedule = randomUUID();
    await db.execute(sql`INSERT INTO stripe_connect_accounts(id,partner_id,stripe_account_id,api_key,key_last4) VALUES (${connection}::uuid,${partner.id}::uuid,${'acct_'+connection},'enc:test-key','test')`);
    await db.execute(sql`INSERT INTO org_autopay_enrollments(id,org_id,partner_id,stripe_connection_id,stripe_account_id) VALUES (${enrollment}::uuid,${b.id}::uuid,${partner.id}::uuid,${connection}::uuid,${'acct_'+connection})`);
    await db.execute(sql`INSERT INTO org_payment_methods(id,org_id,enrollment_id,stripe_payment_method_id,type) VALUES (${method}::uuid,${b.id}::uuid,${enrollment}::uuid,${'pm_'+method},'card')`);
    await db.execute(sql`INSERT INTO invoices(id,partner_id,org_id,currency_code) VALUES (${invoice}::uuid,${partner.id}::uuid,${b.id}::uuid,'USD')`);
    await db.execute(sql`INSERT INTO invoice_autopay_schedules(id,org_id,invoice_id,enrollment_id,enrollment_generation,eligible,terms_snapshot) VALUES (${schedule}::uuid,${b.id}::uuid,${invoice}::uuid,${enrollment}::uuid,1,true,'{}')`);
    return { partner, a, b, ctx, connection, enrollment, method, invoice, schedule };
  });
}
async function state(work: () => Promise<unknown>) {
  try { await work(); return undefined; }
  catch (e) { return (e as { cause?: { code?: string }; code?: string }).cause?.code ?? (e as {code?: string}).code; }
}
describe('autopay foundation PostgreSQL contracts', () => {
  run('replays the five creating migrations without changing their schema', async()=>{
    for (const name of ['2026-12-03-110000-autopay-enums.sql','2026-12-03-110100-billing-payment-settings.sql','2026-12-03-110200-org-autopay-enrollments-methods-consents.sql','2026-12-03-110300-invoice-autopay-schedules-attempts.sql','2026-12-03-110400-billing-notice-outbox-link-tokens.sql']) {
      const body=readFileSync(join(__dirname,'../../../migrations',name),'utf8');
      for(let n=0;n<2;n++) await admin.begin(async tx=>{ await tx.unsafe(body); });
    }
  });
  run('matches every Drizzle column and unique constraint, and defers composite org foreign keys', async()=>{
    const definitions=[autopaySchema.billingPaymentSettings,autopaySchema.orgAutopayEnrollments,autopaySchema.orgAutopayConsents,autopaySchema.orgPaymentMethods,autopaySchema.invoiceAutopaySchedules,autopaySchema.invoiceCollectionAttempts,autopaySchema.billingNoticeOutbox,autopaySchema.billingLinkTokens];
    const normalized=(value:string)=>value.replaceAll('"','').replace(/\s/g,'').replace(/^char\(/,'character(');
    for(const table of definitions){
      const cfg=getTableConfig(table);
      const columns=await admin`SELECT attname AS name,attnotnull AS required,format_type(atttypid,atttypmod) AS type FROM pg_attribute WHERE attrelid=to_regclass(${cfg.name}) AND attnum>0 AND NOT attisdropped ORDER BY attname`;
      expect(columns.map(c=>[c.name,c.required,normalized(c.type)])).toEqual(cfg.columns.map(c=>[c.name,c.notNull,normalized(c.getSQLType())]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
      const uniques=await admin`SELECT conname FROM pg_constraint WHERE conrelid=to_regclass(${cfg.name}) AND contype='u' ORDER BY conname`;
      expect(uniques.map(u=>u.conname).sort()).toEqual(cfg.uniqueConstraints.map(u=>u.name).sort());
      const constraints=await admin`SELECT c.condeferrable,c.condeferred FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey) WHERE c.conrelid=to_regclass(${cfg.name}) AND c.contype='f' AND cardinality(c.conkey)>1 AND a.attname='org_id'`;
      const expectedCompositeOrgFks: Record<string, string[]> = {
        org_autopay_enrollments: ['org_autopay_enrollments_connection_partner_fk','org_autopay_enrollments_org_partner_fk'],
        org_payment_methods: ['org_payment_methods_enrollment_org_fk'],
        org_autopay_consents: ['org_autopay_consents_enrollment_org_fk','org_autopay_consents_method_org_fk'],
        invoice_autopay_schedules: ['invoice_autopay_schedules_invoice_org_fk','invoice_autopay_schedules_enrollment_org_fk','invoice_autopay_schedules_notice_org_fk'],
        invoice_collection_attempts: ['invoice_collection_attempts_invoice_org_fk','invoice_collection_attempts_schedule_org_fk','invoice_collection_attempts_method_org_fk','invoice_collection_attempts_mapping_org_fk'],
        billing_notice_outbox: ['billing_notice_outbox_invoice_org_fk','billing_notice_outbox_enrollment_org_fk'],
        billing_link_tokens: ['billing_link_tokens_invoice_org_fk','billing_link_tokens_enrollment_org_fk'],
      };
      const expected = expectedCompositeOrgFks[cfg.name];
      if (expected) {
        const names = await admin`SELECT conname FROM pg_constraint WHERE conrelid=to_regclass(${cfg.name}) AND contype='f' AND cardinality(conkey)>1 ORDER BY conname`;
        expect(names.map((constraint) => constraint.conname).sort()).toEqual(expected.sort());
        expect(constraints).toHaveLength(expected.filter((name) => name !== 'org_autopay_enrollments_connection_partner_fk').length);
      }
      for(const fk of constraints) expect(fk).toMatchObject({condeferrable:true,condeferred:false});
    }
  });
  run('initializes durable method detach retry fields', async () => {
    const f = await fixture();
    const [method] = await withSystemDbAccessContext(() => db.execute(sql`SELECT detach_attempts,
      detach_next_attempt_at <= now() AS due FROM org_payment_methods WHERE id=${f.method}::uuid`));
    expect(method).toMatchObject({detach_attempts:0,due:true});
  });
  run('keeps all nine PostgreSQL enum vocabularies identical to C3',async()=>{
    const pairs=[['autopay_enrollment_status',vocabulary.AUTOPAY_ENROLLMENT_STATUSES],['autopay_schedule_state',vocabulary.AUTOPAY_SCHEDULE_STATES],['collection_attempt_state',vocabulary.COLLECTION_ATTEMPT_STATES],['billing_notice_kind',vocabulary.BILLING_NOTICE_KINDS],['billing_notice_status',vocabulary.BILLING_NOTICE_STATUSES],['billing_link_purpose',vocabulary.BILLING_LINK_PURPOSES],['org_payment_method_status',vocabulary.ORG_PAYMENT_METHOD_STATUSES],['ach_mode',vocabulary.ACH_MODES],['autopay_offset_rule',vocabulary.AUTOPAY_OFFSET_RULES]] as const;
    for(const [name,values] of pairs){
      const rows=await admin`SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname=${name} ORDER BY e.enumsortorder`;
      expect(rows.map(r=>r.enumlabel)).toEqual([...values]);
    }
  });
  run('rejects incomplete enabled-cap tuples instead of accepting SQL UNKNOWN',async()=>{
    const f=await fixture();
    expect(await state(()=>withSystemDbAccessContext(()=>db.execute(sql`INSERT INTO billing_payment_settings(org_id,autopay_cap_enabled,autopay_cap_currency) VALUES (${f.a.id}::uuid,true,'USD')`)))).toBe('23514');
    expect(await state(()=>withSystemDbAccessContext(()=>db.execute(sql`INSERT INTO billing_payment_settings(org_id,autopay_cap_enabled,autopay_cap_amount) VALUES (${f.a.id}::uuid,true,50)`)))).toBe('23514');
  });
  run('does not grant org tokens cross-partner defaults or partner-scope writes',async()=>{
    const f=await fixture();
    const other=await withSystemDbAccessContext(()=>createPartner());
    await withSystemDbAccessContext(()=>db.execute(sql`INSERT INTO billing_payment_settings(partner_id) VALUES (${other.id}::uuid)`));
    const visible=await withDbAccessContext(f.ctx,()=>db.execute(sql`SELECT id FROM billing_payment_settings WHERE partner_id=${other.id}::uuid`));
    expect(visible).toHaveLength(0);
    expect(await state(()=>withDbAccessContext(f.ctx,()=>db.execute(sql`INSERT INTO billing_payment_settings(partner_id) VALUES (${f.partner.id}::uuid)`)))).toBe('42501');
  });
  run('startup privilege refresh preserves consent revocations',async()=>{
    const prior=process.env.BREEZE_APP_DB_PASSWORD;
    process.env.BREEZE_APP_DB_PASSWORD=decodeURIComponent(new URL(process.env.DATABASE_URL_APP!).password);
    try { expect(await ensureAppRole()).toBe(true); }
    finally { if(prior===undefined) delete process.env.BREEZE_APP_DB_PASSWORD; else process.env.BREEZE_APP_DB_PASSWORD=prior; }
    const rows=await admin`SELECT has_table_privilege('breeze_app','org_autopay_consents','UPDATE') AS u,has_table_privilege('breeze_app','org_autopay_consents','DELETE') AS d`;
    expect(rows[0]).toMatchObject({u:false,d:false});
  });

  run('has forced RLS for every table and an unprivileged application pool', async () => {
    const f = await fixture();
    await withDbAccessContext(f.ctx, async () => {
      const roles = await db.execute(sql`SELECT current_user AS who, rolbypassrls FROM pg_roles WHERE rolname=current_user`);
      expect(roles[0]).toMatchObject({ who: 'breeze_app', rolbypassrls: false });
      for (const name of tables) {
        const rows = await db.execute(sql`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=to_regclass(${name})`);
        expect(rows[0]).toMatchObject({relrowsecurity:true,relforcerowsecurity:true});
      }
    });
  });
  for (const table of tables) run(`rejects cross-org forged INSERT into ${table} with 42501`, async () => {
    const f = await fixture();
    const q = {
      billing_payment_settings: sql`INSERT INTO billing_payment_settings(org_id) VALUES (${f.b.id}::uuid)`,
      org_autopay_enrollments: sql`INSERT INTO org_autopay_enrollments(org_id,partner_id,stripe_connection_id,stripe_account_id) VALUES (${f.b.id}::uuid,${f.partner.id}::uuid,${f.connection}::uuid,'acct_forge')`,
      org_autopay_consents: sql`INSERT INTO org_autopay_consents(org_id,enrollment_id,generation,payment_method_id,consent_text_version,consent_text_hash,fee_terms,schedule_terms,contact_email,source) VALUES (${f.b.id}::uuid,${f.enrollment}::uuid,1,${f.method}::uuid,'v1','hash','{}','{}','client@example.com','setup_page')`,
      org_payment_methods: sql`INSERT INTO org_payment_methods(org_id,enrollment_id,stripe_payment_method_id,type) VALUES (${f.b.id}::uuid,${f.enrollment}::uuid,'pm_forge','card')`,
      invoice_autopay_schedules: sql`INSERT INTO invoice_autopay_schedules(org_id,invoice_id,enrollment_id,enrollment_generation,eligible,terms_snapshot) VALUES (${f.b.id}::uuid,${f.invoice}::uuid,${f.enrollment}::uuid,1,true,'{}')`,
      invoice_collection_attempts: sql`INSERT INTO invoice_collection_attempts(org_id,invoice_id,schedule_id,attempt_no,payment_method_id,idempotency_key,principal_amount,currency,initiated_by) VALUES (${f.b.id}::uuid,${f.invoice}::uuid,${f.schedule}::uuid,1,${f.method}::uuid,${randomUUID()},1,'USD','scheduler')`,
      billing_notice_outbox: sql`INSERT INTO billing_notice_outbox(org_id,invoice_id,kind,seq,dedupe_key,to_email,rendered) VALUES (${f.b.id}::uuid,${f.invoice}::uuid,'payment_receipt',1,${randomUUID()},'client@example.com','{}')`,
      billing_link_tokens: sql`INSERT INTO billing_link_tokens(org_id,purpose,token_hash,token_ct,expires_at) VALUES (${f.b.id}::uuid,'stop_autopay',${randomUUID()},'ciphertext',now()+interval '1 day')`,
    }[table];
    expect(await state(() => withDbAccessContext(f.ctx, () => db.execute(q!)))).toBe('42501');
  });
  run('org token reads inherited defaults but cannot update them, and XOR rejects both/neither owners', async () => {
    const f=await fixture();
    await withSystemDbAccessContext(() => db.execute(sql`INSERT INTO billing_payment_settings(partner_id,autopay_offset_days) VALUES (${f.partner.id}::uuid,9)`));
    const rows=await withDbAccessContext(f.ctx,()=>db.execute(sql`SELECT autopay_offset_days FROM billing_payment_settings WHERE partner_id=${f.partner.id}::uuid`));
    expect(rows).toHaveLength(1); expect(rows[0]!.autopay_offset_days).toBe(9);
    const changed=await withDbAccessContext(f.ctx,()=>db.execute(sql`UPDATE billing_payment_settings SET autopay_offset_days=1 WHERE partner_id=${f.partner.id}::uuid RETURNING id`));
    expect(changed).toHaveLength(0);
    expect(await state(()=>withSystemDbAccessContext(()=>db.execute(sql`INSERT INTO billing_payment_settings(org_id,partner_id) VALUES (${f.a.id}::uuid,${f.partner.id}::uuid)`)))).toBe('23514');
    expect(await state(()=>withSystemDbAccessContext(()=>db.execute(sql`INSERT INTO billing_payment_settings DEFAULT VALUES`)))).toBe('23514');
  });
  run('consent remains append-only even under system scope', async () => {
    const f=await fixture();
    const [consent]=await withSystemDbAccessContext(()=>db.execute(sql`INSERT INTO org_autopay_consents(org_id,enrollment_id,generation,payment_method_id,consent_text_version,consent_text_hash,fee_terms,schedule_terms,contact_email,source) VALUES (${f.b.id}::uuid,${f.enrollment}::uuid,1,${f.method}::uuid,'v1','hash','{}','{}','client@example.com','setup_page') RETURNING id`));
    expect(await state(()=>withSystemDbAccessContext(()=>db.execute(sql`UPDATE org_autopay_consents SET contact_email='changed@example.com' WHERE id=${consent!.id}::uuid`)))).toBe('42501');
    expect(await state(()=>withSystemDbAccessContext(()=>db.execute(sql`DELETE FROM org_autopay_consents WHERE id=${consent!.id}::uuid`)))).toBe('42501');
    const grants=await withSystemDbAccessContext(()=>db.execute(sql`SELECT has_table_privilege('breeze_app','org_autopay_consents','UPDATE') AS u,has_table_privilege('breeze_app','org_autopay_consents','DELETE') AS d`));
    expect(grants[0]).toMatchObject({u:false,d:false});
    await expect(admin.begin(async tx=>{
      await tx`SELECT set_config('breeze.scope','system',true)`;
      await tx`UPDATE org_autopay_consents SET contact_email='changed@example.com' WHERE id=${consent!.id as string}`;
    })).rejects.toMatchObject({code:'55000'});
    await withSystemDbAccessContext(async()=>{
      await db.execute(sql`SET LOCAL ROLE breeze_audit_admin`);
      await db.execute(sql`SET LOCAL breeze.allow_audit_retention='1'`);
      const removed=await db.execute(sql`DELETE FROM org_autopay_consents WHERE id=${consent!.id}::uuid RETURNING id`);
      expect(removed).toHaveLength(1);
    });
  });
});

describe('autopay authority and lifecycle CHECK constraints', () => {
  run('B1 prevents duplicate provider methods and removed methods without a timestamp', async () => {
    const f = await fixture();
    expect(await state(() => withSystemDbAccessContext(() => db.execute(sql`INSERT INTO org_payment_methods(org_id,enrollment_id,stripe_payment_method_id,type) VALUES (${f.b.id}::uuid,${f.enrollment}::uuid,${'pm_'+f.method},'card')`)))).toBe('23505');
    expect(await state(() => withSystemDbAccessContext(() => db.execute(sql`UPDATE org_payment_methods SET status='removed' WHERE id=${f.method}::uuid`)))).toBe('23514');
  });
  run('B2 requires cancellation provenance and active effective date', async () => {
    const f = await fixture();
    for (const patch of [sql`status='cancelled'`, sql`status='cancelled',cancelled_at=now()`, sql`status='cancelled',cancel_source='system'`, sql`status='active'`]) {
      expect(await state(() => withSystemDbAccessContext(() => db.execute(sql`UPDATE org_autopay_enrollments SET ${patch} WHERE id=${f.enrollment}::uuid`)))).toBe('23514');
    }
  });
  run('B3 ties eligibility to reason and scheduled states to collection date', async () => {
    const f = await fixture();
    for (const patch of [sql`eligible=false`, sql`ineligible_reason='over_cap'`, sql`state='scheduled'`, sql`state='retry_scheduled'`]) {
      expect(await state(() => withSystemDbAccessContext(() => db.execute(sql`UPDATE invoice_autopay_schedules SET ${patch} WHERE id=${f.schedule}::uuid`)))).toBe('23514');
    }
  });
  run('B4 rejects lowercase and malformed collection currencies', async () => {
    const f = await fixture();
    for (const currency of ['usd', 'US', '12X']) {
      expect(await state(() => withSystemDbAccessContext(() => db.execute(sql`INSERT INTO invoice_collection_attempts(org_id,invoice_id,attempt_no,payment_method_id,idempotency_key,principal_amount,currency,initiated_by) VALUES (${f.b.id}::uuid,${f.invoice}::uuid,1,${f.method}::uuid,${randomUUID()},1,${currency},'client_on_session')`)))).toBe('23514');
    }
  });
  run('B5 requires the purpose-specific token authority', async () => {
    const f = await fixture();
    for (const purpose of vocabulary.BILLING_LINK_PURPOSES) {
      expect(await state(() => withSystemDbAccessContext(() => db.execute(sql`INSERT INTO billing_link_tokens(org_id,purpose,token_hash,token_ct,expires_at) VALUES (${f.b.id}::uuid,${purpose}::billing_link_purpose,${randomUUID()},'ct',now()+interval '1 day')`)))).toBe('23514');
    }
  });
});

run('C5 RLS hides every authority/history row across orgs while same-partner scope reads it', async () => {
  const f = await fixture();
  await withSystemDbAccessContext(async () => {
    await db.execute(sql`INSERT INTO invoice_collection_attempts(org_id,invoice_id,attempt_no,payment_method_id,idempotency_key,principal_amount,currency,initiated_by) VALUES (${f.b.id}::uuid,${f.invoice}::uuid,1,${f.method}::uuid,${randomUUID()},1,'USD','client_on_session')`);
    await db.execute(sql`INSERT INTO billing_notice_outbox(org_id,kind,seq,dedupe_key,to_email,rendered) VALUES (${f.b.id}::uuid,'autopay_request',1,${randomUUID()},'client@example.test','{}')`);
    await db.execute(sql`INSERT INTO billing_link_tokens(org_id,enrollment_id,purpose,token_hash,token_ct,expires_at) VALUES (${f.b.id}::uuid,${f.enrollment}::uuid,'enroll',${randomUUID()},'ct',now()+interval '1 day')`);
    await db.execute(sql`INSERT INTO org_autopay_consents(org_id,enrollment_id,generation,payment_method_id,consent_text_version,consent_text_hash,fee_terms,schedule_terms,contact_email,source) VALUES (${f.b.id}::uuid,${f.enrollment}::uuid,1,${f.method}::uuid,'v1','hash','{}','{}','client@example.test','setup_page')`);
  });
  for (const name of tables.filter(t => t !== 'billing_payment_settings')) {
    const table = sql.identifier(name);
    expect(await withDbAccessContext({ scope: 'partner', orgId: null, currentPartnerId: f.partner.id, accessiblePartnerIds: [f.partner.id], accessibleOrgIds: [f.a.id, f.b.id] }, () => db.execute(sql`SELECT id FROM ${table} WHERE org_id=${f.b.id}::uuid`))).toHaveLength(1);
    expect(await withDbAccessContext(f.ctx, () => db.execute(sql`SELECT id FROM ${table} WHERE org_id=${f.b.id}::uuid`))).toHaveLength(0);
    for (const query of [sql`UPDATE ${table} SET org_id=org_id WHERE org_id=${f.b.id}::uuid RETURNING id`, sql`DELETE FROM ${table} WHERE org_id=${f.b.id}::uuid RETURNING id`]) {
      if (name === 'org_autopay_consents') expect(await state(() => withDbAccessContext(f.ctx, () => db.execute(query)))).toBe('42501');
      else expect(await withDbAccessContext(f.ctx, () => db.execute(query))).toHaveLength(0);
    }
  }
});
