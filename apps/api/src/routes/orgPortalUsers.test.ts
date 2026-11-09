import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import { INBOUND_CONTACT_LOCK_NAMESPACE } from '../services/inboundEmail/resolveOrg';

const { valuesSpy, setSpy, executeSpy, updateWhereSpy, selectWhereSpy, issueTokenMock } = vi.hoisted(() => ({ valuesSpy: vi.fn(), setSpy: vi.fn(), executeSpy: vi.fn(), updateWhereSpy: vi.fn(), selectWhereSpy: vi.fn(), issueTokenMock: vi.fn(async () => 'raw-token') }));
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
        where: vi.fn((w: unknown) => {
          selectWhereSpy(w);
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
        where: vi.fn((w: unknown) => { updateWhereSpy(w); return ({
          returning: vi.fn(() => insertReturning()),
          // bulk-invite's per-user update has no `.returning()` leaf —
          // make the where-result thenable so a bare `await ...where(x)`
          // also resolves via insertReturning().
          then: (resolve: any, reject: any) => insertReturning().then(resolve, reject)
        }); })
      }); })
    })),
    delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
    // The invite path takes the SAME namespaced advisory lock the inbound
    // resolver takes (#3258 W03), so the mock has to serve `db.execute`.
    execute: vi.fn((statement: unknown) => { executeSpy(statement); return Promise.resolve([]); })
  }
}));
vi.mock('../db/schema', () => ({
  portalUsers: { id: 'id', orgId: 'orgId', email: 'email', name: 'name', passwordHash: 'passwordHash', authMethod: 'authMethod', receiveNotifications: 'receiveNotifications', status: 'status', invitedBy: 'invitedBy', invitedAt: 'invitedAt', lastLoginAt: 'lastLoginAt', createdAt: 'createdAt', contactId: 'contactId', authEpoch: 'authEpoch', browserAccess: 'browserAccess' },
  contacts: { id: 'id', orgId: 'orgId', email: 'email', roles: 'roles' },
  organizations: { id: 'id', name: 'name', deletedAt: 'deletedAt', partnerId: 'partnerId' },
  partners: { id: 'id', name: 'name', settings: 'settings' },
  tickets: { id: 'id', submittedBy: 'submittedBy' },
  ticketComments: { id: 'id', portalUserId: 'portalUserId' },
  assetCheckouts: { id: 'id', checkedOutTo: 'checkedOutTo' }
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: auditMock }));
vi.mock('../services/contacts/crud', async () => {
  const actual = await vi.importActual<typeof import('../services/contacts/crud')>('../services/contacts/crud');
  return { ...actual, createContact: createContactMock, updateContact: updateContactMock };
});
vi.mock('../routes/portal/capabilityTokens', () => ({ issuePortalCapabilityToken: issueTokenMock }));
vi.mock('../routes/portal/helpers', () => ({
  buildPortalUrl: (p: string) => `https://x/portal${p}`,
  purgePortalSessionsForUsers: vi.fn(async () => 0),
}));
vi.mock('../services/email', () => ({ getEmailService: () => ({ sendPortalInvite: sendInvite }) }));

import { QueryBuilder } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { db } from '../db';
import { portalUsers as realPortalUsers } from '../db/schema/portal';
import { authMiddleware } from '../middleware/auth';
import { registerOrgPortalUsersRoutes } from './orgPortalUsers';
import { purgePortalSessionsForUsers } from './portal/helpers';

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';
const makeApp = () => { const app = new Hono(); app.use('*', authMiddleware as any); registerOrgPortalUsersRoutes(app); return app; };
beforeEach(() => { vi.clearAllMocks(); selectResult.mockReset(); selectResult.mockResolvedValue([]); insertReturning.mockReset(); insertReturning.mockResolvedValue([]); issueTokenMock.mockResolvedValue('raw-token'); authRef.current = { scope: 'partner', user: { id: 'u-1', name: 'Tess', email: 'tess@msp.example' }, partnerId: 'p-1', canAccessOrg: () => true }; });

