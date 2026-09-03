import { Hono } from 'hono';
import type { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { and, eq, sql } from 'drizzle-orm';
import { db, type Database } from '../../db';
import { devices, patches, devicePatches } from '../../db/schema';
import { enqueueWingetReleaseTest } from '../../jobs/wingetReleaseTestWorker';
import { writeAuditEvent } from '../../services/auditEvents';
import { envInt } from '../../utils/envInt';
import { enrichFromCatalog } from '../../services/thirdPartyEnrichment';
import { submitInstalledPatchesSchema, submitPatchesSchema, submitPendingPatchesSchema } from './schemas';
import { inferPatchOsType, parseDate, sanitizeDate } from './helpers';
import { admitPatchBatch, mergeRejectionReasons, type AdmittedPatch, type PatchAdmission } from './patchIngestIdentity';
import { requireAgentRole } from '../../middleware/requireAgentRole';
import { compareBuilds } from '../../services/versionCompare';

type PendingPatchData = z.infer<typeof submitPendingPatchesSchema>['patches'][number];
type InstalledPatchData = z.infer<typeof submitInstalledPatchesSchema>['installed'][number];
type PatchIngestDevice = { id: string; orgId: string; osType: string | null };
type PatchIngestExecutor = Pick<Database, 'insert' | 'update'>;
/**
 * A refused row means the sweep can no longer be trusted for this submission:
 * the sweep tombstones every pending row for the covered sources on the
 * assumption that everything still applicable is about to be re-upserted, and a
 * row we refused to ingest is not. Skipping the sweep leaves stale rows for one
 * cycle (self-healing on the next clean scan); sweeping anyway would tombstone
 * a patch that is genuinely still pending. Same conservatism as the
 * covered-zero-sources branch below (#2217).
 */
function sweepIsSafe(admission: PatchAdmission<unknown>): boolean {
  return admission.rejected === 0;
}

function logRejections(agentId: string, kind: string, admission: PatchAdmission<unknown>): void {
  if (admission.rejected === 0) return;
  console.warn(
    `[PATCHES] Agent ${agentId} ${kind}: refused ${admission.rejected} malformed row(s) ` +
    `${JSON.stringify(admission.reasons)}`,
  );
}

/**
 * `patches` rows are GLOBAL: the table is deduped on `(source, external_id)`
 * with no tenant column, so every device that reports a colliding key writes the
 * same row, and every tenant's UI, `patch_approvals` and patch jobs read it.
 * The two upserts below therefore classify each column:
 *
 * - **Volatile / operational** (`category`, `description`, `requires_reboot`,
 *   `os_types`): these genuinely change between scans and keep refreshing. They
 *   are only hardened against *null downgrades* — a scan that omits a field must
 *   not blank a value an earlier scan established.
 * - **Identity-bearing** (`title`, `vendor`, `package_id`, `version`): these say
 *   *what the row is* and, for `package_id`, what actually gets installed
 *   (`routes/devices/patches.ts` forwards it into the `install_patches` command
 *   payload). Raw agent strings may only **fill** them, never rewrite them;
 *   overwriting is reserved for server-side catalog enrichment.
 * - **Authoritative-only** (`severity`): agent scans may fill or *raise* it and
 *   nothing else. See `raiseOnlySeverity`.
 *
 * Two columns are load-bearing for cross-tenant integrity, because a compromised
 * agent in ONE tenant writes a row every OTHER tenant's approval engine reads:
 *
 * - `severity` gates auto-approval rules (`patchApprovalEvaluator`'s severity
 *   filters). Letting an agent LOWER it globally would silently downgrade a
 *   critical patch for every other MSP customer, so the agent path is now
 *   fill-or-raise only. Lowering is reserved for server-authoritative writers —
 *   today that is `jobs/cveEnrichmentWorker.ts`, which itself only ever raises.
 * - `version` drives the version pin / block rules in `patchApprovalEvaluator`.
 *   Agent scan data may only **fill** it on both paths, never rewrite it. The
 *   per-device *observed available* version — which legitimately advances
 *   between scans — now lives on the tenant-scoped `device_patches.available_version`
 *   instead, so one tenant's agent cannot move another tenant's pin target.
 */

/**
 * `download_size_mb` is a Postgres `integer` and the request schema puts no
 * upper bound on `size`, so an absurd byte count overflows the column and aborts
 * the whole scan transaction. Clamp instead of failing the batch.
 */
function toDownloadSizeMb(size: number | undefined): number | null {
  if (!size || !Number.isFinite(size) || size <= 0) return null;
  return Math.min(Math.ceil(size / (1024 * 1024)), 2147483647);
}

/** Keep the stored value; only write when the column is currently NULL. */
function fillIfNull(column: unknown, value: string | null) {
  return value === null ? sql`${column}` : sql`COALESCE(${column}, ${value})`;
}

/** Refresh when this scan reported a value; keep the stored one when it didn't. */
function updateIfReported<T>(column: unknown, value: T | null | undefined) {
  return value === null || value === undefined ? sql`${column}` : value;
}

/** Enum ordering for `patch_severity`, weakest first. Mirrors SEVERITY_RANK in jobs/cveEnrichmentWorker.ts. */
const SEVERITY_RANK_SQL = sql`ARRAY['unknown','low','moderate','important','critical']::text[]`;

/**
 * Agent-reported severity may only FILL or RAISE the shared row, never lower it.
 * `patches` is global, so a compromised agent lowering a critical patch's
 * severity mis-classifies it for every other tenant's auto-approval rules.
 * Lowering is reserved for server-authoritative writers (the CVE enrichment
 * worker, which itself only raises).
 */
export function raiseOnlySeverity(column: unknown, value: string | null | undefined) {
  if (!value || value === 'unknown') {
    return sql`COALESCE(${column}, 'unknown'::patch_severity)`;
  }
  return sql`CASE
    WHEN ${column} IS NULL THEN ${value}::patch_severity
    WHEN COALESCE(array_position(${SEVERITY_RANK_SQL}, ${value}), 0)
       > COALESCE(array_position(${SEVERITY_RANK_SQL}, ${column}::text), 0)
      THEN ${value}::patch_severity
    ELSE ${column}
  END`;
}

// Derive vendor from package id; ignore agent-supplied vendor for winget-style ids.
function deriveVendor(packageId: string | null | undefined, fallback: string | null | undefined): string | null {
  if (packageId && /^[^.]+\.[^.]+/.test(packageId)) {
    return packageId.split('.')[0] ?? fallback ?? null;
  }
  return fallback ?? null;
}

async function getDeviceForPatchIngest(agentId: string): Promise<PatchIngestDevice | null> {
  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.agentId, agentId))
    .limit(1);

  if (!device) {
    return null;
  }

  return {
    id: device.id,
    orgId: device.orgId,
    osType: device.osType ?? null,
  };
}

