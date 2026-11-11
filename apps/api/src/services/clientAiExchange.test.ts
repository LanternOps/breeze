/**
 * #3258 follow-up — an Entra SSO login is attached to a CONTACT.
 *
 * The Entra exchange auto-provisions a `portal_users` row from token claims on
 * first use. Until this change it left `contact_id` NULL, so an add-in user who
 * had also emailed support existed twice in one org — once as a login, once as
 * a contact — and their portal view could not see their own emailed tickets
 * (`routes/portal/ticketOwnership.ts` matches on the contact).
 *
 * What is asserted here is the DECISION (which org, which address, when, and
 * what is written); the resolver's own rules — the advisory lock, the
 * shared-mailbox refusal, the role union — are proved in
 * `contacts/loginLink.test.ts` against real compiled SQL, and the address
 * trust rule in `clientAiEntraAddress.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  txSentinel,
  linkLoginToContactMock,
  resolveAddressMock,
  getOrgPolicyMock,
  isPermittedMock,
  captureExceptionMock,
  valuesSpy,
  setSpy,
  selectResult,
  insertReturning,
  whereSpy,
  joinSpy,
  ensureIdentityMock,
} = vi.hoisted(() => ({
  // Identity of the executor handed to a nested `db.transaction` callback, so a
  // test can tell savepoint work from outer-transaction work.
  txSentinel: {} as Record<string, unknown>,
  linkLoginToContactMock: vi.fn(),
  resolveAddressMock: vi.fn(),
  getOrgPolicyMock: vi.fn(),
  isPermittedMock: vi.fn(),
  captureExceptionMock: vi.fn(),
  valuesSpy: vi.fn(),
  setSpy: vi.fn(),
  selectResult: vi.fn(),
  insertReturning: vi.fn(),
  whereSpy: vi.fn(),
  joinSpy: vi.fn(),
  ensureIdentityMock: vi.fn(),
}));

vi.mock('../db', () => {
  const chain: any = {
    from: () => chain,
    innerJoin: (table: unknown, on: unknown) => { joinSpy(table, on); return chain; },
    where: (w: unknown) => { whereSpy(w); return chain; },
    limit: () => selectResult(),
  };
  const methods = {
    select: vi.fn(() => chain),
    insert: vi.fn(() => ({
      values: (v: unknown) => {
        valuesSpy(v);
        return { returning: () => insertReturning() };
      },
    })),
    update: vi.fn(() => ({
      set: (v: unknown) => {
        setSpy(v);
        return { where: () => Promise.resolve() };
      },
    })),
  };
  // A nested transaction is a SAVEPOINT in production. The callback receives a
  // DISTINCT executor with the same surface, so a test can tell work that ran
  // inside the savepoint from work that ran on the outer transaction.
  Object.assign(txSentinel, methods);
  const dbMock: any = {
    ...methods,
    transaction: (fn: (tx: unknown) => unknown) => fn(txSentinel),
  };
  return {
    withSystemDbAccessContext: (fn: () => Promise<unknown>) => fn(),
    // A savepoint in production; a pass-through here.
    withDbTransaction: (fn: () => Promise<unknown>) => fn(),
    db: dbMock,
  };
});
vi.mock('./clientAiPolicy', () => ({
  getOrgPolicy: getOrgPolicyMock,
  isClientUserPermitted: isPermittedMock,
}));
vi.mock('./contacts/loginLink', () => ({ linkLoginToContact: linkLoginToContactMock }));
vi.mock('./clientAiEntraAddress', () => ({ resolveLinkableEntraAddress: resolveAddressMock }));
vi.mock('./sentry', () => ({ captureException: captureExceptionMock }));
// insertEntraIdentity stays REAL (it must land on the savepoint executor);
// only the existing-login self-heal is stubbed.
vi.mock('./portalUserIdentities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./portalUserIdentities')>()),
  ensureEntraIdentity: ensureIdentityMock,
}));

import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../db';
import { portalUserIdentities, portalUsers } from '../db/schema';
import { resolveAndMintClientSession } from './clientAiExchange';
import type { ClientAiEntraClaims } from './clientAiEntraJwt';
import { entraIssuer } from './portalUserIdentities';

const ORG_ID = '3f1c0b2a-1111-4222-8333-444455556666';
const PARTNER_ID = '9a9a9a9a-1111-4222-8333-444455556666';
const EMAIL = 'jane@customer.example';

const claims = (over: Partial<ClientAiEntraClaims> = {}): ClientAiEntraClaims =>
  ({
    tid: 'tenant-guid',
    oid: 'oid-guid',
    email: EMAIL,
    upn: EMAIL,
    emailClaim: null,
    emailDomainOwnerVerified: false,
    name: 'Jane Client',
    aud: 'api://breeze',
    iss: 'https://login.microsoftonline.com/tenant-guid/v2.0',
    exp: 0,
    iat: 0,
    scp: null,
    ...over,
  }) as ClientAiEntraClaims;

const redisMock = { setex: vi.fn(), sadd: vi.fn(), expire: vi.fn() };
const redis = redisMock as never;

/** mapping row, then the portal-user lookup row(s). */
const seedSelects = (user: Array<Record<string, unknown>>) => {
  selectResult
    .mockResolvedValueOnce([{ orgId: ORG_ID, partnerId: PARTNER_ID, partnerEnabled: true }])
    .mockResolvedValueOnce(user);
};

