// Identity write catalog (W05) tests for executeGraphWriteAction.
// Fake client: reads are keyed `path?select`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { writeActionResultSchema, type M365WriteAction } from '@breeze/shared/m365';
import { executeGraphWriteAction } from './writeActions';
import { GraphClientError, type MicrosoftGraphClient } from './graphClient';
import type { OpaqueAccessToken } from './tokenClient';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const ACCESS_TOKEN = 't' as OpaqueAccessToken;
const GROUP_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = '33333333-3333-4333-8333-333333333333';
const SKU_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SKU_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SKU_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PLAN_1 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PLAN_2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const NEW_USER_ID = '44444444-4444-4444-8444-444444444444';

type ReadMap = Record<string, unknown>;

function fake(opts: {
  reads?: ReadMap;
  collections?: Record<string, unknown>;
  post?: (input: { path: string; body: Record<string, unknown> }) => unknown;
  del?: (input: { path: string }) => unknown;
  patch?: (input: { path: string; body: Record<string, unknown> }) => unknown;
} = {}) {
  const reads: ReadMap = { [`/users/${USER_ID}?id`]: { id: USER_ID }, ...(opts.reads ?? {}) };
  const readResource = vi.fn(async (input: { path: string; select: readonly string[] }) => {
    const key = `${input.path}?${input.select.join(',')}`;
    if (!(key in reads)) throw new Error(`unexpected readResource ${key}`);
    const value = reads[key];
    if (value instanceof Error) throw value;
    return value as Record<string, unknown>;
  });
  const readCollection = vi.fn(async (input: { path: string }) => {
    const collections = opts.collections ?? {};
    if (!(input.path in collections)) throw new Error(`unexpected readCollection ${input.path}`);
    const value = collections[input.path];
    if (value instanceof Error) throw value;
    return value as { items: Record<string, unknown>[]; truncated: boolean };
  });
  const post = vi.fn(async (input: { path: string; body: Record<string, unknown> }) => {
    if (!opts.post) throw new Error('unexpected post');
    const v = opts.post(input);
    if (v instanceof Error) throw v;
    return (v ?? null) as Record<string, unknown> | null;
  });
  const del = vi.fn(async (input: { path: string }) => {
    if (!opts.del) throw new Error('unexpected del');
    const v = opts.del(input);
    if (v instanceof Error) throw v;
  });
  const patch = vi.fn(async (input: { path: string; body: Record<string, unknown> }) => {
    if (!opts.patch) throw new Error('unexpected patch');
    const v = opts.patch(input);
    if (v instanceof Error) throw v;
  });
  const graphClient = { probeTenant: vi.fn(), readResource, readCollection, post, del, patch } as unknown as MicrosoftGraphClient;
  return { graphClient, readResource, readCollection, post, del, patch };
}

const run = (action: M365WriteAction, f: ReturnType<typeof fake>) =>
  executeGraphWriteAction(action, { accessToken: ACCESS_TOKEN, graphClient: f.graphClient });

const LIC_READ = `/users/${USER_ID}?id,assignedLicenses`;
const GROUP_READ = `/groups/${GROUP_ID}?id,groupTypes,isAssignableToRole`;
const notFound = () => new GraphClientError('graph_not_found');
const rejected = () => new GraphClientError('graph_provider_rejected');

describe('m365.user.revoke_sessions', () => {
  it('resolves the user then POSTs revokeSignInSessions with an empty body', async () => {
    const f = fake({ post: () => null });
    const result = await run({ type: 'm365.user.revoke_sessions', userIdentifier: USER_ID, reason: 'x' }, f);
    expect(result).toEqual({ success: true, action: 'm365.user.revoke_sessions', userId: USER_ID });
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.post).toHaveBeenCalledWith(expect.objectContaining({ path: `/users/${USER_ID}/revokeSignInSessions`, body: {} }));
  });
});