function uniqueSourcesFromPendingPatches(patchList: PendingPatchData[]): string[] {
  return [...new Set(patchList.map((patch) => patch.source))];
}

/**
 * Rows discovered only inside a logged-in user's session (#2727) must not be
 * tombstoned by a scan that could not look at user scope — a machine with
 * nobody logged in reports machine scope only, and sweeping its (necessarily
 * absent) per-user results would wipe rows the scan never inspected. Same
 * failure mode as #2217, one axis down.
 *
 * NULL scope is deliberately sweepable: it means "no scope concept" (Windows
 * Update, apt, homebrew) or a row written before this column existed, and both
 * are machine-wide.
 */
const notUserScoped = sql`${devicePatches.scope} IS DISTINCT FROM 'user'`;

async function markAllDevicePatchesMissing(executor: PatchIngestExecutor, deviceId: string): Promise<void> {
  // No userScopeScanned signal exists on this legacy combined-submit route, so
  // it can never prove the user pass ran — user-scope rows are always spared.
  await executor
    .update(devicePatches)
    .set({ status: 'missing', lastCheckedAt: new Date() })
    .where(and(eq(devicePatches.deviceId, deviceId), notUserScoped));
}

async function markPendingDevicePatchesMissing(
  executor: PatchIngestExecutor,
  deviceId: string,
  sources: string[],
  sweepUserScope = false,
): Promise<void> {
  const conditions = [
    eq(devicePatches.deviceId, deviceId),
    eq(devicePatches.status, 'pending'),
  ];

  if (!sweepUserScope) {
    conditions.push(notUserScoped);
  }

  if (sources.length > 0) {
    conditions.push(sql`${devicePatches.patchId} IN (
      SELECT ${patches.id}
      FROM ${patches}
      WHERE ${patches.source} IN (${sql.join(sources.map((source) => sql`${source}`), sql`, `)})
    )`);
  }

  await executor
    .update(devicePatches)
    .set({ status: 'missing', lastCheckedAt: new Date() })
    .where(and(...conditions));
}

