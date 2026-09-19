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

const { deleteObjectsMock } = vi.hoisted(() => ({ deleteObjectsMock: vi.fn(async () => undefined) }));
vi.mock('../../services/s3Storage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/s3Storage')>()),
  deleteObjects: deleteObjectsMock,
}));

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
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { ensureAppRole } from '../../db/ensureAppRole';
import {
  deploymentResults,
  devices,
  softwareCatalog,
  softwareDeployments,
  softwareInstallMethods,
  softwarePolicies,
  softwareVersions,
} from '../../db/schema';
import {
  hasUnfinishedPolicyOwnedInstall,
  POLICY_INSTALL_IN_FLIGHT_LOOKBACK_MINUTES,
  readLatestPolicyOwnedInstallByDevice,
  resolvePolicyInstallTarget,
} from '../../services/softwarePolicyInstallRemediation';
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
  deleteObjectsMock.mockReset();
  deleteObjectsMock.mockResolvedValue(undefined);
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
      .values({ catalogId: catalog.id, version: '1.0.0', fileType: 'exe', isLatest: true, s3Key: `software/${orgId}/package.exe` })
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
    expect(deleteObjectsMock).toHaveBeenCalledWith([`software/${orgA.id}/package.exe`]);

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
      .values({ catalogId: catalog.id, version: '2.0.0', fileType: 'exe', isLatest: true, s3Key: `software/partner/${partnerId}/package.exe` })
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
    expect(deleteObjectsMock).toHaveBeenCalledWith([`software/partner/${partnerA.id}/package.exe`]);

    // Partner B is untouched — including its org_id-less children.
    expect(await countWhere('software_catalog', 'partner_id', partnerB.id)).toBe(1);
    expect(await countWhere('software_versions', 'catalog_id', chainB.catalog.id)).toBe(1);
    expect(await countWhere('software_install_methods', 'catalog_id', chainB.catalog.id)).toBe(1);
  }, 120_000);
});

/**
 * Feature #5505 W03 (#5508): `software_deployments.software_policy_id`.
 *
 * Four things here are provable ONLY against real Postgres:
 *
 *  1. `ON DELETE SET NULL` actually fires on a FORCE-RLS table. PostgreSQL runs
 *     referential actions in internal RI triggers as the referencing table's
 *     owner and bypasses row security for them — a doc claim this fixture turns
 *     into evidence. It is load-bearing: a PARTNER-WIDE policy is referenced by
 *     policy-owned deployments in EVERY child org, so with the NO ACTION default
 *     that the two sibling FKs use, deleting it would abort an erasure on 23503.
 *  2. Org erasure still completes with a policy-owned deployment present. The
 *     cascade-list contract has caught this class of mistake 5/5 times while
 *     code review caught it 0/5.
 *  3. The catalog reachability predicate. The remediation worker runs in a
 *     SYSTEM db context where `breeze_has_org_access` short-circuits true and
 *     RLS scopes nothing, and a rule's `catalogId` is operator-authored jsonb —
 *     so that WHERE clause is the ENTIRE guard between a forged catalogId and
 *     another tenant's package landing on these machines. A mocked suite that
 *     ignores WHERE clauses cannot prove it.
 *  4. The dedup join, against the real deployment_status enum.
 */