describe('m365.user.license.remove', () => {
  const action = (skuIds: string[]): M365WriteAction => ({ type: 'm365.user.license.remove', userIdentifier: USER_ID, skuIds, reason: 'x' });

  it('pre-reads assignedLicenses and POSTs assignLicense removing the assigned requested SKUs', async () => {
    const f = fake({ reads: { [LIC_READ]: { id: USER_ID, assignedLicenses: [{ skuId: SKU_A, disabledPlans: [] }, { skuId: SKU_C, disabledPlans: [] }] } }, post: () => null });
    const result = await run(action([SKU_A, SKU_B]), f);
    expect(result).toEqual({ success: true, action: 'm365.user.license.remove', userId: USER_ID, removedSkuIds: [SKU_A], noop: false });
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.post).toHaveBeenCalledWith(expect.objectContaining({
      path: `/users/${USER_ID}/assignLicense`,
      body: { addLicenses: [], removeLicenses: [SKU_A] },
    }));
  });

  it('is a noop with zero POSTs when none of the requested SKUs is assigned', async () => {
    const f = fake({ reads: { [LIC_READ]: { id: USER_ID, assignedLicenses: [{ skuId: SKU_C }] } }, post: () => null });
    const result = await run(action([SKU_A]), f);
    expect(result).toEqual({ success: true, action: 'm365.user.license.remove', userId: USER_ID, removedSkuIds: [], noop: true });
    expect(f.post).not.toHaveBeenCalled();
  });

  it.each([
    ['assignedLicenses missing', { id: USER_ID }],
    ['assignedLicenses not an array', { id: USER_ID, assignedLicenses: 'x' }],
    ['entry not an object', { id: USER_ID, assignedLicenses: ['x'] }],
    ['skuId not a string', { id: USER_ID, assignedLicenses: [{ skuId: 5 }] }],
    ['disabledPlans not an array', { id: USER_ID, assignedLicenses: [{ skuId: SKU_A, disabledPlans: 'p' }] }],
    ['disabledPlans non-string entry', { id: USER_ID, assignedLicenses: [{ skuId: SKU_A, disabledPlans: [1] }] }],
  ])('fails closed with graph_error and no POST when %s', async (_name, payload) => {
    const f = fake({ reads: { [LIC_READ]: payload }, post: () => null });
    expect(await run(action([SKU_A]), f)).toEqual({ success: false, errorCode: 'graph_error' });
    expect(f.post).not.toHaveBeenCalled();
  });
});

