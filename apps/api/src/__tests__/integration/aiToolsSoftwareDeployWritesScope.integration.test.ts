/**
 * Integration test — W12 (#6782) manage_software_deployments and manage_software_catalog honour the org axis, the
 * site axis, the exact-device axis and the partner-wide gate against real Postgres as the unprivileged `breeze_app`
 * role (org-axis RLS genuinely enforced; the site / device axes and the partner-wide gate are app-layer).
 *
 * Entry point: `executeTool`, so the central `deviceArgs` gate runs before the handler exactly as in production.
 * `create` / `retry` are self-managed (#7347): they are called with NO ambient DB context, as the SDK wrapper does.
 * The human approval step lives in the chat layer (unit-tested in aiGuardrails.*): this suite pins the CLASS each
 * write is raised at (`checkGuardrails`) and then tests the scope behaviour that runs AFTER approval. The effect
 * digest (W12-D12) is computed by the real resolver against the real DB, in the system context intentService uses.
 *
 * Every refusal has a CONTROL: the same call by the caller the guard admits lands, and the stored row proves it.
 * Only the retry re-dispatch fan-out (`buildAndDispatchSoftwareInstalls`) is stubbed; deployment creates are
 * scheduled in the future so nothing is pushed to an agent.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
  fanout: vi.fn(async (opts: { deviceIds: string[] }) => ({ status: 'pending' as const, dispatchedDeviceIds: opts.deviceIds, deviceResults: [] })),
}));
vi.mock('../../services/softwareDeployment', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  buildAndDispatchSoftwareInstalls: mocks.fanout,
}));

import type { DbAccessContext } from '../../db';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  deploymentResults, devices, softwareCatalog, softwareDeployments, softwareInstallMethods, softwareVersions,
} from '../../db/schema';
import { executeTool } from '../../services/aiTools';
import { checkGuardrails } from '../../services/aiGuardrails';
import { computeEffectDigestOutcome } from '../../services/actionIntents/effectDigest';
import { fingerprintSoftwareVersionDependency } from '../../services/softwareDependencyIdentity';
import { clearPermissionCache } from '../../services/permissions';
import { buildDbAccessContext, type AuthContext } from '../../middleware/auth';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
type Who = 'restricted' | 'orgAdmin' | 'otherOrg' | 'partnerAll' | 'partnerSel';

function makeAuth(opts: {
  userId: string; partnerId: string; orgIds: string[]; scope?: 'organization' | 'partner';
  partnerOrgAccess?: 'all' | 'selected'; allowedSiteIds?: string[]; allowedDeviceIds?: string[];
}): AuthContext {
  const { allowedSiteIds, orgIds } = opts;
  const scope = opts.scope ?? 'organization';
  return {
    principal: { kind: 'user_session' },
    user: { id: opts.userId, email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: { mfa: true } as AuthContext['token'],
    partnerId: opts.partnerId,
    orgId: scope === 'organization' ? orgIds[0]! : null,
    scope,
    partnerOrgAccess: opts.partnerOrgAccess,
    accessibleOrgIds: orgIds,
    orgCondition: (col: any) => inArray(col, orgIds),
    canAccessOrg: (id: string) => orgIds.includes(id),
    allowedSiteIds,
    allowedDeviceIds: opts.allowedDeviceIds,
    canAccessSite: (s: string | null | undefined) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
    aiOrigin: { kind: 'ai_assistant', sessionId: 'w12-software-deploy-writes' },
  } as unknown as AuthContext;
}

interface Fixture {
  partnerId: string; orgA: string; orgB: string; userId: string; siteA: string; siteB: string;
  devA: string; devB: string; devOther: string;
  catA: string; v1: string; v2: string; catB: string; vB: string; catWide: string;
  auth: Record<Who, AuthContext>;
}

async function seedDevice(orgId: string, siteId: string): Promise<string> {
  const [row] = await getTestDb().insert(devices).values({
    orgId, siteId, agentId: `w12-dep-${randomUUID()}`, hostname: `w12d-${randomUUID().slice(0, 8)}`,
    osType: 'windows', osVersion: '11', architecture: 'amd64', agentVersion: '1.0.0', status: 'online',
  }).returning({ id: devices.id });
  return row!.id;
}

async function seedFixture(): Promise<Fixture> {
  const db0 = getTestDb();
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: orgA.id, name: 'W12 A' });
  const siteB = await createSite({ orgId: orgA.id, name: 'W12 B' });
  const siteOther = await createSite({ orgId: orgB.id, name: 'W12 other' });
  const user = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `w12-${randomUUID()}@example.com` });
  const catalog = async (v: { orgId: string | null; partnerId: string | null; name: string }) => {
    const [row] = await db0.insert(softwareCatalog).values(v).returning({ id: softwareCatalog.id });
    return row!.id;
  };
  const version = async (catalogId: string, ver: string, isLatest: boolean) => {
    const [row] = await db0.insert(softwareVersions).values({
      catalogId, version: ver, isLatest, downloadUrl: `https://downloads.example.invalid/pkg-${ver}.msi`, fileType: 'msi',
    } as typeof softwareVersions.$inferInsert).returning({ id: softwareVersions.id });
    return row!.id;
  };
  const catA = await catalog({ orgId: orgA.id, partnerId: null, name: 'W12 pkg A' });
  const catB = await catalog({ orgId: orgB.id, partnerId: null, name: 'W12 pkg B' });
  const catWide = await catalog({ orgId: null, partnerId: partner.id, name: 'W12 partner-wide pkg' });
  const base = { userId: user.id, partnerId: partner.id };
  return {
    partnerId: partner.id, orgA: orgA.id, orgB: orgB.id, userId: user.id, siteA: siteA.id, siteB: siteB.id,
    devA: await seedDevice(orgA.id, siteA.id),
    devB: await seedDevice(orgA.id, siteB.id),
    devOther: await seedDevice(orgB.id, siteOther.id),
    catA, v1: await version(catA, '1.0.0', true), v2: await version(catA, '2.0.0', false),
    catB, vB: await version(catB, '9.0.0', true), catWide,
    auth: {
      restricted: makeAuth({ ...base, orgIds: [orgA.id], allowedSiteIds: [siteA.id] }),
      orgAdmin: makeAuth({ ...base, orgIds: [orgA.id] }),
      otherOrg: makeAuth({ ...base, orgIds: [orgB.id] }),
      partnerAll: makeAuth({ ...base, orgIds: [orgA.id, orgB.id], scope: 'partner', partnerOrgAccess: 'all' }),
      partnerSel: makeAuth({ ...base, orgIds: [orgA.id], scope: 'partner', partnerOrgAccess: 'selected' }),
    },
  };
}

function ctxFor(f: Fixture, auth: AuthContext): DbAccessContext {
  return buildDbAccessContext({
    scope: auth.scope, orgId: auth.orgId, accessibleOrgIds: auth.accessibleOrgIds ?? [], partnerId: f.partnerId, userId: auth.user.id,
  });
}

/** An ordinary (context-holding) tool call, as the chat wrapper makes it. */
async function run(f: Fixture, who: Who, tool: string, input: Record<string, unknown>, auth: AuthContext = f.auth[who]) {
  const raw = await withDbAccessContext(ctxFor(f, auth), () => executeTool(tool, input, auth));
  return { raw, body: JSON.parse(raw) as Record<string, any> };
}

