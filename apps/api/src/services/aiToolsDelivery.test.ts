import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db', () => ({ db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn() } }));
vi.mock('../middleware/auth', async original => ({ ...await original<typeof import('../middleware/auth')>(), hasSatisfiedMfa: vi.fn(() => true) }));
vi.mock('./delivery/railContracts', async original => ({ ...await original<typeof import('./delivery/railContracts')>(), getRoutingRuleWithAccess: vi.fn(), canAccessRoutingSites: vi.fn(async () => true), getEscalationPolicyWithOrgCheck: vi.fn() }));
vi.mock('./delivery/describeDelivery', () => ({ previewDelivery: vi.fn() }));
vi.mock('./delivery/inheritedRails', () => ({ readInheritedRails: vi.fn(async () => []) }));
vi.mock('./delivery/railOwnership', async original => ({ ...await original<typeof import('./delivery/railOwnership')>(), partnerIdForOrg: vi.fn(async () => null) }));
vi.mock('./delivery/routingRuleWrites', async original => ({ ...await original<typeof import('./delivery/routingRuleWrites')>(), upsertDefaultRow: vi.fn(), escalationPolicyCompatible: vi.fn(async () => true) }));
import { db } from '../db';
import { hasSatisfiedMfa, type AuthContext } from '../middleware/auth';
import { partnerIdForOrg } from './delivery/railOwnership';
import { getRoutingRuleWithAccess, canAccessRoutingSites } from './delivery/railContracts';
import { getEscalationPolicyWithOrgCheck } from './delivery/railContracts';
import { previewDelivery } from './delivery/describeDelivery';
import { readInheritedRails } from './delivery/inheritedRails';
import { upsertDefaultRow, escalationPolicyCompatible } from './delivery/routingRuleWrites';
import { registerDeliveryTools } from './aiToolsDelivery';
import type { AiTool } from './aiTools';
const ORG = '10000000-0000-4000-8000-000000000001', OTHER = '10000000-0000-4000-8000-000000000002';
const ID = '20000000-0000-4000-8000-000000000001', CH = '30000000-0000-4000-8000-000000000001';
const auth = (patch: Partial<AuthContext> = {}) => ({ principal: { kind: 'user_session' }, scope: 'organization',
  orgId: ORG, partnerId: null, accessibleOrgIds: [ORG], token: { mfa: true }, canAccessOrg: (id: string) => id === ORG, ...patch }) as AuthContext;
