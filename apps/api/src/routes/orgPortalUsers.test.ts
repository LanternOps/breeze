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
// The order of the DB calls a route makes ('select', 'for:<mode>', 'update',
// 'tx:begin'/'tx:end' around a withDbTransaction, 'purge'), for the tests that
// pin a read-under-lock shape. `txState.impl` null = withDbTransaction throws,
// as it did before it was mocked (the invite branding read then falls back).
const { events, txState } = vi.hoisted(() => ({
  events: [] as string[],
  txState: { impl: null as null | ((fn: () => Promise<unknown>) => Promise<unknown>) },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => { c.set('auth', authRef.current); await next(); }),
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next()
}));
vi.mock('../db', () => ({
  withDbTransaction: vi.fn((fn: () => Promise<unknown>) => {
    if (!txState.impl) throw new Error('withDbTransaction is not wired in this test');
    return txState.impl(fn);
  }),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((w: unknown) => {
          selectWhereSpy(w);
          events.push('select');
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
          leaf.for = vi.fn((mode: string) => { events.push(`for:${mode}`); return leaf; });
          return leaf;
        })
      }))
    })),
    insert: vi.fn(() => ({ values: vi.fn((v: unknown) => { valuesSpy(v); return { returning: vi.fn(() => insertReturning()) }; }) })),
    update: vi.fn(() => ({
      set: vi.fn((v: unknown) => { setSpy(v); events.push('update'); return ({
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
  purgePortalSessionsForUsers: vi.fn(async () => { events.push('purge'); return 0; }),
}));
vi.mock('../services/email', () => ({ getEmailService: () => ({ sendPortalInvite: sendInvite }) }));
// W4 (#11381) spec §5.5: which methods the invite email offers comes from the
// org's effective policy (resolved in a savepoint; its SQL is the integration suites').
const { resolveMethods } = vi.hoisted(() => ({ resolveMethods: vi.fn() }));
vi.mock('../services/portalSsoOnly', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/portalSsoOnly')>()),
  resolveInviteSignInMethods: (...args: unknown[]) => resolveMethods(...args),
}));

import { QueryBuilder } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { db } from '../db';
import { portalUsers as realPortalUsers } from '../db/schema/portal';
import { authMiddleware } from '../middleware/auth';
import { registerOrgPortalUsersRoutes } from './orgPortalUsers';
import { purgePortalSessionsForUsers } from './portal/helpers';

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';
const makeApp = () => { const app = new Hono(); app.use('*', authMiddleware as any); registerOrgPortalUsersRoutes(app); return app; };
beforeEach(() => { vi.clearAllMocks(); events.length = 0; txState.impl = null; resolveMethods.mockReset().mockResolvedValue({ microsoft: false, password: true }); selectResult.mockReset(); selectResult.mockResolvedValue([]); insertReturning.mockReset(); insertReturning.mockResolvedValue([]); issueTokenMock.mockResolvedValue('raw-token'); authRef.current = { scope: 'partner', user: { id: 'u-1', name: 'Tess', email: 'tess@msp.example' }, partnerId: 'p-1', canAccessOrg: () => true }; });

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

// ---------------------------------------------------------------------------
// Portal registration W4 (#11381) Task 9: the invite email follows the org's
// sign-in methods (spec §5.5), the bulk SSO invite for stranded accounts, and
// the MSP "give browser access" grant.
// ---------------------------------------------------------------------------

describe('invite email sign-in methods (W4, spec §5.5)', () => {
  const invite = (body: unknown) => makeApp().request(`/organizations/${ORG_ID}/portal-users/invite`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const newInvite = () => {
    selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])          // org existence
      .mockResolvedValueOnce([])                        // no existing portal user
      .mockResolvedValueOnce([{ id: 'ct-1' }])          // the contact on the address
      .mockResolvedValueOnce([{ name: 'Acme Co' }]);    // org name
    insertReturning.mockResolvedValueOnce([{ id: 'pu-new', authEpoch: 1 }]);
    return invite({ email: 'new@acme.example' });
  };

  it('invite email offers Microsoft first and hides the password option under sso_only', async () => {
    resolveMethods.mockResolvedValue({ microsoft: true, password: false });
    const res = await newInvite();
    expect(res.status).toBe(200);
    expect(resolveMethods).toHaveBeenCalledWith(ORG_ID);
    const sent = sendInvite.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.inviteUrl).toBe('https://x/portal/accept-invite?token=raw-token');
    expect(sent.microsoftUrl).toBe('https://x/portal/accept-invite?token=raw-token&method=microsoft');
    expect(sent.passwordAllowed).toBe(false);
  });

  it('Microsoft and password both allowed: the email carries both', async () => {
    resolveMethods.mockResolvedValue({ microsoft: true, password: true });
    await newInvite();
    expect(sendInvite.mock.calls[0]![0]).toMatchObject({
      microsoftUrl: 'https://x/portal/accept-invite?token=raw-token&method=microsoft', passwordAllowed: true,
    });
  });

  it('invite email is unchanged when Microsoft is off', async () => {
    await newInvite();
    const sent = sendInvite.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.passwordAllowed).toBe(true);
    expect(sent.microsoftUrl).toBeUndefined();
  });

  it('a policy read that fails sends no invite and issues no token (emailSent false)', async () => {
    resolveMethods.mockRejectedValue(new Error('db down'));
    const res = await newInvite();
    expect(res.status).toBe(200);
    expect((await res.json()).emailSent).toBe(false);
    expect(issueTokenMock).not.toHaveBeenCalled();
    expect(sendInvite).not.toHaveBeenCalled();
  });
});

