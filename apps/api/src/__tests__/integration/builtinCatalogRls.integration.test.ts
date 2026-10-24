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
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { softwareCatalog, softwareVersions } from '../../db/schema';
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
// #6958 PR D: keyed (builtin_package_key) DNS built-ins. Plan decision D1:
// "No RLS change on the catalog". These pin today's read shape so the
// deferred follow-up (a software_versions SELECT branch on
// builtin_package_key, mirroring the 2026-07-02 integration_provider branch)
// flips them deliberately.
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

  it('PINNED GAP: org scope under the same partner reads the keyed row (partner_wide_select) but ZERO versions', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const { catalogId } = await ensurePinnedBuiltinPackage({ key: 'controld_windows', partnerId: partner.id });

    const { cats, versions } = await readAs(orgScoped(org.id, partner.id), catalogId);
    expect(cats).toHaveLength(1);
    // Flip deliberately with the follow-up software_versions SELECT branch.
    expect(versions).toHaveLength(0);
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
