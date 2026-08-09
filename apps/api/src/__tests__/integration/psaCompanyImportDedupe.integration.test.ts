/**
 * Cross-source dedupe for PSA company import (#3246).
 *
 * The whole point of keying `organization_external_links.system` on the PROVIDER
 * SLUG rather than the connection id: an organization linked as
 * `('connectwise', 'CW-1')` by ANY source — a CSV upload, the migration
 * toolkit, an earlier PSA connection that was deleted and recreated — must be
 * recognised by a later PSA import instead of being created a second time.
 *
 * Needs a real database (the seam does live SQL against organizations and
 * organization_external_links), so it runs under the integration Vitest config
 * only. There is no Postgres in the authoring sandbox; CI is the gate.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { organizationExternalLinks, organizations } from '../../db/schema';
import { commitOrgImport, previewOrgImport } from '../../services/orgImport';
import { createPsaCompanyImportSource } from '../../services/psa/companyImport';
import { createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const actor = { userId: null };

/** A PSA adapter stub returning a fixed company list. */
function fakeClient(companies: Array<{ id: string; name: string; externalId?: string }>, truncated = false) {
  return {
    getCompanies: async (options?: { skipExternalIds?: ReadonlySet<string> }) => {
      const skip = options?.skipExternalIds;
      const kept = skip ? companies.filter((c) => !skip.has(c.externalId ?? c.id)) : companies;
      return {
        companies: kept,
        truncated,
        alreadyLinked: companies.length - kept.length,
        malformed: 0,
      };
    },
  };
}

describe('PSA company import — cross-source dedupe', () => {
  runDb('matches an org linked by a CSV import under the same provider slug', async () => {
    const partner = await withSystemDbAccessContext(() => createPartner());

    // 1. A CSV import creates the org AND the link ('connectwise', 'CW-1').
    const csvSummary = await commitOrgImport(
      [{ organization: 'Acme Ltd', externalId: 'CW-1', externalSystem: 'connectwise' }],
      partner.id,
      actor,
      'skip'
    );
    expect(csvSummary.errors).toEqual([]);
    expect(csvSummary.imported).toHaveLength(1);
    const orgId = csvSummary.imported[0]!.organizationId;
    expect(csvSummary.imported[0]!.createdLink).toBe(true);

    // 2. The PSA now reports that same company (different display name — the
    //    link, not the name, is what must resolve it).
    const source = createPsaCompanyImportSource({
      provider: 'connectwise',
      client: fakeClient([{ id: 'CW-1', name: 'Acme Limited (renamed in PSA)' }]),
    });
    const { rows } = await source.listCompanies({ partnerId: partner.id });
    const annotated = await previewOrgImport(rows, partner.id);

    expect(annotated).toHaveLength(1);
    expect(annotated[0]!.annotation).toBe('link-match');
    expect(annotated[0]!.matchedBy).toBe('link');
    expect(annotated[0]!.organizationId).toBe(orgId);

    // 3. Committing it must NOT create a second organization or a second link.
    const psaSummary = await commitOrgImport(
      rows.map((r) => ({ ...r, expectedAnnotation: 'link-match' as const, expectedOrganizationId: orgId })),
      partner.id,
      actor,
      'skip'
    );
    expect(psaSummary.errors).toEqual([]);

    const orgRows = await withSystemDbAccessContext(() =>
      db.select({ id: organizations.id }).from(organizations).where(eq(organizations.partnerId, partner.id))
    );
    expect(orgRows).toHaveLength(1);

    const linkRows = await withSystemDbAccessContext(() =>
      db
        .select({ id: organizationExternalLinks.id })
        .from(organizationExternalLinks)
        .where(
          and(
            eq(organizationExternalLinks.partnerId, partner.id),
            eq(organizationExternalLinks.system, 'connectwise')
          )
        )
    );
    expect(linkRows).toHaveLength(1);
  });

  runDb('does NOT cross-match a different provider using the same company id', async () => {
    const partner = await withSystemDbAccessContext(() => createPartner());

    await commitOrgImport(
      [{ organization: 'Acme Ltd', externalId: '42', externalSystem: 'connectwise' }],
      partner.id,
      actor,
      'skip'
    );

    // Same external id, different PSA. The (partner, system, external_id) key
    // must keep these apart — id "42" means nothing across vendors.
    const source = createPsaCompanyImportSource({
      provider: 'zendesk',
      client: fakeClient([{ id: '42', name: 'Totally Different Co' }]),
    });
    const { rows } = await source.listCompanies({ partnerId: partner.id });
    const annotated = await previewOrgImport(rows, partner.id);

    expect(annotated[0]!.annotation).toBe('create');
    expect(annotated[0]!.matchedBy).toBeUndefined();
  });

  runDb('falls back to an advisory name-match for an unlinked org', async () => {
    const partner = await withSystemDbAccessContext(() => createPartner());

    // An org that exists but was never linked to any external system.
    await commitOrgImport([{ organization: 'Globex' }], partner.id, actor, 'skip');

    const source = createPsaCompanyImportSource({
      provider: 'connectwise',
      client: fakeClient([{ id: 'CW-99', name: 'globex' }]), // case-insensitive
    });
    const { rows } = await source.listCompanies({ partnerId: partner.id });
    const annotated = await previewOrgImport(rows, partner.id);

    // Advisory only — commit refuses it without an explicit acknowledgement,
    // which is what stops a PSA import silently absorbing an unrelated tenant.
    expect(annotated[0]!.annotation).toBe('name-match');
    expect(annotated[0]!.matchedBy).toBe('name');
  });

  runDb('links a brand-new PSA company on first import', async () => {
    const partner = await withSystemDbAccessContext(() => createPartner());

    const source = createPsaCompanyImportSource({
      provider: 'servicenow',
      client: fakeClient([{ id: 'sys-1', name: 'Initech' }]),
    });
    const { rows } = await source.listCompanies({ partnerId: partner.id });

    const annotated = await previewOrgImport(rows, partner.id);
    expect(annotated[0]!.annotation).toBe('create');

    const summary = await commitOrgImport(
      rows.map((r) => ({ ...r, expectedAnnotation: 'create' as const })),
      partner.id,
      actor,
      'skip'
    );
    expect(summary.errors).toEqual([]);
    expect(summary.imported[0]!.createdLink).toBe(true);

    // A second run of the SAME import is now a link-match, not a duplicate.
    const second = await previewOrgImport(rows, partner.id);
    expect(second[0]!.annotation).toBe('link-match');
    expect(second[0]!.matchedBy).toBe('link');
  });
});
