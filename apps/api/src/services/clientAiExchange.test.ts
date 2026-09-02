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
  linkLoginToContactMock,
  resolveAddressMock,
  getOrgPolicyMock,
  isPermittedMock,
  captureExceptionMock,
  valuesSpy,
  setSpy,
  selectResult,
  insertReturning,
} = vi.hoisted(() => ({
  linkLoginToContactMock: vi.fn(),
  resolveAddressMock: vi.fn(),
  getOrgPolicyMock: vi.fn(),
  isPermittedMock: vi.fn(),
  captureExceptionMock: vi.fn(),
  valuesSpy: vi.fn(),
  setSpy: vi.fn(),
  selectResult: vi.fn(),
  insertReturning: vi.fn(),
}));

vi.mock('../db', () => {
  const chain: any = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: () => selectResult(),
  };
  const dbMock: any = {
    // A nested transaction is a SAVEPOINT in production; here it is just the
    // callback, so a rejecting insert still surfaces to the caller's catch.
    transaction: (fn: (tx: unknown) => unknown) => fn(dbMock),
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
  return {
    withSystemDbAccessContext: (fn: () => Promise<unknown>) => fn(),
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

import { resolveAndMintClientSession } from './clientAiExchange';
import type { ClientAiEntraClaims } from './clientAiEntraJwt';

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

const redis = { setex: vi.fn(), sadd: vi.fn(), expire: vi.fn() } as never;

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
  contactId: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  getOrgPolicyMock.mockResolvedValue({ enabled: true, branding: null, userAccess: 'all', selectedUserIds: [] });
  isPermittedMock.mockReturnValue(true);
  resolveAddressMock.mockResolvedValue({ kind: 'linkable', email: EMAIL });
  linkLoginToContactMock.mockResolvedValue({ contactId: 'ct-1', outcome: 'created' });
});

describe('resolveAndMintClientSession — contact linkage (#3258)', () => {
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

  it('does not resolve a contact for a denied tenant', async () => {
    selectResult.mockResolvedValueOnce([]); // no tenant mapping
    const outcome = await resolveAndMintClientSession(claims(), redis);
    expect(outcome.kind).toBe('denied');
    expect(linkLoginToContactMock).not.toHaveBeenCalled();
    expect(outcome.audit.details).toMatchObject({ contactLink: 'not-attempted' });
  });
});
