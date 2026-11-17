/**
 * Portal registration W1 (#11378): invite FROM CONTACTS on real Postgres.
 *
 * Runs under vitest.integration.config.ts as the unprivileged `breeze_app`
 * role, so RLS is enforced. The cases that matter most are the ones RLS does
 * NOT decide: a sibling org of the same partner is visible to a partner-scope
 * tech, so only the app-layer `(id, org_id)` bound keeps its contact out of
 * this org's invite. The composite FK is the database backstop behind it.
 *
 * Harness copied from portalUserInvite.integration.test.ts.
 */
import './setup';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

// Capture the invite link the ROUTE emails, so the W2 cases below redeem the
// very token a contact invite issued (bound to the row's post-write epoch).
const { sentInvites } = vi.hoisted(() => ({ sentInvites: [] as Array<{ to: string; inviteUrl: string }> }));
vi.mock('../../services/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/email')>()),
  getEmailService: () => ({
    sendPortalInvite: async (msg: { to: string; inviteUrl: string }) => { sentInvites.push({ to: msg.to, inviteUrl: msg.inviteUrl }); },
    sendPasswordReset: async () => undefined,
  }),
}));
import { db, withDbTransaction, withSystemDbAccessContext } from '../../db';
import { contacts, portalUserIdentities, portalUsers } from '../../db/schema';
import { authMiddleware } from '../../middleware/auth';
import { registerOrgPortalUsersRoutes } from '../../routes/orgPortalUsers';
import { portalRoutes } from '../../routes/portal';
import { bindContactLoginForInvite, ContactGoneError } from '../../services/contacts/portalInvite';
import { createAccessToken } from '../../services/jwt';
import { createOrganization, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
type Env = Awaited<ReturnType<typeof setupTestEnvironment>>;

function buildMspApp(): Hono {
  const app = new Hono();
  app.use('*', authMiddleware);
  registerOrgPortalUsersRoutes(app);
  return app;
}

async function mfaTokenFor(env: Env): Promise<string> {
  return createAccessToken({
    sub: env.user.id,
    email: env.user.email,
    roleId: env.role.id,
    orgId: null,
    partnerId: env.partner.id,
    scope: 'partner',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: 'it-session',
  });
}

async function post(env: Env, orgId: string, path: string, body: unknown) {
  return buildMspApp().request(`/organizations/${orgId}/portal-users/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await mfaTokenFor(env)}`, ...JSON_HEADERS },
    body: JSON.stringify(body),
  });
}

async function seedContact(orgId: string, email: string | null, name = 'Seeded Contact', roles: string[] = []) {
  const [row] = await getTestDb().insert(contacts).values({ orgId, email, name, roles }).returning({ id: contacts.id });
  return row!.id;
}

async function seedLogin(values: Partial<typeof portalUsers.$inferInsert> & { orgId: string; email: string }) {
  const [row] = await getTestDb().insert(portalUsers).values({ authMethod: 'password', status: 'invited', ...values }).returning({ id: portalUsers.id });
  return row!.id;
}

async function loginsIn(orgId: string) {
  return withSystemDbAccessContext(() =>
    db.select({
      id: portalUsers.id,
      email: portalUsers.email,
      contactId: portalUsers.contactId,
      authMethod: portalUsers.authMethod,
      status: portalUsers.status,
    }).from(portalUsers).where(eq(portalUsers.orgId, orgId)),
  );
}

async function contactRoles(contactId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select({ roles: contacts.roles }).from(contacts).where(eq(contacts.id, contactId)),
  );
  return row?.roles ?? null;
}

