import { beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

const queue: unknown[][] = [];
const froms: unknown[] = [];
function chain(): unknown {
  const target = {
    then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(queue.shift() ?? []).then(resolve, reject),
  };
  return new Proxy(target, {
    get: (t, prop) => {
      if (prop === 'then') return t.then;
      if (prop === 'from') return (table: unknown) => { froms.push(table); return chain(); };
      return () => chain();
    },
  });
}
vi.mock('../db', () => ({ db: { select: () => chain() } }));

import * as schema from '../db/schema';
import { PERMISSIONS } from './permissions';
import { buildOrgSummary, resolveOrgSummary } from './orgSummary';

const ORG = '11111111-1111-4111-8111-111111111111';
const none = () => false;
const all = () => true;

beforeEach(() => {
  queue.length = 0;
  froms.length = 0;
});

describe('buildOrgSummary (W18, #6789)', () => {
  it('a missing or deleted org is null', async () => {
    queue.push([]);
    expect(await buildOrgSummary(ORG, all)).toBeNull();
  });

  it.each([
    ['devices', PERMISSIONS.DEVICES_READ, schema.devices],
    ['alerts', PERMISSIONS.ALERTS_READ, schema.alerts],
    ['tickets', PERMISSIONS.TICKETS_READ, schema.tickets],
    ['contracts', PERMISSIONS.CONTRACTS_READ, schema.contracts],
    ['invoices', PERMISSIONS.INVOICES_READ, schema.invoices],
    ['portalUsers', PERMISSIONS.USERS_READ, schema.portalUsers],
    ['lastActivityAt', PERMISSIONS.AUDIT_READ, schema.auditLogs],
  ] as const)('summary section %s absent without its grant, and its table never read', async (key, grant, table) => {
    queue.push([{ id: ORG, currencyCode: 'USD' }]);
    const without = await buildOrgSummary(ORG, (g) => !(g.resource === grant.resource && g.action === grant.action));
    expect(without).not.toBeNull();
    expect(Object.keys(without!)).not.toContain(key);
    expect(froms).not.toContain(table);

    froms.length = 0;
    queue.length = 0;
    queue.push([{ id: ORG, currencyCode: 'USD' }]);
    const withGrant = await buildOrgSummary(ORG, all);
    expect(Object.keys(withGrant!)).toContain(key);
    expect(froms).toContain(table);
  });

  it('sites and contacts ride on organizations:read alone', async () => {
    queue.push([{ id: ORG, currencyCode: null }], [{ count: '3' }], [{ count: '2' }], [{ id: 'c1', name: null, email: 'a@x', phone: null }]);
    const summary = await buildOrgSummary(ORG, none);
    expect(summary).toEqual({
      orgId: ORG,
      sites: { count: 3 },
      contacts: { count: 2, primary: { id: 'c1', name: '', email: 'a@x', phone: null } },
    });
  });
});

describe('resolveOrgSummary access', () => {
  it('a malformed id and an inaccessible org are the same null, before any query', async () => {
    const auth = { scope: 'partner', canAccessOrg: () => false } as never;
    expect(await resolveOrgSummary(auth, 'not-a-uuid', all)).toBeNull();
    expect(await resolveOrgSummary(auth, ORG, all)).toBeNull();
    expect(froms).toHaveLength(0);
  });

  it('any non-system scope is bounded by its allowlist (organization included), before any query', async () => {
    const auth = { scope: 'organization', canAccessOrg: () => false } as never;
    expect(await resolveOrgSummary(auth, ORG, all)).toBeNull();
    expect(froms).toHaveLength(0);
  });

  it('system scope is not bounded by an allowlist', async () => {
    queue.push([{ id: ORG, currencyCode: null }]);
    const auth = { scope: 'system', canAccessOrg: () => false } as never;
    expect(await resolveOrgSummary(auth, ORG, none)).toMatchObject({ orgId: ORG });
  });
});