const registry = new Map<string, AiTool>(); registerDeliveryTools(registry);
const call = async (input: Record<string, unknown>, identity = auth()) => JSON.parse(await registry.get('manage_delivery')!.handler(input, identity));
const row = { id: ID, orgId: ORG, partnerId: null, name: 'Everything else', isDefault: true, conditions: {}, channelIds: [], escalationPolicyId: null };
function channels(ids: string[]) { vi.mocked(db.select).mockReturnValue({ from: () => ({ where: async () => ids.map(id => ({ id })) }) } as never); }
function insertReturning(value: unknown) {
  const values = vi.fn(() => ({ returning: async () => [value] }));
  vi.mocked(db.insert).mockReturnValue({ values } as never); return values;
}
beforeEach(() => {
  vi.resetAllMocks(); vi.mocked(hasSatisfiedMfa).mockReturnValue(true);
  vi.mocked(escalationPolicyCompatible).mockResolvedValue(true);
  vi.mocked(canAccessRoutingSites).mockResolvedValue(true);
  vi.mocked(partnerIdForOrg).mockResolvedValue(null);
  vi.mocked(readInheritedRails).mockResolvedValue([]);
  vi.mocked(getRoutingRuleWithAccess).mockResolvedValue(row as never);
  vi.mocked(upsertDefaultRow).mockResolvedValue(row as never);
});
describe('manage_delivery', () => {
  it('returns the authorized shared preview unchanged', async () => {
    const result = { channelIds: [CH], skippedChannelIds: [{ id: ID, reason: 'unavailable' }, { id: OTHER, reason: 'disabled' }],
      escalationPolicyId: null, source: 'default_row', display: 'On-call',
      description: { channels: [{ id: CH, name: 'On-call', enabled: true }], escalationPolicy: null, owner: 'org' } };
    vi.mocked(previewDelivery).mockResolvedValue(result as never);
    expect(await call({ action: 'resolve', orgId: ORG, severity: 'high' })).toEqual(result);
    expect(previewDelivery).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, severity: 'high' }), expect.objectContaining({ orgId: ORG }));
  });
  it.each(['create_routing','update_routing','delete_routing','set_default','create_escalation','update_escalation','delete_escalation'])('%s rejects site/device ceilings', async action => {
    for (const ceiling of [{ allowedSiteIds: [] }, { allowedDeviceIds: [] }]) {
      expect(await call({ action, id: ID, data: {} }, auth(ceiling))).toMatchObject({ status: 403 });
    }
    expect(db.insert).not.toHaveBeenCalled(); expect(db.update).not.toHaveBeenCalled(); expect(db.delete).not.toHaveBeenCalled();
  });
  it('requires human MFA', async () => {
    vi.mocked(hasSatisfiedMfa).mockReturnValue(false);
    expect(await call({ action: 'set_default', data: { channelIds: [] } })).toMatchObject({ status: 403, error: 'MFA required' });
    expect(upsertDefaultRow).not.toHaveBeenCalled();
  });
  it('rejects invalid shape and inaccessible ownership', async () => {
    for (const input of [{ action: 'set_default' }, { action: 'resolve', severity: 'high' }, { action: 'other' }, { action: 'delete_routing', id: 'bad' }]) {
      expect(await call(input)).toMatchObject({ status: 400 });
    }
    expect(await call({ action: 'set_default', orgId: OTHER, data: { channelIds: [] } })).toMatchObject({ status: 403 });
    expect(await call({ action: 'set_default', ownerScope: 'partner', data: { channelIds: [] } },
      auth({ scope: 'partner', partnerId: OTHER, partnerOrgAccess: 'selected' }))).toMatchObject({ status: 403 });
  });
  it('writes an inbox-only default through the shared writer', async () => {
    expect(await call({ action: 'set_default', data: { channelIds: [] } })).toEqual({ data: row });
    expect(upsertDefaultRow).toHaveBeenCalledWith({ orgId: ORG, partnerId: null }, { channelIds: [], escalationPolicyId: null }, expect.anything());
  });
  it('rejects foreign channels, foreign escalation, default rename, and partner default deletion', async () => {
    channels([]);
    expect(await call({ action: 'set_default', data: { channelIds: [CH] } })).toMatchObject({ status: 400 });
    vi.mocked(escalationPolicyCompatible).mockResolvedValue(false);
    expect(await call({ action: 'set_default', data: { channelIds: [], escalationPolicyId: ID } })).toMatchObject({ status: 400 });
    expect(await call({ action: 'update_routing', id: ID, data: { name: 'changed' } })).toMatchObject({ status: 400 });
    vi.mocked(db.delete).mockReturnValue({ where: () => ({ returning: async () => [{ id: ID }] }) } as never);
    expect(await call({ action: 'delete_routing', id: ID })).toEqual({ data: { id: ID, deleted: true } });
    vi.mocked(getRoutingRuleWithAccess).mockResolvedValue({ ...row, orgId: null, partnerId: OTHER } as never);
    expect(await call({ action: 'delete_routing', id: ID }, auth({ scope: 'partner', partnerId: OTHER, partnerOrgAccess: 'all' }))).toMatchObject({ status: 409 });
  });
  it('creates routing and escalation rows with the selected owner', async () => {
    channels([CH]); const values = insertReturning(row);
    expect(await call({ action: 'create_routing', data: { name: 'High', priority: 1, conditions: { severities: ['high'] }, channelIds: [CH] } })).toEqual({ data: row });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG, partnerId: null, isDefault: false }));
    expect(await call({ action: 'create_escalation', data: { name: 'On-call', steps: [{ delayMinutes: 15, channelIds: [CH] }] } })).toEqual({ data: row });
  });
  it('lists bounded routing and policy rows', async () => {
    const limit = vi.fn(async () => [row]);
    vi.mocked(db.select).mockReturnValue({ from: () => ({ where: () => ({ orderBy: () => ({ limit }) }) }) } as never);
    expect(await call({ action: 'list_routing' })).toEqual({ data: [row] });
    expect(await call({ action: 'list_escalation' })).toEqual({ data: [row] });
    expect(limit).toHaveBeenCalledWith(100);
  });
  it('returns inherited list DTOs unchanged, without policy targets or owner metadata', async () => {
    const { partnerIdForOrg } = await import('./delivery/railOwnership');
    vi.mocked(partnerIdForOrg).mockResolvedValueOnce(OTHER).mockResolvedValueOnce(OTHER);
    const limit = vi.fn(async () => []);
    vi.mocked(db.select).mockReturnValue({ from: () => ({ where: () => ({ orderBy: () => ({ limit }) }) }) } as never);
    const inheritedRule = { id: ID, name: 'Partner route', priority: 10, enabled: true, isDefault: false,
      conditions: { severities: [], monitorKinds: [], siteIds: [] }, channelIds: [CH], escalationPolicyId: null, inherited: true as const };
    const inheritedPolicy = { id: ID, name: 'On-call', stepCount: 2, inherited: true as const };
    vi.mocked(readInheritedRails).mockResolvedValueOnce([inheritedRule]).mockResolvedValueOnce([inheritedPolicy]);
    expect(await call({ action: 'list_routing' })).toEqual({ data: [inheritedRule] });
    expect(await call({ action: 'list_escalation' })).toEqual({ data: [inheritedPolicy] });
    expect(readInheritedRails).toHaveBeenCalledWith('escalation',
      { orgId: ORG, partnerId: OTHER, allowedSiteIds: undefined }, db);
  });
  it('updates and deletes normal routing rows and escalation policies', async () => {
    vi.mocked(getRoutingRuleWithAccess).mockResolvedValue({ ...row, isDefault: false } as never);
    vi.mocked(getEscalationPolicyWithOrgCheck).mockResolvedValue({ ...row, steps: [] } as never);
    vi.mocked(db.update).mockReturnValue({ set: () => ({ where: () => ({ returning: async () => [{ id: ID }] }) }) } as never);
    vi.mocked(db.delete).mockReturnValue({ where: () => ({ returning: async () => [{ id: ID }] }) } as never);
    channels([CH]);
    expect(await call({ action: 'update_routing', id: ID, data: { name: 'Changed' } })).toEqual({ data: { id: ID } });
    expect(await call({ action: 'delete_routing', id: ID })).toEqual({ data: { id: ID, deleted: true } });
    expect(await call({ action: 'update_escalation', id: ID, data: { steps: [{ delayMinutes: 20, channelIds: [CH] }] } })).toEqual({ data: { id: ID } });
    expect(await call({ action: 'delete_escalation', id: ID })).toEqual({ data: { id: ID, deleted: true } });
  });
  it('rejects inert filters, bad delays, not-found rows, and reports safe runtime failures', async () => {
    expect(await call({ action: 'create_routing', data: { name: 'x', priority: 1, conditions: { deviceTags: ['x'] }, channelIds: [CH] } })).toMatchObject({ status: 400 });
    expect(await call({ action: 'create_escalation', data: { name: 'x', steps: [{ delayMinutes: 0, channelIds: [CH] }] } })).toMatchObject({ status: 400 });
    vi.mocked(getRoutingRuleWithAccess).mockResolvedValue(null);
    expect(await call({ action: 'delete_routing', id: ID })).toMatchObject({ status: 404 });
    vi.mocked(upsertDefaultRow).mockRejectedValue(new Error('private database text'));
    expect(await call({ action: 'set_default', data: { channelIds: [] } })).toEqual({ error: 'Delivery operation failed' });
  });
});

