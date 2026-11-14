/**
 * Google account resolution on real Postgres (portal registration W7 #11384,
 * plan Task 5, D2–D5, D9, D13, D15; spec §5.6, inv. 1/2/4/5; Review Focus
 * 1–4).
 *
 * The resolver runs as breeze_app under forced RLS through the real `db` pool
 * with no DB context held, exactly as the callback calls it. Verified domains
 * are seeded the way W5 records one (dns_txt evidence, a pass within the
 * stale window) over the superuser connection, and `findOrgByVerifiedDomain`
 * is the real one. The invite consumer is injected. Nothing reaches Google.
 */
import './setup';

/**
 * Seams on the REAL W5 read API (the wrappers call through):
 *  - `afterFind`: runs once, right after step 0's findOrgByVerifiedDomain
 *    returned, to move the domain between step 0 and a write branch (D15);
 *  - `address`: awaited inside the Google address rule (step 4), so two first
 *    sign-ins both pass steps 1 and 4 before either writes.
 */
const hooks = vi.hoisted(() => ({
  afterFind: null as null | ((domain: string) => Promise<void>),
  address: null as null | (() => Promise<void>),
}));

vi.mock('../../services/portalDomainVerification', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/portalDomainVerification')>();
  return {
    ...actual,
    findOrgByVerifiedDomain: async (domain: string) => {
      const fact = await actual.findOrgByVerifiedDomain(domain);
      const hook = hooks.afterFind;
      if (hook) {
        hooks.afterFind = null;
        await hook(domain);
      }
      return fact;
    },
    isDomainVerifiedForOrg: async (domain: string, orgId: string) => {
      const verified = await actual.isDomainVerifiedForOrg(domain, orgId);
      if (hooks.address) await hooks.address();
      return verified;
    },
  };
});

import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestDb } from './setup';
import { createOrganization, createPartner } from './db-utils';
import { db, withSystemDbAccessContext } from '../../db';
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
import { __testOnly as policyTestOnly } from '../../services/portalAccessPolicy';
import { createPortalAccessRequest } from '../../services/portalAccessRequests';
import { entraIssuer, findPortalUserIdByIdentity } from '../../services/portalUserIdentities';
import {
  resolvePortalOidcSignIn,
  type PortalOidcSignInOutcome,
  type ResolvePortalOidcSignInInput,
} from '../../services/portalOidc/accountResolution';
import { PORTAL_GOOGLE_ISSUER } from '../../services/portalOidc/validators';
import type { PortalGoogleVerifiedIdentity } from '../../services/portalOidc/types';
import { portalRoutes } from '../../routes/portal';
import { issuePortalCapabilityToken, peekPortalCapabilityToken } from '../../routes/portal/capabilityTokens';
import { portalOidcStates, portalRateLimitBuckets, portalSessions } from '../../routes/portal/helpers';
import { __testOnly as googleRoutesTestOnly } from '../../routes/portal/oidcGoogle';

const admin = () => getTestDb();
type Mode = 'invited_only' | 'approval' | 'instant';

beforeEach(() => {
  policyTestOnly.setCapabilities({ entra: true, google: true, selfRegistration: false });
  hooks.afterFind = null;
  hooks.address = null;
});

afterEach(() => {
  policyTestOnly.setCapabilities(null);
  hooks.afterFind = null;
  hooks.address = null;
});

/** Opens once `parties` callers have arrived. A missing party fails as a test timeout, never a sleep. */
function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  return async () => {
    arrived += 1;
    if (arrived >= parties) open();
    await gate;
  };
}

const newDomain = (label = 'ws') => `${label}-${randomUUID().slice(0, 8)}.example.com`;

/** A domain verified for `org` the way W5 records one: dns_txt evidence, passed a minute ago. */
async function seedVerifiedDomain(org: { id: string; partnerId: string }, domain: string) {
  const at = new Date(Date.now() - 60_000);
  const [row] = await admin().insert(customerEmailDomains).values({
    partnerId: org.partnerId, orgId: org.id, domain, isActive: true, verificationToken: `tok-${randomUUID()}`,
    verifiedAt: at, verifiedMethod: 'dns_txt', verifiedEvidence: { via: 'dns_txt', recordName: `_breeze-verify.${domain}` },
    lastCheckedAt: at, lastPassedAt: at, lastCheckStatus: 'pass',
  }).returning({ id: customerEmailDomains.id });
  return row!.id;
}

/** An org with Google on (org override) and `hd` verified for it. Optionally Microsoft on with a PROVEN tenant. */
async function seedGoogleOrg(opts: { mode?: Mode; ssoOnly?: boolean; entra?: boolean; verified?: boolean } = {}) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const hd = newDomain();
  const tid = randomUUID();
  await admin().insert(portalAccessPolicies).values({
    orgId: org.id,
    googleEnabled: true,
    entraEnabled: opts.entra ?? false,
    passwordMode: opts.ssoOnly ? 'sso_only' : 'allowed',
    ssoNewPersonMode: opts.mode ?? 'approval',
  });
  if (opts.verified !== false) await seedVerifiedDomain({ id: org.id, partnerId: partner.id }, hd);
  if (opts.entra) {
    await admin().insert(clientAiTenantMappings).values({
      orgId: org.id, entraTenantId: tid, provenAt: new Date(), provenVia: 'proof_run',
      provenEvidence: { via: 'proof_run', adminOid: randomUUID(), runId: randomUUID() },
      provenByUserId: null,
    });
  }
  return { partner, org: { id: org.id, partnerId: partner.id }, hd, tid };
}

