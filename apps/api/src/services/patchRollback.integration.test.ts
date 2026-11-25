/**
 * Real-Postgres proof for #12492: the AI `manage_patches` rollback and
 * POST /patches/:id/rollback leave the same rows behind.
 *
 * Run:
 *   pnpm test-stack up            # from repo root
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/services/patchRollback.integration.test.ts
 */
import '../__tests__/integration/setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, inArray, sql } from 'drizzle-orm';

import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../db';
import { deviceCommands, devicePatches, organizationUsers, patches, patchRollbacks } from '../db/schema';
import { buildOrgAccessClosures, dbAccessContextFromAuth, siteAccessCheck, type AuthContext } from '../middleware/auth';
import { patchRoutes } from '../routes/patches/index';
import { createDevice, createOrganization, createSite, setupTestEnvironment } from '../__tests__/integration/db-utils';
import { executeTool } from './aiTools';
import { queueCommandForExecution } from './commandQueue';
import { createAccessToken } from './jwt';
import { queuePatchRollbacks } from './patchRollback';

const REASON = 'Update broke the line-of-business app';

const installPatch = (patchId: string, orgId: string, deviceIds: string[]) => withSystemDbAccessContext(() =>
  db.insert(devicePatches).values(deviceIds.map((deviceId) => ({ deviceId, orgId, patchId, status: 'installed' as const }))));

async function seed(deviceCount = 2) {
  const env = await setupTestEnvironment();
  const orgId = env.organization.id;
  const deviceIds: string[] = [];
  for (let i = 0; i < deviceCount; i++) deviceIds.push((await createDevice({ orgId, siteId: env.site.id })).id);
  const patchId = await withSystemDbAccessContext(async () => {
    const [patch] = await db
      .insert(patches)
      .values({ source: 'microsoft', externalId: `KB-${randomUUID()}`, title: 'Rollback parity update' })
      .returning({ id: patches.id });
    return patch!.id;
  });
  await installPatch(patchId, orgId, deviceIds);
  return { env, orgId, deviceIds, patchId };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

function aiAuth({ env, orgId }: Fixture, allowedSiteIds?: string[]): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([orgId]);
  return {
    principal: { kind: 'user_session' },
    aiOrigin: { kind: 'ai_assistant', sessionId: randomUUID() },
    user: { id: env.user.id, email: env.user.email, name: 'Rollback Tester', isPlatformAdmin: false },
    token: { sub: env.user.id, email: env.user.email, roleId: env.role.id, orgId, partnerId: env.partner.id, scope: 'organization', type: 'access', mfa: true },
    partnerId: env.partner.id,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition,
    canAccessOrg,
    ...(allowedSiteIds && { allowedSiteIds, canAccessSite: siteAccessCheck(allowedSiteIds) }),
  };
}

async function aiRollback(fx: Fixture, allowedSiteIds?: string[]) {
  const auth = aiAuth(fx, allowedSiteIds);
  const output = await runOutsideDbContext(() =>
    withDbAccessContext(dbAccessContextFromAuth(auth), () =>
      executeTool('manage_patches', { action: 'rollback', patchId: fx.patchId, deviceIds: fx.deviceIds, notes: REASON }, auth)));
  return JSON.parse(output) as { success?: boolean; queued?: unknown[]; error?: string };
}

async function restRollback({ env, orgId, deviceIds, patchId }: Fixture) {
  const app = new Hono().route('/patches', patchRoutes);
  const token = await createAccessToken({
    sub: env.user.id, email: env.user.email, roleId: env.role.id, orgId, partnerId: env.partner.id,
    scope: 'organization', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
  const res = await app.request(`/patches/${patchId}/rollback`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceIds, reason: REASON }),
  });
  return { status: res.status, body: (await res.json()) as { success?: boolean; queuedCommandIds?: string[] } };
}

const rowsFor = (deviceIds: string[]) => withSystemDbAccessContext(async () => ({
  rollbacks: await db.select().from(patchRollbacks).where(inArray(patchRollbacks.deviceId, deviceIds)),
  commands: await db
    .select({ id: deviceCommands.id, deviceId: deviceCommands.deviceId, type: deviceCommands.type, payload: deviceCommands.payload })
    .from(deviceCommands)
    .where(inArray(deviceCommands.deviceId, deviceIds)),
}));

