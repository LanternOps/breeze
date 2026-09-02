/**
 * #3258 follow-up — end-to-end proof that the last two login-minting paths
 * attach a CONTACT.
 *
 * The unit suites mock the database, so they can only prove each path ASKED for
 * the right thing. Only real Postgres can prove the claims that matter:
 *
 *  1. An Entra first exchange creates EXACTLY ONE contact and writes it onto
 *     the new login. A count is something a mocked suite cannot see.
 *  2. A SECOND exchange for the same identity creates nothing — the advisory
 *     lock plus the never-re-derive rule, observed as a row count that does
 *     not move.
 *  3. A shared mailbox leaves `contact_id` NULL rather than picking a person.
 *     `contacts_org_email_idx` is genuinely non-unique, which only a real
 *     schema can demonstrate.
 *  4. The Outlook add-in path produces a ticket whose requester IS the contact,
 *     writes NO `portal_users` row at all, and persists
 *     `requester_contact_id` through the real same-org composite FK — a wrong
 *     org is a constraint violation, not a failed assertion, so the write
 *     itself is the test.
 *
 * The exchange runs under `withSystemDbAccessContext` exactly as production
 * does (the service opens its own); the add-in helpers are driven directly
 * because the route's own wiring is covered by `routes/officeAddin/tickets.test.ts`
 * and standing up a tech session would test the middleware, not the linkage.
 */
import './setup';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

import { withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  contacts,
  customerEmailDomains,
  organizations,
  partners,
  tickets,
  users,
} from '../../db/schema';
import { portalUsers } from '../../db/schema/portal';
import { clientAiOrgPolicies, clientAiTenantMappings } from '../../db/schema/clientAi';
import { resolveAndMintClientSession } from '../../services/clientAiExchange';
import { resolveConfirmedContact } from '../../services/officeAddin/addinContacts';
import { createTicket } from '../../services/ticketService';
import { linkLoginToContact } from '../../services/contacts/loginLink';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';
import { randomUUID } from 'node:crypto';

const admin = () => getTestDb() as any;
const seeded = { partnerIds: [] as string[], orgIds: [] as string[] };

/** The exchange mints a Redis session; nothing here asserts on it. */
const fakeRedis = {
  setex: async () => 'OK',
  sadd: async () => 1,
  expire: async () => 1,
} as never;

interface Fixture {
  partnerId: string;
  orgId: string;
  userId: string;
  /** Entra tenant GUID mapped to this org. */
  tid: string;
  /** The domain the PARTNER has declared this org owns. */
  domain: string;
}

let fx: Fixture;

async function seed(): Promise<Fixture> {
  const partner = await createPartner({ name: `LoginLink MSP ${randomUUID().slice(0, 8)}` });
  const org = await createOrganization({ partnerId: partner.id, name: `LoginLink Org ${randomUUID().slice(0, 8)}` });
  const user = await createUser({ partnerId: partner.id, name: 'Tess Tech' });
  seeded.partnerIds.push(partner.id);
  seeded.orgIds.push(org.id);

  // The two gates above the portal-user JIT: partner entitlement, then org policy.
  await admin().update(partners).set({ aiForOfficeEnabled: true }).where(eq(partners.id, partner.id));
  const tid = randomUUID();
  await admin().insert(clientAiTenantMappings).values({ orgId: org.id, entraTenantId: tid });
  await admin().insert(clientAiOrgPolicies).values({ orgId: org.id, enabled: true });

  // The partner's declaration that this org owns the domain — the same table
  // inbound email trusts to route a sender to a tenant. Without a row here, no
  // Entra address is linkable at all.
  const domain = `c${randomUUID().slice(0, 8)}.test`;
  await admin().insert(customerEmailDomains).values({
    partnerId: partner.id, orgId: org.id, domain, isActive: true,
  });

  return { partnerId: partner.id, orgId: org.id, userId: user.id, tid, domain };
}