type AccountSeed = {
  email?: string;
  status?: 'invited' | 'active' | 'disabled';
  browserAccess?: 'granted' | 'none';
  authMethod?: 'password' | 'entra' | 'google';
  passwordHash?: string | null;
  authEpoch?: number;
  google?: { sub: string; linkedVia?: 'jit' | 'invite' | 'self_link' };
  entra?: { tid: string; oid: string };
};

async function seedAccount(orgId: string, seed: AccountSeed = {}) {
  const [row] = await admin().insert(portalUsers).values({
    orgId,
    email: seed.email ?? `pu-${randomUUID()}@customer.example.com`,
    authMethod: seed.authMethod ?? 'password',
    status: seed.status ?? 'active',
    browserAccess: seed.browserAccess ?? 'granted',
    passwordHash: seed.passwordHash === undefined ? 'argon2-hash' : seed.passwordHash,
    authEpoch: seed.authEpoch ?? 5,
    ...(seed.entra ? { entraTenantId: seed.entra.tid, entraOid: seed.entra.oid } : {}),
  }).returning();
  if (seed.google) {
    await admin().insert(portalUserIdentities).values({
      orgId, portalUserId: row!.id, provider: 'google', issuer: PORTAL_GOOGLE_ISSUER, subject: seed.google.sub,
      entraTenantId: null, linkedVia: seed.google.linkedVia ?? 'jit',
    });
  }
  if (seed.entra) {
    await admin().insert(portalUserIdentities).values({
      orgId, portalUserId: row!.id, provider: 'entra', issuer: entraIssuer(seed.entra.tid), subject: seed.entra.oid,
      entraTenantId: seed.entra.tid, linkedVia: 'jit',
    });
  }
  return row!;
}

async function readAccount(id: string) {
  const [row] = await admin().select().from(portalUsers).where(eq(portalUsers.id, id));
  return row!;
}

const identitiesOf = (portalUserId: string) =>
  admin().select().from(portalUserIdentities).where(eq(portalUserIdentities.portalUserId, portalUserId));
const identitiesWithSubject = (subject: string) =>
  admin().select().from(portalUserIdentities).where(eq(portalUserIdentities.subject, subject));
const accountsIn = (orgId: string) => admin().select().from(portalUsers).where(eq(portalUsers.orgId, orgId));

function googleIdentity(hd: string, sub: string, email: string | null, name: string | null = 'Pat Person'): PortalGoogleVerifiedIdentity {
  return {
    provider: 'google',
    issuer: PORTAL_GOOGLE_ISSUER,
    subject: sub,
    entraTenantId: null,
    upn: null,
    emailClaim: email,
    emailDomainOwnerVerified: true,
    name,
    googleHostedDomain: hd,
  };
}

function entraIdentity(tid: string, oid: string, upn: string | null) {
  return {
    provider: 'entra' as const,
    issuer: entraIssuer(tid),
    subject: oid,
    entraTenantId: tid,
    upn,
    emailClaim: null,
    emailDomainOwnerVerified: false,
    name: 'Pat Person',
  };
}

const noInvite: ResolvePortalOidcSignInInput['inviteConsumer'] = async () => {
  throw new Error('the invite consumer must not be called on this path');
};

function signIn(over: Partial<ResolvePortalOidcSignInInput> & Pick<ResolvePortalOidcSignInInput, 'identity'>) {
  return resolvePortalOidcSignIn({ purpose: { kind: 'login' }, hostOrgId: null, inviteConsumer: noInvite, ...over });
}

const newSub = () => `${Date.now()}${Math.floor(Math.random() * 1e9)}`;

