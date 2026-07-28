/**
 * Integration test — patch ingest status transitions against real Postgres.
 *
 * The pending-preservation guard in `upsertInstalledPatches` (#2725) is a raw
 * SQL CASE inside a Drizzle `onConflictDoUpdate`. The mocked unit suite
 * (`patches.test.ts`) can only assert the shape of the generated SQL object —
 * it cannot prove the CASE branches point the right way, that the untyped
 * `'installed'`/`'pending'` literals resolve against the real
 * `device_patch_status` enum, or that the sweep→installed self-heal sequence
 * works across the two real endpoints. This suite drives the actual
 * `patchesRoutes` handlers against the test DB under the same
 * `withDbAccessContext` shape `agentAuthMiddleware` sets up for agent routes.
 */
import '../../__tests__/integration/setup';
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { devices, patches, devicePatches } from '../../db/schema';
import { setupTestEnvironment } from '../../__tests__/integration/db-utils';
import { patchesRoutes } from './patches';

const runDb = it.runIf(!!process.env.DATABASE_URL);

/** The exact RLS context `agentAuthMiddleware` sets up for org-scoped agent routes. */
function agentRequestContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    currentPartnerId: null,
  };
}

async function insertDevice(orgId: string, siteId: string): Promise<{ id: string; agentId: string }> {
  const agentId = `agent-patches-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .insert(devices)
      .values({
        orgId,
        siteId,
        agentId,
        hostname: `patches-${agentId}`,
        osType: 'windows',
        osVersion: '11',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'online',
        enrolledAt: new Date(),
      })
      .returning({ id: devices.id });
    if (!row) throw new Error('insertDevice: no row');
    return { id: row.id, agentId };
  });
}

function mountRoutes(orgId: string, agentId: string) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('agent', { orgId, agentId, role: 'agent' } as never);
    await next();
  });
  app.route('/agents', patchesRoutes);
  return app;
}

async function putJson(app: Hono, orgId: string, path: string, body: unknown) {
  return withDbAccessContext(agentRequestContext(orgId), async () =>
    app.request(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

async function getDevicePatchRow(deviceId: string, externalId: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({
        status: devicePatches.status,
        installedAt: devicePatches.installedAt,
        installedVersion: devicePatches.installedVersion,
      })
      .from(devicePatches)
      .innerJoin(patches, eq(devicePatches.patchId, patches.id))
      .where(and(eq(devicePatches.deviceId, deviceId), eq(patches.externalId, externalId)));
    return row ?? null;
  });
}

describe('patch ingest — installed inventory must not erase pending rows (real Postgres, #2725)', () => {
  runDb('preserves a pending row through an installed submit, then heals it via the sweep', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const app = mountRoutes(env.organization.id, dev.agentId);
    // Unique per run: (source, externalId) is globally unique in `patches` and
    // cleanup between runs is not guaranteed.
    const externalId = `itest.winget.git-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const pkg = { name: 'Git', source: 'third_party', externalId, packageId: externalId };

    // 1. Pending scan reports an available upgrade.
    const pendingRes = await putJson(app, env.organization.id, `/agents/${dev.agentId}/patches/pending`, {
      source: 'third_party',
      patches: [{ ...pkg, version: '2.55.0.3' }],
    });
    expect(pendingRes.status).toBe(200);
    expect((await getDevicePatchRow(dev.id, externalId))?.status).toBe('pending');

    // 2. The paired installed inventory reports the same package at its
    //    currently-installed (older) version. Pre-#2725 this flipped the row
    //    to 'installed'; it must stay pending, with installedVersion updated
    //    and installedAt untouched.
    const installedRes = await putJson(app, env.organization.id, `/agents/${dev.agentId}/patches/installed`, {
      installed: [{ ...pkg, version: '2.51.0.2', installedAt: '2026-01-05T00:00:00Z' }],
    });
    expect(installedRes.status).toBe(200);
    const afterInstalled = await getDevicePatchRow(dev.id, externalId);
    expect(afterInstalled?.status).toBe('pending');
    expect(afterInstalled?.installedVersion).toBe('2.51.0.2');
    expect(afterInstalled?.installedAt).toBeNull();

    // 3. The upgrade completes: the next pending scan no longer reports the
    //    package, so the source-scoped sweep tombstones the row...
    const sweepRes = await putJson(app, env.organization.id, `/agents/${dev.agentId}/patches/pending`, {
      source: 'third_party',
      patches: [],
    });
    expect(sweepRes.status).toBe(200);
    expect((await getDevicePatchRow(dev.id, externalId))?.status).toBe('missing');

    // 4. ...and the paired installed submit flips it to 'installed' — proving
    //    the CASE guard preserves ONLY 'pending', not every non-installed state.
    const healRes = await putJson(app, env.organization.id, `/agents/${dev.agentId}/patches/installed`, {
      installed: [{ ...pkg, version: '2.55.0.3', installedAt: '2026-01-06T00:00:00Z' }],
    });
    expect(healRes.status).toBe(200);
    const healed = await getDevicePatchRow(dev.id, externalId);
    expect(healed?.status).toBe('installed');
    expect(healed?.installedVersion).toBe('2.55.0.3');
    expect(healed?.installedAt).not.toBeNull();
  });
});
