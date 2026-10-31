/**
 * Functional RLS forge for partner-scoped built-in deployment packages.
 *
 * Built-in EDR packages live in software_catalog with org_id NULL + partner_id set.
 * The 2026-07-02 migration broadened SELECT so an ORG-scoped caller can read their
 * OWN partner's built-in package + its versions (needed to deploy it), while a
 * different partner's org must NOT see it. The earlier integration tests all ran in
 * a system context (RLS bypassed), so this is the only test that exercises the
 * broadened policy + isolation as the unprivileged breeze_app role.
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { softwareCatalog, softwareInstallMethods, softwareVersions } from '../../db/schema';
import { ensurePinnedBuiltinPackage } from '../../services/builtinDeploymentPackages';
import { createPartner, createOrganization } from './db-utils';

async function seedBuiltin(partnerId: string) {
  return withSystemDbAccessContext(async () => {
    const [cat] = await db.insert(softwareCatalog).values({
      orgId: null,
      partnerId,
      integrationProvider: 'huntress',
      name: 'Huntress EDR Agent',
      vendor: 'Huntress',
      category: 'security',
      isManaged: true,
    }).returning({ id: softwareCatalog.id });
    await db.insert(softwareVersions).values({
      catalogId: cat!.id,
      version: 'latest',
      downloadUrl: 'https://update.huntress.io/download/{huntress_acct_key}/HuntressInstaller.exe',
      fileType: 'exe',
      silentInstallArgs: '/ACCT_KEY="{huntress_acct_key}" /ORG_KEY="{huntress_org_key}" /S',
      isLatest: true,
    });
    return cat!.id;
  });
}

const orgCtx = (orgId: string) => ({
  scope: 'organization' as const,
  orgId,
  accessibleOrgIds: [orgId],
  accessiblePartnerIds: [] as string[],
});

describe('built-in software_catalog RLS (partner-scoped) — forge', () => {
  it('an org member can read their OWN partner\'s built-in package + version', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const catalogId = await seedBuiltin(partner.id);

    const { cats, versions } = await withDbAccessContext(orgCtx(org.id), async () => {
      const cats = await db.select().from(softwareCatalog).where(eq(softwareCatalog.id, catalogId));
      const versions = await db.select().from(softwareVersions).where(eq(softwareVersions.catalogId, catalogId));
      return { cats, versions };
    });

    expect(cats).toHaveLength(1);
    expect(cats[0]!.integrationProvider).toBe('huntress');
    expect(versions).toHaveLength(1);
  });

  it('an org under a DIFFERENT partner cannot see the built-in package or its versions', async () => {
    const partnerA = await createPartner();
    const catalogId = await seedBuiltin(partnerA.id);

    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });

    const { cats, versions } = await withDbAccessContext(orgCtx(orgB.id), async () => {
      const cats = await db.select().from(softwareCatalog).where(eq(softwareCatalog.id, catalogId));
      const versions = await db.select().from(softwareVersions).where(eq(softwareVersions.catalogId, catalogId));
      return { cats, versions };
    });

    expect(cats).toHaveLength(0);
    expect(versions).toHaveLength(0);
  });

  it('an org cannot forge a built-in row for a DIFFERENT partner (cross-tenant write)', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });

    // postgres.js wraps the error; the RLS signal is code 42501 on the cause.
    await expect(
      withDbAccessContext(orgCtx(orgB.id), async () => {
        await db.insert(softwareCatalog).values({
          orgId: null,
          partnerId: partnerA.id, // forging partner A's package from partner B's org
          integrationProvider: 'huntress',
          name: 'forged',
          isManaged: true,
        });
      }),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

// ---------------------------------------------------------------------------
// #6958 PR D / #10036: keyed (builtin_package_key) DNS built-ins. An org-scope
// caller reads its own partner's keyed row through
// software_catalog_partner_wide_select (breeze_current_partner_id()), and
// since #10036 that row's versions and install methods through the matching
// *_builtin_keyed_select policies, keyed on the same GUC. Both new policies
// are FOR SELECT only, so writes stay closed.
// ---------------------------------------------------------------------------
describe('keyed built-in software_catalog RLS (#6958): forge', () => {
  // What a real org-scoped request carries: breeze.current_partner_id is
  // populated for EVERY scope (2026-10-11-000200 partner-wide select).
  const orgScoped = (orgId: string, partnerId: string) => ({
    scope: 'organization' as const,
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [] as string[],
    currentPartnerId: partnerId,
  });
  const partnerScoped = (partnerId: string) => ({
    scope: 'partner' as const,
    orgId: null,
    accessibleOrgIds: [] as string[],
    accessiblePartnerIds: [partnerId],
    currentPartnerId: partnerId,
  });

  async function readAs(ctx: Parameters<typeof withDbAccessContext>[0], catalogId: string) {
    return withDbAccessContext(ctx, async () => {
      const cats = await db.select().from(softwareCatalog).where(eq(softwareCatalog.id, catalogId));
      const versions = await db.select().from(softwareVersions).where(eq(softwareVersions.catalogId, catalogId));
      return { cats, versions };
    });
  }

  it('partner scope reads its own keyed row and its versions', async () => {
    const partner = await createPartner();
    const { catalogId } = await ensurePinnedBuiltinPackage({ key: 'controld_windows', partnerId: partner.id });

    const { cats, versions } = await readAs(partnerScoped(partner.id), catalogId);
    expect(cats).toHaveLength(1);
    expect(cats[0]!.builtinPackageKey).toBe('controld_windows');
    expect(versions).toHaveLength(1);
  });

  it('#10036: org scope under the same partner reads the keyed row AND its versions', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const { catalogId, versionId } = await ensurePinnedBuiltinPackage({ key: 'controld_windows', partnerId: partner.id });

    const { cats, versions } = await readAs(orgScoped(org.id, partner.id), catalogId);
    expect(cats).toHaveLength(1);
    expect(versions.map((v) => v.id)).toEqual([versionId]);
  });

  it('#10036: org scope reads keyed install methods too (child-table read parity)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const { catalogId } = await ensurePinnedBuiltinPackage({ key: 'controld_windows', partnerId: partner.id });
    // The app layer never creates methods on a built-in; seed one directly so
    // the policy itself is exercised.
    await withSystemDbAccessContext(() =>
      db.insert(softwareInstallMethods).values({ catalogId, platform: 'windows', kind: 'winget', packageId: 'ControlD.ctrld' }),
    );
    const methodsAs = (ctx: Parameters<typeof withDbAccessContext>[0]) =>
      withDbAccessContext(ctx, () =>
        db.select().from(softwareInstallMethods).where(eq(softwareInstallMethods.catalogId, catalogId)),
      );

    expect(await methodsAs(orgScoped(org.id, partner.id))).toHaveLength(1);

    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });
    expect(await methodsAs(orgScoped(orgB.id, partnerB.id))).toHaveLength(0);
  });

  it('#10036: the keyed read branch exposes no other tenant\'s private versions', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const { versionId: builtinVersionId } = await ensurePinnedBuiltinPackage({ key: 'controld_windows', partnerId: partner.id });

    // A sibling org's private package, and an un-keyed partner-wide custom
    // package of the same partner (its versions stay partner-axis only).
    const { siblingVersionId, partnerWideVersionId } = await withSystemDbAccessContext(async () => {
      const [sibling] = await db.insert(softwareCatalog).values({ orgId: orgB.id, name: 'Sibling private' })
        .returning({ id: softwareCatalog.id });
      const [siblingVersion] = await db.insert(softwareVersions)
        .values({ catalogId: sibling!.id, version: '1.0.0', fileType: 'exe', isLatest: true })
        .returning({ id: softwareVersions.id });
      const [partnerWide] = await db.insert(softwareCatalog).values({ orgId: null, partnerId: partner.id, name: 'Partner custom' })
        .returning({ id: softwareCatalog.id });
      const [partnerWideVersion] = await db.insert(softwareVersions)
        .values({ catalogId: partnerWide!.id, version: '2.0.0', fileType: 'exe', isLatest: true })
        .returning({ id: softwareVersions.id });
      return { siblingVersionId: siblingVersion!.id, partnerWideVersionId: partnerWideVersion!.id };
    });

    // The same keyed package, provisioned for a DIFFERENT partner.
    const otherPartner = await createPartner();
    const { versionId: foreignBuiltinVersionId } = await ensurePinnedBuiltinPackage({ key: 'controld_windows', partnerId: otherPartner.id });

    const candidates = [builtinVersionId, siblingVersionId, partnerWideVersionId, foreignBuiltinVersionId];
    // Precondition: every candidate exists (system scope sees all four), so an
    // empty org-scope read below cannot pass vacuously.
    const all = await withSystemDbAccessContext(() =>
      db.select({ id: softwareVersions.id }).from(softwareVersions).where(inArray(softwareVersions.id, candidates)),
    );
    expect(all).toHaveLength(4);

    const visible = await withDbAccessContext(orgScoped(orgA.id, partner.id), () =>
      db.select({ id: softwareVersions.id }).from(softwareVersions).where(inArray(softwareVersions.id, candidates)),
    );
    expect(visible.map((r) => r.id)).toEqual([builtinVersionId]);
  });

  it('#10036: org scope still cannot UPDATE, DELETE or INSERT a keyed row\'s versions', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const { catalogId, versionId } = await ensurePinnedBuiltinPackage({ key: 'controld_windows', partnerId: partner.id });

    const { updated, deleted } = await withDbAccessContext(orgScoped(org.id, partner.id), async () => {
      const updated = await db.update(softwareVersions)
        .set({ downloadUrl: 'https://evil.example/ctrld.exe' })
        .where(eq(softwareVersions.id, versionId))
        .returning({ id: softwareVersions.id });
      const deleted = await db.delete(softwareVersions)
        .where(eq(softwareVersions.id, versionId))
        .returning({ id: softwareVersions.id });
      return { updated, deleted };
    });
    expect(updated).toEqual([]);
    expect(deleted).toEqual([]);

    await expect(
      withDbAccessContext(orgScoped(org.id, partner.id), async () => {
        await db.insert(softwareVersions).values({ catalogId, version: '6.6.6', fileType: 'exe' });
      }),
    ).rejects.toMatchObject({ cause: { code: '42501' } });

    const after = await withSystemDbAccessContext(() =>
      db.select().from(softwareVersions).where(eq(softwareVersions.catalogId, catalogId)),
    );
    expect(after.map((v) => v.id)).toEqual([versionId]);
    expect(after[0]!.downloadUrl).not.toBe('https://evil.example/ctrld.exe');
  });

  it('an org under a different partner reads neither the row nor its versions', async () => {
    const partnerA = await createPartner();
    const { catalogId } = await ensurePinnedBuiltinPackage({ key: 'controld_windows', partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });

    const { cats, versions } = await readAs(orgScoped(orgB.id, partnerB.id), catalogId);
    expect(cats).toHaveLength(0);
    expect(versions).toHaveLength(0);
  });

  it('org scope cannot INSERT a keyed row, even for its own partner', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    await expect(
      withDbAccessContext(orgScoped(org.id, partner.id), async () => {
        await db.insert(softwareCatalog).values({
          orgId: null,
          partnerId: partner.id,
          builtinPackageKey: 'controld_windows',
          name: 'forged',
          isManaged: true,
        });
      }),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});