describe('portal Google account resolution (real DB, verified hd)', () => {
  it('known google identity with browser access → session pinned to hd', async () => {
    const { org, hd } = await seedGoogleOrg();
    const sub = newSub();
    const account = await seedAccount(org.id, { authMethod: 'google', passwordHash: null, google: { sub } });

    const out = await signIn({ identity: googleIdentity(hd, sub, account.email) });
    expect(out).toEqual({
      kind: 'session', portalUserId: account.id, orgId: org.id, authEpoch: 5,
      method: 'google', entraTenantId: null, googleHostedDomain: hd, via: 'identity',
    });
    const [identity] = await identitiesOf(account.id);
    expect(identity!.lastUsedAt).not.toBeNull();
    expect((await readAccount(account.id)).lastLoginAt).not.toBeNull();
  });

  it('a declared-only (unverified) hd → org_unresolved, nothing written', async () => {
    const { org, hd } = await seedGoogleOrg({ mode: 'instant', verified: false });
    await admin().insert(customerEmailDomains).values({ partnerId: org.partnerId, orgId: org.id, domain: hd });
    const out = await signIn({ identity: googleIdentity(hd, newSub(), `pat@${hd}`) });
    expect(out).toEqual({ kind: 'denied', reason: 'org_unresolved', orgId: null });
    expect(await accountsIn(org.id)).toEqual([]);
  });

  it('google identity in org A whose hd is now verified for org B → identity_other_org', async () => {
    // inv. 4: the identity was created in A; the hd now resolves B (another partner).
    const { org: orgA } = await seedGoogleOrg();
    const { org: orgB, hd } = await seedGoogleOrg({ mode: 'instant' });
    const sub = newSub();
    const inA = await seedAccount(orgA.id, { authMethod: 'google', passwordHash: null, google: { sub } });

    const out = await signIn({ identity: googleIdentity(hd, sub, inA.email) });
    expect(out).toEqual({ kind: 'denied', reason: 'identity_other_org', orgId: orgB.id });
    expect(await accountsIn(orgB.id)).toEqual([]);
    expect(await identitiesWithSubject(sub)).toHaveLength(1);
    expect((await readAccount(inA.id)).authEpoch).toBe(5);
  });

  it('new person with an existing same-email account → account_exists, no identity, the password account untouched', async () => {
    // RF1: instant mode would otherwise create or link.
    const { org, hd } = await seedGoogleOrg({ mode: 'instant' });
    const email = `pat-${randomUUID().slice(0, 8)}@${hd}`;
    const existing = await seedAccount(org.id, { email: email.toUpperCase(), passwordHash: 'kept-hash' });
    const sub = newSub();

    expect(await signIn({ identity: googleIdentity(hd, sub, email) })).toEqual({ kind: 'account_exists', orgId: org.id });
    expect(await identitiesWithSubject(sub)).toEqual([]);
    expect(await readAccount(existing.id)).toMatchObject({ passwordHash: 'kept-hash', authEpoch: 5, authMethod: 'password' });
    expect(await accountsIn(org.id)).toHaveLength(1);
  });

  it('an account at the same address in another org does not block (instant creates org A\'s account)', async () => {
    // RF1: the address check is per org; org B is another partner's.
    const { org: orgA, hd } = await seedGoogleOrg({ mode: 'instant' });
    const { org: orgB } = await seedGoogleOrg();
    const email = `pat-${randomUUID().slice(0, 8)}@${hd}`;
    const inB = await seedAccount(orgB.id, { email, passwordHash: 'b-hash' });
    const sub = newSub();

    const out = await signIn({ identity: googleIdentity(hd, sub, email, 'Pat A') });
    expect(out).toMatchObject({ kind: 'session', orgId: orgA.id, method: 'google', googleHostedDomain: hd, via: 'instant' });
    const account = await readAccount((out as { portalUserId: string }).portalUserId);
    expect(account).toMatchObject({
      orgId: orgA.id, email, name: 'Pat A', status: 'active', browserAccess: 'granted', authMethod: 'google',
      passwordHash: null, entraTenantId: null, entraOid: null,
    });
    // The email is on the hd: a contact is linked (D3).
    expect(account.contactId).not.toBeNull();
    expect(await identitiesOf(account.id)).toEqual([expect.objectContaining({
      orgId: orgA.id, provider: 'google', issuer: PORTAL_GOOGLE_ISSUER, subject: sub, entraTenantId: null, linkedVia: 'jit',
    })]);
    expect(await readAccount(inB.id)).toMatchObject({ orgId: orgB.id, passwordHash: 'b-hash', authEpoch: 5 });
  });

  it('approval mode creates a google request with sub and hostedDomain, and no account', async () => {
    const { org, hd } = await seedGoogleOrg({ mode: 'approval' });
    const sub = newSub();
    const email = `req-${randomUUID().slice(0, 8)}@${hd}`;
    expect(await signIn({ identity: googleIdentity(hd, sub, email, 'Req Person') })).toEqual({ kind: 'request_sent', orgId: org.id });
    expect(await admin().select().from(portalAccessRequests).where(eq(portalAccessRequests.orgId, org.id))).toEqual([
      expect.objectContaining({
        source: 'google', email, name: 'Req Person', issuer: PORTAL_GOOGLE_ISSUER, subject: sub,
        googleHostedDomain: hd, entraTenantId: null, portalUserId: null, status: 'pending',
      }),
    ]);
    expect(await accountsIn(org.id)).toEqual([]);
  });

  it('an approval-mode google sign-in at an address pending for another identity → request_conflict, queue unchanged', async () => {
    // D9: an email match never decides which identity is queued.
    const { org, hd } = await seedGoogleOrg({ mode: 'approval' });
    const email = `pending-${randomUUID().slice(0, 8)}@${hd}`;
    const first = await createPortalAccessRequest({ source: 'google', orgId: org.id, email, name: 'First', sub: newSub(), hostedDomain: hd });
    expect(first.kind).toBe('created');
    const before = await admin().select().from(portalAccessRequests).where(eq(portalAccessRequests.orgId, org.id));

    const out = await signIn({ identity: googleIdentity(hd, newSub(), email, 'Second') });
    expect(out).toEqual({ kind: 'denied', reason: 'request_conflict', orgId: org.id });
    expect(await admin().select().from(portalAccessRequests).where(eq(portalAccessRequests.orgId, org.id))).toEqual(before);
  });

  it('invited_only → invited_only, nothing written', async () => {
    const { org, hd } = await seedGoogleOrg({ mode: 'invited_only' });
    expect(await signIn({ identity: googleIdentity(hd, newSub(), `pat@${hd}`) }))
      .toEqual({ kind: 'denied', reason: 'invited_only', orgId: org.id });
    expect(await accountsIn(org.id)).toEqual([]);
  });

  it('instant mode with an email on an unverified secondary domain creates the account with no contact', async () => {
    // D3: Google is authoritative for the address, but a contact link needs the hd or a domain verified for the org.
    const { org, hd } = await seedGoogleOrg({ mode: 'instant' });
    const email = `pat@${newDomain('secondary')}`;
    const out = await signIn({ identity: googleIdentity(hd, newSub(), email) });
    expect(out).toMatchObject({ kind: 'session', via: 'instant', method: 'google' });
    expect(await readAccount((out as { portalUserId: string }).portalUserId)).toMatchObject({ orgId: org.id, email, contactId: null });
    expect(await admin().select().from(contacts).where(eq(contacts.orgId, org.id))).toEqual([]);
  });

  it('a known google identity on a browser_access none account follows step 5 (no session without a grant)', async () => {
    const { org, hd } = await seedGoogleOrg({ mode: 'invited_only' });
    const sub = newSub();
    const account = await seedAccount(org.id, { authMethod: 'google', browserAccess: 'none', passwordHash: null, google: { sub } });

    expect(await signIn({ identity: googleIdentity(hd, sub, account.email) }))
      .toEqual({ kind: 'denied', reason: 'invited_only', orgId: org.id });
    expect(await readAccount(account.id)).toMatchObject({ browserAccess: 'none', authEpoch: 5 });

    await admin().update(portalAccessPolicies).set({ ssoNewPersonMode: 'approval' }).where(eq(portalAccessPolicies.orgId, org.id));
    expect(await signIn({ identity: googleIdentity(hd, sub, account.email) })).toEqual({ kind: 'request_sent', orgId: org.id });
    expect(await admin().select().from(portalAccessRequests).where(eq(portalAccessRequests.orgId, org.id))).toEqual([
      expect.objectContaining({ source: 'addin_user', portalUserId: account.id, issuer: null, subject: null }),
    ]);
    expect(await readAccount(account.id)).toMatchObject({ browserAccess: 'none', authEpoch: 5 });
  });

  it('invite via Google activates and links linked_via invite, auth_method unchanged', async () => {
    const { org, hd } = await seedGoogleOrg();
    const invited = await seedAccount(org.id, { status: 'invited', passwordHash: null, authEpoch: 7 });
    const sub = newSub();
    const consumer = vi.fn(async () => ({ portalUserId: invited.id, orgId: org.id, authEpoch: 7 }));

    const out = await signIn({
      identity: googleIdentity(hd, sub, `someone-else@${hd}`),
      purpose: { kind: 'invite', inviteTokenHash: 'f'.repeat(64) },
      inviteConsumer: consumer,
    });
    expect(out).toEqual({
      kind: 'session', portalUserId: invited.id, orgId: org.id, authEpoch: 8,
      method: 'google', entraTenantId: null, googleHostedDomain: hd, via: 'invite',
    });
    expect(await readAccount(invited.id)).toMatchObject({
      status: 'active', browserAccess: 'granted', authMethod: 'password', authEpoch: 8, entraTenantId: null, entraOid: null,
    });
    expect(await identitiesOf(invited.id)).toEqual([expect.objectContaining({
      provider: 'google', issuer: PORTAL_GOOGLE_ISSUER, subject: sub, linkedVia: 'invite',
    })]);
  });

  it('a google identity already bound to an account never completes an invite → identity_conflict, invite NOT consumed', async () => {
    // D11 / RF4: knowable before consumption, so the invite is not spent.
    const { org, hd } = await seedGoogleOrg();
    const sub = newSub();
    await seedAccount(org.id, { authMethod: 'google', passwordHash: null, google: { sub } });
    const invited = await seedAccount(org.id, { status: 'invited', passwordHash: null, authEpoch: 7 });
    const consumer = vi.fn(async () => ({ portalUserId: invited.id, orgId: org.id, authEpoch: 7 }));

    const out = await signIn({
      identity: googleIdentity(hd, sub, null),
      purpose: { kind: 'invite', inviteTokenHash: 'e'.repeat(64) },
      inviteConsumer: consumer,
    });
    expect(out).toEqual({ kind: 'denied', reason: 'identity_conflict', orgId: org.id });
    expect(consumer).not.toHaveBeenCalled();
    expect(await readAccount(invited.id)).toMatchObject({ status: 'invited', authEpoch: 7 });
    expect(await identitiesOf(invited.id)).toEqual([]);
  });

  it('invite for an account that already has a google identity → invite_invalid, no second identity (spent, W4 parity)', async () => {
    // The invited account is only known once the invite is consumed (W4's
    // Entra twin: "invite consumed, then the identity link conflicts").
    const { org, hd } = await seedGoogleOrg();
    const held = newSub();
    const invited = await seedAccount(org.id, { status: 'invited', passwordHash: null, authEpoch: 7, google: { sub: held } });
    const sub = newSub();
    const consumer = vi.fn(async () => ({ portalUserId: invited.id, orgId: org.id, authEpoch: 7 }));

    const out = await signIn({
      identity: googleIdentity(hd, sub, null),
      purpose: { kind: 'invite', inviteTokenHash: 'd'.repeat(64) },
      inviteConsumer: consumer,
    });
    expect(out).toEqual({ kind: 'denied', reason: 'invite_invalid', orgId: org.id });
    expect(consumer).toHaveBeenCalledTimes(1);
    expect(await readAccount(invited.id)).toMatchObject({ status: 'invited', authEpoch: 7 });
    expect(await identitiesOf(invited.id)).toEqual([expect.objectContaining({ subject: held })]);
    expect(await identitiesWithSubject(sub)).toEqual([]);
  });

  it('an entra-linked account links google from its session; both identities remain', async () => {
    const { org, hd } = await seedGoogleOrg();
    const tid = randomUUID();
    const oid = randomUUID();
    const account = await seedAccount(org.id, { passwordHash: 'kept-hash', entra: { tid, oid } });
    const sub = newSub();

    const out = await signIn({
      identity: googleIdentity(hd, sub, null),
      purpose: { kind: 'link', portalUserId: account.id, orgId: org.id, authEpoch: 5 },
    });
    expect(out).toEqual({ kind: 'linked', portalUserId: account.id, orgId: org.id });
    const rows = await identitiesOf(account.id);
    expect(rows.map((r) => [r.provider, r.subject, r.linkedVia]).sort()).toEqual([
      ['entra', oid, 'jit'],
      ['google', sub, 'self_link'],
    ]);
    // Linking Google never touches the Entra legacy columns or the hash under allowed.
    expect(await readAccount(account.id)).toMatchObject({
      entraTenantId: tid, entraOid: oid, passwordHash: 'kept-hash', authEpoch: 5, authMethod: 'password',
    });
  });

  it('second google identity on one account → refused (link_invalid), the first identity stays', async () => {
    const { org, hd } = await seedGoogleOrg();
    const first = newSub();
    const account = await seedAccount(org.id, { google: { sub: first, linkedVia: 'self_link' } });
    const second = newSub();

    const out = await signIn({
      identity: googleIdentity(hd, second, null),
      purpose: { kind: 'link', portalUserId: account.id, orgId: org.id, authEpoch: 5 },
    });
    expect(out).toEqual({ kind: 'denied', reason: 'link_invalid', orgId: org.id });
    expect((await identitiesOf(account.id)).map((r) => r.subject)).toEqual([first]);
    expect(await identitiesWithSubject(second)).toEqual([]);
  });

  it('a google identity bound to another account → identity_conflict on link', async () => {
    const { org, hd } = await seedGoogleOrg();
    const sub = newSub();
    await seedAccount(org.id, { google: { sub } });
    const other = await seedAccount(org.id);

    const out = await signIn({
      identity: googleIdentity(hd, sub, null),
      purpose: { kind: 'link', portalUserId: other.id, orgId: org.id, authEpoch: 5 },
    });
    expect(out).toEqual({ kind: 'denied', reason: 'identity_conflict', orgId: org.id });
    expect(await identitiesOf(other.id)).toEqual([]);
  });

  it('under sso_only a google link clears the hash; a google sign-in sheds it without an epoch bump', async () => {
    const { org, hd } = await seedGoogleOrg({ ssoOnly: true });
    const linker = await seedAccount(org.id, { passwordHash: 'old-hash' });
    expect(await signIn({
      identity: googleIdentity(hd, newSub(), null),
      purpose: { kind: 'link', portalUserId: linker.id, orgId: org.id, authEpoch: 5 },
    })).toEqual({ kind: 'linked', portalUserId: linker.id, orgId: org.id });
    expect(await readAccount(linker.id)).toMatchObject({ passwordHash: null, authEpoch: 5 });

    const sub = newSub();
    const leaver = await seedAccount(org.id, { passwordHash: 'leaver-hash', google: { sub, linkedVia: 'self_link' } });
    const out = await signIn({ identity: googleIdentity(hd, sub, leaver.email) });
    expect(out).toMatchObject({ kind: 'session', portalUserId: leaver.id, authEpoch: 5, via: 'identity', method: 'google' });
    expect(await readAccount(leaver.id)).toMatchObject({ passwordHash: null, authEpoch: 5, authMethod: 'password' });
  });

  it('an account with both identities: an entra sign-in and a google sign-in each find it; neither lookup sees the other provider', async () => {
    const { org, hd, tid } = await seedGoogleOrg({ entra: true, mode: 'invited_only' });
    const oid = randomUUID();
    const sub = newSub();
    const account = await seedAccount(org.id, { authMethod: 'entra', passwordHash: null, entra: { tid, oid }, google: { sub } });

    expect(await signIn({ identity: entraIdentity(tid, oid, account.email) })).toEqual({
      kind: 'session', portalUserId: account.id, orgId: org.id, authEpoch: 5, entraTenantId: tid, via: 'identity',
    });
    expect(await signIn({ identity: googleIdentity(hd, sub, account.email) })).toEqual({
      kind: 'session', portalUserId: account.id, orgId: org.id, authEpoch: 5,
      method: 'google', entraTenantId: null, googleHostedDomain: hd, via: 'identity',
    });

    // The key includes the provider and issuer: the same subject under the other provider finds nothing.
    await withSystemDbAccessContext(async () => {
      expect(await findPortalUserIdByIdentity(db, { provider: 'google', sub: oid })).toBeNull();
      expect(await findPortalUserIdByIdentity(db, { provider: 'entra', tid, oid: sub })).toBeNull();
      expect(await findPortalUserIdByIdentity(db, { provider: 'google', sub })).toEqual({ portalUserId: account.id, orgId: org.id });
    });
    // A google sign-in carrying the entra oid as its sub is a NEW person: refused at the address, never linked.
    expect(await signIn({ identity: googleIdentity(hd, oid, account.email) })).toEqual({ kind: 'account_exists', orgId: org.id });
    expect(await identitiesOf(account.id)).toHaveLength(2);
  });

  /** W5's transfer, done by hand: A's verification of `domain` cleared, then `domain` verified for B. */
  async function displaceDomain(domain: string, from: { id: string }, to: { id: string; partnerId: string }) {
    await admin().execute(sql`
      UPDATE customer_email_domains
         SET verified_at = NULL, verified_method = NULL, verified_evidence = NULL, last_passed_at = NULL
       WHERE org_id = ${from.id} AND lower(domain) = ${domain}`);
    await seedVerifiedDomain(to, domain);
  }

  it('the hd is displaced to org B between step 0 and the instant write → org_unresolved, nothing written in org A', async () => {
    // D15: the instant branch fences on the row step 0 observed. The move
    // happens after the policy read (inside the step-4 address rule), so only
    // the fence stands between it and an account in A.
    const { org: orgA, hd } = await seedGoogleOrg({ mode: 'instant' });
    const { org: orgB } = await seedGoogleOrg({ mode: 'instant' });
    let moved = false;
    hooks.address = async () => {
      hooks.address = null;
      await displaceDomain(hd, orgA, orgB);
      moved = true;
    };
    const sub = newSub();

    // An email off the hd, so the address rule runs its W5 read (the seam).
    const out = await signIn({ identity: googleIdentity(hd, sub, `pat@${newDomain('personal')}`) });
    expect(moved).toBe(true);
    expect(out).toEqual({ kind: 'denied', reason: 'org_unresolved', orgId: orgA.id });
    expect(await accountsIn(orgA.id)).toEqual([]);
    expect(await accountsIn(orgB.id)).toEqual([]);
    expect(await identitiesWithSubject(sub)).toEqual([]);
    expect(await admin().select().from(contacts).where(eq(contacts.orgId, orgA.id))).toEqual([]);
  });

  it('the hd displaced right after step 0\'s read (before the policy read) → refused by the policy mask, nothing written', async () => {
    // D6: A has no verified domain left, so its effective Google is off.
    const { org: orgA, hd } = await seedGoogleOrg({ mode: 'instant' });
    const { org: orgB } = await seedGoogleOrg({ mode: 'instant' });
    hooks.afterFind = async (domain) => displaceDomain(domain, orgA, orgB);
    const sub = newSub();

    const out = await signIn({ identity: googleIdentity(hd, sub, `pat@${hd}`) });
    expect(hooks.afterFind).toBeNull(); // the hook ran
    expect(out).toEqual({ kind: 'denied', reason: 'method_off', orgId: orgA.id });
    expect(await accountsIn(orgA.id)).toEqual([]);
    expect(await identitiesWithSubject(sub)).toEqual([]);
  });

  describe('races (two concurrent calls, separate pool connections)', () => {
    it('concurrent instant first Google sign-ins create one account', async () => {
      const { org, hd } = await seedGoogleOrg({ mode: 'instant' });
      // A second domain verified for the org: the address rule reads it (the race gate), and the contact is linked.
      const secondary = newDomain('second');
      await seedVerifiedDomain(org, secondary);
      const sub = newSub();
      const email = `racer@${secondary}`;
      hooks.address = barrier(2);

      const settled = await Promise.allSettled([
        signIn({ identity: googleIdentity(hd, sub, email) }),
        signIn({ identity: googleIdentity(hd, sub, email) }),
      ]);
      expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'fulfilled']); // never a 500
      const outcomes = settled.map((s) => (s as PromiseFulfilledResult<PortalOidcSignInOutcome>).value);
      expect(outcomes.map((o) => o.kind)).toEqual(['session', 'session']);

      const accounts = await accountsIn(org.id);
      expect(accounts).toHaveLength(1);
      expect(await identitiesWithSubject(sub)).toHaveLength(1);
      expect(await admin().select().from(contacts).where(and(eq(contacts.orgId, org.id), eq(contacts.email, email)))).toHaveLength(1);
      for (const o of outcomes as Extract<PortalOidcSignInOutcome, { kind: 'session' }>[]) {
        expect(o.portalUserId).toBe(accounts[0]!.id);
      }
    });
  });
});

