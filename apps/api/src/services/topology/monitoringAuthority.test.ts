import { describe, expect, it, vi } from 'vitest';
import type { TopologyPolicyDefinition } from '@breeze/shared';

const order = vi.hoisted(() => [] as string[]);
vi.mock('../../db', () => ({
  db: {},
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: async (fn: () => unknown) => { order.push('system:enter'); try { return await fn(); } finally { order.push('system:exit'); } },
}));
const siteAccess = vi.fn();
vi.mock('./access', async () => {
  const actual = await vi.importActual<typeof import('./access')>('./access');
  return { ...actual, requireTopologySiteAccess: (...args: unknown[]) => siteAccess(...args) };
});
const flags = vi.fn();
const resolvedFlags = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('./flags', () => ({
  loadTopologyFlags: (...args: unknown[]) => flags(...args),
  withResolvedTopologyFlags: async (resolved: unknown, fn: () => Promise<unknown>) => {
    const previous = resolvedFlags.current;
    resolvedFlags.current = resolved;
    try { return await fn(); } finally { resolvedFlags.current = previous; }
  },
}));

import { TopologyError } from './access';
import {
  freezeTopologyArmAuthority,
  topologyPolicyEffectDigest,
  topologyPolicyMaterialDigest,
  withTopologyArmAuthority,
} from './monitoringAuthority';
import { TopologyOperationError } from './operationErrors';

const orgId = '11111111-1111-4111-8111-111111111111';
const siteId = '22222222-2222-4222-8222-222222222222';
const otherOrg = '33333333-3333-4333-8333-333333333333';
const userId = '44444444-4444-4444-8444-444444444444';

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    scope: { orgId, siteId },
    permissions: {} as never,
    auth: {
      user: { id: userId, email: 'tech@example.com', name: 'Tech', isPlatformAdmin: false },
      principal: { kind: 'user_session' },
      token: { mfa: true, aep: 3, mep: 5 },
      scope: 'partner',
      orgId: null,
      partnerId: '55555555-5555-4555-8555-555555555555',
      accessibleOrgIds: [orgId, otherOrg],
      partnerOrgAccess: 'all',
      ...overrides,
    } as never,
  };
}

describe('freezeTopologyArmAuthority', () => {
  it('narrows the org ceiling to the armed org and carries the permission witness', async () => {
    const record = await freezeTopologyArmAuthority(ctx(), { permissionVersion: async () => '[1,2]' });
    expect(record.actor.accessibleOrgIds).toEqual([orgId]);
    expect(record.actor.allowedSiteIds).toBeUndefined();
    expect(record.actor.authEpoch).toBe(3);
    expect(record.actor.mfaEpoch).toBe(5);
    expect(record.permissionVersion).toBe('[1,2]');
  });

  it('narrows a site-restricted actor to the armed site', async () => {
    const record = await freezeTopologyArmAuthority(ctx({ scope: 'organization', orgId, accessibleOrgIds: [orgId], allowedSiteIds: [siteId, otherOrg] }), { permissionVersion: async () => 'v' });
    expect(record.actor.allowedSiteIds).toEqual([siteId]);
  });

  it.each([
    ['an API key', { principal: { kind: 'api_key' } }],
    ['an AI agent', { principal: { kind: 'ai_agent', agentId: 'a', runId: 'r' } }],
    ['an unsatisfied second factor', { token: { mfa: false, aep: 3, mep: 5 } }],
  ])('refuses %s', async (_label, overrides) => {
    await expect(freezeTopologyArmAuthority(ctx(overrides), { permissionVersion: async () => 'v' })).rejects.toBeInstanceOf(TopologyOperationError);
  });

  it('treats a missing permission version as unavailability, never a pass', async () => {
    await expect(freezeTopologyArmAuthority(ctx(), { permissionVersion: async () => null })).rejects.toMatchObject({ status: 503 });
  });
});

describe('withTopologyArmAuthority', () => {
  const record = async () => freezeTopologyArmAuthority(ctx(), { permissionVersion: async () => 'v' });
  const live = { auth: { user: { id: userId } }, permissions: {}, version: 'v2' } as never;
  const deps = (currentAuthority: () => Promise<unknown>) => ({ currentAuthority: currentAuthority as never, withContext: ((_a: unknown, fn: () => unknown) => fn()) as never });

  it('rejects a malformed stored record', async () => {
    const result = await withTopologyArmAuthority({ version: 2 }, { orgId, siteId }, ['diagnostics'], async () => 1, deps(async () => live));
    expect(result).toEqual({ ok: false, reason: 'authority_unavailable' });
  });

  it('refuses to act for another tenant than the one it was armed for', async () => {
    const result = await withTopologyArmAuthority(await record(), { orgId: otherOrg, siteId }, ['diagnostics'], async () => 1, deps(async () => live));
    expect(result).toEqual({ ok: false, reason: 'scope_changed' });
  });

  it('maps a changed actor to permission_changed and an unavailable one to authority_unavailable', async () => {
    const changed = await withTopologyArmAuthority(await record(), { orgId, siteId }, ['diagnostics'], async () => 1,
      deps(async () => { throw new TopologyOperationError('permission_changed', 403); }));
    expect(changed).toEqual({ ok: false, reason: 'permission_changed' });
    const unavailable = await withTopologyArmAuthority(await record(), { orgId, siteId }, ['diagnostics'], async () => 1,
      deps(async () => { throw new TopologyOperationError('topology_authority_unavailable', 503); }));
    expect(unavailable).toEqual({ ok: false, reason: 'authority_unavailable' });
  });

  it('re-derives live site access (a version change alone is not a denial)', async () => {
    siteAccess.mockReset();
    siteAccess.mockRejectedValueOnce(new TopologyError('topology_site_not_found', 404, 'x'));
    const revoked = await withTopologyArmAuthority(await record(), { orgId, siteId }, ['diagnostics'], async () => 1, deps(async () => live));
    expect(revoked).toEqual({ ok: false, reason: 'site_access_revoked' });

    siteAccess.mockResolvedValue({ scope: { orgId, siteId } });
    flags.mockResolvedValue({ materialization: true, diagnostics: false, interfaceHealth: true });
    expect(await withTopologyArmAuthority(await record(), { orgId, siteId }, ['diagnostics'], async () => 1, deps(async () => live)))
      .toEqual({ ok: false, reason: 'diagnostics_disabled' });
    expect(await withTopologyArmAuthority(await record(), { orgId, siteId }, ['interfaceHealth'], async () => 7, deps(async () => live)))
      .toEqual({ ok: true, value: 7 });
    expect(siteAccess).toHaveBeenCalledWith(expect.anything(), expect.anything(), siteId, 'configure');
    expect(siteAccess).toHaveBeenCalledWith(expect.anything(), expect.anything(), siteId, 'execute');
  });
});

