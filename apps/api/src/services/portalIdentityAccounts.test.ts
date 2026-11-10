/**
 * Unit tests for the identity-only account writer shared by W3 access-request
 * approval and W4 instant-mode sign-in (portal registration W4 #11381, plan
 * Task 5). Statement shapes and outcomes over a scripted Drizzle executor; the
 * lock, RLS and race behaviour is proven on real Postgres in
 * __tests__/integration/portalOidcSignIn.integration.test.ts and
 * portalAccessRequests.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

type Step = [string, unknown[]];
interface Call { op: 'select' | 'insert' | 'update' | 'execute'; args: unknown[]; steps: Step[] }

const h = vi.hoisted(() => {
  const calls: Call[] = [];
  const results: unknown[] = [];
  function builder(op: Call['op'], args: unknown[]): unknown {
    const call: Call = { op, args, steps: [] };
    calls.push(call);
    const proxy: unknown = new Proxy(() => undefined, {
      get(_target, prop) {
        if (prop === 'then') {
          const next = results.length > 0 ? results.shift() : [];
          return (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
            next instanceof Error ? reject(next) : resolve(next);
        }
        return (...stepArgs: unknown[]) => {
          call.steps.push([String(prop), stepArgs]);
          return proxy;
        };
      },
    });
    return proxy;
  }
  return { calls, results, builder };
});

vi.mock('../db', () => ({ db: {} }));

vi.mock('./contacts/portalInvite', () => ({
  lockPortalInviteAddresses: vi.fn(async () => undefined),
}));

vi.mock('./contacts/loginLink', () => ({
  linkLoginToContact: vi.fn(async () => ({ contactId: 'contact-1', outcome: 'linked' })),
}));

import { portalUserIdentities, portalUsers } from '../db/schema';
import { lockPortalInviteAddresses } from './contacts/portalInvite';
import { linkLoginToContact } from './contacts/loginLink';
import { createIdentityOnlyAccount, type CreateIdentityOnlyAccountInput } from './portalIdentityAccounts';
import { entraIssuer, type IdentityExecutor } from './portalUserIdentities';

const ORG = '0b9d6a52-8f43-4c5e-9a1d-2f6c7b8e9d01';
const DECIDER = '7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b';
const TID = '11111111-2222-4333-8444-555555555555';
const OID = '66666666-7777-4888-9999-000000000000';
const NOW = new Date('2027-02-01T12:00:00.000Z');

const tx = {
  select: (...a: unknown[]) => h.builder('select', a),
  insert: (...a: unknown[]) => h.builder('insert', a),
  update: (...a: unknown[]) => h.builder('update', a),
  execute: (...a: unknown[]) => h.builder('execute', a),
} as unknown as IdentityExecutor;

function stepsOf(call: Call | undefined, name: string): unknown[][] {
  return (call?.steps ?? []).filter(([n]) => n === name).map(([, a]) => a);
}
function firstArg(call: Call | undefined, name: string): Record<string, unknown> {
  return stepsOf(call, name)[0]?.[0] as Record<string, unknown>;
}
const inserts = () => h.calls.filter((c) => c.op === 'insert');

const instant = (over: Partial<CreateIdentityOnlyAccountInput> = {}): CreateIdentityOnlyAccountInput => ({
  orgId: ORG,
  provider: 'entra',
  tid: TID,
  oid: OID,
  email: 'jane@acme.example',
  name: 'Jane',
  contactAddress: 'jane@acme.example',
  actorUserId: null,
  writer: 'sso_instant',
  now: NOW,
  ...over,
} as CreateIdentityOnlyAccountInput);

beforeEach(() => {
  h.calls.length = 0;
  h.results.length = 0;
  vi.clearAllMocks();
});

describe('createIdentityOnlyAccount', () => {
  it('instant: locks the address, refuses nothing, links the contact, then an active+granted entra login and a jit identity', async () => {
    h.results.push([], [{ id: 'pu-new', authEpoch: 1 }], [{ id: 'identity-1' }]);
    const outcome = await createIdentityOnlyAccount(tx, instant());
    expect(outcome).toEqual({ kind: 'created', portalUserId: 'pu-new', authEpoch: 1 });

    expect(lockPortalInviteAddresses).toHaveBeenCalledWith(tx, ORG, ['jane@acme.example']);
    // "Never link by email": an existing account at the address is checked under the lock.
    const exists = h.calls[0]!;
    expect(exists.op).toBe('select');
    const where = new PgDialect().sqlToQuery(stepsOf(exists, 'where')[0]![0] as SQL);
    expect(where.sql).toContain('lower("portal_users"."email")');
    expect(where.params).toEqual(expect.arrayContaining([ORG, 'jane@acme.example']));

    expect(linkLoginToContact).toHaveBeenCalledWith(tx, {
      orgId: ORG, email: 'jane@acme.example', name: 'Jane', actor: { userId: null }, roles: ['portal'], unionRoles: ['portal'],
    });

    const [account, identity] = inserts();
    expect(account!.args[0]).toBe(portalUsers);
    expect(firstArg(account, 'values')).toEqual({
      orgId: ORG, email: 'jane@acme.example', name: 'Jane', passwordHash: null, authMethod: 'entra',
      entraTenantId: TID, entraOid: OID, status: 'active', browserAccess: 'granted', contactId: 'contact-1',
    });
    expect(stepsOf(account, 'onConflictDoNothing')).toHaveLength(1);
    expect(identity!.args[0]).toBe(portalUserIdentities);
    expect(firstArg(identity, 'values')).toEqual({
      orgId: ORG, portalUserId: 'pu-new', provider: 'entra', issuer: entraIssuer(TID), subject: OID,
      entraTenantId: TID, linkedVia: 'jit', lastUsedAt: NOW,
    });
    expect(stepsOf(identity, 'onConflictDoNothing')).toHaveLength(1);
  });

  it('no linkable address (D10): no contact link, contact_id null', async () => {
    h.results.push([], [{ id: 'pu-new', authEpoch: 1 }], [{ id: 'identity-1' }]);
    await createIdentityOnlyAccount(tx, instant({ contactAddress: null }));
    expect(linkLoginToContact).not.toHaveBeenCalled();
    expect(firstArg(inserts()[0], 'values')).toMatchObject({ contactId: null });
  });

  it('account_exists when the org has an account at either address; writes nothing', async () => {
    h.results.push([{ id: 'pu-existing' }]);
    const outcome = await createIdentityOnlyAccount(tx, instant({ email: 'jane@acme.example', contactAddress: 'j.doe@acme.example' }));
    expect(outcome).toEqual({ kind: 'account_exists' });
    expect(lockPortalInviteAddresses).toHaveBeenCalledWith(tx, ORG, ['jane@acme.example', 'j.doe@acme.example']);
    const where = new PgDialect().sqlToQuery(stepsOf(h.calls[0], 'where')[0]![0] as SQL);
    expect(where.params).toEqual(expect.arrayContaining(['jane@acme.example', 'j.doe@acme.example']));
    expect(linkLoginToContact).not.toHaveBeenCalled();
    expect(inserts()).toHaveLength(0);
  });

  it('identity_linked when the login insert conflicts (legacy entra_* key): no identity insert', async () => {
    h.results.push([], []);
    expect(await createIdentityOnlyAccount(tx, instant())).toEqual({ kind: 'identity_linked' });
    expect(inserts()).toHaveLength(1);
  });

  it('identity_linked when the identity insert conflicts (the caller must roll back the login)', async () => {
    h.results.push([], [{ id: 'pu-new', authEpoch: 1 }], []);
    expect(await createIdentityOnlyAccount(tx, instant())).toEqual({ kind: 'identity_linked' });
    expect(inserts()).toHaveLength(2);
  });

  it('approved request: the decider is the contact actor and the identity carries no last_used_at', async () => {
    h.results.push([], [{ id: 'pu-new', authEpoch: 1 }], [{ id: 'identity-1' }]);
    await createIdentityOnlyAccount(tx, instant({ writer: 'sso_request_approved', actorUserId: DECIDER }));
    expect(linkLoginToContact).toHaveBeenCalledWith(tx, expect.objectContaining({ actor: { userId: DECIDER } }));
    expect(firstArg(inserts()[1], 'values')).not.toHaveProperty('lastUsedAt');
    expect(firstArg(inserts()[0], 'values')).toMatchObject({ status: 'active', browserAccess: 'granted' });
  });

  it('google: auth_method google, google issuer, no entra_* columns', async () => {
    h.results.push([], [{ id: 'pu-new', authEpoch: 1 }], [{ id: 'identity-1' }]);
    await createIdentityOnlyAccount(tx, {
      orgId: ORG, provider: 'google', sub: 'sub-1', email: 'g@x.test', name: null, contactAddress: 'g@x.test',
      actorUserId: DECIDER, writer: 'sso_request_approved', now: NOW,
    });
    const [account, identity] = inserts();
    const values = firstArg(account, 'values');
    expect(values).toMatchObject({ authMethod: 'google', status: 'active', browserAccess: 'granted' });
    expect(values).not.toHaveProperty('entraOid');
    expect(values).not.toHaveProperty('entraTenantId');
    expect(firstArg(identity, 'values')).toEqual({
      orgId: ORG, portalUserId: 'pu-new', provider: 'google', issuer: 'https://accounts.google.com', subject: 'sub-1',
      entraTenantId: null, linkedVia: 'jit',
    });
  });
});
