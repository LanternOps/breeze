/**
 * #3258 follow-up — an Entra SSO login is attached to a CONTACT.
 *
 * The Entra exchange auto-provisions a `portal_users` row from token claims on
 * first use. Until this change it left `contact_id` NULL, so an add-in user who
 * had also emailed support existed twice in one org — once as a login, once as
 * a contact — and their portal view could not see their own emailed tickets
 * (`routes/portal/ticketOwnership.ts` matches on the contact).
 *
 * What is asserted here is the DECISION (which org, which address, which
 * outcome, and what is written); the resolver's own rules — the advisory lock,
 * the shared-mailbox refusal, the role union — are proved in
 * `contacts/loginLink.test.ts` against real compiled SQL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { linkLoginToContactMock, getOrgPolicyMock, isPermittedMock, valuesSpy, setSpy, selectResult, insertReturning } =
  vi.hoisted(() => ({
    linkLoginToContactMock: vi.fn(),
    getOrgPolicyMock: vi.fn(),
    isPermittedMock: vi.fn(),
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
  return {
    withSystemDbAccessContext: (fn: () => Promise<unknown>) => fn(),
    db: {
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
    },
  };
});
vi.mock('./clientAiPolicy', () => ({
  getOrgPolicy: getOrgPolicyMock,
  isClientUserPermitted: isPermittedMock,
}));
vi.mock('./contacts/loginLink', () => ({ linkLoginToContact: linkLoginToContactMock }));

import { resolveAndMintClientSession } from './clientAiExchange';
import type { ClientAiEntraClaims } from './clientAiEntraJwt';

const ORG_ID = '3f1c0b2a-1111-4222-8333-444455556666';
const claims = (over: Partial<ClientAiEntraClaims> = {}): ClientAiEntraClaims =>
  ({
    tid: 'tenant-guid',
    oid: 'oid-guid',
    email: 'jane@customer.example',
    name: 'Jane Client',
    aud: 'api://breeze',
    iss: 'https://login.microsoftonline.com/tenant-guid/v2.0',
    exp: 0,
    iat: 0,
    ...over,
  }) as ClientAiEntraClaims;

const redis = { setex: vi.fn(), sadd: vi.fn(), expire: vi.fn() } as never;

/** mapping row, then the portal-user lookup row(s). */
const seedSelects = (user: Array<Record<string, unknown>>) => {
  selectResult
    .mockResolvedValueOnce([{ orgId: ORG_ID, partnerEnabled: true }])
    .mockResolvedValueOnce(user);
};

beforeEach(() => {
  vi.clearAllMocks();
  getOrgPolicyMock.mockResolvedValue({ enabled: true, branding: null, userAccess: 'all', selectedUserIds: [] });
  isPermittedMock.mockReturnValue(true);
});

