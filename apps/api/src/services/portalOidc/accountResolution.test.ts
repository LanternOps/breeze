/**
 * Unit tests for portal OIDC account resolution (portal registration W4
 * #11381, plan Task 5, spec §5.6): one test per branch of steps 0–5, over
 * mocked collaborators and a scripted Drizzle executor. Real-Postgres proofs
 * (RLS, locks, rollbacks, races) live in
 * __tests__/integration/portalOidcSignIn.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

type Step = [string, unknown[]];
interface Call { op: 'select' | 'insert' | 'update' | 'execute'; args: unknown[]; steps: Step[]; inTx: boolean }

const h = vi.hoisted(() => {
  const calls: Call[] = [];
  const results: unknown[] = [];
  const state = { held: false, txDepth: 0, systemDepth: 0, rolledBack: 0, committed: 0 };
  function builder(op: Call['op'], args: unknown[]): unknown {
    const call: Call = { op, args, steps: [], inTx: state.txDepth > 0 };
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
  return { calls, results, state, builder };
});

vi.mock('../../db', () => ({
  db: {
    select: (...a: unknown[]) => h.builder('select', a),
    insert: (...a: unknown[]) => h.builder('insert', a),
    update: (...a: unknown[]) => h.builder('update', a),
    execute: (...a: unknown[]) => h.builder('execute', a),
  },
  hasDbAccessContext: () => h.state.held || h.state.systemDepth > 0,
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    h.state.systemDepth += 1;
    try { return await fn(); } finally { h.state.systemDepth -= 1; }
  }),
  withDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => {
    if (h.state.systemDepth === 0) throw new Error('withDbTransaction outside a context');
    h.state.txDepth += 1;
    try {
      const out = await fn();
      h.state.committed += 1;
      return out;
    } catch (err) {
      h.state.rolledBack += 1;
      throw err;
    } finally {
      h.state.txDepth -= 1;
    }
  }),
}));

const m = vi.hoisted(() => ({
  findOrgByProvenEntraTenant: vi.fn(),
  getActiveOrgTenant: vi.fn(),
  resolvePortalAccessPolicy: vi.fn(),
  createPortalAccessRequest: vi.fn(),
  createIdentityOnlyAccount: vi.fn(),
  findPortalUserIdByEntraIdentity: vi.fn(),
  linkPortalUserIdentity: vi.fn(),
  resolveLinkableEntraAddress: vi.fn(),
}));

vi.mock('../portalEntraTenantProof', () => ({ findOrgByProvenEntraTenant: m.findOrgByProvenEntraTenant }));
vi.mock('../tenantStatus', () => ({ getActiveOrgTenant: m.getActiveOrgTenant }));
vi.mock('../portalAccessPolicy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../portalAccessPolicy')>()),
  resolvePortalAccessPolicy: m.resolvePortalAccessPolicy,
}));
vi.mock('../portalAccessRequests', () => ({ createPortalAccessRequest: m.createPortalAccessRequest }));
vi.mock('../portalIdentityAccounts', () => ({ createIdentityOnlyAccount: m.createIdentityOnlyAccount }));
vi.mock('../portalUserIdentities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../portalUserIdentities')>()),
  findPortalUserIdByEntraIdentity: m.findPortalUserIdByEntraIdentity,
  linkPortalUserIdentity: m.linkPortalUserIdentity,
}));
vi.mock('../clientAiEntraAddress', () => ({ resolveLinkableEntraAddress: m.resolveLinkableEntraAddress }));

import { portalUserIdentities, portalUsers } from '../../db/schema';
import { entraIssuer } from '../portalUserIdentities';
import { resolvePortalOidcSignIn, type ResolvePortalOidcSignInInput } from './accountResolution';

const TID = '11111111-2222-4333-8444-555555555555';
const OID = '66666666-7777-4888-9999-000000000000';
const ORG = '0b9d6a52-8f43-4c5e-9a1d-2f6c7b8e9d01';
const OTHER_ORG = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const PARTNER = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
const USER = '44444444-4444-4444-8444-444444444444';
const OTHER_USER = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2027-02-01T12:00:00.000Z');
const HASH = 'a'.repeat(64);

type Mode = 'invited_only' | 'approval' | 'instant';
function policy(opts: { entra?: boolean; ssoOnly?: boolean; mode?: Mode } = {}) {
  const v = <T>(value: T) => ({ value, source: 'org' as const });
  return {
    orgId: ORG,
    partnerId: PARTNER,
    effective: {
      entraEnabled: v(opts.entra ?? true),
      googleEnabled: v(false),
      passwordMode: v(opts.ssoOnly ? 'sso_only' as const : 'allowed' as const),
      selfRegistrationMode: v('off' as const),
      ssoNewPersonMode: v(opts.mode ?? 'approval'),
      ssoSessionMaxHours: v(12),
    },
    passwordModeFallback: false,
    fingerprint: 'f',
    entraTenant: { tenantId: TID, provenAt: NOW.toISOString() },
  };
}

const identity = {
  provider: 'entra' as const,
  issuer: entraIssuer(TID),
  subject: OID,
  entraTenantId: TID,
  upn: 'jane@acme.example',
  emailClaim: null,
  emailDomainOwnerVerified: false,
  name: 'Jane',
};

const consumer = vi.fn<ResolvePortalOidcSignInInput['inviteConsumer']>();

function input(over: Partial<ResolvePortalOidcSignInInput> = {}): ResolvePortalOidcSignInInput {
  return { identity, purpose: { kind: 'login' }, hostOrgId: null, inviteConsumer: consumer, now: NOW, ...over };
}

/** A locked portal_users row (lockAccount's selection). */
function account(over: Record<string, unknown> = {}) {
  return {
    id: USER, email: 'jane@acme.example', name: 'Jane', status: 'active', browserAccess: 'granted', authMethod: 'password',
    authEpoch: 3, hasPasswordHash: true, hasExternalIdentity: true, hasEntraIdentity: true, ...over,
  };
}

const updates = () => h.calls.filter((c) => c.op === 'update');
function setOf(call: Call | undefined): Record<string, unknown> {
  return (call?.steps.find(([n]) => n === 'set')?.[1][0] ?? {}) as Record<string, unknown>;
}
function whereOf(call: Call | undefined) {
  return new PgDialect().sqlToQuery(call!.steps.find(([n]) => n === 'where')![1][0] as SQL);
}
const denied = (reason: string, orgId: string | null = ORG) => ({ kind: 'denied', reason, orgId });

