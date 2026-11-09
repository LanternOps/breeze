/**
 * Portal OIDC account resolution on real Postgres (portal registration W4
 * #11381, plan Task 5, spec §5.6, inv. 2/4/5, D10–D13, Review Focus 1/2/5).
 *
 * The resolver runs as breeze_app under forced RLS through the real `db` pool
 * with no DB context held, exactly as the callback calls it. Fixtures are
 * seeded and read back over the superuser connection; every org has a PROVEN
 * tenant mapping unless a test says otherwise. The invite consumer is injected
 * (Task 7 wires the real capability-token one). Task 7 appends the route cases.
 */
import './setup';

/**
 * Race gate for Review Focus 5: when set, resolveLinkableEntraAddress (step 4)
 * waits here after its real read, so two first sign-ins both pass steps 1 and 4
 * before either writes.
 */
const gates = vi.hoisted(() => ({ address: null as null | (() => Promise<void>) }));

vi.mock('../../services/clientAiEntraAddress', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/clientAiEntraAddress')>();
  return {
    ...actual,
    resolveLinkableEntraAddress: async (...args: Parameters<typeof actual.resolveLinkableEntraAddress>) => {
      const decision = await actual.resolveLinkableEntraAddress(...args);
      if (gates.address) await gates.address();
      return decision;
    },
  };
});

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createUser } from './db-utils';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import {
  clientAiTenantMappings,
  contacts,
  customerEmailDomains,
  portalAccessPolicies,
  portalAccessRequests,
  portalUserIdentities,
  portalUsers,
} from '../../db/schema';
import { __testOnly as policyTestOnly } from '../../services/portalAccessPolicy';
import { approvePortalAccessRequest, createPortalAccessRequest } from '../../services/portalAccessRequests';
import { entraIssuer } from '../../services/portalUserIdentities';
import {
  resolvePortalOidcSignIn,
  type PortalOidcSignInOutcome,
  type ResolvePortalOidcSignInInput,
} from '../../services/portalOidc/accountResolution';

const admin = () => getTestDb();
type Mode = 'invited_only' | 'approval' | 'instant';

beforeEach(() => {
  policyTestOnly.setCapabilities({ entra: true, google: false, selfRegistration: false });
  gates.address = null;
});

