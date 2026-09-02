import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import { INBOUND_CONTACT_LOCK_NAMESPACE } from '../services/inboundEmail/resolveOrg';

const { valuesSpy, setSpy, executeSpy } = vi.hoisted(() => ({ valuesSpy: vi.fn(), setSpy: vi.fn(), executeSpy: vi.fn() }));
const { authRef, selectResult, insertReturning, sendInvite, createContactMock, updateContactMock, auditMock } = vi.hoisted(() => ({
  createContactMock: vi.fn(),
  updateContactMock: vi.fn(),
  auditMock: vi.fn(),
  authRef: { current: { scope: 'partner' as string, user: { id: 'u-1', name: 'Tess', email: 'tess@msp.example' }, partnerId: 'p-1' as string | null, canAccessOrg: (_id: string) => true } },
  selectResult: vi.fn(),
  insertReturning: vi.fn(),
  sendInvite: vi.fn()
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => { c.set('auth', authRef.current); await next(); }),
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next()
}));
vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          // `.for('key share')` pins the matched contact in the same read (the
          // caller writes an FK to it next), so the chain has to return itself.
          const leaf: any = {
          limit: vi.fn(() => selectResult()),
          orderBy: vi.fn(() => selectResult()),
          // bulk-invite's candidates query awaits `.where()` directly with no
          // `.limit()`/`.orderBy()` leaf — make the where-result thenable so
          // `await ...where(x)` also resolves via selectResult().
          then: (resolve: any, reject: any) => selectResult().then(resolve, reject)
          };
          leaf.for = vi.fn(() => leaf);
          return leaf;
        })
      }))
    })),
    insert: vi.fn(() => ({ values: vi.fn((v: unknown) => { valuesSpy(v); return { returning: vi.fn(() => insertReturning()) }; }) })),
    update: vi.fn(() => ({
      set: vi.fn((v: unknown) => { setSpy(v); return ({
        where: vi.fn(() => ({
          returning: vi.fn(() => insertReturning()),
          // bulk-invite's per-user update has no `.returning()` leaf —
          // make the where-result thenable so a bare `await ...where(x)`
          // also resolves via insertReturning().
          then: (resolve: any, reject: any) => insertReturning().then(resolve, reject)
        }))
      }); })
    })),
    delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
    // The invite path takes the SAME namespaced advisory lock the inbound
    // resolver takes (#3258 W03), so the mock has to serve `db.execute`.
    execute: vi.fn((statement: unknown) => { executeSpy(statement); return Promise.resolve([]); })
  }
}));
vi.mock('../db/schema', () => ({
  portalUsers: { id: 'id', orgId: 'orgId', email: 'email', name: 'name', passwordHash: 'passwordHash', receiveNotifications: 'receiveNotifications', status: 'status', invitedBy: 'invitedBy', invitedAt: 'invitedAt', lastLoginAt: 'lastLoginAt', createdAt: 'createdAt', contactId: 'contactId' },
  contacts: { id: 'id', orgId: 'orgId', email: 'email', roles: 'roles' },
  organizations: { id: 'id', name: 'name', deletedAt: 'deletedAt' },
  tickets: { id: 'id', submittedBy: 'submittedBy' },
  ticketComments: { id: 'id', portalUserId: 'portalUserId' },
  assetCheckouts: { id: 'id', checkedOutTo: 'checkedOutTo' }
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: auditMock }));
vi.mock('../services/contacts/crud', async () => {
  const actual = await vi.importActual<typeof import('../services/contacts/crud')>('../services/contacts/crud');
  return { ...actual, createContact: createContactMock, updateContact: updateContactMock };
});
vi.mock('../routes/portal/helpers', () => ({ storePortalInviteToken: vi.fn(async () => 'raw-token'), buildPortalUrl: (p: string) => `https://x/portal${p}` }));
vi.mock('../services/email', () => ({ getEmailService: () => ({ sendPortalInvite: sendInvite }) }));

import { authMiddleware } from '../middleware/auth';
import { registerOrgPortalUsersRoutes } from './orgPortalUsers';

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';
const makeApp = () => { const app = new Hono(); app.use('*', authMiddleware as any); registerOrgPortalUsersRoutes(app); return app; };
beforeEach(() => { vi.clearAllMocks(); authRef.current = { scope: 'partner', user: { id: 'u-1', name: 'Tess', email: 'tess@msp.example' }, partnerId: 'p-1', canAccessOrg: () => true }; });

