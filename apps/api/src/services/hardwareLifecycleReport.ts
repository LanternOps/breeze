/**
 * Hardware Lifecycle report — the customer-facing device replacement plan.
 *
 * Ported from the LanternOps portal's Hardware Lifecycle PDF. The band rules
 * live in `@breeze/shared` (`utils/hardwareLifecycle.ts`) so the PDF renderer
 * and the web preview read the persisted snapshot with exactly the arithmetic
 * that produced it. This module only does the data gathering:
 *
 *  - agent devices (+ device_hardware for make/model/serial, + device_warranty
 *    for the active coverage end) — ephemeral, virtual and decommissioned rows
 *    excluded;
 *  - hand-entered manual assets (+ their own device_warranty row), unless the
 *    config turns them off;
 *  - the split into "computers" (workstations / servers / unknown-role agent
 *    devices) and "other equipment we manage" (print / network / IoT gear),
 *    which gets no replacement timeline.
 *
 * "No purchase date" is a genuine null: such a device is `unknown`, never
 * "new" — the never-scanned ≠ verified-clean discipline.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db';
import {
  deviceHardware,
  deviceWarranty,
  devices,
  manualAssets,
  organizations,
  sites,
} from '../db/schema';
import { hardwareLifecycleConfigSchema } from './reportConfigSchemas';
import type {
  HardwareLifecycleDeviceRow,
  HardwareLifecycleOtherRow,
  HardwareLifecycleSummary,
  OsSupportStatus,
} from '@breeze/shared';
import {
  ageYears,
  buildHardwareLifecycleRecommendations,
  classifyOsSupport,
  cleanUserName,
  classifyReplacement,
  countByOsSupport,
  countByReplacement,
  displayOs,
  lifeUsedFraction,
  replacementDueDate,
  sortLifecycleRows,
  todayIso,
  warrantyExtendsLife,
} from '@breeze/shared';
import {
  assertReportExecutionPreflight,
  type ReportResult,
} from './reportGenerationService';
import type { OrgReportExecutionAuthority } from './siteScope';

/** Roles that are computers with a replacement timeline. `unknown` is the
 *  enrollment default — an agent device with an OS is a computer until a
 *  technician says otherwise. */
const COMPUTER_ROLES = new Set(['workstation', 'server', 'unknown']);

/**
 * `upsertWarranty` (services/warrantySync.ts) writes `status: 'unknown'` both
 * when a vendor genuinely reports no coverage AND when the lookup itself
 * failed (network, expired API key, quota) — only `lastSyncError` tells them
 * apart. Require both signals: a failed lookup always leaves `status`
 * `'unknown'` (the catch path never reaches `computeWarrantyStatus`), so this
 * also reads false for a device that has never been synced at all (`status`
 * null, `lastSyncError` null) — the report should not flag a row as
 * "lookup failed" for a lookup that was simply never attempted (#5764).
 */
function deriveWarrantyLookupFailed(status: string | null, lastSyncError: string | null): boolean {
  return status === 'unknown' && lastSyncError != null;
}

type Subject = {
  id: string;
  kind: 'device' | 'manual_asset';
  name: string;
  hostname: string | null;
  user: string | null;
  site: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  osType: string | null;
  osVersion: string | null;
  category: string;
  purchaseDate: string | null;
  purchaseDateSource: 'manual' | 'vendor' | null;
  warrantyEndDate: string | null;
  warrantyIsSubscription: boolean;
  warrantyLookupFailed: boolean;
};

function isComputer(s: Subject): boolean {
  return COMPUTER_ROLES.has(s.category);
}