beforeEach(() => {
  h.calls.length = 0;
  h.results.length = 0;
  Object.assign(h.state, { held: false, txDepth: 0, systemDepth: 0, rolledBack: 0, committed: 0 });
  vi.clearAllMocks();
  m.findOrgByProvenEntraTenant.mockResolvedValue({ orgId: ORG, partnerId: PARTNER });
  m.getActiveOrgTenant.mockResolvedValue({ orgId: ORG, partnerId: PARTNER });
  m.resolvePortalAccessPolicy.mockResolvedValue(policy());
  m.findPortalUserIdByEntraIdentity.mockResolvedValue(null);
  m.linkPortalUserIdentity.mockResolvedValue({ kind: 'linked' });
  m.resolveLinkableEntraAddress.mockResolvedValue({ kind: 'linkable', email: 'jane@acme.example' });
  m.createPortalAccessRequest.mockResolvedValue({ kind: 'created', requestId: 'req-1' });
  consumer.mockResolvedValue(null);
});

describe('context', () => {
  it('refuses to run inside a held DB context (the callback holds none; it opens its own)', async () => {
    h.state.held = true;
    await expect(resolvePortalOidcSignIn(input())).rejects.toThrow(/DB context/);
    expect(m.findOrgByProvenEntraTenant).not.toHaveBeenCalled();
  });
});

describe('step 0 — org', () => {
  it('org_unresolved: no PROVEN mapping for the tid (inv. 2)', async () => {
    m.findOrgByProvenEntraTenant.mockResolvedValue(null);
    expect(await resolvePortalOidcSignIn(input())).toEqual(denied('org_unresolved', null));
    expect(m.findOrgByProvenEntraTenant).toHaveBeenCalledWith(TID);
    expect(m.findPortalUserIdByEntraIdentity).not.toHaveBeenCalled();
  });

  it('org_unresolved: an identity whose issuer is not entraIssuer(tid) is refused before any lookup', async () => {
    const forged = { ...identity, issuer: 'https://login.microsoftonline.com/common/v2.0' };
    expect(await resolvePortalOidcSignIn(input({ identity: forged }))).toEqual(denied('org_unresolved', null));
    expect(m.findOrgByProvenEntraTenant).not.toHaveBeenCalled();
  });

  it('host_mismatch: a custom-domain host whose org differs from the proven org (inv. 1)', async () => {
    expect(await resolvePortalOidcSignIn(input({ hostOrgId: OTHER_ORG }))).toEqual(denied('host_mismatch'));
    expect(m.getActiveOrgTenant).not.toHaveBeenCalled();
  });

  it('a matching host passes the host check', async () => {
    m.resolvePortalAccessPolicy.mockResolvedValue(policy({ mode: 'invited_only' }));
    h.results.push([]); // account-exists check
    expect(await resolvePortalOidcSignIn(input({ hostOrgId: ORG }))).toEqual(denied('invited_only'));
  });

  it('org_unavailable: the org or its partner is not active', async () => {
    m.getActiveOrgTenant.mockResolvedValue(null);
    expect(await resolvePortalOidcSignIn(input())).toEqual(denied('org_unavailable'));
    expect(m.resolvePortalAccessPolicy).not.toHaveBeenCalled();
  });

  it('method_off: the effective policy does not allow Microsoft', async () => {
    m.resolvePortalAccessPolicy.mockResolvedValue(policy({ entra: false }));
    expect(await resolvePortalOidcSignIn(input())).toEqual(denied('method_off'));
    expect(m.resolvePortalAccessPolicy).toHaveBeenCalledWith(ORG);
    expect(m.findPortalUserIdByEntraIdentity).not.toHaveBeenCalled();
  });

  it('link_invalid: a link state for another org than the proven one', async () => {
    const purpose = { kind: 'link' as const, portalUserId: USER, orgId: OTHER_ORG, authEpoch: 3 };
    expect(await resolvePortalOidcSignIn(input({ purpose }))).toEqual(denied('link_invalid'));
    expect(m.findPortalUserIdByEntraIdentity).not.toHaveBeenCalled();
  });
});

describe('step 1 — identity found', () => {
  beforeEach(() => {
    m.findPortalUserIdByEntraIdentity.mockResolvedValue({ portalUserId: USER, orgId: ORG });
  });

  it('looks the identity up by (entraIssuer(tid), oid) under a system context', async () => {
    h.results.push([account()], [], []);
    await resolvePortalOidcSignIn(input());
    expect(m.findPortalUserIdByEntraIdentity).toHaveBeenCalledWith(expect.anything(), { tid: TID, oid: OID });
  });

  it('identity_other_org: the identity lives in another org (inv. 4)', async () => {
    m.findPortalUserIdByEntraIdentity.mockResolvedValue({ portalUserId: USER, orgId: OTHER_ORG });
    expect(await resolvePortalOidcSignIn(input())).toEqual(denied('identity_other_org'));
    expect(updates()).toHaveLength(0);
  });

  it('identity_conflict: an invite while the identity is bound — the invite is never consumed (D11)', async () => {
    const out = await resolvePortalOidcSignIn(input({ purpose: { kind: 'invite', inviteTokenHash: HASH } }));
    expect(out).toEqual(denied('identity_conflict'));
    expect(consumer).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(0);
  });

  it('identity_conflict: a link for a different account than the identity\'s (D11)', async () => {
    const purpose = { kind: 'link' as const, portalUserId: OTHER_USER, orgId: ORG, authEpoch: 3 };
    expect(await resolvePortalOidcSignIn(input({ purpose }))).toEqual(denied('identity_conflict'));
    expect(m.linkPortalUserIdentity).not.toHaveBeenCalled();
  });

  it('linked: a link for the identity\'s own account is idempotent and writes nothing', async () => {
    const purpose = { kind: 'link' as const, portalUserId: USER, orgId: ORG, authEpoch: 3 };
    expect(await resolvePortalOidcSignIn(input({ purpose }))).toEqual({ kind: 'linked', portalUserId: USER, orgId: ORG });
    expect(h.calls).toHaveLength(0);
  });

  it.each([['disabled'], ['invited']])('account_inactive: the account is %s', async (status) => {
    h.results.push([account({ status })]);
    expect(await resolvePortalOidcSignIn(input())).toEqual(denied('account_inactive'));
    expect(updates()).toHaveLength(0);
    expect(h.state.rolledBack).toBe(1);
  });

  it('session (identity): locks the row FOR UPDATE, touches last_used_at and keeps the hash under allowed', async () => {
    h.results.push([account()], [], []);
    const out = await resolvePortalOidcSignIn(input());
    expect(out).toEqual({ kind: 'session', portalUserId: USER, orgId: ORG, authEpoch: 3, entraTenantId: TID, via: 'identity' });

    const lock = h.calls[0]!;
    expect(lock.op).toBe('select');
    expect(lock.inTx).toBe(true);
    expect(lock.steps.filter(([n]) => n === 'for')).toEqual([['for', ['update']]]);

    const [touch, login] = updates();
    expect(touch!.args[0]).toBe(portalUserIdentities);
    expect(setOf(touch)).toEqual({ lastUsedAt: NOW });
    expect(whereOf(touch).params).toEqual(expect.arrayContaining([entraIssuer(TID), OID, USER]));
    expect(login!.args[0]).toBe(portalUsers);
    expect(setOf(login)).toEqual({ lastLoginAt: NOW, updatedAt: NOW });
    expect(h.state.committed).toBe(1);
  });

  it('session (identity) while effectively sso_only also nulls password_hash, with NO epoch bump (D12 lazy convergence)', async () => {
    m.resolvePortalAccessPolicy.mockResolvedValue(policy({ ssoOnly: true }));
    h.results.push([account()], [], []);
    const out = await resolvePortalOidcSignIn(input());
    expect(out).toMatchObject({ kind: 'session', authEpoch: 3, via: 'identity' });
    const login = updates()[1]!;
    expect(setOf(login)).toEqual({ lastLoginAt: NOW, updatedAt: NOW, passwordHash: null });
    expect(setOf(login)).not.toHaveProperty('authEpoch');
  });
});

