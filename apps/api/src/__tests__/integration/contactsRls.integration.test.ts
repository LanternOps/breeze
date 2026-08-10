/**
 * Real-driver forge + constraint-behaviour proof for `contacts` /
 * `contact_external_links` (issue #3258, epic #3249 Phase 3).
 *
 * Migration under test: 2026-08-19-contacts.sql
 *
 * Both tables are RLS shape #1 (direct `org_id` + `breeze_has_org_access`),
 * so `rls-coverage.integration.test.ts` auto-discovers them and proves *a*
 * policy exists. That is a schema assertion, not a behavioural one: it cannot
 * prove the site pin can't cross a tenant boundary, that the partial unique
 * indexes have the predicates their names imply, or that the link key is
 * org-scoped rather than partner-scoped. This suite is the functional proof,
 * run through the real postgres.js driver as the unprivileged `breeze_app`
 * role (rolbypassrls = false; see setup.ts), so the assertions are NOT
 * vacuous.
 *
 * Pattern (try/catch placement, orgCtx, cause unwrapping) follows
 * deviceRecoveryKeys-rls.integration.test.ts.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { contactExternalLinks, contacts } from '../../db/schema/contacts';
import { sites } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgCtx(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    currentPartnerId: null,
  };
}

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Two orgs under ONE partner. Same-partner is the strictest arrangement for
 * the link-key test below: if the unique index were partner-scoped (the shape
 * `organization_external_links` uses) these two orgs would collide.
 */
async function seed() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const siteA = await createSite({ orgId: orgA.id });
    const siteB = await createSite({ orgId: orgB.id });
    return { partner, orgA, orgB, siteA, siteB };
  });
}

/**
 * Captures the driver error for a statement expected to fail.
 *
 * The try/catch MUST wrap `withDbAccessContext` itself rather than sit inside
 * its callback: Postgres aborts the whole transaction the instant a statement
 * fails, so postgres.js's `client.begin()` wrapper rejects the outer promise
 * on commit even if the callback swallowed the error locally.
 */
async function expectRejection(fn: () => Promise<unknown>) {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught, 'statement was expected to be rejected but succeeded').toBeDefined();
  return (caught as { cause?: { message?: string; code?: string; constraint_name?: string } })
    ?.cause;
}

describe('contacts / contact_external_links — RLS forge (breeze_app role)', () => {
  runDb('same-org insert succeeds; cross-org forge is rejected with 42501', async () => {
    const { orgA, orgB } = await seed();

    const inserted = await withDbAccessContext(orgCtx(orgA.id), async () => {
      const [row] = await db
        .insert(contacts)
        .values({ orgId: orgA.id, name: `Legit ${unique()}`, email: 'legit@example.test' })
        .returning({ id: contacts.id, orgId: contacts.orgId, roles: contacts.roles });
      return row;
    });
    expect(inserted?.orgId).toBe(orgA.id);
    // `roles text[] NOT NULL DEFAULT '{}'` — the default the drift check cares about.
    expect(inserted?.roles).toEqual([]);

    // Org B forging a row into org A.
    const cause = await expectRejection(() =>
      withDbAccessContext(orgCtx(orgB.id), () =>
        db.insert(contacts).values({ orgId: orgA.id, name: 'Forged', email: 'forge@example.test' })
      )
    );
    expect(cause?.code).toBe('42501');
    expect(cause?.message).toMatch(
      /new row violates row-level security policy for table "contacts"/
    );

    // Org B cannot read org A's contact.
    const visibleToB = await withDbAccessContext(orgCtx(orgB.id), () =>
      db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, inserted!.id))
    );
    expect(visibleToB).toHaveLength(0);

    // Org B cannot delete it either (DELETE policy, not just SELECT).
    const deleted = await withDbAccessContext(orgCtx(orgB.id), () =>
      db.delete(contacts).where(eq(contacts.id, inserted!.id)).returning({ id: contacts.id })
    );
    expect(deleted).toHaveLength(0);

    // ...and the child table's policy holds independently.
    const linkCause = await expectRejection(() =>
      withDbAccessContext(orgCtx(orgB.id), () =>
        db.insert(contactExternalLinks).values({
          contactId: inserted!.id,
          orgId: orgA.id,
          system: 'psa',
          externalId: `forged-${unique()}`,
        })
      )
    );
    expect(linkCause?.code).toBe('42501');
    expect(linkCause?.message).toMatch(
      /new row violates row-level security policy for table "contact_external_links"/
    );
  });
});

