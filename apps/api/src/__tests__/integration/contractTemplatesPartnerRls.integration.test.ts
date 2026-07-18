/**
 * Functional cross-tenant RLS forge tests for the contract template library +
 * executed contract documents (Task 6, spec 2026-07-16).
 *
 * Migration under test: 2026-07-16-contract-documents.sql.
 *
 * contract_templates / contract_template_versions are dual-axis (org OR
 * partner) per epic #2135 — a template/version is owned by EITHER an org
 * (org_id set, partner_id NULL) OR a partner (partner_id set, org_id NULL —
 * "all orgs"), enforced by the `*_one_owner_chk` CHECK and a single combined
 * policy: system OR (org_id IS NOT NULL AND breeze_has_org_access(org_id)) OR
 * (partner_id IS NOT NULL AND breeze_has_partner_access(partner_id)).
 *
 * Same blindspot as configuration_policies / software_policies: the
 * rls-coverage contract test only proves the policies EXIST in pg_catalog and
 * accepts an org-only row — it does NOT prove a real cross-partner insert is
 * rejected at runtime. This file is the behavioral guard, run as the
 * unprivileged `breeze_app` role (rolbypassrls=f) so RLS is actually enforced.
 *
 * contract_documents is org-only shape-1 (direct org_id NOT NULL, four
 * per-command `breeze_org_isolation_*` policies) — mirrors quotes.sql /
 * invoiceDocuments.sql. Its `contractTemplatesPartnerRls` coverage lives here
 * (rather than a separate file) because every fixture it needs — an org's own
 * template + published version — already exists in this file's fixture
 * bootstrap.
 *
 * No memoization: each test reseeds fresh via `seedFixture()`.
 * integration/setup.ts TRUNCATE CASCADEs partners/organizations in a
 * beforeEach, so a module-level fixture cache would hand later tests rows
 * that no longer exist — making cross-tenant assertions vacuous (see repo
 * memory: rls-forge-test-memoized-fixture-vacuous.md).
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { contractTemplates, contractTemplateVersions, contractDocuments } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
  };
}

interface TemplateFixture {
  partnerA: { id: string };
  orgA: { id: string };
  partnerB: { id: string };
  orgB: { id: string };
  /** A partner-wide template owned by partnerA (org_id NULL, partner_id set). */
  templateA: { id: string };
  /** A published version of templateA, also owned by partnerA. */
  versionA: { id: string };
  orgAContext: DbAccessContext;
  orgBContext: DbAccessContext;
}

// Re-seeds fresh on every call — see file header on why this is NOT memoized.
async function seedFixture(): Promise<TemplateFixture> {
  return withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });

    const [templateA] = await db
      .insert(contractTemplates)
      .values({ orgId: null, partnerId: partnerA.id, name: 'Partner-wide MSA' })
      .returning({ id: contractTemplates.id });
    if (!templateA) throw new Error('failed to seed partnerA template');

    const [versionA] = await db
      .insert(contractTemplateVersions)
      .values({
        templateId: templateA.id,
        orgId: null,
        partnerId: partnerA.id,
        versionNumber: 1,
        sourceType: 'authored',
        bodyHtml: '<p>Terms</p>',
      })
      .returning({ id: contractTemplateVersions.id });
    if (!versionA) throw new Error('failed to seed partnerA template version');

    return {
      partnerA: { id: partnerA.id },
      orgA: { id: orgA.id },
      partnerB: { id: partnerB.id },
      orgB: { id: orgB.id },
      templateA: { id: templateA.id },
      versionA: { id: versionA.id },
      orgAContext: orgContext(orgA.id),
      orgBContext: orgContext(orgB.id),
    };
  });
}

