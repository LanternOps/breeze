import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import { groupRoutes } from './groups';

const GROUP_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GROUP_ID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORG_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID_2 = '22222222-2222-2222-2222-222222222222';
const PARTNER_ID = '33333333-3333-3333-3333-333333333333';
const DEVICE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DEVICE_ID_2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SITE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SITE_ID_2 = '12121212-1212-4121-8121-121212121212';

vi.mock('../services/deviceGroupOwnership', async (original) => ({ ...await original<typeof import('../services/deviceGroupOwnership')>(), resolveOrgSessionPartnerId: vi.fn(), readPartnerGroupsForOrgSession: vi.fn(), findPartnerOwnedGroupIds: vi.fn().mockResolvedValue([]) }));
vi.mock('../jobs/partnerGroupEvaluationJobs', () => ({ requestPartnerGroupEvaluationAfterCommit: vi.fn() }));
vi.mock('../services/partnerGroupPreview', () => ({ previewPartnerGroup: vi.fn() }));
vi.mock('../services/deviceGroupDelete', () => ({ deleteDeviceGroup: vi.fn(), DeviceGroupDeleteError: class extends Error {} }));
vi.mock('../services', () => ({}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn()
}));

vi.mock('../jobs/peripheralJobs', () => ({
  schedulePeripheralPolicyDevice: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/filterEngine', () => ({
  evaluateFilterWithPreview: vi.fn().mockResolvedValue({
    totalCount: 1,
    devices: [{
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      hostname: 'host-1',
      displayName: 'Host One',
      osType: 'windows',
      status: 'online',
      lastSeenAt: new Date('2026-01-01')
    }],
    evaluatedAt: new Date('2026-01-01')
  }),
  extractFieldsFromFilter: vi.fn().mockReturnValue(['osType']),
  validateFilter: vi.fn().mockReturnValue({ valid: true, errors: [] })
}));

vi.mock('../services/groupMembership', async () => {
  const actual = await vi.importActual<typeof import('../services/groupMembership')>(
    '../services/groupMembership'
  );
  return {
    evaluateGroupMembership: vi.fn().mockResolvedValue(undefined),
    pinDeviceToGroup: vi.fn().mockResolvedValue(undefined),
    pruneGroupMembershipsOutsideSite: vi.fn().mockResolvedValue(undefined),
    // Real: the extracted tenancy guard + membership insert that group-create
    // (#3159) and POST /:id/devices now share. These tests are that logic's
    // coverage, exercised against the already-mocked `../db` / `../db/schema`.
    validateManualMembershipDevices: actual.validateManualMembershipDevices,
    addManualGroupMemberships: actual.addManualGroupMemberships
  };
});

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  }
,
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  deviceGroups: {
    id: 'id',
    orgId: 'orgId',
    partnerId: 'partnerId',
    filterRevision: 'filterRevision',
    siteId: 'siteId',
    name: 'name',
    type: 'type',
    rules: 'rules',
    filterConditions: 'filterConditions',
    filterFieldsUsed: 'filterFieldsUsed',
    parentId: 'parentId',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt'
  },
  deviceGroupMemberships: {
    deviceId: 'deviceId',
    groupId: 'groupId',
    isPinned: 'isPinned',
    addedAt: 'addedAt',
    addedBy: 'addedBy'
  },
  devices: {
    id: 'id',
    orgId: 'orgId',
    partnerId: 'partnerId',
    filterRevision: 'filterRevision',
    hostname: 'hostname',
    displayName: 'displayName',
    status: 'status',
    osType: 'osType'
  },
  sites: {
    id: 'id',
    orgId: 'orgId'
  },
  configPolicyAssignments: {
    id: 'id',
    configPolicyId: 'configPolicyId',
    level: 'level',
    targetId: 'targetId',
    priority: 'priority',
    createdAt: 'createdAt',
  },
  configurationPolicies: {
    id: 'id',
    name: 'name',
    status: 'status',
  },
  groupMembershipLog: {
    id: 'id',
    groupId: 'groupId',
    deviceId: 'deviceId',
    action: 'action',
    reason: 'reason',
    createdAt: 'createdAt'
  }
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      orgId: '11111111-1111-1111-1111-111111111111',
      partnerId: null,
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111'
    });
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn((_resource: string, action: string) => async (c: any, next: any) => {
    if (action === 'write' && c.get('permissions')?.denyWrite) return c.json({error:'Permission denied'},403);
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next())
}));

