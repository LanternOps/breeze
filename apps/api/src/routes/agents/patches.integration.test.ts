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
        availableVersion: devicePatches.availableVersion,
        scope: devicePatches.scope,
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
    // Identity: `version` drives the version pin/block rules in
    // `patchApprovalEvaluator`, so agent scan data may only FILL it.
    expect(row?.version).toBe('121.0');
    // Severity is raise-only on the agent path — 'low' cannot lower 'critical'
    // for every other tenant reading this shared row.
    expect(row?.severity).toBe('critical');
    // Operational: refreshed, exactly as the legitimate rescan flow needs.
    expect(row?.category).toBe('application');
    expect(row?.requiresReboot).toBe(false);
    expect(row?.description).toBe('Rewritten description');
    // The per-device observed available version DOES advance — it lives on the
    // tenant-scoped device_patches row, one value per device.
    expect((await getDevicePatchRow(first.id, externalId))?.availableVersion).toBe('121.0');
    expect((await getDevicePatchRow(second.id, externalId))?.availableVersion).toBe('122.0');
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
    // The shared catalog version is fill-only, so the rescan cannot move it.
    expect(row?.version).toBe('2.55.0');
    // The one thing the sparser scan did report still lands — on the
    // device-scoped column that legitimately advances between scans.
    expect((await getDevicePatchRow(dev.id, externalId))?.availableVersion).toBe('2.55.1');
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

/**
 * #2727 — per-user winget results are a SECOND coverage axis.
 *
 * The agent's user-context pass only runs when somebody is logged in. A scan
 * taken on an unattended machine therefore reports machine scope only, and
 * sweeping its (necessarily absent) per-user results would tombstone rows that
 * scan never inspected — #2217, one axis down. The route must only sweep
 * user-scope rows when the agent explicitly reports `userScopeScanned: true`.
 *
 * This needs real Postgres: the guard is a raw `IS DISTINCT FROM` fragment and
 * the mocked suite can only assert the shape of the generated SQL, not that the
 * NULL-vs-'user' three-valued logic points the right way.
 */
describe('patch ingest — user-scope rows are only swept when the user pass ran (real Postgres, #2727)', () => {
  runDb('preserves user-scope rows across a machine-only scan and sweeps them once the user pass runs', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const app = mountRoutes(env.organization.id, dev.agentId);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const userPkgId = `itest.winget.chrome-${stamp}`;
    const machinePkgId = `itest.winget.firefox-${stamp}`;
    const userPkg = { name: 'Chrome', source: 'third_party', externalId: userPkgId, packageId: userPkgId };
    const machinePkg = { name: 'Firefox', source: 'third_party', externalId: machinePkgId, packageId: machinePkgId };

    // 1. A scan WITH somebody logged in reports both scopes.
    const bothRes = await putJson(app, env.organization.id, `/agents/${dev.agentId}/patches/pending`, {
      full: true,
      coveredSources: ['third_party'],
      userScopeScanned: true,
      patches: [
        { ...machinePkg, version: '2.0', scope: 'machine' },
        { ...userPkg, version: '2.0', scope: 'user' },
      ],
    });
    expect(bothRes.status).toBe(200);
    expect((await getDevicePatchRow(dev.id, userPkgId))?.scope).toBe('user');
    expect((await getDevicePatchRow(dev.id, machinePkgId))?.scope).toBe('machine');

    // 2. The user logs out. The next scan covers third_party (the SYSTEM pass
    //    succeeded) but could not look at user scope. The machine-scope package
    //    is genuinely gone and must be tombstoned; the user-scope one must NOT
    //    be, because nothing looked at it.
    const machineOnlyRes = await putJson(app, env.organization.id, `/agents/${dev.agentId}/patches/pending`, {
      full: true,
      coveredSources: ['third_party'],
      userScopeScanned: false,
      patches: [],
    });
    expect(machineOnlyRes.status).toBe(200);
    expect((await getDevicePatchRow(dev.id, machinePkgId))?.status).toBe('missing');
    expect((await getDevicePatchRow(dev.id, userPkgId))?.status).toBe('pending');

    // 3. A scan that DID cover user scope and no longer reports the package is
    //    real evidence it is gone — now it tombstones.
    const userCoveredRes = await putJson(app, env.organization.id, `/agents/${dev.agentId}/patches/pending`, {
      full: true,
      coveredSources: ['third_party'],
      userScopeScanned: true,
      patches: [],
    });
    expect(userCoveredRes.status).toBe(200);
    expect((await getDevicePatchRow(dev.id, userPkgId))?.status).toBe('missing');
  });

  // The reason the guard is `IS DISTINCT FROM 'user'` and not `<> 'user'`.
  // NULL is what the overwhelming majority of real rows carry — every row
  // written before the column existed, and every provider with no scope concept
  // (Windows Update, apt, homebrew). Under `<>`, `NULL <> 'user'` evaluates to
  // NULL, the row drops out of the WHERE clause, and NOTHING is ever swept
  // again, fleet-wide. Only real Postgres can prove the three-valued logic.
  runDb('still sweeps NULL-scope rows, which is what three-valued logic would silently break', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const app = mountRoutes(env.organization.id, dev.agentId);
    const externalId = `itest.wu.kb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // A provider with no scope concept: the payload omits `scope` entirely.
    const seedRes = await putJson(app, env.organization.id, `/agents/${dev.agentId}/patches/pending`, {
      full: true,
      coveredSources: ['microsoft'],
      patches: [{ name: 'KB5000001', source: 'microsoft', externalId, kbNumber: externalId }],
    });
    expect(seedRes.status).toBe(200);
    const seeded = await getDevicePatchRow(dev.id, externalId);
    expect(seeded?.status).toBe('pending');
    expect(seeded?.scope).toBeNull();

    // The patch is installed, so the next scan no longer reports it. A NULL
    // scope is machine-wide and must be swept — even on a scan that could not
    // cover user scope.
    const sweepRes = await putJson(app, env.organization.id, `/agents/${dev.agentId}/patches/pending`, {
      full: true,
      coveredSources: ['microsoft'],
      userScopeScanned: false,
      patches: [],
    });
    expect(sweepRes.status).toBe(200);
    expect((await getDevicePatchRow(dev.id, externalId))?.status).toBe('missing');
  });

  runDb('a scope-less re-report does not erase an established user scope', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const app = mountRoutes(env.organization.id, dev.agentId);
    const externalId = `itest.winget.zoom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const pkg = { name: 'Zoom', source: 'third_party', externalId, packageId: externalId };

    await putJson(app, env.organization.id, `/agents/${dev.agentId}/patches/pending`, {
      source: 'third_party',
      userScopeScanned: true,
      patches: [{ ...pkg, version: '1.0', scope: 'user' }],
    });
    expect((await getDevicePatchRow(dev.id, externalId))?.scope).toBe('user');

    // A downgraded agent (or a provider with no scope concept) re-reports the
    // same package without a scope. Blanking the column would silently re-expose
    // the row to the sweep.
    const res = await putJson(app, env.organization.id, `/agents/${dev.agentId}/patches/pending`, {
      source: 'third_party',
      patches: [{ ...pkg, version: '1.1' }],
    });
    expect(res.status).toBe(200);
    expect((await getDevicePatchRow(dev.id, externalId))?.scope).toBe('user');
  });
});
