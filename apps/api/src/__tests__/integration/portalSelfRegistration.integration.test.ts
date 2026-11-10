/**
 * Customer-portal self-registration by verified email domain on real Postgres
 * (portal registration W6 #11383, plan Task 7; Review Focus 2 and 3, D8, D10,
 * D11; spec §5.9, inv. 1, 3, 5, 9).
 *
 * The public routes run through the real portal router as breeze_app under
 * forced RLS with no DB context held, exactly as production serves them. The
 * queue is replaced by a capture (the submit's job data), and the job is run by
 * calling `processPortalSelfRegistration` directly (no BullMQ). The email
 * service is replaced at `getEmailService()` by a recorder that also renders
 * each message with the real template builders, so a test can read the link
 * and check what a message says. Verified domains are seeded over the
 * superuser connection the way W5 records them (dns_txt evidence, a pass
 * within the stale window), so W5's own read API is what decides "verified".
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/portalSelfRegistration.integration.test.ts
 */
import './setup';

type CapturedJob = { email: string; name: string; host: string | null };
type SentMail = { kind: string; to: string; params: Record<string, unknown>; rendered: string };

const jobs = vi.hoisted(() => [] as CapturedJob[]);
const mail = vi.hoisted(() => ({ sent: [] as SentMail[] }));

vi.mock('../../services/portalSelfRegistration/queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/portalSelfRegistration/queue')>()),
  enqueuePortalSelfRegistration: async (data: CapturedJob) => {
    jobs.push({ ...data });
    return true;
  },
}));

vi.mock('../../services/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/email')>();
  type Template = { subject: string; html: string; text: string };
  const record = (kind: string, params: { to: string } & Record<string, unknown>, template: Template | null) => {
    mail.sent.push({
      kind,
      to: params.to,
      params,
      rendered: template ? `${template.subject}\n${template.html}\n${template.text}` : '',
    });
  };
  return {
    ...actual,
    getEmailService: () => ({
      sendPortalSelfRegistrationLink: async (p: { to: string } & Record<string, unknown>) =>
        record('verify_link', p, actual.buildPortalSelfRegistrationLinkTemplate(p as never)),
      sendPortalSelfRegistrationExistingAccount: async (p: { to: string } & Record<string, unknown>) =>
        record('existing_account', p, actual.buildPortalSelfRegistrationExistingAccountTemplate(p as never)),
      sendPortalInvite: async (p: { to: string } & Record<string, unknown>) =>
        record('invite', p, actual.buildPortalInviteTemplate(p as never)),
      sendPortalAccessApproved: async (p: { to: string } & Record<string, unknown>) => record('approved', p, null),
      sendPortalAccessDeclined: async (p: { to: string } & Record<string, unknown>) => record('declined', p, null),
      sendPortalEntraTenantDisplaced: async () => undefined,
    }),
  };
});

import { randomUUID } from 'node:crypto';
import { and, eq, like, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestDb } from './setup';
import { createOrganization, createPartner, setupTestEnvironment } from './db-utils';
import {
  auditLogs,
  clientAiTenantMappings,
  contacts,
  customerEmailDomains,
  portalAccessPolicies,
  portalAccessRequests,
  portalBranding,
  portalUserIdentities,
  portalUsers,
} from '../../db/schema';
import { authMiddleware } from '../../middleware/auth';
import { registerOrgPortalAccessRequestRoutes } from '../../routes/orgPortalAccessRequests';
import { registerOrgPortalUsersRoutes } from '../../routes/orgPortalUsers';
import { portalRoutes } from '../../routes/portal';
import {
  issuePortalCapabilityToken,
  peekPortalCapabilityToken,
  validatePortalCapability,
} from '../../routes/portal/capabilityTokens';
import { portalOidcStates, portalRateLimitBuckets, portalSessions } from '../../routes/portal/helpers';
import { __testOnly as oidcTestOnly } from '../../routes/portal/oidc';
import { createAccessToken } from '../../services/jwt';
import { PORTAL_ACCESS_REQUEST_PENDING_CAP } from '../../services/portalAccessRequests';
import { __testOnly as policyTestOnly } from '../../services/portalAccessPolicy';
import { processPortalSelfRegistration } from '../../services/portalSelfRegistration/worker';
import { entraIssuer } from '../../services/portalUserIdentities';
import { awaitAuditRows } from './auditWait';

