/**
 * Built-in package versions are readable through the ROUTE by an org member (#1957).
 *
 * Built-in EDR packages (Huntress/SentinelOne) live in software_catalog with
 * org_id NULL + partner_id set. The 2026-07-02 migration broadened RLS so an
 * org-scoped caller can read their OWN partner's built-in + its versions, and
 * the /catalog LIST route was widened to surface them — but GET /catalog/:id
 * and GET /catalog/:id/versions still filtered `eq(org_id)`, which structurally
 * excludes an org_id-NULL row. The version fetch 404'd, the deploy wizard showed
 * "No versions" with a grayed-out deploy, and the package's Versions tab was
 * blank. builtinCatalogRls.integration.test.ts proves the DB policy is correct;
 * only this route-level path proves the handler's WHERE no longer drops built-ins.
 *
 * Drives the real softwareRoutes against the real docker postgres as breeze_app.
 * NOTE: these cases MUST stay in the real-DB integration suite — built-in
 * cross-partner isolation is enforced by RLS, and the mocked `drizzle-orm` in
 * software.test.ts ignores WHERE clauses, so an isolation assertion there would
 * pass vacuously. Do not "simplify" this into the unit suite.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Mutable per-test auth context: the mocked authMiddleware injects it and opens
// the matching real DB (RLS) context, so tests can drive both organization- and
// partner-scoped callers through the same real RLS boundary the handler trusts.
type ActiveAuth = {
  scope: 'organization' | 'partner';
  orgId: string | null;
  partnerId: string | null;
  accessibleOrgIds: string[];
  /** #6958: lets a case reach the built-in guard past the partner-wide write gate. */
  partnerOrgAccess?: 'all' | 'selected' | 'none';
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
        ...(activeAuth.partnerOrgAccess ? { partnerOrgAccess: activeAuth.partnerOrgAccess } : {}),
        // Mirrors buildOrgAccessClosures in middleware/auth.ts: canAccessOrg is a
        // required member of AuthContext that both real constructors always set,
        // so a stub that omits it makes the route throw instead of authorizing.
        canAccessOrg: (orgId: string) => activeAuth!.accessibleOrgIds.includes(orgId),
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
import { softwareCatalog, softwareVersions } from '../../db/schema';
import { createPartner, createOrganization } from './db-utils';

async function buildApp() {
  const { softwareRoutes } = await import('../../routes/software');
  const { authMiddleware } = await import('../../middleware/auth');
  const app = new Hono();
  app.use('*', authMiddleware as never);
  app.route('/software', softwareRoutes);
  return app;
}

/** Seed a partner-scoped built-in Huntress package + templated version (org_id NULL). */
async function seedBuiltin(partnerId: string) {
  const [catalog] = await getTestDb()
    .insert(softwareCatalog)
    .values({
      orgId: null,
      partnerId,
      integrationProvider: 'huntress',
      name: 'Huntress EDR Agent',
      vendor: 'Huntress',
      category: 'security',
      isManaged: true,
    })
    .returning();
  if (!catalog) throw new Error('failed to seed built-in catalog');
  const [version] = await getTestDb()
    .insert(softwareVersions)
    .values({
      catalogId: catalog.id,
      version: 'latest',
      downloadUrl: 'https://update.huntress.io/download/{huntress_acct_key}/HuntressInstaller.exe',
      fileType: 'exe',
      isLatest: true,
    })
    .returning();
  if (!version) throw new Error('failed to seed built-in version');
  return { catalog, version };
}

/** Seed a normal org-owned package + version (org_id set, partner_id NULL). */
async function seedOrgOwned(orgId: string) {
  const [catalog] = await getTestDb()
    .insert(softwareCatalog)
    .values({ orgId, name: 'Acme Tool', vendor: 'Acme', category: 'utility' })
    .returning();
  if (!catalog) throw new Error('failed to seed org-owned catalog');
  const [version] = await getTestDb()
    .insert(softwareVersions)
    .values({ catalogId: catalog.id, version: '1.0.0', fileType: 'exe', isLatest: true })
    .returning();
  if (!version) throw new Error('failed to seed org-owned version');
  return { catalog, version };
}

beforeEach(() => {
  activeAuth = null;
});

afterEach(() => {
  activeAuth = null;
  vi.clearAllMocks();
});