async function upsertPendingPatches(
  executor: PatchIngestExecutor,
  device: PatchIngestDevice,
  admitted: AdmittedPatch<PendingPatchData>[],
): Promise<number> {
  let processed = 0;
  for (const { data: patchData, identity } of admitted) {
    const { externalId, packageId, title, version, vendor, category, description } = identity;
    const inferredOsType = inferPatchOsType(patchData.source, device.osType);
    const derivedVendor = deriveVendor(packageId, vendor);
    const enriched = await enrichFromCatalog({
      source: patchData.source,
      packageId: packageId,
      title: title,
      vendor: derivedVendor,
      severity: patchData.severity ?? null,
      category: category,
    });
    // `matchedCatalogId` is non-null exactly when title/vendor/category came
    // from the server-side catalog rather than the agent's own strings — the
    // only case in which an identity-bearing column may be rewritten.
    const curated = enriched.matchedCatalogId !== null;

    const [patch] = await executor
      .insert(patches)
      .values({
        source: patchData.source,
        externalId: externalId,
        title: enriched.title,
        description: description,
        severity: enriched.severity ?? 'unknown',
        category: enriched.category,
        releaseDate: sanitizeDate(patchData.releaseDate),
        requiresReboot: patchData.requiresRestart || false,
        downloadSizeMb: toDownloadSizeMb(patchData.size),
        vendor: enriched.vendor,
        packageId: packageId,
        version: version,
        ...(inferredOsType ? { osTypes: [inferredOsType] } : {})
      })
      .onConflictDoUpdate({
        target: [patches.source, patches.externalId],
        set: {
          // Identity: curated catalog values may rewrite, raw agent strings may not.
          title: curated ? enriched.title : sql`${patches.title}`,
          vendor: curated
            ? (enriched.vendor ?? sql`${patches.vendor}`)
            : fillIfNull(patches.vendor, enriched.vendor),
          packageId: fillIfNull(patches.packageId, packageId),
          // Volatile: refresh, but never blank out what an earlier scan set.
          description: updateIfReported(patches.description, description),
          // Agent severity is raise-only; only server-authoritative writers may lower it.
          severity: raiseOnlySeverity(patches.severity, enriched.severity),
          category: updateIfReported(patches.category, enriched.category),
          requiresReboot: updateIfReported(patches.requiresReboot, patchData.requiresRestart),
          // Agent scan data may only fill the shared column, never rewrite it;
          // the per-device value lives on device_patches.available_version.
          version: fillIfNull(patches.version, version),
          ...(inferredOsType
            ? {
                osTypes: sql`CASE
                  WHEN ${inferredOsType} = ANY(COALESCE(${patches.osTypes}, ARRAY[]::text[]))
                  THEN COALESCE(${patches.osTypes}, ARRAY[]::text[])
                  ELSE COALESCE(${patches.osTypes}, ARRAY[]::text[]) || ARRAY[${inferredOsType}]::text[]
                END`
              }
            : {}),
          updatedAt: new Date()
        }
      })
      .returning();

    if (!patch) {
      continue;
    }

    if (
      enriched.matchedCatalogId &&
      version &&
      process.env.ENABLE_AI_PATCH_TESTING === '1'
    ) {
      // Fire-and-forget - don't block the patch submit on test queueing.
      enqueueWingetReleaseTest({
        catalogId: enriched.matchedCatalogId,
        version: version,
      }).catch((err) => {
        console.error('[ReleaseTest] enqueue failed', err);
      });
    }

    await executor
      .insert(devicePatches)
      .values({
        deviceId: device.id,
        orgId: device.orgId,
        patchId: patch.id,
        status: 'pending',
        scope: patchData.scope ?? null,
        availableVersion: version,
        lastCheckedAt: new Date()
      })
      .onConflictDoUpdate({
        target: [devicePatches.deviceId, devicePatches.patchId],
        set: {
          status: 'pending',
          availableVersion: updateIfReported(devicePatches.availableVersion, version),
          // A scope-less report must not erase a scope an earlier scan
          // established: the same device keeps reporting machine-scope rows
          // from providers with no scope concept, and blanking the column
          // would re-expose user-scope rows to the sweep.
          scope: patchData.scope ?? sql`${devicePatches.scope}`,
          lastCheckedAt: new Date(),
          updatedAt: new Date()
        }
      });
    processed++;
  }
  return processed;
}