describe('step 5 — add-in account (identity found, browser_access none)', () => {
  beforeEach(() => {
    m.findPortalUserIdByEntraIdentity.mockResolvedValue({ portalUserId: USER, orgId: ORG });
  });
  const addin = () => account({ browserAccess: 'none', authMethod: 'entra', hasPasswordHash: false, name: null });

  it('invited_only → denied invited_only, nothing written', async () => {
    m.resolvePortalAccessPolicy.mockResolvedValue(policy({ mode: 'invited_only' }));
    h.results.push([addin()]);
    expect(await resolvePortalOidcSignIn(input())).toEqual(denied('invited_only'));
    expect(updates()).toHaveLength(0);
    expect(m.createPortalAccessRequest).not.toHaveBeenCalled();
  });

  it('approval → an addin_user request referencing the account, created outside any transaction', async () => {
    m.resolvePortalAccessPolicy.mockResolvedValue(policy({ mode: 'approval' }));
    h.results.push([addin()]);
    m.createPortalAccessRequest.mockImplementation(async () => {
      expect(h.state.systemDepth).toBe(0);
      return { kind: 'already_pending', requestId: 'req-1' };
    });
    expect(await resolvePortalOidcSignIn(input())).toEqual({ kind: 'request_sent', orgId: ORG });
    expect(m.createPortalAccessRequest).toHaveBeenCalledWith(
      { source: 'addin_user', orgId: ORG, portalUserId: USER, email: 'jane@acme.example', name: 'Jane' },
      NOW,
    );
    expect(updates()).toHaveLength(0);
  });

  it('approval at the cap → denied requests_capped', async () => {
    h.results.push([addin()]);
    m.createPortalAccessRequest.mockResolvedValue({ kind: 'capped' });
    expect(await resolvePortalOidcSignIn(input())).toEqual(denied('requests_capped'));
  });

  it('instant → sso_instant_grant: browser granted WITHOUT an epoch bump, guarded by the read epoch', async () => {
    m.resolvePortalAccessPolicy.mockResolvedValue(policy({ mode: 'instant' }));
    h.results.push([addin()], [{ authEpoch: 3 }], []);
    const out = await resolvePortalOidcSignIn(input());
    expect(out).toEqual({ kind: 'session', portalUserId: USER, orgId: ORG, authEpoch: 3, entraTenantId: TID, via: 'instant_grant' });
    const [grant, touch] = updates();
    expect(grant!.args[0]).toBe(portalUsers);
    expect(setOf(grant)).toEqual({ status: 'active', browserAccess: 'granted', lastLoginAt: NOW, updatedAt: NOW });
    expect(whereOf(grant).params).toEqual(expect.arrayContaining([USER, ORG, 3]));
    expect(touch!.args[0]).toBe(portalUserIdentities);
  });

  it('instant: an epoch that moved under the grant → account_inactive, rolled back', async () => {
    m.resolvePortalAccessPolicy.mockResolvedValue(policy({ mode: 'instant' }));
    h.results.push([addin()], []);
    expect(await resolvePortalOidcSignIn(input())).toEqual(denied('account_inactive'));
    expect(h.state.rolledBack).toBe(1);
  });
});