describe('GET /organizations/:id/portal-users', () => {
  it('lists users with an effective status', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }]) // org existence
      .mockResolvedValueOnce([
        { id: 'pu-1', email: 'a@acme.example', name: 'A', passwordHash: 'h', status: 'active', receiveNotifications: true, lastLoginAt: null, invitedAt: null, authMethod: 'password' },
        { id: 'pu-2', email: 'b@acme.example', name: null, passwordHash: null, status: 'active', receiveNotifications: true, lastLoginAt: null, invitedAt: null, authMethod: 'password' }
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
    // Spec §8.1: the partner comes from the VERIFIED auth context, never
    // request input. A partner-scoped caller must hand a real id over, or
    // portal invites silently stay on the platform sender forever.
    expect((sendInvite.mock.calls.at(-1)![0] as { partnerId?: string | null }).partnerId).toBe('p-1');
  });

  it('matches the existing login case-insensitively (#11529: same comparison as the contact-invite path)', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ name: 'Acme Co' }]);
    createContactMock.mockResolvedValueOnce({ id: 'ct-new' });
    insertReturning.mockResolvedValueOnce([{ id: 'pu-new', email: 'ada@acme.example', status: 'invited' }]);
    const res = await invite({ email: 'Ada@Acme.Example' });
    expect(res.status).toBe(200);
    const loginLookup = new PgDialect().sqlToQuery(selectWhereSpy.mock.calls[1]![0] as never);
    expect(loginLookup.sql).toContain('lower(');
    expect(loginLookup.params).toContain('ada@acme.example');
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

    // Taken twice: once before the existing-login read (Review Focus 3, below)
    // and again by the contact resolver, a no-op re-take of the held lock.
    expect(executeSpy).toHaveBeenCalledTimes(2);
    for (const [statement] of executeSpy.mock.calls) {
      const { sql: lockSql, params } = new PgDialect().sqlToQuery(statement as never);
      expect(lockSql).toMatch(/pg_advisory_xact_lock\(hashtext\(\$\d\), hashtext\(\$\d\)\)/i);
      expect(params).toEqual([INBOUND_CONTACT_LOCK_NAMESPACE, `${ORG_ID}:fresh@acme.example`]);
    }
  });

  it('a plain-email invite takes the per-address lock BEFORE it reads the existing login (W3 Review Focus 3)', async () => {
    // Approving a self request takes this lock, re-checks "no account at this
    // address" and inserts one. An invite that read the existing login before
    // queueing on the lock would act on that stale "none" and insert a second
    // portal_users row for the address (portal_users.email is not unique).
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])            // org existence
      .mockResolvedValueOnce([])                          // existing-login read
      .mockResolvedValueOnce([])                          // contact lookup
      .mockResolvedValueOnce([{ name: 'Acme Co' }]);
    createContactMock.mockResolvedValueOnce({ id: 'ct-made' });
    insertReturning.mockResolvedValueOnce([{ id: 'pu-new' }]);

    await invite({ email: 'Race@Acme.Example' });

    const firstLock = executeSpy.mock.invocationCallOrder[0]!;
    const [orgRead, existingLoginRead] = selectWhereSpy.mock.invocationCallOrder;
    expect(firstLock).toBeGreaterThan(orgRead!);
    expect(firstLock).toBeLessThan(existingLoginRead!);
    const { params } = new PgDialect().sqlToQuery(executeSpy.mock.calls[0]![0] as never);
    expect(params).toEqual([INBOUND_CONTACT_LOCK_NAMESPACE, `${ORG_ID}:race@acme.example`]);
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
      .mockResolvedValueOnce([{ id: 'pu-1', email: 'again@acme.example', passwordHash: null, authMethod: 'password', status: 'invited', contactId: 'ct-existing', authEpoch: 1, browserAccess: 'granted', hasExternalIdentity: false }])
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
      .mockResolvedValueOnce([{ id: 'pu-1', email: 'again@acme.example', passwordHash: null, authMethod: 'password', status: 'invited', contactId: null, authEpoch: 1, browserAccess: 'granted', hasExternalIdentity: false }])
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
      .mockResolvedValueOnce([{ id: 'pu-1', email: 'live@acme.example', passwordHash: 'h', authMethod: 'password', status: 'active', authEpoch: 1, browserAccess: 'granted', hasExternalIdentity: false }]);
    const res = await invite({ email: 'live@acme.example' });
    expect(res.status).toBe(409);
    expect(sendInvite).not.toHaveBeenCalled();
  });

  it('409s without mutation or email when the address belongs to an Entra identity', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([{ id: 'pu-entra', email: 'entra@acme.example', passwordHash: null, authMethod: 'entra', status: 'active', contactId: null, authEpoch: 1, browserAccess: 'none', hasExternalIdentity: true }]);
    const res = await invite({ email: 'entra@acme.example' });
    expect(res.status).toBe(409);
    expect(setSpy).not.toHaveBeenCalled();
    expect(sendInvite).not.toHaveBeenCalled();
  });

  it('409s when the existing row is disabled — disable is terminal, must not resurrect via invite', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([{ id: 'pu-1', email: 'disabled@acme.example', passwordHash: 'h', authMethod: 'password', status: 'disabled', authEpoch: 1, browserAccess: 'granted', hasExternalIdentity: false }]);
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
      .mockResolvedValueOnce([{ id: 'pu-1', orgId: ORG_ID, email: 'a@acme.example', name: null, passwordHash: 'h', authMethod: 'password', status: 'active', authEpoch: 3, browserAccess: 'granted', hasExternalIdentity: false }]); // target exists in org
    insertReturning.mockResolvedValueOnce([{ id: 'pu-1', status: 'disabled' }]); // update .returning
    const res = await patch('pu-1', { status: 'disabled' });
    expect(res.status).toBe(200);
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ authEpoch: expect.anything() }));
    expect(purgePortalSessionsForUsers).toHaveBeenCalledWith(['pu-1']);
  });

  it('rotates the durable session epoch when a user is reactivated', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([{ id: 'pu-1', orgId: ORG_ID, email: 'a@acme.example', name: null, passwordHash: 'h', authMethod: 'password', status: 'disabled', authEpoch: 3, browserAccess: 'granted', hasExternalIdentity: false }]);
    insertReturning.mockResolvedValueOnce([{ id: 'pu-1', status: 'active' }]);

    const res = await patch('pu-1', { status: 'active' });

    expect(res.status).toBe(200);
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ authEpoch: expect.anything() }));
  });
});

