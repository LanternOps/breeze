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
it.each([undefined, [], ['s'], ['s', 't']] as Array<string[] | undefined>)('restores the site axis exactly as siteAccessCheck: %j', (allowedSiteIds) => {
  const restored = restorePreviewAuth(snapshotPreviewAccess({ ...auth, allowedSiteIds }));
  const canonicalCheck = siteAccessCheck(allowedSiteIds);
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

it('denies every row for an empty org allowlist instead of emitting an unbounded IN ()', () => {
  const restored = restorePreviewAuth(snapshotPreviewAccess({ ...auth, accessibleOrgIds: [] }));
  const query = render(restored.orgCondition(devices.orgId));
  expect(query?.params).toEqual(['00000000-0000-0000-0000-000000000000']);
  expect(restored.canAccessOrg('o')).toBe(false);
});

it('treats a null site allowlist as unrestricted, matching the request path', () => {
  // A restored snapshot whose allowedSiteIds arrived as null (not undefined)
  // must stay allow-all rather than flipping to deny-all.
  const snapshot = snapshotPreviewAccess(auth);
  const restored = restorePreviewAuth({ ...snapshot, auth: { ...snapshot.auth, allowedSiteIds: null as unknown as undefined } });
  expect(restored.canAccessSite!('s')).toBe(true);
});
