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
import { inArray } from 'drizzle-orm';

import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../db';
import { deviceCommands, devicePatches, patches, patchRollbacks } from '../db/schema';
import { buildOrgAccessClosures, dbAccessContextFromAuth, type AuthContext } from '../middleware/auth';
import { patchRoutes } from '../routes/patches/index';
import { createDevice, setupTestEnvironment } from '../__tests__/integration/db-utils';
import { executeTool } from './aiTools';
import { createAccessToken } from './jwt';

const REASON = 'Update broke the line-of-business app';

async function seed() {
  const env = await setupTestEnvironment();
  const orgId = env.organization.id;
  const deviceIds = [
    (await createDevice({ orgId, siteId: env.site.id })).id,
    (await createDevice({ orgId, siteId: env.site.id })).id,
  ];
  const patchId = await withSystemDbAccessContext(async () => {
    const [patch] = await db
      .insert(patches)
      .values({ source: 'microsoft', externalId: `KB-${randomUUID()}`, title: 'Rollback parity update' })
      .returning({ id: patches.id });
    await db.insert(devicePatches).values(deviceIds.map((deviceId) => ({ deviceId, orgId, patchId: patch!.id, status: 'installed' as const })));
    return patch!.id;
  });
  return { env, orgId, deviceIds, patchId };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

async function aiRollback({ env, orgId, deviceIds, patchId }: Fixture) {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([orgId]);
  const auth: AuthContext = {
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
  };
  const output = await runOutsideDbContext(() =>
    withDbAccessContext(dbAccessContextFromAuth(auth), () =>
      executeTool('manage_patches', { action: 'rollback', patchId, deviceIds, notes: REASON }, auth)));
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
});