describe('built-in package versions via route (#1957)', () => {
  it('GET /catalog/:id/versions returns the built-in version for an org under its partner', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    activeAuth = { scope: 'organization', orgId: org.id, partnerId: partner.id, accessibleOrgIds: [org.id] };
    const { catalog } = await seedBuiltin(partner.id);

    const app = await buildApp();
    const res = await app.request(
      `/software/catalog/${catalog.id}/versions?orgId=${org.id}`,
      { headers: { Authorization: 'Bearer token' } },
    );

    // Before the fix this 404'd (eq(org_id) excludes the org_id-NULL built-in),
    // yielding the "No versions" / blank Versions tab.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].version).toBe('latest');
  });

  it('GET /catalog/:id returns the built-in item with versionCount for an org under its partner', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    activeAuth = { scope: 'organization', orgId: org.id, partnerId: partner.id, accessibleOrgIds: [org.id] };
    const { catalog } = await seedBuiltin(partner.id);

    const app = await buildApp();
    const res = await app.request(
      `/software/catalog/${catalog.id}?orgId=${org.id}`,
      { headers: { Authorization: 'Bearer token' } },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.integrationProvider).toBe('huntress');
    expect(Number(body.data.versionCount)).toBe(1);
  });

  // Regression guard for the dominant production path (MSP-uploaded custom
  // packages): the fix rewrote the WHERE clause for org-owned rows too, so prove
  // an org still reads its OWN org-scoped package. Nothing else (the mocked unit
  // suite ignores WHERE) covers this.
  it('GET /catalog/:id + /versions still return an org-owned (non-built-in) package', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    activeAuth = { scope: 'organization', orgId: org.id, partnerId: partner.id, accessibleOrgIds: [org.id] };
    const { catalog } = await seedOrgOwned(org.id);

    const app = await buildApp();
    const itemRes = await app.request(
      `/software/catalog/${catalog.id}?orgId=${org.id}`,
      { headers: { Authorization: 'Bearer token' } },
    );
    expect(itemRes.status).toBe(200);
    expect(Number((await itemRes.json()).data.versionCount)).toBe(1);

    const versionsRes = await app.request(
      `/software/catalog/${catalog.id}/versions?orgId=${org.id}`,
      { headers: { Authorization: 'Bearer token' } },
    );
    expect(versionsRes.status).toBe(200);
    expect((await versionsRes.json()).data).toHaveLength(1);
  });

  it('does NOT leak a built-in (or its versions) to an org under a DIFFERENT partner', async () => {
    const partnerA = await createPartner();
    const { catalog } = await seedBuiltin(partnerA.id);

    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });
    activeAuth = { scope: 'organization', orgId: orgB.id, partnerId: partnerB.id, accessibleOrgIds: [orgB.id] };

    const app = await buildApp();
    const versionsRes = await app.request(
      `/software/catalog/${catalog.id}/versions?orgId=${orgB.id}`,
      { headers: { Authorization: 'Bearer token' } },
    );
    expect(versionsRes.status).toBe(404);

    const itemRes = await app.request(
      `/software/catalog/${catalog.id}?orgId=${orgB.id}`,
      { headers: { Authorization: 'Bearer token' } },
    );
    expect(itemRes.status).toBe(404);
  });

  // Under PARTNER scope RLS exposes every org under the partner, so the JS guard
  // (item.orgId !== orgId) — dead code under org scope, where RLS pre-filters to
  // one org — is the ONLY thing stopping a partner caller from reading sibling
  // org B's package by id while scoped to org A. Proves that branch works, and
  // that the same partner's built-in is still readable.
  it('partner-scope caller: reads own built-in (200) but not a sibling org-owned package (404)', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const { catalog: builtin } = await seedBuiltin(partner.id);
    const { catalog: orgBPkg } = await seedOrgOwned(orgB.id);

    // Partner admin acting in org A's context (orgId=orgA) but with partner-wide
    // RLS visibility across both orgs.
    activeAuth = {
      scope: 'partner',
      orgId: null,
      partnerId: partner.id,
      accessibleOrgIds: [orgA.id, orgB.id],
    };

    const app = await buildApp();
    const builtinRes = await app.request(
      `/software/catalog/${builtin.id}/versions?orgId=${orgA.id}`,
      { headers: { Authorization: 'Bearer token' } },
    );
    expect(builtinRes.status).toBe(200);

    // org B's package is RLS-visible to this partner caller, but resolved orgId is
    // org A → the JS guard must reject the cross-org read.
    const siblingRes = await app.request(
      `/software/catalog/${orgBPkg.id}?orgId=${orgA.id}`,
      { headers: { Authorization: 'Bearer token' } },
    );
    expect(siblingRes.status).toBe(404);
  });

  // The All-organizations fleet view sends NO orgId, so nothing resolves and
  // the guard falls back to canAccessOrg. Pins the one place the rule is
  // intentionally wider than the resolved-org narrowing: a multi-org partner
  // caller with no org context can still read its built-ins AND any accessible
  // org's package — that's what the fleet view spans — while cross-partner rows
  // stay invisible (RLS).
  it('fleet view (partner scope, no orgId): reads built-in and own-org package, not cross-partner', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const { catalog: builtin } = await seedBuiltin(partner.id);
    const { catalog: orgBPkg } = await seedOrgOwned(orgB.id);

    const otherPartner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: otherPartner.id });
    const { catalog: foreignPkg } = await seedOrgOwned(otherOrg.id);

    // Two accessible orgs and no auth.orgId: resolveScopedOrgId has nothing to
    // resolve (the single-org shortcut must not fire), which is the fleet view.
    activeAuth = {
      scope: 'partner',
      orgId: null,
      partnerId: partner.id,
      accessibleOrgIds: [orgA.id, orgB.id],
    };

    const app = await buildApp();
    const builtinRes = await app.request(
      `/software/catalog/${builtin.id}/versions`,
      { headers: { Authorization: 'Bearer token' } },
    );
    expect(builtinRes.status).toBe(200);
    expect((await builtinRes.json()).data).toHaveLength(1);

    const orgPkgRes = await app.request(
      `/software/catalog/${orgBPkg.id}`,
      { headers: { Authorization: 'Bearer token' } },
    );
    expect(orgPkgRes.status).toBe(200);

    const foreignRes = await app.request(
      `/software/catalog/${foreignPkg.id}`,
      { headers: { Authorization: 'Bearer token' } },
    );
    expect(foreignRes.status).toBe(404);
  });

  // Same narrowing on the WRITE side (authorizeCatalogItemWrite): a partner
  // caller acting as org A must not mutate sibling org B's RLS-visible package,
  // while the same request against org B's own context succeeds.
  it('partner-scope caller: cannot PATCH a sibling org-owned package while acting as another org', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const { catalog: orgBPkg } = await seedOrgOwned(orgB.id);

    activeAuth = {
      scope: 'partner',
      orgId: null,
      partnerId: partner.id,
      accessibleOrgIds: [orgA.id, orgB.id],
    };

    const app = await buildApp();
    const crossRes = await app.request(
      `/software/catalog/${orgBPkg.id}?orgId=${orgA.id}`,
      {
        method: 'PATCH',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'tampered from org A context' }),
      },
    );
    expect(crossRes.status).toBe(404);

    const ownRes = await app.request(
      `/software/catalog/${orgBPkg.id}?orgId=${orgB.id}`,
      {
        method: 'PATCH',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'legitimate update in org B context' }),
      },
    );
    expect(ownRes.status).toBe(200);
  });
});