describe('step 2 — invite', () => {
  const purpose = { kind: 'invite' as const, inviteTokenHash: HASH };
  const invited = (over: Record<string, unknown> = {}) =>
    account({ status: 'invited', hasPasswordHash: false, hasExternalIdentity: false, hasEntraIdentity: false, ...over });

  /** Every invite branch first reads the legacy (entra_tenant_id, entra_oid) key; these cases find it free. */
  beforeEach(() => {
    h.results.push([]);
  });
  const writes = () => h.calls.filter((c) => c.op !== 'select');

  it('identity_conflict: a login holds the legacy entra_* pair with no identity row — refused BEFORE the invite is consumed (D11)', async () => {
    h.results.length = 0;
    h.results.push([{ id: OTHER_USER }]);
    consumer.mockResolvedValue({ portalUserId: USER, orgId: ORG, authEpoch: 3 });

    expect(await resolvePortalOidcSignIn(input({ purpose }))).toEqual(denied('identity_conflict'));
    expect(consumer).not.toHaveBeenCalled();
    expect(m.linkPortalUserIdentity).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(0);

    // The read: any portal_users row at (tid, oid), under a system context, outside any transaction.
    const [legacy] = h.calls;
    expect(legacy!.op).toBe('select');
    expect(legacy!.inTx).toBe(false);
    expect(legacy!.steps.find(([n]) => n === 'from')?.[1][0]).toBe(portalUsers);
    expect(whereOf(legacy).params).toEqual([TID, OID]);
  });

  it('the legacy key check runs before the consumer, which still runs with no DB context held', async () => {
    const order: string[] = [];
    consumer.mockImplementation(async () => {
      order.push(`consume after ${h.calls.length} read(s)`);
      expect(h.state.systemDepth).toBe(0);
      return null;
    });
    expect(await resolvePortalOidcSignIn(input({ purpose }))).toEqual(denied('invite_invalid'));
    expect(order).toEqual(['consume after 1 read(s)']);
  });

  it('invite_invalid: the consumer returns nothing', async () => {
    expect(await resolvePortalOidcSignIn(input({ purpose }))).toEqual(denied('invite_invalid'));
    expect(consumer).toHaveBeenCalledWith(HASH);
    expect(writes()).toHaveLength(0);
  });

  it('invite_invalid: the consumed invite is for another org', async () => {
    consumer.mockResolvedValue({ portalUserId: USER, orgId: OTHER_ORG, authEpoch: 3 });
    expect(await resolvePortalOidcSignIn(input({ purpose }))).toEqual(denied('invite_invalid'));
    expect(writes()).toHaveLength(0);
  });

  it('the consumer runs with no DB context held and before the transaction (the token is spent first)', async () => {
    consumer.mockImplementation(async () => {
      expect(h.state.systemDepth).toBe(0);
      return null;
    });
    await resolvePortalOidcSignIn(input({ purpose }));
    expect(consumer).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the account already has an entra identity', invited({ hasEntraIdentity: true, hasExternalIdentity: true })],
    ['the epoch moved since the invite was issued', invited({ authEpoch: 4 })],
    ['the account is no longer invited', invited({ status: 'active' })],
    ['the account lost browser access', invited({ browserAccess: 'none' })],
  ])('invite_invalid: %s — no link, rolled back', async (_name, row) => {
    consumer.mockResolvedValue({ portalUserId: USER, orgId: ORG, authEpoch: 3 });
    h.results.push([row]);
    expect(await resolvePortalOidcSignIn(input({ purpose }))).toEqual(denied('invite_invalid'));
    expect(m.linkPortalUserIdentity).not.toHaveBeenCalled();
    expect(updates()).toHaveLength(0);
  });

  it('invite_invalid: the account row is gone', async () => {
    consumer.mockResolvedValue({ portalUserId: USER, orgId: ORG, authEpoch: 3 });
    h.results.push([]);
    expect(await resolvePortalOidcSignIn(input({ purpose }))).toEqual(denied('invite_invalid'));
  });

  it('identity_conflict: the identity link conflicts — rolled back', async () => {
    consumer.mockResolvedValue({ portalUserId: USER, orgId: ORG, authEpoch: 3 });
    h.results.push([invited()]);
    m.linkPortalUserIdentity.mockResolvedValue({ kind: 'conflict' });
    expect(await resolvePortalOidcSignIn(input({ purpose }))).toEqual(denied('identity_conflict'));
    expect(updates()).toHaveLength(0);
    expect(h.state.rolledBack).toBe(1);
  });

  it('invite_invalid: the activation loses its epoch guard — rolled back with the link', async () => {
    consumer.mockResolvedValue({ portalUserId: USER, orgId: ORG, authEpoch: 3 });
    h.results.push([invited()], []);
    expect(await resolvePortalOidcSignIn(input({ purpose }))).toEqual(denied('invite_invalid'));
    expect(m.linkPortalUserIdentity).toHaveBeenCalledTimes(1);
    expect(h.state.rolledBack).toBe(1);
  });

  it('session (invite): links (linked_via invite), activates with an epoch bump guarded by the payload epoch, auth_method untouched (D13)', async () => {
    consumer.mockResolvedValue({ portalUserId: USER, orgId: ORG, authEpoch: 3 });
    h.results.push([invited({ name: null })], [{ authEpoch: 4 }]);
    const out = await resolvePortalOidcSignIn(input({ purpose }));
    expect(out).toEqual({ kind: 'session', portalUserId: USER, orgId: ORG, authEpoch: 4, entraTenantId: TID, via: 'invite' });
    expect(m.linkPortalUserIdentity).toHaveBeenCalledWith(expect.anything(), {
      orgId: ORG, portalUserId: USER, provider: 'entra', tid: TID, oid: OID, linkedVia: 'invite', clearPasswordHash: false, now: NOW,
    });
    const [activate] = updates();
    const set = setOf(activate);
    expect(set).toMatchObject({ status: 'active', browserAccess: 'granted', lastLoginAt: NOW, updatedAt: NOW, name: 'Jane' });
    expect(set).toHaveProperty('authEpoch');
    expect(set).not.toHaveProperty('authMethod');
    expect(whereOf(activate).params).toEqual(expect.arrayContaining([USER, ORG, 3]));
  });

  it('session (invite) while effectively sso_only links with clearPasswordHash (D12)', async () => {
    m.resolvePortalAccessPolicy.mockResolvedValue(policy({ ssoOnly: true }));
    consumer.mockResolvedValue({ portalUserId: USER, orgId: ORG, authEpoch: 3 });
    h.results.push([invited()], [{ authEpoch: 4 }]);
    await resolvePortalOidcSignIn(input({ purpose }));
    expect(m.linkPortalUserIdentity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ clearPasswordHash: true }));
  });
});

describe('step 3 — link (signed-in account)', () => {
  const purpose = { kind: 'link' as const, portalUserId: USER, orgId: ORG, authEpoch: 3 };
  const signedIn = (over: Record<string, unknown> = {}) =>
    account({ hasExternalIdentity: false, hasEntraIdentity: false, ...over });

  it.each([
    ['the account is gone', null],
    ['the account is disabled', signedIn({ status: 'disabled' })],
    ['the account has no browser access', signedIn({ browserAccess: 'none' })],
    ['the session epoch is stale', signedIn({ authEpoch: 4 })],
    ['the account already has an entra identity', signedIn({ hasEntraIdentity: true })],
  ])('link_invalid: %s', async (_name, row) => {
    h.results.push(row ? [row] : []);
    expect(await resolvePortalOidcSignIn(input({ purpose }))).toEqual(denied('link_invalid'));
    expect(m.linkPortalUserIdentity).not.toHaveBeenCalled();
  });

  it('linked: self_link on the signed-in account, hash kept under allowed', async () => {
    h.results.push([signedIn()]);
    expect(await resolvePortalOidcSignIn(input({ purpose }))).toEqual({ kind: 'linked', portalUserId: USER, orgId: ORG });
    expect(m.linkPortalUserIdentity).toHaveBeenCalledWith(expect.anything(), {
      orgId: ORG, portalUserId: USER, provider: 'entra', tid: TID, oid: OID, linkedVia: 'self_link', clearPasswordHash: false, now: NOW,
    });
  });

  it('linked under sso_only clears the hash (D12)', async () => {
    m.resolvePortalAccessPolicy.mockResolvedValue(policy({ ssoOnly: true }));
    h.results.push([signedIn()]);
    await resolvePortalOidcSignIn(input({ purpose }));
    expect(m.linkPortalUserIdentity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ clearPasswordHash: true }));
  });

  it('identity_conflict: the link conflicts (a concurrent link took the identity) — rolled back', async () => {
    h.results.push([signedIn()]);
    m.linkPortalUserIdentity.mockResolvedValue({ kind: 'conflict' });
    expect(await resolvePortalOidcSignIn(input({ purpose }))).toEqual(denied('identity_conflict'));
    expect(h.state.rolledBack).toBe(1);
  });
});