describe('m365.user.license.assign', () => {
  const action = (skuIds: string[], disabledPlanIds?: string[]): M365WriteAction => ({
    type: 'm365.user.license.assign', userIdentifier: USER_ID, skuIds, ...(disabledPlanIds ? { disabledPlanIds } : {}), reason: 'x',
  });
  const sku = (skuId: string, enabled: number, consumedUnits: number) => ({ skuId, prepaidUnits: { enabled }, consumedUnits });
  const assigned = (...entries: Array<Record<string, unknown>>) => ({ [LIC_READ]: { id: USER_ID, assignedLicenses: entries } });
  const SKUS = '/subscribedSkus';

  it('POSTs addLicenses with disabledPlans (default []) when a seat is free', async () => {
    const f = fake({ reads: assigned(), collections: { [SKUS]: { items: [sku(SKU_A, 10, 3)], truncated: false } }, post: () => null });
    const result = await run(action([SKU_A]), f);
    expect(result).toEqual({ success: true, action: 'm365.user.license.assign', userId: USER_ID, assignedSkuIds: [SKU_A], noop: false });
    expect(f.post).toHaveBeenCalledWith(expect.objectContaining({
      path: `/users/${USER_ID}/assignLicense`,
      body: { addLicenses: [{ skuId: SKU_A, disabledPlans: [] }], removeLicenses: [] },
    }));
  });

  it('passes the requested disabledPlanIds through', async () => {
    const f = fake({ reads: assigned(), collections: { [SKUS]: { items: [sku(SKU_A, 10, 3)], truncated: false } }, post: () => null });
    await run(action([SKU_A], [PLAN_1]), f);
    expect(f.post.mock.calls[0]![0].body).toEqual({ addLicenses: [{ skuId: SKU_A, disabledPlans: [PLAN_1] }], removeLicenses: [] });
  });

  it('is a noop with no subscribedSkus read and no POST when the SKU is already assigned (no plan request)', async () => {
    const f = fake({ reads: assigned({ skuId: SKU_A, disabledPlans: [PLAN_2] }), post: () => null });
    const result = await run(action([SKU_A]), f);
    expect(result).toEqual({ success: true, action: 'm365.user.license.assign', userId: USER_ID, assignedSkuIds: [], noop: true });
    expect(f.readCollection).not.toHaveBeenCalled();
    expect(f.post).not.toHaveBeenCalled();
  });

  it('treats equal disabledPlans sets (any order) as satisfied', async () => {
    const f = fake({ reads: assigned({ skuId: SKU_A, disabledPlans: [PLAN_2, PLAN_1] }), post: () => null });
    const result = await run(action([SKU_A], [PLAN_1, PLAN_2]), f);
    expect(result).toMatchObject({ success: true, noop: true, assignedSkuIds: [] });
    expect(f.readCollection).not.toHaveBeenCalled();
    expect(f.post).not.toHaveBeenCalled();
  });

  it('re-posts an assigned SKU whose disabledPlans differ, WITHOUT a seat check', async () => {
    const f = fake({ reads: assigned({ skuId: SKU_A, disabledPlans: [] }), post: () => null });
    const result = await run(action([SKU_A], [PLAN_1]), f);
    expect(result).toMatchObject({ success: true, noop: false, assignedSkuIds: [SKU_A] });
    expect(f.readCollection).not.toHaveBeenCalled();
    expect(f.post.mock.calls[0]![0].body).toEqual({ addLicenses: [{ skuId: SKU_A, disabledPlans: [PLAN_1] }], removeLicenses: [] });
  });

  it('only seat-checks not-yet-assigned SKUs and only adds unsatisfied ones', async () => {
    const f = fake({ reads: assigned({ skuId: SKU_A }), collections: { [SKUS]: { items: [sku(SKU_B, 5, 1)], truncated: false } }, post: () => null });
    const result = await run(action([SKU_A, SKU_B]), f);
    expect(result).toMatchObject({ success: true, noop: false, assignedSkuIds: [SKU_B] });
    expect(f.post.mock.calls[0]![0].body).toEqual({ addLicenses: [{ skuId: SKU_B, disabledPlans: [] }], removeLicenses: [] });
  });

  it('returns license_unavailable with no POST when no seat is free', async () => {
    const f = fake({ reads: assigned(), collections: { [SKUS]: { items: [sku(SKU_A, 5, 5)], truncated: false } }, post: () => null });
    expect(await run(action([SKU_A]), f)).toEqual({ success: false, errorCode: 'license_unavailable' });
    expect(f.post).not.toHaveBeenCalled();
  });

  it('returns license_unavailable when the SKU is absent from subscribedSkus', async () => {
    const f = fake({ reads: assigned(), collections: { [SKUS]: { items: [sku(SKU_C, 5, 0)], truncated: false } }, post: () => null });
    expect(await run(action([SKU_A]), f)).toEqual({ success: false, errorCode: 'license_unavailable' });
    expect(f.post).not.toHaveBeenCalled();
  });

  it.each([
    ['skuId missing', { prepaidUnits: { enabled: 5 }, consumedUnits: 0 }],
    ['prepaidUnits missing', { skuId: SKU_A, consumedUnits: 0 }],
    ['enabled not a number', { skuId: SKU_A, prepaidUnits: { enabled: '5' }, consumedUnits: 0 }],
    ['consumedUnits not a number', { skuId: SKU_A, prepaidUnits: { enabled: 5 }, consumedUnits: null }],
  ])('fails closed (graph_error, no POST) on a malformed subscribedSkus item: %s', async (_n, item) => {
    const f = fake({ reads: assigned(), collections: { [SKUS]: { items: [item], truncated: false } }, post: () => null });
    expect(await run(action([SKU_A]), f)).toEqual({ success: false, errorCode: 'graph_error' });
    expect(f.post).not.toHaveBeenCalled();
  });

  it('fails closed on a truncated subscribedSkus collection', async () => {
    const f = fake({ reads: assigned(), collections: { [SKUS]: { items: [sku(SKU_A, 5, 0)], truncated: true } }, post: () => null });
    expect(await run(action([SKU_A]), f)).toEqual({ success: false, errorCode: 'graph_error' });
    expect(f.post).not.toHaveBeenCalled();
  });

  it('fails closed on a malformed user assignedLicenses payload before any seat read', async () => {
    const f = fake({ reads: { [LIC_READ]: { id: USER_ID, assignedLicenses: [{ skuId: 1 }] } }, post: () => null });
    expect(await run(action([SKU_A]), f)).toEqual({ success: false, errorCode: 'graph_error' });
    expect(f.readCollection).not.toHaveBeenCalled();
    expect(f.post).not.toHaveBeenCalled();
  });
});