describe('GET /organizations/:id/portal-users', () => {
  it('lists users with an effective status', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }]) // org existence
      .mockResolvedValueOnce([
        { id: 'pu-1', email: 'a@acme.example', name: 'A', passwordHash: 'h', status: 'active', receiveNotifications: true, lastLoginAt: null, invitedAt: null },
        { id: 'pu-2', email: 'b@acme.example', name: null, passwordHash: null, status: 'active', receiveNotifications: true, lastLoginAt: null, invitedAt: null }
      ]);
    const res = await makeApp().request(`/organizations/${ORG_ID}/portal-users`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((u: any) => u.effectiveStatus)).toEqual(['active', 'pending_setup']);
    expect(JSON.stringify(body)).not.toContain('passwordHash');
  });
});

describe('POST /organizations/:id/portal-users/invite', () => {
  const invite = (body: unknown) => makeApp().request(`/organizations/${ORG_ID}/portal-users/invite`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('creates an invited user and emails a link', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }]) // org existence
      .mockResolvedValueOnce([])               // no existing portal user
      .mockResolvedValueOnce([])               // no contact for the address yet (#3258 W03)
      .mockResolvedValueOnce([{ name: 'Acme Co' }]); // org name
    createContactMock.mockResolvedValueOnce({ id: 'ct-new' });
    insertReturning.mockResolvedValueOnce([{ id: 'pu-new', email: 'new@acme.example', status: 'invited' }]);
    const res = await invite({ email: 'new@acme.example', name: 'New Cust' });
    expect(res.status).toBe(200);
    expect(sendInvite).toHaveBeenCalledWith(expect.objectContaining({ to: 'new@acme.example', inviteUrl: expect.stringContaining('/portal/accept-invite?token=raw-token') }));
  });

  // ---- #3258 W03: an invited LOGIN is linked to the org's CONTACT ----
  // A portal login is a login attached to a person, and tickets now attribute
  // to that person. An invite that leaves contact_id null hands the customer a
  // login that cannot see the tickets they emailed in.

  it('links the new login to the org contact that already holds the address', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])          // org existence
      .mockResolvedValueOnce([])                        // no existing portal user
      .mockResolvedValueOnce([{ id: 'ct-1' }])          // exactly one contact on the address
      .mockResolvedValueOnce([{ name: 'Acme Co' }]);    // org name
    insertReturning.mockResolvedValueOnce([{ id: 'pu-new' }]);

    const res = await invite({ email: 'known@acme.example', name: 'Known Cust' });

    expect(res.status).toBe(200);
    expect(createContactMock).not.toHaveBeenCalled();
    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'ct-1' }));
    expect(auditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: expect.objectContaining({ contactLink: 'linked' }),
    }));
    // The caller gets the outcome too, not only the audit log: the UI needs it
    // to warn on 'ambiguous' (follow-up), and an API consumer has no other way
    // to learn the invite left the login unlinked.
    expect(await res.json()).toMatchObject({ data: expect.objectContaining({ contactLink: 'linked' }) });
  });

  it("grants the existing contact the 'portal' role it did not have", async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'ct-1', roles: ['billing'] }])
      .mockResolvedValueOnce([{ name: 'Acme Co' }]);
    insertReturning.mockResolvedValueOnce([{ id: 'pu-new' }]);

    await invite({ email: 'known@acme.example' });

    // A UNION, never a replace: the invite grants portal access, it does not
    // decide the person stopped being the billing contact.
    expect(updateContactMock).toHaveBeenCalledTimes(1);
    const [, contactId, orgId, patch] = updateContactMock.mock.calls[0]!;
    expect(contactId).toBe('ct-1');
    expect(orgId).toBe(ORG_ID);
    expect((patch as { roles: string[] }).roles.slice().sort()).toEqual(['billing', 'portal']);
  });

  it("does not re-write the contact when it ALREADY has the 'portal' role", async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'ct-1', roles: ['portal', 'technical'] }])
      .mockResolvedValueOnce([{ name: 'Acme Co' }]);
    insertReturning.mockResolvedValueOnce([{ id: 'pu-new' }]);

    await invite({ email: 'known@acme.example' });

    expect(updateContactMock).not.toHaveBeenCalled();
  });

  it('serialises on the SAME advisory lock inbound email takes for (org, address)', async () => {
    // An invite and a first email from the same address, arriving together,
    // would otherwise each see "no contact" and each create one —
    // contacts_org_email_idx is deliberately non-unique, so the DB will not
    // stop it. Same namespace AND same key, or the two lock different things
    // and serialise nothing.
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ name: 'Acme Co' }]);
    createContactMock.mockResolvedValueOnce({ id: 'ct-made' });
    insertReturning.mockResolvedValueOnce([{ id: 'pu-new' }]);

    await invite({ email: 'Fresh@Acme.Example' });

    expect(executeSpy).toHaveBeenCalledTimes(1);
    const { sql: lockSql, params } = new PgDialect().sqlToQuery(executeSpy.mock.calls[0]![0] as never);
    expect(lockSql).toMatch(/pg_advisory_xact_lock\(hashtext\(\$\d\), hashtext\(\$\d\)\)/i);
    expect(params).toEqual([INBOUND_CONTACT_LOCK_NAMESPACE, `${ORG_ID}:fresh@acme.example`]);
  });

  it('creates a portal-role contact when the org has none for the address', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])                        // no contact yet
      .mockResolvedValueOnce([{ name: 'Acme Co' }]);
    createContactMock.mockResolvedValueOnce({ id: 'ct-made' });
    insertReturning.mockResolvedValueOnce([{ id: 'pu-new' }]);

    const res = await invite({ email: 'fresh@acme.example', name: 'Fresh Cust' });

    expect(res.status).toBe(200);
    const [, input, actor] = createContactMock.mock.calls[0]!;
    // 'portal' is the role the INVITE grants — inbound email deliberately
    // claims no role at all.
    expect(input).toMatchObject({ orgId: ORG_ID, email: 'fresh@acme.example', name: 'Fresh Cust', roles: ['portal'] });
    expect(actor).toEqual({ userId: 'u-1' });
    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'ct-made' }));
  });

  it('leaves contact_id null and records contactLink=ambiguous for a shared address', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'ct-a' }, { id: 'ct-b' }])  // shared mailbox
      .mockResolvedValueOnce([{ name: 'Acme Co' }]);
    insertReturning.mockResolvedValueOnce([{ id: 'pu-new' }]);

    const res = await invite({ email: 'support@acme.example' });

    expect(res.status).toBe(200);
    expect(createContactMock).not.toHaveBeenCalled();
    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ contactId: null }));
    expect(auditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: expect.objectContaining({ contactLink: 'ambiguous' }),
    }));
    expect(await res.json()).toMatchObject({ data: expect.objectContaining({ contactLink: 'ambiguous' }) });
  });

  it('re-inviting an existing login NEVER overwrites a contact link it already has', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([{ id: 'pu-1', email: 'again@acme.example', passwordHash: null, status: 'invited', contactId: 'ct-existing' }])
      .mockResolvedValueOnce([{ name: 'Acme Co' }]);
    insertReturning.mockResolvedValueOnce([{ id: 'pu-1' }]);

    const res = await invite({ email: 'again@acme.example' });

    expect(res.status).toBe(200);
    expect(createContactMock).not.toHaveBeenCalled();
    // The link is not re-derived at all — no lookup, and nothing written.
    // `not.objectContaining({ contactId: expect.anything() })` is satisfied by
    // ANY of the several set() calls this route can make, so it passes even
    // when one of them DOES carry contactId. Assert on the one call that
    // matters, by absence of the key.
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy.mock.calls[0]![0]).not.toHaveProperty('contactId');
    expect(auditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: expect.objectContaining({ contactLink: 'kept' }),
    }));
  });

  it('re-inviting a login with NO contact link backfills one', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([{ id: 'pu-1', email: 'again@acme.example', passwordHash: null, status: 'invited', contactId: null }])
      .mockResolvedValueOnce([{ id: 'ct-1' }])
      .mockResolvedValueOnce([{ name: 'Acme Co' }]);
    insertReturning.mockResolvedValueOnce([{ id: 'pu-1' }]);

    const res = await invite({ email: 'again@acme.example' });

    expect(res.status).toBe(200);
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'ct-1' }));
  });

  it('409s when the email is already an active account with a password', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([{ id: 'pu-1', email: 'live@acme.example', passwordHash: 'h', status: 'active' }]);
    const res = await invite({ email: 'live@acme.example' });
    expect(res.status).toBe(409);
    expect(sendInvite).not.toHaveBeenCalled();
  });

  it('409s when the existing row is disabled — disable is terminal, must not resurrect via invite', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([{ id: 'pu-1', email: 'disabled@acme.example', passwordHash: 'h', status: 'disabled' }]);
    const res = await invite({ email: 'disabled@acme.example' });
    expect(res.status).toBe(409);
    expect(sendInvite).not.toHaveBeenCalled();
  });
});