describe('POST /organizations/:id/portal-users/:userId/resend-invite', () => {
  const resend = (uid: string) => makeApp().request(`/organizations/${ORG_ID}/portal-users/${uid}/resend-invite`, { method: 'POST' });

  it('resends the invite to a pending (no-password) user', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }]) // org
      .mockResolvedValueOnce([{ id: 'pu-1', orgId: ORG_ID, email: 'pending@acme.example', name: null, passwordHash: null, authMethod: 'password', status: 'invited', authEpoch: 1, browserAccess: 'granted', hasExternalIdentity: false }]) // target
      .mockResolvedValueOnce([{ name: 'Acme Co' }]); // org name
    const res = await resend('pu-1');
    expect(res.status).toBe(200);
    expect(sendInvite).toHaveBeenCalledTimes(1);
    expect(sendInvite).toHaveBeenCalledWith(expect.objectContaining({ to: 'pending@acme.example' }));
  });

  it('409s when the target already has an active password-set account', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }]) // org
      .mockResolvedValueOnce([{ id: 'pu-1', orgId: ORG_ID, email: 'live@acme.example', name: null, passwordHash: 'h', authMethod: 'password', status: 'active', authEpoch: 1, browserAccess: 'granted', hasExternalIdentity: false }]); // target
    const res = await resend('pu-1');
    expect(res.status).toBe(409);
    expect(sendInvite).not.toHaveBeenCalled();
  });

  it('409s without email when the target is an Entra identity', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([{ id: 'pu-entra', orgId: ORG_ID, email: 'entra@acme.example', name: null, passwordHash: null, authMethod: 'entra', status: 'active', authEpoch: 1, browserAccess: 'none', hasExternalIdentity: true }]);
    const res = await resend('pu-entra');
    expect(res.status).toBe(409);
    expect(sendInvite).not.toHaveBeenCalled();
  });

  it('409s when the target is disabled — disable is terminal, must not resurrect via resend', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }]) // org
      .mockResolvedValueOnce([{ id: 'pu-1', orgId: ORG_ID, email: 'disabled@acme.example', name: null, passwordHash: 'h', authMethod: 'password', status: 'disabled', authEpoch: 1, browserAccess: 'granted', hasExternalIdentity: false }]); // target
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
  const pending = { status: 'invited', browserAccess: 'granted', authMethod: 'password', passwordHash: null, hasExternalIdentity: false, authEpoch: 1 };

  it('invites all candidates returned by the pending-setup query when no userIds are given', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }]) // org
      .mockResolvedValueOnce([
        { id: PU_1, email: 'a@acme.example', ...pending },
        { id: PU_2, email: 'b@acme.example', ...pending }
      ]) // candidates — the handler's baseWhere (org + no password + status != disabled) already filtered these
      .mockResolvedValueOnce([{ name: 'Acme Co' }]); // org name
    insertReturning.mockResolvedValue([{ authEpoch: 2 }]); // per-user epoch-guarded update
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
      .mockResolvedValueOnce([{ id: PU_1, email: 'a@acme.example', ...pending }]) // candidates
      .mockResolvedValueOnce([{ name: 'Acme Co' }]); // org name
    insertReturning.mockResolvedValue([{ authEpoch: 2 }]);
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
        { id: PU_1, email: 'a@acme.example', ...pending },
        { id: PU_2, email: 'b@acme.example', ...pending }
      ]) // candidates
      .mockResolvedValueOnce([{ name: 'Acme Co' }]); // org name
    insertReturning.mockResolvedValue([{ authEpoch: 2 }]);
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

