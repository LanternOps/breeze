/**
 * #12675: POST /software/catalog/import-package with `ownerScope: 'partner'`.
 *
 * Real tokens, real RLS context, real Postgres. Proves that the partner-wide
 * import writes a partner-owned row and its install methods, that the package
 * is readable and deployable in every organization of that partner, and that
 * another partner can neither read, extend nor deploy it.
 */
import './setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

vi.mock('../../services/auditEvents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/auditEvents')>()),
  writeRouteAudit: vi.fn(),
}));

import { getTestDb } from './setup';
import {
  assignUserToPartner,
  createDevice,
  createOrganization,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
  setupTestEnvironment,
} from './db-utils';
import { db, withDbAccessContext } from '../../db';
import {
  deploymentResults,
  deviceCommands,
  partnerUsers,
  softwareCatalog,
  softwareDeployments,
  softwareInstallMethods,
} from '../../db/schema';
import { createAccessToken } from '../../services/jwt';
import { writeRouteAudit } from '../../services/auditEvents';

const runDb = it.runIf(!!process.env.DATABASE_URL && !!process.env.DATABASE_URL_APP);

const METHODS = [
  { platform: 'windows', kind: 'winget', packageId: 'Synthetic.Shared' },
  { platform: 'macos', kind: 'homebrew_cask', packageId: 'synthetic-shared' },
];

async function tokenFor(params: {
  user: { id: string; email: string };
  roleId: string;
  scope: 'partner' | 'organization';
  partnerId: string;
  orgId: string | null;
}): Promise<string> {
  return createAccessToken({
    sub: params.user.id,
    email: params.user.email,
    roleId: params.roleId,
    orgId: params.orgId,
    partnerId: params.partnerId,
    scope: params.scope,
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  });
}

async function partnerEnv() {
  const env = await setupTestEnvironment({ scope: 'partner' });
  // A second organization, so no request resolves an org implicitly (the
  // single-accessible-org default in resolveScopedOrgId).
  const secondOrg = await createOrganization({ partnerId: env.partner.id });
  const token = await tokenFor({
    user: env.user,
    roleId: env.role.id,
    scope: 'partner',
    partnerId: env.partner.id,
    orgId: null,
  });
  return { ...env, secondOrg, token };
}
type PartnerEnv = Awaited<ReturnType<typeof partnerEnv>>;

async function buildClient() {
  const { softwareRoutes } = await import('../../routes/software');
  const app = new Hono();
  app.route('/software', softwareRoutes);
  return (token: string, method: string, path: string, body?: unknown) =>
    app.request(`/software${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}
type Client = Awaited<ReturnType<typeof buildClient>>;

const importBody = () => ({
  name: `Synthetic shared ${randomUUID()}`,
  methods: METHODS,
  ownerScope: 'partner',
});

async function importPartnerWide(call: Client, token: string, query = '') {
  const res = await call(token, 'POST', `/catalog/import-package${query}`, importBody());
  expect(res.status).toBe(201);
  const { data } = (await res.json()) as {
    data: { catalogItem: { id: string }; methods: Array<{ id: string }> };
  };
  return { catalogId: data.catalogItem.id, methodIds: data.methods.map((m) => m.id) };
}

async function listedIds(call: Client, token: string, query: string) {
  const res = await call(token, 'GET', `/catalog${query}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Array<{ id: string }> }).data.map((i) => i.id);
}

const deployBody = (catalogId: string, deviceId: string) => ({
  name: 'Synthetic deploy',
  catalogId,
  deploymentType: 'install',
  targetType: 'devices',
  targetIds: [deviceId],
  scheduleType: 'immediate',
});

async function windowsDevice(orgId: string) {
  const site = await createSite({ orgId });
  return createDevice({ orgId, siteId: site.id });
}