// #6958 PR C: software_catalog.builtin_package_key marks a Breeze-defined
// package. The DB, not only the routes, holds it to partner-owned rows, one
// per (partner, key), and an org-scoped session can never place one.
describe('software_catalog.builtin_package_key (#6958)', () => {
  const seedKeyed = (partnerId: string, key: string) =>
    getTestDb()
      .insert(softwareCatalog)
      .values({ orgId: null, partnerId, builtinPackageKey: key, name: `Built-in ${key}`, isManaged: true })
      .returning();

  it('CHECK rejects a key on an org-owned row, and a malformed key on a partner row', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    await expect(
      getTestDb().insert(softwareCatalog).values({ orgId: org.id, builtinPackageKey: 'controld_windows', name: 'x' }),
    ).rejects.toMatchObject({ cause: { code: '23514', constraint_name: 'software_catalog_builtin_package_key_chk' } });

    await expect(seedKeyed(partner.id, 'Bad-Key')).rejects.toMatchObject({
      cause: { code: '23514', constraint_name: 'software_catalog_builtin_package_key_chk' },
    });
  });

  it('the partial unique index allows one row per (partner, key), and the same key under another partner', async () => {
    const partner = await createPartner();
    const other = await createPartner();
    await seedKeyed(partner.id, 'controld_windows');

    await expect(seedKeyed(partner.id, 'controld_windows')).rejects.toMatchObject({
      cause: { code: '23505', constraint_name: 'software_catalog_partner_builtin_key_uidx' },
    });
    await expect(seedKeyed(other.id, 'controld_windows')).resolves.toHaveLength(1);
    // Rows without a key are unconstrained by the index.
    await getTestDb().insert(softwareCatalog).values({ orgId: null, partnerId: partner.id, name: 'Shared A' });
    await getTestDb().insert(softwareCatalog).values({ orgId: null, partnerId: partner.id, name: 'Shared B' });
  });

  it('an org-scope session cannot set the key: CHECK on its own row, RLS on the partner row', async () => {
    const { db, withDbAccessContext } = await import('../../db');
    const { eq } = await import('drizzle-orm');
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const { catalog: own } = await seedOrgOwned(org.id);
    const [builtin] = await getTestDb()
      .insert(softwareCatalog)
      .values({ orgId: null, partnerId: partner.id, name: 'Shared', isManaged: true })
      .returning();

    const orgContext = {
      scope: 'organization' as const,
      orgId: org.id,
      accessibleOrgIds: [org.id],
      accessiblePartnerIds: null,
      currentPartnerId: partner.id,
      userId: null,
    };

    await expect(
      withDbAccessContext(orgContext, () =>
        db.update(softwareCatalog).set({ builtinPackageKey: 'controld_windows' }).where(eq(softwareCatalog.id, own.id)),
      ),
    ).rejects.toMatchObject({ cause: { code: '23514' } });

    const touched = await withDbAccessContext(orgContext, () =>
      db.update(softwareCatalog)
        .set({ builtinPackageKey: 'controld_windows' })
        .where(eq(softwareCatalog.id, builtin!.id))
        .returning({ id: softwareCatalog.id }),
    );
    expect(touched).toEqual([]);

    const [after] = await getTestDb().select().from(softwareCatalog).where(eq(softwareCatalog.id, builtin!.id));
    expect(after!.builtinPackageKey).toBeNull();
  });

  it('GET /catalog returns builtinPackageKey and the latest version\'s installScriptsEnabled (real SQL)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [keyed] = await seedKeyed(partner.id, 'controld_windows');
    await getTestDb().insert(softwareVersions).values([
      { catalogId: keyed!.id, version: '1.0.0', fileType: 'zip', isLatest: false, installScriptsEnabled: false },
      { catalogId: keyed!.id, version: '1.5.8', fileType: 'zip', isLatest: true, installScriptsEnabled: true, postInstallScript: 'x' },
    ]);
    const { catalog: plain } = await seedOrgOwned(org.id); // latest version, scripts not enabled
    const [empty] = await getTestDb()
      .insert(softwareCatalog)
      .values({ orgId: org.id, name: 'No versions yet' })
      .returning();

    activeAuth = { scope: 'partner', orgId: null, partnerId: partner.id, accessibleOrgIds: [org.id] };
    const app = await buildApp();
    const res = await app.request(`/software/catalog?orgId=${org.id}&limit=100`, { headers: { Authorization: 'Bearer token' } });
    expect(res.status).toBe(200);
    const rows = (await res.json()).data as Array<Record<string, unknown>>;
    const byId = new Map(rows.map((r) => [r.id, r]));

    expect(byId.get(keyed!.id)).toMatchObject({ builtinPackageKey: 'controld_windows', installScriptsEnabled: true });
    expect(byId.get(plain.id)).toMatchObject({ builtinPackageKey: null, installScriptsEnabled: false });
    expect(byId.get(empty!.id)).toMatchObject({ builtinPackageKey: null, installScriptsEnabled: null });
  });

  it('a route write can never set it: POST /catalog drops the key, version create on a keyed row is 403', async () => {
    const { eq } = await import('drizzle-orm');
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [keyed] = await seedKeyed(partner.id, 'nextdns_windows');

    activeAuth = { scope: 'organization', orgId: org.id, partnerId: null, accessibleOrgIds: [org.id] };
    const app = await buildApp();

    const created = await app.request(`/software/catalog?orgId=${org.id}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Fake built-in', builtinPackageKey: 'controld_windows' }),
    });
    expect(created.status).toBe(201);
    const createdId = (await created.json()).data.id as string;
    const [row] = await getTestDb().select().from(softwareCatalog).where(eq(softwareCatalog.id, createdId));
    expect(row!.builtinPackageKey).toBeNull();

    activeAuth = { scope: 'partner', orgId: null, partnerId: partner.id, accessibleOrgIds: [org.id], partnerOrgAccess: 'all' };
    const versionRes = await app.request(`/software/catalog/${keyed!.id}/versions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: '9.9.9', downloadUrl: 'https://dl.example/nextdns.zip', supportedOs: ['windows'] }),
    });
    expect(versionRes.status).toBe(403);
    expect((await versionRes.json()).error).toMatch(/Built-in packages are managed by Breeze/);
    const versions = await getTestDb().select().from(softwareVersions).where(eq(softwareVersions.catalogId, keyed!.id));
    expect(versions).toEqual([]);
  });
});