const activeUser = (over: Record<string, unknown> = {}) => ({
  id: 'pu-1',
  orgId: ORG_ID,
  email: EMAIL,
  name: 'Jane',
  status: 'active',
  authMethod: 'entra',
  authEpoch: 1,
  contactId: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` clears CALLS but not queued `mockResolvedValueOnce`
  // implementations, and a test that denies early leaves its unconsumed queue
  // entries behind to be picked up by the next test's first query. Reset the
  // two queues outright, then re-establish a safe default.
  selectResult.mockReset();
  selectResult.mockResolvedValue([]);
  insertReturning.mockReset();
  insertReturning.mockResolvedValue([]);
  getOrgPolicyMock.mockResolvedValue({ enabled: true, branding: null, userAccess: 'all', selectedUserIds: [] });
  isPermittedMock.mockReturnValue(true);
  resolveAddressMock.mockResolvedValue({ kind: 'linkable', email: EMAIL });
  linkLoginToContactMock.mockResolvedValue({ contactId: 'ct-1', outcome: 'created' });
  ensureIdentityMock.mockResolvedValue('present');
});

describe('resolveAndMintClientSession — contact linkage (#3258)', () => {
  it('binds the minted Redis session to the live portal auth epoch', async () => {
    seedSelects([activeUser({ authEpoch: 7, contactId: 'ct-existing' })]);

    await resolveAndMintClientSession(claims(), redis);

    const payload = JSON.parse(redisMock.setex.mock.calls[0]![2] as string);
    expect(payload).toMatchObject({ portalUserId: 'pu-1', orgId: ORG_ID, authEpoch: 7 });
  });

  it('links a contact on the FIRST exchange and writes it onto the new login', async () => {
    seedSelects([]);
    insertReturning.mockResolvedValueOnce([activeUser()]);

    const outcome = await resolveAndMintClientSession(claims(), redis);

    // The LOGIN's own org — never re-derived from the address, so the link
    // stays inside the tenant the Entra tenant mapping resolved to.
    expect(linkLoginToContactMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId: ORG_ID, email: EMAIL, name: 'Jane Client', actor: { userId: null } }),
    );
    expect(outcome.kind).toBe('resolved');
    // Written by a follow-up UPDATE, not the INSERT: the link is only made once
    // the exchange is known to be granting a session (A1).
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'ct-1' }));
    expect(outcome.audit.details).toMatchObject({
      provisioned: true,
      contactLink: 'created',
      contactId: 'ct-1',
      linkAddress: EMAIL,
    });
  });

  it('claims the portal role, and unions it onto an existing contact', async () => {
    seedSelects([]);
    insertReturning.mockResolvedValueOnce([activeUser()]);
    await resolveAndMintClientSession(claims(), redis);
    // An Entra login IS portal access, unlike the add-in's ticket requester.
    expect(linkLoginToContactMock.mock.calls[0]![1]).toMatchObject({
      roles: ['portal'],
      unionRoles: ['portal'],
    });
  });

  // ---- A1: nothing is written to `contacts` on a path that will 403 ----

  it('writes NO contact when the policy does not permit the user', async () => {
    seedSelects([activeUser({ contactId: null })]);
    isPermittedMock.mockReturnValue(false);

    const outcome = await resolveAndMintClientSession(claims(), redis);

    expect(outcome.kind).toBe('denied');
    expect(linkLoginToContactMock).not.toHaveBeenCalled();
    expect(resolveAddressMock).not.toHaveBeenCalled();
    expect(outcome.audit.details).toMatchObject({
      reason: 'user_not_permitted',
      contactLink: 'not-attempted',
    });
  });

  it('writes NO contact for a deactivated login', async () => {
    seedSelects([activeUser({ status: 'disabled' })]);

    const outcome = await resolveAndMintClientSession(claims(), redis);

    expect(outcome.kind).toBe('denied');
    expect(linkLoginToContactMock).not.toHaveBeenCalled();
    // No `contactId` in the .set() either — the pre-gate write is lastLoginAt only.
    expect(setSpy.mock.calls.every((c) => !('contactId' in (c[0] as object)))).toBe(true);
    expect(outcome.audit.details).toMatchObject({ reason: 'account_inactive', contactLink: 'not-attempted' });
  });

  it('mints for an account found by its entra identity regardless of auth_method', async () => {
    // Identities release B (plan D5): the identity lookup IS the gate. The
    // account the Entra identity resolves to gets the add-in session whatever
    // its auth_method (W4 links identities to password accounts).
    seedSelects([activeUser({ authMethod: 'password', contactId: 'ct-1' })]);

    const outcome = await resolveAndMintClientSession(claims(), redis);

    expect(outcome.kind).toBe('resolved');
    expect(outcome.audit.details).not.toMatchObject({ reason: 'identity_method_mismatch' });
    expect(redisMock.setex).toHaveBeenCalledTimes(1);
  });

  // ---- S1: only an address the customer demonstrably owns may link ----

  it('provisions UNLINKED when the address is not one the org owns', async () => {
    seedSelects([]);
    resolveAddressMock.mockResolvedValue({ kind: 'refused', outcome: 'unverified-address' });
    insertReturning.mockResolvedValueOnce([activeUser()]);

    const outcome = await resolveAndMintClientSession(claims({ upn: 'jane@evil.example' }), redis);

    // The SSO login still works — only the identity claim is refused.
    expect(outcome.kind).toBe('resolved');
    expect(linkLoginToContactMock).not.toHaveBeenCalled();
    expect(setSpy.mock.calls.every((c) => !('contactId' in (c[0] as object)))).toBe(true);
    expect(outcome.audit.details).toMatchObject({ contactLink: 'unverified-address', contactId: null });
  });

  it('passes the org AND partner from the server-derived mapping to the address rule', async () => {
    seedSelects([]);
    insertReturning.mockResolvedValueOnce([activeUser()]);
    await resolveAndMintClientSession(claims(), redis);
    expect(resolveAddressMock).toHaveBeenCalledWith(ORG_ID, PARTNER_ID, expect.anything());
  });

  it('links only the address the rule VOUCHED for, not the display address', async () => {
    // The rule may accept the xms_edov email claim while `claims.email` shows
    // something else; the linked identity must be the vouched one.
    seedSelects([]);
    resolveAddressMock.mockResolvedValue({ kind: 'linkable', email: 'vouched@customer.example' });
    insertReturning.mockResolvedValueOnce([activeUser({ email: 'vouched@customer.example' })]);

    await resolveAndMintClientSession(claims({ email: 'display@customer.example' }), redis);

    expect(linkLoginToContactMock.mock.calls[0]![1]).toMatchObject({ email: 'vouched@customer.example' });
  });

  it('refuses to link when the vouched address is not the login\'s stored address', async () => {
    // A tenant admin can change a user's UPN. Linking on the new address would
    // move an existing login onto a different person's contact.
    seedSelects([activeUser({ email: 'old.name@customer.example', contactId: null })]);
    resolveAddressMock.mockResolvedValue({ kind: 'linkable', email: 'new.name@customer.example' });

    const outcome = await resolveAndMintClientSession(claims(), redis);

    expect(outcome.kind).toBe('resolved');
    expect(linkLoginToContactMock).not.toHaveBeenCalled();
    expect(outcome.audit.details).toMatchObject({ contactLink: 'address-mismatch' });
  });

  it('compares the stored address case-insensitively', async () => {
    seedSelects([activeUser({ email: 'Jane@Customer.Example', contactId: null })]);
    resolveAddressMock.mockResolvedValue({ kind: 'linkable', email: 'jane@customer.example' });

    const outcome = await resolveAndMintClientSession(claims(), redis);

    expect(outcome.kind).toBe('resolved');
    expect(linkLoginToContactMock).toHaveBeenCalledTimes(1);
  });

  it('reports an address-less token as unusable, and still mints a session', async () => {
    seedSelects([]);
    resolveAddressMock.mockResolvedValue({ kind: 'refused', outcome: 'unusable-address' });
    insertReturning.mockResolvedValueOnce([
      activeUser({ email: 'oid-guid@tenant-guid.entra.invalid' }),
    ]);

    const outcome = await resolveAndMintClientSession(claims({ email: null, upn: null, name: null }), redis);

    expect(outcome.kind).toBe('resolved');
    // portal_users.email is NOT NULL, so the login keeps a synthetic address —
    // but nothing keys a CONTACT on it.
    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'oid-guid@tenant-guid.entra.invalid' }),
    );
    expect(outcome.audit.details).toMatchObject({ contactLink: 'unusable-address', contactId: null });
  });

  // ---- S2: a login found by tenant+oid may sit in a STALE org ----

  it('denies the exchange when the login belongs to another org than the mapping', async () => {
    // Re-mapping a tenant to a different org leaves the old logins behind. The
    // lookup is by (tenant, oid) only, so without this the backfill would write
    // a contact into the stale org and mint a session against it.
    seedSelects([activeUser({ orgId: 'aaaaaaaa-0000-4000-8000-000000000000' })]);

    const outcome = await resolveAndMintClientSession(claims(), redis);

    expect(outcome.kind).toBe('denied');
    if (outcome.kind !== 'denied') return;
    expect(outcome.status).toBe(403);
    expect(outcome.body.error).toBe('org_mismatch');
    expect(linkLoginToContactMock).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
    expect(outcome.audit.details).toMatchObject({ reason: 'org_mismatch', contactLink: 'not-attempted' });
  });

  it('runs the contact link inside a SAVEPOINT, not on the outer transaction', async () => {
    // postgres.js re-throws a database error at COMMIT time even after it has
    // been caught (see catalogService/ticketConfigService), so a deadlock or
    // 23503 raised on the outer transaction would still 500 the exchange
    // despite the `link-failed` catch below. Running the link in a savepoint is
    // what makes that catch real — same fix as the provisioning INSERT.
    seedSelects([]);
    insertReturning.mockResolvedValueOnce([activeUser()]);

    await resolveAndMintClientSession(claims(), redis);

    expect(linkLoginToContactMock.mock.calls[0]![0]).toBe(txSentinel);
  });

  // ---- T3: a contacts failure must not deny a valid SSO login ----

  it('provisions with link-failed when the resolver throws', async () => {
    seedSelects([]);
    insertReturning.mockResolvedValueOnce([activeUser()]);
    linkLoginToContactMock.mockRejectedValueOnce(new Error('deadlock detected'));

    const outcome = await resolveAndMintClientSession(claims(), redis);

    // The token is a verified Entra identity; a contacts problem is ours.
    expect(outcome.kind).toBe('resolved');
    expect(outcome.audit.details).toMatchObject({ contactLink: 'link-failed', contactId: null });
    expect(captureExceptionMock).toHaveBeenCalled();
    expect(setSpy.mock.calls.every((c) => !('contactId' in (c[0] as object)))).toBe(true);
  });

  // ---- T4: unresolvable outcomes on the BACKFILL branch write no link ----

  it('omits contactId from the update when the backfill is ambiguous', async () => {
    seedSelects([activeUser({ contactId: null })]);
    linkLoginToContactMock.mockResolvedValueOnce({ contactId: null, outcome: 'ambiguous' });

    const outcome = await resolveAndMintClientSession(claims(), redis);

    expect(outcome.kind).toBe('resolved');
    expect(setSpy.mock.calls.every((c) => !('contactId' in (c[0] as object)))).toBe(true);
    expect(outcome.audit.details).toMatchObject({ contactLink: 'ambiguous', contactId: null });
  });

  it('backfills the link on a LATER login that predates this change', async () => {
    seedSelects([activeUser({ contactId: null })]);
    linkLoginToContactMock.mockResolvedValueOnce({ contactId: 'ct-9', outcome: 'linked' });

    const outcome = await resolveAndMintClientSession(claims(), redis);

    // The backfill uses the LOGIN's own org (equal to the mapping's, per S2).
    expect(linkLoginToContactMock.mock.calls[0]![1]).toMatchObject({ orgId: ORG_ID });
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'ct-9' }));
    expect(outcome.audit.details).toMatchObject({ provisioned: false, contactLink: 'linked', contactId: 'ct-9' });
  });

  it('NEVER re-derives a link the login already has', async () => {
    seedSelects([activeUser({ contactId: 'ct-existing' })]);

    const outcome = await resolveAndMintClientSession(claims(), redis);

    // Whoever set it — the 2026-08-19 backfill, an invite, a tech editing the
    // contact — knew more than an email string does.
    expect(linkLoginToContactMock).not.toHaveBeenCalled();
    expect(resolveAddressMock).not.toHaveBeenCalled();
    expect(setSpy.mock.calls.every((c) => !('contactId' in (c[0] as object)))).toBe(true);
    expect(outcome.audit.details).toMatchObject({ contactLink: 'kept', contactId: 'ct-existing' });
  });

  it('resolves the winner row on the concurrent first-exchange 23505 race', async () => {
    selectResult
      .mockResolvedValueOnce([{ orgId: ORG_ID, partnerId: PARTNER_ID, partnerEnabled: true }])
      .mockResolvedValueOnce([]) // first lookup: nothing yet
      .mockResolvedValueOnce([activeUser({ id: 'pu-winner', contactId: 'ct-1' })]);
    insertReturning.mockRejectedValueOnce(Object.assign(new Error('dup'), { cause: { code: '23505' } }));

    const outcome = await resolveAndMintClientSession(claims(), redis);

    expect(outcome.kind).toBe('resolved');
    // The winner already linked it, so the loser keeps that link untouched.
    expect(outcome.audit.details).toMatchObject({ contactLink: 'kept', contactId: 'ct-1' });
  });

  it('re-selects the concurrent provisioning winner through its identity too, and re-asserts the org', async () => {
    selectResult
      .mockResolvedValueOnce([{ orgId: ORG_ID, partnerId: PARTNER_ID, partnerEnabled: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([activeUser({ id: 'pu-winner', orgId: 'aaaaaaaa-0000-4000-8000-000000000000' })]);
    insertReturning.mockRejectedValueOnce(Object.assign(new Error('dup'), { cause: { code: '23505' } }));

    const outcome = await resolveAndMintClientSession(claims(), redis);

    expect(outcome).toMatchObject({ kind: 'denied', status: 403, body: { error: 'org_mismatch' } });
    expect(linkLoginToContactMock).not.toHaveBeenCalled();
    // [0] mapping, [1] first lookup, [2] the re-select: both lookups go through the identity.
    for (const i of [1, 2]) {
      const rendered = new PgDialect().sqlToQuery(whereSpy.mock.calls[i]![0] as never);
      expect(rendered.sql).toContain('"portal_user_identities"."issuer"');
      expect(rendered.sql).not.toContain('entra_oid');
    }
  });

  it('an existing login whose identity row is missing fails closed (provisioning_failed) and is reported as drift', async () => {
    // Release B reads identities only. A login that still holds the legacy
    // entra_* columns but lost its identity is not found, the JIT insert hits
    // the login's own unique index, and the re-select (by identity) finds
    // nothing: denied, never a second login, never a silent fallback to the
    // columns.
    selectResult
      .mockResolvedValueOnce([{ orgId: ORG_ID, partnerId: PARTNER_ID, partnerEnabled: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    insertReturning.mockRejectedValueOnce(Object.assign(new Error('dup'), {
      cause: { code: '23505', constraint_name: 'portal_users_entra_identity_uniq' },
    }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const outcome = await resolveAndMintClientSession(claims(), redis);
      expect(outcome).toMatchObject({ kind: 'denied', status: 403, body: { error: 'provisioning_failed' } });
      expect(captureExceptionMock).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ eventCode: 'client_ai_identity_drift' }),
      );
      expect(redisMock.setex).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('records not-attempted on the partner-entitlement denial', async () => {
    selectResult.mockResolvedValueOnce([{ orgId: ORG_ID, partnerId: PARTNER_ID, partnerEnabled: false }]);
    const outcome = await resolveAndMintClientSession(claims(), redis);
    expect(outcome.kind).toBe('denied');
    expect(outcome.audit.details).toMatchObject({ reason: 'partner_not_enabled', contactLink: 'not-attempted' });
    expect(linkLoginToContactMock).not.toHaveBeenCalled();
  });

  it('records not-attempted when the org policy is disabled', async () => {
    seedSelects([]);
    getOrgPolicyMock.mockResolvedValue({ enabled: false, branding: null, userAccess: 'all', selectedUserIds: [] });
    const outcome = await resolveAndMintClientSession(claims(), redis);
    expect(outcome.kind).toBe('denied');
    expect(outcome.audit.details).toMatchObject({ reason: 'disabled', contactLink: 'not-attempted' });
    expect(linkLoginToContactMock).not.toHaveBeenCalled();
  });

  it('records not-attempted when provisioning yields no row', async () => {
    seedSelects([]);
    insertReturning.mockResolvedValueOnce([]); // insert returned nothing
    const outcome = await resolveAndMintClientSession(claims(), redis);
    expect(outcome.kind).toBe('denied');
    expect(outcome.audit.details).toMatchObject({ reason: 'provisioning_failed', contactLink: 'not-attempted' });
    expect(linkLoginToContactMock).not.toHaveBeenCalled();
  });

  it('does not resolve a contact for a denied tenant', async () => {
    selectResult.mockResolvedValueOnce([]); // no tenant mapping
    const outcome = await resolveAndMintClientSession(claims(), redis);
    expect(outcome.kind).toBe('denied');
    expect(linkLoginToContactMock).not.toHaveBeenCalled();
    expect(outcome.audit.details).toMatchObject({ contactLink: 'not-attempted' });
  });
});

describe('resolveAndMintClientSession — portal_user_identities dual-write (W2 release A)', () => {
  const insertCalls = () => {
    const insert = vi.mocked(db.insert);
    return insert.mock.calls.map((call, i) => ({ table: call[0], ctx: insert.mock.contexts[i] }));
  };

  it('writes the entra identity inside the same SAVEPOINT as the JIT login insert', async () => {
    seedSelects([]);
    insertReturning.mockResolvedValueOnce([activeUser()]);

    const outcome = await resolveAndMintClientSession(claims(), redis);

    expect(outcome.kind).toBe('resolved');
    const calls = insertCalls();
    expect(calls.map((c) => c.table)).toEqual([portalUsers, portalUserIdentities]);
    // Both on the savepoint executor, never the outer transaction: a 23505 on
    // either rolls back BOTH (no half-provisioned login).
    expect(calls.every((c) => c.ctx === txSentinel)).toBe(true);
    expect(valuesSpy).toHaveBeenNthCalledWith(2, {
      orgId: ORG_ID,
      portalUserId: 'pu-1',
      provider: 'entra',
      issuer: entraIssuer('tenant-guid'),
      subject: 'oid-guid',
      entraTenantId: 'tenant-guid',
      linkedVia: 'jit',
      lastUsedAt: expect.any(Date),
    });
    // A just-provisioned login needs no self-heal.
    expect(ensureIdentityMock).not.toHaveBeenCalled();
  });

  it('JIT inserts browser_access none (an add-in login never grants the browser portal)', async () => {
    seedSelects([]);
    insertReturning.mockResolvedValueOnce([activeUser()]);
    await resolveAndMintClientSession(claims(), redis);
    expect(valuesSpy.mock.calls[0]![0]).toMatchObject({ authMethod: 'entra', browserAccess: 'none', status: 'active' });
  });

  it('ensures the identity on a later exchange', async () => {
    seedSelects([activeUser({ contactId: 'ct-1' })]);
    const outcome = await resolveAndMintClientSession(claims(), redis);
    expect(outcome.kind).toBe('resolved');
    expect(ensureIdentityMock).toHaveBeenCalledWith(db, {
      orgId: ORG_ID,
      portalUserId: 'pu-1',
      tid: 'tenant-guid',
      oid: 'oid-guid',
      usedAt: expect.any(Date),
    });
    expect(captureExceptionMock).not.toHaveBeenCalled();
  });

  it('still mints a session on an identity conflict and reports the drift', async () => {
    seedSelects([activeUser({ contactId: 'ct-1' })]);
    ensureIdentityMock.mockResolvedValueOnce('conflict');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const outcome = await resolveAndMintClientSession(claims(), redis);
      // The login was found THROUGH its identity; a conflict on the use-stamp
      // (an identity moved mid-exchange) is reported, not enforced.
      expect(outcome.kind).toBe('resolved');
      expect(captureExceptionMock).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ eventCode: 'client_ai_identity_drift' }),
      );
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  it('a failing identity self-heal never costs the user their sign-in, and is reported', async () => {
    seedSelects([activeUser({ contactId: 'ct-1' })]);
    ensureIdentityMock.mockRejectedValueOnce(new Error('lock timeout on portal_user_identities'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const outcome = await resolveAndMintClientSession(claims(), redis);
      expect(outcome.kind).toBe('resolved');
      expect(captureExceptionMock).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ eventCode: 'client_ai_identity_write_failed' }),
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it('a JIT identity collision with another login fails closed as provisioning_failed and is reported as drift', async () => {
    selectResult
      .mockResolvedValueOnce([{ orgId: ORG_ID, partnerId: PARTNER_ID, partnerEnabled: true }])
      .mockResolvedValueOnce([]) // no login yet
      .mockResolvedValueOnce([]); // re-select after the savepoint rolled back: nothing
    insertReturning.mockResolvedValueOnce([activeUser()]);
    // The identity insert (2nd values() call) is the one that collides.
    valuesSpy.mockImplementation((v: Record<string, unknown>) => {
      if (v.provider === 'entra') {
        throw Object.assign(new Error('dup'), { cause: { code: '23505', constraint_name: 'portal_user_identities_issuer_subject_uq' } });
      }
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const outcome = await resolveAndMintClientSession(claims(), redis);
      expect(outcome).toMatchObject({ kind: 'denied', status: 403, body: { error: 'provisioning_failed' } });
      expect(captureExceptionMock).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ eventCode: 'client_ai_identity_drift' }),
      );
    } finally {
      errSpy.mockRestore();
      valuesSpy.mockReset();
    }
  });

});

describe('resolveAndMintClientSession — identities release B (W3 read switch)', () => {
  it('resolves the login through portal_user_identities (issuer/subject), not portal_users entra columns', async () => {
    seedSelects([activeUser({ contactId: 'ct-1' })]);
    await resolveAndMintClientSession(claims(), redis);
    // [0] = tenant mapping lookup, [1] = the login lookup.
    const rendered = new PgDialect().sqlToQuery(whereSpy.mock.calls[1]![0] as never);
    expect(rendered.sql).toContain('"portal_user_identities"."provider"');
    expect(rendered.sql).toContain('"portal_user_identities"."issuer"');
    expect(rendered.sql).toContain('"portal_user_identities"."subject"');
    expect(rendered.sql).not.toContain('entra_oid');
    expect(rendered.sql).not.toContain('"portal_users"."entra_tenant_id"');
    expect(rendered.params).toEqual(['entra', entraIssuer('tenant-guid'), 'oid-guid']);
    // The login is the identity's account: joined on portal_user_id = portal_users.id.
    const loginJoin = joinSpy.mock.calls.find((c) => c[0] === portalUserIdentities);
    expect(loginJoin).toBeDefined();
    const on = new PgDialect().sqlToQuery(loginJoin![1] as never);
    expect(on.sql).toBe('"portal_user_identities"."portal_user_id" = "portal_users"."id"');
  });

  it('identity in org B for a tenant mapped to org A → org_mismatch denial, before any write', async () => {
    // The identity (and so its account — composite FK) sits in org B; the
    // token's tenant maps to org A. Never mint against B, never JIT into A.
    seedSelects([activeUser({ orgId: 'bbbbbbbb-0000-4000-8000-000000000000', contactId: 'ct-1' })]);

    const outcome = await resolveAndMintClientSession(claims(), redis);

    expect(outcome).toMatchObject({ kind: 'denied', status: 403, body: { error: 'org_mismatch' } });
    expect(outcome.audit.details).toMatchObject({ reason: 'org_mismatch', loginOrgId: 'bbbbbbbb-0000-4000-8000-000000000000' });
    expect(vi.mocked(db.insert)).not.toHaveBeenCalled();
    expect(vi.mocked(db.update)).not.toHaveBeenCalled();
    expect(ensureIdentityMock).not.toHaveBeenCalled();
    expect(redisMock.setex).not.toHaveBeenCalled();
  });
});