const admin = () => getTestDb();
const PORTAL = 'https://portal.example.test/portal';
const ACCEPTED = { success: true, message: "If this address can request access, we've emailed you." };
const INVALID_LINK = { error: 'This link is invalid or has expired. Request access again.' };
const STRONG_PASSWORD = 'Selfreg-Passw0rd';

type SelfMode = 'off' | 'approval' | 'instant';

const SAVED_PORTAL_URL = process.env.PUBLIC_PORTAL_URL;
beforeAll(() => {
  process.env.PUBLIC_PORTAL_URL = PORTAL;
});
afterAll(() => {
  if (SAVED_PORTAL_URL === undefined) delete process.env.PUBLIC_PORTAL_URL;
  else process.env.PUBLIC_PORTAL_URL = SAVED_PORTAL_URL;
});

beforeEach(() => {
  // W06a ships the capability off; these proofs run with it on.
  policyTestOnly.setCapabilities({ entra: true, google: false, selfRegistration: true });
  jobs.length = 0;
  mail.sent.length = 0;
  portalRateLimitBuckets.clear();
  portalSessions.clear();
  portalOidcStates.clear();
});

afterEach(() => {
  policyTestOnly.setCapabilities(null);
});

const portalApp = new Hono().route('/portal', portalRoutes);

// ---------------------------------------------------------------------------
// Fixtures (superuser connection)
// ---------------------------------------------------------------------------

const newDomain = () => `selfreg-${randomUUID().slice(0, 8)}.example.com`;

/** An org with an org-level access policy. `ssoOnly` also gives it a PROVEN Entra tenant (the W3/W4 requirement). */
async function seedOrg(opts: { mode: SelfMode; ssoOnly?: boolean; partnerId?: string; name?: string }) {
  const partnerId = opts.partnerId ?? (await createPartner()).id;
  const org = await createOrganization({ partnerId, ...(opts.name ? { name: opts.name } : {}) });
  let tid: string | null = null;
  if (opts.ssoOnly) {
    tid = randomUUID();
    await admin().insert(clientAiTenantMappings).values({
      orgId: org.id,
      entraTenantId: tid,
      provenAt: new Date(),
      provenVia: 'proof_run' as const,
      provenEvidence: { via: 'proof_run' as const, adminOid: randomUUID(), runId: randomUUID() },
      provenByUserId: null,
    });
  }
  await admin().insert(portalAccessPolicies).values({
    orgId: org.id,
    selfRegistrationMode: opts.mode,
    ...(opts.ssoOnly ? { entraEnabled: true, passwordMode: 'sso_only' as const } : {}),
  });
  return { org: org!, partnerId, tid };
}

/** A domain verified for `org` exactly as W5 records one: dns_txt evidence and a recent pass. */
async function verifyDomain(org: { id: string; partnerId: string }, domain: string = newDomain()) {
  const at = new Date(Date.now() - 60_000);
  const [row] = await admin().insert(customerEmailDomains).values({
    partnerId: org.partnerId,
    orgId: org.id,
    domain,
    isActive: true,
    verificationToken: `tok-${randomUUID()}`,
    verifiedAt: at,
    verifiedMethod: 'dns_txt',
    verifiedEvidence: { via: 'dns_txt', recordName: `_breeze-verify.${domain}` },
    lastCheckedAt: at,
    lastPassedAt: at,
    lastCheckStatus: 'pass',
  }).returning({ id: customerEmailDomains.id });
  return { id: row!.id, domain };
}

/** What W5's re-check worker writes when it clears a verification (service.ts `clearedColumns`). */
async function clearDomain(rowId: string, reason: 'record_missing' | 'displaced' = 'record_missing') {
  const now = new Date();
  await admin().update(customerEmailDomains).set({
    verifiedAt: null,
    verifiedMethod: null,
    verifiedEvidence: null,
    verifiedByUserId: null,
    lastPassedAt: null,
    checkFailures: 0,
    clearedAt: now,
    clearedReason: reason,
    updatedAt: now,
  }).where(eq(customerEmailDomains.id, rowId));
}