import { db } from '../db';
import { writeRouteAudit } from '../services/auditEvents';
import { authMiddleware } from '../middleware/auth';
import { validateFilter } from '../services/filterEngine';
import { resolveOrgSessionPartnerId, readPartnerGroupsForOrgSession, findPartnerOwnedGroupIds } from '../services/deviceGroupOwnership';
import { requestPartnerGroupEvaluationAfterCommit } from '../jobs/partnerGroupEvaluationJobs';
import { previewPartnerGroup } from '../services/partnerGroupPreview';
import { schedulePeripheralPolicyDevice } from '../jobs/peripheralJobs';
import { deleteDeviceGroup } from '../services/deviceGroupDelete';
import { evaluateGroupMembership } from '../services/groupMembership';

function makeGroup(overrides: Record<string, unknown> = {}) {
  return {
    id: GROUP_ID,
    orgId: null,
    partnerId: PARTNER_ID,
    siteId: null,
    name: 'Test Group',
    type: 'dynamic',
    rules: { legacy: true },
    filterConditions: { operator: 'AND', conditions: [{ field: 'osType', operator: 'equals', value: 'windows' }] },
    filterFieldsUsed: ['osType'],
    parentId: null,
    filterRevision: 1, evaluatedRevision: 0, evaluatedAt: null, evaluationFailedOrgs: 0,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides
  };
}



function query(rows: unknown[]) {
  const chain = {
    from: vi.fn(), where: vi.fn(), innerJoin: vi.fn(), leftJoin: vi.fn(), groupBy: vi.fn(), offset: vi.fn(), orderBy: vi.fn(), limit: vi.fn(),
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
  };
  for (const method of ['from', 'where', 'innerJoin', 'leftJoin', 'groupBy', 'offset', 'orderBy', 'limit'] as const) chain[method].mockReturnValue(chain);
  return chain;
}

