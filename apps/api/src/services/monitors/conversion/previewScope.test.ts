import { beforeEach, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../../middleware/auth';
import type { DbAccessContext } from '../../../db';
import { devices, organizations, configurationPolicies, escalationPolicies, notificationRoutingRules } from '../../../db/schema';
import type { PolicySources } from './loadSources';
import type { DbExecutor } from './legacyBaseline';
const mocks = vi.hoisted(() => ({ context: vi.fn(), policy: vi.fn(), sources: vi.fn(), devices: vi.fn(), fromAuth: vi.fn() }));
vi.mock('../../../middleware/auth', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../middleware/auth')>()), dbAccessContextFromAuth: mocks.fromAuth }));
vi.mock('../../../db', () => ({ getCurrentDbAccessContext: mocks.context }));
vi.mock('../../configurationPolicy', () => ({ getConfigPolicy: mocks.policy }));
vi.mock('./loadSources', () => ({ loadPolicySources: mocks.sources }));
vi.mock('./convert', () => ({ ConversionError: class extends Error { constructor(readonly code: string, message: string) { super(message); } } }));
vi.mock('./legacyBaseline', () => ({ resolveDeviceIdsForPolicy: mocks.devices }));
import { authorizePreview, previewFreshness, previewScopeHash, restorePreviewAuth, snapshotPreviewAccess } from './previewScope';
import { buildOrgAccessClosures, siteAccessCheck } from '../../../middleware/auth';
import { PgDialect } from 'drizzle-orm/pg-core';
const render = (condition: ReturnType<AuthContext['orgCondition']>) => condition ? new PgDialect().sqlToQuery(condition) : undefined;
const context: DbAccessContext = { scope: 'organization', orgId: 'o', accessibleOrgIds: ['o'], accessiblePartnerIds: [], currentPartnerId: 'p', userId: 'u' };
const auth: AuthContext = { principal: { kind: 'user_session' }, user: { id: 'u', email: 'u@example.com', name: 'User', isPlatformAdmin: false }, token: null, partnerId: 'p', orgId: 'o', scope: 'organization', accessibleOrgIds: ['o'], canAccessOrg: (id) => id === 'o', orgCondition: () => undefined };
const sources = (id: string): PolicySources => ({ policy: { id, name: id, orgId: 'o', partnerId: null, parentPolicyId: null }, links: { alertRule: null, monitoring: null, monitoringSettingsId: null, monitors: null }, inlineRules: [], watches: [], policyAutomations: [], standaloneAutomations: [], openAlertsBySource: new Map(), parentUnconverted: false });
beforeEach(() => { vi.clearAllMocks(); mocks.context.mockReturnValue(context); mocks.policy.mockResolvedValue(sources('policy').policy); mocks.sources.mockImplementation(async (id: string) => sources(id)); mocks.devices.mockResolvedValue(['device']); });
it('separates principals and every access ceiling, and restores access without credentials', () => {
  const full = snapshotPreviewAccess(auth);
  for (const update of [{ allowedSiteIds: [] }, { allowedDeviceIds: [] }, { allowedSiteIds: ['s'] }, { accessibleOrgIds: [] }, { principal: { kind: 'api_key' as const, apiKeyId: 'key' } }, { user: { ...auth.user, id: 'other' } }]) {
    expect(previewScopeHash(snapshotPreviewAccess({ ...auth, ...update }))).not.toBe(previewScopeHash(full));
  }
  const restored = restorePreviewAuth(snapshotPreviewAccess({ ...auth, allowedSiteIds: [] }));
  expect(restored.principal).toEqual(auth.principal);
  expect(restored.scope).toBe(auth.scope);
  expect(restored.token).toBeNull();
  expect(restored.canAccessSite!('s')).toBe(false);
  expect(restored.canAccessOrg('o')).toBe(true);
  expect(restored.canAccessOrg('other')).toBe(false);
  expect(JSON.stringify(full)).not.toContain('canAccess');
  expect(full.dbContext).not.toBe(context);
});
it('keeps its scope hash across the JSON queue boundary', () => {
  const snapshot = snapshotPreviewAccess({ ...auth, allowedSiteIds: undefined });
  expect(previewScopeHash(JSON.parse(JSON.stringify(snapshot)))).toBe(previewScopeHash(snapshot));
});
it('derives the context from the caller auth when none is ambient (self-managed route / worker)', () => {
  // The conversion entry points are self-managed precisely so their own
  // isolated transaction is the only pooled connection they hold, so there is
  // no ambient context to read — deriving it from auth must not throw (D30).
  mocks.context.mockReturnValue(undefined);
  mocks.fromAuth.mockReturnValue(context);
  expect(snapshotPreviewAccess(auth).dbContext).toEqual(context);
  expect(mocks.fromAuth).toHaveBeenCalledWith(auth);
});
it.each([{ allowedSiteIds: [] }, { allowedSiteIds: ['s'] }, { allowedDeviceIds: [] }, { allowedDeviceIds: ['d'] }])('rejects restricted scope before any policy lookup: %j', async (ceiling) => {
  await expect(authorizePreview('policy', { ...auth, ...ceiling })).rejects.toMatchObject({ code: 'partner_wide_denied' });
  expect(mocks.policy).not.toHaveBeenCalled();
});
it('rejects invisible policy and partner-wide owners outside full partner administration', async () => {
  mocks.policy.mockResolvedValueOnce(null);
  await expect(authorizePreview('policy', auth)).rejects.toMatchObject({ code: 'policy_not_found' });
  mocks.policy.mockResolvedValue({ ...sources('policy').policy, orgId: null, partnerId: 'p' });
  await expect(authorizePreview('policy', auth)).rejects.toMatchObject({ code: 'partner_wide_denied' });
  await expect(authorizePreview('policy', { ...auth, scope: 'partner', partnerOrgAccess: 'all' })).resolves.toMatchObject({ partnerId: 'p' });
});
it('fingerprints routing, escalation steps, competitor payloads and full row dates', async () => {
  const rows = new Map<unknown, unknown[]>([[devices, [{ id: 'device', orgId: 'o' }]], [organizations, [{ id: 'o', partnerId: 'p' }]], [configurationPolicies, [sources('policy').policy, sources('competitor').policy]], [escalationPolicies, [{ id: 'e', steps: [{ delay: 1 }] }]], [notificationRoutingRules, [{ id: 'r', updatedAt: new Date(0) }]]]);
  const executor = { select: () => ({ from: (table: unknown) => ({ where: () => ({ orderBy: async () => rows.get(table) ?? [] }) }) }) } as unknown as DbExecutor;
  const initial = await previewFreshness('policy', executor);
  expect(await previewFreshness('policy', executor)).toBe(initial);
  rows.set(escalationPolicies, [{ id: 'e', steps: [{ delay: 2 }] }]);
  expect(await previewFreshness('policy', executor)).not.toBe(initial);
  rows.set(escalationPolicies, [{ id: 'e', steps: [{ delay: 1 }] }]);
  rows.set(notificationRoutingRules, [{ id: 'r', updatedAt: new Date(1000) }]);
  expect(await previewFreshness('policy', executor)).not.toBe(initial);
  rows.set(notificationRoutingRules, [{ id: 'r', updatedAt: new Date(0) }]);
  mocks.sources.mockImplementation(async (id: string) => ({ ...sources(id), inlineRules: id === 'competitor' ? [{ id: 'rule', severity: 'critical' }] : [] }));
  expect(await previewFreshness('policy', executor)).not.toBe(initial);
  expect(mocks.sources).toHaveBeenCalledWith('competitor', executor);
});

// #6445 — the restored AuthContext must delegate to the auth module's single
// source of truth, not re-implement it. Compare against the canonical closures
// directly so any future divergence in either axis fails here.
// `null` is in the matrix deliberately: every other allowlist shape behaves
// identically under the old hand-rolled closure, so without it this parity
// check would pass against the very implementation it is meant to retire.
it.each([undefined, null, [], ['s'], ['s', 't']] as Array<string[] | null | undefined>)('restores the site axis exactly as siteAccessCheck: %j', (allowedSiteIds) => {
  const snapshot = snapshotPreviewAccess({ ...auth, allowedSiteIds: allowedSiteIds ?? undefined });
  const restored = restorePreviewAuth({ ...snapshot, auth: { ...snapshot.auth, allowedSiteIds: allowedSiteIds as string[] | undefined } });
  const canonicalCheck = siteAccessCheck(allowedSiteIds as string[] | undefined);
  for (const siteId of ['s', 't', 'other', null, undefined]) {
    expect(restored.canAccessSite!(siteId)).toBe(canonicalCheck(siteId));
  }
});

it.each([null, [], ['o'], ['o', 'b']] as Array<string[] | null>)('restores the org axis exactly as buildOrgAccessClosures: %j', (accessibleOrgIds) => {
  const scope = accessibleOrgIds === null ? 'system' as const : auth.scope;
  const restored = restorePreviewAuth(snapshotPreviewAccess({ ...auth, scope, accessibleOrgIds }));
  const canonicalClosures = buildOrgAccessClosures(accessibleOrgIds);
  expect(render(restored.orgCondition(devices.orgId))).toEqual(render(canonicalClosures.orgCondition(devices.orgId)));
  for (const orgId of ['o', 'b', 'other']) {
    expect(restored.canAccessOrg(orgId)).toBe(canonicalClosures.canAccessOrg(orgId));
  }
});

// The parity checks above would both pass if the canonical closures themselves
// regressed, so pin the restored context's actual behaviour to literals too.
it('emits the canonical org filter and access decision for every allowlist shape', () => {
  const restore = (accessibleOrgIds: string[] | null, scope: AuthContext['scope'] = 'organization') =>
    restorePreviewAuth(snapshotPreviewAccess({ ...auth, scope, accessibleOrgIds }));

  // System scope: no filter at all, and every org is accessible.
  const system = restore(null, 'system');
  expect(system.orgCondition(devices.orgId)).toBeUndefined();
  expect(system.canAccessOrg('any-org')).toBe(true);

  // Empty allowlist: the impossible-condition sentinel, not a bare `false`
  // literal — same deny-all effect, but the shape the request path produces.
  const empty = restore([]);
  expect(render(empty.orgCondition(devices.orgId))?.params).toEqual(['00000000-0000-0000-0000-000000000000']);
  expect(empty.canAccessOrg('o')).toBe(false);

  // Single org collapses to equality; multiple orgs use an IN list.
  expect(render(restore(['o']).orgCondition(devices.orgId))).toMatchObject({ sql: expect.stringContaining('='), params: ['o'] });
  const many = restore(['o', 'b']);
  expect(render(many.orgCondition(devices.orgId))).toMatchObject({ sql: expect.stringContaining(' in '), params: ['o', 'b'] });
  expect([many.canAccessOrg('o'), many.canAccessOrg('b'), many.canAccessOrg('other')]).toEqual([true, true, false]);
});

it('fails a null site allowlist closed, matching the request path (#6790)', () => {
  // `allowedSiteIds` is `string[] | undefined`; the JSON boundary omits an
  // undefined field, so a restored null is an invariant breach. It must deny
  // every site, exactly as the request path's `siteAccessCheck` does.
  const snapshot = snapshotPreviewAccess(auth);
  const restored = restorePreviewAuth({ ...snapshot, auth: { ...snapshot.auth, allowedSiteIds: null as unknown as undefined } });
  expect(restored.canAccessSite!('s')).toBe(false);
  expect(restored.canAccessSite!('s')).toBe(siteAccessCheck(null as unknown as undefined)('s'));
  // An omitted allowlist (the real undefined case after the JSON round trip) stays unrestricted.
  expect(restorePreviewAuth(snapshot).canAccessSite!('s')).toBe(true);
});
