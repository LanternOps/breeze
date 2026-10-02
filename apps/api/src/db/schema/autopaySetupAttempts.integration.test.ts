import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { createOrganization, createPartner } from '../../__tests__/integration/db-utils';
describe('durable setup authorization', () => {
  it('forces RLS and refuses changing accepted terms', async () => {
    const role = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`));
    expect(Array.from(role)).toEqual([{name:'breeze_app',rolsuper:false,rolbypassrls:false}]);
    const partner = await createPartner();
    const org = await createOrganization({partnerId:partner.id});
    const enrollment = randomUUID();
    const attempt = randomUUID();
    const connection = randomUUID();
    await withSystemDbAccessContext(async () => {
      await db.execute(sql`INSERT INTO stripe_connect_accounts(id,partner_id,stripe_account_id,api_key,key_last4)
        VALUES (${connection},${partner.id},'acct_test','enc:test-key','test')`);
      await db.execute(sql`INSERT INTO org_autopay_enrollments
        (id,org_id,partner_id,status,generation,stripe_connection_id,stripe_account_id) VALUES
        (${enrollment},${org.id},${partner.id},'requested',1,${connection},'acct_test')`);
      await db.execute(sql`INSERT INTO autopay_setup_attempts
        (id,org_id,partner_id,enrollment_id,generation,source,method_type,
         stripe_connection_id,stripe_account_id,consent_snapshot)
        VALUES (${attempt},${org.id},${partner.id},${enrollment},1,'setup_page','card',
          ${connection},'acct_test','{"text":"accepted original"}'::jsonb)`);
    });
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      UPDATE autopay_setup_attempts SET consent_snapshot='{}'::jsonb WHERE id=${attempt}
    `))).rejects.toMatchObject({cause:{code:'23514',message:'autopay setup authority is immutable'}});
    const rows = await withDbAccessContext({scope:'organization',orgId:randomUUID(),
      currentPartnerId:partner.id, accessibleOrgIds:[],accessiblePartnerIds:[],userId:null}, () => db.execute(sql`
        SELECT id FROM autopay_setup_attempts WHERE id=${attempt}`));
    expect(Array.from(rows)).toEqual([]);
    await expect(withDbAccessContext({scope:'organization',orgId:randomUUID(),currentPartnerId:partner.id,accessibleOrgIds:[],accessiblePartnerIds:[],userId:null},()=>db.execute(sql`
      INSERT INTO autopay_setup_attempts(org_id,partner_id,enrollment_id,generation,source,method_type,
       stripe_connection_id,stripe_account_id,consent_snapshot)
      VALUES(${org.id},${partner.id},${enrollment},1,'setup_page','card',${connection},'acct_test','{}'::jsonb)
    `))).rejects.toMatchObject({cause:{code:'42501'}});
    const flags=await withSystemDbAccessContext(()=>db.execute(sql`
      SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='autopay_setup_attempts'::regclass`));
    expect(Array.from(flags)).toEqual([{relrowsecurity:true,relforcerowsecurity:true}]);
    await withSystemDbAccessContext(() => db.execute(sql`
      DELETE FROM autopay_setup_attempts WHERE id=${attempt}`));
  });
});
