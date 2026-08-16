/**
 * Live-Postgres contract coverage for the package-manager install-method
 * chain (winget / Homebrew), spec:
 * docs/superpowers/specs/vuln-patch/2026-08-15-package-manager-software-library-design.md
 *
 * `software_install_methods` carries NO org_id — it is a parent-FK-join
 * tenancy shape whose RLS policies EXISTS-join to `software_catalog`
 * (migration 2026-08-16-a). The mocked unit suite (`software.test.ts`) stubs
 * drizzle and ignores WHERE clauses entirely, so nothing there can prove the
 * join policy, the CHECK constraints, or the cascade behavior. This file is
 * the only coverage for:
 *
 *   1. cross-tenant forge as `breeze_app` -> 42501 (insert a method under
 *      ANOTHER org's catalog item);
 *   2. org A cannot SELECT org B's methods (read side of the join policy);
 *   3. platform/kind coherence CHECK -> 23514 (winget is Windows-only,
 *      Homebrew is macOS-only);
 *   4. unique (catalog_id, platform, kind) -> 23505;
 *   5. `software_deployments_one_target_chk` -> 23514 when BOTH or NEITHER of
 *      software_version_id / install_method_id is set (migration -b-);
 *   6. replaying 2026-08-16-a/-b/-c is a no-op (idempotency contract);
 *   7. `methodKinds` (array_agg over a varchar column) round-trips through
 *      postgres-js as a real JS string array in the /software/catalog feed —
 *      the web card badges do `item.methodKinds.map(String)`, which silently
 *      renders a raw `{winget,homebrew_cask}` Postgres array literal as one
 *      bogus badge if the driver hands back a string;
 *   8. ORG ERASURE of the whole software chain (catalog -> version ->
 *      install method -> deployment -> deployment_result). None of
 *      deployment_results / software_versions / software_install_methods has
 *      an org_id, so the main cascade loop's FK-safe toposort never sees
 *      them; they are pre-cleared via ASSOCIATED_SYSTEM_SCOPED_TABLES in
 *      tenantCascade.ts. Without that pre-clear, erasing any org that ever
 *      uploaded a version or ran a deployment aborts with 23503 — a latent
 *      GDPR bug this branch fixes, so this fixture is the regression guard.
 */
import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';

// Mutable per-test auth context for the route-level assertion (case 7): the
// mocked authMiddleware injects it and opens the matching real RLS context,
// exactly as builtinCatalogVersionsRoute.integration.test.ts does.
type ActiveAuth = {
  scope: 'organization' | 'partner';
  orgId: string | null;
  partnerId: string | null;
  accessibleOrgIds: string[];
};
let activeAuth: ActiveAuth | null = null;

vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  const { withDbAccessContext } = await import('../../db');
  return {
    ...actual,
    authMiddleware: (c: any, next: any) => {
      if (!activeAuth) return c.json({ error: 'Unauthorized' }, 401);
      c.set('auth', {
        scope: activeAuth.scope,
        partnerId: activeAuth.partnerId,
        orgId: activeAuth.orgId,
        accessibleOrgIds: activeAuth.accessibleOrgIds,
        user: { id: null, email: 'integration@test' },
      });
      return withDbAccessContext(
        {
          scope: activeAuth.scope,
          orgId: activeAuth.orgId,
          accessibleOrgIds: activeAuth.accessibleOrgIds,
          accessiblePartnerIds:
            activeAuth.scope === 'partner' && activeAuth.partnerId ? [activeAuth.partnerId] : null,
          currentPartnerId: activeAuth.partnerId,
          userId: null,
        },
        () => next(),
      );
    },
    requireScope: () => (_c: any, next: any) => next(),
    requirePermission: () => (_c: any, next: any) => next(),
    requireMfa: () => (_c: any, next: any) => next(),
  };
});

vi.mock('../../services/auditEvents', () => ({
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
  writeRouteAudit: vi.fn(),
  writeAuditEvent: vi.fn(),
}));

import { getTestDb } from './setup';
import { db, withDbAccessContext } from '../../db';
import { ensureAppRole } from '../../db/ensureAppRole';
import {
  deploymentResults,
  devices,
  softwareCatalog,
  softwareDeployments,
  softwareInstallMethods,
  softwareVersions,
} from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { cascadeDeleteOrg, cascadeDeletePartner } from '../../services/tenantCascade';