const USER = '40000000-0000-4000-8000-000000000001';
const step = { delayMinutes: 1, userIds: [USER] };
function updateReturning() {
  const set = vi.fn(() => ({ where: () => ({ returning: async () => [row] }) }));
  vi.mocked(db.update).mockReturnValue({ set } as never);
  vi.mocked(getEscalationPolicyWithOrgCheck).mockResolvedValue({ ...row, steps: [] } as never);
  return set;
}
function partnerMember() {
  vi.mocked(partnerIdForOrg).mockResolvedValue(OTHER);
  vi.mocked(db.execute).mockImplementation((async (query: Parameters<typeof db.execute>[0]) => {
    const sql = new PgDialect().sqlToQuery(query as never).sql;
    return sql.includes('partner_users') ? [{ id: USER, name: 'Partner member' }] : [];
  }) as unknown as typeof db.execute);
}
describe('shared escalation validation and delivery authorization', () => {
  it.each(['create_escalation', 'update_escalation'])('%s rejects newly selected partner users from org callers', async action => {
    partnerMember(); const values = insertReturning(row); const set = updateReturning();
    expect(await call({ action, id: ID, data: { name: 'Policy', steps: [step] } })).toMatchObject({ status: 400 });
    expect(values).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled();
    expect(new PgDialect().sqlToQuery(vi.mocked(db.execute).mock.calls[0]![0] as never).sql).not.toContain('partner_users');
  });
  it('preserves stored partner targets on org edits without permitting new ones', async () => {
    partnerMember(); updateReturning();
    vi.mocked(getEscalationPolicyWithOrgCheck).mockResolvedValue({ ...row, steps: [step] } as never);
    expect(await call({ action: 'update_escalation', id: ID, data: { steps: [{ ...step, delayMinutes: 5 }] } })).toEqual({ data: row });
    expect(db.execute).not.toHaveBeenCalled();
    expect(await call({ action: 'update_escalation', id: ID, data: { steps: [{ ...step, userIds: [USER, CH] }] } })).toMatchObject({ status: 400 });
  });
  it.each(['partner', 'system'] as const)('%s may select eligible partner users', async scope => {
    partnerMember(); insertReturning(row); updateReturning();
    const identity = auth({ scope, partnerId: OTHER, partnerOrgAccess: 'all' });
    for (const action of ['create_escalation', 'update_escalation']) {
      expect(await call({ action, orgId: ORG, id: ID, data: { name: 'Policy', steps: [step] } }, identity)).toEqual({ data: row });
    }
    const query = new PgDialect().sqlToQuery(vi.mocked(db.execute).mock.calls[0]![0] as never);
    expect(query.sql).toContain("u.status = 'active'");
    expect(query.sql).toContain("pu.org_access = 'selected'");
    expect(query.params).toContain(ORG);
  });
  it('allows active selected-org users in partner-wide policies', async () => {
    partnerMember(); const values = insertReturning(row);
    expect(await call({ action: 'create_escalation', ownerScope: 'partner', data: { name: 'Policy', steps: [step] } },
      auth({ scope: 'partner', partnerId: OTHER, partnerOrgAccess: 'all' }))).toEqual({ data: row });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ orgId: null, partnerId: OTHER }));
    const query = new PgDialect().sqlToQuery(vi.mocked(db.execute).mock.calls[0]![0] as never);
    expect(query.sql).toContain("u.status = 'active'");
    expect(query.sql).toContain('partner_users');
    expect(query.sql).not.toContain('pu.org_access');
  });
  it.each(['create_escalation', 'update_escalation'])('%s enforces step and occurrence bounds', async action => {
    const values = insertReturning(row); const set = updateReturning();
    const channelStep = { delayMinutes: 1, channelIds: [CH] };
    const invalid = [
      [{ ...channelStep, delayMinutes: 10081 }], [{ ...channelStep, delayMinutes: 1.5 }],
      ...[0, 1441, 1.5].map(everyMinutes => [{ ...channelStep, renotify: { everyMinutes, maxTimes: 1 } }]),
      ...[0, 11, 1.5].map(maxTimes => [{ ...channelStep, renotify: { everyMinutes: 1, maxTimes } }]),
      Array.from({ length: 11 }, () => channelStep),
      Array.from({ length: 5 }, (_, i) => ({ ...channelStep, renotify: { everyMinutes: 1, maxTimes: i === 0 ? 10 : 9 } })),
    ];
    for (const steps of invalid) expect(await call({ action, id: ID, data: { name: 'Policy', steps } })).toMatchObject({ status: 400 });
    expect(values).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled();
    channels([CH]);
    const steps = Array.from({ length: 5 }, () => ({ ...channelStep, delayMinutes: 10080, renotify: { everyMinutes: 1440, maxTimes: 9 } }));
    expect(await call({ action, id: ID, data: { name: 'Policy', steps } })).toEqual({ data: row });
  });
  it('keeps an independent escalation in an empty-channel shared preview after org-default deletion', async () => {
    vi.mocked(db.delete).mockReturnValue({ where: () => ({ returning: async () => [{ id: ID }] }) } as never);
    const preview = { channelIds: [], skippedChannelIds: [], escalationPolicyId: CH, source: 'default_row',
      display: 'Inbox only, escalates via On-call', description: { channels: [], escalationPolicy: { id: CH, name: 'On-call' }, owner: 'partner' } };
    vi.mocked(previewDelivery).mockResolvedValue(preview as never);
    expect(await call({ action: 'delete_routing', id: ID })).toEqual({ data: { id: ID, deleted: true } });
    expect(await call({ action: 'resolve', orgId: ORG, severity: 'high' })).toEqual(preview);
    expect(previewDelivery).toHaveBeenCalledWith(expect.objectContaining({ orgId: ORG }), expect.objectContaining({ scope: 'organization' }));
  });
  it('allows an agent write under its upstream guardrails without human MFA', async () => {
    vi.mocked(hasSatisfiedMfa).mockReturnValue(false);
    expect(await call({ action: 'set_default', data: { channelIds: [] } }, auth({ principal: { kind: 'ai_agent' } as AuthContext['principal'] }))).toEqual({ data: row });
    expect(hasSatisfiedMfa).not.toHaveBeenCalled();
  });
  it('does not accept ownership changes inside row data', async () => {
    vi.mocked(getRoutingRuleWithAccess).mockResolvedValue({ ...row, isDefault: false } as never);
    updateReturning();
    for (const action of ['update_routing', 'update_escalation']) {
      expect(await call({ action, id: ID, data: { orgId: OTHER } })).toMatchObject({ status: 400 });
      expect(await call({ action, id: ID, data: { ownerScope: 'partner' } })).toMatchObject({ status: 400 });
    }
    expect(db.update).not.toHaveBeenCalled();
  });
  it('denies routing site changes outside the authorized owner', async () => {
    vi.mocked(canAccessRoutingSites).mockResolvedValue(false);
    channels([CH]);
    expect(await call({ action: 'create_routing', data: { name: 'Rule', priority: 1, conditions: { siteIds: [OTHER] }, channelIds: [CH] } })).toMatchObject({ status: 403 });
    expect(db.insert).not.toHaveBeenCalled();
  });
});