describe('PATCH /organizations/:id/portal-users/:userId', () => {
  const patch = (uid: string, body: unknown) => makeApp().request(`/organizations/${ORG_ID}/portal-users/${uid}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  it('disables a user', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])                         // org
      .mockResolvedValueOnce([{ id: 'pu-1', orgId: ORG_ID }]);          // target exists in org
    insertReturning.mockResolvedValueOnce([{ id: 'pu-1', status: 'disabled' }]); // update .returning
    const res = await patch('pu-1', { status: 'disabled' });
    expect(res.status).toBe(200);
  });
});

describe('POST /organizations/:id/portal-users/:userId/resend-invite', () => {
  const resend = (uid: string) => makeApp().request(`/organizations/${ORG_ID}/portal-users/${uid}/resend-invite`, { method: 'POST' });

  it('resends the invite to a pending (no-password) user', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }]) // org
      .mockResolvedValueOnce([{ id: 'pu-1', orgId: ORG_ID, email: 'pending@acme.example', name: null, passwordHash: null, status: 'invited' }]) // target
      .mockResolvedValueOnce([{ name: 'Acme Co' }]); // org name
    const res = await resend('pu-1');
    expect(res.status).toBe(200);
    expect(sendInvite).toHaveBeenCalledTimes(1);
    expect(sendInvite).toHaveBeenCalledWith(expect.objectContaining({ to: 'pending@acme.example' }));
  });

  it('409s when the target already has an active password-set account', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }]) // org
      .mockResolvedValueOnce([{ id: 'pu-1', orgId: ORG_ID, email: 'live@acme.example', name: null, passwordHash: 'h', status: 'active' }]); // target
    const res = await resend('pu-1');
    expect(res.status).toBe(409);
    expect(sendInvite).not.toHaveBeenCalled();
  });

  it('409s when the target is disabled — disable is terminal, must not resurrect via resend', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }]) // org
      .mockResolvedValueOnce([{ id: 'pu-1', orgId: ORG_ID, email: 'disabled@acme.example', name: null, passwordHash: 'h', status: 'disabled' }]); // target
    const res = await resend('pu-1');
    expect(res.status).toBe(409);
    expect(sendInvite).not.toHaveBeenCalled();
  });
});

describe('POST /organizations/:id/portal-users/bulk-invite', () => {
  const bulkInvite = (body: unknown) => makeApp().request(`/organizations/${ORG_ID}/portal-users/bulk-invite`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const PU_1 = 'aaaaaaaa-1111-4222-8333-444455556666';
  const PU_2 = 'bbbbbbbb-1111-4222-8333-444455556666';
  const PU_DISABLED = 'cccccccc-1111-4222-8333-444455556666';

  it('invites all candidates returned by the pending-setup query when no userIds are given', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }]) // org
      .mockResolvedValueOnce([
        { id: PU_1, email: 'a@acme.example' },
        { id: PU_2, email: 'b@acme.example' }
      ]) // candidates — the handler's baseWhere (org + no password + status != disabled) already filtered these
      .mockResolvedValueOnce([{ name: 'Acme Co' }]); // org name
    insertReturning.mockResolvedValue([]); // per-user update
    const res = await bulkInvite({});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((r: any) => r.id)).toEqual([PU_1, PU_2]);
    expect(sendInvite).toHaveBeenCalledTimes(2);
  });

  it('drops a requested userId that is not in the candidate set (e.g. a disabled account)', async () => {
    // Candidates mock simulates the DB-side ne(status,'disabled') filter already having
    // excluded PU_DISABLED — the handler's userIds-intersection then can only invite PU_1.
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }]) // org
      .mockResolvedValueOnce([{ id: PU_1, email: 'a@acme.example' }]) // candidates
      .mockResolvedValueOnce([{ name: 'Acme Co' }]); // org name
    insertReturning.mockResolvedValue([]);
    const res = await bulkInvite({ userIds: [PU_1, PU_DISABLED] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((r: any) => r.id)).toEqual([PU_1]);
    expect(sendInvite).toHaveBeenCalledTimes(1);
  });

  it('respects userIds — only invites the requested subset of candidates', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }]) // org
      .mockResolvedValueOnce([
        { id: PU_1, email: 'a@acme.example' },
        { id: PU_2, email: 'b@acme.example' }
      ]) // candidates
      .mockResolvedValueOnce([{ name: 'Acme Co' }]); // org name
    insertReturning.mockResolvedValue([]);
    const res = await bulkInvite({ userIds: [PU_1] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.map((r: any) => r.id)).toEqual([PU_1]);
    expect(sendInvite).toHaveBeenCalledTimes(1);
  });
});

describe('DELETE /organizations/:id/portal-users/:userId', () => {
  const del = (uid: string) => makeApp().request(`/organizations/${ORG_ID}/portal-users/${uid}`, { method: 'DELETE' });
  it('409s when the user has ticket references', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])            // org
      .mockResolvedValueOnce([{ id: 'pu-1', orgId: ORG_ID }]) // target
      .mockResolvedValueOnce([{ id: 't-1' }]);            // reference exists (tickets)
    const res = await del('pu-1');
    expect(res.status).toBe(409);
  });
  it('hard-deletes an unreferenced user', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([{ id: 'pu-1', orgId: ORG_ID }])
      .mockResolvedValueOnce([]) // tickets ref
      .mockResolvedValueOnce([]) // comments ref
      .mockResolvedValueOnce([]); // checkouts ref
    // delete().where() resolves (mock deleteChain below)
    const res = await del('pu-1');
    expect(res.status).toBe(200);
  });
});