/** A UPN on the org's owned domain — the strongest, linkable shape. */
const ownedAddress = () => `jane.${randomUUID().slice(0, 8)}@${fx.domain}`;

const claims = (over: Record<string, unknown> = {}) => {
  // `in`, not `??`: an explicit `upn: null` is the address-less case and must
  // NOT fall back to a generated address.
  const upn = 'upn' in over ? (over.upn as string | null) : ownedAddress();
  return {
    tid: fx.tid,
    oid: randomUUID(),
    upn,
    emailClaim: null,
    emailDomainOwnerVerified: false,
    email: upn,
    name: 'Jane Client',
    aud: 'api://breeze',
    iss: `https://login.microsoftonline.com/${fx.tid}/v2.0`,
    exp: 0,
    iat: 0,
    scp: null,
    ...over,
  } as never;
};

const contactsFor = (orgId: string, email: string) =>
  admin()
    .select({ id: contacts.id, roles: contacts.roles, name: contacts.name })
    .from(contacts)
    .where(and(eq(contacts.orgId, orgId), sql`lower(${contacts.email}) = ${email.toLowerCase()}`));

/** The add-in's real request context: partner scope, RLS enforced. */
const techContext = <T,>(fn: () => Promise<T>): Promise<T> =>
  withDbAccessContext(
    {
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [fx.orgId],
      accessiblePartnerIds: [fx.partnerId],
      currentPartnerId: fx.partnerId,
      userId: fx.userId,
    },
    fn,
  );

const loginRow = (id: string) =>
  admin().select({ id: portalUsers.id, contactId: portalUsers.contactId, orgId: portalUsers.orgId })
    .from(portalUsers).where(eq(portalUsers.id, id)).limit(1);

beforeEach(async () => {
  fx = await seed();
});

afterAll(async () => {
  // Children first: portal_users and tickets both reference contacts.
  for (const orgId of seeded.orgIds) {
    await admin().delete(tickets).where(eq(tickets.orgId, orgId));
    await admin().delete(portalUsers).where(eq(portalUsers.orgId, orgId));
    await admin().delete(contacts).where(eq(contacts.orgId, orgId));
    await admin().delete(clientAiOrgPolicies).where(eq(clientAiOrgPolicies.orgId, orgId));
    await admin().delete(clientAiTenantMappings).where(eq(clientAiTenantMappings.orgId, orgId));
    await admin().delete(customerEmailDomains).where(eq(customerEmailDomains.orgId, orgId));
  }
  for (const orgId of seeded.orgIds) await admin().delete(organizations).where(eq(organizations.id, orgId));
  // `users.partner_id` has no ON DELETE, so the staff row must go before its partner.
  for (const partnerId of seeded.partnerIds) await admin().delete(users).where(eq(users.partnerId, partnerId));
  for (const partnerId of seeded.partnerIds) await admin().delete(partners).where(eq(partners.id, partnerId));
});