describe('contacts — constraint behaviour', () => {
  runDb('contacts_site_org_fk makes a cross-org site pin unrepresentable', async () => {
    const { orgA, siteA, siteB } = await seed();

    // Same-org pin is fine.
    const pinned = await withDbAccessContext(orgCtx(orgA.id), async () => {
      const [row] = await db
        .insert(contacts)
        .values({ orgId: orgA.id, siteId: siteA.id, name: `Site contact ${unique()}` })
        .returning({ id: contacts.id });
      return row;
    });
    expect(pinned?.id).toBeDefined();

    // Cross-org pin: org_id passes the RLS predicate, the composite FK does not.
    // Referential-integrity checks run with row security disabled, so org B's
    // site is visible to the check — the tuple (siteB, orgA) simply does not
    // exist in `sites`.
    const cause = await expectRejection(() =>
      withDbAccessContext(orgCtx(orgA.id), () =>
        db.insert(contacts).values({ orgId: orgA.id, siteId: siteB.id, name: 'Cross-org pin' })
      )
    );
    expect(cause?.code).toBe('23503');
    expect(cause?.message).toMatch(/contacts_site_org_fk/);

    // Documented consequence of ON DELETE CASCADE (a composite SET NULL would
    // null org_id, which is NOT NULL): deleting a site deletes its pinned
    // contacts rather than orphaning them at org level.
    await withSystemDbAccessContext(() => db.delete(sites).where(eq(sites.id, siteA.id)));
    const survivors = await withSystemDbAccessContext(() =>
      db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, pinned!.id))
    );
    expect(survivors).toHaveLength(0);
  });

  runDb('primary uniqueness is per-org and per-site, not global', async () => {
    const { orgA, orgB, siteA } = await seed();

    const orgPrimary = await withDbAccessContext(orgCtx(orgA.id), async () => {
      const [row] = await db
        .insert(contacts)
        .values({ orgId: orgA.id, name: 'Org primary', isPrimary: true })
        .returning({ id: contacts.id });
      return row;
    });
    expect(orgPrimary?.id).toBeDefined();

    // Second org-level primary in the same org — rejected.
    const orgDup = await expectRejection(() =>
      withDbAccessContext(orgCtx(orgA.id), () =>
        db.insert(contacts).values({ orgId: orgA.id, name: 'Second org primary', isPrimary: true })
      )
    );
    expect(orgDup?.code).toBe('23505');
    expect(orgDup?.message).toMatch(/contacts_org_primary_uniq/);

    // A SITE-level primary in the same org is legal — this is what proves the
    // index predicate is `is_primary AND site_id IS NULL` rather than a plain
    // `is_primary` partial index.
    const sitePrimary = await withDbAccessContext(orgCtx(orgA.id), async () => {
      const [row] = await db
        .insert(contacts)
        .values({ orgId: orgA.id, siteId: siteA.id, name: 'Site primary', isPrimary: true })
        .returning({ id: contacts.id });
      return row;
    });
    expect(sitePrimary?.id).toBeDefined();

    // Second primary on the SAME site — rejected by the site index.
    const siteDup = await expectRejection(() =>
      withDbAccessContext(orgCtx(orgA.id), () =>
        db.insert(contacts).values({
          orgId: orgA.id,
          siteId: siteA.id,
          name: 'Second site primary',
          isPrimary: true,
        })
      )
    );
    expect(siteDup?.code).toBe('23505');
    expect(siteDup?.message).toMatch(/contacts_site_primary_uniq/);

    // Non-primary contacts are unconstrained (the index is partial).
    const extras = await withDbAccessContext(orgCtx(orgA.id), () =>
      db
        .insert(contacts)
        .values([
          { orgId: orgA.id, name: 'Regular one' },
          { orgId: orgA.id, name: 'Regular two' },
        ])
        .returning({ id: contacts.id })
    );
    expect(extras).toHaveLength(2);

    // Another org may have its own org-level primary.
    const otherOrgPrimary = await withDbAccessContext(orgCtx(orgB.id), async () => {
      const [row] = await db
        .insert(contacts)
        .values({ orgId: orgB.id, name: 'Org B primary', isPrimary: true })
        .returning({ id: contacts.id });
      return row;
    });
    expect(otherOrgPrimary?.id).toBeDefined();
  });

  runDb('contacts_identifiable_chk rejects a wholly unidentifiable row', async () => {
    const { orgA } = await seed();

    const cause = await expectRejection(() =>
      withDbAccessContext(orgCtx(orgA.id), () =>
        db.insert(contacts).values({
          orgId: orgA.id,
          name: null,
          email: null,
          phone: null,
          mobile: null,
          title: 'Head of Nothing',
        })
      )
    );
    expect(cause?.code).toBe('23514');
    expect(cause?.message).toMatch(/contacts_identifiable_chk/);

    // Each identifying column on its own is sufficient — the constraint is a
    // disjunction, and name-less contacts are a supported shape (inbound email
    // and `{"email": "ap@acme.com"}` billing blobs both produce them).
    for (const values of [
      { name: 'Name only' },
      { email: 'email-only@example.test' },
      { phone: '+1-555-0100' },
      { mobile: '+1-555-0199' },
    ]) {
      const [row] = await withDbAccessContext(orgCtx(orgA.id), () =>
        db
          .insert(contacts)
          .values({ orgId: orgA.id, ...values })
          .returning({ id: contacts.id })
      );
      expect(row?.id, `insert with ${Object.keys(values)[0]} only should succeed`).toBeDefined();
    }
  });
});

