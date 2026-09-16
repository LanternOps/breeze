import './setup';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {sql} from 'drizzle-orm';
import {db,withDbAccessContext,withSystemDbAccessContext} from '../../db';
import {executeOrgMerge} from '../../services/orgMerge';
import {cascadeDeleteOrg} from '../../services/tenantCascade';
import {createOrganization} from './db-utils';
import {createTopologyTenant,orgContext} from './topology-fixtures';
beforeEach(()=>vi.stubEnv('ORG_MERGE_FENCE_DRAIN_MS','0'));
afterEach(()=>vi.unstubAllEnvs());
describe('topology template lifecycle',()=>{
 it('real org merge preserves pinned published content and resolves name/key collisions',async()=>{
  const a=await createTopologyTenant();const survivor=await createOrganization({partnerId:a.partnerId});const templateId=crypto.randomUUID(),versionId=crypto.randomUUID();
  await withSystemDbAccessContext(async()=>{
   await db.execute(sql`INSERT INTO topology_config_templates(id,org_id,key,name) VALUES(${templateId}::uuid,${a.orgId}::uuid,'common','Common'),(gen_random_uuid(),${survivor.id}::uuid,'common','Common')`);
   await db.execute(sql`INSERT INTO topology_config_template_versions(id,template_id,org_id,version,state,payload,content_digest,published_at) VALUES(${versionId}::uuid,${templateId}::uuid,${a.orgId}::uuid,1,'published','{"targets":{},"policies":{}}',${'0'.repeat(64)},now())`);
   await db.execute(sql`INSERT INTO topology_site_template_bindings(org_id,site_id,org_version_id,effective_digest) VALUES(${a.orgId}::uuid,${a.siteId}::uuid,${versionId}::uuid,${'1'.repeat(64)})`);
  });
  await executeOrgMerge({loserOrgId:a.orgId,survivorOrgId:survivor.id,partnerId:a.partnerId,performedBy:'00000000-0000-0000-0000-000000000000'});
  await withDbAccessContext(orgContext(survivor.id),async()=>{
   expect((await db.execute(sql`SELECT org_id,content_digest FROM topology_config_template_versions WHERE id=${versionId}::uuid`))[0]).toEqual({org_id:survivor.id,content_digest:'0'.repeat(64)});
   expect((await db.execute(sql`SELECT org_version_id FROM topology_site_template_bindings WHERE site_id=${a.siteId}::uuid`))[0]?.org_version_id).toBe(versionId);
   expect((await db.execute(sql`SELECT key FROM topology_config_templates WHERE id=${templateId}::uuid`))[0]?.key).toBe(`common-${templateId}`);
  });
 });
 it('erases one org library without touching another owner',async()=>{
  const a=await createTopologyTenant(),b=await createTopologyTenant();
  await withSystemDbAccessContext(async()=>{
   for(const orgId of [a.orgId,b.orgId]) await db.execute(sql`INSERT INTO topology_config_templates(org_id,key,name) VALUES(${orgId}::uuid,'owned','Owned')`);
  });
  await cascadeDeleteOrg(a.orgId,'00000000-0000-0000-0000-000000000000');
  expect(await withDbAccessContext(orgContext(b.orgId),()=>db.execute(sql`SELECT id FROM topology_config_templates WHERE org_id=${b.orgId}::uuid`))).toHaveLength(1);
 });
});