describe('Entra SSO provisioning links a contact (#3258)', () => {
  it('creates EXACTLY ONE contact on the first exchange and writes it onto the login', async () => {
    const c = claims();
    const outcome = await resolveAndMintClientSession(c, fakeRedis);

    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    expect(outcome.audit.details).toMatchObject({ provisioned: true, contactLink: 'created' });

    const found = await contactsFor(fx.orgId, (c as { email: string }).email);
    expect(found).toHaveLength(1);
    // The invite's role, for the same reason: this person has been granted a
    // login. Inbound email deliberately claims no role at all.
    expect(found[0]!.roles).toContain('portal');
    expect(found[0]!.name).toBe('Jane Client');

    const [login] = await loginRow(outcome.body.user.id);
    expect(login!.contactId).toBe(found[0]!.id);
    // Org-bounded by construction — this is what the same-org composite FK on
    // portal_users.contact_id requires.
    expect(login!.orgId).toBe(fx.orgId);
  });

  it('creates NOTHING on a second exchange for the same identity', async () => {
    const c = claims();
    const first = await resolveAndMintClientSession(c, fakeRedis);
    expect(first.kind).toBe('resolved');

    const second = await resolveAndMintClientSession(c, fakeRedis);
    expect(second.kind).toBe('resolved');
    if (second.kind !== 'resolved' || first.kind !== 'resolved') return;

    // Same login, same contact, and no duplicate person.
    expect(second.body.user.id).toBe(first.body.user.id);
    expect(second.audit.details).toMatchObject({ provisioned: false, contactLink: 'kept' });
    expect(await contactsFor(fx.orgId, (c as { email: string }).email)).toHaveLength(1);
  });

  it('backfills a login that predates the change, without minting a second contact', async () => {
    const c = claims();
    const email = (c as { email: string }).email;
    // The pre-change state: a contact-less Entra login, plus the contact that
    // the same person's inbound email would already have created.
    const [existing] = await admin()
      .insert(contacts)
      .values({ orgId: fx.orgId, email, name: 'Jane From Email', roles: [] })
      .returning({ id: contacts.id });
    await admin().insert(portalUsers).values({
      orgId: fx.orgId,
      email,
      name: 'Jane Client',
      passwordHash: null,
      entraOid: (c as { oid: string }).oid,
      entraTenantId: fx.tid,
      authMethod: 'entra',
      status: 'active',
      contactId: null,
    });

    const outcome = await resolveAndMintClientSession(c, fakeRedis);
    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    expect(outcome.audit.details).toMatchObject({ provisioned: false, contactLink: 'linked' });

    const found = await contactsFor(fx.orgId, email);
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe(existing!.id);
    // The union, on a real text[] column: the emailer keeps whatever they were.
    expect(found[0]!.roles).toContain('portal');

    const [login] = await loginRow(outcome.body.user.id);
    expect(login!.contactId).toBe(existing!.id);
  });

  it('leaves the link NULL for a shared mailbox rather than picking a person', async () => {
    const email = `support.${randomUUID().slice(0, 8)}@${fx.domain}`;
    // contacts_org_email_idx is deliberately non-unique — this insert is the
    // proof, and it is why the resolver refuses to guess.
    await admin().insert(contacts).values([
      { orgId: fx.orgId, email, name: 'AP Clerk One', roles: [] },
      { orgId: fx.orgId, email, name: 'AP Clerk Two', roles: [] },
    ]);

    const outcome = await resolveAndMintClientSession(claims({ upn: email }), fakeRedis);

    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    // A login is still granted — the token is a verified Entra identity. Only
    // the PERSON is unresolvable, and the audit says so.
    expect(outcome.audit.details).toMatchObject({ contactLink: 'ambiguous' });
    const [login] = await loginRow(outcome.body.user.id);
    expect(login!.contactId).toBeNull();
    // No third contact invented for the address.
    expect(await contactsFor(fx.orgId, email)).toHaveLength(2);
  });

  it('never keys a contact on the synthetic @entra.invalid address', async () => {
    const outcome = await resolveAndMintClientSession(
      claims({ upn: null, email: null, emailClaim: null }),
      fakeRedis,
    );

    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    expect(outcome.audit.details).toMatchObject({ contactLink: 'unusable-address' });
    expect(outcome.body.user.email).toMatch(/\.entra\.invalid$/);

    const [login] = await loginRow(outcome.body.user.id);
    expect(login!.contactId).toBeNull();
    // An unreachable address must not become a person in the customer's book.
    const all = await admin().select({ id: contacts.id, email: contacts.email })
      .from(contacts).where(eq(contacts.orgId, fx.orgId));
    expect(all.map((r: { email: string | null }) => r.email)).not.toContain(outcome.body.user.email);
  });

  it('NEVER links a UPN on a domain the org does not own', async () => {
    // The token is a perfectly valid Entra identity from the mapped tenant, and
    // the address already belongs to a real contact of this customer. Linking
    // on it would hand that contact's emailed ticket history to whoever holds
    // the tenant — the whole point of the ownership gate.
    const victim = `ceo@${randomUUID().slice(0, 8)}.victim.test`;
    const [existing] = await admin()
      .insert(contacts)
      .values({ orgId: fx.orgId, email: victim, name: 'Real CEO', roles: [] })
      .returning({ id: contacts.id });

    const outcome = await resolveAndMintClientSession(claims({ upn: victim }), fakeRedis);

    expect(outcome.kind).toBe('resolved');
    if (outcome.kind !== 'resolved') return;
    expect(outcome.audit.details).toMatchObject({ contactLink: 'unverified-address', contactId: null });

    const [login] = await loginRow(outcome.body.user.id);
    expect(login!.contactId).toBeNull();
    // The victim's contact is untouched — not linked, and not role-mutated.
    const [after] = await admin()
      .select({ roles: contacts.roles }).from(contacts).where(eq(contacts.id, existing!.id)).limit(1);
    expect(after!.roles).toEqual([]);
  });

  it('denies a login that sits in a different org than the tenant now maps to', async () => {
    // Re-mapping the tenant leaves old logins behind under the OLD org.
    const otherOrg = await createOrganization({ partnerId: fx.partnerId, name: `Stale ${randomUUID().slice(0, 8)}` });
    seeded.orgIds.push(otherOrg.id);
    const c = claims();
    await admin().insert(portalUsers).values({
      orgId: otherOrg.id,
      email: (c as { email: string }).email,
      passwordHash: null,
      entraOid: (c as { oid: string }).oid,
      entraTenantId: fx.tid,
      authMethod: 'entra',
      status: 'active',
      contactId: null,
    });

    const outcome = await resolveAndMintClientSession(c, fakeRedis);

    expect(outcome.kind).toBe('denied');
    if (outcome.kind !== 'denied') return;
    expect(outcome.body.error).toBe('org_mismatch');
    // Nothing was seeded into either org.
    expect(await contactsFor(otherOrg.id, (c as { email: string }).email)).toHaveLength(0);
    expect(await contactsFor(fx.orgId, (c as { email: string }).email)).toHaveLength(0);
  });

  it('two CONCURRENT first exchanges yield one login and one contact', async () => {
    // The only proof the advisory lock actually serialises: a mocked
    // single-threaded suite cannot run two transactions at once.
    const c = claims();

    const [a, b] = await Promise.all([
      resolveAndMintClientSession(c, fakeRedis),
      resolveAndMintClientSession(c, fakeRedis),
    ]);

    expect(a.kind).toBe('resolved');
    expect(b.kind).toBe('resolved');
    if (a.kind !== 'resolved' || b.kind !== 'resolved') return;
    expect(a.body.user.id).toBe(b.body.user.id);

    const logins = await admin().select({ id: portalUsers.id })
      .from(portalUsers).where(eq(portalUsers.orgId, fx.orgId));
    expect(logins).toHaveLength(1);
    expect(await contactsFor(fx.orgId, (c as { email: string }).email)).toHaveLength(1);

    const [login] = await loginRow(a.body.user.id);
    expect(login!.contactId).not.toBeNull();
  });

  it('still mints the session when the contacts write raises a real DB error', async () => {
    // The `link-failed` catch is only real if the failure is contained in a
    // SAVEPOINT: postgres.js re-throws a database error at COMMIT time even
    // after it has been caught, so a deadlock or constraint violation raised on
    // the OUTER exchange transaction would still 500 the request. Only a real
    // Postgres error can prove that — a mocked rejection never reaches commit.
    //
    // The trigger is scoped to one address prefix so it cannot disturb suites
    // running concurrently against the same database.
    await admin().execute(sql`
      CREATE OR REPLACE FUNCTION breeze_test_block_contact_insert() RETURNS trigger AS $fn$
      BEGIN
        IF NEW.email LIKE 'linkfail-%' THEN
          RAISE EXCEPTION 'injected contacts failure' USING ERRCODE = '40001';
        END IF;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql;
    `);
    await admin().execute(sql`
      DROP TRIGGER IF EXISTS breeze_test_block_contact_insert ON contacts;
      CREATE TRIGGER breeze_test_block_contact_insert
        BEFORE INSERT ON contacts FOR EACH ROW
        EXECUTE FUNCTION breeze_test_block_contact_insert();
    `);

    try {
      const email = `linkfail-${randomUUID().slice(0, 8)}@${fx.domain}`;
      const outcome = await resolveAndMintClientSession(claims({ upn: email }), fakeRedis);

      // The token is a verified Entra identity; a contacts problem is ours.
      expect(outcome.kind).toBe('resolved');
      if (outcome.kind !== 'resolved') return;
      expect(outcome.audit.details).toMatchObject({ contactLink: 'link-failed', contactId: null });

      // The LOGIN committed — proof the outer transaction was never poisoned.
      const [login] = await loginRow(outcome.body.user.id);
      expect(login).toBeTruthy();
      expect(login!.contactId).toBeNull();
      // And the savepoint rolled the contact back rather than leaving a partial.
      expect(await contactsFor(fx.orgId, email)).toHaveLength(0);
    } finally {
      await admin().execute(sql`DROP TRIGGER IF EXISTS breeze_test_block_contact_insert ON contacts`);
      await admin().execute(sql`DROP FUNCTION IF EXISTS breeze_test_block_contact_insert()`);
    }
  });

  it('writes NO contact when the org policy does not permit the user', async () => {
    // A tenant member outside policy.selectedUserIds is denied — and must not
    // leave a seeded person behind on the way out.
    const c = claims();
    await admin().update(clientAiOrgPolicies)
      .set({ userAccess: 'selected', selectedUserIds: [] })
      .where(eq(clientAiOrgPolicies.orgId, fx.orgId));

    const outcome = await resolveAndMintClientSession(c, fakeRedis);

    expect(outcome.kind).toBe('denied');
    if (outcome.kind !== 'denied') return;
    expect(outcome.audit.details).toMatchObject({ contactLink: 'not-attempted' });
    expect(await contactsFor(fx.orgId, (c as { email: string }).email)).toHaveLength(0);
    const [login] = await loginRow(outcome.audit.details.portalUserId as string);
    expect(login!.contactId).toBeNull();
  });
});

