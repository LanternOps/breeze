/**
 * Real-database proof that the contact importer's tenancy bound holds
 * (issue #3258, epic #3249 Phase 3).
 *
 * WHY THIS SUITE EXISTS, given contactsRls.integration.test.ts already forges
 * cross-tenant writes as `breeze_app`: the importer does NOT run as that role.
 * Per-row failure isolation is unachievable inside one transaction (a failed
 * statement aborts it and every later statement raises 25P02), so each row's
 * writes open their own `withSystemDbAccessContext` — where RLS is switched
 * off. The snapshot query is therefore the ONLY thing standing between a
 * caller and another tenant's contacts, and a unit test with a mocked driver
 * can only prove the SQL was built, not that it bounds anything.
 *
 * So this is spec S7's "forge a cross-tenant insert — must fail" applied to
 * the one write path RLS does not cover: instead of forging a statement, it
 * drives the real `commitContactImport` with an out-of-reach organization and
 * asserts that nothing lands.
 *
 * Fixtures, setup and teardown follow contactsRls.integration.test.ts.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { contactExternalLinks, contacts } from '../../db/schema/contacts';
import { commitContactImport, previewContactImport } from '../../services/contacts/import';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const ACTOR = { userId: null };

/**
 * Two organizations under ONE partner. Same-partner is the strict arrangement:
 * a partner-only filter would let org B through, so only the caller's own
 * `accessibleOrgIds` can keep it out.
 */
async function seed() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id, name: `Reachable ${Date.now()}` });
    const orgB = await createOrganization({ partnerId: partner.id, name: `Unreachable ${Date.now()}` });
    return { partner, orgA, orgB };
  });
}

function readContacts(orgIds: string[]) {
  return withSystemDbAccessContext(() =>
    db.select({ id: contacts.id, orgId: contacts.orgId, name: contacts.name, email: contacts.email })
      .from(contacts)
      .where(inArray(contacts.orgId, orgIds)));
}

function readLinks(orgId: string) {
  return withSystemDbAccessContext(() =>
    db.select({ id: contactExternalLinks.id })
      .from(contactExternalLinks)
      .where(eq(contactExternalLinks.orgId, orgId)));
}

describe('contact import — organization reach bound (system-context writes)', () => {
  runDb('refuses rows targeting an organization outside the caller reach, by id AND by name', async () => {
    const { partner, orgA, orgB } = await seed();

    const summary = await commitContactImport(
      [
        { organizationId: orgB.id, name: 'By Id', email: 'byid@example.test', externalId: 'CT-B1' },
        { organization: orgB.name, name: 'By Name', email: 'byname@example.test', externalId: 'CT-B2' },
      ],
      { partnerId: partner.id, accessibleOrgIds: [orgA.id] },
      ACTOR,
    );

    expect(summary.errors.map((e) => e.code)).toEqual(['org-not-found', 'org-not-found']);
    expect(summary.imported).toEqual([]);
    expect(summary.updated).toEqual([]);
    expect(summary.skipped).toEqual([]);

    // The bound is the write, not just the annotation.
    expect(await readContacts([orgB.id])).toEqual([]);
    expect(await readLinks(orgB.id)).toEqual([]);
  });

  runDb('the org name of an unreachable tenant is not an existence oracle', async () => {
    const { partner, orgA, orgB } = await seed();

    const [known] = await previewContactImport(
      [{ organization: orgB.name, name: 'By Name' }],
      { partnerId: partner.id, accessibleOrgIds: [orgA.id] },
    );
    const [absent] = await previewContactImport(
      [{ organization: `No Such Org ${Date.now()}`, name: 'By Name' }],
      { partnerId: partner.id, accessibleOrgIds: [orgA.id] },
    );

    // An org that exists but is out of reach must be indistinguishable from
    // one that does not exist at all.
    expect(known!.annotation).toBe('org-not-found');
    expect(absent!.annotation).toBe('org-not-found');
    expect(known!.organizationId).toBeNull();
  });

  runDb('commits the same file for a reachable organization, then skips it on re-import', async () => {
    const { partner, orgA } = await seed();
    const ctx = { partnerId: partner.id, accessibleOrgIds: [orgA.id] };
    const rows = [
      { organizationId: orgA.id, name: 'Jane Ops', email: 'jane@example.test', externalId: 'CT-A1', externalSystem: 'datto_rmm' },
      { organizationId: orgA.id, name: 'Sam Site', phone: '555-0142', externalId: 'CT-A2', externalSystem: 'datto_rmm' },
    ];

    const first = await commitContactImport(rows, ctx, ACTOR);
    expect(first.errors).toEqual([]);
    expect(first.imported).toHaveLength(2);
    expect(first.imported.every((e) => e.createdLink)).toBe(true);

    const stored = await readContacts([orgA.id]);
    expect(stored).toHaveLength(2);
    // An emailless contact round-trips; email is stored lower-cased.
    expect(stored.find((c) => c.name === 'Sam Site')?.email).toBeNull();
    expect(stored.find((c) => c.name === 'Jane Ops')?.email).toBe('jane@example.test');

    // Re-importing the identical file resolves through contact_external_links
    // and writes nothing at all.
    const second = await commitContactImport(rows, ctx, ACTOR);
    expect(second.skipped).toHaveLength(2);
    expect(second.skipped.every((s) => s.reason === 'already_linked')).toBe(true);
    expect(second.imported).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.errors).toEqual([]);
    expect(await readContacts([orgA.id])).toHaveLength(2);
    expect(await readLinks(orgA.id)).toHaveLength(2);
  });

  runDb('one source contact id may exist under two organizations at once', async () => {
    // contact_external_links_uniq is (org_id, system, external_id): the same
    // person working for two of an MSP's customers is two rows, not a conflict.
    const { partner, orgA, orgB } = await seed();
    const ctx = { partnerId: partner.id, accessibleOrgIds: [orgA.id, orgB.id] };

    const summary = await commitContactImport([
      { organizationId: orgA.id, name: 'Jane Ops', externalId: 'CT-SHARED', externalSystem: 'datto_rmm' },
      { organizationId: orgB.id, name: 'Jane Ops', externalId: 'CT-SHARED', externalSystem: 'datto_rmm' },
    ], ctx, ACTOR);

    expect(summary.errors).toEqual([]);
    expect(summary.imported).toHaveLength(2);
    expect(await readLinks(orgA.id)).toHaveLength(1);
    expect(await readLinks(orgB.id)).toHaveLength(1);
  });
});
