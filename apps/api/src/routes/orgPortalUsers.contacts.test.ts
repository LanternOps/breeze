/**
 * Portal registration W1 (#11378): invite FROM CONTACTS.
 *
 *  - `POST …/portal-users/invite` with `contactId` binds the login to that
 *    contact, and only when the invite email equals the contact's email.
 *  - `POST …/portal-users/invite-contacts` is the capped batch with exactly
 *    five per-contact outcomes.
 *
 * The planner/binder (`services/contacts/portalInvite`) is mocked here; its
 * own tests and the integration suite cover the SQL. The existing
 * `orgPortalUsers.test.ts` select-order mocks stay untouched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const h = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'partner' as string,
      user: { id: 'u-1', name: 'Tess', email: 'tess@msp.example' },
      partnerId: 'p-1' as string | null,
      canAccessOrg: (_id: string): boolean => true,
      canAccessSite: (_id: string): boolean => true,
    },
  },
  selectResult: vi.fn(),
  insertReturning: vi.fn(),
  sendInvite: vi.fn(),
  auditMock: vi.fn(),
  loadMock: vi.fn(),
  bindMock: vi.fn(),
  lockMock: vi.fn(),
  linkMock: vi.fn(),
  purgeAi: vi.fn(),
  withTx: vi.fn(),
  storeToken: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn(async (c: any, next: any) => { c.set('auth', h.authRef.current); await next(); }),
  requireScope: () => async (_c: any, next: any) => next(),
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
}));
vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          const leaf: any = {
            limit: vi.fn(() => h.selectResult()),
            orderBy: vi.fn(() => h.selectResult()),
            then: (resolve: any, reject: any) => h.selectResult().then(resolve, reject),
          };
          leaf.for = vi.fn(() => leaf);
          return leaf;
        }),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn(() => h.insertReturning()) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(() => h.insertReturning()) })) })) })),
    delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
    execute: vi.fn(() => Promise.resolve([])),
  },
  withDbTransaction: h.withTx,
}));
vi.mock('../services/auditEvents', () => ({ writeRouteAudit: h.auditMock }));
vi.mock('../services/contacts/portalInvite', async () => {
  const actual = await vi.importActual<typeof import('../services/contacts/portalInvite')>('../services/contacts/portalInvite');
  return {
    ...actual,
    loadOrgContactsForPortalInvite: h.loadMock,
    bindContactLoginForInvite: h.bindMock,
    lockPortalInviteAddresses: h.lockMock,
  };
});
vi.mock('../services/contacts/loginLink', () => ({ linkLoginToContact: h.linkMock }));
// W2 (#11379): invite links are purpose-bound capability tokens, bound to the
// row's auth_epoch at issue time.
vi.mock('./portal/capabilityTokens', () => ({ issuePortalCapabilityToken: h.storeToken }));
vi.mock('./portal/helpers', () => ({
  buildPortalUrl: (p: string) => `https://x/portal${p}`,
  purgePortalSessionsForUsers: vi.fn(async () => 0),
}));
vi.mock('../services/email', () => ({ getEmailService: () => ({ sendPortalInvite: h.sendInvite }) }));
vi.mock('../services/redis', () => ({ getRedis: () => ({ fake: true }) }));
vi.mock('../services/clientAiSessionStore', () => ({ purgeClientAiSessionsForUsers: h.purgeAi }));
// W4 (#11381): issueAndSendInvite reads the org's sign-in methods for the email
// (orgPortalUsers.test.ts covers that); here a password-only org.
vi.mock('../services/portalSsoOnly', () => ({
  isSsoOnlyStranded: () => false,
  resolveInviteSignInMethods: async () => ({ microsoft: false, password: true }),
}));

import { authMiddleware } from '../middleware/auth';
import { registerOrgPortalUsersRoutes } from './orgPortalUsers';
import { purgePortalSessionsForUsers } from './portal/helpers';
import { ContactGoneError, ContactEmailChangedError, PortalLoginChangedError } from '../services/contacts/portalInvite';
import { PORTAL_ACCOUNT_TRANSITION_REFUSED, PortalAccountTransitionError } from '../services/portalAccountState';

/** What the state module throws for a stored status outside its known set (fail closed). */
const unknownState = () => new PortalAccountTransitionError(PORTAL_ACCOUNT_TRANSITION_REFUSED, 409, 'msp_invite', 'unknown_status', 'This portal user is in an unknown state.');

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';
const C1 = '11111111-1111-4111-8111-111111111111';
const C2 = '22222222-2222-4222-8222-222222222222';
const C3 = '33333333-3333-4333-8333-333333333333';
const C4 = '44444444-4444-4444-8444-444444444444';
const C5 = '55555555-5555-4555-8555-555555555555';
const C6 = '66666666-6666-4666-8666-666666666666';
const SITE = '99999999-9999-4999-8999-999999999999';