/** A self-managed action (`create` / `retry`): no ambient context, exactly as the SDK wrapper calls it. */
async function runSelf(auth: AuthContext, input: Record<string, unknown>) {
  const raw = await executeTool('manage_software_deployments', input, auth);
  return { raw, body: JSON.parse(raw) as Record<string, any> };
}

const futureIso = () => new Date(Date.now() + 86_400_000).toISOString();
const deploymentsOf = (orgId: string) => getTestDb().select().from(softwareDeployments).where(eq(softwareDeployments.orgId, orgId));
const resultsOf = (deploymentId: string) => getTestDb().select().from(deploymentResults).where(eq(deploymentResults.deploymentId, deploymentId));
const versionRow = async (id: string) => (await getTestDb().select().from(softwareVersions).where(eq(softwareVersions.id, id)))[0]!;
const catalogRow = async (id: string) => (await getTestDb().select().from(softwareCatalog).where(eq(softwareCatalog.id, id)))[0];

let f: Fixture;
beforeEach(async () => {
  clearPermissionCache();
  mocks.fanout.mockClear();
  f = await seedFixture();
});

describe('the class each write is raised at (pinned here as well as in the guardrail contract)', () => {
  runDb('deployment create/retry and installer edits are supervised; cancel and a plain catalog create are t2; partner-wide create supervised', () => {
    expect(checkGuardrails('manage_software_deployments', { action: 'create' })).toMatchObject({ tier: 3, approvalScope: 'supervised' });
    expect(checkGuardrails('manage_software_deployments', { action: 'retry' })).toMatchObject({ tier: 3, approvalScope: 'supervised' });
    expect(checkGuardrails('manage_software_deployments', { action: 'cancel' })).toMatchObject({ tier: 2 });
    expect(checkGuardrails('manage_software_catalog', { action: 'promote_version' })).toMatchObject({ tier: 3, approvalScope: 'supervised' });
    expect(checkGuardrails('manage_software_catalog', { action: 'create' })).toMatchObject({ tier: 2 });
    expect(checkGuardrails('manage_software_catalog', { action: 'create', ownerScope: 'partner' })).toMatchObject({ tier: 3, approvalScope: 'supervised' });
  });
});

