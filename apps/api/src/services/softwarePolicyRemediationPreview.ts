/**
 * #3616 — the dry run behind the software-policy Remediate confirmation.
 *
 * Incident #3381: one click on an unlabelled Remediate icon POSTed an empty
 * body, the route resolved every violating device (up to 500) on its own, and
 * 259 machines had software uninstalled with no number shown beforehand. The
 * confirmation dialog now asks the server for this summary first, shows the
 * operator the blast radius, and confirms by sending back exactly
 * `deviceIds` — so the set that runs is the set that was shown, never a set
 * the route re-resolves after the fact.
 *
 * Only `unauthorized` violations are uninstall work (the remediation worker
 * skips everything else and marks a device with none as completed), so a
 * device whose row carries only `missing` violations is not a target here.
 * Per-device dedupe mirrors the worker's normalizeSoftwareKey — trimmed,
 * lower-cased (name, version) — so the preview count is the command count.
 */

import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { devices, softwareComplianceStatus } from '../db/schema';

/** Upper bound on one remediation request — the remediate route's explicit
 *  deviceIds schema, its legacy implicit selection, and this preview. */
export const MAX_REMEDIATION_DEVICES = 500;

export const REMEDIATION_PREVIEW_SAMPLE_DEVICES = 10;
export const REMEDIATION_PREVIEW_TOP_SOFTWARE = 15;

export type RemediationPreviewRow = {
  deviceId: string;
  hostname: string | null;
  violations: unknown;
};

export type RemediationPreviewUninstall = { name: string; version?: string };

export type RemediationPreviewSummary = {
  /** Every device that would receive at least one uninstall, in row order. */
  deviceIds: string[];
  deviceCount: number;
  /** Total uninstall commands across all target devices. */
  uninstallCount: number;
  /** Most-affected software first, by name (case-insensitive), bounded. */
  software: Array<{ name: string; deviceCount: number }>;
  softwareDistinctCount: number;
  /** The first few target devices with exactly what each would lose. */
  sampleDevices: Array<{
    deviceId: string;
    hostname: string | null;
    uninstalls: RemediationPreviewUninstall[];
  }>;
};