describe('step 4 — new person (login, no identity)', () => {
  it('reads the linkable address under a system context with the org and partner (D10)', async () => {
    m.resolvePortalAccessPolicy.mockResolvedValue(policy({ mode: 'invited_only' }));
    m.resolveLinkableEntraAddress.mockImplementation(async () => {
      expect(h.state.systemDepth).toBe(1);
      return { kind: 'refused', outcome: 'unverified-address' };
    });
    h.results.push([]);
    await resolvePortalOidcSignIn(input());
    expect(m.resolveLinkableEntraAddress).toHaveBeenCalledWith(ORG, PARTNER, identity);
  });

  it('account_exists: an account at the UPN or the linkable address — no link is created (inv. 5)', async () => {
    m.resolveLinkableEntraAddress.mockResolvedValue({ kind: 'linkable', email: 'jane.doe@acme.example' });
    h.results.push([{ id: OTHER_USER }]);
    expect(await resolvePortalOidcSignIn(input())).toEqual({ kind: 'account_exists', orgId: ORG });
    const where = whereOf(h.calls[0]);
    expect(where.sql).toContain('lower("portal_users"."email")');
    expect(where.params).toEqual(expect.arrayContaining([ORG, 'jane.doe@acme.example', 'jane@acme.example']));
    expect(m.createPortalAccessRequest).not.toHaveBeenCalled();
    expect(m.createIdentityOnlyAccount).not.toHaveBeenCalled();
    expect(m.linkPortalUserIdentity).not.toHaveBeenCalled();
  });

  it('no_address: neither a UPN nor a linkable address', async () => {
    m.resolveLinkableEntraAddress.mockResolvedValue({ kind: 'refused', outcome: 'unusable-address' });
    const out = await resolvePortalOidcSignIn(input({ identity: { ...identity, upn: null } }));
    expect(out).toEqual(denied('no_address'));
    expect(h.calls).toHaveLength(0);
  });

  it('invited_only → denied invited_only', async () => {
    m.resolvePortalAccessPolicy.mockResolvedValue(policy({ mode: 'invited_only' }));
    h.results.push([]);
    expect(await resolvePortalOidcSignIn(input())).toEqual(denied('invited_only'));
    expect(m.createPortalAccessRequest).not.toHaveBeenCalled();
  });

  it.each([['created'], ['already_pending']])('approval → an entra request (%s) → request_sent, outside any transaction', async (kind) => {
    m.resolveLinkableEntraAddress.mockResolvedValue({ kind: 'refused', outcome: 'unverified-address' });
    h.results.push([]);
    m.createPortalAccessRequest.mockImplementation(async () => {
      expect(h.state.systemDepth).toBe(0);
      return { kind, requestId: 'req-1' };
    });
    expect(await resolvePortalOidcSignIn(input())).toEqual({ kind: 'request_sent', orgId: ORG });
    // Not linkable → the lowercased UPN (D10).
    expect(m.createPortalAccessRequest).toHaveBeenCalledWith(
      { source: 'entra', orgId: ORG, email: 'jane@acme.example', name: 'Jane', tid: TID, oid: OID },
      NOW,
    );
  });

  it('approval at the cap → denied requests_capped', async () => {
    h.results.push([]);
    m.createPortalAccessRequest.mockResolvedValue({ kind: 'capped' });
    expect(await resolvePortalOidcSignIn(input())).toEqual(denied('requests_capped'));
  });

  it('instant → createIdentityOnlyAccount(sso_instant) in a transaction → session (instant); contact only for the linkable address', async () => {
    m.resolvePortalAccessPolicy.mockResolvedValue(policy({ mode: 'instant' }));
    h.results.push([]);
    m.createIdentityOnlyAccount.mockImplementation(async () => {
      expect(h.state.txDepth).toBe(1);
      return { kind: 'created', portalUserId: USER, authEpoch: 1 };
    });
    const out = await resolvePortalOidcSignIn(input());
    expect(out).toEqual({ kind: 'session', portalUserId: USER, orgId: ORG, authEpoch: 1, entraTenantId: TID, via: 'instant' });
    expect(m.createIdentityOnlyAccount).toHaveBeenCalledWith(expect.anything(), {
      orgId: ORG, provider: 'entra', tid: TID, oid: OID, email: 'jane@acme.example', name: 'Jane',
      contactAddress: 'jane@acme.example', actorUserId: null, writer: 'sso_instant', now: NOW,
    });
  });

  it('instant with no linkable address: the UPN is the email and no contact is linked (D10)', async () => {
    m.resolvePortalAccessPolicy.mockResolvedValue(policy({ mode: 'instant' }));
    m.resolveLinkableEntraAddress.mockResolvedValue({ kind: 'refused', outcome: 'unverified-address' });
    h.results.push([]);
    m.createIdentityOnlyAccount.mockResolvedValue({ kind: 'created', portalUserId: USER, authEpoch: 1 });
    await resolvePortalOidcSignIn(input());
    expect(m.createIdentityOnlyAccount).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      email: 'jane@acme.example', contactAddress: null,
    }));
  });

  it('instant: account_exists from the writer (raced under the address lock) → account_exists', async () => {
    m.resolvePortalAccessPolicy.mockResolvedValue(policy({ mode: 'instant' }));
    h.results.push([]);
    m.createIdentityOnlyAccount.mockResolvedValue({ kind: 'account_exists' });
    expect(await resolvePortalOidcSignIn(input())).toEqual({ kind: 'account_exists', orgId: ORG });
  });

  it('instant: identity_linked → rolled back, step 1 retried once → session on the winner\'s account', async () => {
    m.resolvePortalAccessPolicy.mockResolvedValue(policy({ mode: 'instant' }));
    h.results.push([], [account({ authMethod: 'entra', hasPasswordHash: false })], [], []);
    m.createIdentityOnlyAccount.mockResolvedValue({ kind: 'identity_linked' });
    m.findPortalUserIdByEntraIdentity
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ portalUserId: USER, orgId: ORG });
    const out = await resolvePortalOidcSignIn(input());
    expect(out).toEqual({ kind: 'session', portalUserId: USER, orgId: ORG, authEpoch: 3, entraTenantId: TID, via: 'identity' });
    expect(h.state.rolledBack).toBe(1);
    expect(m.findPortalUserIdByEntraIdentity).toHaveBeenCalledTimes(2);
  });

  it('instant: identity_linked and the retry still finds no identity → identity_conflict (one retry only)', async () => {
    m.resolvePortalAccessPolicy.mockResolvedValue(policy({ mode: 'instant' }));
    h.results.push([]);
    m.createIdentityOnlyAccount.mockResolvedValue({ kind: 'identity_linked' });
    expect(await resolvePortalOidcSignIn(input())).toEqual(denied('identity_conflict'));
    expect(m.findPortalUserIdByEntraIdentity).toHaveBeenCalledTimes(2);
    expect(m.createIdentityOnlyAccount).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// W7 (#11384, plan Task 5): Google through the same resolver (D2–D4, D9, D13,
// D15). Appended; every case above is unchanged. vi.hoisted / vi.mock are
// hoisted to the top of the file by vitest.
// ===========================================================================

const gm = vi.hoisted(() => ({
  findOrgByVerifiedDomain: vi.fn(),
  isDomainVerifiedForOrg: vi.fn(),
  lockVerifiedDomainRow: vi.fn(),
}));
vi.mock('../portalDomainVerification', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../portalDomainVerification')>()),
  findOrgByVerifiedDomain: gm.findOrgByVerifiedDomain,
  isDomainVerifiedForOrg: gm.isDomainVerifiedForOrg,
  lockVerifiedDomainRow: gm.lockVerifiedDomainRow,
}));