describe('manage_software_deployments:create', () => {
  const create = (deviceIds: string[], extra: Record<string, unknown> = {}) => ({
    action: 'create', name: 'W12 deploy', softwareVersionId: f.v1, deviceIds, scheduleType: 'scheduled', scheduledAt: futureIso(), ...extra,
  });

  runDb('an out-of-site device (alone or mixed with an in-site one) is refused and writes no deployment (CONTROL: in-site lands)', async () => {
    const outOfSite = await runSelf(f.auth.restricted, create([f.devB]));
    expect(outOfSite.body.error, outOfSite.raw).toBeTruthy();
    const mixed = await runSelf(f.auth.restricted, create([f.devA, f.devB]));
    expect(mixed.body.error, mixed.raw).toBeTruthy();
    const foreign = await runSelf(f.auth.restricted, create([f.devOther]));
    expect(foreign.body.error, foreign.raw).toBeTruthy();
    expect(await deploymentsOf(f.orgA)).toHaveLength(0);
    expect(await deploymentsOf(f.orgB)).toHaveLength(0);

    const ok = await runSelf(f.auth.restricted, create([f.devA]));
    expect(ok.body.error, ok.raw).toBeUndefined();
    const rows = await deploymentsOf(f.orgA);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orgId: f.orgA, softwareVersionId: f.v1, deploymentType: 'install', targetType: 'devices', createdBy: f.userId });
    expect((await resultsOf(rows[0]!.id)).map((r) => r.deviceId)).toEqual([f.devA]);
  });

  runDb('a device-bound session cannot target a device outside its allowlist (CONTROL: its own device lands)', async () => {
    const bound = { ...f.auth.orgAdmin, allowedDeviceIds: [f.devA] } as unknown as AuthContext;
    const refused = await runSelf(bound, create([f.devB]));
    expect(refused.body.error, refused.raw).toBeTruthy();
    expect(await deploymentsOf(f.orgA)).toHaveLength(0);
    const ok = await runSelf(bound, create([f.devA]));
    expect(ok.body.error, ok.raw).toBeUndefined();
    expect(await deploymentsOf(f.orgA)).toHaveLength(1);
  });

  runDb('another org\'s catalog version is not deployable (RLS hides it), and created_by is NULL for a non-users caller (W12-D3)', async () => {
    const foreignVersion = await runSelf(f.auth.orgAdmin, create([f.devA], { softwareVersionId: f.vB }));
    expect(foreignVersion.body.error, foreignVersion.raw).toBeTruthy();
    expect(await deploymentsOf(f.orgA)).toHaveLength(0);
    const synthetic = makeAuth({ userId: randomUUID(), partnerId: f.partnerId, orgIds: [f.orgA] });
    const ok = await runSelf(synthetic, create([f.devA]));
    expect(ok.body.error, ok.raw).toBeUndefined();
    const rows = await deploymentsOf(f.orgA);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.createdBy).toBeNull();
  });
});

