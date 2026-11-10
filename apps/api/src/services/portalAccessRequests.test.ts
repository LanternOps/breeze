/**
 * Unit tests for the access-request queue service (W3 #11380, plan Task 7):
 * argument shapes and error mapping over a scripted Drizzle mock. The
 * transaction, RLS, lock and concurrency behaviour is proven against real
 * Postgres in __tests__/integration/portalAccessRequests.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

type Step = [string, unknown[]];
interface Call { op: 'select' | 'insert' | 'update' | 'execute'; args: unknown[]; steps: Step[]; depth: number }

const h = vi.hoisted(() => {
  const calls: Call[] = [];
  const results: unknown[] = [];
  const txDepth = { current: 0 };
  function builder(op: Call['op'], args: unknown[]): unknown {
    const call: Call = { op, args, steps: [], depth: txDepth.current };
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
  return { calls, results, txDepth, builder };
});

vi.mock('../db', () => ({
  db: {
    select: (...a: unknown[]) => h.builder('select', a),
    insert: (...a: unknown[]) => h.builder('insert', a),
    update: (...a: unknown[]) => h.builder('update', a),
    execute: (...a: unknown[]) => h.builder('execute', a),
  },
  withDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => {
    h.txDepth.current += 1;
    try { return await fn(); } finally { h.txDepth.current -= 1; }
  }),
  withSystemDbAccessContextIsolated: vi.fn(async (fn: () => Promise<unknown>) => {
    h.txDepth.current += 1;
    try { return await fn(); } finally { h.txDepth.current -= 1; }
  }),
}));

vi.mock('./contacts/portalInvite', () => ({
  lockPortalInviteAddresses: vi.fn(async () => {
    expect(h.txDepth.current).toBeGreaterThan(0);
  }),
  portalLoginEmailEquals: vi.fn((email: string) => ({ __lowerEmailEquals: email })),
}));

vi.mock('./contacts/loginLink', () => ({
  linkLoginToContact: vi.fn(async () => ({ contactId: 'contact-1', outcome: 'linked' })),
}));

import { clientAiTenantMappings, portalAccessRequests, portalUserIdentities, portalUsers } from '../db/schema';
import { withDbTransaction, withSystemDbAccessContextIsolated } from '../db';
import { lockPortalInviteAddresses } from './contacts/portalInvite';
import { linkLoginToContact } from './contacts/loginLink';
import { PORTAL_ACCOUNT_TRANSITION_REFUSED, PortalAccountTransitionError } from './portalAccountState';
import {
  PORTAL_ACCESS_REQUEST_PENDING_CAP,
  PORTAL_ACCESS_REQUEST_TTL_DAYS,
  PortalAccessRequestError,
  approvePortalAccessRequest,
  createPortalAccessRequest,
  denyPortalAccessRequest,
  listPortalAccessRequests,
  summarizePendingPortalAccessRequests,
} from './portalAccessRequests';

const ORG = '0b9d6a52-8f43-4c5e-9a1d-2f6c7b8e9d01';
const REQ = '5c1f2e3d-4b5a-4c6d-8e7f-9a0b1c2d3e4f';
const DECIDER = '7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b';
const NOW = new Date('2027-02-01T12:00:00.000Z');
const LATER = new Date(NOW.getTime() + 3 * 86_400_000);
const TID = '11111111-2222-4333-8444-555555555555';

function stepsOf(call: Call | undefined, name: string): unknown[][] {
  return (call?.steps ?? []).filter(([n]) => n === name).map(([, a]) => a);
}
function firstArg(call: Call | undefined, name: string): Record<string, unknown> {
  return stepsOf(call, name)[0]?.[0] as Record<string, unknown>;
}
const inserts = () => h.calls.filter((c) => c.op === 'insert');
const updates = () => h.calls.filter((c) => c.op === 'update');

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(() => { throw new Error('expected a rejection'); }, (e: unknown) => e);
}

function pendingRow(over: Record<string, unknown> = {}) {
  return {
    id: REQ, orgId: ORG, email: 'ada@customer.test', name: 'Ada', source: 'self',
    issuer: null, subject: null, entraTenantId: null, portalUserId: null,
    status: 'pending', expiresAt: LATER, ...over,
  };
}

beforeEach(() => {
  h.calls.length = 0;
  h.results.length = 0;
  h.txDepth.current = 0;
  vi.clearAllMocks();
});

describe('createPortalAccessRequest', () => {
  it('serializes admission per org: a transaction-scoped advisory lock comes first, inside the isolated block', async () => {
    h.results.push([], [], [{ n: 3 }], [{ id: REQ, inserted: true }]);
    await createPortalAccessRequest({ source: 'self', orgId: ORG, email: 'ada@customer.test', name: null }, NOW);

    expect(h.calls.map((c) => c.op)).toEqual(['execute', 'update', 'select', 'insert']);
    expect(h.calls.every((c) => c.depth === 1)).toBe(true);
    const lock = new PgDialect().sqlToQuery(h.calls[0]!.args[0] as SQL);
    expect(lock.sql).toMatch(/^select pg_advisory_xact_lock\(hashtext\(\$1\), hashtext\(\$2\)\)$/i);
    expect(lock.params).toEqual(['portal_access_request_admission', ORG]);
  });

  it('normalizes the email, expires a stale row, counts, and inserts with the pending-only upsert', async () => {
    h.results.push([], [], [{ n: 3 }], [{ id: REQ, inserted: true }]);
    const outcome = await createPortalAccessRequest({ source: 'self', orgId: ORG, email: '  Ada@Customer.TEST ', name: ' Ada ' }, NOW);

    expect(outcome).toEqual({ kind: 'created', requestId: REQ });
    expect(withSystemDbAccessContextIsolated).toHaveBeenCalledTimes(1);
    expect(h.calls.map((c) => c.op)).toEqual(['execute', 'update', 'select', 'insert']);

    const [, expire, , insert] = h.calls;
    expect(expire!.args[0]).toBe(portalAccessRequests);
    expect(firstArg(expire, 'set')).toEqual({ status: 'expired', updatedAt: NOW });

    expect(insert!.args[0]).toBe(portalAccessRequests);
    const values = firstArg(insert, 'values');
    expect(values).toMatchObject({
      orgId: ORG, email: 'ada@customer.test', name: 'Ada', source: 'self', status: 'pending',
      issuer: null, subject: null, entraTenantId: null, portalUserId: null,
      requestedAt: NOW, lastRequestedAt: NOW,
    });
    expect((values.expiresAt as Date).getTime() - NOW.getTime()).toBe(PORTAL_ACCESS_REQUEST_TTL_DAYS * 86_400_000);

    const conflict = firstArg(insert, 'onConflictDoUpdate');
    expect(conflict.target).toEqual([portalAccessRequests.orgId, portalAccessRequests.email]);
    expect(conflict.targetWhere).toBeDefined();
    expect(conflict.set).toEqual({ lastRequestedAt: NOW, updatedAt: NOW });
  });

  it('maps an upsert that updated the live row to already_pending', async () => {
    h.results.push([], [], [{ n: 3 }], [{ id: REQ, inserted: false }]);
    expect(await createPortalAccessRequest({ source: 'self', orgId: ORG, email: 'ada@customer.test', name: null }, NOW))
      .toEqual({ kind: 'already_pending', requestId: REQ });
  });

  it('returns capped at the cap and inserts nothing', async () => {
    h.results.push([], [], [{ n: PORTAL_ACCESS_REQUEST_PENDING_CAP }]);
    expect(await createPortalAccessRequest({ source: 'self', orgId: ORG, email: 'ada@customer.test', name: null }, NOW))
      .toEqual({ kind: 'capped' });
    expect(inserts()).toHaveLength(0);
  });

  it('stores Entra claims as issuer/subject/tenant and Google claims as the google issuer', async () => {
    h.results.push([], [], [{ n: 0 }], [{ id: REQ, inserted: true }]);
    await createPortalAccessRequest({ source: 'entra', orgId: ORG, email: 'a@x.test', name: null, tid: TID, oid: 'oid-1' }, NOW);
    expect(firstArg(inserts()[0], 'values')).toMatchObject({
      source: 'entra', issuer: `https://login.microsoftonline.com/${TID}/v2.0`, subject: 'oid-1', entraTenantId: TID, portalUserId: null,
    });

    h.calls.length = 0;
    h.results.push([], [], [{ n: 0 }], [{ id: REQ, inserted: true }]);
    await createPortalAccessRequest({ source: 'google', orgId: ORG, email: 'a@x.test', name: null, sub: 'sub-1' }, NOW);
    expect(firstArg(inserts()[0], 'values')).toMatchObject({
      source: 'google', issuer: 'https://accounts.google.com', subject: 'sub-1', entraTenantId: null,
    });

    h.calls.length = 0;
    h.results.push([], [], [{ n: 0 }], [{ id: REQ, inserted: true }]);
    await createPortalAccessRequest({ source: 'addin_user', orgId: ORG, portalUserId: 'pu-1', email: 'a@x.test', name: null }, NOW);
    expect(firstArg(inserts()[0], 'values')).toMatchObject({
      source: 'addin_user', issuer: null, subject: null, entraTenantId: null, portalUserId: 'pu-1',
    });
  });
});

describe('approvePortalAccessRequest', () => {
  it('runs the whole body in one withDbTransaction and reads the request FOR UPDATE', async () => {
    h.results.push([pendingRow()], [], [{ id: 'pu-new', authEpoch: 1 }], []);
    await approvePortalAccessRequest({ orgId: ORG, requestId: REQ, deciderUserId: DECIDER, now: NOW });
    expect(withDbTransaction).toHaveBeenCalledTimes(1);
    const read = h.calls[0]!;
    expect(read.op).toBe('select');
    expect(stepsOf(read, 'for')).toEqual([['update']]);
  });

  it('NOT_FOUND (404) when the request is not in this org, and for a malformed id without querying', async () => {
    h.results.push([]);
    const err = await rejection(approvePortalAccessRequest({ orgId: ORG, requestId: REQ, deciderUserId: DECIDER, now: NOW }));
    expect(err).toBeInstanceOf(PortalAccessRequestError);
    expect(err).toMatchObject({ code: 'PORTAL_ACCESS_REQUEST_NOT_FOUND', httpStatus: 404 });

    h.calls.length = 0;
    const bad = await rejection(approvePortalAccessRequest({ orgId: ORG, requestId: 'not-a-uuid', deciderUserId: DECIDER, now: NOW }));
    expect(bad).toMatchObject({ code: 'PORTAL_ACCESS_REQUEST_NOT_FOUND', httpStatus: 404 });
    expect(h.calls).toHaveLength(0);
  });

  it.each([
    ['approved', { status: 'approved' }],
    ['denied', { status: 'denied' }],
    ['expired status', { status: 'expired' }],
    ['pending past expires_at', { expiresAt: NOW }],
  ])('NOT_PENDING (409) for a %s request, and writes nothing', async (_name, over) => {
    h.results.push([pendingRow(over)]);
    const err = await rejection(approvePortalAccessRequest({ orgId: ORG, requestId: REQ, deciderUserId: DECIDER, now: NOW }));
    expect(err).toMatchObject({ code: 'PORTAL_ACCESS_REQUEST_NOT_PENDING', httpStatus: 409 });
    expect(updates()).toHaveLength(0);
    expect(inserts()).toHaveLength(0);
  });

  it('ACCOUNT_EXISTS (409) when the org has an account for the address; creates nothing', async () => {
    h.results.push([pendingRow()], [{ id: 'pu-existing' }]);
    const err = await rejection(approvePortalAccessRequest({ orgId: ORG, requestId: REQ, deciderUserId: DECIDER, now: NOW }));
    expect(err).toMatchObject({ code: 'PORTAL_ACCESS_REQUEST_ACCOUNT_EXISTS', httpStatus: 409 });
    expect(lockPortalInviteAddresses).toHaveBeenCalledWith(expect.anything(), ORG, ['ada@customer.test']);
    expect(inserts()).toHaveLength(0);
    expect(updates()).toHaveLength(0);
  });

  it('self: invited password account with invitedAt/invitedBy, linked contact, outcome invite_pending', async () => {
    h.results.push([pendingRow()], [], [{ id: 'pu-new', authEpoch: 1 }], []);
    const result = await approvePortalAccessRequest({ orgId: ORG, requestId: REQ, deciderUserId: DECIDER, now: NOW });

    expect(result).toEqual({
      outcome: 'invite_pending', portalUserId: 'pu-new', email: 'ada@customer.test', name: 'Ada', authEpoch: 1, source: 'self',
    });
    expect(linkLoginToContact).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG, email: 'ada@customer.test', name: 'Ada', actor: { userId: DECIDER }, roles: ['portal'], unionRoles: ['portal'],
    }));
    const [account] = inserts();
    expect(account!.args[0]).toBe(portalUsers);
    expect(firstArg(account, 'values')).toMatchObject({
      orgId: ORG, email: 'ada@customer.test', name: 'Ada', passwordHash: null, authMethod: 'password',
      status: 'invited', browserAccess: 'granted', invitedAt: NOW, invitedBy: DECIDER, contactId: 'contact-1',
    });
    const [decide] = updates();
    expect(decide!.args[0]).toBe(portalAccessRequests);
    expect(firstArg(decide, 'set')).toEqual({
      status: 'approved', decidedAt: NOW, decidedByUserId: DECIDER, portalUserId: 'pu-new', updatedAt: NOW,
    });
  });

  it('entra: identity-only active account (auth_method entra) with entra_* dual-write and a jit identity', async () => {
    h.results.push(
      [pendingRow({ source: 'entra', issuer: `https://login.microsoftonline.com/${TID}/v2.0`, subject: 'oid-1', entraTenantId: TID })],
      [{ tenantId: TID }], [], [{ id: 'pu-new', authEpoch: 1 }], [{ id: 'identity-1' }], [],
    );
    const result = await approvePortalAccessRequest({ orgId: ORG, requestId: REQ, deciderUserId: DECIDER, now: NOW });
    expect(result.outcome).toBe('account_created');

    const [account, identity] = inserts();
    expect(firstArg(account, 'values')).toMatchObject({
      authMethod: 'entra', status: 'active', browserAccess: 'granted', passwordHash: null,
      entraTenantId: TID, entraOid: 'oid-1', contactId: 'contact-1',
    });
    expect(stepsOf(account, 'onConflictDoNothing')).toHaveLength(1);
    expect(identity!.args[0]).toBe(portalUserIdentities);
    expect(firstArg(identity, 'values')).toEqual({
      orgId: ORG, portalUserId: 'pu-new', provider: 'entra',
      issuer: `https://login.microsoftonline.com/${TID}/v2.0`, subject: 'oid-1', entraTenantId: TID, linkedVia: 'jit',
    });
    expect(stepsOf(identity, 'onConflictDoNothing')).toHaveLength(1);
  });

  it('google: auth_method google, no entra_* columns, google issuer identity', async () => {
    h.results.push(
      [pendingRow({ source: 'google', issuer: 'https://accounts.google.com', subject: 'sub-1' })],
      [], [{ id: 'pu-new', authEpoch: 1 }], [{ id: 'identity-1' }], [],
    );
    await approvePortalAccessRequest({ orgId: ORG, requestId: REQ, deciderUserId: DECIDER, now: NOW });
    const [account, identity] = inserts();
    const values = firstArg(account, 'values');
    expect(values).toMatchObject({ authMethod: 'google', status: 'active', browserAccess: 'granted' });
    expect(values).not.toHaveProperty('entraOid');
    expect(values).not.toHaveProperty('entraTenantId');
    expect(firstArg(identity, 'values')).toMatchObject({ provider: 'google', issuer: 'https://accounts.google.com', subject: 'sub-1', entraTenantId: null });
  });

  it('IDENTITY_LINKED (409) when the identity insert conflicts, and when the legacy entra_* key conflicts', async () => {
    const entra = pendingRow({ source: 'entra', issuer: `https://login.microsoftonline.com/${TID}/v2.0`, subject: 'oid-1', entraTenantId: TID });
    h.results.push([entra], [{ tenantId: TID }], [], [{ id: 'pu-new', authEpoch: 1 }], []);
    expect(await rejection(approvePortalAccessRequest({ orgId: ORG, requestId: REQ, deciderUserId: DECIDER, now: NOW })))
      .toMatchObject({
        code: 'PORTAL_ACCESS_REQUEST_IDENTITY_LINKED',
        httpStatus: 409,
        message: 'This sign-in identity cannot be approved. Ask the person to request access again.',
      });

    h.calls.length = 0;
    h.results.push([entra], [{ tenantId: TID }], [], []);
    expect(await rejection(approvePortalAccessRequest({ orgId: ORG, requestId: REQ, deciderUserId: DECIDER, now: NOW })))
      .toMatchObject({ code: 'PORTAL_ACCESS_REQUEST_IDENTITY_LINKED', httpStatus: 409 });
    expect(updates()).toHaveLength(0);
  });

  it("entra: reads the org's PROVEN mapping FOR SHARE, inside the transaction, before any write", async () => {
    h.results.push(
      [pendingRow({ source: 'entra', issuer: `https://login.microsoftonline.com/${TID}/v2.0`, subject: 'oid-1', entraTenantId: TID })],
      [{ tenantId: TID }], [], [{ id: 'pu-new', authEpoch: 1 }], [{ id: 'identity-1' }], [],
    );
    await approvePortalAccessRequest({ orgId: ORG, requestId: REQ, deciderUserId: DECIDER, now: NOW });

    const mapping = h.calls[1]!;
    expect(mapping.op).toBe('select');
    expect(mapping.depth).toBe(1);
    expect(stepsOf(mapping, 'from')).toEqual([[clientAiTenantMappings]]);
    expect(stepsOf(mapping, 'for')).toEqual([['share']]);
    const where = new PgDialect().sqlToQuery(stepsOf(mapping, 'where')[0]![0] as SQL);
    expect(where.sql).toMatch(/"org_id" = \$1 and "client_ai_tenant_mappings"\."proven_at" is not null/);
    expect(where.params).toEqual([ORG]);
    // Nothing was locked or written before it.
    expect(h.calls.slice(0, 2).map((c) => c.op)).toEqual(['select', 'select']);
  });

  it.each([
    ['no proven mapping (none, unproven, or displaced to another org)', []],
    ['a proven mapping for a different tenant', [{ tenantId: '99999999-8888-4777-8666-555555555555' }]],
  ])('entra: ENTRA_TENANT_NOT_PROVEN (409) with %s; nothing locked or written', async (_name, mappingRows) => {
    h.results.push(
      [pendingRow({ source: 'entra', issuer: `https://login.microsoftonline.com/${TID}/v2.0`, subject: 'oid-1', entraTenantId: TID })],
      mappingRows,
    );
    const err = await rejection(approvePortalAccessRequest({ orgId: ORG, requestId: REQ, deciderUserId: DECIDER, now: NOW }));
    expect(err).toBeInstanceOf(PortalAccessRequestError);
    expect(err).toMatchObject({
      code: 'PORTAL_ACCESS_REQUEST_ENTRA_TENANT_NOT_PROVEN',
      httpStatus: 409,
      message: "This organization's Microsoft tenant has changed since this request was made. Ask the person to sign in again.",
    });
    expect(lockPortalInviteAddresses).not.toHaveBeenCalled();
    expect(linkLoginToContact).not.toHaveBeenCalled();
    expect(inserts()).toHaveLength(0);
    expect(updates()).toHaveLength(0);
  });

  it('entra: the tenant comparison ignores GUID case (both sides are stored lowercased, but never trust it)', async () => {
    h.results.push(
      [pendingRow({ source: 'entra', issuer: `https://login.microsoftonline.com/${TID}/v2.0`, subject: 'oid-1', entraTenantId: TID })],
      [{ tenantId: TID.toUpperCase() }], [], [{ id: 'pu-new', authEpoch: 1 }], [{ id: 'identity-1' }], [],
    );
    expect((await approvePortalAccessRequest({ orgId: ORG, requestId: REQ, deciderUserId: DECIDER, now: NOW })).outcome)
      .toBe('account_created');
  });

  it('google: no tenant read (only entra requests carry a tenant)', async () => {
    h.results.push(
      [pendingRow({ source: 'google', issuer: 'https://accounts.google.com', subject: 'sub-1' })],
      [], [{ id: 'pu-new', authEpoch: 1 }], [{ id: 'identity-1' }], [],
    );
    await approvePortalAccessRequest({ orgId: ORG, requestId: REQ, deciderUserId: DECIDER, now: NOW });
    expect(h.calls.some((c) => stepsOf(c, 'from').some(([t]) => t === clientAiTenantMappings))).toBe(false);
  });

  it('addin_user: plans access_request_approve and writes it guarded by the read epoch, no bump', async () => {
    h.results.push(
      [pendingRow({ source: 'addin_user', portalUserId: 'pu-addin' })],
      [{ id: 'pu-addin', email: 'ada@customer.test', name: 'Ada', status: 'active', browserAccess: 'none', authMethod: 'entra', hasPasswordHash: false, authEpoch: 4, hasExternalIdentity: true }],
      [{ id: 'pu-addin', authEpoch: 4 }],
      [],
    );
    const result = await approvePortalAccessRequest({ orgId: ORG, requestId: REQ, deciderUserId: DECIDER, now: NOW });
    expect(result).toEqual({
      outcome: 'browser_access_granted', portalUserId: 'pu-addin', email: 'ada@customer.test', name: 'Ada', authEpoch: 4, source: 'addin_user',
    });
    expect(lockPortalInviteAddresses).not.toHaveBeenCalled();
    const [grant, decide] = updates();
    expect(grant!.args[0]).toBe(portalUsers);
    expect(firstArg(grant, 'set')).toEqual({ status: 'active', browserAccess: 'granted', updatedAt: NOW });
    expect(firstArg(decide, 'set')).toMatchObject({ status: 'approved', portalUserId: 'pu-addin' });
  });

  it('addin_user: an epoch that moved after the read → 409 epoch_moved transition refusal', async () => {
    h.results.push(
      [pendingRow({ source: 'addin_user', portalUserId: 'pu-addin' })],
      [{ id: 'pu-addin', email: 'a@x.test', name: null, status: 'active', browserAccess: 'none', authMethod: 'entra', hasPasswordHash: false, authEpoch: 4, hasExternalIdentity: true }],
      [],
    );
    const err = await rejection(approvePortalAccessRequest({ orgId: ORG, requestId: REQ, deciderUserId: DECIDER, now: NOW }));
    expect(err).toBeInstanceOf(PortalAccountTransitionError);
    expect(err).toMatchObject({
      code: PORTAL_ACCOUNT_TRANSITION_REFUSED, httpStatus: 409, writer: 'access_request_approve', rule: 'epoch_moved',
      message: 'This account changed while it was being approved. Try again.',
    });
    expect(updates()).toHaveLength(1); // the guarded grant only; the request is not marked
  });

  it('addin_user: a disabled account is refused by the state module before any write', async () => {
    h.results.push(
      [pendingRow({ source: 'addin_user', portalUserId: 'pu-addin' })],
      [{ id: 'pu-addin', email: 'a@x.test', name: null, status: 'disabled', browserAccess: 'none', authMethod: 'entra', hasPasswordHash: false, authEpoch: 4, hasExternalIdentity: true }],
    );
    const err = await rejection(approvePortalAccessRequest({ orgId: ORG, requestId: REQ, deciderUserId: DECIDER, now: NOW }));
    expect(err).toMatchObject({ code: PORTAL_ACCOUNT_TRANSITION_REFUSED, httpStatus: 409, message: 'This user is disabled. Reactivate them before approving.' });
    expect(updates()).toHaveLength(0);
  });
});

describe('denyPortalAccessRequest', () => {
  it('marks denied with the decider inside one withDbTransaction', async () => {
    h.results.push([pendingRow({ source: 'google', issuer: 'https://accounts.google.com', subject: 's' })], []);
    expect(await denyPortalAccessRequest({ orgId: ORG, requestId: REQ, deciderUserId: DECIDER, now: NOW }))
      .toEqual({ email: 'ada@customer.test', source: 'google' });
    expect(withDbTransaction).toHaveBeenCalledTimes(1);
    expect(stepsOf(h.calls[0], 'for')).toEqual([['update']]);
    expect(firstArg(updates()[0], 'set')).toEqual({ status: 'denied', decidedAt: NOW, decidedByUserId: DECIDER, updatedAt: NOW });
  });

  it('NOT_PENDING for a decided request', async () => {
    h.results.push([pendingRow({ status: 'denied' })]);
    expect(await rejection(denyPortalAccessRequest({ orgId: ORG, requestId: REQ, deciderUserId: DECIDER, now: NOW })))
      .toMatchObject({ code: 'PORTAL_ACCESS_REQUEST_NOT_PENDING', httpStatus: 409 });
    expect(updates()).toHaveLength(0);
  });
});

describe('listPortalAccessRequests', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: REQ, email: 'ada@customer.test', name: 'Ada', source: 'self', status: 'pending',
    requestedAt: NOW, lastRequestedAt: NOW, expiresAt: LATER, decidedAt: null,
    decidedByUserId: null, decidedByName: null, portalUserId: null, accountExists: false, ...over,
  });

  it('defaults to 100, caps at 200, and reports hasMore from one extra row', async () => {
    h.results.push(Array.from({ length: 101 }, () => row()));
    const page = await listPortalAccessRequests(ORG, { status: 'pending', now: NOW });
    expect(page.items).toHaveLength(100);
    expect(page.hasMore).toBe(true);
    expect(stepsOf(h.calls[0], 'limit')).toEqual([[101]]);

    h.calls.length = 0;
    h.results.push([]);
    await listPortalAccessRequests(ORG, { status: 'decided', limit: 5000, now: NOW });
    expect(stepsOf(h.calls[0], 'limit')).toEqual([[201]]);
  });

  it('reports a pending row past expiry as expired and maps decidedBy', async () => {
    h.results.push([
      row({ expiresAt: NOW }),
      row({ status: 'approved', decidedAt: NOW, decidedByUserId: DECIDER, decidedByName: 'Tech', portalUserId: 'pu-1', accountExists: true }),
      row({ status: 'denied', decidedAt: NOW, decidedByUserId: null }),
    ]);
    const { items, hasMore } = await listPortalAccessRequests(ORG, { status: 'decided', now: NOW });
    expect(hasMore).toBe(false);
    expect(items.map((i) => i.status)).toEqual(['expired', 'approved', 'denied']);
    expect(items[1]).toMatchObject({ decidedBy: { id: DECIDER, name: 'Tech' }, portalUserId: 'pu-1', accountExists: true, decidedAt: NOW.toISOString() });
    expect(items[2]!.decidedBy).toBeNull();
    expect(items[0]!.requestedAt).toBe(NOW.toISOString());
  });
});

describe('summarizePendingPortalAccessRequests', () => {
  it('totals the per-org counts', async () => {
    h.results.push([{ orgId: 'o1', orgName: 'A', pending: 2 }, { orgId: 'o2', orgName: 'B', pending: '3' }]);
    expect(await summarizePendingPortalAccessRequests(NOW)).toEqual({
      pendingTotal: 5,
      orgs: [{ orgId: 'o1', orgName: 'A', pending: 2 }, { orgId: 'o2', orgName: 'B', pending: 3 }],
    });
  });
});