describe('POST /organizations/:id/portal-users/sso-invite (W4)', () => {
  const PU = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  const row = (id: string, over: Record<string, unknown> = {}) => ({
    id, orgId: ORG_ID, email: `${id.slice(-1)}@acme.example`, name: null, passwordHash: null, authMethod: 'password',
    status: 'invited', authEpoch: 5, browserAccess: 'granted', hasExternalIdentity: false, ...over,
  });
  const ssoInvite = (body: unknown) => makeApp().request(`/organizations/${ORG_ID}/portal-users/sso-invite`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  it('Microsoft not effective for the org → 409 PORTAL_SSO_INVITE_UNAVAILABLE, nothing written or sent', async () => {
    selectResult.mockResolvedValueOnce([{ id: ORG_ID }]);
    const res = await ssoInvite({ portalUserIds: [PU(1)] });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: expect.any(String), code: 'PORTAL_SSO_INVITE_UNAVAILABLE' });
    expect(setSpy).not.toHaveBeenCalled();
    expect(sendInvite).not.toHaveBeenCalled();
  });

  /** withDbTransaction as a savepoint that runs its callback, bracketed in `events`. */
  const savepoints = () => {
    txState.impl = async (fn) => {
      events.push('tx:begin');
      try { return await fn(); } finally { events.push('tx:end'); }
    };
  };
  /** Each account is read twice: its row lock, then its facts re-read under that lock. */
  const locked = (r: ReturnType<typeof row>) => [[{ id: r.id }], [r]] as const;
  const queue = (...results: ReadonlyArray<readonly unknown[]>) => { for (const r of results) selectResult.mockResolvedValueOnce(r); };
  const NO_BRANDING: unknown[] = []; // issueAndSendInvite's partner-branding read (its own savepoint)

  it('sso-invite re-invites only stranded accounts and reports not_stranded for the rest', async () => {
    resolveMethods.mockResolvedValue({ microsoft: true, password: false });
    savepoints();
    queue(
      [{ id: ORG_ID }],                                                                    // org existence
      [{ name: 'Acme Co' }],                                                               // org name
      ...locked(row(PU(1))), NO_BRANDING,                                                  // stranded, invited
      ...locked(row(PU(2), { status: 'active', passwordHash: 'h', hasExternalIdentity: true })), // has an identity
      [],                                                                                  // not in this org (no row to lock)
      ...locked(row(PU(4), { status: 'active', passwordHash: 'h' })), NO_BRANDING,         // stranded, active with a password
      ...locked(row(PU(5), { status: 'active' })),                                         // stranded legacy row …
      ...locked(row(PU(6), { status: 'disabled' })),                                       // disabled: not stranded
    );
    insertReturning
      .mockResolvedValueOnce([{ authEpoch: 6 }])  // PU(1) moved
      .mockResolvedValueOnce([{ authEpoch: 6 }])  // PU(4) moved (active with a password → invited)
      .mockResolvedValueOnce([]);                 // … PU(5) changed under us (epoch guard)

    const res = await ssoInvite({ portalUserIds: [PU(1), PU(2), PU(3), PU(4), PU(5), PU(6), PU(1)] });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([
      { portalUserId: PU(1), result: 'invited', emailSent: true },
      { portalUserId: PU(2), result: 'not_stranded' },
      { portalUserId: PU(3), result: 'not_stranded' },
      { portalUserId: PU(4), result: 'invited', emailSent: true },
      { portalUserId: PU(5), result: 'PORTAL_ACCOUNT_TRANSITION_REFUSED' },
      { portalUserId: PU(6), result: 'not_stranded' },
    ]);
    // The msp_sso_invite writer: invited + granted, epoch bumped, guarded by the epoch read.
    expect(setSpy).toHaveBeenCalledTimes(3);
    expect(setSpy.mock.calls[0]![0]).toMatchObject({ status: 'invited', browserAccess: 'granted', invitedBy: 'u-1' });
    expect(setSpy.mock.calls[0]![0]).toHaveProperty('authEpoch');
    expect(new PgDialect().sqlToQuery(updateWhereSpy.mock.calls[0]![0] as never).params).toEqual(expect.arrayContaining([PU(1), ORG_ID, 5]));
    expect(purgePortalSessionsForUsers).toHaveBeenCalledWith([PU(1)]);
    expect(purgePortalSessionsForUsers).toHaveBeenCalledWith([PU(4)]);
    // Microsoft invites, each bound to the NEW epoch.
    expect(issueTokenMock).toHaveBeenCalledTimes(2);
    expect(issueTokenMock).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'invite', portalUserId: PU(1), authEpoch: 6 }));
    expect(issueTokenMock).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'invite', portalUserId: PU(4), authEpoch: 6 }));
    expect(sendInvite).toHaveBeenCalledTimes(2);
    expect(sendInvite.mock.calls[0]![0]).toMatchObject({ to: '1@acme.example', microsoftUrl: expect.stringContaining('&method=microsoft'), passwordAllowed: false });
    expect(auditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG_ID,
      action: 'organization.portal_user.sso_invite',
      details: { requested: 6, invited: 2, notStranded: 3, refused: 1 },
    }));
    // PU(1): row lock, re-read and write in ONE savepoint; the purge and the
    // invite (its branding read in a savepoint of its own) only after it.
    expect(events.slice(0, 13)).toEqual([
      'select', 'select',                                                      // org existence, org name
      'tx:begin', 'select', 'for:update', 'select', 'update', 'tx:end',       // PU(1) under its lock
      'purge',
      'tx:begin', 'select', 'tx:end',                                          // branding
      'tx:begin',                                                              // PU(2) …
    ]);
  });

  it('a purge failure after the write is logged and the invite is still sent (result invited)', async () => {
    resolveMethods.mockResolvedValue({ microsoft: true, password: false });
    savepoints();
    queue([{ id: ORG_ID }], [{ name: 'Acme Co' }], ...locked(row(PU(1))), NO_BRANDING);
    insertReturning.mockResolvedValueOnce([{ authEpoch: 6 }]);
    vi.mocked(purgePortalSessionsForUsers).mockRejectedValueOnce(new Error('redis down'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await ssoInvite({ portalUserIds: [PU(1)] });
      expect(res.status).toBe(200);
      expect((await res.json()).data).toEqual([{ portalUserId: PU(1), result: 'invited', emailSent: true }]);
      expect(sendInvite).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it('reads eligibility under the row lock: a link that committed while the lock waited → not_stranded, nothing written', async () => {
    resolveMethods.mockResolvedValue({ microsoft: true, password: false });
    savepoints();
    queue(
      [{ id: ORG_ID }],
      [{ name: 'Acme Co' }],
      [row(PU(1))],                                   // the lock (the snapshot from before the link committed)
      [row(PU(1), { hasExternalIdentity: true })],    // the re-read AFTER the lock: the self-link is visible
    );
    insertReturning.mockResolvedValue([{ authEpoch: 6 }]);
    const res = await ssoInvite({ portalUserIds: [PU(1)] });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([{ portalUserId: PU(1), result: 'not_stranded' }]);
    expect(setSpy).not.toHaveBeenCalled();
    expect(purgePortalSessionsForUsers).not.toHaveBeenCalled();
    expect(sendInvite).not.toHaveBeenCalled();
    expect(events).toEqual(['select', 'select', 'tx:begin', 'select', 'for:update', 'select', 'tx:end']);
    // The decision comes from the re-read: it carries the identity fact, the lock only the id.
    const columns = vi.mocked(db.select).mock.calls.map((call) => Object.keys(((call as unknown[])[0] ?? {}) as Record<string, unknown>));
    expect(columns[2]).toEqual(['id']);
    expect(columns[3]).toContain('hasExternalIdentity');
  });

  it('while password sign-in is still allowed, an active account with a password is not stranded (nothing written)', async () => {
    resolveMethods.mockResolvedValue({ microsoft: true, password: true });
    savepoints();
    queue(
      [{ id: ORG_ID }],
      [{ name: 'Acme Co' }],
      ...locked(row(PU(4), { status: 'active', passwordHash: 'h' })),
    );
    const res = await ssoInvite({ portalUserIds: [PU(4)] });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([{ portalUserId: PU(4), result: 'not_stranded' }]);
    expect(setSpy).not.toHaveBeenCalled();
    expect(sendInvite).not.toHaveBeenCalled();
  });

  it('validates the batch: 1..100 uuids', async () => {
    expect((await ssoInvite({ portalUserIds: [] })).status).toBe(400);
    expect((await ssoInvite({ portalUserIds: ['nope'] })).status).toBe(400);
    expect((await ssoInvite({ portalUserIds: Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) })).status).toBe(400);
    expect(setSpy).not.toHaveBeenCalled();
  });
});

describe('POST /organizations/:id/portal-users/:userId/browser-access (W4)', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'pu-1', orgId: ORG_ID, email: 'addin@acme.example', name: null, passwordHash: null, authMethod: 'entra',
    status: 'active', authEpoch: 4, browserAccess: 'none', hasExternalIdentity: true, ...over,
  });
  const grant = () => makeApp().request(`/organizations/${ORG_ID}/portal-users/pu-1/browser-access`, { method: 'POST' });

  it('browser-access grant on an add-in account keeps its epoch; on a disabled account → 409', async () => {
    selectResult.mockResolvedValueOnce([{ id: ORG_ID }]).mockResolvedValueOnce([row()]);
    insertReturning.mockResolvedValueOnce([{ id: 'pu-1' }]);
    const res = await grant();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { browserAccess: 'granted' } });
    const set = setSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(set).toMatchObject({ status: 'active', browserAccess: 'granted' });
    // No epoch bump: the person's live add-in sessions keep working.
    expect(set).not.toHaveProperty('authEpoch');
    expect(purgePortalSessionsForUsers).not.toHaveBeenCalled();
    // Still guarded by the epoch it read.
    expect(new PgDialect().sqlToQuery(updateWhereSpy.mock.calls[0]![0] as never).params).toEqual(expect.arrayContaining(['pu-1', ORG_ID, 4]));
    expect(auditMock).toHaveBeenCalledWith(expect.anything(), {
      orgId: ORG_ID,
      action: 'organization.portal_user.browser_access.grant',
      resourceType: 'portal_user',
      resourceId: 'pu-1',
      details: { email: 'addin@acme.example' },
    });

    vi.clearAllMocks();
    selectResult.mockResolvedValueOnce([{ id: ORG_ID }]).mockResolvedValueOnce([row({ status: 'disabled' })]);
    const disabled = await grant();
    expect(disabled.status).toBe(409);
    expect(await disabled.json()).toEqual({ error: 'This user is disabled. Reactivate them first.', code: 'PORTAL_ACCOUNT_TRANSITION_REFUSED' });
    expect(setSpy).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('an invited account → 409 with the writer message; a missing one → 404', async () => {
    selectResult.mockResolvedValueOnce([{ id: ORG_ID }]).mockResolvedValueOnce([row({ status: 'invited', authMethod: 'password', hasExternalIdentity: false })]);
    const invited = await grant();
    expect(invited.status).toBe(409);
    expect(await invited.json()).toEqual({ error: 'This user has a pending invite.', code: 'PORTAL_ACCOUNT_TRANSITION_REFUSED' });

    selectResult.mockResolvedValueOnce([{ id: ORG_ID }]).mockResolvedValueOnce([]);
    expect((await grant()).status).toBe(404);
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('already granted: 200 with no write and no audit; a concurrent change → 409', async () => {
    selectResult.mockResolvedValueOnce([{ id: ORG_ID }]).mockResolvedValueOnce([row({ browserAccess: 'granted' })]);
    const same = await grant();
    expect(same.status).toBe(200);
    expect(setSpy).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();

    selectResult.mockResolvedValueOnce([{ id: ORG_ID }]).mockResolvedValueOnce([row()]);
    insertReturning.mockResolvedValueOnce([]);
    const raced = await grant();
    expect(raced.status).toBe(409);
    expect((await raced.json()).code).toBe('PORTAL_ACCOUNT_TRANSITION_REFUSED');
    expect(auditMock).not.toHaveBeenCalled();
  });
});