describe('withTopologyArmAuthority — no nested pooled connection (T4, #6671 shape)', () => {
  it('resolves flags in a short system context BEFORE the actor context opens, serves them inside, and hands fn the live permission witness', async () => {
    const record = await freezeTopologyArmAuthority(ctx(), { permissionVersion: async () => 'v' });
    const live = { auth: { user: { id: userId } }, permissions: {}, version: '[7,9]' } as never;
    siteAccess.mockReset();
    siteAccess.mockResolvedValue({ scope: { orgId, siteId } });
    flags.mockReset();
    flags.mockImplementation(async () => { order.push('flags:loaded'); return { materialization: true, diagnostics: true, interfaceHealth: true }; });
    order.length = 0;
    let seen: unknown = null;
    let witness: unknown = null;
    const result = await withTopologyArmAuthority(record, { orgId, siteId }, ['diagnostics'], async (_ctx, authority) => {
      order.push('fn');
      seen = resolvedFlags.current;
      witness = authority;
      return 1;
    }, {
      currentAuthority: (async () => live) as never,
      withContext: (async (_a: unknown, fn: () => Promise<unknown>) => { order.push('actor:open'); try { return await fn(); } finally { order.push('actor:close'); } }) as never,
    });
    expect(result).toEqual({ ok: true, value: 1 });
    const loaded = order.indexOf('flags:loaded');
    expect(loaded).toBeGreaterThan(-1);
    expect(order.lastIndexOf('system:enter', loaded)).toBeGreaterThan(-1);
    expect(order.indexOf('system:exit', loaded)).toBeLessThan(order.indexOf('actor:open'));
    expect(order.filter((e) => e === 'flags:loaded')).toHaveLength(1);
    expect(seen).toEqual({ orgId, flags: { materialization: true, diagnostics: true, interfaceHealth: true } });
    expect(witness).toEqual({ permissionVersion: '[7,9]' });
  });
});

describe('policy digests', () => {
  const definition: TopologyPolicyDefinition = {
    kind: 'policy', enabled: true, recipeId: 'internet_basic', recipeVersion: 1, subject: 'configured_target', targetKeys: ['a', 'b'],
    families: ['ipv4', 'ipv6'], origin: 'eligible_collector', intervalSeconds: 300, jitterPercent: 10, alertsEnabled: true,
    failureThreshold: 3, recoveryThreshold: 2,
  };
  const targets = [
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', revision: '2', purpose: 'configured_target', position: 0 },
    { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', revision: '1', purpose: 'configured_target', position: 1 },
  ];
  const contexts = [{ contextKey: 'default', family: 'ipv4' as const, originDeviceId: userId, originNodeId: userId, sourceId: userId, interfaceId: null, interfaceEpoch: null }];
  const base = { scope: { orgId, siteId }, policyId: userId, definition, targets, contexts, authority: { userId, authEpoch: 1, mfaEpoch: 1, permissionVersion: 'v' } };

  it('is order-independent and changes with any executable effect', () => {
    const digest = topologyPolicyEffectDigest(base);
    expect(topologyPolicyEffectDigest({ ...base, targets: [...targets].reverse(), definition: { ...definition, families: ['ipv6', 'ipv4'] } })).toBe(digest);
    expect(topologyPolicyEffectDigest({ ...base, definition: { ...definition, intervalSeconds: 600 } })).not.toBe(digest);
    expect(topologyPolicyEffectDigest({ ...base, definition: { ...definition, failureThreshold: 4 } })).not.toBe(digest);
    expect(topologyPolicyEffectDigest({ ...base, targets: [{ ...targets[0]!, revision: '3' }, targets[1]!] })).not.toBe(digest);
    expect(topologyPolicyEffectDigest({ ...base, contexts: [{ ...contexts[0]!, family: 'ipv6' }] })).not.toBe(digest);
    expect(topologyPolicyEffectDigest({ ...base, authority: { ...base.authority, mfaEpoch: 2 } })).not.toBe(digest);
  });

  it('material digest ignores the activation intent but not configuration', () => {
    const material = topologyPolicyMaterialDigest({ definition, targets });
    expect(topologyPolicyMaterialDigest({ definition: { ...definition, enabled: false }, targets })).toBe(material);
    expect(topologyPolicyMaterialDigest({ definition: { ...definition, recoveryThreshold: 5 }, targets })).not.toBe(material);
    expect(topologyPolicyMaterialDigest({ definition, targets: targets.slice(0, 1) })).not.toBe(material);
  });
});