describe('partner-owned groups W3', () => {
  let app: Hono;
  const setScope = (scope: 'organization' | 'partner' | 'system', access = 'all', partnerId: string | null = PARTNER_ID, siteRestricted: boolean | string[] = false, denyWrite = false) => {
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', { scope, orgId: ORG_ID, partnerId: scope === 'organization' ? null : partnerId, partnerOrgAccess: access, accessibleOrgIds: [ORG_ID], canAccessOrg: (id: string) => id === ORG_ID });
      if (siteRestricted || denyWrite) c.set('permissions', { ...(siteRestricted ? {allowedSiteIds: Array.isArray(siteRestricted) ? siteRestricted : [SITE_ID]} : {}), denyWrite });
      return next();
    });
  };
  const request = (method: string, suffix = '', body?: unknown) => app.request(`/groups${suffix}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : {body: JSON.stringify(body)}) });
  const insert = () => {
    const values = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([makeGroup()]) });
    vi.mocked(db.insert).mockReturnValue({values} as never); return values;
  };
  beforeEach(() => {
    vi.clearAllMocks();
    setScope('partner');
    vi.mocked(db.select).mockReset().mockImplementation(() => query([]) as never);
    vi.mocked(resolveOrgSessionPartnerId).mockResolvedValue(PARTNER_ID);
    const {id, partnerId, name, type, createdAt, updatedAt} = makeGroup();
    vi.mocked(readPartnerGroupsForOrgSession).mockResolvedValue([{id, partnerId, name, type, createdAt, updatedAt}] as never);
    vi.mocked(validateFilter).mockReturnValue({ valid: true, errors: [] });
    app = new Hono(); app.route('/groups', groupRoutes);
  });
  it.each(['selected', 'none'])('POST partner denies %s before validation', async access => {
    setScope('partner', access);
    expect((await request('POST', '', {ownerScope: 'partner'})).status).toBe(403);
  });
  it.each([['organization',403],['system',400]] as const)('POST partner denies %s', async (scope,status) => {
    setScope(scope); expect((await request('POST', '', {ownerScope:'partner', name:'Fleet', type:'dynamic',filterConditions:makeGroup().filterConditions})).status).toBe(status);
  });
  it.each([{allowedSiteIds: [SITE_ID]}, {allowedSiteIds: []}])('POST partner refuses site restriction $allowedSiteIds without writing', async ({allowedSiteIds}) => {
    setScope('partner', 'all', PARTNER_ID, allowedSiteIds);
    insert();
    const res = await request('POST', '', {ownerScope: 'partner', name: 'Fleet', type: 'dynamic', filterConditions: makeGroup().filterConditions});
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({error: 'Access to this site denied'});
    expect(db.insert).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
    expect(requestPartnerGroupEvaluationAfterCommit).not.toHaveBeenCalled();
  });
  it.each([
    {allowedSiteIds: [SITE_ID], filterChanged: false},
    {allowedSiteIds: [], filterChanged: false},
    {allowedSiteIds: [SITE_ID], filterChanged: true},
    {allowedSiteIds: [], filterChanged: true},
  ])('PATCH partner refuses site restriction $allowedSiteIds with filterChanged=$filterChanged', async ({allowedSiteIds, filterChanged}) => {
    setScope('partner', 'all', PARTNER_ID, allowedSiteIds);
    vi.mocked(db.select).mockReturnValueOnce(query([makeGroup()]) as never);
    vi.mocked(db.update).mockReturnValue({set: vi.fn().mockReturnValue({where: vi.fn().mockReturnValue({returning: vi.fn().mockResolvedValue([makeGroup()])})})} as never);
    const res = await request('PATCH', '/'+GROUP_ID, {name: 'Changed', ...(filterChanged ? {filterConditions: makeGroup().filterConditions} : {})});
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({error: 'Access to this site denied'});
    expect(db.update).not.toHaveBeenCalled();
    expect(writeRouteAudit).not.toHaveBeenCalled();
    expect(requestPartnerGroupEvaluationAfterCommit).not.toHaveBeenCalled();
  });
  it('POST partner stamps token owner and enqueues evaluation', async () => {
    const values=insert();
    const res=await request('POST', '?orgId='+ORG_ID_2, {ownerScope:'partner',partnerId:ORG_ID_2,name:'Fleet',type:'dynamic',filterConditions:makeGroup().filterConditions});
    expect(res.status).toBe(201);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({orgId:null,partnerId:PARTNER_ID,siteId:null,parentId:null}));
    expect((await res.json()).data).toMatchObject({ownerScope:'partner',deviceCount:0,evaluation:{state:'pending'}});
    expect(requestPartnerGroupEvaluationAfterCommit).toHaveBeenCalledWith(GROUP_ID,'created');
    expect(evaluateGroupMembership).not.toHaveBeenCalled();
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({orgId:null,action:'device_group.create'}));
  });
  it.each([{orgId:ORG_ID},{siteId:SITE_ID},{parentId:GROUP_ID_2},{deviceIds:[]},{rules:{}},{type:'static'},{filterConditions:null}])('POST partner rejects shape %j', async invalid => {
    const res=await request('POST','',{ownerScope:'partner',name:'Fleet',type:'dynamic',filterConditions:makeGroup().filterConditions,...invalid});
    expect(res.status).toBe(400); expect(db.insert).not.toHaveBeenCalled();
  });
  it.each(['groupId','orgId'])('POST rejects nested %s filters', async field => {
    const res=await request('POST','',{ownerScope:'partner',name:'Fleet',type:'dynamic',filterConditions:{operator:'AND',conditions:[{operator:'OR',conditions:[{field,operator:'equals',value:ORG_ID}]}]}});
    expect(res.status).toBe(400); expect(await res.json()).toMatchObject({code:'PARTNER_GROUP_FILTER_UNSUPPORTED'});
  });
  it.each(['PATCH','DELETE'])('%s read-before-gate and unknown response equivalence', async method => {
    for (const [scope,access,owner,status] of [['partner','selected',PARTNER_ID,403],['partner','none',PARTNER_ID,404],['partner','all',ORG_ID_2,404],['organization','all',PARTNER_ID,404]] as const) {
      setScope(scope,access); vi.mocked(db.select).mockReturnValueOnce(query([makeGroup({partnerId:owner})]) as never);
      const res=await request(method,'/'+GROUP_ID,{}); expect(res.status).toBe(status);
      if(status===404) expect(await res.json()).toEqual({error:'Group not found'});
    }
  });
  it.each([false,true])('PATCH filter changed=%s bumps only filter edits', async changed => {
    vi.mocked(db.select).mockReturnValueOnce(query([makeGroup()]) as never);
    const set=vi.fn().mockReturnValue({where:vi.fn().mockReturnValue({returning:vi.fn().mockResolvedValue([makeGroup()])})});
    vi.mocked(db.update).mockReturnValue({set} as never);
    const res=await request('PATCH','/'+GROUP_ID,{name:'New',ownerScope:'organization',...(changed?{filterConditions:makeGroup().filterConditions}:{})});
    expect(res.status).toBe(200); expect(set.mock.calls[0]?.[0]).not.toHaveProperty('ownerScope');
    expect(set.mock.calls[0]?.[0]).not.toHaveProperty('orgId');
    if(changed){expect(set.mock.calls[0]?.[0]).toHaveProperty('filterRevision');expect(requestPartnerGroupEvaluationAfterCommit).toHaveBeenCalledWith(GROUP_ID,'filter_updated');}
    else {expect(set.mock.calls[0]?.[0]).not.toHaveProperty('filterRevision');expect(requestPartnerGroupEvaluationAfterCommit).not.toHaveBeenCalled();}
    expect(evaluateGroupMembership).not.toHaveBeenCalled();
  });
  it.each([{siteId:SITE_ID},{parentId:GROUP_ID_2},{type:'static'},{filterConditions:null},{rules:{}}])('PATCH rejects shape %j', async body => {
    vi.mocked(db.select).mockReturnValueOnce(query([makeGroup()]) as never);
    expect((await request('PATCH','/'+GROUP_ID,body)).status).toBe(400);
  });
  it.each(['partner','system'] as const)('DELETE %s audits partner owner', async scope => {
    setScope(scope); vi.mocked(db.select).mockReturnValueOnce(query([makeGroup()]) as never);
    vi.mocked(deleteDeviceGroup).mockResolvedValue({group:makeGroup(),affectedDeviceIds:[DEVICE_ID]} as never);
    expect((await request('DELETE','/'+GROUP_ID)).status).toBe(200);
    expect(deleteDeviceGroup).toHaveBeenCalledWith(GROUP_ID,{partnerId:PARTNER_ID});
    expect(schedulePeripheralPolicyDevice).toHaveBeenCalledWith(DEVICE_ID,'group_deleted');
    expect(writeRouteAudit).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({orgId:null,action:'device_group.delete'}));
  });
  it.each([['POST','/devices',{deviceIds:[DEVICE_ID]}],['DELETE','/devices/'+DEVICE_ID,undefined],['POST','/devices/'+DEVICE_ID+'/pin',undefined],['DELETE','/devices/'+DEVICE_ID+'/pin',undefined]])('manual %s %s stays read-only',async(method,suffix,body)=>{
    vi.mocked(db.select).mockReturnValueOnce(query([makeGroup()]) as never);
    const res=await request(String(method),'/'+GROUP_ID+suffix,body);expect(res.status).toBe(400);expect(await res.json()).toMatchObject({code:'PARTNER_GROUP_READ_ONLY'});
  });
  it.each(['','/'+GROUP_ID,'/'+GROUP_ID+'/devices'])('OD5 redacts filter in %s',async suffix=>{
    setScope('organization');
    const res=await request('GET',suffix || '?ownerScope=all');
    expect(res.status).toBe(200);const raw=await res.text();expect(raw).not.toContain('windows');expect(raw).not.toContain('osType');
    expect(resolveOrgSessionPartnerId).toHaveBeenCalledWith(ORG_ID);
    if(!suffix.endsWith('/devices')) expect(JSON.parse(raw).data).toEqual(suffix ? expect.objectContaining({filterConditions:null,rules:null,evaluation:null,ownerScope:'partner'}) : [expect.objectContaining({filterConditions:null,rules:null,evaluation:null,ownerScope:'partner'})]);
  });
  it('other-partner org response equals unknown ID',async()=>{
    setScope('organization');vi.mocked(readPartnerGroupsForOrgSession).mockResolvedValue([]);
    const a=await request('GET','/'+GROUP_ID),b=await request('GET','/'+GROUP_ID_2);
    expect(a.status).toBe(404);expect(await a.text()).toBe(await b.text());
  });
  it('P-none list and detail are closed',async()=>{
    setScope('partner','none');expect(await (await request('GET','?ownerScope=partner')).json()).toEqual({data:[],total:0});
    vi.mocked(db.select).mockReturnValueOnce(query([makeGroup()]) as never);expect((await request('GET','/'+GROUP_ID)).status).toBe(404);
  });
  it('partner list returns evaluation state',async()=>{
    vi.mocked(db.select).mockReturnValueOnce(query([makeGroup()]) as never);
    const res=await request('GET','?ownerScope=partner');expect(res.status).toBe(200);expect((await res.json()).data[0]).toMatchObject({ownerScope:'partner',evaluation:{state:'pending',failedOrgs:0}});
  });
  it.each(['POST', 'PATCH'])('%s malformed JSON returns 400', async method => {
    if (method === 'PATCH') vi.mocked(db.select).mockReturnValueOnce(query([makeGroup()]) as never);
    const res = await app.request('/groups' + (method === 'PATCH' ? '/' + GROUP_ID : ''), {method, headers:{'Content-Type':'application/json'},body:'{'});
    expect(res.status).toBe(400);
  });
  it('unreadable manual add returns unknown-id before body validation', async () => {
    setScope('organization'); vi.mocked(db.select).mockReturnValueOnce(query([makeGroup()]) as never);
    const res = await request('POST','/'+GROUP_ID+'/devices',{});
    expect(res.status).toBe(404);expect(await res.json()).toEqual({error:'Group not found'});
  });

  it.each(['partner','organization'] as const)('orgId outside access retains %s partner definitions with zero members', async scope => {
    setScope(scope);
    if(scope === 'partner') vi.mocked(db.select).mockReturnValueOnce(query([makeGroup()]) as never);
    else vi.mocked(db.select).mockReturnValueOnce(query([]) as never);
    const counts = query([]);vi.mocked(db.select).mockReturnValueOnce(counts as never);
    const res = await request('GET','?ownerScope=partner&orgId='+ORG_ID_2);
    expect(res.status).toBe(200);expect((await res.json()).data).toEqual([expect.objectContaining({id:GROUP_ID,deviceCount:0})]);
    const condition = new PgDialect().sqlToQuery(counts.where.mock.calls[0]?.[0]);
    expect(condition.sql).toContain('false');
  });

  it('default ownerScope selects only organizations; partner scope pins owner', async () => {
    const orgs = query([]);vi.mocked(db.select).mockReturnValueOnce(orgs as never);
    await request('GET');
    const orgWhere = new PgDialect().sqlToQuery(orgs.where.mock.calls[0]?.[0]);
    expect(orgWhere.params).toContain(ORG_ID);expect(orgWhere.params).not.toContain(PARTNER_ID);
    const partner = query([]);vi.mocked(db.select).mockReturnValueOnce(partner as never);
    await request('GET','?ownerScope=partner');
    const partnerWhere = new PgDialect().sqlToQuery(partner.where.mock.calls[0]?.[0]);
    expect(partnerWhere.sql).toContain('is null');expect(partnerWhere.params).toContain(PARTNER_ID);
  });
  it.each(['','/'+GROUP_ID,'/'+GROUP_ID+'/devices','/'+GROUP_ID+'/membership-log'])('selected-access %s explicitly clamps membership org ids',async suffix => {
    setScope('partner','selected');
    vi.mocked(db.select).mockReturnValueOnce(query([makeGroup()]) as never);
    const membership = query([]);vi.mocked(db.select).mockReturnValueOnce(membership as never);
    const res=await request('GET',suffix || '?ownerScope=partner');expect(res.status).toBe(200);
    const predicate=new PgDialect().sqlToQuery(membership.where.mock.calls[0]?.[0]);
    expect(predicate.params).toContain(ORG_ID);expect(predicate.params).not.toContain(ORG_ID_2);
    expect(predicate.sql).toContain(' in ');
  });
  it('OD5 all returns own organization and partner groups',async()=>{
    setScope('organization');vi.mocked(db.select).mockReturnValueOnce(query([makeGroup({id:GROUP_ID_2,orgId:ORG_ID,partnerId:null})]) as never);
    const res=await request('GET','?ownerScope=all');
    expect((await res.json()).data).toEqual(expect.arrayContaining([expect.objectContaining({id:GROUP_ID_2,ownerScope:'organization'}),expect.objectContaining({id:GROUP_ID,ownerScope:'partner',rules:null,filterConditions:null})]));
  });
  it.each(['?siteId='+SITE_ID,'?parentId='+GROUP_ID_2])('list excludes partner groups with %s',async filter=>{
    setScope('organization');await request('GET',filter+'&ownerScope=all');expect(readPartnerGroupsForOrgSession).not.toHaveBeenCalled();
  });
  it.each(['','/'+GROUP_ID,'/'+GROUP_ID+'/devices'])('site restricted org %s fails closed',async suffix=>{
    setScope('organization','all',null,true);const res=await request('GET',suffix || '?ownerScope=all');
    expect(res.status).toBe(suffix?403:200);
    if(!suffix){expect((await res.json()).data).toEqual([]);expect(readPartnerGroupsForOrgSession).not.toHaveBeenCalled();}
  });
  it.each([['pending',2,1,3],['partial',2,2,3],['current',2,2,0]] as const)('evaluation state %s',async(state,filterRevision,evaluatedRevision,evaluationFailedOrgs)=>{
    vi.mocked(db.select).mockReturnValueOnce(query([makeGroup({filterRevision,evaluatedRevision,evaluationFailedOrgs})]) as never);
    const res=await request('GET','/'+GROUP_ID);expect((await res.json()).data.evaluation).toEqual({state,evaluatedAt:null,failedOrgs:evaluationFailedOrgs});
  });
  it('partner siteId filter is permitted',async()=>{
    insert();const res=await request('POST','',{ownerScope:'partner',name:'Sites',type:'dynamic',filterConditions:{operator:'AND',conditions:[{field:'siteId',operator:'equals',value:SITE_ID}]}});expect(res.status).toBe(201);
  });
  it.each(['all','selected'])('preview %s returns partial progress',async access=>{
    setScope('partner',access);vi.mocked(db.select).mockReturnValueOnce(query([makeGroup()]) as never);
    vi.mocked(previewPartnerGroup).mockResolvedValue({devices:[],total:2,partial:true,evaluatedOrgs:1,totalOrgs:2});
    const res=await request('POST','/'+GROUP_ID+'/preview');expect(res.status).toBe(200);expect((await res.json()).data).toMatchObject({totalCount:2,partial:true,evaluatedOrgs:1,totalOrgs:2});
  });
  it.each(['POST','PATCH'])('org %s refuses own-partner group filter reference',async method=>{
    setScope('organization');if(method==='PATCH')vi.mocked(db.select).mockReturnValueOnce(query([makeGroup({orgId:ORG_ID,partnerId:null})]) as never);
    vi.mocked(findPartnerOwnedGroupIds).mockResolvedValueOnce([GROUP_ID]);
    const res=await request(method,method==='PATCH'?'/'+GROUP_ID_2:'',{name:'Org',type:'dynamic',filterConditions:{operator:'AND',conditions:[{field:'groupId',operator:'equals',value:GROUP_ID}]}});
    expect(res.status).toBe(400);expect(await res.json()).toMatchObject({code:'PARTNER_GROUP_FILTER_UNSUPPORTED'});
  });

  it.each([['PATCH',''],['DELETE',''],['POST','/devices'],['DELETE','/devices/'+DEVICE_ID],['POST','/devices/'+DEVICE_ID+'/pin'],['DELETE','/devices/'+DEVICE_ID+'/pin']])('org read-only user %s %s receives unknown-id before write permission gate',async(method,suffix)=>{
    setScope('organization','all',null,false,true);
    vi.mocked(db.select).mockReturnValueOnce(query([makeGroup()]) as never);
    const res=await request(method,'/'+GROUP_ID+suffix,{});
    expect(res.status).toBe(404);expect(await res.json()).toEqual({error:'Group not found'});
  });

});