const makeApp = () => { const app = new Hono(); app.use('*', authMiddleware as any); registerOrgPortalUsersRoutes(app); return app; };
const post = (path: string, body: unknown) => makeApp().request(`/organizations/${ORG_ID}/portal-users/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const contactRow = (id: string, email: string | null, over: Record<string, unknown> = {}) => ({ id, orgId: ORG_ID, siteId: null, name: `Name ${id.slice(0, 2)}`, email, ...over });
const invited = (portalUserId: string, email: string, over: Record<string, unknown> = {}) => ({ kind: 'invite', portalUserId, email, authEpoch: 4, created: true, contactLink: 'direct', ...over });

beforeEach(() => {
  vi.clearAllMocks();
  h.authRef.current = {
    scope: 'partner', user: { id: 'u-1', name: 'Tess', email: 'tess@msp.example' }, partnerId: 'p-1',
    canAccessOrg: () => true, canAccessSite: () => true,
  };
  // First select is resolveAccessibleOrg's existence check; everything after
  // (org name, branding) reads as empty.
  h.selectResult.mockReset();
  h.selectResult.mockResolvedValueOnce([{ id: ORG_ID }]).mockResolvedValue([]);
  h.withTx.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  h.storeToken.mockResolvedValue('raw-token');
  h.sendInvite.mockResolvedValue(undefined);
  h.lockMock.mockResolvedValue(undefined);
});

describe('POST …/invite with contactId', () => {
  it('binds directly to the named contact and never calls linkLoginToContact', async () => {
    h.loadMock.mockResolvedValueOnce([contactRow(C1, 'ada@acme.test')]);
    // The bind must run INSIDE a savepoint (catch outside it, #11203).
    let depth = 0;
    let bindDepth = -1;
    h.withTx.mockImplementation(async (fn: () => Promise<unknown>) => { depth += 1; try { return await fn(); } finally { depth -= 1; } });
    h.bindMock.mockImplementationOnce(async () => { bindDepth = depth; return invited('pu-1', 'ada@acme.test'); });

    const res = await post('invite', { email: 'ada@acme.test', contactId: C1 });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ data: { id: 'pu-1', email: 'ada@acme.test', status: 'invited', contactLink: 'direct' }, emailSent: true });
    expect(h.bindMock).toHaveBeenCalledTimes(1);
    const [, input] = h.bindMock.mock.calls[0]!;
    expect(input).toMatchObject({ orgId: ORG_ID, normalizedEmail: 'ada@acme.test', contact: { id: C1 }, actor: { userId: 'u-1' } });
    expect(bindDepth).toBe(1);
    expect(h.linkMock).not.toHaveBeenCalled();
    expect(h.sendInvite).toHaveBeenCalledWith(expect.objectContaining({ to: 'ada@acme.test' }));
    // The invite token is bound to the epoch the bind's write returned.
    expect(h.storeToken).toHaveBeenCalledWith({ purpose: 'invite', portalUserId: 'pu-1', orgId: ORG_ID, email: 'ada@acme.test', authEpoch: 4 });
  });

  it('409s PORTAL_ACCOUNT_TRANSITION_REFUSED when the login changed between read and write (epoch guard), sending nothing', async () => {
    h.loadMock.mockResolvedValueOnce([contactRow(C1, 'ada@acme.test')]);
    h.bindMock.mockRejectedValueOnce(new PortalLoginChangedError());
    const res = await post('invite', { email: 'ada@acme.test', contactId: C1 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'This portal user changed while the request was in progress. Reload and try again.', code: 'PORTAL_ACCOUNT_TRANSITION_REFUSED' });
    expect(h.storeToken).not.toHaveBeenCalled();
    expect(h.sendInvite).not.toHaveBeenCalled();
    expect(h.auditMock).not.toHaveBeenCalled();
  });

  it('accepts a case-different invite email (Ada@Acme.TEST vs ada@acme.test)', async () => {
    h.loadMock.mockResolvedValueOnce([contactRow(C1, 'ada@acme.test')]);
    h.bindMock.mockResolvedValueOnce(invited('pu-1', 'ada@acme.test'));
    const res = await post('invite', { email: 'Ada@Acme.TEST', contactId: C1 });
    expect(res.status).toBe(200);
  });

  it('refuses an email that differs from the contact email with 400 PORTAL_INVITE_EMAIL_MISMATCH and writes nothing', async () => {
    h.loadMock.mockResolvedValueOnce([contactRow(C1, 'ada@acme.test')]);
    const res = await post('invite', { email: 'someone@else.test', contactId: C1 });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('PORTAL_INVITE_EMAIL_MISMATCH');
    expect(h.bindMock).not.toHaveBeenCalled();
    expect(h.sendInvite).not.toHaveBeenCalled();
    expect(h.auditMock).not.toHaveBeenCalled();
  });

  it('404s PORTAL_INVITE_CONTACT_NOT_FOUND when the contact is not in this org', async () => {
    h.loadMock.mockResolvedValueOnce([]);
    const res = await post('invite', { email: 'ada@acme.test', contactId: C1 });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('PORTAL_INVITE_CONTACT_NOT_FOUND');
    // The org bound is passed: the loader reads by (org, id), never id alone.
    expect(h.loadMock).toHaveBeenCalledWith(expect.anything(), ORG_ID, [C1]);
    expect(h.bindMock).not.toHaveBeenCalled();
  });

  it('404s a contact pinned to a site the caller cannot reach (same body as not found)', async () => {
    h.authRef.current.canAccessSite = () => false;
    h.loadMock.mockResolvedValueOnce([contactRow(C1, 'ada@acme.test', { siteId: SITE })]);
    const res = await post('invite', { email: 'ada@acme.test', contactId: C1 });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Contact not found', code: 'PORTAL_INVITE_CONTACT_NOT_FOUND' });
    expect(h.bindMock).not.toHaveBeenCalled();
  });

  it('400s PORTAL_INVITE_CONTACT_NO_EMAIL for a contact without an email', async () => {
    h.loadMock.mockResolvedValueOnce([contactRow(C1, null)]);
    const res = await post('invite', { email: 'ada@acme.test', contactId: C1 });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('PORTAL_INVITE_CONTACT_NO_EMAIL');
    expect(h.bindMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'email_bound_to_other_contact', portalUserId: 'pu-9' }, 'PORTAL_INVITE_CONTACT_CONFLICT'],
    [{ kind: 'already_has_access', portalUserId: 'pu-9', reason: 'active' }, 'PORTAL_INVITE_ALREADY_ACTIVE'],
    [{ kind: 'already_has_access', portalUserId: 'pu-9', reason: 'disabled' }, 'PORTAL_INVITE_USER_DISABLED'],
    [{ kind: 'already_has_access', portalUserId: 'pu-9', reason: 'external_identity' }, 'PORTAL_INVITE_EXTERNAL_IDENTITY'],
    [{ kind: 'already_has_access', portalUserId: 'pu-9', reason: 'login_email_differs' }, 'PORTAL_INVITE_LOGIN_EMAIL_DIFFERS'],
  ])('refusal %o → 409 %s, no email, no audit', async (decision, code) => {
    h.loadMock.mockResolvedValueOnce([contactRow(C1, 'ada@acme.test')]);
    h.bindMock.mockResolvedValueOnce(decision);
    const res = await post('invite', { email: 'ada@acme.test', contactId: C1 });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe(code);
    expect(h.storeToken).not.toHaveBeenCalled();
    expect(h.sendInvite).not.toHaveBeenCalled();
    expect(h.auditMock).not.toHaveBeenCalled();
    expect(purgePortalSessionsForUsers).not.toHaveBeenCalled();
  });

  it('re-invite of a login already bound to the same contact reports contactLink kept and purges sessions', async () => {
    h.loadMock.mockResolvedValueOnce([contactRow(C1, 'ada@acme.test')]);
    h.bindMock.mockResolvedValueOnce(invited('pu-1', 'ada@acme.test', { created: false, contactLink: 'kept' }));
    const res = await post('invite', { email: 'ada@acme.test', contactId: C1 });
    expect(res.status).toBe(200);
    expect((await res.json()).data.contactLink).toBe('kept');
    expect(purgePortalSessionsForUsers).toHaveBeenCalledWith(['pu-1']);
    expect(h.purgeAi).toHaveBeenCalledWith(expect.anything(), ['pu-1']);
  });

  it('does not purge sessions for a freshly created login', async () => {
    h.loadMock.mockResolvedValueOnce([contactRow(C1, 'ada@acme.test')]);
    h.bindMock.mockResolvedValueOnce(invited('pu-1', 'ada@acme.test'));
    await post('invite', { email: 'ada@acme.test', contactId: C1 });
    expect(purgePortalSessionsForUsers).not.toHaveBeenCalled();
  });

  it('404s when the contact is deleted between load and bind (ContactGoneError)', async () => {
    h.loadMock.mockResolvedValueOnce([contactRow(C1, 'ada@acme.test')]);
    h.bindMock.mockRejectedValueOnce(new ContactGoneError());
    const res = await post('invite', { email: 'ada@acme.test', contactId: C1 });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('PORTAL_INVITE_CONTACT_NOT_FOUND');
    expect(h.sendInvite).not.toHaveBeenCalled();
  });

  it('400s PORTAL_INVITE_EMAIL_MISMATCH when the contact email changes between load and bind', async () => {
    h.loadMock.mockResolvedValueOnce([contactRow(C1, 'ada@acme.test')]);
    h.bindMock.mockRejectedValueOnce(new ContactEmailChangedError());
    const res = await post('invite', { email: 'ada@acme.test', contactId: C1 });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('PORTAL_INVITE_EMAIL_MISMATCH');
    expect(h.sendInvite).not.toHaveBeenCalled();
  });

  it('fails closed with the state module\'s own code on an unknown stored state, sending nothing', async () => {
    h.loadMock.mockResolvedValueOnce([contactRow(C1, 'ada@acme.test')]);
    h.bindMock.mockRejectedValueOnce(unknownState());
    const res = await post('invite', { email: 'ada@acme.test', contactId: C1 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'This portal user is in an unknown state.', code: 'PORTAL_ACCOUNT_TRANSITION_REFUSED' });
    expect(h.storeToken).not.toHaveBeenCalled();
    expect(h.sendInvite).not.toHaveBeenCalled();
    expect(h.auditMock).not.toHaveBeenCalled();
  });

  it('rethrows an unexpected bind failure (500), sending nothing', async () => {
    h.loadMock.mockResolvedValueOnce([contactRow(C1, 'ada@acme.test')]);
    h.bindMock.mockRejectedValueOnce(new Error('boom'));
    const res = await post('invite', { email: 'ada@acme.test', contactId: C1 });
    expect(res.status).toBe(500);
    expect(h.sendInvite).not.toHaveBeenCalled();
  });

  it('audits contactId and contactLink', async () => {
    h.loadMock.mockResolvedValueOnce([contactRow(C1, 'ada@acme.test')]);
    h.bindMock.mockResolvedValueOnce(invited('pu-1', 'ada@acme.test'));
    await post('invite', { email: 'ada@acme.test', contactId: C1 });
    expect(h.auditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG_ID,
      action: 'organization.portal_user.invite',
      resourceType: 'portal_user',
      resourceId: 'pu-1',
      details: { email: 'ada@acme.test', emailSent: true, contactLink: 'direct', contactId: C1 },
    }));
  });

  it('reports emailSent:false (still 200) when the email cannot be sent', async () => {
    h.loadMock.mockResolvedValueOnce([contactRow(C1, 'ada@acme.test')]);
    h.bindMock.mockResolvedValueOnce(invited('pu-1', 'ada@acme.test'));
    h.sendInvite.mockRejectedValueOnce(new Error('smtp down'));
    const res = await post('invite', { email: 'ada@acme.test', contactId: C1 });
    expect(res.status).toBe(200);
    expect((await res.json()).emailSent).toBe(false);
  });
});

describe('POST …/invite without contactId (stable codes on the existing 409s)', () => {
  // The refusal itself comes from the W2 state module; the invite route keeps
  // W1's stable PORTAL_INVITE_* codes on it.
  it.each([
    [{ authMethod: 'entra', status: 'active', passwordHash: null, browserAccess: 'none', hasExternalIdentity: true }, 'PORTAL_INVITE_EXTERNAL_IDENTITY', 'This identity is managed by an external sign-in provider.'],
    [{ authMethod: 'password', status: 'invited', passwordHash: null, browserAccess: 'granted', hasExternalIdentity: true }, 'PORTAL_INVITE_EXTERNAL_IDENTITY', 'This identity is managed by an external sign-in provider.'],
    [{ authMethod: 'password', status: 'disabled', passwordHash: null, browserAccess: 'granted', hasExternalIdentity: false }, 'PORTAL_INVITE_USER_DISABLED', 'This user is disabled. Reactivate them before inviting.'],
    [{ authMethod: 'password', status: 'active', passwordHash: 'h', browserAccess: 'granted', hasExternalIdentity: false }, 'PORTAL_INVITE_ALREADY_ACTIVE', 'This email already has an active portal account.'],
  ])('existing row %o → 409 %s with the old message', async (row, code, error) => {
    h.selectResult.mockReset();
    h.selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([{ id: 'pu-1', email: 'ada@acme.test', contactId: null, authEpoch: 1, ...row }])
      .mockResolvedValue([]);
    const res = await post('invite', { email: 'ada@acme.test' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error, code });
    expect(h.loadMock).not.toHaveBeenCalled();
  });

  it('an existing row in an unknown stored state fails closed with the module code (no PORTAL_INVITE_* reason), writing and sending nothing', async () => {
    h.selectResult.mockReset();
    h.selectResult
      .mockResolvedValueOnce([{ id: ORG_ID }])
      .mockResolvedValueOnce([{ id: 'pu-1', email: 'ada@acme.test', contactId: null, authEpoch: 1, authMethod: 'password', status: 'weird', passwordHash: null, browserAccess: 'granted', hasExternalIdentity: false }])
      .mockResolvedValue([]);
    const res = await post('invite', { email: 'ada@acme.test' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'This portal user is in an unknown state.', code: 'PORTAL_ACCOUNT_TRANSITION_REFUSED' });
    expect(h.insertReturning).not.toHaveBeenCalled();
    expect(h.linkMock).not.toHaveBeenCalled();
    expect(h.sendInvite).not.toHaveBeenCalled();
  });
});

describe('POST …/invite-contacts', () => {
  it('returns exactly one result per unique contactId with the five outcomes', async () => {
    h.loadMock.mockResolvedValueOnce([
      contactRow(C1, 'one@acme.test'),
      contactRow(C2, 'two@acme.test'),
      contactRow(C3, null),
      contactRow(C4, 'four@acme.test'),
      contactRow(C5, 'Shared@acme.test'),
      contactRow(C6, 'shared@ACME.test'),
    ]);
    h.bindMock.mockImplementation(async (_db: unknown, input: { contact: { id: string }; normalizedEmail: string }) => {
      if (input.contact.id === C1) return invited('pu-1', 'one@acme.test');
      if (input.contact.id === C2) return { kind: 'already_has_access', portalUserId: 'pu-2', reason: 'active' };
      if (input.contact.id === C4) return { kind: 'email_bound_to_other_contact', portalUserId: 'pu-4' };
      throw new Error(`unexpected bind for ${input.contact.id}`);
    });

    const res = await post('invite-contacts', { contactIds: [C1, C2, C3, C4, C5, C6] });

    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.results.map((r: any) => [r.contactId, r.outcome])).toEqual([
      [C1, 'invited'],
      [C2, 'already_has_access'],
      [C3, 'no_email'],
      [C4, 'email_bound_to_other_contact'],
      [C5, 'duplicate_email_in_batch'],
      [C6, 'duplicate_email_in_batch'],
    ]);
    expect(data.results[0]).toEqual({ contactId: C1, outcome: 'invited', portalUserId: 'pu-1', emailSent: true });
    expect(data.results[1]).toEqual({ contactId: C2, outcome: 'already_has_access', portalUserId: 'pu-2', reason: 'active' });
    expect(data.counts).toEqual({ invited: 1, already_has_access: 1, no_email: 1, email_bound_to_other_contact: 1, duplicate_email_in_batch: 2 });
  });

  it('never binds or emails a duplicate_email_in_batch or no_email contact', async () => {
    h.loadMock.mockResolvedValueOnce([contactRow(C1, 'one@acme.test'), contactRow(C3, '  '), contactRow(C5, 'dup@acme.test'), contactRow(C6, 'dup@acme.test')]);
    h.bindMock.mockResolvedValue(invited('pu-1', 'one@acme.test'));
    await post('invite-contacts', { contactIds: [C1, C3, C5, C6] });
    expect(h.bindMock.mock.calls.map((call) => call[1].contact.id)).toEqual([C1]);
    expect(h.sendInvite).toHaveBeenCalledTimes(1);
    // Every address locked up front, sorted by the helper: here only one.
    expect(h.lockMock).toHaveBeenCalledWith(expect.anything(), ORG_ID, ['one@acme.test']);
  });

  it('dedupes a contactId repeated in the request', async () => {
    h.loadMock.mockResolvedValueOnce([contactRow(C1, 'one@acme.test')]);
    h.bindMock.mockResolvedValue(invited('pu-1', 'one@acme.test'));
    const res = await post('invite-contacts', { contactIds: [C1, C1] });
    const { data } = await res.json();
    expect(data.results).toHaveLength(1);
    expect(h.loadMock).toHaveBeenCalledWith(expect.anything(), ORG_ID, [C1]);
    expect(h.bindMock).toHaveBeenCalledTimes(1);
  });

  it('404s the whole batch when any contactId is outside the org, and sends nothing', async () => {
    h.loadMock.mockResolvedValueOnce([contactRow(C1, 'one@acme.test')]);
    const res = await post('invite-contacts', { contactIds: [C1, C2] });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Contact not found', code: 'PORTAL_INVITE_CONTACT_NOT_FOUND' });
    expect(h.bindMock).not.toHaveBeenCalled();
    expect(h.sendInvite).not.toHaveBeenCalled();
    expect(h.auditMock).not.toHaveBeenCalled();
  });

  it('404s the whole batch when a contact is on an unreachable site', async () => {
    h.authRef.current.canAccessSite = (id: string) => id !== SITE;
    h.loadMock.mockResolvedValueOnce([contactRow(C1, 'one@acme.test'), contactRow(C2, 'two@acme.test', { siteId: SITE })]);
    const res = await post('invite-contacts', { contactIds: [C1, C2] });
    expect(res.status).toBe(404);
    expect(h.bindMock).not.toHaveBeenCalled();
  });

  it('404s and sends no email when a contact disappears mid-batch (ContactGoneError)', async () => {
    h.loadMock.mockResolvedValueOnce([contactRow(C1, 'one@acme.test'), contactRow(C2, 'two@acme.test')]);
    h.bindMock
      .mockResolvedValueOnce(invited('pu-1', 'one@acme.test'))
      .mockRejectedValueOnce(new ContactGoneError());
    const res = await post('invite-contacts', { contactIds: [C1, C2] });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('PORTAL_INVITE_CONTACT_NOT_FOUND');
    // Phase 1 runs in ONE savepoint, so the first bind is rolled back with it.
    expect(h.withTx).toHaveBeenCalledTimes(1);
    expect(h.storeToken).not.toHaveBeenCalled();
    expect(h.sendInvite).not.toHaveBeenCalled();
    expect(h.auditMock).not.toHaveBeenCalled();
  });

  it('409s and sends nothing when a login changes mid-batch (epoch guard): the savepoint rolls back every bind', async () => {
    h.loadMock.mockResolvedValueOnce([contactRow(C1, 'one@acme.test'), contactRow(C2, 'two@acme.test')]);
    h.bindMock
      .mockResolvedValueOnce(invited('pu-1', 'one@acme.test'))
      .mockRejectedValueOnce(new PortalLoginChangedError());
    const res = await post('invite-contacts', { contactIds: [C1, C2] });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('PORTAL_ACCOUNT_TRANSITION_REFUSED');
    expect(h.withTx).toHaveBeenCalledTimes(1);
    expect(h.storeToken).not.toHaveBeenCalled();
    expect(h.sendInvite).not.toHaveBeenCalled();
    expect(h.auditMock).not.toHaveBeenCalled();
  });

  it('fails the whole batch closed on an unknown stored state (savepoint rolls back), sending nothing', async () => {
    h.loadMock.mockResolvedValueOnce([contactRow(C1, 'one@acme.test'), contactRow(C2, 'two@acme.test')]);
    h.bindMock
      .mockResolvedValueOnce(invited('pu-1', 'one@acme.test'))
      .mockRejectedValueOnce(unknownState());
    const res = await post('invite-contacts', { contactIds: [C1, C2] });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('PORTAL_ACCOUNT_TRANSITION_REFUSED');
    expect(h.withTx).toHaveBeenCalledTimes(1);
    expect(h.storeToken).not.toHaveBeenCalled();
    expect(h.sendInvite).not.toHaveBeenCalled();
    expect(h.auditMock).not.toHaveBeenCalled();
  });

  it('binds each emailed invite token to that login\'s own post-write epoch', async () => {
    h.loadMock.mockResolvedValueOnce([contactRow(C1, 'one@acme.test'), contactRow(C2, 'two@acme.test')]);
    h.bindMock
      .mockResolvedValueOnce(invited('pu-1', 'one@acme.test', { authEpoch: 1 }))
      .mockResolvedValueOnce(invited('pu-2', 'two@acme.test', { authEpoch: 9, created: false, contactLink: 'kept' }));
    await post('invite-contacts', { contactIds: [C1, C2] });
    expect(h.storeToken.mock.calls.map((call) => call[0])).toEqual([
      { purpose: 'invite', portalUserId: 'pu-1', orgId: ORG_ID, email: 'one@acme.test', authEpoch: 1 },
      { purpose: 'invite', portalUserId: 'pu-2', orgId: ORG_ID, email: 'two@acme.test', authEpoch: 9 },
    ]);
  });

  it('reports invited with emailSent:false when the email service fails', async () => {
    h.loadMock.mockResolvedValueOnce([contactRow(C1, 'one@acme.test'), contactRow(C2, 'two@acme.test')]);
    h.bindMock
      .mockResolvedValueOnce(invited('pu-1', 'one@acme.test'))
      .mockResolvedValueOnce(invited('pu-2', 'two@acme.test'));
    h.sendInvite.mockRejectedValueOnce(new Error('smtp down'));
    const res = await post('invite-contacts', { contactIds: [C1, C2] });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.results).toEqual([
      { contactId: C1, outcome: 'invited', portalUserId: 'pu-1', emailSent: false },
      { contactId: C2, outcome: 'invited', portalUserId: 'pu-2', emailSent: true },
    ]);
  });

  it('reports emailSent:false when no invite token can be stored (Redis down)', async () => {
    h.loadMock.mockResolvedValueOnce([contactRow(C1, 'one@acme.test')]);
    h.bindMock.mockResolvedValueOnce(invited('pu-1', 'one@acme.test'));
    h.storeToken.mockResolvedValueOnce(null);
    const { data } = await (await post('invite-contacts', { contactIds: [C1] })).json();
    expect(data.results[0]).toMatchObject({ outcome: 'invited', emailSent: false });
    expect(h.sendInvite).not.toHaveBeenCalled();
  });

  it('a Redis failure storing one invite token does not 500 the batch after others were mailed', async () => {
    // Phase 2 runs after the binds; a throw there would roll back logins whose
    // invite links already went out. The failed contact reports emailSent:false.
    h.loadMock.mockResolvedValueOnce([contactRow(C1, 'one@acme.test'), contactRow(C2, 'two@acme.test')]);
    h.bindMock
      .mockResolvedValueOnce(invited('pu-1', 'one@acme.test'))
      .mockResolvedValueOnce(invited('pu-2', 'two@acme.test'));
    h.storeToken.mockResolvedValueOnce('raw-1').mockRejectedValueOnce(new Error('redis down'));

    const res = await post('invite-contacts', { contactIds: [C1, C2] });

    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.results).toEqual([
      { contactId: C1, outcome: 'invited', portalUserId: 'pu-1', emailSent: true },
      { contactId: C2, outcome: 'invited', portalUserId: 'pu-2', emailSent: false },
    ]);
    expect(h.sendInvite).toHaveBeenCalledTimes(1);
  });

  it('a session-purge failure on a re-invited login still reports the contact (emailSent:false) and continues', async () => {
    h.loadMock.mockResolvedValueOnce([contactRow(C1, 'one@acme.test'), contactRow(C2, 'two@acme.test')]);
    h.bindMock
      .mockResolvedValueOnce(invited('pu-1', 'one@acme.test', { created: false, contactLink: 'kept' }))
      .mockResolvedValueOnce(invited('pu-2', 'two@acme.test'));
    h.purgeAi.mockRejectedValueOnce(new Error('redis down'));

    const res = await post('invite-contacts', { contactIds: [C1, C2] });

    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.results.map((r: any) => [r.contactId, r.outcome, r.emailSent])).toEqual([
      [C1, 'invited', false],
      [C2, 'invited', true],
    ]);
  });

  it('locks every eligible address BEFORE the first bind, inside the same savepoint', async () => {
    let depth = 0;
    let lockDepth = -1;
    h.withTx.mockImplementation(async (fn: () => Promise<unknown>) => { depth += 1; try { return await fn(); } finally { depth -= 1; } });
    h.lockMock.mockImplementationOnce(async () => { lockDepth = depth; });
    h.loadMock.mockResolvedValueOnce([contactRow(C1, 'b@acme.test'), contactRow(C2, 'a@acme.test'), contactRow(C3, null)]);
    h.bindMock.mockResolvedValue(invited('pu-1', 'x@acme.test'));

    await post('invite-contacts', { contactIds: [C1, C2, C3] });

    expect(h.lockMock).toHaveBeenCalledTimes(1);
    expect(h.lockMock.mock.calls[0]![2]).toEqual(['b@acme.test', 'a@acme.test']);
    expect(h.lockMock.mock.invocationCallOrder[0]!).toBeLessThan(h.bindMock.mock.invocationCallOrder[0]!);
    expect(lockDepth).toBe(1);
  });

  it('purges sessions only for re-invited (not newly created) logins', async () => {
    h.loadMock.mockResolvedValueOnce([contactRow(C1, 'one@acme.test'), contactRow(C2, 'two@acme.test')]);
    h.bindMock
      .mockResolvedValueOnce(invited('pu-1', 'one@acme.test'))
      .mockResolvedValueOnce(invited('pu-2', 'two@acme.test', { created: false, contactLink: 'kept' }));
    await post('invite-contacts', { contactIds: [C1, C2] });
    expect(purgePortalSessionsForUsers).toHaveBeenCalledTimes(1);
    expect(purgePortalSessionsForUsers).toHaveBeenCalledWith(['pu-2']);
  });

  it('400s more than 100 contactIds', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `7c0a1f7e-1111-4222-8333-${i.toString(16).padStart(12, '0')}`);
    const res = await post('invite-contacts', { contactIds: ids });
    expect(res.status).toBe(400);
    expect(h.loadMock).not.toHaveBeenCalled();
  });

  it('writes one invite audit per invited contact and one invite_contacts summary', async () => {
    h.loadMock.mockResolvedValueOnce([contactRow(C1, 'one@acme.test'), contactRow(C2, 'two@acme.test'), contactRow(C3, null)]);
    h.bindMock
      .mockResolvedValueOnce(invited('pu-1', 'one@acme.test'))
      .mockResolvedValueOnce({ kind: 'already_has_access', portalUserId: 'pu-2', reason: 'disabled' });
    await post('invite-contacts', { contactIds: [C1, C2, C3] });

    const calls = h.auditMock.mock.calls.map((call) => call[1]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      orgId: ORG_ID,
      action: 'organization.portal_user.invite',
      resourceType: 'portal_user',
      resourceId: 'pu-1',
      details: { email: 'one@acme.test', emailSent: true, contactLink: 'direct', contactId: C1, source: 'invite_contacts' },
    });
    expect(calls[1]).toEqual({
      orgId: ORG_ID,
      action: 'organization.portal_user.invite_contacts',
      resourceType: 'organization',
      resourceId: ORG_ID,
      details: {
        requested: 3,
        counts: { invited: 1, already_has_access: 1, no_email: 1, email_bound_to_other_contact: 0, duplicate_email_in_batch: 0 },
      },
    });
  });
});