// ---------------------------------------------------------------------------
// Portal registration W2: every writer goes through services/portalAccountState
// ---------------------------------------------------------------------------

describe('portal account state machine on the MSP routes (W2)', () => {
  const render = (w: unknown) => new PgDialect().sqlToQuery(w as never);
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'pu-1', orgId: ORG_ID, email: 'cust@acme.example', name: null, passwordHash: null, authMethod: 'password',
    status: 'invited', authEpoch: 5, browserAccess: 'granted', hasExternalIdentity: false, contactId: 'ct-1', ...over,
  });
  const invite = (body: unknown) => makeApp().request(`/organizations/${ORG_ID}/portal-users/invite`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const patch = (body: unknown) => makeApp().request(`/organizations/${ORG_ID}/portal-users/pu-1`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const resend = () => makeApp().request(`/organizations/${ORG_ID}/portal-users/pu-1/resend-invite`, { method: 'POST' });

  // The invite route keeps W1's (#11378) stable PORTAL_INVITE_* codes on the
  // state module's msp_invite refusals; resend/PATCH carry the module's codes.
  it('invite of an identity-only (entra) account → 409 PORTAL_INVITE_EXTERNAL_IDENTITY, no write, no email', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([row({ authMethod: 'entra', status: 'active', browserAccess: 'none', hasExternalIdentity: true })]);
    const res = await invite({ email: 'cust@acme.example' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'This identity is managed by an external sign-in provider.', code: 'PORTAL_INVITE_EXTERNAL_IDENTITY' });
    expect(setSpy).not.toHaveBeenCalled();
    expect(sendInvite).not.toHaveBeenCalled();
  });

  it('invite of a password row that carries an Entra identity is identity-managed too', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([row({ hasExternalIdentity: true })]);
    const res = await invite({ email: 'cust@acme.example' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('PORTAL_INVITE_EXTERNAL_IDENTITY');
  });

  it('new invite inserts status invited + browser_access granted and issues an invite token bound to the returned epoch', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([])                     // no existing portal user
      .mockResolvedValueOnce([{ id: 'ct-1' }])       // contact
      .mockResolvedValueOnce([{ name: 'Acme Co' }]); // org name
    insertReturning.mockResolvedValueOnce([{ id: 'pu-new', authEpoch: 1 }]);
    const res = await invite({ email: 'New@Acme.example' });
    expect(res.status).toBe(200);
    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ authMethod: 'password', status: 'invited', browserAccess: 'granted' }));
    expect(issueTokenMock).toHaveBeenCalledWith({ purpose: 'invite', portalUserId: 'pu-new', orgId: ORG_ID, email: 'new@acme.example', authEpoch: 1 });
  });

  it('re-invite of a legacy active credential-less row moves it to invited, bumps the epoch, and binds the token to the NEW epoch', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([row({ status: 'active' })])
      .mockResolvedValueOnce([{ name: 'Acme Co' }]);
    insertReturning.mockResolvedValueOnce([{ id: 'pu-1', authEpoch: 6 }]);
    const res = await invite({ email: 'cust@acme.example' });
    expect(res.status).toBe(200);
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'invited', browserAccess: 'granted', authEpoch: expect.anything() }));
    // Optimistic concurrency: the write is guarded by the epoch that was read.
    expect(render(updateWhereSpy.mock.calls[0]![0]).params).toEqual(expect.arrayContaining(['pu-1', ORG_ID, 5]));
    expect(issueTokenMock).toHaveBeenCalledWith(expect.objectContaining({ portalUserId: 'pu-1', authEpoch: 6 }));
  });

  it('a concurrent change between read and write (epoch guard matches nothing) → 409, no email', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([row()]);
    insertReturning.mockResolvedValueOnce([]);
    const res = await invite({ email: 'cust@acme.example' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('PORTAL_ACCOUNT_TRANSITION_REFUSED');
    expect(sendInvite).not.toHaveBeenCalled();
    expect(purgePortalSessionsForUsers).not.toHaveBeenCalled();
  });

  it('PATCH status active on an invited user → 409 PORTAL_ACCOUNT_TRANSITION_REFUSED, no update', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([row()]);
    const res = await patch({ status: 'active' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'This user has not accepted their invite yet. Resend the invite instead.', code: 'PORTAL_ACCOUNT_TRANSITION_REFUSED' });
    expect(setSpy).not.toHaveBeenCalled();
  });

  // Review Focus 5: disabled before accepting, then reactivated.
  it('reactivating a credential-less disabled user lands on invited', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([row({ status: 'disabled' })]);
    insertReturning.mockResolvedValueOnce([{ id: 'pu-1', status: 'invited' }]);
    const res = await patch({ status: 'active' });
    expect(res.status).toBe(200);
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'invited', authEpoch: expect.anything() }));
    expect((await res.json()).data).toEqual({ id: 'pu-1', status: 'invited' });
  });

  it('reactivating a disabled user with a password lands on active', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([row({ status: 'disabled', passwordHash: 'h' })]);
    insertReturning.mockResolvedValueOnce([{ id: 'pu-1', status: 'active' }]);
    const res = await patch({ status: 'active' });
    expect(res.status).toBe(200);
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'active', authEpoch: expect.anything() }));
    expect(render(updateWhereSpy.mock.calls[0]![0]).params).toEqual(expect.arrayContaining(['pu-1', ORG_ID, 5]));
  });

  it('reactivating an already active user is a no-op: no epoch bump, sessions kept', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([row({ status: 'active', passwordHash: 'h' })]);
    insertReturning.mockResolvedValueOnce([{ id: 'pu-1', status: 'active' }]);
    const res = await patch({ status: 'active' });
    expect(res.status).toBe(200);
    expect(setSpy.mock.calls[0]![0]).not.toHaveProperty('authEpoch');
    expect(purgePortalSessionsForUsers).not.toHaveBeenCalled();
  });

  it('a PATCH of profile fields only does not touch state and is not epoch-guarded', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([row({ status: 'active', passwordHash: 'h' })]);
    insertReturning.mockResolvedValueOnce([{ id: 'pu-1', status: 'active' }]);
    const res = await patch({ name: 'Renamed' });
    expect(res.status).toBe(200);
    const set = setSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(set).toMatchObject({ name: 'Renamed' });
    expect(set).not.toHaveProperty('status');
    expect(set).not.toHaveProperty('browserAccess');
    expect(render(updateWhereSpy.mock.calls[0]![0]).params).not.toContain(5);
  });

  it('resend to a legacy active credential-less row moves it to invited first and binds the token to the new epoch', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([row({ status: 'active' })])
      .mockResolvedValueOnce([{ name: 'Acme Co' }]);
    insertReturning.mockResolvedValueOnce([{ authEpoch: 6 }]);
    const res = await resend();
    expect(res.status).toBe(200);
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'invited', browserAccess: 'granted' }));
    expect(issueTokenMock).toHaveBeenCalledWith(expect.objectContaining({ portalUserId: 'pu-1', authEpoch: 6 }));
  });

  it('resend to an invited row writes nothing and binds the token to the current epoch', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([row()])
      .mockResolvedValueOnce([{ name: 'Acme Co' }]);
    const res = await resend();
    expect(res.status).toBe(200);
    expect(setSpy).not.toHaveBeenCalled();
    expect(issueTokenMock).toHaveBeenCalledWith(expect.objectContaining({ portalUserId: 'pu-1', authEpoch: 5 }));
  });

  it('bulk invite reports a row that changed under it as skipped, and audits only the rows it invited', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([row({ id: 'pu-ok' }), row({ id: 'pu-raced' })])
      .mockResolvedValueOnce([{ name: 'Acme Co' }]);
    insertReturning
      .mockResolvedValueOnce([{ authEpoch: 6 }]) // pu-ok moved
      .mockResolvedValueOnce([]);                // pu-raced: epoch guard matched nothing
    const res = await makeApp().request(`/organizations/${ORG_ID}/portal-users/bulk-invite`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([
      { id: 'pu-ok', emailSent: true },
      { id: 'pu-raced', emailSent: false, skipped: 'concurrent_change' },
    ]);
    expect(sendInvite).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ details: { invited: 1, skipped: 1 } }));
  });

  it('bulk invite never selects entra/identity, disabled, or passworded rows', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([
        row({ id: 'pu-ok' }),
        // Defence in depth: even if the SQL filter let these through, the
        // state module's isBulkInviteEligible drops them.
        row({ id: 'pu-entra', authMethod: 'entra', browserAccess: 'none', hasExternalIdentity: true }),
        row({ id: 'pu-disabled', status: 'disabled' }),
        row({ id: 'pu-hash', passwordHash: 'h', status: 'active' }),
      ])
      .mockResolvedValueOnce([{ name: 'Acme Co' }]);
    insertReturning.mockResolvedValue([{ authEpoch: 6 }]);
    const res = await makeApp().request(`/organizations/${ORG_ID}/portal-users/bulk-invite`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([{ id: 'pu-ok', emailSent: true }]);
    expect(setSpy).toHaveBeenCalledTimes(1);

    // The candidate query itself (the 2nd select, after the org lookup) is narrowed.
    const candidateWhere = render(selectWhereSpy.mock.calls[1]![0]);
    expect(candidateWhere.params).toEqual(expect.arrayContaining(['authMethod', 'password', 'passwordHash', 'status', 'invited', 'active']));
    expect(candidateWhere.params).not.toContain('disabled');
    // W3: "no external identity" is NOT EXISTS over portal_user_identities, correlated to the row.
    expect(candidateWhere.params).not.toContain('entraOid');
    expect(candidateWhere.sql).toMatch(/not exists \(select 1 from "portal_user_identities" "\w+" where "\w+"\."portal_user_id" = "portal_users"\."id"\)/);
    expect(issueTokenMock).toHaveBeenCalledWith(expect.objectContaining({ portalUserId: 'pu-ok', authEpoch: 6 }));
  });
});