describe('portal Google sign-in routes (real DB + router, plan Task 7)', () => {
  const CLIENT_ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com';
  const PORTAL = 'https://portal.example.test/portal';
  const SAVED_ENV = {
    id: process.env.PORTAL_GOOGLE_CLIENT_ID,
    secret: process.env.PORTAL_GOOGLE_CLIENT_SECRET,
    portal: process.env.PUBLIC_PORTAL_URL,
  };
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  const tokenFetch = vi.fn();
  const app = new Hono().route('/portal', portalRoutes);

  beforeAll(async () => {
    keys = await generateKeyPair('RS256', { modulusLength: 2048 });
    process.env.PORTAL_GOOGLE_CLIENT_ID = CLIENT_ID;
    process.env.PORTAL_GOOGLE_CLIENT_SECRET = 'portal-google-test-secret';
    process.env.PUBLIC_PORTAL_URL = PORTAL;
  });

  afterAll(() => {
    restore('PORTAL_GOOGLE_CLIENT_ID', SAVED_ENV.id);
    restore('PORTAL_GOOGLE_CLIENT_SECRET', SAVED_ENV.secret);
    restore('PUBLIC_PORTAL_URL', SAVED_ENV.portal);
  });

  beforeEach(() => {
    portalOidcStates.clear();
    portalSessions.clear();
    portalRateLimitBuckets.clear();
    tokenFetch.mockReset();
    googleRoutesTestOnly.setGoogleDeps({ fetch: tokenFetch as unknown as typeof fetch, verificationKey: keys.publicKey });
  });

  afterEach(() => googleRoutesTestOnly.setGoogleDeps(null));

  const cookiePair = (res: Response, name: string) => {
    const header = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
    if (!header) throw new Error(`no ${name} cookie`);
    return header.split(';')[0]!;
  };

  async function startFlow(body: unknown, headers: Record<string, string> = {}) {
    const res = await app.request('/portal/auth/oidc/google/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const url = new URL(((await res.json()) as { redirectUrl: string }).redirectUrl);
    return { state: url.searchParams.get('state')!, nonce: url.searchParams.get('nonce')!, binding: cookiePair(res, 'breeze_portal_oidc') };
  }

  /** Google's answer: an id_token for (sub, hd, email) bound to the flow's nonce. */
  async function googleSignsIn(nonce: string, sub: string, hd: string, email: string) {
    const idToken = await new SignJWT({
      iss: 'https://accounts.google.com', aud: CLIENT_ID, azp: CLIENT_ID, sub, nonce, email, email_verified: true, hd, name: 'Pat Person',
    }).setProtectedHeader({ alg: 'RS256' }).setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
    tokenFetch.mockImplementation(async () => new Response(JSON.stringify({ id_token: idToken }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
  }

  /** Google's redirect as it really arrives (scope, authuser, hd, prompt beside code and state). */
  async function callback(flow: { state: string; binding: string }) {
    const query = `state=${encodeURIComponent(flow.state)}&code=4%2F0A${randomUUID()}&scope=email+profile+openid&authuser=0&hd=ignored.example.com&prompt=consent`;
    return app.request(`/portal/auth/oidc/google/callback?${query}`, { headers: { Cookie: flow.binding } });
  }

  async function oidcAuditRows(orgId: string) {
    return (await admin().select().from(auditLogs).where(eq(auditLogs.orgId, orgId)))
      .filter((row) => row.action.startsWith('portal.auth.'));
  }

  it('end-to-end: start → callback (stubbed token endpoint + local JWKS key) → /portal/profile works', async () => {
    const { org, hd } = await seedGoogleOrg();
    const sub = newSub();
    const account = await seedAccount(org.id, { email: `pat@${hd}`, authMethod: 'google', passwordHash: null, google: { sub } });

    const flow = await startFlow({ purpose: 'login' });
    await googleSignsIn(flow.nonce, sub, hd, account.email);
    const res = await callback(flow);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${PORTAL}/login?sso=signed_in&p=google`);
    expect(res.headers.getSetCookie().find((c) => c.startsWith('breeze_portal_oidc='))).toContain('Max-Age=0');

    // The real session middleware accepts the Google session (google on, its hd verified for the org).
    const profile = await app.request('/portal/profile', { headers: { Cookie: cookiePair(res, 'breeze_portal_session') } });
    expect(profile.status).toBe(200);
    expect(((await profile.json()) as { user: { id: string } }).user.id).toBe(account.id);
    expect([...portalSessions.values()]).toEqual([expect.objectContaining({
      portalUserId: account.id, orgId: org.id, method: 'google', googleHostedDomain: hd,
    })]);

    // The same callback again: the state is spent.
    const replay = await callback(flow);
    expect(replay.headers.get('location')).toBe(`${PORTAL}/login?sso=unavailable&p=google`);

    expect(await oidcAuditRows(org.id)).toEqual([expect.objectContaining({
      action: 'portal.auth.oidc.login', result: 'success', actorId: account.id, resourceId: account.id,
      details: { provider: 'google', outcome: 'session', via: 'identity' },
    })]);
  });

  it('end-to-end account_exists leaves the password account unchanged', async () => {
    // RF1: an address match never links an existing account.
    const { org, hd } = await seedGoogleOrg({ mode: 'instant' });
    const account = await seedAccount(org.id, { email: `pat@${hd}`, passwordHash: 'kept-hash' });
    const before = await readAccount(account.id);
    const sub = newSub();

    const flow = await startFlow({ purpose: 'login' });
    await googleSignsIn(flow.nonce, sub, hd, `pat@${hd}`);
    const res = await callback(flow);
    expect(res.headers.get('location')).toBe(`${PORTAL}/login?sso=account_exists&p=google`);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('breeze_portal_session='))).toBe(false);

    expect(await readAccount(account.id)).toEqual(before);
    expect(await identitiesOf(account.id)).toEqual([]);
    expect(await identitiesWithSubject(sub)).toEqual([]);
    expect(await accountsIn(org.id)).toHaveLength(1);
    expect(await oidcAuditRows(org.id)).toEqual([expect.objectContaining({
      action: 'portal.auth.oidc.login', result: 'success', details: { provider: 'google', outcome: 'account_exists' },
    })]);
  });

  it('custom-domain host for org A + hd verified for org B → unavailable (host_mismatch)', async () => {
    // inv. 1: the host binding recorded at start beats the token's hd.
    const { org: orgA } = await seedGoogleOrg({ mode: 'instant' });
    const domainA = `portal-a-${randomUUID().slice(0, 8)}.test`;
    await admin().insert(portalBranding).values({ orgId: orgA.id, customDomain: domainA, domainVerified: true });
    const { org: orgB, hd: hdB } = await seedGoogleOrg({ mode: 'instant' });
    const sub = newSub();
    const inB = await seedAccount(orgB.id, { email: `pat@${hdB}`, authMethod: 'google', passwordHash: null, google: { sub } });

    const flow = await startFlow({ purpose: 'login' }, { Host: `${domainA.toUpperCase()}:443` });
    await googleSignsIn(flow.nonce, sub, hdB, inB.email);
    const res = await callback(flow);
    expect(res.headers.get('location')).toBe(`${PORTAL}/login?sso=unavailable&p=google`);
    expect(portalSessions.size).toBe(0);
    expect(await oidcAuditRows(orgB.id)).toEqual([expect.objectContaining({
      action: 'portal.auth.oidc.login', result: 'failure', details: { provider: 'google', outcome: 'denied', reason: 'host_mismatch' },
    })]);
    expect(await oidcAuditRows(orgA.id)).toEqual([]);

    // The same identity on the shared host signs in to B.
    const shared = await startFlow({ purpose: 'login' });
    await googleSignsIn(shared.nonce, sub, hdB, inB.email);
    expect((await callback(shared)).headers.get('location')).toBe(`${PORTAL}/login?sso=signed_in&p=google`);
  });

  it('an invite accepted through Google uses the real capability consumer: one activation, the token spent', async () => {
    const { org, hd } = await seedGoogleOrg({ ssoOnly: true });
    const invited = await seedAccount(org.id, { email: `invitee@${hd}`, status: 'invited', passwordHash: null, authEpoch: 7 });
    const inviteToken = await issuePortalCapabilityToken({
      purpose: 'invite', portalUserId: invited.id, orgId: org.id, email: invited.email, authEpoch: 7,
    });

    // sso_only with only Google: the invite can only be accepted through Google.
    const methods = await app.request('/portal/auth/invite/methods', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: inviteToken }),
    });
    expect(await methods.json()).toEqual({ password: false, microsoft: false, google: true });

    const flow = await startFlow({ purpose: 'invite', inviteToken });
    expect(await peekPortalCapabilityToken('invite', inviteToken!)).not.toBeNull(); // peeked, not consumed
    const sub = newSub();
    await googleSignsIn(flow.nonce, sub, hd, `someone-else@${hd}`);
    const res = await callback(flow);
    expect(res.headers.get('location')).toBe(`${PORTAL}/login?sso=signed_in&p=google`);

    expect(await readAccount(invited.id)).toMatchObject({ status: 'active', browserAccess: 'granted', authMethod: 'password', authEpoch: 8 });
    expect(await identitiesOf(invited.id)).toEqual([expect.objectContaining({ provider: 'google', subject: sub, linkedVia: 'invite' })]);
    expect(await peekPortalCapabilityToken('invite', inviteToken!)).toBeNull();
    expect(await oidcAuditRows(org.id)).toEqual([expect.objectContaining({
      action: 'portal.auth.identity.link', result: 'success', resourceId: invited.id, details: { provider: 'google', linkedVia: 'invite' },
    })]);
  });

  it('invite for an account that already has a google identity → invite_invalid, invite not consumed', async () => {
    // Ruling 19 / W4 D11 / plan RF4: the route's consumer peeks the invited
    // account before consuming. The identity lands after the start (which
    // refuses such an invite up front), so only the callback's check stands.
    const { org, hd } = await seedGoogleOrg();
    const invited = await seedAccount(org.id, { email: `invitee@${hd}`, status: 'invited', passwordHash: null, authEpoch: 7 });
    const inviteToken = await issuePortalCapabilityToken({
      purpose: 'invite', portalUserId: invited.id, orgId: org.id, email: invited.email, authEpoch: 7,
    });
    const flow = await startFlow({ purpose: 'invite', inviteToken });

    const held = newSub();
    await admin().insert(portalUserIdentities).values({
      orgId: org.id, portalUserId: invited.id, provider: 'google', issuer: PORTAL_GOOGLE_ISSUER, subject: held, entraTenantId: null, linkedVia: 'jit',
    });
    const sub = newSub();
    await googleSignsIn(flow.nonce, sub, hd, `someone-else@${hd}`);
    const res = await callback(flow);
    expect(res.headers.get('location')).toBe(`${PORTAL}/login?sso=unavailable&p=google`);

    expect(await peekPortalCapabilityToken('invite', inviteToken!)).not.toBeNull(); // NOT consumed
    expect(await readAccount(invited.id)).toMatchObject({ status: 'invited', authEpoch: 7 });
    expect(await identitiesOf(invited.id)).toEqual([expect.objectContaining({ subject: held })]);
    expect(await identitiesWithSubject(sub)).toEqual([]);
    expect(await oidcAuditRows(org.id)).toEqual([expect.objectContaining({
      action: 'portal.auth.oidc.login', result: 'failure', details: { provider: 'google', outcome: 'denied', reason: 'invite_invalid' },
    })]);

    // And a fresh start with the (unspent) token is refused up front.
    const again = await app.request('/portal/auth/oidc/google/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: 'invite', inviteToken }),
    });
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: 'Invalid or expired invite' });
  });

  it('a signed-in password user links Google through link/start and link-status (real session middleware, org RLS)', async () => {
    const { org, hd } = await seedGoogleOrg();
    const account = await seedAccount(org.id, { email: `pat@${hd}`, passwordHash: 'kept-hash' });
    const sessionToken = `portal-${randomUUID()}`;
    portalSessions.set(sessionToken, {
      token: sessionToken, portalUserId: account.id, orgId: org.id, authEpoch: 5, method: 'password',
      createdAt: new Date(), expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    const auth = { Authorization: `Bearer ${sessionToken}` };
    const linkStatus = async () => (await app.request('/portal/auth/oidc/google/link-status', { headers: auth })).json();

    expect((await app.request('/portal/auth/oidc/google/link-status')).status).toBe(401);
    // The policy read runs W5's verified-domain read outside the request's org transaction.
    expect(await linkStatus()).toEqual({ available: true, linked: false });

    const startRes = await app.request('/portal/auth/oidc/google/link/start', {
      method: 'POST', headers: { ...auth, Host: 'shared-portal.example.test' },
    });
    expect(startRes.status).toBe(200);
    const url = new URL(((await startRes.json()) as { redirectUrl: string }).redirectUrl);
    const flow = { state: url.searchParams.get('state')!, binding: cookiePair(startRes, 'breeze_portal_oidc') };
    const sub = newSub();
    await googleSignsIn(url.searchParams.get('nonce')!, sub, hd, account.email);
    const res = await callback(flow);
    expect(res.headers.get('location')).toBe(`${PORTAL}/profile?sso=linked&p=google`);

    expect(await readAccount(account.id)).toMatchObject({ passwordHash: 'kept-hash', authEpoch: 5 });
    expect(await identitiesOf(account.id)).toEqual([expect.objectContaining({ provider: 'google', subject: sub, linkedVia: 'self_link' })]);
    expect(await linkStatus()).toEqual({ available: true, linked: true });
    expect(await oidcAuditRows(org.id)).toEqual([expect.objectContaining({
      action: 'portal.auth.identity.link', result: 'success', actorId: account.id, details: { provider: 'google', linkedVia: 'self_link' },
    })]);
  });
});
