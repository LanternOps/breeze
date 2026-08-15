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

async function getPatchRow(externalId: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(patches).where(eq(patches.externalId, externalId));
    return row ?? null;
  });
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

/**
 * `patches` is a GLOBAL, un-tenanted catalog table deduped on
 * `(source, external_id)`: every device that reports a colliding key writes the
 * SAME row, and every tenant's UI, `patch_approvals` and patch jobs read it.
 * The conflict-update classification (identity columns fill-only, operational
 * columns refresh) is expressed as raw `COALESCE`/`CASE` fragments inside
 * Drizzle's `onConflictDoUpdate`, which the mocked unit suite can only inspect
 * as an object shape. These cases drive the real endpoints against Postgres so
 * the fragments are proven to point the right way.
 */
describe('patch ingest — shared catalog metadata must not be clobbered (real Postgres)', () => {
  runDb('keeps identity columns from the first report while operational columns keep refreshing', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const first = await insertDevice(env.organization.id, env.site.id);
    const second = await insertDevice(env.organization.id, env.site.id);
    const externalId = `itest.clobber.${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const firstRes = await putJson(
      mountRoutes(env.organization.id, first.agentId),
      env.organization.id,
      `/agents/${first.agentId}/patches/pending`,
      {
        source: 'third_party',
        patches: [{
          name: 'Mozilla Firefox',
          source: 'third_party',
          externalId,
          packageId: 'Mozilla.Firefox',
          vendor: 'Mozilla',
          version: '121.0',
          severity: 'critical',
          category: 'security',
          requiresRestart: true,
          description: 'Original vendor description',
        }],
      },
    );
    expect(firstRes.status).toBe(200);

    // A second device reports the same (source, externalId) with entirely
    // different metadata — the shape that used to rewrite the shared row.
    const secondRes = await putJson(
      mountRoutes(env.organization.id, second.agentId),
      env.organization.id,
      `/agents/${second.agentId}/patches/pending`,
      {
        source: 'third_party',
        patches: [{
          name: 'Totally Different Product',
          source: 'third_party',
          externalId,
          packageId: 'Attacker.Package',
          vendor: 'Someone Else',
          version: '122.0',
          severity: 'low',
          category: 'application',
          requiresRestart: false,
          description: 'Rewritten description',
        }],
      },
    );
    expect(secondRes.status).toBe(200);

    const row = await getPatchRow(externalId);
    // Identity: unchanged by the second report.
    expect(row?.packageId).toBe('Mozilla.Firefox');
    expect(row?.title).toBe('Mozilla Firefox');
    expect(row?.vendor).toBe('Mozilla');
    // Operational: refreshed, exactly as the legitimate rescan flow needs.
    expect(row?.version).toBe('122.0');
    expect(row?.severity).toBe('low');
    expect(row?.category).toBe('application');
    expect(row?.requiresReboot).toBe(false);
    expect(row?.description).toBe('Rewritten description');
  });

  runDb('does not blank operational columns when a later scan simply omits them', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const app = mountRoutes(env.organization.id, dev.agentId);
    const externalId = `itest.nulldown.${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Deliberately a package the curated third-party catalog does NOT know, so
    // this case isolates the null-downgrade guard from catalog enrichment
    // (which legitimately overwrites title/vendor/category on a hit).
    const packageId = 'AcmeCorp.InternalTool';
    await putJson(app, env.organization.id, `/agents/${dev.agentId}/patches/pending`, {
      source: 'third_party',
      patches: [{
        name: 'Acme Internal Tool', source: 'third_party', externalId, packageId,
        version: '2.55.0', severity: 'critical', category: 'security',
        requiresRestart: true, description: 'Security fix',
      }],
    });

    // A sparser rescan: no description, no category, no reboot flag, and the
    // agent's "I couldn't classify this" severity of 'unknown'.
    const res = await putJson(app, env.organization.id, `/agents/${dev.agentId}/patches/pending`, {
      source: 'third_party',
      patches: [{ name: 'Acme Internal Tool', source: 'third_party', externalId, packageId, version: '2.55.1', severity: 'unknown' }],
    });
    expect(res.status).toBe(200);

    const row = await getPatchRow(externalId);
    expect(row?.description).toBe('Security fix');
    expect(row?.category).toBe('security');
    expect(row?.requiresReboot).toBe(true);
    expect(row?.severity).toBe('critical');
    // The one thing the sparser scan did report still lands.
    expect(row?.version).toBe('2.55.1');
  });

  runDb('lets a later scan FILL columns the first report left empty', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const app = mountRoutes(env.organization.id, dev.agentId);
    const externalId = `itest.fill.${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    await putJson(app, env.organization.id, `/agents/${dev.agentId}/patches/pending`, {
      source: 'microsoft',
      patches: [{ name: 'Cumulative Update', source: 'microsoft', externalId }],
    });
    expect((await getPatchRow(externalId))?.packageId).toBeNull();

    await putJson(app, env.organization.id, `/agents/${dev.agentId}/patches/pending`, {
      source: 'microsoft',
      patches: [{
        name: 'Cumulative Update', source: 'microsoft', externalId,
        packageId: 'KB5034441', vendor: 'Microsoft', version: '10.0.1',
      }],
    });

    const row = await getPatchRow(externalId);
    expect(row?.packageId).toBe('KB5034441');
    expect(row?.vendor).toBe('Microsoft');
    expect(row?.version).toBe('10.0.1');
  });

  runDb('installed inventory cannot drag the shared row back to the installed version', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const app = mountRoutes(env.organization.id, dev.agentId);
    const externalId = `itest.installed.${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    await putJson(app, env.organization.id, `/agents/${dev.agentId}/patches/pending`, {
      source: 'third_party',
      patches: [{ name: 'Git', source: 'third_party', externalId, packageId: 'Git.Git', version: '2.55.0.3', vendor: 'Git' }],
    });

    // The paired installed submit carries the *installed* version and no catalog
    // enrichment at all — it is the lowest-authority writer on this row.
    const res = await putJson(app, env.organization.id, `/agents/${dev.agentId}/patches/installed`, {
      installed: [{
        name: 'Something Else', source: 'third_party', externalId,
        packageId: 'Other.Package', vendor: 'Other', version: '2.51.0.2',
        category: 'application', installedAt: '2026-01-05T00:00:00Z',
      }],
    });
    expect(res.status).toBe(200);

    const row = await getPatchRow(externalId);
    expect(row?.version).toBe('2.55.0.3');
    expect(row?.title).toBe('Git');
    expect(row?.packageId).toBe('Git.Git');
    expect(row?.vendor).toBe('Git');
    // The per-device observation is tenant-scoped and still records what is
    // actually installed on this box.
    expect((await getDevicePatchRow(dev.id, externalId))?.installedVersion).toBe('2.51.0.2');
  });

  runDb('refuses a malformed row, still ingests the rest, and skips the sweep that cycle', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const app = mountRoutes(env.organization.id, dev.agentId);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const keptId = `itest.kept.${stamp}`;
    const freshId = `itest.fresh.${stamp}`;

    await putJson(app, env.organization.id, `/agents/${dev.agentId}/patches/pending`, {
      source: 'third_party',
      patches: [{ name: 'Kept', source: 'third_party', externalId: keptId, packageId: 'Kept.Pkg' }],
    });
    expect((await getDevicePatchRow(dev.id, keptId))?.status).toBe('pending');

    const res = await putJson(app, env.organization.id, `/agents/${dev.agentId}/patches/pending`, {
      source: 'third_party',
      patches: [
        { name: 'Fresh', source: 'third_party', externalId: freshId, packageId: 'Fresh.Pkg' },
        // An option-like local segment behind a provider prefix: the agent
        // splits on ':' and would install `--all`.
        { name: 'Malformed', source: 'third_party', externalId: `itest.bad.${stamp}`, packageId: 'winget:--all' },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, pending: 1, rejected: 1 });

    // The good row landed...
    expect((await getDevicePatchRow(dev.id, freshId))?.status).toBe('pending');
    // ...and the sweep was skipped, so the earlier row was not tombstoned by a
    // scan we know to be incomplete.
    expect((await getDevicePatchRow(dev.id, keptId))?.status).toBe('pending');
  });

  runDb('combined scan: a refused INSTALLED row also suppresses the full sweep', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const app = mountRoutes(env.organization.id, dev.agentId);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const installedId = `itest.combined.installed.${stamp}`;

    // Establish a genuinely-installed row via the combined endpoint.
    await putJson(app, env.organization.id, `/agents/${dev.agentId}/patches`, {
      patches: [],
      installed: [{
        name: 'Installed Thing', source: 'third_party', externalId: installedId,
        packageId: 'Installed.Thing', version: '1.0', installedAt: '2026-01-05T00:00:00Z',
      }],
    });
    expect((await getDevicePatchRow(dev.id, installedId))?.status).toBe('installed');

    // The combined route's sweep is markAllDevicePatchesMissing — it flips
    // INSTALLED rows too — so a refusal on the installed list must suppress it.
    // Gating on the pending list alone stranded this row at 'missing'.
    const res = await putJson(app, env.organization.id, `/agents/${dev.agentId}/patches`, {
      patches: [],
      installed: [{ name: 'Malformed', source: 'third_party', externalId: `itest.bad.${stamp}`, packageId: 'winget:--all' }],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).rejected).toBe(1);
    expect((await getDevicePatchRow(dev.id, installedId))?.status).toBe('installed');
  });

  runDb('still accepts Apple softwareupdate labels, which legitimately contain spaces', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const app = mountRoutes(env.organization.id, dev.agentId);
    const externalId = `macOS Sonoma 14.5-23F79 ${Date.now()}`;

    const res = await putJson(app, env.organization.id, `/agents/${dev.agentId}/patches/pending`, {
      source: 'apple',
      patches: [{
        name: 'macOS Sonoma 14.5', source: 'apple', externalId,
        packageId: `apple-softwareupdate:${externalId}`, version: '14.5',
      }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, pending: 1, rejected: 0 });
    expect((await getPatchRow(externalId))?.packageId).toBe(`apple-softwareupdate:${externalId}`);
  });
});