async function upsertInstalledPatches(
  executor: PatchIngestExecutor,
  device: PatchIngestDevice,
  admitted: AdmittedPatch<InstalledPatchData>[],
): Promise<number> {
  let processed = 0;
  for (const { data: patchData, identity } of admitted) {
    // Linux package-manager inventories are owned by software_inventory. They
    // are not installed patch/update records and must not be allowed to flip
    // actionable Linux update rows from pending to installed.
    if (patchData.source === 'linux') {
      continue;
    }

    const { externalId, packageId, title, version, vendor, category } = identity;
    const inferredOsType = inferPatchOsType(patchData.source, device.osType);
    const derivedVendor = deriveVendor(packageId, vendor);

    const [patch] = await executor
      .insert(patches)
      .values({
        source: patchData.source,
        externalId: externalId,
        title: title,
        severity: 'unknown',
        category: category,
        vendor: derivedVendor,
        packageId: packageId,
        version: version,
        ...(inferredOsType ? { osTypes: [inferredOsType] } : {})
      })
      .onConflictDoUpdate({
        target: [patches.source, patches.externalId],
        set: {
          // Installed inventory is the lowest-authority writer on this shared
          // row: it carries no catalog enrichment, and its `version` is the
          // *installed* version rather than the available one. It may only fill
          // columns that are still unset — never rewrite them. `title` is NOT
          // NULL, so it is simply never updated from this path.
          category: fillIfNull(patches.category, category),
          vendor: fillIfNull(patches.vendor, derivedVendor),
          packageId: fillIfNull(patches.packageId, packageId),
          version: fillIfNull(patches.version, version),
          ...(inferredOsType
            ? {
                osTypes: sql`CASE
                  WHEN ${inferredOsType} = ANY(COALESCE(${patches.osTypes}, ARRAY[]::text[]))
                  THEN COALESCE(${patches.osTypes}, ARRAY[]::text[])
                  ELSE COALESCE(${patches.osTypes}, ARRAY[]::text[]) || ARRAY[${inferredOsType}]::text[]
                END`
              }
            : {}),
          updatedAt: new Date()
        }
      })
      .returning();

    if (!patch) {
      continue;
    }

    const installedAt = parseDate(patchData.installedAt);
    // A Date bound inside a raw sql`` fragment bypasses drizzle's column
    // mapper and postgres.js cannot serialize it (TypeError at query time) —
    // bind the ISO string with an explicit cast instead.
    const installedAtParam = installedAt ? sql`${installedAt.toISOString()}::timestamp` : sql`NULL::timestamp`;
    // Installed inventory must not downgrade an actionable 'pending' row on the
    // normal paired-submit flow. Package managers report a pending upgrade and
    // the installed package under the SAME (source, externalId) — `winget list`
    // covers every package the paired `winget upgrade` scan reports — so an
    // unconditional flip would clobber every pending third-party row in the
    // same scan cycle. installedVersion still updates: it's the
    // currently-installed version either way. A row whose upgrade completed
    // self-heals within one scan cycle: the pending sweep flips it to
    // 'missing', then the paired installed submit lands in the ELSE branch
    // below as 'installed'.
    //
    // That sweep, though, only runs for sources whose pending Scan() actually
    // ran this cycle (#2217) — a source whose pending scan chronically errors
    // (e.g. winget upgrade flaking) never gets swept, so a row can stay
    // 'pending' forever even after the upgrade genuinely lands, with the
    // installed inventory (winget list) succeeding the whole time (#2736).
    // Bound that: if the reported installed version already meets or exceeds
    // the patch's known target version (`patches.version`, filled once via
    // fillIfNull and stable thereafter), flip out of 'pending' regardless of
    // sweep coverage — the installed inventory itself proves the upgrade
    // completed, so there is nothing left to preserve.
    const installedMeetsTarget =
      version !== null && patch.version !== null && compareBuilds(version, patch.version) >= 0;

    await executor
      .insert(devicePatches)
      .values({
        deviceId: device.id,
        orgId: device.orgId,
        patchId: patch.id,
        status: 'installed',
        installedAt: installedAt,
        installedVersion: version,
        lastCheckedAt: new Date()
      })
      .onConflictDoUpdate({
        target: [devicePatches.deviceId, devicePatches.patchId],
        set: {
          status: installedMeetsTarget
            ? 'installed'
            : sql`CASE WHEN ${devicePatches.status} = 'pending' THEN ${devicePatches.status} ELSE 'installed' END`,
          installedAt: installedMeetsTarget
            ? installedAtParam
            : sql`CASE WHEN ${devicePatches.status} = 'pending' THEN ${devicePatches.installedAt} ELSE ${installedAtParam} END`,
          installedVersion: version,
          lastCheckedAt: new Date(),
          updatedAt: new Date()
        }
      });
    processed++;
  }
  return processed;
}