function toDeviceRow(s: Subject, today: string, replaceAgeYears: number): HardwareLifecycleDeviceRow {
  // An AppleCare subscription's "end" is the next renewal, not an expiry —
  // it must not extend the replacement runway.
  const warrantyEnd = s.warrantyIsSubscription ? null : s.warrantyEndDate;
  const osSupport: OsSupportStatus = s.kind === 'manual_asset' && !s.osType && !s.osVersion
    ? 'na'
    : classifyOsSupport(s.osType, s.osVersion);
  const replaceBy = replacementDueDate(s.purchaseDate, warrantyEnd, { today, replaceAgeYears });
  return {
    id: s.id,
    kind: s.kind,
    name: s.name,
    hostname: s.hostname,
    user: s.user,
    deviceKind: s.category === 'server' ? 'server' : 'workstation',
    site: s.site,
    manufacturer: s.manufacturer,
    model: s.model,
    serialNumber: s.serialNumber,
    os: displayOs(s.osType, s.osVersion),
    osSupport,
    purchaseDate: s.purchaseDate,
    purchaseDateSource: s.purchaseDateSource,
    warrantyEndDate: s.warrantyEndDate,
    warrantyLookupFailed: s.warrantyLookupFailed,
    ageYears: ageYears(s.purchaseDate, today),
    replaceBy,
    replacement: classifyReplacement(replaceBy, today),
    warrantyExtended: warrantyExtendsLife(s.purchaseDate, warrantyEnd, replaceBy, { today, replaceAgeYears }),
    lifeUsed: lifeUsedFraction(s.purchaseDate, replaceBy, today),
  };
}

function toOtherRow(s: Subject): HardwareLifecycleOtherRow {
  return {
    id: s.id,
    kind: s.kind,
    name: s.name,
    manufacturer: s.manufacturer,
    model: s.model,
    serialNumber: s.serialNumber,
    category: s.category,
  };
}