const MIGRATIONS_DIR = join(__dirname, '../../../migrations');
const MIGRATION_A = join(MIGRATIONS_DIR, '2026-08-16-a-software-install-methods.sql');
const MIGRATION_B = join(MIGRATIONS_DIR, '2026-08-16-b-software-deployments-install-method.sql');
const MIGRATION_C = join(MIGRATIONS_DIR, '2026-08-16-c-winget-package-index.sql');

const PERFORMED_BY = '00000000-0000-0000-0000-0000000000aa';
const PERFORMED_EMAIL = 'platform-admin@breeze.test';

const orgCtx = (orgId: string) => ({
  scope: 'organization' as const,
  orgId,
  accessibleOrgIds: [orgId],
  accessiblePartnerIds: [] as string[],
});

/** postgres.js error codes surface either on the error or on drizzle's `.cause`. */
function pgErrorCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code ?? e?.cause?.code;
}

async function expectPgCode(promise: Promise<unknown>, code: string) {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught, `expected the statement to fail with SQLSTATE ${code}`).toBeDefined();
  expect(pgErrorCode(caught)).toBe(code);
}

/** Seed an org-owned catalog item (superuser pool — RLS bypassed on purpose). */
async function seedCatalog(orgId: string, name = 'Google Chrome') {
  const [catalog] = await getTestDb()
    .insert(softwareCatalog)
    .values({ orgId, name, vendor: 'Google', category: 'browser' })
    .returning();
  if (!catalog) throw new Error('failed to seed catalog item');
  return catalog;
}

async function seedMethod(
  catalogId: string,
  platform: 'windows' | 'macos',
  kind: 'winget' | 'homebrew_cask' | 'homebrew_formula',
  packageId: string,
) {
  const [method] = await getTestDb()
    .insert(softwareInstallMethods)
    .values({ catalogId, platform, kind, packageId })
    .returning();
  if (!method) throw new Error('failed to seed install method');
  return method;
}

beforeEach(() => {
  activeAuth = null;
});

afterEach(() => {
  activeAuth = null;
  vi.clearAllMocks();
});

describe('software_install_methods — parent-FK-join RLS forge', () => {
  it('an org cannot forge an install method under ANOTHER org\'s catalog item', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const catalogA = await seedCatalog(orgA.id);

    await expectPgCode(
      withDbAccessContext(orgCtx(orgB.id), async () => {
        await db.insert(softwareInstallMethods).values({
          catalogId: catalogA.id,
          platform: 'windows',
          kind: 'winget',
          packageId: 'Forged.Package',
        });
      }),
      '42501',
    );
  });

  it('org A cannot SELECT org B\'s install methods, but can read its own', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const catalogA = await seedCatalog(orgA.id, 'A Chrome');
    const catalogB = await seedCatalog(orgB.id, 'B Chrome');
    await seedMethod(catalogA.id, 'windows', 'winget', 'Google.Chrome');
    await seedMethod(catalogB.id, 'macos', 'homebrew_cask', 'google-chrome');

    const { own, foreign } = await withDbAccessContext(orgCtx(orgA.id), async () => ({
      own: await db
        .select()
        .from(softwareInstallMethods)
        .where(eq(softwareInstallMethods.catalogId, catalogA.id)),
      foreign: await db
        .select()
        .from(softwareInstallMethods)
        .where(eq(softwareInstallMethods.catalogId, catalogB.id)),
    }));

    expect(own).toHaveLength(1);
    expect(own[0]!.packageId).toBe('Google.Chrome');
    expect(foreign).toHaveLength(0);
  });

  it('an org member CAN create an install method on its own catalog item', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const catalog = await seedCatalog(org.id);

    const rows = await withDbAccessContext(orgCtx(org.id), async () =>
      db
        .insert(softwareInstallMethods)
        .values({
          catalogId: catalog.id,
          platform: 'macos',
          kind: 'homebrew_cask',
          packageId: 'google-chrome',
        })
        .returning(),
    );

    expect(rows).toHaveLength(1);
  });
});