async function requestsFor(email: string) {
  return admin().select().from(portalAccessRequests).where(eq(portalAccessRequests.email, email));
}

async function loginsFor(email: string) {
  return admin().select().from(portalUsers).where(sql`lower(${portalUsers.email}) = ${email.toLowerCase()}`);
}

async function selfRegisterAudits(orgId: string) {
  return admin().select().from(auditLogs)
    .where(and(eq(auditLogs.orgId, orgId), like(auditLogs.action, 'portal.auth.self_register.%')));
}

// ---------------------------------------------------------------------------
// The public flow: submit → job → email → verify
// ---------------------------------------------------------------------------

async function submit(email: string, headers: Record<string, string> = {}, name = 'Pat Person') {
  const res = await portalApp.request('/portal/auth/self-register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ email, name }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  expect(await res.json()).toEqual(ACCEPTED);
}

/** Runs every captured job through the real worker, in order. */
async function runJobs() {
  const pending = jobs.splice(0);
  const results: string[] = [];
  for (const job of pending) results.push(await processPortalSelfRegistration(job));
  return results;
}

/** The raw token from the one verify link mailed to `email` (it rides in the URL fragment, D9). */
function linkTokenFor(email: string): string {
  const links = mail.sent.filter((m) => m.kind === 'verify_link' && m.to === email);
  expect(links).toHaveLength(1);
  const url = String(links[0]!.params.verifyUrl);
  expect(url.startsWith(`${PORTAL}/request-access/verify#token=`), url).toBe(true);
  return decodeURIComponent(url.slice(url.indexOf('#token=') + '#token='.length));
}

/** Submit on the shared host, run the job, and return the link token. */
async function requestLink(email: string): Promise<string> {
  await submit(email);
  expect(await runJobs()).toEqual(['link_sent']);
  return linkTokenFor(email);
}

async function verify(token: string) {
  return portalApp.request('/portal/auth/self-register/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
}

async function expectInvalidLink(res: Response) {
  expect(res.status, await res.clone().text()).toBe(400);
  expect(await res.json()).toEqual(INVALID_LINK);
}

/** The invite token from an `account_created` answer's `next`. */
async function inviteTokenFrom(res: Response): Promise<string> {
  expect(res.status, await res.clone().text()).toBe(200);
  const body = await res.json() as { outcome: string; next: string };
  expect(body.outcome).toBe('account_created');
  expect(body.next.startsWith('/accept-invite?token=')).toBe(true);
  return decodeURIComponent(body.next.slice('/accept-invite?token='.length));
}

// ---------------------------------------------------------------------------
// The MSP's approval routes (real router, partner tech with MFA)
// ---------------------------------------------------------------------------

async function mspFixture() {
  const env = await setupTestEnvironment({ scope: 'partner' });
  const token = await createAccessToken({
    sub: env.user.id, email: env.user.email, roleId: env.role.id, orgId: null, partnerId: env.partner.id,
    scope: 'partner', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
  const app = new Hono();
  app.use('*', authMiddleware);
  registerOrgPortalAccessRequestRoutes(app);
  registerOrgPortalUsersRoutes(app);
  const request = (method: 'GET' | 'POST', path: string) => app.request(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const org = env.organization;
  await admin().insert(portalAccessPolicies).values({ orgId: org.id, selfRegistrationMode: 'approval' });
  return {
    org,
    deciderId: env.user.id,
    get: (path: string) => request('GET', path),
    post: (path: string) => request('POST', path),
    base: `/organizations/${org.id}/portal-access-requests`,
  };
}

// ---------------------------------------------------------------------------

describe('portal self-registration (real DB, real routes, worker run directly)', () => {
  it('approval: submit → job → link → verify creates one pending self request in the verified org', async () => {
    const { org } = await seedOrg({ mode: 'approval' });
    const { domain } = await verifyDomain(org);
    const email = `pat-${randomUUID().slice(0, 8)}@${domain}`;

    await submit(email.toUpperCase());
    expect(jobs).toEqual([{ email, name: 'Pat Person', host: null }]);
    // Nothing is decided at submit: no row, no mail until the worker runs.
    expect(await requestsFor(email)).toEqual([]);
    expect(mail.sent).toEqual([]);

    expect(await runJobs()).toEqual(['link_sent']);
    expect(mail.sent.map((m) => ({ kind: m.kind, to: m.to }))).toEqual([{ kind: 'verify_link', to: email }]);
    expect(mail.sent[0]!.params.orgName).toBe(org.name);
    expect(mail.sent[0]!.rendered).not.toContain('Pat Person'); // the submitted name is never mailed
    const token = linkTokenFor(email);

    const res = await verify(token);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ outcome: 'request_sent' });

    const rows = await requestsFor(email);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orgId: org.id, email, name: 'Pat Person', source: 'self', status: 'pending', portalUserId: null });
    expect(await loginsFor(email)).toEqual([]);

    const audits = await awaitAuditRows(() => selfRegisterAudits(org.id), 2);
    expect(audits.map((a) => ({ action: a.action, result: a.result, resourceType: a.resourceType, resourceId: a.resourceId, details: a.details }))
      .sort((x, y) => x.action.localeCompare(y.action))).toEqual([
      {
        action: 'portal.auth.self_register.email_sent', result: 'success', resourceType: 'portal_auth', resourceId: null,
        details: expect.objectContaining({ kind: 'verify_link', domain, mode: 'approval' }),
      },
      {
        action: 'portal.auth.self_register.verify', result: 'success', resourceType: 'portal_access_request', resourceId: rows[0]!.id,
        details: expect.objectContaining({ outcome: 'request_sent', mode: 'approval', created: true }),
      },
    ]);

    // Single use: the same link again is the generic 400 and writes nothing.
    await expectInvalidLink(await verify(token));
    expect(await requestsFor(email)).toHaveLength(1);
  });

  it('instant: verify creates an invited, granted password account with a portal contact; accept-invite activates it', async () => {
    const { org } = await seedOrg({ mode: 'instant' });
    const { domain } = await verifyDomain(org);
    const email = `ina-${randomUUID().slice(0, 8)}@${domain}`;

    const inviteToken = await inviteTokenFrom(await verify(await requestLink(email)));

    const [account] = await loginsFor(email);
    expect(account).toMatchObject({
      orgId: org.id, email, name: 'Pat Person', status: 'invited', browserAccess: 'granted', authMethod: 'password',
      passwordHash: null, invitedBy: null,
    });
    expect(account!.invitedAt).not.toBeNull();
    expect(account!.contactId).not.toBeNull();
    const [contact] = await admin().select().from(contacts).where(eq(contacts.id, account!.contactId!));
    expect(contact).toMatchObject({ orgId: org.id, email });
    expect(contact!.roles).toContain('portal');
    expect(await requestsFor(email)).toEqual([]); // instant writes no queue row

    const accept = await portalApp.request('/portal/auth/accept-invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: inviteToken, password: STRONG_PASSWORD }),
    });
    expect(accept.status, await accept.clone().text()).toBe(200);
    expect(((await accept.json()) as { user: { id: string } }).user.id).toBe(account!.id);

    const [activated] = await loginsFor(email);
    expect(activated).toMatchObject({ id: account!.id, status: 'active', browserAccess: 'granted', authEpoch: account!.authEpoch + 1 });
    expect(activated!.passwordHash).not.toBeNull();
  });

  describe('instant under sso_only (Microsoft invite accept, real OIDC routes)', () => {
    const CLIENT_ID = '99999999-8888-4777-8666-555555555555';
    const SAVED = { id: process.env.PORTAL_ENTRA_CLIENT_ID, secret: process.env.PORTAL_ENTRA_CLIENT_SECRET };
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    let keys: Awaited<ReturnType<typeof generateKeyPair>>;
    const tokenFetch = vi.fn();

    beforeAll(async () => {
      keys = await generateKeyPair('RS256', { modulusLength: 2048 });
      process.env.PORTAL_ENTRA_CLIENT_ID = CLIENT_ID;
      process.env.PORTAL_ENTRA_CLIENT_SECRET = 'portal-entra-test-secret';
    });
    afterAll(() => {
      restore('PORTAL_ENTRA_CLIENT_ID', SAVED.id);
      restore('PORTAL_ENTRA_CLIENT_SECRET', SAVED.secret);
    });
    beforeEach(() => {
      tokenFetch.mockReset();
      oidcTestOnly.setEntraDeps({ fetch: tokenFetch as unknown as typeof fetch, verificationKey: keys.publicKey });
    });
    afterEach(() => oidcTestOnly.setEntraDeps(null));

    const cookiePair = (res: Response, name: string) => {
      const header = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
      if (!header) throw new Error(`no ${name} cookie`);
      return header.split(';')[0]!;
    };

    it('instant under sso_only: the invite token is accepted by the Microsoft invite start (requirePasswordMethod false) and refused by the password accept', async () => {
      const { org, tid } = await seedOrg({ mode: 'instant', ssoOnly: true });
      const { domain } = await verifyDomain(org);
      const email = `sso-${randomUUID().slice(0, 8)}@${domain}`;

      const inviteToken = await inviteTokenFrom(await verify(await requestLink(email)));
      const [account] = await loginsFor(email);
      expect(account).toMatchObject({ status: 'invited', browserAccess: 'granted', authMethod: 'password', passwordHash: null });

      // The accept-invite page's method probe: Microsoft only.
      const methods = await portalApp.request('/portal/auth/invite/methods', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: inviteToken }),
      });
      expect(await methods.json()).toEqual({ password: false, microsoft: true });

      // The capability itself: refused as a password acceptance, valid for the SSO one.
      const peeked = await peekPortalCapabilityToken('invite', inviteToken);
      expect(peeked).not.toBeNull();
      expect(await validatePortalCapability('invite', peeked!)).toEqual({ ok: false, reason: 'invalid' });
      expect(await validatePortalCapability('invite', peeked!, { requirePasswordMethod: false })).toMatchObject({ ok: true });

      // The real password accept refuses. It consumes what it is given, so it is
      // fed a second invite token for the same account and generation, keeping
      // the flow's own token for the Microsoft leg.
      const passwordToken = await issuePortalCapabilityToken({
        purpose: 'invite', portalUserId: account!.id, orgId: org.id, email, authEpoch: account!.authEpoch,
      });
      const refused = await portalApp.request('/portal/auth/accept-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: passwordToken, password: STRONG_PASSWORD }),
      });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({ error: 'Invalid or expired invite' });
      expect((await loginsFor(email))[0]).toMatchObject({ status: 'invited', passwordHash: null, authEpoch: account!.authEpoch });

      // The Microsoft invite start accepts the flow's token (peek, not consume) …
      const start = await portalApp.request('/portal/auth/oidc/entra/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: 'invite', inviteToken }),
      });
      expect(start.status, await start.clone().text()).toBe(200);
      const redirect = new URL(((await start.json()) as { redirectUrl: string }).redirectUrl);
      const flow = { state: redirect.searchParams.get('state')!, nonce: redirect.searchParams.get('nonce')!, binding: cookiePair(start, 'breeze_portal_oidc') };
      expect(await peekPortalCapabilityToken('invite', inviteToken)).not.toBeNull();

      // … and the callback activates the account through Microsoft.
      const oid = randomUUID();
      const idToken = await new SignJWT({
        tid, oid, nonce: flow.nonce, ver: '2.0', iss: entraIssuer(tid!), aud: CLIENT_ID, preferred_username: email, name: 'Pat Person',
      }).setProtectedHeader({ alg: 'RS256' }).setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
      tokenFetch.mockImplementation(async () => new Response(JSON.stringify({ id_token: idToken }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
      const callback = await portalApp.request(
        `/portal/auth/oidc/entra/callback?code=code-${randomUUID()}&state=${encodeURIComponent(flow.state)}`,
        { headers: { Cookie: flow.binding } },
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get('location')).toBe(`${PORTAL}/login?sso=signed_in`);

      const [activated] = await loginsFor(email);
      expect(activated).toMatchObject({
        id: account!.id, status: 'active', browserAccess: 'granted', authMethod: 'password', passwordHash: null,
        authEpoch: account!.authEpoch + 1, entraTenantId: tid, entraOid: oid,
      });
      const identities = await admin().select().from(portalUserIdentities).where(eq(portalUserIdentities.portalUserId, account!.id));
      expect(identities).toEqual([expect.objectContaining({ subject: oid, linkedVia: 'invite' })]);
      expect(await peekPortalCapabilityToken('invite', inviteToken)).toBeNull();
    });
  });

  it('two orgs, one address: only the verified org gets a request', async () => {
    // RF2: pat@<domain> has a login in org B (another partner's customer); the
    // domain is verified for org A only.
    const { org: orgA } = await seedOrg({ mode: 'approval', name: 'Alpha Self-Reg Org' });
    const partnerB = await createPartner({ name: 'Bravo Partner MSP' });
    const { org: orgB } = await seedOrg({ mode: 'approval', partnerId: partnerB.id, name: 'Bravo Self-Reg Org' });
    const { domain } = await verifyDomain(orgA);
    const email = `pat-${randomUUID().slice(0, 8)}@${domain}`;
    const [loginB] = await admin().insert(portalUsers).values({
      orgId: orgB.id, email, authMethod: 'password', status: 'active', browserAccess: 'granted', passwordHash: 'argon2-hash',
    }).returning();

    // Org A's verify link, not the existing-account mail.
    await submit(email);
    expect(await runJobs()).toEqual(['link_sent']);
    expect(mail.sent.map((m) => m.kind)).toEqual(['verify_link']);
    expect(mail.sent[0]!.params).toMatchObject({ to: email, orgName: orgA.name, partnerId: orgA.partnerId });
    for (const m of mail.sent) {
      expect(m.rendered).not.toContain(orgB.name);
      expect(m.rendered).not.toContain(partnerB.name);
      expect(JSON.stringify(m.params)).not.toContain(orgB.id);
    }

    const res = await verify(linkTokenFor(email));
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ outcome: 'request_sent' });
    expect(body).not.toContain(orgB.id);

    const rows = await requestsFor(email);
    expect(rows.map((r) => ({ orgId: r.orgId, source: r.source, status: r.status }))).toEqual([{ orgId: orgA.id, source: 'self', status: 'pending' }]);
    // Org B's account is untouched and org B has no trace of the attempt.
    const [afterB] = await admin().select().from(portalUsers).where(eq(portalUsers.id, loginB!.id));
    expect(afterB).toEqual(loginB);
    expect((await loginsFor(email)).map((l) => l.orgId)).toEqual([orgB.id]);
    await awaitAuditRows(() => selfRegisterAudits(orgA.id), 2);
    expect(await selfRegisterAudits(orgB.id)).toEqual([]);
  });

  it('displacement between email and click lands nobody in the old org', async () => {
    // RF3 / D11: the W5 transfer — A's verification cleared, the domain then
    // verified for org B (another partner) — happens while A's link is unread.
    const { org: orgA } = await seedOrg({ mode: 'instant' });
    const { org: orgB } = await seedOrg({ mode: 'instant' });
    const verified = await verifyDomain(orgA);
    const email = `moved-${randomUUID().slice(0, 8)}@${verified.domain}`;
    const token = await requestLink(email);

    await clearDomain(verified.id, 'displaced');
    await verifyDomain(orgB, verified.domain);

    await expectInvalidLink(await verify(token));
    expect(await loginsFor(email)).toEqual([]);
    expect(await requestsFor(email)).toEqual([]);
    const denied = await awaitAuditRows(async () => (await selfRegisterAudits(orgA.id))
      .filter((a) => a.action === 'portal.auth.self_register.verify'), 1);
    expect(denied).toEqual([expect.objectContaining({ result: 'denied', details: expect.objectContaining({ outcome: 'refused', reason: 'domain_not_verified' }) })]);
    expect(await selfRegisterAudits(orgB.id)).toEqual([]);
  });

  it('a domain set is_active=false between email and click refuses the link', async () => {
    const { org } = await seedOrg({ mode: 'approval' });
    const verified = await verifyDomain(org);
    const email = `inactive-${randomUUID().slice(0, 8)}@${verified.domain}`;
    const token = await requestLink(email);

    await admin().update(customerEmailDomains).set({ isActive: false }).where(eq(customerEmailDomains.id, verified.id));

    await expectInvalidLink(await verify(token));
    expect(await requestsFor(email)).toEqual([]);
    expect(await loginsFor(email)).toEqual([]);
    const denied = await awaitAuditRows(async () => (await selfRegisterAudits(org.id))
      .filter((a) => a.action === 'portal.auth.self_register.verify'), 1);
    expect(denied).toEqual([expect.objectContaining({ result: 'denied', details: expect.objectContaining({ outcome: 'refused', reason: 'domain_not_verified' }) })]);
  });

  it('MSP approval of a self request after the domain is cleared: 409, request still pending', async () => {
    const msp = await mspFixture();
    const verified = await verifyDomain(msp.org);
    const email = `lapsed-${randomUUID().slice(0, 8)}@${verified.domain}`;
    expect(await (await verify(await requestLink(email))).json()).toEqual({ outcome: 'request_sent' });
    const [request] = await requestsFor(email);
    mail.sent.length = 0;

    await clearDomain(verified.id);

    // The queue shows why Approve is unavailable.
    const list = await msp.get(msp.base);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { data: Array<{ id: string; domainVerified: boolean | null }> }).data)
      .toEqual([expect.objectContaining({ id: request!.id, domainVerified: false })]);

    const res = await msp.post(`${msp.base}/${request!.id}/approve`);
    expect(res.status, await res.clone().text()).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'PORTAL_ACCESS_REQUEST_DOMAIN_NOT_VERIFIED' });

    expect((await requestsFor(email)).map((r) => ({ id: r.id, status: r.status, portalUserId: r.portalUserId })))
      .toEqual([{ id: request!.id, status: 'pending', portalUserId: null }]);
    expect(await loginsFor(email)).toEqual([]);
    expect(mail.sent).toEqual([]);
  });

  it('MSP approval of a self request while verified sends the normal invite (W3 path unchanged)', async () => {
    const msp = await mspFixture();
    const { domain } = await verifyDomain(msp.org);
    const email = `approved-${randomUUID().slice(0, 8)}@${domain}`;
    expect(await (await verify(await requestLink(email))).json()).toEqual({ outcome: 'request_sent' });
    const [request] = await requestsFor(email);
    mail.sent.length = 0;

    const res = await msp.post(`${msp.base}/${request!.id}/approve`);
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json() as { data: { outcome: string; portalUserId: string }; emailSent: boolean };
    expect(body).toMatchObject({ data: { outcome: 'invite_pending' }, emailSent: true });

    const [login] = await loginsFor(email);
    expect(login).toMatchObject({
      id: body.data.portalUserId, orgId: msp.org.id, status: 'invited', browserAccess: 'granted', authMethod: 'password',
      passwordHash: null, invitedBy: msp.deciderId,
    });
    expect(login!.contactId).not.toBeNull();
    expect((await requestsFor(email))[0]).toMatchObject({ status: 'approved', portalUserId: login!.id, decidedByUserId: msp.deciderId });
    expect(mail.sent.map((m) => ({ kind: m.kind, to: m.to }))).toEqual([{ kind: 'invite', to: email }]);
  });

  it('the pending cap returns request_unavailable at 200 live requests', async () => {
    const { org } = await seedOrg({ mode: 'approval' });
    const { domain } = await verifyDomain(org);
    const future = new Date(Date.now() + 7 * 86_400_000);
    await admin().insert(portalAccessRequests).values(Array.from({ length: PORTAL_ACCESS_REQUEST_PENDING_CAP }, (_, i) => ({
      orgId: org.id, email: `fill-${i}-${randomUUID().slice(0, 8)}@${domain}`, source: 'self' as const, expiresAt: future,
    })));
    expect(PORTAL_ACCESS_REQUEST_PENDING_CAP).toBe(200);
    const email = `capped-${randomUUID().slice(0, 8)}@${domain}`;

    const res = await verify(await requestLink(email));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toEqual({ outcome: 'request_unavailable' });

    expect(await requestsFor(email)).toEqual([]);
    const [{ n }] = await admin().select({ n: sql<number>`count(*)::int` }).from(portalAccessRequests)
      .where(and(eq(portalAccessRequests.orgId, org.id), eq(portalAccessRequests.status, 'pending'))) as [{ n: number }];
    expect(n).toBe(PORTAL_ACCESS_REQUEST_PENDING_CAP);
    const audits = await awaitAuditRows(async () => (await selfRegisterAudits(org.id))
      .filter((a) => a.action === 'portal.auth.self_register.verify'), 1);
    expect(audits).toEqual([expect.objectContaining({
      result: 'denied', details: expect.objectContaining({ outcome: 'request_unavailable', mode: 'approval', reason: 'requests_capped' }),
    })]);
  });

  it('an instant-mode account holds no browser session before it accepts the invite', async () => {
    const { org } = await seedOrg({ mode: 'instant' });
    const { domain } = await verifyDomain(org);
    const email = `nosession-${randomUUID().slice(0, 8)}@${domain}`;

    const res = await verify(await requestLink(email));
    expect(res.headers.getSetCookie().some((c) => c.startsWith('breeze_portal_session='))).toBe(false);
    await inviteTokenFrom(res);

    const [account] = await loginsFor(email);
    expect(account).toMatchObject({ status: 'invited', browserAccess: 'granted', passwordHash: null });
    expect([...portalSessions.values()].filter((s) => s.portalUserId === account!.id)).toEqual([]);

    // No password exists yet, so a password sign-in is the ordinary 401.
    const login = await portalApp.request('/portal/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: STRONG_PASSWORD }),
    });
    expect(login.status).toBe(401);
    expect(await login.json()).toEqual({ error: 'Invalid email or password' });
    expect(login.headers.getSetCookie().some((c) => c.startsWith('breeze_portal_session='))).toBe(false);
    expect([...portalSessions.values()].filter((s) => s.portalUserId === account!.id)).toEqual([]);
    expect((await loginsFor(email))[0]).toMatchObject({ status: 'invited', lastLoginAt: null });
  });

  it('a request on org X\'s custom portal host for an address on org Y\'s verified domain sends nothing', async () => {
    // inv. 1 / D6: org X serves its portal on a verified custom domain.
    const { org: orgX } = await seedOrg({ mode: 'approval' });
    const hostX = `portal-x-${randomUUID().slice(0, 8)}.example.com`;
    await admin().insert(portalBranding).values({ orgId: orgX.id, customDomain: hostX, domainVerified: true });
    const { org: orgY } = await seedOrg({ mode: 'approval' });
    const { domain } = await verifyDomain(orgY);
    const email = `hosted-${randomUUID().slice(0, 8)}@${domain}`;

    // Same answer as any submit (Host in any case, with a port).
    await submit(email, { Host: `${hostX.toUpperCase()}:443` });
    expect(jobs).toEqual([{ email, name: 'Pat Person', host: hostX }]);
    expect(await runJobs()).toEqual(['ineligible']);
    expect(mail.sent).toEqual([]);
    expect(await requestsFor(email)).toEqual([]);
    expect(await selfRegisterAudits(orgX.id)).toEqual([]);
    expect(await selfRegisterAudits(orgY.id)).toEqual([]);

    // CONTROL: the same address on the shared host does reach org Y.
    await submit(email);
    expect(await runJobs()).toEqual(['link_sent']);
    expect(mail.sent.map((m) => ({ kind: m.kind, to: m.to, orgName: m.params.orgName })))
      .toEqual([{ kind: 'verify_link', to: email, orgName: orgY.name }]);
    expect(await selfRegisterAudits(orgX.id)).toEqual([]);
  });
});