// ---------------------------------------------------------------------------
// Portal registration W3 (identities release B): external identity is read
// from portal_user_identities (portalUserHasIdentitySql), not entra_oid.
// The real-Postgres proofs are in
// __tests__/integration/portalUserIdentities.integration.test.ts.
// ---------------------------------------------------------------------------

describe('identities release B on the MSP portal-user routes (W3)', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'pu-1', orgId: ORG_ID, email: 'cust@acme.example', name: null, passwordHash: null, authMethod: 'password',
    status: 'invited', authEpoch: 5, browserAccess: 'granted', hasExternalIdentity: false, contactId: 'ct-1', ...over,
  });
  const invite = (body: unknown) => makeApp().request(`/organizations/${ORG_ID}/portal-users/invite`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const resend = () => makeApp().request(`/organizations/${ORG_ID}/portal-users/pu-1/resend-invite`, { method: 'POST' });
  /** The selection's hasExternalIdentity rendered in a single-table select — where drizzle strips qualifiers (#9692). */
  const renderIdentityColumn = (callIndex: number) => {
    const cols = vi.mocked(db.select).mock.calls[callIndex]![0] as unknown as Record<string, unknown>;
    expect(cols).not.toHaveProperty('entraOid');
    return new QueryBuilder().select({ id: realPortalUsers.id, has: cols.hasExternalIdentity as SQL }).from(realPortalUsers).toSQL().sql;
  };

  it('an account with an identity row is identity-managed even when entra_oid is NULL', async () => {
    // A password account whose only external identity lives in portal_user_identities.
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([row({ entraOid: null, hasExternalIdentity: true })]);
    const res = await invite({ email: 'cust@acme.example' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('PORTAL_INVITE_EXTERNAL_IDENTITY');
    expect(setSpy).not.toHaveBeenCalled();
    expect(sendInvite).not.toHaveBeenCalled();

    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([row({ entraOid: null, hasExternalIdentity: true })]);
    const resent = await resend();
    expect(resent.status).toBe(409);
    expect((await resent.json()).code).toBe('PORTAL_USER_IDENTITY_MANAGED');
  });

  it('an identity on ANOTHER user does not make this user identity-managed', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([row({ hasExternalIdentity: false })])
      .mockResolvedValueOnce([{ name: 'Acme Co' }]);
    const res = await resend();
    expect(res.status).toBe(200);
    // The fact comes from an EXISTS correlated to THIS row's id, spelled with
    // its table so a single-table select cannot rebind it to the subquery.
    expect(renderIdentityColumn(1)).toMatch(/where "\w+"\."portal_user_id" = "portal_users"\."id"\)/);
  });

  it('the invite-by-email reader takes the identity fact from portal_user_identities too', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([row({ hasExternalIdentity: true })]);
    await invite({ email: 'cust@acme.example' });
    expect(renderIdentityColumn(1)).toMatch(/exists \(select 1 from "portal_user_identities"/);
  });

  it('bulk invite skips accounts with any identity row', async () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([
        row({ id: 'pu-ok' }),
        // A password row whose identity lives only in portal_user_identities:
        // defence in depth behind the SQL NOT EXISTS.
        row({ id: 'pu-identity', entraOid: null, hasExternalIdentity: true }),
      ])
      .mockResolvedValueOnce([{ name: 'Acme Co' }]);
    insertReturning.mockResolvedValue([{ authEpoch: 6 }]);
    const res = await makeApp().request(`/organizations/${ORG_ID}/portal-users/bulk-invite`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([{ id: 'pu-ok', emailSent: true }]);
    const candidateWhere = new PgDialect().sqlToQuery(selectWhereSpy.mock.calls[1]![0] as never);
    expect(candidateWhere.sql).toMatch(/not exists \(select 1 from "portal_user_identities"/);
    expect(renderIdentityColumn(1)).toMatch(/= "portal_users"\."id"\)/);
  });
});