describe('software_install_methods — CHECK + uniqueness constraints', () => {
  it('rejects an incoherent platform/kind pair (winget on macOS) with 23514', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const catalog = await seedCatalog(org.id);

    await expectPgCode(
      getTestDb()
        .insert(softwareInstallMethods)
        .values({
          catalogId: catalog.id,
          platform: 'macos',
          kind: 'winget',
          packageId: 'Google.Chrome',
        }),
      '23514',
    );
  });

  it('rejects an unknown platform with 23514', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const catalog = await seedCatalog(org.id);

    await expectPgCode(
      getTestDb().execute(sql`
        INSERT INTO software_install_methods (catalog_id, platform, kind, package_id)
        VALUES (${catalog.id}, 'linux', 'winget', 'Google.Chrome')
      `),
      '23514',
    );
  });

  it('rejects a duplicate (catalog_id, platform, kind) with 23505', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const catalog = await seedCatalog(org.id);
    await seedMethod(catalog.id, 'windows', 'winget', 'Google.Chrome');

    await expectPgCode(
      getTestDb()
        .insert(softwareInstallMethods)
        .values({
          catalogId: catalog.id,
          platform: 'windows',
          kind: 'winget',
          packageId: 'Google.Chrome.Beta',
        }),
      '23505',
    );
  });

  it('allows the same (platform, kind) pair on a DIFFERENT catalog item', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const catalog1 = await seedCatalog(org.id, 'Chrome');
    const catalog2 = await seedCatalog(org.id, 'Firefox');
    await seedMethod(catalog1.id, 'windows', 'winget', 'Google.Chrome');
    const second = await seedMethod(catalog2.id, 'windows', 'winget', 'Mozilla.Firefox');
    expect(second.packageId).toBe('Mozilla.Firefox');
  });
});

describe('software_deployments — one-target CHECK (migration -b-)', () => {
  async function seedDeploymentTargets() {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const catalog = await seedCatalog(org.id);
    const [version] = await getTestDb()
      .insert(softwareVersions)
      .values({ catalogId: catalog.id, version: '1.0.0', fileType: 'exe', isLatest: true })
      .returning();
    const method = await seedMethod(catalog.id, 'windows', 'winget', 'Google.Chrome');
    return { org, catalog, version: version!, method };
  }

  const baseDeployment = (orgId: string) => ({
    orgId,
    name: 'Chrome rollout',
    deploymentType: 'install',
    targetType: 'devices',
    scheduleType: 'immediate',
  });

  it('rejects a deployment with BOTH software_version_id and install_method_id (23514)', async () => {
    const { org, version, method } = await seedDeploymentTargets();

    await expectPgCode(
      getTestDb()
        .insert(softwareDeployments)
        .values({
          ...baseDeployment(org.id),
          softwareVersionId: version.id,
          installMethodId: method.id,
        }),
      '23514',
    );
  });

  it('rejects a deployment with NEITHER target set (23514)', async () => {
    const { org } = await seedDeploymentTargets();

    await expectPgCode(
      getTestDb()
        .insert(softwareDeployments)
        .values({ ...baseDeployment(org.id), softwareVersionId: null, installMethodId: null }),
      '23514',
    );
  });

  it('accepts exactly one target — version-only and method-only', async () => {
    const { org, version, method } = await seedDeploymentTargets();

    const [versionOnly] = await getTestDb()
      .insert(softwareDeployments)
      .values({ ...baseDeployment(org.id), softwareVersionId: version.id })
      .returning();
    const [methodOnly] = await getTestDb()
      .insert(softwareDeployments)
      .values({ ...baseDeployment(org.id), installMethodId: method.id })
      .returning();

    expect(versionOnly!.installMethodId).toBeNull();
    expect(methodOnly!.softwareVersionId).toBeNull();
  });
});

