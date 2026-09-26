import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ db: {} }));
const env = vi.hoisted(() => ({ disabled: false }));
vi.mock('../../config/env', () => ({ topologyGloballyDisabled: () => env.disabled }));

import { organizations, partners, topologyCollectionSources, users } from '../../db/schema';
import {
  freezeTopologyTraceRequester,
  revalidateTopologyTraceAuthority,
  type TopologyTraceRequesterAuthority,
} from './diagnosticTraceAuthority';

const ids = {
  org: '60000000-0000-4000-8000-000000000001',
  site: '60000000-0000-4000-8000-000000000002',
  user: '60000000-0000-4000-8000-000000000003',
  partner: '60000000-0000-4000-8000-000000000004',
  device: '60000000-0000-4000-8000-000000000005',
};

/** Table-keyed fake of `reader.select().from(t).where().limit()`. */
function fakeReader(rows: Map<unknown, unknown[]>) {
  return {
    select() {
      let table: unknown;
      const chain: Record<string, unknown> = {
        from(t: unknown) { table = t; return chain; },
        where() { return chain; },
        limit() { return chain; },
        then(ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) {
          return Promise.resolve(rows.get(table) ?? []).then(ok, fail);
        },
      };
      return chain;
    },
  } as never;
}

const authority: TopologyTraceRequesterAuthority = {
  version: 1, userId: ids.user, authEpoch: 3, mfaEpoch: 5, permissionVersion: '[1,2]', orgId: ids.org, partnerId: ids.partner,
};

function envelope(capabilities: Array<{ name: string; version: number; supported: boolean }>) {
  return { capabilities };
}

let rows: Map<unknown, unknown[]>;
beforeEach(() => {
  env.disabled = false;
  rows = new Map<unknown, unknown[]>([
    [users, [{ id: ids.user, status: 'active', authEpoch: 3, mfaEpoch: 5, orgId: ids.org, partnerId: ids.partner }]],
    [organizations, [{ partnerId: ids.partner, settings: { topologyFeatureFlags: { materialization: true, diagnostics: true } } }]],
    [partners, [{ settings: {} }]],
    [topologyCollectionSources, [{ currentBaseline: envelope([{ name: 'network_trace', version: 1, supported: true }]) }]],
  ]);
});

const run = () => ({
  orgId: ids.org, siteId: ids.site, requesterId: ids.user, requesterAuthority: authority,
  originSnapshot: { deviceId: ids.device, producerEpoch: 'epoch-1' },
});
const revalidate = (overrides: Partial<Parameters<typeof revalidateTopologyTraceAuthority>[0]> = {}) =>
  revalidateTopologyTraceAuthority({
    reader: fakeReader(rows),
    run: run(),
    permissionVersion: async () => '[1,2]',
    trustAllowed: async () => true,
    ...overrides,
  });

describe('revalidateTopologyTraceAuthority (M3-D13, trace path)', () => {
  it('allows an unchanged requester, permission set, flag state and capability', async () => {
    expect(await revalidate()).toBeNull();
  });

  it('fences a run with no frozen authority', async () => {
    expect(await revalidate({ run: { ...run(), requesterAuthority: null } })).toBe('authority_unavailable');
  });

  it.each([
    ['signed out everywhere (auth epoch)', { authEpoch: 4 }],
    ['MFA reset (mfa epoch)', { mfaEpoch: 6 }],
    ['deactivated', { status: 'disabled' }],
    ['moved to another org', { orgId: '60000000-0000-4000-8000-0000000000ff' }],
  ])('fences a requester who was %s', async (_name, patch) => {
    rows.set(users, [{ ...rows.get(users)![0] as object, ...patch }]);
    expect(await revalidate()).toBe('requester_changed');
  });

  it('fences a requester whose row is no longer visible', async () => {
    rows.set(users, []);
    expect(await revalidate()).toBe('requester_changed');
  });

  it('fences a permission change and fails closed when the version is unknowable', async () => {
    expect(await revalidate({ permissionVersion: async () => '[1,3]' })).toBe('permission_changed');
    expect(await revalidate({ permissionVersion: async () => null })).toBe('authority_unavailable');
  });

  it('fences diagnostics disabled at the org, at the partner, or globally', async () => {
    rows.set(organizations, [{ partnerId: ids.partner, settings: { topologyFeatureFlags: { materialization: true, diagnostics: false } } }]);
    expect(await revalidate()).toBe('diagnostics_disabled');
    rows.set(organizations, [{ partnerId: ids.partner, settings: {} }]);
    rows.set(partners, [{ settings: { topologyFeatureFlags: { materialization: true, diagnostics: false } } }]);
    expect(await revalidate()).toBe('diagnostics_disabled');
    rows.set(partners, [{ settings: { topologyFeatureFlags: { materialization: true, diagnostics: true } } }]);
    expect(await revalidate()).toBeNull();
    env.disabled = true;
    expect(await revalidate()).toBe('diagnostics_disabled');
  });

  it('defers a partner-level flag it cannot see to the fences that can, but never an org-level disable', async () => {
    rows.set(partners, []);
    rows.set(organizations, [{ partnerId: ids.partner, settings: {} }]);
    expect(await revalidate()).toBeNull();
    rows.set(organizations, [{ partnerId: ids.partner, settings: { topologyFeatureFlags: { diagnostics: false } } }]);
    expect(await revalidate()).toBe('diagnostics_disabled');
    // A fence that must see the partner (enqueue, result publication) fails closed.
    rows.set(organizations, [{ partnerId: ids.partner, settings: {} }]);
    expect(await revalidate({ requirePartnerFlags: true })).toBe('diagnostics_disabled');
  });

  it('fences an origin that stopped advertising trace support', async () => {
    rows.set(topologyCollectionSources, [{ currentBaseline: envelope([{ name: 'network_trace', version: 1, supported: false }]) }]);
    expect(await revalidate()).toBe('trace_capability_withdrawn');
    rows.set(topologyCollectionSources, []);
    expect(await revalidate()).toBe('trace_capability_withdrawn');
  });

  it('consults partner trust only where asked', async () => {
    expect(await revalidate({ trustAllowed: async () => false })).toBeNull();
    expect(await revalidate({ trustAllowed: async () => false, checkTrust: true })).toBe('trust_denied');
  });
});

describe('freezeTopologyTraceRequester', () => {
  it('pins the current epochs and permission version of a human requester', async () => {
    const frozen = await freezeTopologyTraceRequester(
      { auth: { user: { id: ids.user }, principal: { kind: 'user_session' } } } as never,
      { reader: fakeReader(rows), permissionVersion: async () => '[1,2]' },
    );
    expect(frozen).toEqual(authority);
  });

  it('refuses when the permission version is unavailable rather than freezing nothing', async () => {
    await expect(freezeTopologyTraceRequester(
      { auth: { user: { id: ids.user }, principal: { kind: 'user_session' } } } as never,
      { reader: fakeReader(rows), permissionVersion: async () => null },
    )).rejects.toMatchObject({ code: 'topology_authority_unavailable' });
  });
});