describe('contact_external_links — org-scoped re-import key', () => {
  runDb('the same source id may exist in two orgs of one partner, but not twice in one', async () => {
    const { orgA, orgB } = await seed();
    const externalId = `psa-person-${unique()}`;

    const contactA = await withDbAccessContext(orgCtx(orgA.id), async () => {
      const [row] = await db
        .insert(contacts)
        .values({ orgId: orgA.id, name: 'Shared person', email: 'shared@example.test' })
        .returning({ id: contacts.id });
      return row;
    });
    const contactB = await withDbAccessContext(orgCtx(orgB.id), async () => {
      const [row] = await db
        .insert(contacts)
        .values({ orgId: orgB.id, name: 'Shared person', email: 'shared@example.test' })
        .returning({ id: contacts.id });
      return row;
    });

    const linkA = await withDbAccessContext(orgCtx(orgA.id), async () => {
      const [row] = await db
        .insert(contactExternalLinks)
        .values({ contactId: contactA!.id, orgId: orgA.id, system: 'psa', externalId })
        .returning({ id: contactExternalLinks.id });
      return row;
    });
    expect(linkA?.id).toBeDefined();

    // The deliberate divergence from `organization_external_links`' PARTNER-
    // scoped key: one person legitimately works for two of an MSP's customers,
    // so the SAME source id must be linkable again under the other org. A
    // partner-scoped index would reject this insert.
    const linkB = await withDbAccessContext(orgCtx(orgB.id), async () => {
      const [row] = await db
        .insert(contactExternalLinks)
        .values({ contactId: contactB!.id, orgId: orgB.id, system: 'psa', externalId })
        .returning({ id: contactExternalLinks.id });
      return row;
    });
    expect(linkB?.id).toBeDefined();

    // Within one org the key is unique — this is what makes re-import
    // idempotent.
    const dup = await expectRejection(() =>
      withDbAccessContext(orgCtx(orgA.id), () =>
        db
          .insert(contactExternalLinks)
          .values({ contactId: contactA!.id, orgId: orgA.id, system: 'psa', externalId })
      )
    );
    expect(dup?.code).toBe('23505');
    expect(dup?.message).toMatch(/contact_external_links_uniq/);

    // A different source system reusing the same id is a different identity.
    const otherSystem = await withDbAccessContext(orgCtx(orgA.id), async () => {
      const [row] = await db
        .insert(contactExternalLinks)
        .values({ contactId: contactA!.id, orgId: orgA.id, system: 'm365', externalId })
        .returning({ id: contactExternalLinks.id });
      return row;
    });
    expect(otherSystem?.id).toBeDefined();

    // Deleting the contact takes its links with it (composite FK CASCADE).
    await withDbAccessContext(orgCtx(orgA.id), () =>
      db.delete(contacts).where(eq(contacts.id, contactA!.id))
    );
    const orphans = await withSystemDbAccessContext(() =>
      db
        .select({ id: contactExternalLinks.id })
        .from(contactExternalLinks)
        .where(
          and(
            eq(contactExternalLinks.orgId, orgA.id),
            eq(contactExternalLinks.externalId, externalId)
          )
        )
    );
    expect(orphans).toHaveLength(0);
  });
});