describe('migration replay (2026-08-16-a/-b/-c) is a no-op', () => {
  it('re-applies all three migrations twice without error', async () => {
    const adminDb = getTestDb();
    for (const file of [MIGRATION_A, MIGRATION_B, MIGRATION_C]) {
      const body = readFileSync(file, 'utf8');
      await expect(adminDb.execute(sql.raw(body))).resolves.toBeDefined();
      await expect(adminDb.execute(sql.raw(body))).resolves.toBeDefined();
    }
    // Re-applying does not re-create the tables, so the app role's grants
    // survive — but re-assert them the way the other replay suites do so a
    // future GRANT-carrying edit to these files can't silently strand
    // breeze_app for every subsequent test file.
    await ensureAppRole();

    // The constraints the replay must have preserved.
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const catalog = await seedCatalog(org.id);
    await seedMethod(catalog.id, 'windows', 'winget', 'Google.Chrome');
    await expectPgCode(
      getTestDb()
        .insert(softwareInstallMethods)
        .values({
          catalogId: catalog.id,
          platform: 'windows',
          kind: 'winget',
          packageId: 'Dup.Package',
        }),
      '23505',
    );
    // And the winget index still rejects a non-system write.
    await expectPgCode(
      withDbAccessContext(orgCtx(org.id), async () => {
        await db.execute(sql`
          INSERT INTO winget_package_index (package_id, vendor_segment, name_segment, synced_commit_sha)
          VALUES ('Forged.Pkg', 'Forged', 'Pkg', 'deadbeef')
        `);
      }),
      '42501',
    );
  });
});