function readUninstalls(violations: unknown): RemediationPreviewUninstall[] {
  if (!Array.isArray(violations)) return [];
  const out: RemediationPreviewUninstall[] = [];
  const seen = new Set<string>();
  for (const violation of violations) {
    if (!violation || typeof violation !== 'object') continue;
    const typed = violation as { type?: unknown; software?: { name?: unknown; version?: unknown } };
    if (typed.type !== 'unauthorized') continue;
    const name = typeof typed.software?.name === 'string' ? typed.software.name.trim() : '';
    if (!name) continue;
    const version = typeof typed.software?.version === 'string' ? typed.software.version.trim() : '';
    const key = `${name.toLowerCase()}::${version.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(version ? { name, version } : { name });
  }
  return out;
}

export function summarizeRemediationTargets(rows: RemediationPreviewRow[]): RemediationPreviewSummary {
  const perDevice = new Map<string, { hostname: string | null; uninstalls: RemediationPreviewUninstall[] }>();

  for (const row of rows) {
    const uninstalls = readUninstalls(row.violations);
    if (uninstalls.length === 0) continue;
    const existing = perDevice.get(row.deviceId);
    if (!existing) {
      perDevice.set(row.deviceId, { hostname: row.hostname, uninstalls });
      continue;
    }
    const keys = new Set(existing.uninstalls.map((u) => `${u.name.toLowerCase()}::${(u.version ?? '').toLowerCase()}`));
    for (const u of uninstalls) {
      const key = `${u.name.toLowerCase()}::${(u.version ?? '').toLowerCase()}`;
      if (!keys.has(key)) {
        keys.add(key);
        existing.uninstalls.push(u);
      }
    }
  }

  // Software tally by name: a device counts once per name even when it holds
  // several versions, because "how many machines lose Zoom" is the question.
  const software = new Map<string, { name: string; devices: Set<string> }>();
  let uninstallCount = 0;
  for (const [deviceId, entry] of perDevice) {
    uninstallCount += entry.uninstalls.length;
    for (const u of entry.uninstalls) {
      const key = u.name.toLowerCase();
      let bucket = software.get(key);
      if (!bucket) {
        bucket = { name: u.name, devices: new Set() };
        software.set(key, bucket);
      }
      bucket.devices.add(deviceId);
    }
  }

  const deviceIds = Array.from(perDevice.keys());
  return {
    deviceIds,
    deviceCount: deviceIds.length,
    uninstallCount,
    software: Array.from(software.values())
      .map((b) => ({ name: b.name, deviceCount: b.devices.size }))
      .sort((a, b) => b.deviceCount - a.deviceCount || a.name.localeCompare(b.name))
      .slice(0, REMEDIATION_PREVIEW_TOP_SOFTWARE),
    softwareDistinctCount: software.size,
    sampleDevices: deviceIds.slice(0, REMEDIATION_PREVIEW_SAMPLE_DEVICES).map((deviceId) => {
      const entry = perDevice.get(deviceId)!;
      return { deviceId, hostname: entry.hostname, uninstalls: entry.uninstalls };
    }),
  };
}

/**
 * Conditions selecting a policy's violating devices the caller may act on.
 * `orgCondition` is the caller's tenant filter on devices.org_id (undefined =
 * unrestricted system scope); `siteAllowedDeviceIds` is the app-layer site
 * ceiling (null = no site restriction). Returns null when the caller can reach
 * no devices at all. Shared by this preview and the remediate route's legacy
 * implicit path so the two cannot drift.
 */
export function implicitRemediationConditions(
  policyId: string,
  orgCondition: SQL | undefined,
  siteAllowedDeviceIds: string[] | null,
): SQL[] | null {
  const conditions: SQL[] = [
    eq(softwareComplianceStatus.policyId, policyId),
    eq(softwareComplianceStatus.status, 'violation'),
  ];
  if (orgCondition) conditions.push(orgCondition);
  if (siteAllowedDeviceIds) {
    if (siteAllowedDeviceIds.length === 0) return null;
    conditions.push(inArray(softwareComplianceStatus.deviceId, siteAllowedDeviceIds));
  }
  return conditions;
}

export type RemediationPreviewResult = RemediationPreviewSummary & {
  /** Uncapped count of devices that qualify; >= deviceCount. */
  totalTargetDevices: number;
  capped: boolean;
  maxDevices: number;
};

/**
 * Resolve and summarize the uninstall target set for a policy. Narrowed to
 * devices whose violations contain an `unauthorized` entry — the only kind the
 * uninstall worker acts on — ordered by hostname, capped at
 * MAX_REMEDIATION_DEVICES, with a separate uncapped COUNT(DISTINCT) so a
 * capped run says so rather than reporting the cap as the total.
 */
export async function queryRemediationPreview(input: {
  policyId: string;
  orgCondition: SQL | undefined;
  siteAllowedDeviceIds: string[] | null;
}): Promise<RemediationPreviewResult> {
  const base = implicitRemediationConditions(input.policyId, input.orgCondition, input.siteAllowedDeviceIds);

  let rows: RemediationPreviewRow[] = [];
  let total = 0;
  if (base) {
    const conditions = and(
      ...base,
      sql`${softwareComplianceStatus.violations} @> '[{"type":"unauthorized"}]'::jsonb`,
    );
    rows = await db
      .select({
        deviceId: softwareComplianceStatus.deviceId,
        hostname: devices.hostname,
        violations: softwareComplianceStatus.violations,
      })
      .from(softwareComplianceStatus)
      .innerJoin(devices, eq(softwareComplianceStatus.deviceId, devices.id))
      .where(conditions)
      .orderBy(devices.hostname, softwareComplianceStatus.deviceId)
      .limit(MAX_REMEDIATION_DEVICES);

    const [countRow] = await db
      .select({ count: sql<number>`count(distinct ${softwareComplianceStatus.deviceId})::int` })
      .from(softwareComplianceStatus)
      .innerJoin(devices, eq(softwareComplianceStatus.deviceId, devices.id))
      .where(conditions);
    total = Number(countRow?.count ?? 0);
  }

  const summary = summarizeRemediationTargets(rows);
  // The count can only be >= the capped selection; never report a total
  // smaller than what is actually listed.
  const totalTargetDevices = Math.max(total, summary.deviceCount);
  return {
    ...summary,
    totalTargetDevices,
    capped: totalTargetDevices > summary.deviceCount,
    maxDevices: MAX_REMEDIATION_DEVICES,
  };
}