describe('software_deployments.software_policy_id — policy origin (#5505 W03)', () => {
  /**
   * Everything in services/softwarePolicyInstallRemediation.ts runs inside the
   * remediation worker's SYSTEM db context, and the app pool connects as the
   * unprivileged `breeze_app`. A CONTEXTLESS connection is DENY-ALL under RLS,
   * not a bypass — so calling these helpers bare makes every negative assertion
   * pass for the wrong reason and every positive one fail. The control test
   * below pins that down so a future edit cannot quietly drop the wrapper and
   * leave a green-but-vacuous suite.
   */
  const resolveInWorkerContext = (input: {
    catalogId: string | null | undefined;
    deviceOrgId: string;
    deviceOsType: string;
  }) => withSystemDbAccessContext(() => resolvePolicyInstallTarget(input));

  async function seedDevice(orgId: string, siteId: string, osType: 'windows' | 'macos' = 'windows') {
    const [device] = await getTestDb()
      .insert(devices)
      .values({
        orgId,
        siteId,
        agentId: `w03-agent-${crypto.randomUUID()}`,
        hostname: 'w03-host',
        osType,
        osVersion: '11',
        architecture: 'amd64',
        agentVersion: '1.0.0',
      })
      .returning();
    if (!device) throw new Error('failed to seed device');
    return device;
  }

  async function seedPolicy(owner: { orgId?: string; partnerId?: string }, catalogId: string) {
    const [policy] = await getTestDb()
      .insert(softwarePolicies)
      .values({
        orgId: owner.orgId ?? null,
        partnerId: owner.partnerId ?? null,
        name: 'Standard workstation build',
        mode: 'allowlist',
        rules: { software: [{ name: 'Chrome', catalogId }] },
        enforceMode: true,
        remediationOptions: { autoInstall: true },
      })
      .returning();
    if (!policy) throw new Error('failed to seed policy');
    return policy;
  }

  async function seedPolicyOwnedDeployment(orgId: string, installMethodId: string, policyId: string) {
    const [deployment] = await getTestDb()
      .insert(softwareDeployments)
      .values({
        orgId,
        name: 'Policy: Standard workstation build',
        installMethodId,
        deploymentType: 'install',
        targetType: 'devices',
        scheduleType: 'immediate',
        softwarePolicyId: policyId,
      })
      .returning();
    if (!deployment) throw new Error('failed to seed policy-owned deployment');
    return deployment;
  }

  it('the FK is ON DELETE SET NULL: deleting the policy nulls the column and keeps the deployment', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const catalog = await seedCatalog(org.id);
    const method = await seedMethod(catalog.id, 'windows', 'winget', 'Google.Chrome');
    // A PARTNER-WIDE policy: the case array ordering does not cover, because
    // such a policy is referenced from every child org.
    const policy = await seedPolicy({ partnerId: partner.id }, catalog.id);

    const deployment = await seedPolicyOwnedDeployment(org.id, method.id, policy.id);
    expect(deployment.softwarePolicyId).toBe(policy.id);

    await getTestDb().delete(softwarePolicies).where(eq(softwarePolicies.id, policy.id));

    const [after] = await getTestDb()
      .select()
      .from(softwareDeployments)
      .where(eq(softwareDeployments.id, deployment.id));
    // Survived, with the label degraded rather than the delete aborting.
    expect(after).toBeDefined();
    expect(after!.softwarePolicyId).toBeNull();
  }, 60_000);

  it('org erasure still completes with a policy-owned deployment present', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const catalog = await seedCatalog(org.id);
    const method = await seedMethod(catalog.id, 'windows', 'winget', 'Google.Chrome');
    const policy = await seedPolicy({ partnerId: partner.id }, catalog.id);
    const device = await seedDevice(org.id, site.id);

    const deployment = await seedPolicyOwnedDeployment(org.id, method.id, policy.id);
    await getTestDb()
      .insert(deploymentResults)
      .values({ deploymentId: deployment.id, deviceId: device.id, status: 'pending' });

    // Must not raise 23503.
    await expect(cascadeDeleteOrg(org.id, PERFORMED_BY, PERFORMED_EMAIL)).resolves.toBeDefined();

    const remaining = await getTestDb()
      .select()
      .from(softwareDeployments)
      .where(eq(softwareDeployments.id, deployment.id));
    expect(remaining).toHaveLength(0);

    // The partner-wide policy outlived the org erasure, which is the whole
    // point: it still serves the partner's other orgs.
    const survivingPolicy = await getTestDb()
      .select()
      .from(softwarePolicies)
      .where(eq(softwarePolicies.id, policy.id));
    expect(survivingPolicy).toHaveLength(1);
  }, 120_000);


  it('CONTROL: without the system context the resolver refuses everything — a bare call is a vacuous pass', async () => {
    // Discriminates the two "not reachable" answers above. Those assertions are
    // only meaningful if the SAME reachable item resolves OK under the worker's
    // real context and is refused without it — otherwise RLS denying the whole
    // table would satisfy them just as well.
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const catalog = await seedCatalog(org.id);
    await seedMethod(catalog.id, 'windows', 'winget', 'Google.Chrome');

    await expect(
      resolveInWorkerContext({
        catalogId: catalog.id,
        deviceOrgId: org.id,
        deviceOsType: 'windows',
      })
    ).resolves.toMatchObject({ ok: true, target: { kind: 'install_method' } });

    // Same arguments, no context: DENY-ALL, not bypass.
    await expect(
      resolvePolicyInstallTarget({
        catalogId: catalog.id,
        deviceOrgId: org.id,
        deviceOsType: 'windows',
      })
    ).resolves.toEqual({ ok: false, reason: 'catalog_item_not_reachable' });
  }, 60_000);

  it("a policy rule naming ANOTHER org's catalog item resolves to nothing", async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const catalogB = await seedCatalog(orgB.id, 'B Chrome');
    await seedMethod(catalogB.id, 'windows', 'winget', 'Google.Chrome');

    const resolution = await resolveInWorkerContext({
      catalogId: catalogB.id,
      deviceOrgId: orgA.id,
      deviceOsType: 'windows',
    });
    expect(resolution).toEqual({ ok: false, reason: 'catalog_item_not_reachable' });
  }, 60_000);

  it('a partner-owned catalog item IS reachable from a child org of that partner', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [catalog] = await getTestDb()
      .insert(softwareCatalog)
      .values({ orgId: null, partnerId: partner.id, name: 'Partner-wide App' })
      .returning();
    await seedMethod(catalog!.id, 'windows', 'winget', 'Partner.App');

    const resolution = await resolveInWorkerContext({
      catalogId: catalog!.id,
      deviceOrgId: org.id,
      deviceOsType: 'windows',
    });
    expect(resolution).toMatchObject({ ok: true, target: { kind: 'install_method' } });
  }, 60_000);

  it("a DIFFERENT partner's partner-wide catalog item is NOT reachable", async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const [catalogB] = await getTestDb()
      .insert(softwareCatalog)
      .values({ orgId: null, partnerId: partnerB.id, name: 'Other Partner App' })
      .returning();
    await seedMethod(catalogB!.id, 'windows', 'winget', 'Other.App');

    const resolution = await resolveInWorkerContext({
      catalogId: catalogB!.id,
      deviceOrgId: orgA.id,
      deviceOsType: 'windows',
    });
    expect(resolution).toEqual({ ok: false, reason: 'catalog_item_not_reachable' });
  }, 60_000);

  it('does not create a second policy-owned deployment while one is unfinished', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const catalog = await seedCatalog(org.id);
    const method = await seedMethod(catalog.id, 'windows', 'winget', 'Google.Chrome');
    const policy = await seedPolicy({ partnerId: partner.id }, catalog.id);
    const device = await seedDevice(org.id, site.id);

    const first = await seedPolicyOwnedDeployment(org.id, method.id, policy.id);
    await getTestDb()
      .insert(deploymentResults)
      .values({ deploymentId: first.id, deviceId: device.id, status: 'installing' });

    await expect(
      withSystemDbAccessContext(() => hasUnfinishedPolicyOwnedInstall(policy.id, device.id))
    ).resolves.toBe(true);

    // Once the result reaches a terminal status the gate reopens.
    await getTestDb()
      .update(deploymentResults)
      .set({ status: 'completed' })
      .where(eq(deploymentResults.deploymentId, first.id));
    await expect(
      withSystemDbAccessContext(() => hasUnfinishedPolicyOwnedInstall(policy.id, device.id))
    ).resolves.toBe(false);
  }, 60_000);


  it('stops counting an unfinished result once the deployment ages past the lookback', async () => {
    // POLICY_INSTALL_IN_FLIGHT_LOOKBACK_MINUTES exists precisely so ONE
    // permanently wedged deployment_results row cannot suppress every future
    // install for a (policy, device) pair forever. Nothing proved that: the
    // mocked unit tests discard the WHERE clause, and the live case above only
    // covers the unexpired side. Drop the `gte(createdAt, cutoff)` term and
    // this is the test that goes red.
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const catalog = await seedCatalog(org.id);
    const method = await seedMethod(catalog.id, 'windows', 'winget', 'Google.Chrome');
    const policy = await seedPolicy({ partnerId: partner.id }, catalog.id);
    const device = await seedDevice(org.id, site.id);

    const wedged = await seedPolicyOwnedDeployment(org.id, method.id, policy.id);
    await getTestDb()
      .insert(deploymentResults)
      .values({ deploymentId: wedged.id, deviceId: device.id, status: 'installing' });

    await expect(
      withSystemDbAccessContext(() => hasUnfinishedPolicyOwnedInstall(policy.id, device.id))
    ).resolves.toBe(true);

    // Age the deployment past the horizon. The result row stays non-terminal.
    await getTestDb()
      .update(softwareDeployments)
      .set({
        createdAt: new Date(
          Date.now() - (POLICY_INSTALL_IN_FLIGHT_LOOKBACK_MINUTES + 60) * 60 * 1000
        ),
      })
      .where(eq(softwareDeployments.id, wedged.id));

    await expect(
      withSystemDbAccessContext(() => hasUnfinishedPolicyOwnedInstall(policy.id, device.id))
    ).resolves.toBe(false);
  }, 60_000);

  it('the install-method query really filters on enabled AND platform', async () => {
    // The mocked unit tests drive resolvePolicyInstallTarget purely off primed
    // return values and ignore `.where()` arguments entirely, so dropping
    // either predicate from the real query would not fail any of them. This
    // seeds exactly the two rows those predicates must exclude and asserts the
    // resolver falls through to the version path instead of picking either.
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const catalog = await seedCatalog(org.id);

    const disabledWindows = await seedMethod(catalog.id, 'windows', 'winget', 'Disabled.App');
    await getTestDb()
      .update(softwareInstallMethods)
      .set({ enabled: false })
      .where(eq(softwareInstallMethods.id, disabledWindows.id));
    // Right catalog item, wrong platform for the device below.
    await seedMethod(catalog.id, 'macos', 'homebrew_cask', 'Wrong.Platform');

    const [version] = await getTestDb()
      .insert(softwareVersions)
      .values({
        catalogId: catalog.id,
        version: '1.0.0',
        isLatest: true,
        supportedOs: ['windows'],
      })
      .returning();

    const resolution = await resolveInWorkerContext({
      catalogId: catalog.id,
      deviceOrgId: org.id,
      deviceOsType: 'windows',
    });

    expect(resolution).toEqual({
      ok: true,
      target: { kind: 'version', catalogId: catalog.id, softwareVersionId: version!.id },
    });
  }, 60_000);

  it('the reconcile reader reports the LATEST policy-owned deployment per device', async () => {
    // Backs the compliance worker's orphaned-install sweep: it must be able to
    // tell "this enqueue produced a deployment" from "an EARLIER cycle did".
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const catalog = await seedCatalog(org.id);
    const method = await seedMethod(catalog.id, 'windows', 'winget', 'Google.Chrome');
    const policy = await seedPolicy({ partnerId: partner.id }, catalog.id);
    const device = await seedDevice(org.id, site.id);
    const otherDevice = await seedDevice(org.id, site.id);

    const older = await seedPolicyOwnedDeployment(org.id, method.id, policy.id);
    const newer = await seedPolicyOwnedDeployment(org.id, method.id, policy.id);
    await getTestDb()
      .update(softwareDeployments)
      .set({ createdAt: new Date('2026-09-01T00:00:00Z') })
      .where(eq(softwareDeployments.id, older.id));
    await getTestDb()
      .update(softwareDeployments)
      .set({ createdAt: new Date('2026-09-10T00:00:00Z') })
      .where(eq(softwareDeployments.id, newer.id));
    await getTestDb().insert(deploymentResults).values([
      { deploymentId: older.id, deviceId: device.id, status: 'completed' },
      { deploymentId: newer.id, deviceId: device.id, status: 'completed' },
    ]);

    const byDevice = await withSystemDbAccessContext(() =>
      readLatestPolicyOwnedInstallByDevice(policy.id, [device.id, otherDevice.id])
    );
    expect(byDevice.get(device.id)).toEqual(new Date('2026-09-10T00:00:00Z'));
    // A device that never had one is absent, not zero-dated.
    expect(byDevice.has(otherDevice.id)).toBe(false);
  }, 60_000);
});