/**
 * Bound tombstone growth (#1004): delete device_patches rows that have stayed
 * 'missing' (absent from every scan) longer than the grace window.
 *
 * `updatedAt` is bumped only when a scan actually reports the patch — the bulk
 * mark-missing in the scan ingest sets `status='missing'` + `lastCheckedAt` but
 * leaves `updatedAt` untouched — so `updatedAt` dates the patch's last real
 * sighting. A transient partial-provider failure (e.g. winget fails while
 * chocolatey succeeds under the shared 'third_party' source bucket) self-heals:
 * the row is re-upserted on the next clean scan inside the window, so only
 * genuinely-removed packages age out. The window is generous (default 7 days,
 * `PATCH_TOMBSTONE_PRUNE_AFTER_HOURS`) so a missed scan never prunes prematurely.
 * Scoped to a single device + org (cross-tenant safe).
 */
export async function pruneStaleTombstones(
  executor: Database,
  deviceId: string,
  orgId: string,
  // `|| 168` is deliberate and preserves the pre-#2823 semantics: a 0-hour
  // window would prune every `missing` tombstone on the very next scan, so 0
  // is treated as "unset" rather than honoured.
  pruneAfterHours = envInt('PATCH_TOMBSTONE_PRUNE_AFTER_HOURS', 168) || 168,
): Promise<void> {
  await executor
    .delete(devicePatches)
    .where(
      and(
        eq(devicePatches.deviceId, deviceId),
        eq(devicePatches.orgId, orgId),
        eq(devicePatches.status, 'missing'),
        sql`${devicePatches.updatedAt} < now() - make_interval(hours => ${pruneAfterHours})`,
      ),
    );
}

