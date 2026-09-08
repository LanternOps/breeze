import { db } from '../db';
import { deviceWarranty, deviceHardware, devices, manualAssets } from '../db/schema';
import { eq, and, lt, isNull, or, sql } from 'drizzle-orm';
import { getProviderForManufacturer, normalizeManufacturer } from './warrantyProviders';
import type { WarrantyLookupResult } from './warrantyProviders';
import { evaluateWarrantyAlerts } from './warrantyAlertEvaluator';

export type WarrantyStatus = 'active' | 'expiring' | 'expired' | 'unknown' | 'subscription_active';

/**
 * EXPORTED for `services/customFields/import/warrantyTarget.ts` (#3257 W08),
 * which writes `device_warranty` from an imported CSV and must derive `status`
 * the same way every other writer does. `evaluateWarrantyAlerts` returns early
 * on `status === 'unknown'` and the column defaults to it, so a writer that
 * computed its own status — or skipped it — would ship warranty alerting inert
 * for every imported device. One function, one rule; do not copy it.
 */
export function computeWarrantyStatus(endDate: string | null, warnDays = 90): WarrantyStatus {
  if (!endDate) return 'unknown';
  const now = new Date();
  const end = new Date(endDate);
  if (isNaN(end.getTime())) return 'unknown';

  const diffMs = end.getTime() - now.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  if (diffDays <= 0) return 'expired';
  if (diffDays <= warnDays) return 'expiring';
  return 'active';
}

const SYNC_CADENCE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface SyncWarrantyOptions {
  /**
   * Explicit, user-requested refresh. Bypasses the virtual-machine skip only.
   *
   * The VM skip exists to stop the 7-day fleet sweep burning vendor quota on
   * synthetic serials, which is an efficiency rule — so a human asking for one
   * device is both negligible in cost and the escape hatch when virtualization
   * detection misfires. `ClassifyVirtualization` matches bare substrings, so a
   * physical machine with an unlucky SMBIOS string would otherwise lose its
   * warranty data permanently with no way to override.
   *
   * Deliberately does NOT bypass the ephemeral skip: that one is an ownership
   * rule (never ship a stranger's serial to a vendor), not an efficiency one.
   */
  force?: boolean;
}

export async function syncWarrantyForDevice(
  deviceId: string,
  options: SyncWarrantyOptions = {},
): Promise<void> {
  // Load hardware info for this device
  const [hw] = await db
    .select({
      serialNumber: deviceHardware.serialNumber,
      manufacturer: deviceHardware.manufacturer,
      model: deviceHardware.model,
    })
    .from(deviceHardware)
    .where(eq(deviceHardware.deviceId, deviceId))
    .limit(1);

  if (!hw?.serialNumber || !hw?.manufacturer) {
    console.log(`[WarrantySync] No serial/manufacturer for device ${deviceId}, skipping`);
    return;
  }

  // Get device org
  const [device] = await db
    .select({ orgId: devices.orgId, isEphemeral: devices.isEphemeral, isVirtual: devices.isVirtual })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) return;

  // Quick Support exclusion: ephemeral devices live in the hidden per-partner
  // 'quick_support' org and are a stranger's personal machine borrowed for one
  // ~20-minute session. That org stays inside technicians' accessibleOrgIds for
  // RLS reasons, so nothing upstream filters them. A warranty sync ships the
  // machine's serial number to a third-party vendor API (Dell/Lenovo/Apple) —
  // never do that for hardware the MSP does not own. The fleet sweep in
  // getDevicesNeedingWarrantySync excludes them too; this is the entry-point
  // guard for any other caller.
  if (device.isEphemeral) return;

  // Virtual-machine exclusion: a VMware/Hyper-V guest reports a synthetic
  // serial and a vendor-ish manufacturer string, so it passes the serial +
  // manufacturer filters above and gets submitted to a vendor warranty API
  // that has never heard of it. There is no warranty to find — the result is
  // burnt vendor quota and a row parked permanently in 'unknown'.
  // cleanHardwareIdentityValue does not catch these the way it catches
  // whitebox OEM placeholders, because a guest's reported values look
  // plausible. Same entry-point-guard role as the isEphemeral check above.
  //
  // `force` (an explicit user-requested refresh) bypasses this one — see
  // SyncWarrantyOptions. Without that, a manual refresh on a device flagged
  // virtual would never advance lastSyncAt and the UI would poll a success
  // that never arrives.
  if (device.isVirtual && !options.force) return;

  await syncWarrantyForSubject({
    orgId: device.orgId,
    manufacturer: hw.manufacturer,
    serialNumber: hw.serialNumber,
    subject: { kind: 'device', deviceId },
  });
}