describe('patch rollback on real Postgres (#12492)', () => {
  it('AI rollback queues a rollback_patches command and a pending patch_rollbacks row for each of two devices', async () => {
    const fx = await seed();

    const result = await aiRollback(fx);

    const { rollbacks, commands } = await rowsFor(fx.deviceIds);
    expect(commands.filter((c) => c.type === 'rollback_patches').map((c) => c.deviceId).sort()).toEqual([...fx.deviceIds].sort());
    expect(rollbacks.map((r) => r.deviceId).sort()).toEqual([...fx.deviceIds].sort());
    for (const row of rollbacks) {
      expect(row).toMatchObject({ patchId: fx.patchId, status: 'pending', initiatedBy: fx.env.user.id, reason: REASON });
    }
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.queued).toHaveLength(2);
  });

  it('REST and AI rollback of the same request leave identical rows apart from ids and timestamps', async () => {
    const fx = await seed();

    expect((await aiRollback(fx)).success).toBe(true);
    const ai = await rowsFor(fx.deviceIds);
    const rest = await restRollback(fx);
    expect(rest.status, JSON.stringify(rest.body)).toBe(200);
    expect(rest.body.queuedCommandIds).toHaveLength(2);
    const all = await rowsFor(fx.deviceIds);

    const aiIds = new Set([...ai.rollbacks, ...ai.commands].map((r) => r.id));
    const shape = (rows: Array<Record<string, unknown>>) => rows
      .map(({ id: _id, createdAt: _createdAt, ...rest }) => rest)
      .sort((a, b) => String(a.deviceId).localeCompare(String(b.deviceId)));
    const restRollbacks = all.rollbacks.filter((r) => !aiIds.has(r.id));
    const restCommands = all.commands.filter((r) => !aiIds.has(r.id));
    expect(restRollbacks).toHaveLength(2);
    expect(shape(restRollbacks)).toEqual(shape(ai.rollbacks));
    expect(shape(restCommands)).toEqual(shape(ai.commands));
  });

  it('a real statement error on the third of five devices rolls back only that device; the other four keep their command and row', async () => {
    const fx = await seed(5);
    const failing = fx.deviceIds[2]!;

    const result = await runOutsideDbContext(() =>
      withDbAccessContext(dbAccessContextFromAuth(aiAuth(fx)), () => queuePatchRollbacks({
        patchId: fx.patchId,
        deviceIds: fx.deviceIds,
        reason: REASON,
        initiatedBy: fx.env.user.id,
        canAccess: () => true,
        queue: async (d, type, payload) => {
          if (d.id === failing) await db.execute(sql`SELECT 1/0`);
          return queueCommandForExecution(d.id, type, payload, { userId: fx.env.user.id });
        },
      })));

    const others = fx.deviceIds.filter((id) => id !== failing).sort();
    const { rollbacks, commands } = await rowsFor(fx.deviceIds);
    expect(commands.map((c) => c.deviceId).sort()).toEqual(others);
    expect(rollbacks.map((r) => r.deviceId).sort()).toEqual(others);
    expect(result!.failed).toEqual([{ deviceId: failing, error: 'Rollback command was not queued' }]);
  });

  it.each(['another org', 'another site'] as const)('a listed device in %s gets no command and no row from AI or REST', async (where) => {
    const base = await seed();
    const strangerOrgId = where === 'another org' ? (await createOrganization({ partnerId: base.env.partner.id })).id : base.orgId;
    const stranger = (await createDevice({ orgId: strangerOrgId, siteId: (await createSite({ orgId: strangerOrgId })).id })).id;
    await installPatch(base.patchId, strangerOrgId, [stranger]);
    const fx = { ...base, deviceIds: [...base.deviceIds, stranger] };
    const sites = where === 'another site' ? [fx.env.site.id] : undefined;
    if (sites) {
      await withSystemDbAccessContext(() =>
        db.update(organizationUsers).set({ siteIds: sites }).where(eq(organizationUsers.userId, fx.env.user.id)));
    }
    const nothing = { rollbacks: [], commands: [] };

    const ai = await aiRollback(fx, sites);
    expect(await rowsFor([stranger]), JSON.stringify(ai)).toEqual(nothing);

    const rest = await restRollback(fx);
    expect(await rowsFor([stranger])).toEqual(nothing);
    expect(rest.body.queuedCommandIds, JSON.stringify(rest.body)).toHaveLength(2);
  });
});
