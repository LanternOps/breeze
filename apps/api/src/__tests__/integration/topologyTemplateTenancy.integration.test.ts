import './setup';
import { describe,expect,it } from 'vitest';
import {sql} from 'drizzle-orm';
import {db,withDbAccessContext,withSystemDbAccessContext,type DbAccessContext} from '../../db';
import {createTopologyTenant,orgContext} from './topology-fixtures';
const partnerContext=(partnerId:string):DbAccessContext=>({scope:'partner',orgId:null,accessibleOrgIds:[],accessiblePartnerIds:[partnerId],userId:null});
const scoped=<T>(orgId:string,fn:()=>Promise<T>)=>withDbAccessContext(orgContext(orgId),fn);
async function fixture(){
 const a=await createTopologyTenant(),b=await createTopologyTenant();const templateId=crypto.randomUUID(),versionId=crypto.randomUUID();
 await withDbAccessContext(partnerContext(a.partnerId),async()=>{
  await db.execute(sql`INSERT INTO topology_config_templates(id,partner_id,key,name) VALUES(${templateId}::uuid,${a.partnerId}::uuid,'shared','Shared')`);
  await db.execute(sql`INSERT INTO topology_config_template_versions(id,template_id,partner_id,version,state,payload,content_digest,published_at)
   VALUES(${versionId}::uuid,${templateId}::uuid,${a.partnerId}::uuid,1,'published','{"targets":{},"policies":{}}',${'0'.repeat(64)},now())`);
 });return {a,b,templateId,versionId};
}
describe('topology template tenancy',()=>{
 it('permits own-partner SELECT only and denies foreign partner insert',async()=>{
  const f=await fixture();
  expect(await withDbAccessContext({...orgContext(f.a.orgId),currentPartnerId:f.a.partnerId},()=>db.execute(sql`SELECT id FROM topology_config_templates WHERE id=${f.templateId}::uuid`))).toHaveLength(1);
  expect(await scoped(f.b.orgId,()=>db.execute(sql`SELECT id FROM topology_config_templates WHERE id=${f.templateId}::uuid`))).toHaveLength(0);
  expect(await scoped(f.a.orgId,()=>db.execute(sql`UPDATE topology_config_templates SET name='forged' WHERE id=${f.templateId}::uuid RETURNING id`))).toHaveLength(0);
  await expect(withDbAccessContext(partnerContext(f.b.partnerId),()=>db.execute(sql`INSERT INTO topology_config_templates(partner_id,key,name) VALUES(${f.a.partnerId}::uuid,'forged','Forged')`))).rejects.toMatchObject({cause:{code:'42501'}});
 });
 it('rejects XOR/parent owner mismatches and foreign partner layers',async()=>{
  const f=await fixture();
  await expect(scoped(f.a.orgId,()=>db.execute(sql`INSERT INTO topology_config_templates(org_id,partner_id,key,name) VALUES(${f.a.orgId}::uuid,${f.a.partnerId}::uuid,'both','Both')`))).rejects.toMatchObject({cause:{code:'23514'}});
  await expect(scoped(f.a.orgId,()=>db.execute(sql`INSERT INTO topology_config_template_versions(template_id,org_id,version,payload,content_digest) VALUES(${f.templateId}::uuid,${f.a.orgId}::uuid,2,'{}',${'1'.repeat(64)})`))).rejects.toMatchObject({cause:{code:'23514'}});
  await expect(scoped(f.b.orgId,()=>db.execute(sql`INSERT INTO topology_site_template_bindings(org_id,site_id,partner_version_id) VALUES(${f.b.orgId}::uuid,${f.b.siteId}::uuid,${f.versionId}::uuid)`))).rejects.toMatchObject({cause:{code:'23514'}});
 });
 it('allows valid binding but refuses cross-partner transfer and owner changes behind live references',async()=>{
  const f=await fixture();
  await scoped(f.a.orgId,()=>db.execute(sql`INSERT INTO topology_site_template_bindings(org_id,site_id,partner_version_id) VALUES(${f.a.orgId}::uuid,${f.a.siteId}::uuid,${f.versionId}::uuid)`));
  await expect(withSystemDbAccessContext(()=>db.transaction(async tx=>{
   await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
   await tx.execute(sql`UPDATE organizations SET partner_id=${f.b.partnerId}::uuid WHERE id=${f.a.orgId}::uuid`);
  }))).rejects.toThrow('organization transfer requires topology detach/rebind');
  await expect(withSystemDbAccessContext(()=>db.transaction(async tx=>{
   await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
   await tx.execute(sql`UPDATE topology_config_templates SET partner_id=${f.b.partnerId}::uuid WHERE id=${f.templateId}::uuid`);
   await tx.execute(sql`UPDATE topology_config_template_versions SET partner_id=${f.b.partnerId}::uuid WHERE id=${f.versionId}::uuid`);
  }))).rejects.toThrow('topology version live binding owner mismatch');
 });
 it('rejects published payload edits while allowing coordinated owner-only movement',async()=>{
  const f=await fixture();
  await expect(withDbAccessContext(partnerContext(f.a.partnerId),()=>db.execute(sql`UPDATE topology_config_template_versions SET payload='{"changed":true}' WHERE id=${f.versionId}::uuid`))).rejects.toMatchObject({cause:{code:'23514'}});
  const templateId=crypto.randomUUID(),versionId=crypto.randomUUID();
  await withSystemDbAccessContext(async()=>{
   await db.execute(sql`INSERT INTO topology_config_templates(id,org_id,key,name) VALUES(${templateId}::uuid,${f.a.orgId}::uuid,'org','Org')`);
   await db.execute(sql`INSERT INTO topology_config_template_versions(id,template_id,org_id,version,state,payload,content_digest,published_at) VALUES(${versionId}::uuid,${templateId}::uuid,${f.a.orgId}::uuid,1,'published','{}',${'0'.repeat(64)},now())`);
   await db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
   await db.execute(sql`UPDATE topology_config_templates SET org_id=${f.b.orgId}::uuid WHERE id=${templateId}::uuid`);
   await db.execute(sql`UPDATE topology_config_template_versions SET org_id=${f.b.orgId}::uuid WHERE id=${versionId}::uuid`);
  });
  expect((await scoped(f.b.orgId,()=>db.execute(sql`SELECT content_digest FROM topology_config_template_versions WHERE id=${versionId}::uuid`)))[0]?.content_digest).toBe('0'.repeat(64));
 });
 it('purging a pinned version clears live provenance and requires re-arm',async()=>{
  const f=await fixture();
  await scoped(f.a.orgId,async()=>{
   await db.execute(sql`INSERT INTO topology_site_template_bindings(org_id,site_id,partner_version_id,effective_digest,status) VALUES(${f.a.orgId}::uuid,${f.a.siteId}::uuid,${f.versionId}::uuid,${'1'.repeat(64)},'applied')`);
   await db.execute(sql`INSERT INTO topology_monitoring_policies(org_id,site_id,key,definition,partner_version_id,configuration_digest,enabled,authority_digest) VALUES(${f.a.orgId}::uuid,${f.a.siteId}::uuid,'p','{}',${f.versionId}::uuid,${'1'.repeat(64)},true,${'2'.repeat(64)})`);
  });
  await withSystemDbAccessContext(()=>db.execute(sql`DELETE FROM topology_config_template_versions WHERE id=${f.versionId}::uuid`));
  await scoped(f.a.orgId,async()=>{
   expect((await db.execute(sql`SELECT partner_version_id,effective_digest,status FROM topology_site_template_bindings WHERE site_id=${f.a.siteId}::uuid`))[0]).toMatchObject({partner_version_id:null,effective_digest:null,status:'requires_rearm'});
   expect((await db.execute(sql`SELECT enabled,configuration_digest,authority_digest FROM topology_monitoring_policies WHERE site_id=${f.a.siteId}::uuid`))[0]).toMatchObject({enabled:false,configuration_digest:null,authority_digest:null});
  });
 });
});