describe('resolveAndMintClientSession — contact linkage (#3258)', () => {
  it('links a contact on the FIRST exchange and writes it onto the new login', async () => {
    seedSelects([]);
    linkLoginToContactMock.mockResolvedValueOnce({ contactId: 'ct-1', outcome: 'created' });
    insertReturning.mockResolvedValueOnce([
      { id: 'pu-1', orgId: ORG_ID, email: 'jane@customer.example', name: 'Jane Client', status: 'active', contactId: 'ct-1' },
    ]);

    const outcome = await resolveAndMintClientSession(claims(), redis);

    // The LOGIN's own org — never re-derived from the address, so the link
    // stays inside the tenant the Entra tenant mapping resolved to.
    expect(linkLoginToContactMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: ORG_ID,
        email: 'jane@customer.example',
        name: 'Jane Client',
        actor: { userId: null },
      }),
    );
    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'ct-1' }));
    expect(outcome.kind).toBe('resolved');
    expect(outcome.audit.details).toMatchObject({ provisioned: true, contactLink: 'created' });
  });

  it('never offers the synthetic @entra.invalid fallback as a contact address', async () => {
    // portal_users.email is NOT NULL, so a token with no address gets a
    // synthetic non-routable one. A contact keyed on that would be an
    // unreachable person in the customer's address book.
    seedSelects([]);
    linkLoginToContactMock.mockResolvedValueOnce({ contactId: null, outcome: 'unusable-address' });
    insertReturning.mockResolvedValueOnce([
      { id: 'pu-1', orgId: ORG_ID, email: 'oid-guid@tenant-guid.entra.invalid', name: null, status: 'active', contactId: null },
    ]);

    const outcome = await resolveAndMintClientSession(claims({ email: null, name: null }), redis);

    expect(linkLoginToContactMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ email: null }),
    );
    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'oid-guid@tenant-guid.entra.invalid', contactId: null }),
    );
    expect(outcome.kind).toBe('resolved');
    expect(outcome.audit.details).toMatchObject({ contactLink: 'unusable-address' });
  });

  it('still mints a session when the address is a shared mailbox, leaving the login unlinked', async () => {
    seedSelects([]);
    linkLoginToContactMock.mockResolvedValueOnce({ contactId: null, outcome: 'ambiguous' });
    insertReturning.mockResolvedValueOnce([
      { id: 'pu-1', orgId: ORG_ID, email: 'support@customer.example', name: null, status: 'active', contactId: null },
    ]);

    const outcome = await resolveAndMintClientSession(claims({ email: 'support@customer.example' }), redis);

    // An unresolvable PERSON must not deny a valid LOGIN — the token is still
    // a verified Entra identity. The audit says why the link is null.
    expect(outcome.kind).toBe('resolved');
    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ contactId: null }));
    expect(outcome.audit.details).toMatchObject({ contactLink: 'ambiguous' });
  });

  it('backfills the link on a LATER login that predates this change', async () => {
    seedSelects([{ id: 'pu-old', orgId: ORG_ID, email: 'jane@customer.example', name: 'Jane', status: 'active', contactId: null }]);
    linkLoginToContactMock.mockResolvedValueOnce({ contactId: 'ct-9', outcome: 'linked' });

    const outcome = await resolveAndMintClientSession(claims(), redis);

    expect(linkLoginToContactMock).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy.mock.calls[0]![0]).toMatchObject({ contactId: 'ct-9' });
    expect(outcome.kind).toBe('resolved');
    expect(outcome.audit.details).toMatchObject({ provisioned: false, contactLink: 'linked' });
  });

  it('NEVER re-derives a link the login already has', async () => {
    seedSelects([{ id: 'pu-old', orgId: ORG_ID, email: 'jane@customer.example', name: 'Jane', status: 'active', contactId: 'ct-existing' }]);

    const outcome = await resolveAndMintClientSession(claims(), redis);

    // Whoever set it — the 2026-08-19 backfill, an invite, a tech editing the
    // contact — knew more than an email string does.
    expect(linkLoginToContactMock).not.toHaveBeenCalled();
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy.mock.calls[0]![0]).not.toHaveProperty('contactId');
    expect(outcome.audit.details).toMatchObject({ contactLink: 'kept' });
  });

  it('resolves the winner row on the concurrent first-exchange 23505 race', async () => {
    selectResult
      .mockResolvedValueOnce([{ orgId: ORG_ID, partnerEnabled: true }])
      .mockResolvedValueOnce([]) // first lookup: nothing yet
      .mockResolvedValueOnce([
        { id: 'pu-winner', orgId: ORG_ID, email: 'jane@customer.example', name: 'Jane', status: 'active', contactId: 'ct-1' },
      ]);
    linkLoginToContactMock.mockResolvedValueOnce({ contactId: 'ct-1', outcome: 'linked' });
    insertReturning.mockRejectedValueOnce(Object.assign(new Error('dup'), { cause: { code: '23505' } }));

    const outcome = await resolveAndMintClientSession(claims(), redis);

    expect(outcome.kind).toBe('resolved');
    // The advisory lock inside the resolver serialises the two callers, so the
    // loser sees the contact the winner made rather than minting a duplicate.
    expect(linkLoginToContactMock).toHaveBeenCalledTimes(1);
  });

  it('does not resolve a contact for a denied tenant', async () => {
    selectResult.mockResolvedValueOnce([]); // no tenant mapping
    const outcome = await resolveAndMintClientSession(claims(), redis);
    expect(outcome.kind).toBe('denied');
    expect(linkLoginToContactMock).not.toHaveBeenCalled();
  });
});