const partnerCtx = (env: PartnerEnv) => ({
  scope: 'partner' as const,
  orgId: null,
  accessibleOrgIds: [env.organization.id, env.secondOrg.id],
  accessiblePartnerIds: [env.partner.id],
  currentPartnerId: env.partner.id,
  userId: null,
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('partner-wide package-manager import (#12675)', () => {
  runDb('writes a partner-owned package and its methods in the All-organizations view', async () => {
    const call = await buildClient();
    const a = await partnerEnv();

    const { catalogId } = await importPartnerWide(call, a.token);

    const [row] = await getTestDb().select().from(softwareCatalog).where(eq(softwareCatalog.id, catalogId));
    expect(row).toMatchObject({
      orgId: null,
      partnerId: a.partner.id,
      integrationProvider: null,
      builtinPackageKey: null,
    });
    const methods = await getTestDb()
      .select()
      .from(softwareInstallMethods)
      .where(eq(softwareInstallMethods.catalogId, catalogId));
    expect(methods.map((m) => m.kind).sort()).toEqual(['homebrew_cask', 'winget']);
    expect(writeRouteAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'software.catalog.import', orgId: null, resourceId: catalogId }),
    );
  }, 60_000);

  runDb('stays partner-owned when the header has an organization selected', async () => {
    const call = await buildClient();
    const a = await partnerEnv();

    const { catalogId } = await importPartnerWide(call, a.token, `?orgId=${a.organization.id}`);

    const [row] = await getTestDb().select().from(softwareCatalog).where(eq(softwareCatalog.id, catalogId));
    expect(row).toMatchObject({ orgId: null, partnerId: a.partner.id });
  }, 60_000);

  runDb('refuses partner callers without full org access, and organization users', async () => {
    const call = await buildClient();
    const a = await partnerEnv();
    const partnerRole = await createRole({ scope: 'partner', partnerId: a.partner.id });
    await grantRolePermissions(partnerRole.id, [{ resource: '*', action: '*' }]);
    const limited = await createUser({ partnerId: a.partner.id, orgId: null });
    await assignUserToPartner(limited.id, a.partner.id, partnerRole.id, 'selected');
    const orgEnv = await setupTestEnvironment({ scope: 'organization' });
    const callers = [
      await tokenFor({
        user: limited,
        roleId: partnerRole.id,
        scope: 'partner',
        partnerId: a.partner.id,
        orgId: null,
      }),
      await tokenFor({
        user: orgEnv.user,
        roleId: orgEnv.role.id,
        scope: 'organization',
        partnerId: orgEnv.partner.id,
        orgId: orgEnv.organization.id,
      }),
    ];

    for (const token of callers) {
      const body = importBody();
      const res = await call(token, 'POST', '/catalog/import-package', body);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toMatch(/full partner org access/);
      expect(
        await getTestDb().select().from(softwareCatalog).where(eq(softwareCatalog.name, body.name)),
      ).toEqual([]);
    }
  }, 60_000);

  runDb('install-method writes on a partner-wide package take the same ownership check as the package routes', async () => {
    const call = await buildClient();
    const a = await partnerEnv();
    const { catalogId, methodIds } = await importPartnerWide(call, a.token);
    const [wingetId] = methodIds;

    // A same-partner member limited to ONE selected organization (it can reach
    // ?orgId= for that org), with every permission and MFA.
    const partnerRole = await createRole({ scope: 'partner', partnerId: a.partner.id });
    await grantRolePermissions(partnerRole.id, [{ resource: '*', action: '*' }]);
    const limited = await createUser({ partnerId: a.partner.id, orgId: null });
    await assignUserToPartner(limited.id, a.partner.id, partnerRole.id, 'selected');
    await getTestDb()
      .update(partnerUsers)
      .set({ orgIds: [a.organization.id] })
      .where(eq(partnerUsers.userId, limited.id));
    const limitedToken = await tokenFor({
      user: limited,
      roleId: partnerRole.id,
      scope: 'partner',
      partnerId: a.partner.id,
      orgId: null,
    });
    const inOrgA = `?orgId=${a.organization.id}`;

    // CONTROL: the limited caller does reach the package itself in its org.
    expect((await call(limitedToken, 'GET', `/catalog/${catalogId}/install-methods${inOrgA}`)).status).toBe(200);

    const methodsOf = (id: string) =>
      getTestDb().select().from(softwareInstallMethods).where(eq(softwareInstallMethods.catalogId, id)).orderBy(softwareInstallMethods.id);
    const before = await methodsOf(catalogId);

    const refused = [
      await call(limitedToken, 'POST', `/catalog/${catalogId}/install-methods${inOrgA}`, {
        platform: 'macos', kind: 'homebrew_formula', packageId: 'synthetic-limited',
      }),
      await call(limitedToken, 'PATCH', `/catalog/${catalogId}/install-methods/${wingetId}${inOrgA}`, {
        packageId: 'Synthetic.Limited',
      }),
      await call(limitedToken, 'DELETE', `/catalog/${catalogId}/install-methods/${wingetId}${inOrgA}`),
    ];
    for (const res of refused) {
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toMatch(/full partner org access/);
    }
    // Nothing changed: same rows, same package identifiers.
    expect(await methodsOf(catalogId)).toEqual(before);
    expect(writeRouteAudit).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: expect.stringMatching(/^software\.install_method\./) }),
    );

    // A full-partner caller still manages the same package's methods.
    const created = await call(a.token, 'POST', `/catalog/${catalogId}/install-methods${inOrgA}`, {
      platform: 'macos', kind: 'homebrew_formula', packageId: 'synthetic-full',
    });
    expect(created.status).toBe(201);
    const patched = await call(a.token, 'PATCH', `/catalog/${catalogId}/install-methods/${wingetId}${inOrgA}`, {
      packageId: 'Synthetic.Full',
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { data: { packageId: string } }).data.packageId).toBe('Synthetic.Full');
    const createdId = ((await created.json()) as { data: { id: string } }).data.id;
    expect((await call(a.token, 'DELETE', `/catalog/${catalogId}/install-methods/${createdId}${inOrgA}`)).status).toBe(200);

    // An organization-owned package in the limited caller's own org is unchanged:
    // that caller still creates, edits and deletes its methods.
    const orgRes = await call(a.token, 'POST', `/catalog/import-package${inOrgA}`, {
      name: `Synthetic org ${randomUUID()}`,
      methods: [METHODS[0]],
      ownerScope: 'organization',
    });
    expect(orgRes.status).toBe(201);
    const orgPkg = ((await orgRes.json()) as { data: { catalogItem: { id: string; orgId: string } } }).data.catalogItem;
    expect(orgPkg.orgId).toBe(a.organization.id);
    const orgCreated = await call(limitedToken, 'POST', `/catalog/${orgPkg.id}/install-methods${inOrgA}`, {
      platform: 'macos', kind: 'homebrew_cask', packageId: 'synthetic-org',
    });
    expect(orgCreated.status).toBe(201);
    const orgMethodId = ((await orgCreated.json()) as { data: { id: string } }).data.id;
    expect(
      (await call(limitedToken, 'PATCH', `/catalog/${orgPkg.id}/install-methods/${orgMethodId}${inOrgA}`, {
        packageId: 'synthetic-org-2',
      })).status,
    ).toBe(200);
    expect(
      (await call(limitedToken, 'DELETE', `/catalog/${orgPkg.id}/install-methods/${orgMethodId}${inOrgA}`)).status,
    ).toBe(200);
  }, 120_000);

  runDb('is listed, readable and deployable in every organization of the owning partner', async () => {
    const call = await buildClient();
    const a = await partnerEnv();
    const { catalogId, methodIds } = await importPartnerWide(call, a.token);

    // All-organizations list: the card counts the methods.
    const fleet = (await (await call(a.token, 'GET', '/catalog')).json()) as {
      data: Array<{ id: string; methodCount: number }>;
    };
    expect(Number(fleet.data.find((i) => i.id === catalogId)?.methodCount)).toBe(2);

    for (const org of [a.organization, a.secondOrg]) {
      const query = `?orgId=${org.id}`;
      expect(await listedIds(call, a.token, query)).toContain(catalogId);

      const methodsRes = await call(a.token, 'GET', `/catalog/${catalogId}/install-methods${query}`);
      expect(methodsRes.status).toBe(200);
      const methods = (await methodsRes.json()) as { data: Array<{ id: string }> };
      expect(methods.data.map((m) => m.id).sort()).toEqual([...methodIds].sort());

      const device = await windowsDevice(org.id);
      const deployRes = await call(a.token, 'POST', `/deployments${query}`, deployBody(catalogId, device.id));
      expect(deployRes.status).toBe(201);

      const [deployment] = await getTestDb()
        .select()
        .from(softwareDeployments)
        .where(eq(softwareDeployments.orgId, org.id));
      expect(methodIds).toContain(deployment!.installMethodId);
      const results = await getTestDb()
        .select()
        .from(deploymentResults)
        .where(eq(deploymentResults.deploymentId, deployment!.id));
      expect(results.map((r) => r.deviceId)).toEqual([device.id]);
      expect(results[0]!.status).not.toBe('failed');
      const commands = await getTestDb()
        .select()
        .from(deviceCommands)
        .where(and(eq(deviceCommands.deviceId, device.id), eq(deviceCommands.type, 'software_install')));
      expect(commands).toHaveLength(1);
      expect(commands[0]!.payload).toMatchObject({
        installMethod: { kind: 'winget', packageId: 'Synthetic.Shared' },
      });
    }
  }, 120_000);

  runDb('another partner can neither read nor deploy it', async () => {
    const call = await buildClient();
    const a = await partnerEnv();
    const b = await partnerEnv();
    const { catalogId } = await importPartnerWide(call, a.token);
    const deviceB = await windowsDevice(b.organization.id);
    const inOrgB = `?orgId=${b.organization.id}`;

    for (const query of ['', inOrgB]) {
      expect(await listedIds(call, b.token, query)).not.toContain(catalogId);
      expect((await call(b.token, 'GET', `/catalog/${catalogId}${query}`)).status).toBe(404);
      expect((await call(b.token, 'GET', `/catalog/${catalogId}/versions${query}`)).status).toBe(404);
    }
    expect((await call(b.token, 'GET', `/catalog/${catalogId}/install-methods${inOrgB}`)).status).toBe(404);
    const deploy = await call(b.token, 'POST', `/deployments${inOrgB}`, deployBody(catalogId, deviceB.id));
    expect(deploy.status).toBe(404);
    // Nor through one of the owning partner's organizations.
    const viaOrgA = await call(
      b.token,
      'POST',
      `/deployments?orgId=${a.organization.id}`,
      deployBody(catalogId, deviceB.id),
    );
    expect(viaOrgA.status).toBe(403);
    expect(
      await getTestDb().select().from(softwareDeployments).where(eq(softwareDeployments.orgId, b.organization.id)),
    ).toEqual([]);
  }, 120_000);

  runDb('RLS alone hides the package from another partner and refuses a forged method', async () => {
    const call = await buildClient();
    const a = await partnerEnv();
    const b = await partnerEnv();
    const { catalogId } = await importPartnerWide(call, a.token);
    const read = (env: PartnerEnv) =>
      withDbAccessContext(partnerCtx(env), async () => ({
        catalog: await db.select().from(softwareCatalog).where(eq(softwareCatalog.id, catalogId)),
        methods: await db
          .select()
          .from(softwareInstallMethods)
          .where(eq(softwareInstallMethods.catalogId, catalogId)),
      }));

    // CONTROL: the owning partner sees the rows through the same query.
    const own = await read(a);
    expect(own.catalog).toHaveLength(1);
    expect(own.methods).toHaveLength(2);
    expect(await read(b)).toEqual({ catalog: [], methods: [] });

    let code: string | undefined;
    try {
      await withDbAccessContext(partnerCtx(b), () =>
        db.insert(softwareInstallMethods).values({
          catalogId,
          platform: 'macos',
          kind: 'homebrew_formula',
          packageId: 'forged',
        }),
      );
    } catch (err) {
      const e = err as { code?: string; cause?: { code?: string } };
      code = e.code ?? e.cause?.code;
    }
    expect(code).toBe('42501');
  }, 60_000);
});
