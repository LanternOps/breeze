/**
 * #3258 follow-up — the Outlook add-in's confirmed requester is a CONTACT.
 *
 * The load-bearing assertion here is a NEGATIVE one: `resolveConfirmedContact`
 * must not write to `portal_users` at all. A login is minted only where portal
 * access is granted, and the add-in grants none — the orphan logins this path
 * used to create were write-only, unreachable by their own customer, and
 * undeletable once a ticket referenced them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { linkLoginToContactMock, insertSpy, selectSpy } = vi.hoisted(() => ({
  linkLoginToContactMock: vi.fn(),
  insertSpy: vi.fn(),
  selectSpy: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: {
    insert: (...args: unknown[]) => {
      insertSpy(...args);
      throw new Error('resolveConfirmedContact must not write to portal_users');
    },
    select: (...args: unknown[]) => {
      selectSpy(...args);
      const chain: any = { from: () => chain, where: () => chain, limit: () => Promise.resolve([]) };
      return chain;
    },
  },
}));
vi.mock('../contacts/loginLink', () => ({ linkLoginToContact: linkLoginToContactMock }));

import { resolveConfirmedContact } from './addinContacts';

const ORG_ID = '11111111-2222-4333-8444-555555555555';
const actor = { userId: 'tech-1' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveConfirmedContact', () => {
  it('resolves the CONTACT for the org and never mints a login', async () => {
    linkLoginToContactMock.mockResolvedValueOnce({ contactId: 'ct-1', outcome: 'created' });

    const result = await resolveConfirmedContact(ORG_ID, { email: 'New.Person@acme.com', name: 'New Person' }, actor);

    expect(result).toEqual({ contactId: 'ct-1', outcome: 'created' });
    expect(insertSpy).not.toHaveBeenCalled();
    expect(linkLoginToContactMock).toHaveBeenCalledWith(
      expect.anything(),
      // The org comes from the CALLER (already reachability-checked by the
      // route), never re-derived from the address — that is what keeps the link
      // inside one tenant.
      { orgId: ORG_ID, email: 'New.Person@acme.com', name: 'New Person', actor },
    );
  });

  it('passes the technician through as the acting user', async () => {
    // A technician-confirmed action, not an ingest side effect: the person who
    // confirmed it is `contacts.created_by`.
    linkLoginToContactMock.mockResolvedValueOnce({ contactId: 'ct-1', outcome: 'linked' });
    await resolveConfirmedContact(ORG_ID, { email: 'a@b.com' }, { userId: 'tech-9' });
    expect(linkLoginToContactMock.mock.calls[0]![1]).toMatchObject({ actor: { userId: 'tech-9' } });
  });

  it('normalises an absent name to null rather than undefined', async () => {
    linkLoginToContactMock.mockResolvedValueOnce({ contactId: null, outcome: 'ambiguous' });
    const result = await resolveConfirmedContact(ORG_ID, { email: 'support@acme.com' }, actor);
    expect(linkLoginToContactMock.mock.calls[0]![1]).toMatchObject({ name: null });
    // A shared mailbox surfaces as an unlinked outcome, not a thrown error —
    // the ticket is still worth creating.
    expect(result).toEqual({ contactId: null, outcome: 'ambiguous' });
  });
});