describe('invite from contacts — real Postgres / RLS', () => {
  it('binds the new login to the named contact (contact_id set, auth_method password, status invited)', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const contactId = await seedContact(env.organization.id, 'ada@acme.example', 'Ada', ['billing']);

    const res = await post(env, env.organization.id, 'invite', { email: 'Ada@Acme.Example', contactId });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.contactLink).toBe('direct');
    const rows = await loginsIn(env.organization.id);
    expect(rows).toEqual([{ id: body.data.id, email: 'ada@acme.example', contactId, authMethod: 'password', status: 'invited' }]);
    // The 'portal' role is UNIONED onto the contact, never replacing billing.
    expect([...(await contactRoles(contactId))!].sort()).toEqual(['billing', 'portal']);
  });

  it('refuses a contactId from a sibling org of the SAME partner with 404 and creates no portal_users row in either org', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const orgA2 = await createOrganization({ partnerId: env.partner.id });
    const siblingContact = await seedContact(orgA2.id, 'ada@acme.example');

    const res = await post(env, env.organization.id, 'invite', { email: 'ada@acme.example', contactId: siblingContact });

    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('PORTAL_INVITE_CONTACT_NOT_FOUND');
    expect(await loginsIn(env.organization.id)).toEqual([]);
    expect(await loginsIn(orgA2.id)).toEqual([]);
    expect(await contactRoles(siblingContact)).toEqual([]);
  });

  it('refuses a contactId from another partner with 404 (RLS-hidden)', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const other = await setupTestEnvironment({ scope: 'partner' });
    const foreignContact = await seedContact(other.organization.id, 'ada@acme.example');

    const res = await post(env, env.organization.id, 'invite', { email: 'ada@acme.example', contactId: foreignContact });

    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('PORTAL_INVITE_CONTACT_NOT_FOUND');
    expect(await loginsIn(env.organization.id)).toEqual([]);
    expect(await loginsIn(other.organization.id)).toEqual([]);
  });

  it('refuses an email that does not equal the contact email (400 PORTAL_INVITE_EMAIL_MISMATCH), no row written', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const contactId = await seedContact(env.organization.id, 'ada@acme.example');

    const res = await post(env, env.organization.id, 'invite', { email: 'someone-else@acme.example', contactId });

    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('PORTAL_INVITE_EMAIL_MISMATCH');
    expect(await loginsIn(env.organization.id)).toEqual([]);
    expect(await contactRoles(contactId)).toEqual([]);
  });

  it('409 PORTAL_INVITE_CONTACT_CONFLICT when the address has a login bound to a different contact, and the existing binding is unchanged', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const orgId = env.organization.id;
    const otherContact = await seedContact(orgId, 'shared@acme.example', 'Other');
    const contactId = await seedContact(orgId, 'shared@acme.example', 'Target');
    const loginId = await seedLogin({ orgId, email: 'shared@acme.example', contactId: otherContact });

    const res = await post(env, orgId, 'invite', { email: 'shared@acme.example', contactId });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('PORTAL_INVITE_CONTACT_CONFLICT');
    const rows = await loginsIn(orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: loginId, contactId: otherContact });
  });

  it('re-invite of a login bound to the same contact keeps the binding (contactLink kept)', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const orgId = env.organization.id;
    const contactId = await seedContact(orgId, 'ada@acme.example', 'Ada', ['portal']);
    const loginId = await seedLogin({ orgId, email: 'ada@acme.example', contactId });

    const res = await post(env, orgId, 'invite', { email: 'ada@acme.example', contactId });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ id: loginId, contactLink: 'kept' });
    const rows = await loginsIn(orgId);
    expect(rows).toEqual([expect.objectContaining({ id: loginId, contactId, status: 'invited' })]);
  });

  it('a pending login bound under the contact\'s OLD address is refused, never re-mailed (login_email_differs)', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const orgId = env.organization.id;
    const contactId = await seedContact(orgId, 'new@acme.example');
    const loginId = await seedLogin({ orgId, email: 'old@acme.example', contactId });

    const res = await post(env, orgId, 'invite', { email: 'new@acme.example', contactId });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('PORTAL_INVITE_LOGIN_EMAIL_DIFFERS');
    expect(await loginsIn(orgId)).toEqual([expect.objectContaining({ id: loginId, email: 'old@acme.example', contactId })]);
  });

  it('invite-contacts returns all five outcomes against real rows', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const orgId = env.organization.id;
    const fresh = await seedContact(orgId, 'fresh@acme.example');
    const active = await seedContact(orgId, 'active@acme.example');
    await seedLogin({ orgId, email: 'active@acme.example', contactId: active, status: 'active', passwordHash: 'hash' });
    const noEmail = await seedContact(orgId, null, 'No Email');
    const taken = await seedContact(orgId, 'taken@acme.example');
    const holder = await seedContact(orgId, 'taken@acme.example', 'Holder');
    const takenLogin = await seedLogin({ orgId, email: 'taken@acme.example', contactId: holder });
    const dupA = await seedContact(orgId, 'dup@acme.example', 'Dup A');
    const dupB = await seedContact(orgId, 'DUP@acme.example', 'Dup B');

    const res = await post(env, orgId, 'invite-contacts', { contactIds: [fresh, active, noEmail, taken, dupA, dupB] });

    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.results.map((r: { contactId: string; outcome: string }) => [r.contactId, r.outcome])).toEqual([
      [fresh, 'invited'],
      [active, 'already_has_access'],
      [noEmail, 'no_email'],
      [taken, 'email_bound_to_other_contact'],
      [dupA, 'duplicate_email_in_batch'],
      [dupB, 'duplicate_email_in_batch'],
    ]);
    expect(data.results[1].reason).toBe('active');
    expect(data.counts).toEqual({ invited: 1, already_has_access: 1, no_email: 1, email_bound_to_other_contact: 1, duplicate_email_in_batch: 2 });

    const rows = await loginsIn(orgId);
    // Exactly one new login (for `fresh`), bound to it; nothing else changed.
    expect(rows.filter((r) => r.contactId === fresh)).toEqual([expect.objectContaining({ email: 'fresh@acme.example', status: 'invited' })]);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.id === takenLogin)).toMatchObject({ contactId: holder });
    expect(rows.some((r) => r.contactId === dupA || r.contactId === dupB || r.contactId === noEmail)).toBe(false);
  });

  it('invite-contacts with an Entra-only login on the address reports already_has_access/external_identity and creates no password row', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const orgId = env.organization.id;
    const contactId = await seedContact(orgId, 'addin@acme.example');
    await seedLogin({
      orgId,
      email: 'addin@acme.example',
      authMethod: 'entra',
      status: 'active',
      entraOid: crypto.randomUUID(),
      entraTenantId: crypto.randomUUID(),
    });

    const res = await post(env, orgId, 'invite-contacts', { contactIds: [contactId] });

    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.results).toEqual([expect.objectContaining({ contactId, outcome: 'already_has_access', reason: 'external_identity' })]);
    const rows = await loginsIn(orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.authMethod).toBe('entra');
  });

  it('invite-contacts 404s the whole batch when one contact is in a sibling org, and writes nothing', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const orgA2 = await createOrganization({ partnerId: env.partner.id });
    const mine = await seedContact(env.organization.id, 'mine@acme.example');
    const sibling = await seedContact(orgA2.id, 'sibling@acme.example');

    const res = await post(env, env.organization.id, 'invite-contacts', { contactIds: [mine, sibling] });

    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('PORTAL_INVITE_CONTACT_NOT_FOUND');
    expect(await loginsIn(env.organization.id)).toEqual([]);
    expect(await loginsIn(orgA2.id)).toEqual([]);
  });

  it('an organization-scope caller is refused (403) on both routes, even with MFA, and nothing is written', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const orgId = env.organization.id;
    const contactId = await seedContact(orgId, 'ada@acme.example');
    const orgToken = await createAccessToken({
      sub: env.user.id,
      email: env.user.email,
      roleId: env.role.id,
      orgId,
      partnerId: env.partner.id,
      scope: 'organization',
      mfa: true,
      aep: 1,
      mep: 1,
      sid: 'it-session-org',
    });
    const send = (path: string, body: unknown) => buildMspApp().request(`/organizations/${orgId}/portal-users/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${orgToken}`, ...JSON_HEADERS },
      body: JSON.stringify(body),
    });

    expect((await send('invite', { email: 'ada@acme.example', contactId })).status).toBe(403);
    expect((await send('invite-contacts', { contactIds: [contactId] })).status).toBe(403);
    expect(await loginsIn(orgId)).toEqual([]);
    expect(await contactRoles(contactId)).toEqual([]);
  });

  it('binds an existing unbound pending login to the contact (reuse/direct) and bumps auth_epoch', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const orgId = env.organization.id;
    const contactId = await seedContact(orgId, 'ada@acme.example');
    const loginId = await seedLogin({ orgId, email: 'ada@acme.example', status: 'invited' });

    const res = await post(env, orgId, 'invite', { email: 'ada@acme.example', contactId });

    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ id: loginId, contactLink: 'direct' });
    const [row] = await withSystemDbAccessContext(() =>
      db.select({ contactId: portalUsers.contactId, authEpoch: portalUsers.authEpoch }).from(portalUsers).where(eq(portalUsers.id, loginId)),
    );
    expect(row).toEqual({ contactId, authEpoch: 2 });
    expect(await loginsIn(orgId)).toHaveLength(1);
  });

  it('an unbound ACTIVE login on the address is refused (409) and is not bound', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const orgId = env.organization.id;
    const contactId = await seedContact(orgId, 'ada@acme.example');
    const loginId = await seedLogin({ orgId, email: 'ada@acme.example', status: 'active', passwordHash: 'hash' });

    const res = await post(env, orgId, 'invite', { email: 'ada@acme.example', contactId });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('PORTAL_INVITE_ALREADY_ACTIVE');
    expect(await loginsIn(orgId)).toEqual([expect.objectContaining({ id: loginId, contactId: null, status: 'active' })]);
    expect(await contactRoles(contactId)).toEqual([]);
  });

  it('a ContactGoneError mid-batch rolls back the earlier bind in the same savepoint (real Postgres)', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const orgId = env.organization.id;
    const contactA = await seedContact(orgId, 'a@acme.example', 'A');
    const now = new Date();
    const actor = { userId: env.user.id };

    let caught: unknown;
    await withSystemDbAccessContext(async () => {
      try {
        await withDbTransaction(async () => {
          const first = await bindContactLoginForInvite(db, {
            orgId, contact: { id: contactA, orgId, siteId: null, name: 'A', email: 'a@acme.example' },
            normalizedEmail: 'a@acme.example', name: null, actor, now,
          });
          expect(first).toMatchObject({ kind: 'invite', created: true });
          // A contact that no longer exists: the locked re-read finds nothing.
          await bindContactLoginForInvite(db, {
            orgId, contact: { id: crypto.randomUUID(), orgId, siteId: null, name: 'B', email: 'b@acme.example' },
            normalizedEmail: 'b@acme.example', name: null, actor, now,
          });
        });
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBeInstanceOf(ContactGoneError);
    expect(await loginsIn(orgId)).toEqual([]);
    expect(await contactRoles(contactA)).toEqual([]);
  });

  it('the composite FK still rejects a cross-org contact_id written directly', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const orgA2 = await createOrganization({ partnerId: env.partner.id });
    const siblingContact = await seedContact(orgA2.id, 'x@acme.example');
    const loginId = await seedLogin({ orgId: env.organization.id, email: 'x@acme.example' });

    let caught: unknown;
    try {
      await withSystemDbAccessContext(() =>
        db.update(portalUsers).set({ contactId: siblingContact })
          .where(and(eq(portalUsers.id, loginId), eq(portalUsers.orgId, env.organization.id))),
      );
    } catch (err) {
      caught = err;
    }
    const e = caught as { code?: string; cause?: { code?: string } } | undefined;
    expect(e?.code ?? e?.cause?.code).toBe('23503');
  });
});