describe('manage_software_deployments:retry', () => {
  async function seedFailedDeployment(): Promise<string> {
    const testDb = getTestDb();
    const v = await versionRow(f.v1);
    const c = (await catalogRow(f.catA))!;
    const [dep] = await testDb.insert(softwareDeployments).values({
      orgId: f.orgA, name: 'W12 failed run', softwareVersionId: f.v1, deploymentType: 'install', targetType: 'devices',
      targetIds: [f.devA, f.devB], scheduleType: 'immediate', dispatchedAt: new Date(),
      dependencyFingerprint: fingerprintSoftwareVersionDependency(v, c),
    } as typeof softwareDeployments.$inferInsert).returning({ id: softwareDeployments.id });
    await testDb.insert(deploymentResults).values([
      { deploymentId: dep!.id, deviceId: f.devA, status: 'failed', errorMessage: 'exit 1603' },
      { deploymentId: dep!.id, deviceId: f.devB, status: 'failed', errorMessage: 'exit 1603' },
    ]);
    return dep!.id;
  }
  const stillFailed = async (deploymentId: string) =>
    (await resultsOf(deploymentId)).every((r) => r.status === 'failed' && r.retryCount === 0);

  runDb('a device-bound session cannot retry a deployment that includes a device outside its allowlist (CONTROL: unbound org admin retries both)', async () => {
    const deploymentId = await seedFailedDeployment();
    const bound = { ...f.auth.orgAdmin, allowedDeviceIds: [f.devA] } as unknown as AuthContext;
    const refused = await runSelf(bound, { action: 'retry', deploymentId });
    expect(refused.body.code, refused.raw).toBe('NOT_FOUND');
    // Even when it names only its own device.
    const narrowed = await runSelf(bound, { action: 'retry', deploymentId, deviceIds: [f.devA] });
    expect(narrowed.body.code, narrowed.raw).toBe('NOT_FOUND');
    expect(await stillFailed(deploymentId)).toBe(true);
    expect(mocks.fanout).not.toHaveBeenCalled();

    const ok = await runSelf(f.auth.orgAdmin, { action: 'retry', deploymentId });
    expect((ok.body.retriedDeviceIds as string[] | undefined)?.sort(), ok.raw).toEqual([f.devA, f.devB].sort());
    const rows = await resultsOf(deploymentId);
    expect(rows.every((r) => r.status === 'pending' && r.retryCount === 1)).toBe(true);
    expect(mocks.fanout).toHaveBeenCalledTimes(1);
  });

  runDb('a site-restricted caller cannot retry a deployment that spans a site outside its allowlist', async () => {
    const deploymentId = await seedFailedDeployment();
    const refused = await runSelf(f.auth.restricted, { action: 'retry', deploymentId });
    expect(refused.body.code, refused.raw).toBe('NOT_FOUND');
    expect(await stillFailed(deploymentId)).toBe(true);
    expect(mocks.fanout).not.toHaveBeenCalled();
  });
});

describe('manage_software_catalog', () => {
  runDb('promote_version on another org\'s package is not found and changes nothing (CONTROL: its own org promotes, is_latest flips)', async () => {
    const foreign = await run(f, 'otherOrg', 'manage_software_catalog', { action: 'promote_version', catalogId: f.catA, versionId: f.v2 });
    expect(foreign.body.code, foreign.raw).toBe('NOT_FOUND');
    expect((await versionRow(f.v1)).isLatest).toBe(true);
    expect((await versionRow(f.v2)).isLatest).toBe(false);
    // A version id from another package is not found either.
    const crossed = await run(f, 'orgAdmin', 'manage_software_catalog', { action: 'promote_version', catalogId: f.catA, versionId: f.vB });
    expect(crossed.body.code, crossed.raw).toBe('NOT_FOUND');
    expect((await versionRow(f.vB)).isLatest).toBe(true);

    const own = await run(f, 'orgAdmin', 'manage_software_catalog', { action: 'promote_version', catalogId: f.catA, versionId: f.v2 });
    expect(own.body.version?.id, own.raw).toBe(f.v2);
    expect((await versionRow(f.v2)).isLatest).toBe(true);
    expect((await versionRow(f.v1)).isLatest).toBe(false);
  });

  runDb('a site-restricted caller cannot promote (org-wide catalog state, W12-D4)', async () => {
    const out = await run(f, 'restricted', 'manage_software_catalog', { action: 'promote_version', catalogId: f.catA, versionId: f.v2 });
    expect(out.body.code, out.raw).toBe('ACCESS_DENIED');
    expect((await versionRow(f.v2)).isLatest).toBe(false);
  });

  runDb('a partner-wide create needs full partner org access (CONTROL: partnerAll lands it with org_id NULL)', async () => {
    const named = (name: string) => getTestDb().select().from(softwareCatalog).where(eq(softwareCatalog.name, name));
    const sel = await run(f, 'partnerSel', 'manage_software_catalog', { action: 'create', name: 'W12 wide sel', ownerScope: 'partner' });
    expect(sel.body.code, sel.raw).toBe('ACCESS_DENIED');
    expect(await named('W12 wide sel')).toHaveLength(0);
    const org = await run(f, 'orgAdmin', 'manage_software_catalog', { action: 'create', name: 'W12 wide org', ownerScope: 'partner' });
    expect(org.body.code, org.raw).toBe('ACCESS_DENIED');
    expect(await named('W12 wide org')).toHaveLength(0);

    const all = await run(f, 'partnerAll', 'manage_software_catalog', { action: 'create', name: 'W12 wide all', ownerScope: 'partner' });
    expect(all.body.package?.ownership, all.raw).toBe('partner');
    const rows = await named('W12 wide all');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orgId: null, partnerId: f.partnerId });
  });

  runDb('an EXISTING partner-wide package is never modified, even by a full partner admin (CONTROL: an org package updates)', async () => {
    for (const input of [
      { action: 'update', catalogId: f.catWide, name: 'hijack' },
      { action: 'add_version', catalogId: f.catWide, version: '6.6.6', downloadUrl: 'https://evil.example.invalid/x.msi', fileType: 'msi' },
      { action: 'archive', catalogId: f.catWide },
    ]) {
      const out = await run(f, 'partnerAll', 'manage_software_catalog', input);
      expect(out.body.code, out.raw).toBe('ACCESS_DENIED');
    }
    const wide = await catalogRow(f.catWide);
    expect(wide).toMatchObject({ name: 'W12 partner-wide pkg', deletedAt: null });
    expect(await getTestDb().select().from(softwareVersions).where(eq(softwareVersions.catalogId, f.catWide))).toHaveLength(0);

    const own = await run(f, 'orgAdmin', 'manage_software_catalog', { action: 'update', catalogId: f.catA, vendor: 'W12 Vendor' });
    expect(own.body.package?.vendor, own.raw).toBe('W12 Vendor');
    expect((await catalogRow(f.catA))!.vendor).toBe('W12 Vendor');
  });
});