describe('W7 google', () => {
  const HD = 'acme.example.com';
  const SUB = '109876543210987654321';
  const GOOGLE_ISSUER = 'https://accounts.google.com';
  const VERIFIED_AT = new Date('2027-01-31T08:00:00.000Z');
  const EMAIL = `pat@${HD}`;
  const gIdentity = {
    provider: 'google' as const,
    issuer: GOOGLE_ISSUER as 'https://accounts.google.com',
    subject: SUB,
    entraTenantId: null,
    upn: null,
    emailClaim: EMAIL as string | null,
    emailDomainOwnerVerified: true,
    name: 'Pat',
    googleHostedDomain: HD,
  };
  const gInput = (over: Partial<ResolvePortalOidcSignInInput> = {}) => input({ identity: gIdentity, ...over });
  function gPolicy(opts: { google?: boolean; ssoOnly?: boolean; mode?: Mode } = {}) {
    const p = policy({ entra: false, ssoOnly: opts.ssoOnly, mode: opts.mode });
    const google = opts.google ?? true;
    return {
      ...p,
      effective: { ...p.effective, googleEnabled: { value: google, source: 'org' as const } },
      googleDomains: google ? [HD] : null,
    };
  }
  const gSession = (over: Record<string, unknown>) => ({
    kind: 'session', portalUserId: USER, orgId: ORG, method: 'google', entraTenantId: null, googleHostedDomain: HD, ...over,
  });
  /** Where the google fence ran: [transaction depth, db calls made before it]. */
  let fenceAt: Array<[number, number]> = [];

  beforeEach(() => {
    fenceAt = [];
    gm.findOrgByVerifiedDomain.mockResolvedValue({ domain: HD, orgId: ORG, partnerId: PARTNER, method: 'dns_txt', verifiedAt: VERIFIED_AT });
    gm.isDomainVerifiedForOrg.mockResolvedValue(false);
    gm.lockVerifiedDomainRow.mockImplementation(async () => {
      fenceAt.push([h.state.txDepth, h.calls.length]);
      return true;
    });
    m.resolvePortalAccessPolicy.mockResolvedValue(gPolicy());
  });

  describe('step 0', () => {
    it('google: unverified or declared-only hd → org_unresolved', async () => {
      // RF2, inv. 2: findOrgByVerifiedDomain answers only a CURRENT verification;
      // a declared-only row or a lapsed one reads as null.
      gm.findOrgByVerifiedDomain.mockResolvedValue(null);
      expect(await resolvePortalOidcSignIn(gInput())).toEqual(denied('org_unresolved', null));
      expect(gm.findOrgByVerifiedDomain).toHaveBeenCalledWith(HD);
      expect(m.findOrgByProvenEntraTenant).not.toHaveBeenCalled();
      expect(m.getActiveOrgTenant).not.toHaveBeenCalled();
      expect(h.calls).toHaveLength(0);
    });

    it('google: hd verified for org B never signs into org A; custom host for A + hd for B → host_mismatch', async () => {
      // inv. 1: the org is the hd's, never the host's.
      gm.findOrgByVerifiedDomain.mockResolvedValue({ domain: HD, orgId: OTHER_ORG, partnerId: PARTNER, method: 'dns_txt', verifiedAt: VERIFIED_AT });
      expect(await resolvePortalOidcSignIn(gInput({ hostOrgId: ORG }))).toEqual(denied('host_mismatch', OTHER_ORG));
      expect(m.getActiveOrgTenant).not.toHaveBeenCalled();
      expect(h.calls).toHaveLength(0);

      // On the shared host the sign-in lands in B (the hd's org), never A.
      m.resolvePortalAccessPolicy.mockResolvedValue(gPolicy({ mode: 'invited_only' }));
      h.results.push([], []);
      expect(await resolvePortalOidcSignIn(gInput())).toEqual(denied('invited_only', OTHER_ORG));
      expect(m.getActiveOrgTenant).toHaveBeenCalledWith(OTHER_ORG);
      expect(m.resolvePortalAccessPolicy).toHaveBeenCalledWith(OTHER_ORG);
      expect(whereOf(h.calls[1]).params).toEqual(expect.arrayContaining([OTHER_ORG, EMAIL]));
      expect(whereOf(h.calls[1]).params).not.toContain(ORG);
    });

    it('google: googleEnabled off (masked or set) → method_off', async () => {
      m.resolvePortalAccessPolicy.mockResolvedValue(gPolicy({ google: false }));
      expect(await resolvePortalOidcSignIn(gInput())).toEqual(denied('method_off'));
      // Microsoft on does not let a Google identity in.
      m.resolvePortalAccessPolicy.mockResolvedValue(policy({ entra: true }));
      expect(await resolvePortalOidcSignIn(gInput())).toEqual(denied('method_off'));
      expect(h.calls).toHaveLength(0);
    });

    it('google: an identity of the wrong shape (issuer) is refused before any read', async () => {
      const forged = { ...gIdentity, issuer: 'https://evil.example.com' as 'https://accounts.google.com' };
      expect(await resolvePortalOidcSignIn(gInput({ identity: forged }))).toEqual(denied('org_unresolved', null));
      expect(gm.findOrgByVerifiedDomain).not.toHaveBeenCalled();
    });
  });

  describe('step 1 — google identity found', () => {
    it('looks up (PORTAL_GOOGLE_ISSUER, sub) only, never the Entra reader; session pinned to hd, no fence', async () => {
      h.results.push([{ portalUserId: USER, orgId: ORG }], [account({ hasEntraIdentity: false, hasGoogleIdentity: true })], [], []);
      const out = await resolvePortalOidcSignIn(gInput());
      expect(out).toEqual(gSession({ authEpoch: 3, via: 'identity' }));
      expect(m.findPortalUserIdByEntraIdentity).not.toHaveBeenCalled();
      const lookup = whereOf(h.calls[0]);
      expect(lookup.params).toEqual(['google', GOOGLE_ISSUER, SUB]);
      const [touch] = updates();
      expect(touch!.args[0]).toBe(portalUserIdentities);
      expect(whereOf(touch).params).toEqual(expect.arrayContaining([GOOGLE_ISSUER, SUB, USER]));
      // D15: a plain session is read-only for placement; D7's per-request check covers it.
      expect(gm.lockVerifiedDomainRow).not.toHaveBeenCalled();
    });

    it('identity_other_org: a google identity in another org (inv. 4)', async () => {
      h.results.push([{ portalUserId: USER, orgId: OTHER_ORG }]);
      expect(await resolvePortalOidcSignIn(gInput())).toEqual(denied('identity_other_org'));
      expect(updates()).toHaveLength(0);
    });

    it('step 5, instant: the browser grant is fenced first; a fence refusal → org_unresolved, rolled back', async () => {
      m.resolvePortalAccessPolicy.mockResolvedValue(gPolicy({ mode: 'instant' }));
      const addin = account({ browserAccess: 'none', authMethod: 'google', hasPasswordHash: false, hasGoogleIdentity: true });
      h.results.push([{ portalUserId: USER, orgId: ORG }], [addin], [{ authEpoch: 3 }], []);
      expect(await resolvePortalOidcSignIn(gInput())).toEqual(gSession({ authEpoch: 3, via: 'instant_grant' }));
      expect(fenceAt).toEqual([[1, 2]]);

      h.calls.length = 0;
      gm.lockVerifiedDomainRow.mockResolvedValue(false);
      h.results.push([{ portalUserId: USER, orgId: ORG }], [addin]);
      expect(await resolvePortalOidcSignIn(gInput())).toEqual(denied('org_unresolved'));
      expect(updates()).toHaveLength(0);
    });

    it('step 5, invited_only: a google identity on a browser_access none account gets no session', async () => {
      m.resolvePortalAccessPolicy.mockResolvedValue(gPolicy({ mode: 'invited_only' }));
      h.results.push([{ portalUserId: USER, orgId: ORG }], [account({ browserAccess: 'none', hasGoogleIdentity: true })]);
      expect(await resolvePortalOidcSignIn(gInput())).toEqual(denied('invited_only'));
      expect(updates()).toHaveLength(0);
    });
  });

  describe('step 2 — google invite', () => {
    const purpose = { kind: 'invite' as const, inviteTokenHash: HASH };
    const invited = (over: Record<string, unknown> = {}) => account({
      status: 'invited', hasPasswordHash: false, hasExternalIdentity: false, hasEntraIdentity: false, hasGoogleIdentity: false, ...over,
    });

    it('no legacy pre-check; fence first in the transaction; links (google, sub) linked_via invite → session pinned to hd', async () => {
      consumer.mockResolvedValue({ portalUserId: USER, orgId: ORG, authEpoch: 3 });
      h.results.push([], [invited()], [{ authEpoch: 4 }]);
      const out = await resolvePortalOidcSignIn(gInput({ purpose }));
      expect(out).toEqual(gSession({ authEpoch: 4, via: 'invite' }));
      // Only the identity lookup ran before the fence: no portal_users legacy read for Google.
      expect(fenceAt).toEqual([[1, 1]]);
      expect(gm.lockVerifiedDomainRow).toHaveBeenCalledWith(expect.anything(), { orgId: ORG, domain: HD, verifiedAt: VERIFIED_AT });
      expect(m.linkPortalUserIdentity).toHaveBeenCalledWith(expect.anything(), {
        orgId: ORG, portalUserId: USER, provider: 'google', sub: SUB, linkedVia: 'invite', clearPasswordHash: false, now: NOW,
      });
      expect(setOf(updates()[0])).not.toHaveProperty('authMethod');
    });

    it('an account that already has an entra identity accepts a google invite (one identity per provider)', async () => {
      consumer.mockResolvedValue({ portalUserId: USER, orgId: ORG, authEpoch: 3 });
      h.results.push([], [invited({ hasEntraIdentity: true, hasExternalIdentity: true })], [{ authEpoch: 4 }]);
      expect(await resolvePortalOidcSignIn(gInput({ purpose }))).toMatchObject({ kind: 'session', via: 'invite', method: 'google' });
    });

    it('invite_invalid: the invited account already has a google identity — no link', async () => {
      consumer.mockResolvedValue({ portalUserId: USER, orgId: ORG, authEpoch: 3 });
      h.results.push([], [invited({ hasGoogleIdentity: true, hasExternalIdentity: true })]);
      expect(await resolvePortalOidcSignIn(gInput({ purpose }))).toEqual(denied('invite_invalid'));
      expect(m.linkPortalUserIdentity).not.toHaveBeenCalled();
      expect(updates()).toHaveLength(0);
    });

    it('a bound google identity never completes an invite: identity_conflict, invite NOT consumed (D11)', async () => {
      h.results.push([{ portalUserId: USER, orgId: ORG }]);
      expect(await resolvePortalOidcSignIn(gInput({ purpose }))).toEqual(denied('identity_conflict'));
      expect(consumer).not.toHaveBeenCalled();
    });

    it('the fence refuses (hd no longer verified for the org) → org_unresolved, nothing linked', async () => {
      consumer.mockResolvedValue({ portalUserId: USER, orgId: ORG, authEpoch: 3 });
      gm.lockVerifiedDomainRow.mockResolvedValue(false);
      h.results.push([]);
      expect(await resolvePortalOidcSignIn(gInput({ purpose }))).toEqual(denied('org_unresolved'));
      expect(m.linkPortalUserIdentity).not.toHaveBeenCalled();
      expect(h.state.rolledBack).toBe(1);
    });
  });

  describe('step 3 — google link', () => {
    const purpose = { kind: 'link' as const, portalUserId: USER, orgId: ORG, authEpoch: 3 };

    it('an entra-linked account links google (self_link), fenced first', async () => {
      h.results.push([], [account({ hasEntraIdentity: true, hasGoogleIdentity: false })]);
      expect(await resolvePortalOidcSignIn(gInput({ purpose }))).toEqual({ kind: 'linked', portalUserId: USER, orgId: ORG });
      expect(fenceAt).toEqual([[1, 1]]);
      expect(m.linkPortalUserIdentity).toHaveBeenCalledWith(expect.anything(), {
        orgId: ORG, portalUserId: USER, provider: 'google', sub: SUB, linkedVia: 'self_link', clearPasswordHash: false, now: NOW,
      });
    });

    it('a google-linked account linking a second google identity is refused (link_invalid, W4 parity), no link', async () => {
      h.results.push([], [account({ hasEntraIdentity: false, hasGoogleIdentity: true })]);
      expect(await resolvePortalOidcSignIn(gInput({ purpose }))).toEqual(denied('link_invalid'));
      expect(m.linkPortalUserIdentity).not.toHaveBeenCalled();
    });

    it('the fence refuses → org_unresolved, nothing linked', async () => {
      gm.lockVerifiedDomainRow.mockResolvedValue(false);
      h.results.push([]);
      expect(await resolvePortalOidcSignIn(gInput({ purpose }))).toEqual(denied('org_unresolved'));
      expect(m.linkPortalUserIdentity).not.toHaveBeenCalled();
    });
  });

  describe('step 4 — google new person', () => {
    it('google new person with an existing same-email account → account_exists, no link', async () => {
      // RF1, inv. 5: instant mode would otherwise create or link.
      m.resolvePortalAccessPolicy.mockResolvedValue(gPolicy({ mode: 'instant' }));
      h.results.push([], [{ id: OTHER_USER }], []);
      expect(await resolvePortalOidcSignIn(gInput())).toEqual({ kind: 'account_exists', orgId: ORG });
      const where = whereOf(h.calls[1]);
      expect(where.sql).toContain('lower("portal_users"."email")');
      expect(where.params).toEqual([ORG, EMAIL]);
      expect(m.createIdentityOnlyAccount).not.toHaveBeenCalled();
      expect(m.linkPortalUserIdentity).not.toHaveBeenCalled();
      expect(m.createPortalAccessRequest).not.toHaveBeenCalled();
      expect(gm.lockVerifiedDomainRow).not.toHaveBeenCalled();
    });

    it('google: approval → google request with sub and hostedDomain; instant → identity-only google account', async () => {
      h.results.push([], []);
      m.createPortalAccessRequest.mockImplementation(async () => {
        expect(h.state.systemDepth).toBe(0);
        return { kind: 'created', requestId: 'req-1' };
      });
      expect(await resolvePortalOidcSignIn(gInput())).toEqual({ kind: 'request_sent', orgId: ORG });
      expect(m.createPortalAccessRequest).toHaveBeenCalledWith(
        { source: 'google', orgId: ORG, email: EMAIL, name: 'Pat', sub: SUB, hostedDomain: HD },
        NOW,
      );

      m.resolvePortalAccessPolicy.mockResolvedValue(gPolicy({ mode: 'instant' }));
      h.results.push([], []);
      m.createIdentityOnlyAccount.mockImplementation(async () => {
        expect(h.state.txDepth).toBe(1);
        expect(fenceAt).toHaveLength(1); // fenced before the write
        return { kind: 'created', portalUserId: USER, authEpoch: 1 };
      });
      expect(await resolvePortalOidcSignIn(gInput())).toEqual(gSession({ authEpoch: 1, via: 'instant' }));
      expect(m.createIdentityOnlyAccount).toHaveBeenCalledWith(expect.anything(), {
        orgId: ORG, provider: 'google', sub: SUB, email: EMAIL, name: 'Pat',
        contactAddress: EMAIL, actorUserId: null, writer: 'sso_instant', now: NOW,
      });
      expect(gm.lockVerifiedDomainRow).toHaveBeenCalledWith(expect.anything(), { orgId: ORG, domain: HD, verifiedAt: VERIFIED_AT });
    });

    it('instant: an email on a domain not verified for the org → the account, no contact (D3)', async () => {
      m.resolvePortalAccessPolicy.mockResolvedValue(gPolicy({ mode: 'instant' }));
      h.results.push([], []);
      m.createIdentityOnlyAccount.mockResolvedValue({ kind: 'created', portalUserId: USER, authEpoch: 1 });
      const identity = { ...gIdentity, emailClaim: 'pat@personal.example.com' };
      await resolvePortalOidcSignIn(gInput({ identity }));
      expect(gm.isDomainVerifiedForOrg).toHaveBeenCalledWith('personal.example.com', ORG);
      expect(m.createIdentityOnlyAccount).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        email: 'pat@personal.example.com', contactAddress: null,
      }));
    });

    it('instant: the hd is displaced between step 0 and the write → org_unresolved, rolled back, no step-1 retry', async () => {
      m.resolvePortalAccessPolicy.mockResolvedValue(gPolicy({ mode: 'instant' }));
      gm.lockVerifiedDomainRow.mockResolvedValue(false);
      h.results.push([], []);
      expect(await resolvePortalOidcSignIn(gInput())).toEqual(denied('org_unresolved'));
      expect(m.createIdentityOnlyAccount).not.toHaveBeenCalled();
      expect(h.state.rolledBack).toBe(1);
      expect(h.calls.filter((c) => c.op === 'select')).toHaveLength(2); // lookup + account-exists; no retry
    });

    it('google: invited_only → invited_only', async () => {
      m.resolvePortalAccessPolicy.mockResolvedValue(gPolicy({ mode: 'invited_only' }));
      h.results.push([], []);
      expect(await resolvePortalOidcSignIn(gInput())).toEqual(denied('invited_only'));
      expect(m.createPortalAccessRequest).not.toHaveBeenCalled();
      expect(m.createIdentityOnlyAccount).not.toHaveBeenCalled();
    });

    it('no_address: a google identity without an email claim', async () => {
      h.results.push([]);
      expect(await resolvePortalOidcSignIn(gInput({ identity: { ...gIdentity, emailClaim: null } }))).toEqual(denied('no_address'));
    });
  });
});