describe('GET /software/catalog — methodKinds array round-trip', () => {
  async function buildApp() {
    const { softwareRoutes } = await import('../../routes/software');
    const { authMiddleware } = await import('../../middleware/auth');
    const app = new Hono();
    app.use('*', authMiddleware as never);
    app.route('/software', softwareRoutes);
    return app;
  }

  it('array_agg over the varchar `kind` column arrives as a JS string array', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const catalog = await seedCatalog(org.id, 'Chrome (managed)');
    await seedMethod(catalog.id, 'windows', 'winget', 'Google.Chrome');
    await seedMethod(catalog.id, 'macos', 'homebrew_cask', 'google-chrome');
    // A disabled method must not appear in the badge set.
    const disabled = await seedMethod(catalog.id, 'macos', 'homebrew_formula', 'chromedriver');
    await getTestDb()
      .update(softwareInstallMethods)
      .set({ enabled: false })
      .where(eq(softwareInstallMethods.id, disabled.id));
    // One uploaded version too: versionCount shares the correlated-subquery
    // shape and was silently 0 for every row before the qualification fix.
    await getTestDb()
      .insert(softwareVersions)
      .values({ catalogId: catalog.id, version: '1.0.0', fileType: 'exe', isLatest: true });
    // A catalog item with no methods at all must come back as [], not null.
    const bare = await seedCatalog(org.id, 'Aardvark Tool');

    const app = await buildApp();
    activeAuth = {
      scope: 'organization',
      orgId: org.id,
      partnerId: partner.id,
      accessibleOrgIds: [org.id],
    };
    const res = await app.request(`/software/catalog?orgId=${org.id}`, {
      headers: { Authorization: 'Bearer test' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{
        id: string;
        versionCount: number;
        methodCount: number;
        methodKinds: unknown;
      }>;
    };

    const managed = body.data.find((i) => i.id === catalog.id);
    expect(managed).toBeDefined();
    expect(Array.isArray(managed!.methodKinds)).toBe(true);
    expect([...(managed!.methodKinds as string[])].sort()).toEqual(['homebrew_cask', 'winget']);
    expect(Number(managed!.methodCount)).toBe(2);
    expect(Number(managed!.versionCount)).toBe(1);

    const empty = body.data.find((i) => i.id === bare.id);
    expect(empty).toBeDefined();
    expect(Array.isArray(empty!.methodKinds)).toBe(true);
    expect(empty!.methodKinds).toEqual([]);
    expect(Number(empty!.methodCount)).toBe(0);
    expect(Number(empty!.versionCount)).toBe(0);
  });
});

describe('org erasure removes the whole software chain', () => {
  /**
   * catalog -> version + install method -> deployment (one per target kind)
   * -> deployment_result. Three of those tables have no org_id, so they only
   * disappear if the ASSOCIATED_SYSTEM_SCOPED_TABLES pre-clear in
   * tenantCascade.ts runs in the right order (results, deployments,
   * versions) before the main loop deletes devices and software_catalog.
   */
  async function seedSoftwareChain(orgId: string) {
    const site = await createSite({ orgId });
    const catalog = await seedCatalog(orgId, `Chrome ${orgId.slice(0, 8)}`);
    const [version] = await getTestDb()
      .insert(softwareVersions)
      .values({ catalogId: catalog.id, version: '1.0.0', fileType: 'exe', isLatest: true })
      .returning();
    const method = await seedMethod(catalog.id, 'windows', 'winget', 'Google.Chrome');
    const [device] = await getTestDb()
      .insert(devices)
      .values({
        orgId,
        siteId: site.id,
        agentId: `erasure-agent-${crypto.randomUUID()}`,
        hostname: 'erasure-host',
        osType: 'windows',
        osVersion: '11',
        architecture: 'amd64',
        agentVersion: '1.0.0',
      })
      .returning();
    const [managerDeployment] = await getTestDb()
      .insert(softwareDeployments)
      .values({
        orgId,
        name: 'winget rollout',
        deploymentType: 'install',
        targetType: 'devices',
        scheduleType: 'immediate',
        installMethodId: method.id,
      })
      .returning();
    const [versionDeployment] = await getTestDb()
      .insert(softwareDeployments)
      .values({
        orgId,
        name: 'uploaded rollout',
        deploymentType: 'install',
        targetType: 'devices',
        scheduleType: 'immediate',
        softwareVersionId: version!.id,
      })
      .returning();
    await getTestDb()
      .insert(deploymentResults)
      .values([
        { deploymentId: managerDeployment!.id, deviceId: device!.id, status: 'completed' },
        { deploymentId: versionDeployment!.id, deviceId: device!.id, status: 'failed' },
      ]);
    return { catalog, version: version!, method, device: device! };
  }

  const countWhere = async (table: string, column: string, value: string) => {
    const rows = (await getTestDb().execute(
      sql`SELECT count(*)::int AS n FROM ${sql.raw(`"${table}"`)} WHERE ${sql.raw(`"${column}"`)} = ${value}`,
    )) as unknown as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  };

  it('cascadeDeleteOrg erases catalog/version/install-method/deployment/result and spares the other org', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const chainA = await seedSoftwareChain(orgA.id);
    const chainB = await seedSoftwareChain(orgB.id);

    expect(await countWhere('software_install_methods', 'catalog_id', chainA.catalog.id)).toBe(1);
    expect(await countWhere('deployment_results', 'device_id', chainA.device.id)).toBe(2);

    const stats = await cascadeDeleteOrg(orgA.id, PERFORMED_BY, PERFORMED_EMAIL);

    // Org A: every link of the chain is gone.
    expect(await countWhere('software_catalog', 'org_id', orgA.id)).toBe(0);
    expect(await countWhere('software_versions', 'catalog_id', chainA.catalog.id)).toBe(0);
    expect(await countWhere('software_install_methods', 'catalog_id', chainA.catalog.id)).toBe(0);
    expect(await countWhere('software_deployments', 'org_id', orgA.id)).toBe(0);
    expect(await countWhere('deployment_results', 'device_id', chainA.device.id)).toBe(0);
    expect(await countWhere('devices', 'org_id', orgA.id)).toBe(0);

    // The pre-clear + cascade genuinely ran (not a silent no-op).
    expect(stats.tablesDeleted['deployment_results']).toBe(2);
    expect(stats.tablesDeleted['software_deployments']).toBe(2);
    expect(stats.tablesDeleted['software_catalog']).toBe(1);

    // Org B untouched — including the org_id-less children.
    expect(await countWhere('software_catalog', 'org_id', orgB.id)).toBe(1);
    expect(await countWhere('software_versions', 'catalog_id', chainB.catalog.id)).toBe(1);
    expect(await countWhere('software_install_methods', 'catalog_id', chainB.catalog.id)).toBe(1);
    expect(await countWhere('software_deployments', 'org_id', orgB.id)).toBe(2);
    expect(await countWhere('deployment_results', 'device_id', chainB.device.id)).toBe(2);
  }, 60_000);
});