export const patchesRoutes = new Hono();
// Patch/compliance scan ingest is the main agent's job; reject watchdog-role
// tokens so a weaker credential can't falsify operator-facing patch posture (F3).
patchesRoutes.use('*', requireAgentRole);

patchesRoutes.put('/:id/patches/pending', zValidator('json', submitPendingPatchesSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');
  const agent = c.get('agent') as { orgId?: string; agentId?: string } | undefined;
  console.log(`[PATCHES] Agent ${agentId} submitting ${data.patches.length} pending`);

  const device = await getDeviceForPatchIngest(agentId);
  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  const sources = data.source ? [data.source] : uniqueSourcesFromPendingPatches(data.patches);
  // Admit BEFORE the sweep — see sweepIsSafe.
  const pending = admitPatchBatch(data.patches);
  logRejections(agentId, 'pending scan', pending);
  // Only an explicit true unlocks sweeping user-scope rows. Absent (legacy
  // agent, non-Windows, no winget provider) means the user pass demonstrably
  // did not run, so those rows are left alone (#2727).
  const sweepUserScope = data.userScopeScanned === true;
  if (!sweepUserScope && data.full) {
    console.log(`[PATCHES] Agent ${agentId} full scan did not cover per-user installs; user-scope pending rows preserved`);
  }

  let pendingCount = 0;
  await db.transaction(async (tx) => {
    if (!sweepIsSafe(pending)) {
      console.warn(`[PATCHES] Agent ${agentId} pending scan had refused rows — skipping tombstone sweep this cycle`);
    } else if (data.full) {
      if (data.coveredSources === undefined) {
        // Legacy agents send full scans without coverage info: sweep all sources.
        // Log the path so an operator can tell a legacy sweep-all from a
        // coverage-scoped sweep when diagnosing lingering-pending rows (#2217).
        console.log(`[PATCHES] Agent ${agentId} full scan (legacy, no coverage): sweeping ALL pending sources`);
        await markPendingDevicePatchesMissing(tx, device.id, [], sweepUserScope);
      } else if (data.coveredSources.length > 0) {
        // Coverage-aware full scan (#2217): only sweep sources whose providers
        // actually ran. Skipped providers (e.g. winget without a helper
        // session) keep their pending rows instead of being tombstoned.
        console.log(`[PATCHES] Agent ${agentId} full scan (coverage-scoped): sweeping only [${data.coveredSources.join(', ')}]${sweepUserScope ? ' (incl. user scope)' : ''}`);
        await markPendingDevicePatchesMissing(tx, device.id, data.coveredSources, sweepUserScope);
      } else {
        // full with coveredSources: [] means EVERY registered provider on the
        // device was skipped or failed — a genuinely degraded agent. We sweep
        // nothing (correct: don't tombstone rows nothing looked at), but warn so
        // "why are this device's pending patches never reconciled?" is greppable
        // instead of a silent no-op (#2217).
        console.warn(`[PATCHES] Agent ${agentId} full scan covered ZERO sources — every provider skipped/failed; no tombstoning performed`);
      }
    } else if (sources.length > 0) {
      await markPendingDevicePatchesMissing(tx, device.id, sources, sweepUserScope);
    }
    pendingCount = await upsertPendingPatches(tx, device, pending.admitted);
  });

  await pruneStaleTombstones(db, device.id, device.orgId);

  writeAuditEvent(c, {
    orgId: agent?.orgId ?? device.orgId,
    actorType: 'agent',
    actorId: agent?.agentId ?? agentId,
    action: 'agent.patches.pending.submit',
    resourceType: 'device',
    resourceId: device.id,
    details: {
      pendingCount,
      rejectedCount: pending.rejected,
      rejectedReasons: pending.reasons,
      source: data.source ?? null,
      full: data.full,
      coveredSources: data.coveredSources ?? null,
    },
  });

  return c.json({ success: true, pending: pendingCount, rejected: pending.rejected });
});