describe('Outlook add-in confirmed requester is a contact (#3258)', () => {
  it('creates a ticket whose requester IS the contact, and NO login', async () => {
    const email = `new.person.${randomUUID().slice(0, 8)}@${fx.domain}`;

    // The REAL context the add-in route runs in: partner scope with RLS
    // enforced, not the system context. A policy that only passes under system
    // scope would be a false green here.
    const { resolved, ticket } = await techContext(async () => {
      const resolved = await resolveConfirmedContact(
        fx.orgId, { email, name: 'New Person' }, { userId: fx.userId },
      );
      // Exactly the arguments the route passes: no submittedBy at all.
      const ticket = await createTicket(
        {
          source: 'email',
          orgId: fx.orgId,
          subject: 'Printer is on fire',
          description: 'Sent from the pane',
          submitterEmail: email,
          submitterName: 'New Person',
          requesterContactId: resolved.contactId!,
        },
        { userId: fx.userId, name: 'Tess Tech' },
      );
      return { resolved, ticket };
    });
    expect(resolved.outcome).toBe('created');
    expect(resolved.contactId).not.toBeNull();

    const [row] = await admin()
      .select({ requesterContactId: tickets.requesterContactId, submittedBy: tickets.submittedBy })
      .from(tickets)
      .where(eq(tickets.id, ticket.id as string))
      .limit(1);

    // Persisted through the real same-org composite FK.
    expect(row!.requesterContactId).toBe(resolved.contactId);
    // A login is minted only where portal access is granted — the add-in grants none.
    expect(row!.submittedBy).toBeNull();

    const logins = await admin().select({ id: portalUsers.id })
      .from(portalUsers).where(eq(portalUsers.orgId, fx.orgId));
    expect(logins).toHaveLength(0);

    const made = await contactsFor(fx.orgId, email);
    expect(made).toHaveLength(1);
    // A technician-confirmed action, so the CONTACT records who confirmed it —
    // not a null system actor.
    const [audit] = await admin()
      .select({ createdBy: contacts.createdBy, roles: contacts.roles })
      .from(contacts).where(eq(contacts.id, made[0]!.id)).limit(1);
    expect(audit!.createdBy).toBe(fx.userId);
    // And it grants nothing: the add-in hands out no portal access.
    expect(audit!.roles).toEqual([]);
  });

  it('does not mutate an existing contact\'s roles', async () => {
    const email = `billing.${randomUUID().slice(0, 8)}@${fx.domain}`;
    const [existing] = await admin()
      .insert(contacts)
      .values({ orgId: fx.orgId, email, name: 'AP', roles: ['billing'] })
      .returning({ id: contacts.id });

    const resolved = await techContext(() =>
      resolveConfirmedContact(fx.orgId, { email, name: 'AP' }, { userId: fx.userId }),
    );

    expect(resolved).toEqual({ contactId: existing!.id, outcome: 'linked' });
    const [after] = await admin()
      .select({ roles: contacts.roles }).from(contacts).where(eq(contacts.id, existing!.id)).limit(1);
    // `tickets:write` is not licence to edit the customer's contact record.
    expect(after!.roles).toEqual(['billing']);
  });

  it('reuses the contact inbound email already made for that sender', async () => {
    const email = `repeat.${randomUUID().slice(0, 8)}@${fx.domain}`;
    const [fromEmail] = await admin()
      .insert(contacts)
      .values({ orgId: fx.orgId, email, name: 'Repeat Sender', roles: [] })
      .returning({ id: contacts.id });

    const resolved = await techContext(() =>
      resolveConfirmedContact(fx.orgId, { email, name: 'Repeat Sender' }, { userId: fx.userId }),
    );

    // One person, one row — the whole point of moving off portal_users.
    expect(resolved).toEqual({ contactId: fromEmail!.id, outcome: 'linked' });
    expect(await contactsFor(fx.orgId, email)).toHaveLength(1);
  });
});

describe('linkLoginToContact tenancy', () => {
  it('never links across orgs, even when the SAME address exists in another tenant', async () => {
    const email = `shared.${randomUUID().slice(0, 8)}@${fx.domain}`;
    const otherOrg = await createOrganization({ partnerId: fx.partnerId, name: `Other ${randomUUID().slice(0, 8)}` });
    seeded.orgIds.push(otherOrg.id);
    const [foreign] = await admin()
      .insert(contacts)
      .values({ orgId: otherOrg.id, email, name: 'Same Address, Other Tenant', roles: [] })
      .returning({ id: contacts.id });

    const resolved = await withSystemDbAccessContext(() =>
      linkLoginToContact(admin(), { orgId: fx.orgId, email, name: null, actor: { userId: null } }),
    );

    // A fresh contact in the LOGIN's org — the foreign row is invisible to the
    // lookup, which is what keeps the same-org composite FK satisfiable.
    expect(resolved.outcome).toBe('created');
    expect(resolved.contactId).not.toBe(foreign!.id);
    const own = await contactsFor(fx.orgId, email);
    expect(own).toHaveLength(1);
    expect(own[0]!.id).toBe(resolved.contactId);
  });
});