/**
 * #4622 — the subject a warranty row describes. `device_warranty` carries a
 * `device_id` XOR `manual_asset_id` binding (device_warranty_one_subject_chk);
 * everything downstream of provider resolution is identical for both.
 */
export type WarrantySubject =
  | { kind: 'device'; deviceId: string }
  | { kind: 'manualAsset'; manualAssetId: string };

/**
 * Subject-agnostic warranty sync: provider resolution, vendor lookup, status
 * computation and the upsert.
 *
 * The device-only rules — the hardware lookup and the ephemeral/virtual guards
 * — stay in `syncWarrantyForDevice` above and must NOT migrate down here: they
 * are ownership/efficiency rules about agent devices, not about warranty data.
 */
export async function syncWarrantyForSubject(input: {
  orgId: string;
  manufacturer: string;
  serialNumber: string;
  subject: WarrantySubject;
}): Promise<void> {
  const { orgId, manufacturer, serialNumber, subject } = input;
  const label = subject.kind === 'device'
    ? `device ${subject.deviceId}`
    : `manual asset ${subject.manualAssetId}`;

  const provider = getProviderForManufacturer(manufacturer);
  if (!provider) {
    // Check if we already have agent-reported warranty data for this subject.
    // If so, don't overwrite it with an error — just skip. Only an agent writes
    // 'agent_plist', so only a device subject can ever carry it.
    if (subject.kind === 'device') {
      const [existing] = await db
        .select({ dataSource: deviceWarranty.dataSource, status: deviceWarranty.status })
        .from(deviceWarranty)
        .where(eq(deviceWarranty.deviceId, subject.deviceId))
        .limit(1);

      if (existing?.dataSource === 'agent_plist') {
        // Agent-reported data exists — preserve it regardless of status, just update nextSyncAt
        const now = new Date();
        await db
          .update(deviceWarranty)
          .set({
            lastSyncAt: now,
            lastSyncError: null,
            nextSyncAt: new Date(now.getTime() + SYNC_CADENCE_MS),
            updatedAt: now,
          })
          .where(eq(deviceWarranty.deviceId, subject.deviceId));
        return;
      }
    }

    // No provider and no agent data — upsert as unknown (not an error)
    await upsertWarranty(subject, orgId, manufacturer, serialNumber, {
      found: false,
      entitlements: [],
      warrantyStartDate: null,
      warrantyEndDate: null,
    });
    return;
  }

  try {
    const results = await provider.lookup([serialNumber]);
    const result = results.get(serialNumber) ?? {
      found: false,
      entitlements: [],
      warrantyStartDate: null,
      warrantyEndDate: null,
    };

    await upsertWarranty(subject, orgId, manufacturer, serialNumber, result);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[WarrantySync] Error syncing ${label}:`, errorMsg);
    await upsertWarranty(subject, orgId, manufacturer, serialNumber, {
      found: false,
      entitlements: [],
      warrantyStartDate: null,
      warrantyEndDate: null,
      error: errorMsg,
    });
  }

  // Evaluate warranty alerts after sync.
  //
  // DELIBERATELY device-only. Manual-asset warranty is *displayed*, never
  // alerted on, in v1 (#4622): the alert evaluator is device-shaped end to end
  // (device alerts, device dedupe keys, device notification routing), and a
  // hand-entered asset has no agent to remediate against. A stated decision,
  // not an oversight — do not "fix" it by widening the call.
  if (subject.kind === 'device') {
    try {
      await evaluateWarrantyAlerts(subject.deviceId);
    } catch (err) {
      console.error(`[WarrantySync] Alert evaluation error for device ${subject.deviceId}:`, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Sync a hand-entered asset (#4622). Eligible only when the technician supplied
 * BOTH a manufacturer and a serial — a vendor lookup missing either is a
 * guaranteed miss that burns vendor quota.
 */
export async function syncWarrantyForManualAsset(manualAssetId: string): Promise<void> {
  const [asset] = await db
    .select({
      orgId: manualAssets.orgId,
      manufacturer: manualAssets.manufacturer,
      serialNumber: manualAssets.serialNumber,
    })
    .from(manualAssets)
    .where(eq(manualAssets.id, manualAssetId))
    .limit(1);

  if (!asset?.manufacturer || !asset?.serialNumber) {
    console.log(`[WarrantySync] No serial/manufacturer for manual asset ${manualAssetId}, skipping`);
    return;
  }

  await syncWarrantyForSubject({
    orgId: asset.orgId,
    manufacturer: asset.manufacturer,
    serialNumber: asset.serialNumber,
    subject: { kind: 'manualAsset', manualAssetId },
  });
}

async function upsertWarranty(
  subject: WarrantySubject,
  orgId: string,
  manufacturer: string,
  serialNumber: string,
  result: WarrantyLookupResult
): Promise<void> {
  const status = result.found
    ? computeWarrantyStatus(result.warrantyEndDate)
    : 'unknown';

  const now = new Date();
  const nextSyncAt = new Date(now.getTime() + SYNC_CADENCE_MS);

  // Exactly one subject column is non-null — device_warranty_one_subject_chk
  // rejects any other combination with 23514, and the two partial unique
  // indexes give each kind its own conflict target.
  const deviceId = subject.kind === 'device' ? subject.deviceId : null;
  const manualAssetId = subject.kind === 'manualAsset' ? subject.manualAssetId : null;
  const conflictTarget = subject.kind === 'device'
    ? deviceWarranty.deviceId
    : deviceWarranty.manualAssetId;
  // Both unique indexes are PARTIAL now. Postgres can only infer a partial
  // unique index as the ON CONFLICT arbiter when the statement repeats its
  // predicate verbatim — without `targetWhere` this raises 42P10 ("no unique
  // or exclusion constraint matching the ON CONFLICT specification") for
  // EVERY warranty upsert, device rows included.
  const conflictWhere = subject.kind === 'device'
    ? sql`${deviceWarranty.deviceId} IS NOT NULL`
    : sql`${deviceWarranty.manualAssetId} IS NOT NULL`;

  await db
    .insert(deviceWarranty)
    .values({
      deviceId,
      manualAssetId,
      orgId,
      manufacturer: normalizeManufacturer(manufacturer),
      serialNumber,
      status,
      warrantyStartDate: result.warrantyStartDate,
      warrantyEndDate: result.warrantyEndDate,
      entitlements: result.entitlements,
      dataSource: 'provider',
      lastSyncAt: now,
      lastSyncError: result.error ?? null,
      nextSyncAt,
    })
    .onConflictDoUpdate({
      target: conflictTarget,
      targetWhere: conflictWhere,
      set: {
        orgId,
        manufacturer: normalizeManufacturer(manufacturer),
        serialNumber,
        status,
        warrantyStartDate: result.warrantyStartDate,
        warrantyEndDate: result.warrantyEndDate,
        entitlements: result.entitlements,
        dataSource: 'provider',
        lastSyncAt: now,
        lastSyncError: result.error ?? null,
        nextSyncAt,
        updatedAt: now,
      },
    });
}

/** Upsert warranty data reported directly by the agent (e.g. Apple plist). */
export interface AgentWarrantyData {
  source: string;
  manufacturer: string;
  serialNumber: string | null;
  coverageEndDate: string | null;
  coverageStartDate: string | null;
  coverageType: string | null;
  /**
   * Coverage kind from the macOS NDO label verb: 'subscription' ("Renews ...")
   * vs 'fixed' ("Expires ..."). For a subscription, coverageEndDate is the next
   * renewal date, not a true expiry — status is recorded as 'subscription_active'
   * and the expiry alert is suppressed downstream. An empty string ('') means
   * the verb couldn't be classified (timestamp-only/labelless/localized/plist
   * fallback, or an older agent); it's treated as 'fixed' for back-compat.
   */
  coverageKind?: 'subscription' | 'fixed' | '' | null;
}

/** Return the date string if it parses to a valid Date, otherwise null. */
function sanitizeDateOrNull(val: string | null | undefined): string | null {
  if (!val) return null;
  const d = new Date(val);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export async function upsertAgentWarranty(
  deviceId: string,
  orgId: string,
  data: AgentWarrantyData
): Promise<void> {
  // Sanitize dates before DB insert to prevent Postgres errors
  data = {
    ...data,
    coverageStartDate: sanitizeDateOrNull(data.coverageStartDate),
    coverageEndDate: sanitizeDateOrNull(data.coverageEndDate),
  };

  // An active AppleCare subscription reports its next renewal date as the
  // coverage end date, so it perpetually rolls forward. Record it as a distinct
  // status (so the UI / alert gate can treat it as "renewing, no fixed end")
  // rather than a near-term expiry.
  const isSubscription = data.coverageKind === 'subscription';
  const status: WarrantyStatus = isSubscription
    ? 'subscription_active'
    : computeWarrantyStatus(data.coverageEndDate);
  const now = new Date();
  const nextSyncAt = new Date(now.getTime() + SYNC_CADENCE_MS);

  // Build entitlements array from agent data
  const entitlements = data.coverageType
    ? [{
        provider: 'apple' as const,
        serviceLevelDescription: data.coverageType,
        entitlementType: data.coverageType,
        startDate: data.coverageStartDate ?? '',
        endDate: data.coverageEndDate ?? '',
      }]
    : [];

  await db
    .insert(deviceWarranty)
    .values({
      deviceId,
      // #4622 — explicit: the agent path only ever describes a device subject,
      // and device_warranty_one_subject_chk requires the other side to be NULL.
      manualAssetId: null,
      orgId,
      manufacturer: normalizeManufacturer(data.manufacturer),
      serialNumber: data.serialNumber,
      status,
      warrantyStartDate: data.coverageStartDate,
      warrantyEndDate: data.coverageEndDate,
      isSubscription,
      entitlements,
      dataSource: data.source,
      lastSyncAt: now,
      lastSyncError: null,
      nextSyncAt,
    })
    .onConflictDoUpdate({
      target: deviceWarranty.deviceId,
      // device_warranty_device_id_idx is partial since #4622 W03 — the
      // predicate must be repeated or Postgres cannot infer the arbiter (42P10).
      targetWhere: sql`${deviceWarranty.deviceId} IS NOT NULL`,
      set: {
        orgId,
        manufacturer: normalizeManufacturer(data.manufacturer),
        serialNumber: data.serialNumber,
        status,
        warrantyStartDate: data.coverageStartDate,
        warrantyEndDate: data.coverageEndDate,
        isSubscription,
        entitlements,
        dataSource: data.source,
        lastSyncAt: now,
        lastSyncError: null,
        nextSyncAt,
        updatedAt: now,
      },
    });

  // Evaluate warranty alerts after upsert
  try {
    await evaluateWarrantyAlerts(deviceId);
  } catch (err) {
    console.error(`[WarrantySync] Alert evaluation error for device ${deviceId}:`, err instanceof Error ? err.message : err);
  }
}

export async function syncWarrantyBatch(subjects: WarrantySubject[]): Promise<void> {
  for (const subject of subjects) {
    try {
      if (subject.kind === 'device') {
        await syncWarrantyForDevice(subject.deviceId);
      } else {
        await syncWarrantyForManualAsset(subject.manualAssetId);
      }
    } catch (err) {
      const label = subject.kind === 'device'
        ? `device ${subject.deviceId}`
        : `manual asset ${subject.manualAssetId}`;
      console.error(`[WarrantySync] Batch sync error for ${label}:`, err instanceof Error ? err.message : err);
    }
  }
}

/**
 * The 7-day fleet sweep, now over both subject kinds (#4622).
 *
 * Two queries rather than one `UNION ALL`: the arms join different tables and
 * project different key columns, and merging in TypeScript keeps the *global*
 * limit honest — each arm is fetched up to `limit`, the union is ordered by how
 * overdue each subject is, and the slice is taken across both. A per-arm limit
 * would let a large device fleet starve manual assets forever.
 *
 * A NULL `nextSyncAt` means "no warranty row yet", which is the most overdue
 * state there is, so it sorts first.
 */
export async function getDevicesNeedingWarrantySync(limit = 50): Promise<WarrantySubject[]> {
  const now = new Date();

  const deviceRows = await db
    .select({ deviceId: devices.id, nextSyncAt: deviceWarranty.nextSyncAt })
    .from(devices)
    .leftJoin(deviceWarranty, eq(devices.id, deviceWarranty.deviceId))
    .leftJoin(deviceHardware, eq(devices.id, deviceHardware.deviceId))
    .where(
      and(
        // Quick Support exclusion — see syncWarrantyForDevice above.
        eq(devices.isEphemeral, false),
        // Virtual-machine exclusion — see syncWarrantyForDevice above.
        eq(devices.isVirtual, false),
        // Has hardware with serial number
        sql`${deviceHardware.serialNumber} IS NOT NULL`,
        sql`${deviceHardware.manufacturer} IS NOT NULL`,
        // Either no warranty row or next sync is due
        or(
          isNull(deviceWarranty.id),
          lt(deviceWarranty.nextSyncAt, now)
        )
      )
    )
    // NULLS FIRST is explicit: Postgres defaults ASC to NULLS LAST, which would
    // push "never synced yet" — the most overdue state there is — to the END of
    // the fetched page, so a backlog of already-due rows would starve brand-new
    // subjects forever. The JS re-sort below cannot fix what the page never
    // returned.
    .orderBy(sql`${deviceWarranty.nextSyncAt} ASC NULLS FIRST`)
    .limit(limit);

  const manualRows = await db
    .select({ manualAssetId: manualAssets.id, nextSyncAt: deviceWarranty.nextSyncAt })
    .from(manualAssets)
    .leftJoin(deviceWarranty, eq(manualAssets.id, deviceWarranty.manualAssetId))
    .where(
      and(
        // A vendor lookup needs both, and a retired asset is not worth quota.
        sql`${manualAssets.manufacturer} IS NOT NULL`,
        sql`${manualAssets.serialNumber} IS NOT NULL`,
        isNull(manualAssets.retiredAt),
        or(
          isNull(deviceWarranty.id),
          lt(deviceWarranty.nextSyncAt, now)
        )
      )
    )
    .orderBy(sql`${deviceWarranty.nextSyncAt} ASC NULLS FIRST`)
    .limit(limit);

  type Candidate = { subject: WarrantySubject; nextSyncAt: Date | null };
  const candidates: Candidate[] = [
    ...deviceRows.map((r) => ({
      subject: { kind: 'device', deviceId: r.deviceId } as WarrantySubject,
      nextSyncAt: r.nextSyncAt,
    })),
    ...manualRows.map((r) => ({
      subject: { kind: 'manualAsset', manualAssetId: r.manualAssetId } as WarrantySubject,
      nextSyncAt: r.nextSyncAt,
    })),
  ];

  candidates.sort((a, b) => {
    const at = a.nextSyncAt ? a.nextSyncAt.getTime() : Number.NEGATIVE_INFINITY;
    const bt = b.nextSyncAt ? b.nextSyncAt.getTime() : Number.NEGATIVE_INFINITY;
    return at - bt;
  });

  return candidates.slice(0, limit).map((c) => c.subject);
}