patchesRoutes.put('/:id/patches/installed', zValidator('json', submitInstalledPatchesSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');
  const agent = c.get('agent') as { orgId?: string; agentId?: string } | undefined;
  console.log(`[PATCHES] Agent ${agentId} submitting ${data.installed.length} installed`);

  const device = await getDeviceForPatchIngest(agentId);
  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  const installed = admitPatchBatch(data.installed);
  logRejections(agentId, 'installed inventory', installed);

  let installedCount = 0;
  await db.transaction(async (tx) => {
    installedCount = await upsertInstalledPatches(tx, device, installed.admitted);
  });

  writeAuditEvent(c, {
    orgId: agent?.orgId ?? device.orgId,
    actorType: 'agent',
    actorId: agent?.agentId ?? agentId,
    action: 'agent.patches.installed.submit',
    resourceType: 'device',
    resourceId: device.id,
    details: {
      installedCount,
      rejectedCount: installed.rejected,
      rejectedReasons: installed.reasons,
      ignoredLinuxPackageCount: installed.admitted.length - installedCount,
    },
  });

  return c.json({
    success: true,
    installed: installedCount,
    ignored: installed.admitted.length - installedCount,
    rejected: installed.rejected,
  });
});

patchesRoutes.put('/:id/patches', zValidator('json', submitPatchesSchema), async (c) => {
  const agentId = c.req.param('id');
  const data = c.req.valid('json');
  const agent = c.get('agent') as { orgId?: string; agentId?: string } | undefined;
  const submittedInstalledCount = data.installed?.length || 0;
  console.log(`[PATCHES] Agent ${agentId} submitting ${data.patches.length} pending, ${submittedInstalledCount} installed`);

  const device = await getDeviceForPatchIngest(agentId);
  if (!device) {
    return c.json({ error: 'Device not found' }, 404);
  }

  const pending = admitPatchBatch(data.patches);
  const installed = admitPatchBatch(data.installed ?? []);
  logRejections(agentId, 'combined scan', pending);
  logRejections(agentId, 'combined scan (installed)', installed);
  const rejectedCount = pending.rejected + installed.rejected;

  let pendingCount = 0;
  let installedCount = 0;
  await db.transaction(async (tx) => {
    // Gated on BOTH admissions, unlike the pending-only route: this sweep is
    // markAllDevicePatchesMissing, which flips *installed* rows to 'missing'
    // too, on the assumption that both lists below fully restate the device.
    // A refused installed row is never re-upserted, so sweeping on a partial
    // installed list would strand a genuinely-installed patch at 'missing'.
    if (sweepIsSafe(pending) && sweepIsSafe(installed)) {
      await markAllDevicePatchesMissing(tx, device.id);
    } else {
      console.warn(`[PATCHES] Agent ${agentId} combined scan had refused rows — skipping tombstone sweep this cycle`);
    }
    pendingCount = await upsertPendingPatches(tx, device, pending.admitted);
    installedCount = await upsertInstalledPatches(tx, device, installed.admitted);
  });

  // Prune stale tombstones after the scan commits. Outside the txn on purpose:
  // it reads the just-committed state, and a crash before it runs is harmless
  // (the next scan prunes). Runs in the same request DB context as the ingest.
  await pruneStaleTombstones(db, device.id, device.orgId);

  writeAuditEvent(c, {
    orgId: agent?.orgId ?? device.orgId,
    actorType: 'agent',
    actorId: agent?.agentId ?? agentId,
    action: 'agent.patches.submit',
    resourceType: 'device',
    resourceId: device.id,
    details: {
      pendingCount,
      installedCount,
      rejectedCount,
      rejectedReasons: mergeRejectionReasons(pending.reasons, installed.reasons),
      ignoredLinuxPackageCount: installed.admitted.length - installedCount,
    },
  });

  return c.json({
    success: true,
    pending: pendingCount,
    installed: installedCount,
    ignored: installed.admitted.length - installedCount,
    rejected: rejectedCount
  });
});
