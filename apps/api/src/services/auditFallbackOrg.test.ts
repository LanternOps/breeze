import type { Context } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The resolver's resource lookups run through `db` inside the caller's own DB
// access context. Here `db` is a chain stub whose terminal `limit()` resolves
// the rows the test queued, and the context wrapper records the auth it was
// entered with so a test can assert the lookup was scoped to the caller.
const { limit, contextAuths, fromTables } = vi.hoisted(() => ({
  limit: vi.fn(),
  contextAuths: [] as unknown[],
  fromTables: [] as unknown[],
}));

vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const method of ['select', 'innerJoin', 'where']) {
    chain[method] = () => chain;
  }
  chain.from = (table: unknown) => {
    fromTables.push(table);
    return chain;
  };
  chain.limit = limit;
  return { db: chain };
});

vi.mock('../middleware/auth', () => ({
  withAuthDbAccessContext: async (auth: unknown, fn: () => Promise<unknown>) => {
    contextAuths.push(auth);
    return fn();
  },
}));

import { contracts, deviceGroups, devices, invoices, quotes, securityThreats, tickets } from '../db/schema';
import { resolveFallbackOrgId } from './auditFallbackOrg';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const FOREIGN_ORG = '33333333-3333-4333-8333-333333333333';
const RESOURCE_ID = '44444444-4444-4444-8444-444444444444';

type FakeAuth = {
  scope: 'system' | 'partner' | 'organization';
  orgId: string | null;
  accessibleOrgIds: string[] | null;
  canAccessOrg: (orgId: string) => boolean;
};

function partnerAuth(orgIds: string[]): FakeAuth {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    canAccessOrg: (orgId) => orgIds.includes(orgId),
  };
}

function ctx(url: string, vars: Record<string, unknown> = {}): Context {
  const parsed = new URL(url, 'http://localhost');
  return {
    get: (key: string) => vars[key],
    req: {
      path: parsed.pathname,
      query: (key: string) => parsed.searchParams.get(key) ?? undefined,
    },
  } as unknown as Context;
}

async function resolve(url: string, vars: Record<string, unknown> = {}) {
  const c = ctx(url, vars);
  return resolveFallbackOrgId(c, new URL(url, 'http://localhost').pathname);
}

beforeEach(() => {
  limit.mockReset().mockResolvedValue([]);
  contextAuths.length = 0;
  fromTables.length = 0;
});

describe('resolveFallbackOrgId — caller-bound org (unchanged behaviour)', () => {
  it('returns the org of an organization-scope caller, ignoring any org in the path', async () => {
    const auth: FakeAuth = {
      scope: 'organization', orgId: ORG_A, accessibleOrgIds: [ORG_A],
      canAccessOrg: (id) => id === ORG_A,
    };
    await expect(resolve(`/api/v1/orgs/${ORG_B}/billing-settings`, { auth })).resolves.toBe(ORG_A);
  });

  it('returns the only accessible org of a single-org partner caller', async () => {
    await expect(resolve('/api/v1/scripts', { auth: partnerAuth([ORG_A]) })).resolves.toBe(ORG_A);
  });

  it('returns null for a multi-org partner caller when nothing identifies the org', async () => {
    await expect(resolve('/api/v1/scripts', { auth: partnerAuth([ORG_A, ORG_B]) })).resolves.toBeNull();
  });
});

describe('resolveFallbackOrgId — org named by the request', () => {
  const auth = partnerAuth([ORG_A, ORG_B]);

  it.each([
    [`/api/v1/orgs/${ORG_B}/billing-settings`],
    [`/api/v1/orgs/${ORG_B}/invoices/assemble`],
    [`/api/v1/orgs/${ORG_B}`],
    [`/api/v1/orgs/organizations/${ORG_B}`],
  ])('resolves the accessible org in %s', async (url) => {
    await expect(resolve(url, { auth })).resolves.toBe(ORG_B);
  });

  it.each([
    [`/api/v1/scripts?orgId=${ORG_B}`],
    [`/api/v1/partner/known-guests?orgId=${ORG_B}`],
    [`/api/v1/orgs/organizations/order?orgId=${ORG_B}`],
  ])('ignores an ?orgId= query parameter, which the web client adds from the org switcher (%s)', async (url) => {
    await expect(resolve(url, { auth })).resolves.toBeNull();
  });

  it.each([
    [`/api/v1/orgs/${FOREIGN_ORG}/billing-settings`],
    [`/api/v1/orgs/organizations/${FOREIGN_ORG}`],
  ])('never resolves an org outside the caller\'s access (%s)', async (url) => {
    await expect(resolve(url, { auth })).resolves.toBeNull();
  });

  it('does not treat a literal segment after /orgs/ as an org id', async () => {
    await expect(resolve('/api/v1/orgs/import', { auth })).resolves.toBeNull();
    await expect(resolve('/api/v1/orgs/partners/abc', { auth })).resolves.toBeNull();
  });

  it('prefers the path org over a query org', async () => {
    await expect(resolve(`/api/v1/orgs/${ORG_A}/billing-settings?orgId=${ORG_B}`, { auth })).resolves.toBe(ORG_A);
  });

  it('does not resolve a path org for an unauthenticated request', async () => {
    await expect(resolve(`/api/v1/orgs/${ORG_A}/billing-settings`)).resolves.toBeNull();
  });

  it('resolves a path org for a system-scope caller', async () => {
    const system: FakeAuth = {
      scope: 'system', orgId: null, accessibleOrgIds: null, canAccessOrg: () => true,
    };
    await expect(resolve(`/api/v1/orgs/${FOREIGN_ORG}/billing-settings`, { auth: system })).resolves.toBe(FOREIGN_ORG);
  });
});