afterEach(() => {
  policyTestOnly.setCapabilities(null);
  gates.address = null;
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

async function seedOrg(opts: { mode?: Mode; ssoOnly?: boolean; proven?: boolean; domain?: string } = {}) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const tid = randomUUID();
  await admin().insert(clientAiTenantMappings).values({
    orgId: org.id,
    entraTenantId: tid,
    ...(opts.proven === false ? {} : {
      provenAt: new Date(),
      provenVia: 'proof_run' as const,
      provenEvidence: { via: 'proof_run' as const, adminOid: randomUUID(), runId: randomUUID() },
      provenByUserId: null,
    }),
  });
  await admin().insert(portalAccessPolicies).values({
    orgId: org.id,
    entraEnabled: true,
    passwordMode: opts.ssoOnly ? 'sso_only' : 'allowed',
    ssoNewPersonMode: opts.mode ?? 'approval',
  });
  if (opts.domain) {
    await admin().insert(customerEmailDomains).values({ partnerId: partner.id, orgId: org.id, domain: opts.domain });
  }
  return { partner, org, tid };
}

async function setPolicy(orgId: string, patch: { mode?: Mode; ssoOnly?: boolean }) {
  await admin().update(portalAccessPolicies).set({
    ...(patch.mode ? { ssoNewPersonMode: patch.mode } : {}),
    ...(patch.ssoOnly !== undefined ? { passwordMode: patch.ssoOnly ? 'sso_only' as const : 'allowed' as const } : {}),
  }).where(eq(portalAccessPolicies.orgId, orgId));
}

type AccountSeed = {
  email?: string;
  status?: 'invited' | 'active' | 'disabled';
  browserAccess?: 'granted' | 'none';
  authMethod?: 'password' | 'entra';
  passwordHash?: string | null;
  authEpoch?: number;
  identity?: { tid: string; oid: string; linkedVia?: 'jit' | 'invite' | 'self_link' };
};

async function seedAccount(orgId: string, seed: AccountSeed = {}) {
  const [row] = await admin().insert(portalUsers).values({
    orgId,
    email: seed.email ?? `pu-${randomUUID()}@customer.test`,
    authMethod: seed.authMethod ?? 'password',
    status: seed.status ?? 'active',
    browserAccess: seed.browserAccess ?? 'granted',
    passwordHash: seed.passwordHash === undefined ? 'argon2-hash' : seed.passwordHash,
    authEpoch: seed.authEpoch ?? 5,
    ...(seed.identity ? { entraTenantId: seed.identity.tid, entraOid: seed.identity.oid } : {}),
  }).returning();
  if (seed.identity) {
    await admin().insert(portalUserIdentities).values({
      orgId,
      portalUserId: row!.id,
      provider: 'entra',
      issuer: entraIssuer(seed.identity.tid),
      subject: seed.identity.oid,
      entraTenantId: seed.identity.tid,
      linkedVia: seed.identity.linkedVia ?? 'jit',
    });
  }
  return row!;
}

async function readAccount(id: string) {
  const [row] = await admin().select().from(portalUsers).where(eq(portalUsers.id, id));
  return row!;
}

async function identitiesFor(where: { portalUserId?: string; tid?: string; oid?: string }) {
  const rows = await admin().select().from(portalUserIdentities);
  return rows.filter((r) =>
    (where.portalUserId === undefined || r.portalUserId === where.portalUserId)
    && (where.tid === undefined || r.issuer === entraIssuer(where.tid))
    && (where.oid === undefined || r.subject === where.oid));
}

function entraIdentity(tid: string, oid: string, upn: string | null, name: string | null = 'Pat Person') {
  return {
    provider: 'entra' as const,
    issuer: entraIssuer(tid),
    subject: oid,
    entraTenantId: tid,
    upn,
    emailClaim: null,
    emailDomainOwnerVerified: false,
    name,
  };
}

const noInvite: ResolvePortalOidcSignInInput['inviteConsumer'] = async () => {
  throw new Error('the invite consumer must not be called on this path');
};

function signIn(over: Partial<ResolvePortalOidcSignInInput> & Pick<ResolvePortalOidcSignInInput, 'identity'>) {
  return resolvePortalOidcSignIn({ purpose: { kind: 'login' }, hostOrgId: null, inviteConsumer: noInvite, ...over });
}

describe('portal OIDC account resolution (real DB, proven tenant)', () => {
  it('known identity in the org with browser access → session', async () => {
    const { org, tid } = await seedOrg();
    const oid = randomUUID();
    const account = await seedAccount(org.id, { authMethod: 'entra', passwordHash: null, identity: { tid, oid } });

    const out = await signIn({ identity: entraIdentity(tid, oid, account.email) });
    expect(out).toEqual({
      kind: 'session', portalUserId: account.id, orgId: org.id, authEpoch: 5, entraTenantId: tid, via: 'identity',
    });
    const [identity] = await identitiesFor({ portalUserId: account.id });
    expect(identity!.lastUsedAt).not.toBeNull();
    expect((await readAccount(account.id)).lastLoginAt).not.toBeNull();
  });

  it('identity in org A whose tenant is now proven for org B → denied identity_other_org', async () => {
    // A's mapping was displaced: the tenant is now proven for B (another partner).
    const { org: orgA } = await seedOrg();
    const { org: orgB, tid } = await seedOrg({ mode: 'instant' });
    const oid = randomUUID();
    const inA = await seedAccount(orgA.id, { authMethod: 'entra', passwordHash: null, identity: { tid, oid } });

    const out = await signIn({ identity: entraIdentity(tid, oid, inA.email) });
    expect(out).toEqual({ kind: 'denied', reason: 'identity_other_org', orgId: orgB.id });
    // Never placed in B: no account, no identity there; A's account untouched.
    expect(await admin().select().from(portalUsers).where(eq(portalUsers.orgId, orgB.id))).toEqual([]);
    expect(await identitiesFor({ oid })).toHaveLength(1);
    expect((await readAccount(inA.id)).authEpoch).toBe(5);
  });

  it('unproven mapping for the tid → denied org_unresolved', async () => {
    const { org, tid } = await seedOrg({ proven: false, mode: 'instant' });
    const oid = randomUUID();
    const out = await signIn({ identity: entraIdentity(tid, oid, `new-${randomUUID()}@customer.test`) });
    expect(out).toEqual({ kind: 'denied', reason: 'org_unresolved', orgId: null });
    expect(await admin().select().from(portalUsers).where(eq(portalUsers.orgId, org.id))).toEqual([]);
  });

  it('new person with an existing same-email account → account_exists and no link is created', async () => {
    // instant mode: without the check this sign-in would create or link an account.
    const { org, tid } = await seedOrg({ mode: 'instant', domain: 'customer.test' });
    const email = `jane-${randomUUID()}@customer.test`;
    const existing = await seedAccount(org.id, { email: email.toUpperCase() });
    const oid = randomUUID();

    const out = await signIn({ identity: entraIdentity(tid, oid, email) });
    expect(out).toEqual({ kind: 'account_exists', orgId: org.id });
    expect(await identitiesFor({ oid })).toEqual([]);
    const after = await readAccount(existing.id);
    expect(after.entraOid).toBeNull();
    expect(after.authEpoch).toBe(existing.authEpoch);
    expect(await admin().select().from(portalUsers).where(eq(portalUsers.orgId, org.id))).toHaveLength(1);
  });

  it('approval mode creates an entra request with issuer/subject/tid and no account', async () => {
    const { org, tid } = await seedOrg({ mode: 'approval' });
    const oid = randomUUID();
    const email = `req-${randomUUID()}@customer.test`;

    const out = await signIn({ identity: entraIdentity(tid, oid, email.toUpperCase(), 'Req Person') });
    expect(out).toEqual({ kind: 'request_sent', orgId: org.id });
    const requests = await admin().select().from(portalAccessRequests).where(eq(portalAccessRequests.orgId, org.id));
    expect(requests).toEqual([expect.objectContaining({
      source: 'entra', email, name: 'Req Person', issuer: entraIssuer(tid), subject: oid, entraTenantId: tid,
      portalUserId: null, status: 'pending',
    })]);
    expect(await admin().select().from(portalUsers).where(eq(portalUsers.orgId, org.id))).toEqual([]);
    expect(await identitiesFor({ oid })).toEqual([]);
  });

  it('instant mode creates an active, granted, identity-only account with entra_* columns and a contact link', async () => {
    const domain = `acme-${randomUUID().slice(0, 8)}.test`;
    const { org, tid } = await seedOrg({ mode: 'instant', domain });
    const oid = randomUUID();
    const email = `new.person@${domain}`;

    const out = await signIn({ identity: entraIdentity(tid, oid, email, 'New Person') });
    expect(out).toMatchObject({ kind: 'session', orgId: org.id, entraTenantId: tid, via: 'instant' });
    const session = out as Extract<PortalOidcSignInOutcome, { kind: 'session' }>;

    const account = await readAccount(session.portalUserId);
    expect(account).toMatchObject({
      orgId: org.id, email, name: 'New Person', status: 'active', browserAccess: 'granted', authMethod: 'entra',
      passwordHash: null, entraTenantId: tid, entraOid: oid, authEpoch: session.authEpoch,
    });
    expect(account.contactId).not.toBeNull();
    const [contact] = await admin().select().from(contacts).where(eq(contacts.id, account.contactId!));
    expect(contact).toMatchObject({ orgId: org.id, email });
    expect(contact!.roles).toContain('portal');
    expect(await identitiesFor({ portalUserId: account.id })).toEqual([expect.objectContaining({
      orgId: org.id, provider: 'entra', issuer: entraIssuer(tid), subject: oid, entraTenantId: tid, linkedVia: 'jit',
    })]);
  });

  it('instant mode with an undeclared domain: the UPN is the email and no contact is linked (D10)', async () => {
    const { org, tid } = await seedOrg({ mode: 'instant' });
    const oid = randomUUID();
    const email = `undeclared-${randomUUID()}@elsewhere.test`;
    const out = await signIn({ identity: entraIdentity(tid, oid, email) });
    expect(out).toMatchObject({ kind: 'session', via: 'instant' });
    const account = await readAccount((out as { portalUserId: string }).portalUserId);
    expect(account).toMatchObject({ orgId: org.id, email, contactId: null });
    expect(await admin().select().from(contacts).where(eq(contacts.orgId, org.id))).toEqual([]);
  });

  describe('add-in account (identity found, browser_access none) — Review Focus 2', () => {
    async function addinFixture(mode: Mode) {
      const { org, tid } = await seedOrg({ mode });
      const oid = randomUUID();
      const account = await seedAccount(org.id, {
        authMethod: 'entra', browserAccess: 'none', passwordHash: null, identity: { tid, oid },
      });
      return { org, tid, oid, account };
    }

    it('add-in account, invited_only → denied', async () => {
      const { org, tid, oid, account } = await addinFixture('invited_only');
      expect(await signIn({ identity: entraIdentity(tid, oid, account.email) }))
        .toEqual({ kind: 'denied', reason: 'invited_only', orgId: org.id });
      expect(await readAccount(account.id)).toMatchObject({ browserAccess: 'none', authEpoch: 5 });
      expect(await admin().select().from(portalAccessRequests).where(eq(portalAccessRequests.orgId, org.id))).toEqual([]);
    });

    it('add-in account, approval → addin_user request referencing the account', async () => {
      const { org, tid, oid, account } = await addinFixture('approval');
      expect(await signIn({ identity: entraIdentity(tid, oid, account.email) }))
        .toEqual({ kind: 'request_sent', orgId: org.id });
      const requests = await admin().select().from(portalAccessRequests).where(eq(portalAccessRequests.orgId, org.id));
      expect(requests).toEqual([expect.objectContaining({
        source: 'addin_user', portalUserId: account.id, email: account.email, issuer: null, subject: null, status: 'pending',
      })]);
      expect(await readAccount(account.id)).toMatchObject({ browserAccess: 'none', authEpoch: 5 });
    });

    it('add-in account, instant → browser granted without an epoch bump', async () => {
      const { org, tid, oid, account } = await addinFixture('instant');
      const out = await signIn({ identity: entraIdentity(tid, oid, account.email) });
      expect(out).toEqual({
        kind: 'session', portalUserId: account.id, orgId: org.id, authEpoch: 5, entraTenantId: tid, via: 'instant_grant',
      });
      // Epoch unchanged: the person's live add-in sessions keep working.
      expect(await readAccount(account.id)).toMatchObject({ status: 'active', browserAccess: 'granted', authEpoch: 5 });
    });
  });

  it('invite via Microsoft activates the invited account, links (linked_via invite) and keeps auth_method password', async () => {
    const { org, tid } = await seedOrg();
    const invited = await seedAccount(org.id, { status: 'invited', passwordHash: null, authEpoch: 7 });
    const oid = randomUUID();
    const consumer = vi.fn(async () => ({ portalUserId: invited.id, orgId: org.id, authEpoch: 7 }));

    const out = await signIn({
      identity: entraIdentity(tid, oid, `someone-else-${randomUUID()}@customer.test`),
      purpose: { kind: 'invite', inviteTokenHash: 'f'.repeat(64) },
      inviteConsumer: consumer,
    });
    expect(out).toEqual({ kind: 'session', portalUserId: invited.id, orgId: org.id, authEpoch: 8, entraTenantId: tid, via: 'invite' });
    expect(consumer).toHaveBeenCalledWith('f'.repeat(64));
    expect(await readAccount(invited.id)).toMatchObject({
      status: 'active', browserAccess: 'granted', authMethod: 'password', authEpoch: 8, entraTenantId: tid, entraOid: oid,
    });
    expect(await identitiesFor({ portalUserId: invited.id })).toEqual([expect.objectContaining({
      provider: 'entra', issuer: entraIssuer(tid), subject: oid, linkedVia: 'invite',
    })]);
  });

  it('invite for another account than the identity\'s → identity_conflict, invite not consumed', async () => {
    const { org, tid } = await seedOrg();
    const oid = randomUUID();
    await seedAccount(org.id, { authMethod: 'entra', passwordHash: null, identity: { tid, oid } });
    const invited = await seedAccount(org.id, { status: 'invited', passwordHash: null, authEpoch: 7 });
    const consumer = vi.fn(async () => ({ portalUserId: invited.id, orgId: org.id, authEpoch: 7 }));

    const out = await signIn({
      identity: entraIdentity(tid, oid, null),
      purpose: { kind: 'invite', inviteTokenHash: 'e'.repeat(64) },
      inviteConsumer: consumer,
    });
    expect(out).toEqual({ kind: 'denied', reason: 'identity_conflict', orgId: org.id });
    expect(consumer).not.toHaveBeenCalled();
    expect(await readAccount(invited.id)).toMatchObject({ status: 'invited', authEpoch: 7, entraOid: null });
    expect(await identitiesFor({ portalUserId: invited.id })).toEqual([]);
  });

  it('link adds self_link to a signed-in password user; under sso_only it also clears the hash', async () => {
    const { org, tid } = await seedOrg();
    const allowedUser = await seedAccount(org.id, { passwordHash: 'kept-hash' });
    const oidA = randomUUID();
    const linked = await signIn({
      identity: entraIdentity(tid, oidA, null),
      purpose: { kind: 'link', portalUserId: allowedUser.id, orgId: org.id, authEpoch: 5 },
    });
    expect(linked).toEqual({ kind: 'linked', portalUserId: allowedUser.id, orgId: org.id });
    expect(await readAccount(allowedUser.id)).toMatchObject({
      passwordHash: 'kept-hash', authEpoch: 5, authMethod: 'password', entraTenantId: tid, entraOid: oidA,
    });
    expect(await identitiesFor({ portalUserId: allowedUser.id })).toEqual([expect.objectContaining({ subject: oidA, linkedVia: 'self_link' })]);

    await setPolicy(org.id, { ssoOnly: true });
    const ssoUser = await seedAccount(org.id, { passwordHash: 'old-hash' });
    const oidB = randomUUID();
    const linkedSso = await signIn({
      identity: entraIdentity(tid, oidB, null),
      purpose: { kind: 'link', portalUserId: ssoUser.id, orgId: org.id, authEpoch: 5 },
    });
    expect(linkedSso).toEqual({ kind: 'linked', portalUserId: ssoUser.id, orgId: org.id });
    expect(await readAccount(ssoUser.id)).toMatchObject({ passwordHash: null, authEpoch: 5, entraOid: oidB });
  });

  it('known identity signing in while the org is effectively sso_only (via a proof, no PATCH) loses its hash, epoch unchanged', async () => {
    const { org, tid } = await seedOrg({ ssoOnly: true });
    const oid = randomUUID();
    const account = await seedAccount(org.id, { passwordHash: 'leaver-hash', identity: { tid, oid, linkedVia: 'self_link' } });

    const out = await signIn({ identity: entraIdentity(tid, oid, account.email) });
    expect(out).toMatchObject({ kind: 'session', portalUserId: account.id, authEpoch: 5, via: 'identity' });
    expect(await readAccount(account.id)).toMatchObject({ passwordHash: null, authEpoch: 5, authMethod: 'password' });
  });

  it('invite consumed, then the identity link conflicts → invite spent, no account change, invite_invalid', async () => {
    const { org, tid } = await seedOrg();
    // Drift: the invited account already holds a (different) entra identity, so
    // linking this one would conflict on (portal_user_id, provider).
    const invited = await seedAccount(org.id, {
      status: 'invited', passwordHash: null, authEpoch: 7, identity: { tid, oid: randomUUID() },
    });
    const oid = randomUUID();
    const consumer = vi.fn(async () => ({ portalUserId: invited.id, orgId: org.id, authEpoch: 7 }));

    const out = await signIn({
      identity: entraIdentity(tid, oid, null),
      purpose: { kind: 'invite', inviteTokenHash: 'd'.repeat(64) },
      inviteConsumer: consumer,
    });
    expect(out).toEqual({ kind: 'denied', reason: 'invite_invalid', orgId: org.id });
    expect(consumer).toHaveBeenCalledTimes(1); // spent: the MSP resends
    expect(await readAccount(invited.id)).toMatchObject({ status: 'invited', authEpoch: 7 });
    expect(await identitiesFor({ oid })).toEqual([]);
  });

  describe('races — Review Focus 5 (two concurrent calls, separate pool connections)', () => {
    it('concurrent instant first sign-ins create one account', async () => {
      const domain = `race-${randomUUID().slice(0, 8)}.test`;
      const { org, tid } = await seedOrg({ mode: 'instant', domain });
      const oid = randomUUID();
      const email = `racer@${domain}`;
      gates.address = barrier(2);

      const settled = await Promise.allSettled([
        signIn({ identity: entraIdentity(tid, oid, email) }),
        signIn({ identity: entraIdentity(tid, oid, email) }),
      ]);
      expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'fulfilled']); // never a 500
      const outcomes = settled.map((s) => (s as PromiseFulfilledResult<PortalOidcSignInOutcome>).value);
      // The loser waited on the address lock, saw the winner's account, then
      // re-ran step 1 and found the same identity: both get a session for the
      // one account (never "account exists — use your password" for an
      // identity-only account).
      expect(outcomes.map((o) => o.kind)).toEqual(['session', 'session']);

      const accounts = await admin().select().from(portalUsers).where(eq(portalUsers.orgId, org.id));
      expect(accounts).toHaveLength(1);
      expect(await identitiesFor({ oid })).toHaveLength(1);
      expect(await admin().select().from(contacts).where(and(eq(contacts.orgId, org.id), eq(contacts.email, email)))).toHaveLength(1);
      for (const o of outcomes as Extract<PortalOidcSignInOutcome, { kind: 'session' }>[]) {
        expect(o.portalUserId).toBe(accounts[0]!.id);
      }
    });

    it('invite consumed twice via Microsoft activates once; the second → invite_invalid', async () => {
      const { org, tid } = await seedOrg();
      const invited = await seedAccount(org.id, { status: 'invited', passwordHash: null, authEpoch: 7 });
      const oid = randomUUID();
      // A double-clicked invite where the consumer hands the payload to BOTH
      // callbacks (stronger than the real single-use GET+DEL): only the row
      // lock + epoch guard stand between them and a double activation.
      const arrive = barrier(2);
      const consumer = vi.fn(async () => {
        await arrive();
        return { portalUserId: invited.id, orgId: org.id, authEpoch: 7 };
      });
      const purpose = { kind: 'invite' as const, inviteTokenHash: 'c'.repeat(64) };

      const settled = await Promise.allSettled([
        signIn({ identity: entraIdentity(tid, oid, null), purpose, inviteConsumer: consumer }),
        signIn({ identity: entraIdentity(tid, oid, null), purpose, inviteConsumer: consumer }),
      ]);
      expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'fulfilled']);
      const outcomes = settled.map((s) => (s as PromiseFulfilledResult<PortalOidcSignInOutcome>).value);
      expect(outcomes.map((o) => (o.kind === 'denied' ? o.reason : `${o.kind}`)).sort()).toEqual(['invite_invalid', 'session']);

      // One activation: exactly one epoch bump, one identity.
      expect(await readAccount(invited.id)).toMatchObject({ status: 'active', authEpoch: 8 });
      expect(await identitiesFor({ portalUserId: invited.id })).toHaveLength(1);
    });
  });

  it('W3 approve of an entra request still passes after createIdentityOnlyAccount moved', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const decider = await createUser({ partnerId: partner.id, email: `tech-${randomUUID()}@msp.test`, name: 'Tech One' });
    const ctx: DbAccessContext = {
      scope: 'partner', orgId: null, accessibleOrgIds: [org.id], accessiblePartnerIds: [partner.id],
      userId: decider.id, currentPartnerId: partner.id,
    };
    const email = `entra-${randomUUID()}@example.test`;
    const tid = randomUUID();
    const oid = randomUUID();
    const created = await createPortalAccessRequest({ source: 'entra', orgId: org.id, email, name: 'Ent Ra', tid, oid });
    expect(created.kind).toBe('created');

    const result = await withDbAccessContext(ctx, () => approvePortalAccessRequest({
      orgId: org.id, requestId: (created as { requestId: string }).requestId, deciderUserId: decider.id,
    }));
    expect(result).toMatchObject({ outcome: 'account_created', email, name: 'Ent Ra', source: 'entra' });
    const account = await readAccount(result.portalUserId);
    expect(account).toMatchObject({
      status: 'active', browserAccess: 'granted', authMethod: 'entra', passwordHash: null, entraTenantId: tid, entraOid: oid,
    });
    expect(account.contactId).not.toBeNull();
    expect(await identitiesFor({ portalUserId: account.id })).toEqual([expect.objectContaining({
      issuer: entraIssuer(tid), subject: oid, linkedVia: 'jit', lastUsedAt: null,
    })]);
  });
});