describe('partner erasure removes the partner-owned software chain (#3600)', () => {
  /**
   * The org-axis pre-clears added with the install-method work are keyed on
   * `software_catalog.org_id`, so they do not reach a catalog item owned on the
   * PARTNER axis (epic #2135 dual ownership: org_id XOR partner_id).
   * `cascadeDeletePartner`'s sweep runs `DELETE FROM software_catalog WHERE
   * partner_id = $1`, and `software_versions.catalog_id` is a NO ACTION FK with
   * no tenancy column of its own — so before the partner-axis pre-clears, any
   * partner whose built-in catalog item ever had a version row aborted the
   * whole purge with 23503. This fixture is that regression guard.
   */
  const countWhere = async (table: string, column: string, value: string) => {
    const rows = (await getTestDb().execute(
      sql`SELECT count(*)::int AS n FROM ${sql.raw(`"${table}"`)} WHERE ${sql.raw(`"${column}"`)} = ${value}`,
    )) as unknown as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  };

  /** Partner-owned (built-in integration) catalog item + version + method. */
  async function seedPartnerChain(partnerId: string) {
    const [catalog] = await getTestDb()
      .insert(softwareCatalog)
      .values({
        partnerId,
        integrationProvider: 'huntress',
        name: `Huntress ${partnerId.slice(0, 8)}`,
        vendor: 'Huntress',
      })
      .returning();
    if (!catalog) throw new Error('failed to seed partner catalog item');
    const [version] = await getTestDb()
      .insert(softwareVersions)
      .values({ catalogId: catalog.id, version: '2.0.0', fileType: 'exe', isLatest: true })
      .returning();
    const method = await seedMethod(catalog.id, 'windows', 'winget', 'Huntress.Agent');
    return { catalog, version: version!, method };
  }

  it('cascadeDeletePartner erases a partner-owned catalog/version/method and spares the other partner', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const chainA = await seedPartnerChain(partnerA.id);
    const chainB = await seedPartnerChain(partnerB.id);

    // A child-org deployment against the PARTNER-owned method: the per-org
    // cascade must clear it before the partner sweep reaches the catalog.
    const site = await createSite({ orgId: orgA.id });
    const [device] = await getTestDb()
      .insert(devices)
      .values({
        orgId: orgA.id,
        siteId: site.id,
        agentId: `partner-erasure-agent-${crypto.randomUUID()}`,
        hostname: 'partner-erasure-host',
        osType: 'windows',
        osVersion: '11',
        architecture: 'amd64',
        agentVersion: '1.0.0',
      })
      .returning();
    const [deployment] = await getTestDb()
      .insert(softwareDeployments)
      .values({
        orgId: orgA.id,
        name: 'built-in EDR rollout',
        deploymentType: 'install',
        targetType: 'devices',
        scheduleType: 'immediate',
        installMethodId: chainA.method.id,
      })
      .returning();
    await getTestDb()
      .insert(deploymentResults)
      .values({ deploymentId: deployment!.id, deviceId: device!.id, status: 'completed' });

    expect(await countWhere('software_versions', 'catalog_id', chainA.catalog.id)).toBe(1);

    // The assertion that matters: this used to throw 23503 on software_catalog.
    const stats = await cascadeDeletePartner(partnerA.id, PERFORMED_BY);

    expect(await countWhere('software_catalog', 'partner_id', partnerA.id)).toBe(0);
    expect(await countWhere('software_versions', 'catalog_id', chainA.catalog.id)).toBe(0);
    expect(await countWhere('software_install_methods', 'catalog_id', chainA.catalog.id)).toBe(0);
    expect(await countWhere('software_deployments', 'org_id', orgA.id)).toBe(0);
    expect(await countWhere('deployment_results', 'device_id', device!.id)).toBe(0);

    // The partner-axis pre-clear genuinely ran rather than matching zero rows.
    expect(stats.tablesDeleted['software_versions']).toBeGreaterThanOrEqual(1);

    // Partner B is untouched — including its org_id-less children.
    expect(await countWhere('software_catalog', 'partner_id', partnerB.id)).toBe(1);
    expect(await countWhere('software_versions', 'catalog_id', chainB.catalog.id)).toBe(1);
    expect(await countWhere('software_install_methods', 'catalog_id', chainB.catalog.id)).toBe(1);
  }, 120_000);
});