describe('resolveFallbackOrgId — org owning a resource in the path', () => {
  const auth = partnerAuth([ORG_A, ORG_B]);

  it('looks the device up inside the caller\'s own DB access context', async () => {
    limit.mockResolvedValueOnce([{ orgId: ORG_B }]);
    await expect(resolve(`/api/v1/devices/${RESOURCE_ID}`, { auth })).resolves.toBe(ORG_B);
    expect(contextAuths).toEqual([auth]);
  });

  it('never resolves a looked-up org outside the caller\'s access', async () => {
    limit.mockResolvedValueOnce([{ orgId: FOREIGN_ORG }]);
    await expect(resolve(`/api/v1/devices/${RESOURCE_ID}`, { auth })).resolves.toBeNull();
  });

  it('does no lookup for an unauthenticated request', async () => {
    limit.mockResolvedValue([{ orgId: ORG_A }]);
    await expect(resolve(`/api/v1/devices/${RESOURCE_ID}`)).resolves.toBeNull();
    expect(limit).not.toHaveBeenCalled();
  });

  it.each([
    [`/api/v1/devices/${RESOURCE_ID}/reboot`, 'devices', devices],
    [`/api/v1/devices/groups/${RESOURCE_ID}`, 'deviceGroups', deviceGroups],
    [`/api/v1/security/scan/${RESOURCE_ID}`, 'devices', devices],
    [`/api/v1/security/threats/${RESOURCE_ID}/quarantine`, 'securityThreats', securityThreats],
    [`/api/v1/system-tools/devices/${RESOURCE_ID}/services/x/restart`, 'devices', devices],
    [`/api/v1/tickets/${RESOURCE_ID}/checklist`, 'tickets', tickets],
    [`/api/v1/tickets/${RESOURCE_ID}/invoice`, 'tickets', tickets],
    [`/api/v1/quotes/${RESOURCE_ID}/lines`, 'quotes', quotes],
    [`/api/v1/invoices/${RESOURCE_ID}/issue`, 'invoices', invoices],
    [`/api/v1/contracts/${RESOURCE_ID}`, 'contracts', contracts],
  ])('resolves the owning org of the resource in %s from %s', async (url, _name, table) => {
    limit.mockResolvedValueOnce([{ orgId: ORG_A }]);
    await expect(resolve(url, { auth })).resolves.toBe(ORG_A);
    expect(limit).toHaveBeenCalledTimes(1);
    expect(fromTables).toEqual([table]);
  });

  it.each([
    ['/api/v1/quotes/bulk-delete'],
    ['/api/v1/contracts/templates'],
    ['/api/v1/tickets/parts/abc'],
    ['/api/v1/devices/groups/not-a-uuid'],
  ])('does no lookup for a literal route segment (%s)', async (url) => {
    await expect(resolve(url, { auth })).resolves.toBeNull();
    expect(limit).not.toHaveBeenCalled();
  });

  it('lets the resource, not a query parameter, decide the org', async () => {
    limit.mockResolvedValueOnce([]);
    await expect(resolve(`/api/v1/tickets/${RESOURCE_ID}?orgId=${ORG_B}`, { auth })).resolves.toBeNull();
  });

  it('does not resolve an agent-authenticated request', async () => {
    await expect(resolve(`/api/v1/agents/${RESOURCE_ID}/something`, {
      agent: { agentId: RESOURCE_ID, orgId: ORG_A },
    })).resolves.toBeNull();
    expect(limit).not.toHaveBeenCalled();
  });

  it('returns null when the lookup fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    limit.mockRejectedValueOnce(new Error('db down'));
    await expect(resolve(`/api/v1/devices/${RESOURCE_ID}`, { auth })).resolves.toBeNull();
    error.mockRestore();
  });
});