describe('group membership arms', () => {
  const remove: M365WriteAction = { type: 'm365.group.membership.remove', groupId: GROUP_ID, userIdentifier: USER_ID, reason: 'x' };
  const add: M365WriteAction = { type: 'm365.group.membership.add', groupId: GROUP_ID, userIdentifier: USER_ID, reason: 'x' };
  const okGroup = { id: GROUP_ID, groupTypes: ['Unified'], isAssignableToRole: false };
  const MEMBERS = `/groups/${GROUP_ID}/members`;
  const REF = `/groups/${GROUP_ID}/members/${USER_ID}/$ref`;

  it.each([
    ['dynamic membership', { id: GROUP_ID, groupTypes: ['Unified', 'DynamicMembership'], isAssignableToRole: false }, 'unsupported_group_type'],
    ['role-assignable', { id: GROUP_ID, groupTypes: [], isAssignableToRole: true }, 'unsupported_group_type'],
    ['groupTypes missing', { id: GROUP_ID }, 'graph_error'],
    ['groupTypes not strings', { id: GROUP_ID, groupTypes: [1] }, 'graph_error'],
    ['pre-read permission missing', new GraphClientError('graph_permission_missing'), 'graph_permission_missing'],
    ['pre-read not found', notFound(), 'graph_error'],
  ])('refuses both arms with zero membership calls: %s', async (_n, groupRead, code) => {
    for (const a of [remove, add]) {
      const f = fake({ reads: { [GROUP_READ]: groupRead }, post: () => null, del: () => undefined, collections: { [MEMBERS]: { items: [], truncated: false } } });
      expect(await run(a, f)).toEqual({ success: false, errorCode: code });
      expect(f.post).not.toHaveBeenCalled();
      expect(f.del).not.toHaveBeenCalled();
      expect(f.readCollection).not.toHaveBeenCalled();
    }
  });

  it('remove DELETEs the $ref directly with no membership pre-read', async () => {
    const f = fake({ reads: { [GROUP_READ]: okGroup }, del: () => undefined });
    const result = await run(remove, f);
    expect(result).toEqual({ success: true, action: 'm365.group.membership.remove', userId: USER_ID, groupId: GROUP_ID, noop: false });
    expect(f.del).toHaveBeenCalledTimes(1);
    expect(f.del).toHaveBeenCalledWith(expect.objectContaining({ path: REF }));
    expect(f.readCollection).not.toHaveBeenCalled();
  });

  it('remove treats a DELETE 404 as noop success', async () => {
    const f = fake({ reads: { [GROUP_READ]: okGroup }, del: () => notFound() });
    expect(await run(remove, f)).toEqual({ success: true, action: 'm365.group.membership.remove', userId: USER_ID, groupId: GROUP_ID, noop: true });
  });

  it('remove maps other DELETE failures normally', async () => {
    const f = fake({ reads: { [GROUP_READ]: okGroup }, del: () => new GraphClientError('graph_throttled', 9) });
    expect(await run(remove, f)).toEqual({ success: false, errorCode: 'graph_throttled', retryAfterSeconds: 9 });
  });

  it('add POSTs the directoryObjects $ref with no membership pre-read', async () => {
    const f = fake({ reads: { [GROUP_READ]: okGroup }, post: () => null });
    const result = await run(add, f);
    expect(result).toEqual({ success: true, action: 'm365.group.membership.add', userId: USER_ID, groupId: GROUP_ID, noop: false });
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.post).toHaveBeenCalledWith(expect.objectContaining({
      path: `${MEMBERS}/$ref`,
      body: { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${USER_ID}` },
    }));
    expect(f.readCollection).not.toHaveBeenCalled();
  });

  it('add disambiguates a provider_rejected POST with a bounded eventual-consistency member read: present => noop', async () => {
    const f = fake({ reads: { [GROUP_READ]: okGroup }, post: () => rejected(), collections: { [MEMBERS]: { items: [{ id: USER_ID }], truncated: false } } });
    expect(await run(add, f)).toEqual({ success: true, action: 'm365.group.membership.add', userId: USER_ID, groupId: GROUP_ID, noop: true });
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.readCollection).toHaveBeenCalledWith(expect.objectContaining({
      path: MEMBERS,
      query: { '$select': 'id', '$filter': `id eq '${USER_ID}'`, '$count': 'true' },
      consistencyLevelEventual: true,
      maxItems: 1,
      maxPages: 1,
    }));
  });

  it.each([
    ['member absent', { items: [], truncated: false }],
    ['member id mismatch', { items: [{ id: GROUP_ID }], truncated: false }],
    ['malformed item', { items: [{}], truncated: false }],
    ['the read itself fails', new GraphClientError('graph_transport_failed')],
  ])('add returns graph_error when the disambiguation read says: %s', async (_n, coll) => {
    const f = fake({ reads: { [GROUP_READ]: okGroup }, post: () => rejected(), collections: { [MEMBERS]: coll } });
    expect(await run(add, f)).toEqual({ success: false, errorCode: 'graph_error' });
  });

  it('add keeps a retryable cause when the disambiguation read is throttled (not a flat graph_error)', async () => {
    const f = fake({ reads: { [GROUP_READ]: okGroup }, post: () => rejected(), collections: { [MEMBERS]: new GraphClientError('graph_throttled', 9) } });
    expect(await run(add, f)).toEqual({ success: false, errorCode: 'graph_throttled', retryAfterSeconds: 9 });
  });

  it('add never swallows a programming error in the disambiguation read', async () => {
    const f = fake({ reads: { [GROUP_READ]: okGroup }, post: () => rejected(), collections: { [MEMBERS]: new TypeError('boom') } });
    await expect(run(add, f)).rejects.toThrow('boom');
  });

  it('add maps non-rejected POST failures normally and does not disambiguate', async () => {
    const f = fake({ reads: { [GROUP_READ]: okGroup }, post: () => new GraphClientError('graph_throttled', 12) });
    expect(await run(add, f)).toEqual({ success: false, errorCode: 'graph_throttled', retryAfterSeconds: 12 });
    expect(f.readCollection).not.toHaveBeenCalled();
  });
});

describe('m365.intune.device.retire', () => {
  const retire: M365WriteAction = { type: 'm365.intune.device.retire', managedDeviceId: DEVICE_ID, reason: 'x' };

  it('POSTs the retire action with an empty body', async () => {
    const f = fake({ post: () => null });
    expect(await run(retire, f)).toEqual({ success: true, action: 'm365.intune.device.retire', managedDeviceId: DEVICE_ID });
    expect(f.post).toHaveBeenCalledWith(expect.objectContaining({ path: `/deviceManagement/managedDevices/${DEVICE_ID}/retire`, body: {} }));
  });

  it('maps a 404 to device_not_found, not user_not_found', async () => {
    const f = fake({ post: () => notFound() });
    expect(await run(retire, f)).toEqual({ success: false, errorCode: 'device_not_found' });
  });

  it('has no wipe path anywhere in the source', () => {
    const source = readFileSync(fileURLToPath(new URL('./writeActions.ts', import.meta.url)), 'utf8');
    expect(source.includes('/wipe')).toBe(false);
  });
});

describe('m365.user.create', () => {
  const create: M365WriteAction = {
    type: 'm365.user.create', userPrincipalName: 'new.user@contoso.com', displayName: 'New User',
    mailNickname: 'new.user', usageLocation: 'US', reason: 'x',
  };
  const UPN_READ = `/users/${encodeURIComponent('new.user@contoso.com')}?id`;

  it('does exactly one POST /users with the full body and returns the temporary password', async () => {
    const f = fake({ post: () => ({ id: NEW_USER_ID }) });
    const result = await run(create, f);
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.readResource).not.toHaveBeenCalled();
    const call = f.post.mock.calls[0]![0];
    expect(call.path).toBe('/users');
    const pw = (call.body.passwordProfile as { password: string }).password;
    expect(call.body).toEqual({
      accountEnabled: true,
      displayName: 'New User',
      mailNickname: 'new.user',
      userPrincipalName: 'new.user@contoso.com',
      usageLocation: 'US',
      passwordProfile: { forceChangePasswordNextSignIn: true, password: pw },
    });
    expect(pw).toHaveLength(20);
    expect(result).toEqual({
      success: true, action: 'm365.user.create', userId: NEW_USER_ID,
      userPrincipalName: 'new.user@contoso.com', temporaryPassword: pw, forceChangeNextSignIn: true,
    });
    expect(writeActionResultSchema.safeParse(result).success).toBe(true);
  });

  it.each([['no body', null], ['no id', {}], ['non-string id', { id: 7 }], ['empty id', { id: '' }]])(
    'returns graph_error when the 201 body has %s',
    async (_n, body) => {
      const f = fake({ post: () => body });
      expect(await run(create, f)).toEqual({ success: false, errorCode: 'graph_error' });
      expect(f.post).toHaveBeenCalledTimes(1);
    },
  );

  it('on provider_rejected with an existing user => user_already_exists (one POST, never retried)', async () => {
    const f = fake({ post: () => rejected(), reads: { [UPN_READ]: { id: NEW_USER_ID } } });
    expect(await run(create, f)).toEqual({ success: false, errorCode: 'user_already_exists' });
    expect(f.post).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['not found', notFound()],
    ['read fails', new GraphClientError('graph_transport_failed')],
    ['malformed read', { nope: true }],
  ])('on provider_rejected where the follow-up read is %s => graph_error', async (_n, read) => {
    const f = fake({ post: () => rejected(), reads: { [UPN_READ]: read } });
    expect(await run(create, f)).toEqual({ success: false, errorCode: 'graph_error' });
    expect(f.post).toHaveBeenCalledTimes(1);
  });

  it('never swallows a programming error in the follow-up read', async () => {
    const f = fake({ post: () => rejected(), reads: { [UPN_READ]: new TypeError('boom') } });
    await expect(run(create, f)).rejects.toThrow('boom');
    expect(f.post).toHaveBeenCalledTimes(1);
  });

  it('maps throttling normally with no follow-up read', async () => {
    const f = fake({ post: () => new GraphClientError('graph_throttled', 30) });
    expect(await run(create, f)).toEqual({ success: false, errorCode: 'graph_throttled', retryAfterSeconds: 30 });
    expect(f.readResource).not.toHaveBeenCalled();
    expect(f.post).toHaveBeenCalledTimes(1);
  });
});

describe('m365.user.mailbox.auto_reply', () => {
  it('PATCHes mailboxSettings with UTC instants and omits absent optional keys', async () => {
    const f = fake({ patch: () => undefined });
    const result = await run({
      type: 'm365.user.mailbox.auto_reply', userIdentifier: USER_ID, status: 'scheduled',
      internalReplyMessage: 'Away', externalAudience: 'all',
      scheduledStartDateTime: '2026-10-01T00:00:00Z', scheduledEndDateTime: '2026-10-08T00:00:00Z', reason: 'x',
    }, f);
    expect(result).toEqual({ success: true, action: 'm365.user.mailbox.auto_reply', userId: USER_ID, status: 'scheduled' });
    expect(f.patch).toHaveBeenCalledWith(expect.objectContaining({
      path: `/users/${USER_ID}/mailboxSettings`,
      body: { automaticRepliesSetting: {
        status: 'scheduled', externalAudience: 'all', internalReplyMessage: 'Away',
        scheduledStartDateTime: { dateTime: '2026-10-01T00:00:00', timeZone: 'UTC' },
        scheduledEndDateTime: { dateTime: '2026-10-08T00:00:00', timeZone: 'UTC' },
      } },
    }));
    const setting = f.patch.mock.calls[0]![0].body.automaticRepliesSetting as Record<string, unknown>;
    expect('externalReplyMessage' in setting).toBe(false);
  });

  it('sends only status when nothing else is given', async () => {
    const f = fake({ patch: () => undefined });
    await run({ type: 'm365.user.mailbox.auto_reply', userIdentifier: USER_ID, status: 'disabled', reason: 'x' }, f);
    expect(f.patch.mock.calls[0]![0].body).toEqual({ automaticRepliesSetting: { status: 'disabled' } });
  });
});

describe('m365.user.mailbox.auto_reply.state (probe)', () => {
  const probe: M365WriteAction = { type: 'm365.user.mailbox.auto_reply.state', userIdentifier: USER_ID };
  const READ = `/users/${USER_ID}/mailboxSettings?automaticRepliesSetting`;
  const BODY = 'CONFIDENTIAL <b>quoted customer mail</b>';
  const setting = (over: Record<string, unknown> = {}) => ({
    automaticRepliesSetting: {
      status: 'scheduled', externalAudience: 'contactsOnly',
      internalReplyMessage: BODY, externalReplyMessage: '',
      scheduledStartDateTime: { dateTime: '2026-10-01T00:00:00.0000000', timeZone: 'UTC' },
      scheduledEndDateTime: { dateTime: '2026-10-08T12:30:00.0000000', timeZone: 'UTC' },
      ...over,
    },
  });

  it('projects the state without any message body and with valid ISO instants', async () => {
    const f = fake({ reads: { [READ]: setting() } });
    const result = await run(probe, f);
    expect(result).toEqual({
      success: true, action: 'm365.user.mailbox.auto_reply.state', userId: USER_ID,
      status: 'scheduled', externalAudience: 'contactsOnly',
      hasInternalReplyMessage: true, hasExternalReplyMessage: false,
      scheduledStartDateTime: '2026-10-01T00:00:00.000Z', scheduledEndDateTime: '2026-10-08T12:30:00.000Z',
    });
    expect(JSON.stringify(result).includes(BODY)).toBe(false);
    expect(writeActionResultSchema.safeParse(result).success).toBe(true);
  });

  it('returns null instants when no schedule is present', async () => {
    const f = fake({ reads: { [READ]: setting({ status: 'disabled', scheduledStartDateTime: undefined, scheduledEndDateTime: undefined }) } });
    expect(await run(probe, f)).toMatchObject({ success: true, scheduledStartDateTime: null, scheduledEndDateTime: null });
  });

  it.each([
    ['unknown status', setting({ status: 'weird' })],
    ['absent status', setting({ status: undefined })],
    ['unknown audience', setting({ externalAudience: 'everyone' })],
    ['absent audience', setting({ externalAudience: undefined })],
    ['absent setting', {}],
    ['non-UTC schedule', setting({ scheduledStartDateTime: { dateTime: '2026-10-01T00:00:00.0000000', timeZone: 'Pacific Standard Time' } })],
    ['unparseable instant', setting({ scheduledEndDateTime: { dateTime: 'garbage', timeZone: 'UTC' } })],
  ])('returns graph_error on %s', async (_n, payload) => {
    const f = fake({ reads: { [READ]: payload } });
    expect(await run(probe, f)).toEqual({ success: false, errorCode: 'graph_error' });
  });
});

describe('every arm maps graph_throttled with retryAfterSeconds', () => {
  const arms: M365WriteAction[] = [
    { type: 'm365.user.disable', userIdentifier: USER_ID, reason: 'x' },
    { type: 'm365.user.reset_password', userIdentifier: USER_ID, reason: 'x' },
    { type: 'm365.user.revoke_sessions', userIdentifier: USER_ID, reason: 'x' },
    { type: 'm365.user.license.remove', userIdentifier: USER_ID, skuIds: [SKU_A], reason: 'x' },
    { type: 'm365.user.license.assign', userIdentifier: USER_ID, skuIds: [SKU_A], reason: 'x' },
    { type: 'm365.group.membership.remove', groupId: GROUP_ID, userIdentifier: USER_ID, reason: 'x' },
    { type: 'm365.group.membership.add', groupId: GROUP_ID, userIdentifier: USER_ID, reason: 'x' },
    { type: 'm365.intune.device.retire', managedDeviceId: DEVICE_ID, reason: 'x' },
    { type: 'm365.user.create', userPrincipalName: 'a@b.com', displayName: 'A', mailNickname: 'a', usageLocation: 'US', reason: 'x' },
    { type: 'm365.user.mailbox.auto_reply', userIdentifier: USER_ID, status: 'disabled', reason: 'x' },
    { type: 'm365.user.mailbox.auto_reply.state', userIdentifier: USER_ID },
  ];
  it.each(arms.map((a) => [a.type, a] as const))('%s', async (_type, action) => {
    const throttled = () => new GraphClientError('graph_throttled', 42);
    const graphClient = {
      readResource: vi.fn(async () => { throw throttled(); }),
      readCollection: vi.fn(async () => { throw throttled(); }),
      post: vi.fn(async () => { throw throttled(); }),
      del: vi.fn(async () => { throw throttled(); }),
      patch: vi.fn(async () => { throw throttled(); }),
    } as unknown as MicrosoftGraphClient;
    expect(await executeGraphWriteAction(action, { accessToken: ACCESS_TOKEN, graphClient }))
      .toEqual({ success: false, errorCode: 'graph_throttled', retryAfterSeconds: 42 });
  });
});