describe('W7 D9 — a conflicting pending request is refused, never overwritten', () => {
  it('entra approval: claims_conflict → request_conflict (was request_sent before W7)', async () => {
    h.results.push([]);
    m.createPortalAccessRequest.mockResolvedValue({ kind: 'claims_conflict', requestId: 'req-other' });
    expect(await resolvePortalOidcSignIn(input())).toEqual(denied('request_conflict'));
  });

  it('google approval: claims_conflict → request_conflict', async () => {
    const base = policy({ entra: false });
    m.resolvePortalAccessPolicy.mockResolvedValue({
      ...base,
      effective: { ...base.effective, googleEnabled: { value: true, source: 'org' as const } },
      googleDomains: ['acme.example.com'],
    });
    gm.findOrgByVerifiedDomain.mockResolvedValue({
      domain: 'acme.example.com', orgId: ORG, partnerId: PARTNER, method: 'dns_txt', verifiedAt: NOW,
    });
    h.results.push([], []);
    m.createPortalAccessRequest.mockResolvedValue({ kind: 'claims_conflict', requestId: 'req-other' });
    const identity = {
      provider: 'google' as const, issuer: 'https://accounts.google.com' as const, subject: 'sub-1', entraTenantId: null,
      upn: null, emailClaim: 'pat@acme.example.com', emailDomainOwnerVerified: true, name: 'Pat', googleHostedDomain: 'acme.example.com',
    };
    expect(await resolvePortalOidcSignIn(input({ identity }))).toEqual(denied('request_conflict'));
  });

  it('step 5 add-in request: claims_conflict → request_conflict', async () => {
    m.findPortalUserIdByEntraIdentity.mockResolvedValue({ portalUserId: USER, orgId: ORG });
    h.results.push([account({ browserAccess: 'none', authMethod: 'entra', hasPasswordHash: false })]);
    m.createPortalAccessRequest.mockResolvedValue({ kind: 'claims_conflict', requestId: 'req-other' });
    expect(await resolvePortalOidcSignIn(input())).toEqual(denied('request_conflict'));
  });
});