describe('the manage_software_deployments:create effect digest (W12-D12) against the real DB', () => {
  const digest = (args: Record<string, unknown>) =>
    withSystemDbAccessContext(() => computeEffectDigestOutcome('manage_software_deployments', { action: 'create', ...args }, db));

  runDb('a version\'s downloadUrl edit changes the digest; an unrelated version does not', async () => {
    const args = { softwareVersionId: f.v1, deviceIds: [f.devA] };
    const first = await digest(args);
    expect(first.kind).toBe('pinned');
    expect(await digest(args)).toEqual(first);
    // Editing a DIFFERENT version of the same package leaves this pin alone.
    await getTestDb().update(softwareVersions).set({ downloadUrl: 'https://downloads.example.invalid/other.msi' }).where(eq(softwareVersions.id, f.v2));
    expect(await digest(args)).toEqual(first);

    await getTestDb().update(softwareVersions).set({ downloadUrl: 'https://downloads.example.invalid/pkg-1.0.0-SWAPPED.msi' }).where(eq(softwareVersions.id, f.v1));
    const second = await digest(args);
    expect(second.kind).toBe('pinned');
    expect(second).not.toEqual(first);
  });

  runDb('a catalog deploy pins its enabled install methods: adding or disabling one changes the digest', async () => {
    const [m] = await getTestDb().insert(softwareInstallMethods).values({
      catalogId: f.catA, platform: 'windows', kind: 'winget', packageId: 'W12.PackageA', enabled: true,
    }).returning({ id: softwareInstallMethods.id });
    const args = { catalogId: f.catA, deviceIds: [f.devA] };
    const first = await digest(args);
    expect(first.kind).toBe('pinned');
    await getTestDb().update(softwareInstallMethods).set({ packageId: 'W12.PackageA.Evil' }).where(eq(softwareInstallMethods.id, m!.id));
    const second = await digest(args);
    expect(second).not.toEqual(first);
    await getTestDb().update(softwareInstallMethods).set({ enabled: false }).where(eq(softwareInstallMethods.id, m!.id));
    const third = await digest(args);
    expect(third).not.toEqual(second);
    // An archived package is unresolved, never silently pinned.
    await getTestDb().update(softwareCatalog).set({ deletedAt: new Date() }).where(and(eq(softwareCatalog.id, f.catA)));
    expect(await digest(args)).toEqual({ kind: 'unresolved', reason: 'target_absent' });
  });
});