export async function generateHardwareLifecycleReport(
  orgId: string,
  rawConfig: Record<string, unknown>,
  authority: OrgReportExecutionAuthority,
): Promise<ReportResult> {
  const cfg = hardwareLifecycleConfigSchema.parse(rawConfig ?? {});
  const generatedAt = new Date().toISOString();
  const today = todayIso();

  assertReportExecutionPreflight(orgId, cfg, authority, 'hardware_lifecycle');

  const restrictedScope = authority.scope.kind === 'restricted' ? authority.scope : null;
  if (restrictedScope && restrictedScope.siteIds.length === 0) {
    return { rows: [], rowCount: 0, generatedAt, summary: emptySummary(orgId, generatedAt, cfg.replaceAgeYears, cfg.serverReplaceAgeYears) };
  }

  const [orgRow] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  // --- agent devices ---------------------------------------------------------
  const deviceConditions = [
    eq(devices.orgId, orgId),
    eq(devices.isEphemeral, false),
    eq(devices.isVirtual, false),
    isNull(devices.decommissionedAt),
  ];
  if (cfg.sites.length > 0) deviceConditions.push(inArray(devices.siteId, cfg.sites));
  if (restrictedScope) deviceConditions.push(inArray(devices.siteId, restrictedScope.siteIds));

  const deviceRows = await db
    .select({
      id: devices.id,
      hostname: devices.hostname,
      displayName: devices.displayName,
      lastUser: devices.lastUser,
      osType: devices.osType,
      osVersion: devices.osVersion,
      deviceRole: devices.deviceRole,
      purchaseDate: devices.purchaseDate,
      purchaseDateSource: devices.purchaseDateSource,
      siteName: sites.name,
      manufacturer: deviceHardware.manufacturer,
      model: deviceHardware.model,
      serialNumber: deviceHardware.serialNumber,
      warrantyEndDate: deviceWarranty.warrantyEndDate,
      warrantyIsSubscription: deviceWarranty.isSubscription,
      warrantyStatus: deviceWarranty.status,
      warrantyLastSyncError: deviceWarranty.lastSyncError,
    })
    .from(devices)
    .leftJoin(sites, eq(devices.siteId, sites.id))
    .leftJoin(deviceHardware, eq(deviceHardware.deviceId, devices.id))
    .leftJoin(deviceWarranty, eq(deviceWarranty.deviceId, devices.id))
    .where(and(...deviceConditions));

  const subjects: Subject[] = (deviceRows ?? []).map((d) => ({
    id: d.id,
    kind: 'device' as const,
    name: d.displayName?.trim() || d.hostname,
    hostname: d.hostname,
    user: cleanUserName(d.lastUser),
    site: d.siteName ?? null,
    manufacturer: d.manufacturer ?? null,
    model: d.model ?? null,
    serialNumber: d.serialNumber ?? null,
    osType: d.osType ?? null,
    osVersion: d.osVersion ?? null,
    category: d.deviceRole ?? 'unknown',
    purchaseDate: d.purchaseDate ?? null,
    purchaseDateSource: d.purchaseDateSource ?? null,
    warrantyEndDate: d.warrantyEndDate ?? null,
    warrantyIsSubscription: d.warrantyIsSubscription === true,
    warrantyLookupFailed: deriveWarrantyLookupFailed(d.warrantyStatus ?? null, d.warrantyLastSyncError ?? null),
  }));

  // --- manual assets ---------------------------------------------------------
  if (cfg.includeManualAssets) {
    const assetConditions = [eq(manualAssets.orgId, orgId), isNull(manualAssets.retiredAt)];
    if (cfg.sites.length > 0) assetConditions.push(inArray(manualAssets.siteId, cfg.sites));
    if (restrictedScope) assetConditions.push(inArray(manualAssets.siteId, restrictedScope.siteIds));

    const assetRows = await db
      .select({
        id: manualAssets.id,
        name: manualAssets.name,
        assetType: manualAssets.assetType,
        manufacturer: manualAssets.manufacturer,
        model: manualAssets.model,
        serialNumber: manualAssets.serialNumber,
        purchaseDate: manualAssets.purchaseDate,
        purchaseDateSource: manualAssets.purchaseDateSource,
        siteName: sites.name,
        warrantyEndDate: deviceWarranty.warrantyEndDate,
        warrantyIsSubscription: deviceWarranty.isSubscription,
        warrantyStatus: deviceWarranty.status,
        warrantyLastSyncError: deviceWarranty.lastSyncError,
      })
      .from(manualAssets)
      .leftJoin(sites, eq(manualAssets.siteId, sites.id))
      .leftJoin(deviceWarranty, eq(deviceWarranty.manualAssetId, manualAssets.id))
      .where(and(...assetConditions));

    for (const a of assetRows ?? []) {
      subjects.push({
        id: a.id,
        kind: 'manual_asset',
        name: a.name,
        hostname: null,
        user: null,
        site: a.siteName ?? null,
        manufacturer: a.manufacturer ?? null,
        model: a.model ?? null,
        serialNumber: a.serialNumber ?? null,
        osType: null,
        osVersion: null,
        category: a.assetType ?? 'unknown',
        purchaseDate: a.purchaseDate ?? null,
        purchaseDateSource: a.purchaseDateSource ?? null,
        warrantyEndDate: a.warrantyEndDate ?? null,
        warrantyIsSubscription: a.warrantyIsSubscription === true,
        warrantyLookupFailed: deriveWarrantyLookupFailed(a.warrantyStatus ?? null, a.warrantyLastSyncError ?? null),
      });
    }
  }

  // --- split + classify --------------------------------------------------------
  // A manual asset of unknown type has no OS to prove it is a computer; keep it
  // with the other equipment rather than inventing a replacement timeline.
  const computers = subjects.filter((s) => isComputer(s) && !(s.kind === 'manual_asset' && s.category === 'unknown'));
  const other = subjects.filter((s) => !computers.includes(s));

  const rows = sortLifecycleRows(computers.map((s) => toDeviceRow(s, today, s.category === 'server' ? cfg.serverReplaceAgeYears : cfg.replaceAgeYears)));
  const otherRows = cfg.includeOtherEquipment
    ? other.map(toOtherRow).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    : [];

  const summary = {
    org: { id: orgRow?.id ?? orgId, name: orgRow?.name ?? '' },
    generatedAt,
    replaceAgeYears: cfg.replaceAgeYears,
    serverReplaceAgeYears: cfg.serverReplaceAgeYears,
    computers: {
      total: rows.length,
      byReplacement: countByReplacement(rows),
      byOsSupport: countByOsSupport(rows),
    },
    otherEquipmentCount: otherRows.length,
    rows,
    other: otherRows,
    recommendations: buildHardwareLifecycleRecommendations(rows, today),
  } satisfies HardwareLifecycleSummary;

  return { rows, rowCount: rows.length, generatedAt, summary };
}

function emptySummary(orgId: string, generatedAt: string, replaceAgeYears: number, serverReplaceAgeYears: number): HardwareLifecycleSummary {
  return {
    org: { id: orgId, name: '' },
    generatedAt,
    replaceAgeYears,
    serverReplaceAgeYears,
    computers: { total: 0, byReplacement: { supported: 0, due_soon: 0, replace: 0, unknown: 0 }, byOsSupport: { supported: 0, ending: 0, ended: 0, unclassified: 0 } },
    otherEquipmentCount: 0,
    rows: [],
    other: [],
    recommendations: buildHardwareLifecycleRecommendations([]),
  };
}