// ── W2 (#11379): the contact invite goes through the account state machine ──

describe('invite from contacts × account state machine (W2) — real Postgres', () => {
  const NEW_PORTAL_PASSWORD = 'NewPortalPass456!';
  beforeEach(() => { sentInvites.length = 0; });

  const tokenFromLastInvite = (to: string): string => {
    const sent = [...sentInvites].reverse().find((m) => m.to === to);
    expect(sent, `no invite emailed to ${to}`).toBeDefined();
    return new URL(sent!.inviteUrl).searchParams.get('token')!;
  };
  const accept = (token: string) => {
    const app = new Hono();
    app.route('/portal', portalRoutes);
    return app.request('/portal/auth/accept-invite', {
      method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ token, password: NEW_PORTAL_PASSWORD }),
    });
  };
  const stateOf = async (id: string) => {
    const [row] = await withSystemDbAccessContext(() =>
      db.select({ status: portalUsers.status, browserAccess: portalUsers.browserAccess, authEpoch: portalUsers.authEpoch })
        .from(portalUsers).where(eq(portalUsers.id, id)),
    );
    return row ?? null;
  };

  it('a new contact login is written with browser_access granted, and the emailed token redeems', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const contactId = await seedContact(env.organization.id, 'redeem@acme.example', 'Redeem');

    const res = await post(env, env.organization.id, 'invite', { email: 'redeem@acme.example', contactId });

    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(await stateOf(data.id)).toMatchObject({ status: 'invited', browserAccess: 'granted' });
    expect((await accept(tokenFromLastInvite('redeem@acme.example'))).status).toBe(200);
    expect(await stateOf(data.id)).toMatchObject({ status: 'active', browserAccess: 'granted' });
  });

  it('re-inviting a bound contact kills the earlier link; the new one (bound to the post-write epoch) redeems', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const contactId = await seedContact(env.organization.id, 'again@acme.example', 'Again');

    expect((await post(env, env.organization.id, 'invite', { email: 'again@acme.example', contactId })).status).toBe(200);
    const first = tokenFromLastInvite('again@acme.example');
    const second = await post(env, env.organization.id, 'invite', { email: 'again@acme.example', contactId });
    expect(second.status).toBe(200);
    expect((await second.json()).data.contactLink).toBe('kept');
    const fresh = tokenFromLastInvite('again@acme.example');

    expect((await accept(first)).status).toBe(400);
    expect((await accept(fresh)).status).toBe(200);
  });

  it('invite-contacts: a created and a reused login each get a token that redeems for that login', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const orgId = env.organization.id;
    const newContact = await seedContact(orgId, 'fresh@acme.example', 'Fresh');
    const reusedContact = await seedContact(orgId, 'pending@acme.example', 'Pending');
    const pendingLogin = await seedLogin({ orgId, email: 'pending@acme.example', status: 'invited' });

    const res = await post(env, orgId, 'invite-contacts', { contactIds: [newContact, reusedContact] });

    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.counts.invited).toBe(2);
    expect(data.results[1]).toMatchObject({ outcome: 'invited', portalUserId: pendingLogin, emailSent: true });
    expect(await stateOf(pendingLogin)).toEqual({ status: 'invited', browserAccess: 'granted', authEpoch: 2 });
    expect((await accept(tokenFromLastInvite('fresh@acme.example'))).status).toBe(200);
    expect((await accept(tokenFromLastInvite('pending@acme.example'))).status).toBe(200);
  });

  it('a password login on the address that carries an Entra identity is refused (external_identity) and left untouched', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const orgId = env.organization.id;
    const contactId = await seedContact(orgId, 'twin@acme.example');
    const suffix = crypto.randomUUID();
    const loginId = await seedLogin({ orgId, email: 'twin@acme.example', status: 'invited', entraOid: `oid-${suffix}`, entraTenantId: `tid-${suffix}` });
    // The identity row is what makes it identity-managed since W3 (identities
    // release B); the legacy columns above are the D4 dual-write, no longer read.
    await getTestDb().insert(portalUserIdentities).values({
      orgId, portalUserId: loginId, provider: 'entra', issuer: `https://login.microsoftonline.com/tid-${suffix}/v2.0`,
      subject: `oid-${suffix}`, entraTenantId: `tid-${suffix}`, linkedVia: 'migrated',
    });
    const before = await stateOf(loginId);

    const res = await post(env, orgId, 'invite', { email: 'twin@acme.example', contactId });

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('PORTAL_INVITE_EXTERNAL_IDENTITY');
    expect(await stateOf(loginId)).toEqual(before);
    expect(await loginsIn(orgId)).toEqual([expect.objectContaining({ id: loginId, contactId: null })]);
    expect(await contactRoles(contactId)).toEqual([]);
    expect(sentInvites).toEqual([]);
  });
});