describe('contract_templates RLS — dual-axis (2026-07-16 migration)', () => {
  it('partner scope can INSERT and SELECT a partner-wide template', async () => {
    const fx = await seedFixture();

    const visible = await withDbAccessContext(partnerContext(fx.partnerA.id, []), () =>
      db
        .select({ id: contractTemplates.id })
        .from(contractTemplates)
        .where(eq(contractTemplates.id, fx.templateA.id)),
    );
    expect(visible.map((r) => r.id)).toContain(fx.templateA.id);
  });

  it('a different partner can neither see nor forge a template attributed to the first partner (42501)', async () => {
    const fx = await seedFixture();

    const visibleToB = await withDbAccessContext(partnerContext(fx.partnerB.id, []), () =>
      db
        .select({ id: contractTemplates.id })
        .from(contractTemplates)
        .where(eq(contractTemplates.id, fx.templateA.id)),
    );
    expect(visibleToB).toEqual([]);

    // WITH CHECK denies the cross-partner forge. Drizzle wraps the driver
    // error, so the RLS signal is Postgres code 42501 on the cause.
    await expect(
      withDbAccessContext(partnerContext(fx.partnerB.id, []), () =>
        db
          .insert(contractTemplates)
          .values({ orgId: null, partnerId: fx.partnerA.id, name: 'Forged partner-wide template' })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('org scope can INSERT and SELECT an org-scoped template (unchanged shape-1 form)', async () => {
    const fx = await seedFixture();

    const inserted = await withDbAccessContext(fx.orgAContext, () =>
      db
        .insert(contractTemplates)
        .values({ orgId: fx.orgA.id, partnerId: null, name: 'Org MSA' })
        .returning(),
    );
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.orgId).toBe(fx.orgA.id);

    const visible = await withDbAccessContext(fx.orgAContext, () =>
      db
        .select({ id: contractTemplates.id })
        .from(contractTemplates)
        .where(eq(contractTemplates.id, inserted[0]!.id)),
    );
    expect(visible.map((r) => r.id)).toContain(inserted[0]?.id);
  });

  it('an org-scope caller cannot see a partner-wide template owned by its own partner', async () => {
    // Org scope is intentionally narrower than partner scope: partner-wide
    // templates belong to the partner axis, which org-scope tokens don't hold.
    const fx = await seedFixture();

    const visibleToOrg = await withDbAccessContext(fx.orgAContext, () =>
      db
        .select({ id: contractTemplates.id })
        .from(contractTemplates)
        .where(eq(contractTemplates.id, fx.templateA.id)),
    );
    expect(visibleToOrg).toEqual([]);
  });

  it('the one-owner CHECK rejects a template row that sets BOTH axes and one that sets NEITHER (23514)', async () => {
    const fx = await seedFixture();

    await expect(
      withSystemDbAccessContext(() =>
        db
          .insert(contractTemplates)
          .values({ orgId: fx.orgA.id, partnerId: fx.partnerA.id, name: 'Both axes' })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });

    await expect(
      withSystemDbAccessContext(() =>
        db.insert(contractTemplates).values({ orgId: null, partnerId: null, name: 'No axis' }).returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });
});

describe('contract_template_versions RLS — dual-axis (2026-07-16 migration)', () => {
  it('a different partner can neither see nor forge a version row attributed to the first partner (42501)', async () => {
    const fx = await seedFixture();

    const visibleToB = await withDbAccessContext(partnerContext(fx.partnerB.id, []), () =>
      db
        .select({ id: contractTemplateVersions.id })
        .from(contractTemplateVersions)
        .where(eq(contractTemplateVersions.id, fx.versionA.id)),
    );
    expect(visibleToB).toEqual([]);

    await expect(
      withDbAccessContext(partnerContext(fx.partnerB.id, []), () =>
        db
          .insert(contractTemplateVersions)
          .values({
            templateId: fx.templateA.id, // partnerA's real template (FK resolves)
            orgId: null,
            partnerId: fx.partnerA.id, // foreign partner — RLS WITH CHECK must reject
            versionNumber: 2,
            sourceType: 'authored',
            bodyHtml: '<p>Forged version</p>',
          })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('an org-scope caller cannot see a partner-wide version owned by its own partner', async () => {
    const fx = await seedFixture();

    const visibleToOrg = await withDbAccessContext(fx.orgAContext, () =>
      db
        .select({ id: contractTemplateVersions.id })
        .from(contractTemplateVersions)
        .where(eq(contractTemplateVersions.id, fx.versionA.id)),
    );
    expect(visibleToOrg).toEqual([]);
  });

  it('the one-owner CHECK rejects a version row that sets BOTH axes and one that sets NEITHER (23514)', async () => {
    const fx = await seedFixture();

    await expect(
      withSystemDbAccessContext(() =>
        db
          .insert(contractTemplateVersions)
          .values({
            templateId: fx.templateA.id,
            orgId: fx.orgA.id,
            partnerId: fx.partnerA.id,
            versionNumber: 3,
            sourceType: 'authored',
            bodyHtml: '<p>Both axes</p>',
          })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });

    await expect(
      withSystemDbAccessContext(() =>
        db
          .insert(contractTemplateVersions)
          .values({
            templateId: fx.templateA.id,
            orgId: null,
            partnerId: null,
            versionNumber: 4,
            sourceType: 'authored',
            bodyHtml: '<p>No axis</p>',
          })
          .returning(),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });
});

describe('contract_documents RLS — org-only shape-1 (2026-07-16 migration)', () => {
  // Own fixture: contract_documents needs an org-owned template + published
  // version to satisfy its NOT NULL RESTRICT FKs, distinct per org so the
  // cross-org forge/hidden-read cases reference real (FK-resolving) rows.
  async function seedDocumentFixture() {
    const fx = await seedFixture();

    return withSystemDbAccessContext(async () => {
      const [templateOrgA] = await db
        .insert(contractTemplates)
        .values({ orgId: fx.orgA.id, partnerId: null, name: 'OrgA template' })
        .returning({ id: contractTemplates.id });
      const [versionOrgA] = await db
        .insert(contractTemplateVersions)
        .values({
          templateId: templateOrgA!.id,
          orgId: fx.orgA.id,
          partnerId: null,
          versionNumber: 1,
          sourceType: 'authored',
          bodyHtml: '<p>OrgA terms</p>',
        })
        .returning({ id: contractTemplateVersions.id });

      const [templateOrgB] = await db
        .insert(contractTemplates)
        .values({ orgId: fx.orgB.id, partnerId: null, name: 'OrgB template' })
        .returning({ id: contractTemplates.id });
      const [versionOrgB] = await db
        .insert(contractTemplateVersions)
        .values({
          templateId: templateOrgB!.id,
          orgId: fx.orgB.id,
          partnerId: null,
          versionNumber: 1,
          sourceType: 'authored',
          bodyHtml: '<p>OrgB terms</p>',
        })
        .returning({ id: contractTemplateVersions.id });

      const [documentOrgB] = await db
        .insert(contractDocuments)
        .values({
          orgId: fx.orgB.id,
          templateId: templateOrgB!.id,
          templateVersionId: versionOrgB!.id,
          pdfData: Buffer.from('orgB pdf bytes'),
          byteSize: 14,
          sha256: 'b'.repeat(64),
        })
        .returning({ id: contractDocuments.id });

      return {
        ...fx,
        templateOrgA: { id: templateOrgA!.id },
        versionOrgA: { id: versionOrgA!.id },
        templateOrgB: { id: templateOrgB!.id },
        versionOrgB: { id: versionOrgB!.id },
        documentOrgB: { id: documentOrgB!.id },
      };
    });
  }

  it('blocks a forged cross-org contract_documents INSERT for another org (42501)', async () => {
    const fx = await seedDocumentFixture();

    await expect(
      withDbAccessContext(fx.orgAContext, () =>
        db.insert(contractDocuments).values({
          orgId: fx.orgB.id, // foreign org — RLS WITH CHECK must reject
          templateId: fx.templateOrgB.id, // orgB's real template (FK resolves)
          templateVersionId: fx.versionOrgB.id, // orgB's real version (FK resolves)
          pdfData: Buffer.from('forged pdf bytes'),
          byteSize: 17,
          sha256: 'a'.repeat(64),
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('hides another org contract_documents from SELECT (system probe confirms it exists)', async () => {
    const fx = await seedDocumentFixture();

    const existsUnderSystem = await withSystemDbAccessContext(() =>
      db.select({ id: contractDocuments.id }).from(contractDocuments).where(eq(contractDocuments.id, fx.documentOrgB.id)),
    );
    expect(existsUnderSystem).toHaveLength(1);

    const visibleToA = await withDbAccessContext(fx.orgAContext, () =>
      db.select({ id: contractDocuments.id }).from(contractDocuments).where(eq(contractDocuments.id, fx.documentOrgB.id)),
    );
    expect(visibleToA).toHaveLength(0);
  });

  it('allows inserting + selecting a contract_documents row within the caller org', async () => {
    const fx = await seedDocumentFixture();

    const inserted = await withDbAccessContext(fx.orgAContext, () =>
      db
        .insert(contractDocuments)
        .values({
          orgId: fx.orgA.id,
          templateId: fx.templateOrgA.id,
          templateVersionId: fx.versionOrgA.id,
          pdfData: Buffer.from('orgA pdf bytes'),
          byteSize: 14,
          sha256: 'c'.repeat(64),
        })
        .returning({ id: contractDocuments.id, orgId: contractDocuments.orgId }),
    );
    expect(inserted[0]?.orgId).toBe(fx.orgA.id);

    const visible = await withDbAccessContext(fx.orgAContext, () =>
      db.select({ id: contractDocuments.id }).from(contractDocuments).where(eq(contractDocuments.id, inserted[0]!.id)),
    );
    expect(visible).toHaveLength(1);
  });
});
