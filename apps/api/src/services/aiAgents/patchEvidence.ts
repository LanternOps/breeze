/**
 * Bounded patch evidence for a `patch`-profile agent run (AI patch agent W01).
 *
 * ## Why the evidence is SYSTEM-EXECUTED
 *
 * Same design as `sweepEvidence.ts` / `designEvidence.ts`: the model never
 * assembles its own picture of an org's patch state by wandering through
 * tools. Every section below is ONE hand-written, org-pinned read, and the run
 * is handed the result before its first turn. The model gets a small
 * read-only drill-down floor (`patchProfile.ts`) to confirm a line, and one
 * outcome tool, `submit_patch_plan`, whose every reference is validated
 * against THIS bundle (`patchEvidenceRefs`).
 *
 * ## Aggregate-first
 *
 * A real fleet has thousands of (device, patch) pairs; 40 rows at 24 KiB
 * would truncate it into nonsense. So the bundle leads with a SCALAR rollup
 * (device/patch/severity counts, oldest outstanding age, the latest compliance
 * snapshot's scalars), then per-ring posture, then the worst devices with a
 * small per-device sample of their outstanding patches, then the reboot
 * backlog. Counts are real (`COUNT(*) OVER ()` / aggregates); rows are samples.
 *
 * ## The properties this module holds (copied from sweepEvidence.ts)
 *
 *  - **Display scalars only, off named columns.** No jsonb/bytea/free-text
 *    column reaches the bundle: `patch_policies.targets/schedule/
 *    reboot_policy/category_rules`, `patch_jobs.patches/targets`,
 *    `patch_job_results.output`, `patch_compliance_snapshots.
 *    details_by_category`, `patches.description/metadata/install_command`,
 *    `device_patches.last_error` are never selected. The ONE jsonb read is
 *    `patch_policies.auto_approve`, parsed server-side through the canonical
 *    `parseRingAutoApprove` into a short summary string — the raw object is
 *    never emitted.
 *  - **Untrusted vendor text.** `patches.title`/`vendor` come from vendor
 *    catalogs, not from the operator. They are bounded and flattened with
 *    `sanitizeSweepText` (≤ 256 chars, `\p{C}` → space) and nothing in this
 *    program derives authority, eligibility or retryability from them.
 *  - **Bounded, twice.** `PATCH_EVIDENCE_MAX_ROWS_PER_SECTION` per section,
 *    `PATCH_EVIDENCE_MAX_PATCHES_PER_DEVICE` per device, then a UTF-8 byte
 *    ceiling that drops WHOLE rows from the tail of the largest section.
 *  - **Truncation is observable.** Loaders ask for MAX+1 and carry the real
 *    total — the `anomalyContext.ts` #3828 bug is a bare `LIMIT MAX`.
 *  - **Per-section failure isolation** (`settled()`): a broken read degrades
 *    to an `unavailable` section the prompt renders as "(not measured)".
 *    EXCEPTION: the compliance rollup. A plan with no posture is not a plan,
 *    so a missing rollup throws `PatchEvidenceUnavailableError` and the run
 *    fails with `patch_evidence_unavailable` (mirror of the design run's
 *    device-section rule).
 *
 * ## Tenancy
 *
 * `loadPatchEvidence` runs inside the run loop's SYSTEM DB context (full RLS
 * bypass) and manages none of its own. The `org_id = $orgId` predicate is
 * therefore the ONLY tenant boundary: every statement pins it on
 * `device_patches` AND on `devices`, and excludes ephemeral (Quick Support)
 * devices. `patches` is a global vendor catalog with no tenant column — it is
 * only ever reached through an org-pinned `device_patches` row.
 * `patch_policies`/`patch_approvals` are partner-axis (no `org_id`): they are
 * pinned to the ORG'S partner (resolved by the caller from the org row), and
 * never joined to a device without the device's own org pin.
 *
 * ## Honest gaps (W01)
 *
 *  - No next-window time. There is no future-occurrence projector for
 *    config-policy maintenance (plan index correction 18); a row reports only
 *    whether a config-policy maintenance window RESOLVES for the device and
 *    whether it is ACTIVE NOW. W04 builds the projector.
 *  - `heldByDeferral` is `null`: the deferral predicate is private to
 *    `patchApprovalEvaluator` and W02 extracts it
 *    (`resolvePatchInstallEligibility`). Reported as a marked gap, not a guess.
 *  - `failedWork` ships as an unavailable shell; W03 fills it from
 *    `patch_job_results` (org reached through `patch_jobs.org_id` AND
 *    `devices.org_id` — that table has no tenant column of its own).
 */
import { sql, type SQL } from 'drizzle-orm';

import type { PatchPlanOutcomeRefs } from '@breeze/shared';

// Late-bound namespace import — see sweepEvidence.ts on why (vi.mock).
import * as dbModule from '../../db';
import { OUTSTANDING_DEVICE_PATCH_STATUSES } from '../../db/schema';
import { isCategoryAllowed, parseRingAutoApprove } from '../patchApprovalEvaluator';
import { isInMaintenanceWindow, resolveMaintenanceConfigForDevice } from '../featureConfigResolver';
import { captureException } from '../sentry';
import { sanitizeSweepText } from './runnerPrompt';

/** Ceiling on the serialized sections — double the sweep ceiling: the bundle
 *  is aggregate-first and covers four row sections. */
export const PATCH_EVIDENCE_HARD_LIMIT_BYTES = 24 * 1024;
export const PATCH_EVIDENCE_MAX_ROWS_PER_SECTION = 40;
export const PATCH_EVIDENCE_MAX_PATCHES_PER_DEVICE = 8;
/** `sanitizeSweepText` appends one ellipsis char on truncation, so 255 keeps
 *  every emitted text field ≤ 256 chars. */
const MAX_TEXT_CHARS = 255;
const MAX_CATEGORY_NAMES = 10;

export const PATCH_EVIDENCE_ROW_SECTIONS = ['ringPosture', 'topNonCompliant', 'failedWork', 'rebootBacklog'] as const;
export type PatchEvidenceSectionKey = (typeof PATCH_EVIDENCE_ROW_SECTIONS)[number];

type Scalar = string | number | boolean | null;

export interface PatchEvidencePatch {
  patchId: string;
  /** Untrusted vendor text, sanitized. */
  title: string;
  vendor: string | null;
  severity: string | null;
  /** Days since vendor release (or first seen on the device). */
  ageDays: number | null;
  requiresReboot: boolean | null;
}

export interface PatchEvidenceRow {
  deviceId: string | null;
  hostname: string | null;
  fields: Record<string, Scalar>;
  /** topNonCompliant only: a most-severe-first sample of outstanding patches. */
  patches?: PatchEvidencePatch[];
}

export interface PatchEvidenceSection {
  available: boolean;
  /** Why `available` is false — a display code, never an error message. */
  reason: string | null;
  rows: PatchEvidenceRow[];
  /** The REAL match count, not `rows.length`. */
  total: number;
  truncated: boolean;
}

export interface PatchComplianceSnapshotScalars {
  date: string | null;
  totalDevices: number | null;
  compliantDevices: number | null;
  nonCompliantDevices: number | null;
  criticalMissing: number | null;
  importantMissing: number | null;
  patchesPendingApproval: number | null;
  patchesInstalled24h: number | null;
  failedInstalls24h: number | null;
}

export interface PatchEvidenceRollup {
  devicesTotal: number;
  devicesNonCompliant: number;
  devicesCompliant: number;
  /** Distinct outstanding patches across the org. */
  outstandingPatches: number;
  /** Outstanding (device, patch) pairs by vendor severity. */
  outstandingBySeverity: { critical: number; important: number; moderate: number; low: number; unrated: number };
  oldestOutstandingDays: number | null;
  /** Latest org-wide `patch_compliance_snapshots` scalars, when recent. */
  snapshot: PatchComplianceSnapshotScalars | null;
}

export interface PatchEvidence {
  rollup: PatchEvidenceRollup;
  sections: Record<PatchEvidenceSectionKey, PatchEvidenceSection>;
  /** True when ANY section was capped or byte-trimmed. */
  truncated: boolean;
  /** Sections that could not be measured. */
  unavailable: PatchEvidenceSectionKey[];
}

type RawSection = { rows: PatchEvidenceRow[]; total: number } | { unavailable: string };

export interface RawPatchEvidence {
  rollup: PatchEvidenceRollup | null;
  sections: Record<Exclude<PatchEvidenceSectionKey, 'failedWork'>, RawSection>;
}

/** The compliance rollup could not be read — there is nothing to plan for. */
export class PatchEvidenceUnavailableError extends Error {
  constructor(message = 'patch compliance rollup is unavailable') {
    super(message);
    this.name = 'PatchEvidenceUnavailableError';
  }
}

// ---------------------------------------------------------------------------
// Pure assembly
// ---------------------------------------------------------------------------

function cleanText(value: string | null | undefined): string | null {
  return typeof value === 'string' ? sanitizeSweepText(value, MAX_TEXT_CHARS) : null;
}

function cleanRow(row: PatchEvidenceRow): PatchEvidenceRow {
  const fields: Record<string, Scalar> = {};
  for (const [key, value] of Object.entries(row.fields)) {
    fields[key] = typeof value === 'string' ? sanitizeSweepText(value, MAX_TEXT_CHARS * 8) : value;
  }
  const out: PatchEvidenceRow = { deviceId: row.deviceId, hostname: cleanText(row.hostname), fields };
  if (row.patches) {
    out.patches = row.patches.slice(0, PATCH_EVIDENCE_MAX_PATCHES_PER_DEVICE).map((p) => ({
      patchId: p.patchId,
      title: cleanText(p.title) ?? '',
      vendor: cleanText(p.vendor),
      severity: cleanText(p.severity),
      ageDays: p.ageDays,
      requiresReboot: p.requiresReboot,
    }));
  }
  return out;
}

/**
 * Pure assembly from already-fetched rows (fixture-testable, no DB). Rows are
 * expected MOST IMPORTANT FIRST, because both bounding mechanisms trim from
 * the tail. Throws `PatchEvidenceUnavailableError` when the rollup is null.
 */
export function assemblePatchEvidence(raw: RawPatchEvidence): PatchEvidence {
  if (!raw.rollup) throw new PatchEvidenceUnavailableError();

  const sections = {} as Record<PatchEvidenceSectionKey, PatchEvidenceSection>;
  const unavailable: PatchEvidenceSectionKey[] = [];
  let truncated = false;

  for (const key of PATCH_EVIDENCE_ROW_SECTIONS) {
    if (key === 'failedWork') {
      // W03 fills this from patch_job_results. Shipping the shell now fixes
      // the bundle shape (and the prompt's section list) so W03 is additive.
      sections.failedWork = { available: false, reason: 'not_collected_until_w03', rows: [], total: 0, truncated: false };
      continue;
    }
    const entry = raw.sections[key];
    if ('unavailable' in entry) {
      sections[key] = { available: false, reason: entry.unavailable, rows: [], total: 0, truncated: false };
      unavailable.push(key);
      continue;
    }
    const overflowed = entry.rows.length > PATCH_EVIDENCE_MAX_ROWS_PER_SECTION;
    const patchesCapped = entry.rows.some((r) => (r.patches?.length ?? 0) > PATCH_EVIDENCE_MAX_PATCHES_PER_DEVICE);
    if (overflowed) truncated = true;
    sections[key] = {
      available: true,
      reason: null,
      rows: entry.rows.slice(0, PATCH_EVIDENCE_MAX_ROWS_PER_SECTION).map(cleanRow),
      total: entry.total,
      truncated: overflowed || patchesCapped,
    };
    if (patchesCapped) truncated = true;
  }

  // Byte ceiling: each pass drops ONE whole row — the last row of whichever
  // section currently has the most (ties → catalog order). Never a partial
  // row, never a truncated field.
  while (Buffer.byteLength(JSON.stringify(sections), 'utf8') > PATCH_EVIDENCE_HARD_LIMIT_BYTES) {
    let victim: PatchEvidenceSection | null = null;
    for (const key of PATCH_EVIDENCE_ROW_SECTIONS) {
      const candidate = sections[key];
      if (candidate.rows.length === 0) continue;
      if (!victim || candidate.rows.length > victim.rows.length) victim = candidate;
    }
    if (!victim) break;
    victim.rows = victim.rows.slice(0, -1);
    victim.truncated = true;
    truncated = true;
  }

  return { rollup: raw.rollup, sections, truncated, unavailable };
}

/**
 * The referential refs `submit_patch_plan` and `persistPatchPlan` check every
 * item against — built from the ASSEMBLED bundle (what the model was shown),
 * never from a second query. W01 resolves no maintenance-window ids and no
 * failed job results, so those two sets are always empty.
 */
export function patchEvidenceRefs(evidence: PatchEvidence): PatchPlanOutcomeRefs {
  const deviceIds = new Set<string>();
  const patchIdsByDevice = new Map<string, Set<string>>();
  for (const key of ['topNonCompliant', 'rebootBacklog'] as const) {
    for (const row of evidence.sections[key].rows) {
      if (!row.deviceId) continue;
      deviceIds.add(row.deviceId);
      if (row.patches && row.patches.length > 0) {
        const set = patchIdsByDevice.get(row.deviceId) ?? new Set<string>();
        for (const p of row.patches) set.add(p.patchId);
        patchIdsByDevice.set(row.deviceId, set);
      }
    }
  }
  return { deviceIds, patchIdsByDevice, windowIds: new Set(), jobResultIds: new Set() };
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
const int = (value: unknown): number => Math.trunc(num(value) ?? 0);
function iso(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}
function dateOnly(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  return typeof value === 'string' ? value.slice(0, 10) : null;
}
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const bool = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
const strArray = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

function totalFrom(rows: ReadonlyArray<{ total_count?: unknown }>): number {
  return rows.length === 0 ? 0 : int(rows[0]!.total_count);
}

// ---------------------------------------------------------------------------
// SQL fragments shared by every device_patches read
// ---------------------------------------------------------------------------

const FETCH_LIMIT = PATCH_EVIDENCE_MAX_ROWS_PER_SECTION + 1;

/** `dp.status IN (...)` from the exported constant — never a hand-written
 *  list, and never the 'missing' tombstone. */
function outstandingStatus(): SQL {
  return sql`dp.status IN (${sql.join(OUTSTANDING_DEVICE_PATCH_STATUSES.map((s) => sql`${s}`), sql`, `)})`;
}

/** The org pin on BOTH sides of the device_patches → devices join, plus the
 *  live-device filter. Callers alias the tables `dp` and `d`. */
function orgPinnedOutstanding(orgId: string): SQL {
  return sql`dp.org_id = ${orgId}
      AND d.org_id = ${orgId}
      AND d.is_ephemeral = false
      AND d.status <> 'decommissioned'
      AND ${outstandingStatus()}`;
}

/** Vendor release date when known, else first seen on the device. */
const OUTSTANDING_SINCE = sql`COALESCE(p.release_date::timestamp, dp.created_at)`;
/** Most severe first; unrated last. */
const SEVERITY_RANK = sql`CASE p.severity WHEN 'critical' THEN 0 WHEN 'important' THEN 1 WHEN 'moderate' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

async function loadRollup(orgId: string): Promise<Omit<PatchEvidenceRollup, 'snapshot'>> {
  const rows = await dbModule.db.execute<{
    devices_total: unknown; devices_non_compliant: unknown; outstanding_patches: unknown;
    critical: unknown; important: unknown; moderate: unknown; low: unknown; unrated: unknown;
    oldest_since_days: unknown;
  }>(sql`
    WITH outstanding AS (
      SELECT dp.device_id, dp.patch_id, p.severity, ${OUTSTANDING_SINCE} AS since
      FROM device_patches dp
      JOIN devices d ON d.id = dp.device_id
      JOIN patches p ON p.id = dp.patch_id
      WHERE ${orgPinnedOutstanding(orgId)}
    )
    SELECT
      (SELECT COUNT(*)::int FROM devices d
        WHERE d.org_id = ${orgId} AND d.is_ephemeral = false AND d.status <> 'decommissioned') AS devices_total,
      (SELECT COUNT(DISTINCT device_id)::int FROM outstanding) AS devices_non_compliant,
      (SELECT COUNT(DISTINCT patch_id)::int FROM outstanding) AS outstanding_patches,
      (SELECT COUNT(*)::int FROM outstanding WHERE severity = 'critical') AS critical,
      (SELECT COUNT(*)::int FROM outstanding WHERE severity = 'important') AS important,
      (SELECT COUNT(*)::int FROM outstanding WHERE severity = 'moderate') AS moderate,
      (SELECT COUNT(*)::int FROM outstanding WHERE severity = 'low') AS low,
      (SELECT COUNT(*)::int FROM outstanding WHERE severity IS NULL OR severity = 'unknown') AS unrated,
      (SELECT FLOOR(EXTRACT(EPOCH FROM (now() - MIN(since))) / 86400)::int FROM outstanding) AS oldest_since_days
  `);
  const row = [...rows][0];
  if (!row) throw new PatchEvidenceUnavailableError('patch compliance rollup returned no row');
  const devicesTotal = int(row.devices_total);
  const devicesNonCompliant = int(row.devices_non_compliant);
  return {
    devicesTotal,
    devicesNonCompliant,
    devicesCompliant: Math.max(0, devicesTotal - devicesNonCompliant),
    outstandingPatches: int(row.outstanding_patches),
    outstandingBySeverity: {
      critical: int(row.critical), important: int(row.important), moderate: int(row.moderate),
      low: int(row.low), unrated: int(row.unrated),
    },
    oldestOutstandingDays: num(row.oldest_since_days),
  };
}

async function loadSnapshot(orgId: string): Promise<PatchComplianceSnapshotScalars | null> {
  // The org-wide (ring_id IS NULL) snapshot from today or yesterday only — a
  // stale snapshot would contradict the live rollup above.
  const rows = await dbModule.db.execute<Record<string, unknown>>(sql`
    SELECT snapshot_date, total_devices, compliant_devices, non_compliant_devices,
           critical_missing, important_missing, patches_pending_approval,
           patches_installed_24h, failed_installs_24h
    FROM patch_compliance_snapshots
    WHERE org_id = ${orgId}
      AND ring_id IS NULL
      AND snapshot_date >= current_date - 1
    ORDER BY snapshot_date DESC, created_at DESC
    LIMIT 1
  `);
  const row = [...rows][0];
  if (!row) return null;
  return {
    date: dateOnly(row.snapshot_date),
    totalDevices: num(row.total_devices),
    compliantDevices: num(row.compliant_devices),
    nonCompliantDevices: num(row.non_compliant_devices),
    criticalMissing: num(row.critical_missing),
    importantMissing: num(row.important_missing),
    patchesPendingApproval: num(row.patches_pending_approval),
    patchesInstalled24h: num(row.patches_installed_24h),
    failedInstalls24h: num(row.failed_installs_24h),
  };
}

function autoApproveSummary(autoApprove: unknown, ringId: string): string {
  const cfg = parseRingAutoApprove(autoApprove, `patchEvidence ring ${ringId}`);
  if (!cfg.enabled) return 'off';
  const parts = [
    `severities: ${cfg.severities.length > 0 ? cfg.severities.join(',') : 'none'}`,
    `deferral: ${cfg.deferralDays}d`,
    `third-party: ${cfg.thirdPartyApps ? `on${cfg.thirdPartyDeferralDays !== null ? ` (${cfg.thirdPartyDeferralDays}d)` : ''}` : 'off'}`,
    `unrated: ${cfg.autoApproveUnrated ? 'on' : 'off'}`,
  ];
  return parts.join('; ');
}

function categoryList(values: string[]): string {
  const shown = values.slice(0, MAX_CATEGORY_NAMES).join(', ');
  return values.length > MAX_CATEGORY_NAMES ? `${shown}, …` : shown;
}

async function loadRingPosture(orgId: string, partnerId: string): Promise<{ rows: PatchEvidenceRow[]; total: number }> {
  const rings = [...await dbModule.db.execute<{
    id: string; name: unknown; ring_order: unknown; deferral_days: unknown;
    categories: unknown; exclude_categories: unknown; auto_approve: unknown; total_count: unknown;
  }>(sql`
    SELECT pp.id, pp.name, pp.ring_order, pp.deferral_days, pp.categories, pp.exclude_categories,
           pp.auto_approve, COUNT(*) OVER () AS total_count
    FROM patch_policies pp
    WHERE pp.partner_id = ${partnerId}
      AND pp.kind = 'ring'
      AND pp.enabled = true
    ORDER BY pp.ring_order ASC, pp.id ASC
    LIMIT ${FETCH_LIMIT}
  `)];
  if (rings.length === 0) return { rows: [], total: 0 };

  // Distinct outstanding org patches per category — the input to the
  // evaluator's own `isCategoryAllowed`, never a re-implementation of it.
  const histogram = [...await dbModule.db.execute<{ category: unknown; n: unknown }>(sql`
    SELECT p.category, COUNT(DISTINCT p.id)::int AS n
    FROM device_patches dp
    JOIN devices d ON d.id = dp.device_id
    JOIN patches p ON p.id = dp.patch_id
    WHERE ${orgPinnedOutstanding(orgId)}
    GROUP BY p.category
  `)];

  // Distinct outstanding org patches with no APPROVED approval row for this
  // ring (or partner-wide blanket). Ring auto-approve may still approve some
  // of them at job time — the summary string sits beside this count.
  const ringValues = sql.join(rings.map((r) => sql`(${r.id}::uuid)`), sql`, `);
  const withoutApproval = [...await dbModule.db.execute<{ ring_id: string; n: unknown }>(sql`
    SELECT r.ring_id, COUNT(DISTINCT o.patch_id)::int AS n
    FROM (VALUES ${ringValues}) AS r(ring_id)
    CROSS JOIN (
      SELECT DISTINCT dp.patch_id
      FROM device_patches dp
      JOIN devices d ON d.id = dp.device_id
      WHERE ${orgPinnedOutstanding(orgId)}
    ) o
    WHERE NOT EXISTS (
      SELECT 1 FROM patch_approvals pa
      WHERE pa.partner_id = ${partnerId}
        AND pa.patch_id = o.patch_id
        AND pa.status = 'approved'
        AND (pa.ring_id = r.ring_id OR pa.ring_id IS NULL)
    )
    GROUP BY r.ring_id
  `)];
  const withoutByRing = new Map(withoutApproval.map((row) => [row.ring_id, int(row.n)]));

  const rows = rings.map((ring): PatchEvidenceRow => {
    const categories = strArray(ring.categories);
    const exclude = strArray(ring.exclude_categories);
    const blockedByCategory = histogram.reduce(
      (sum, h) => (isCategoryAllowed(str(h.category), categories, exclude) ? sum : sum + int(h.n)),
      0,
    );
    return {
      deviceId: null,
      hostname: null,
      fields: {
        ringId: ring.id,
        name: str(ring.name),
        ringOrder: num(ring.ring_order),
        deferralDays: num(ring.deferral_days),
        categoryCount: categories.length,
        categories: categoryList(categories),
        excludeCategoryCount: exclude.length,
        excludeCategories: categoryList(exclude),
        autoApprove: autoApproveSummary(ring.auto_approve, ring.id),
        blockedByCategory,
        withoutApprovalRow: withoutByRing.get(ring.id) ?? 0,
        heldByDeferral: null,
        heldByDeferralReason: 'not_resolvable_until_w02',
      },
    };
  });
  return { rows, total: totalFrom(rings) };
}

async function loadTopNonCompliant(orgId: string): Promise<{ rows: PatchEvidenceRow[]; total: number }> {
  const devices = [...await dbModule.db.execute<{
    device_id: string; hostname: unknown; os_type: unknown; os_version: unknown; pending_reboot: unknown;
    last_seen_at: unknown; outstanding_count: unknown; critical_count: unknown; important_count: unknown;
    moderate_count: unknown; low_count: unknown; unrated_count: unknown; total_count: unknown;
  }>(sql`
    SELECT d.id AS device_id, d.hostname, d.os_type, d.os_version, d.pending_reboot, d.last_seen_at,
           COUNT(*)::int AS outstanding_count,
           COUNT(*) FILTER (WHERE p.severity = 'critical')::int AS critical_count,
           COUNT(*) FILTER (WHERE p.severity = 'important')::int AS important_count,
           COUNT(*) FILTER (WHERE p.severity = 'moderate')::int AS moderate_count,
           COUNT(*) FILTER (WHERE p.severity = 'low')::int AS low_count,
           COUNT(*) FILTER (WHERE p.severity IS NULL OR p.severity = 'unknown')::int AS unrated_count,
           COUNT(*) OVER () AS total_count
    FROM device_patches dp
    JOIN devices d ON d.id = dp.device_id
    JOIN patches p ON p.id = dp.patch_id
    WHERE ${orgPinnedOutstanding(orgId)}
    GROUP BY d.id, d.hostname, d.os_type, d.os_version, d.pending_reboot, d.last_seen_at
    ORDER BY (COUNT(*) FILTER (WHERE p.severity = 'critical')) DESC,
             (COUNT(*) FILTER (WHERE p.severity = 'important')) DESC,
             COUNT(*) DESC, d.id ASC
    LIMIT ${FETCH_LIMIT}
  `)];
  if (devices.length === 0) return { rows: [], total: 0 };

  const shown = devices.slice(0, PATCH_EVIDENCE_MAX_ROWS_PER_SECTION);
  const idList = sql.join(shown.map((d) => sql`${d.device_id}`), sql`, `);
  const patchRows = [...await dbModule.db.execute<{
    device_id: string; patch_id: string; title: unknown; vendor: unknown; severity: unknown;
    requires_reboot: unknown; age_days: unknown;
  }>(sql`
    SELECT x.device_id, x.patch_id, x.title, x.vendor, x.severity, x.requires_reboot, x.age_days
    FROM (
      SELECT dp.device_id, p.id AS patch_id, p.title, p.vendor, p.severity, p.requires_reboot,
             FLOOR(EXTRACT(EPOCH FROM (now() - ${OUTSTANDING_SINCE})) / 86400)::int AS age_days,
             row_number() OVER (
               PARTITION BY dp.device_id ORDER BY ${SEVERITY_RANK}, ${OUTSTANDING_SINCE} ASC, p.id ASC
             ) AS rn
      FROM device_patches dp
      JOIN devices d ON d.id = dp.device_id
      JOIN patches p ON p.id = dp.patch_id
      WHERE ${orgPinnedOutstanding(orgId)}
        AND dp.device_id IN (${idList})
    ) x
    WHERE x.rn <= ${PATCH_EVIDENCE_MAX_PATCHES_PER_DEVICE}
    ORDER BY x.device_id, x.rn
  `)];
  const byDevice = new Map<string, PatchEvidencePatch[]>();
  for (const p of patchRows) {
    const list = byDevice.get(p.device_id) ?? [];
    list.push({
      patchId: p.patch_id,
      title: str(p.title) ?? '',
      vendor: str(p.vendor),
      severity: str(p.severity),
      ageDays: num(p.age_days),
      requiresReboot: bool(p.requires_reboot),
    });
    byDevice.set(p.device_id, list);
  }

  return {
    rows: devices.map((d) => ({
      deviceId: d.device_id,
      hostname: str(d.hostname),
      fields: {
        osType: str(d.os_type),
        osVersion: str(d.os_version),
        outstanding: int(d.outstanding_count),
        critical: int(d.critical_count),
        important: int(d.important_count),
        moderate: int(d.moderate_count),
        low: int(d.low_count),
        unrated: int(d.unrated_count),
        pendingReboot: bool(d.pending_reboot),
        lastSeenAt: iso(d.last_seen_at),
      },
      patches: byDevice.get(d.device_id) ?? [],
    })),
    total: totalFrom(devices),
  };
}

async function loadRebootBacklog(orgId: string): Promise<{ rows: PatchEvidenceRow[]; total: number }> {
  const rows = [...await dbModule.db.execute<{
    device_id: string; hostname: unknown; os_type: unknown; last_seen_at: unknown; total_count: unknown;
  }>(sql`
    SELECT d.id AS device_id, d.hostname, d.os_type, d.last_seen_at, COUNT(*) OVER () AS total_count
    FROM devices d
    WHERE d.org_id = ${orgId}
      AND d.is_ephemeral = false
      AND d.status <> 'decommissioned'
      AND d.pending_reboot = true
    ORDER BY d.last_seen_at DESC NULLS LAST, d.id ASC
    LIMIT ${FETCH_LIMIT}
  `)];
  return {
    rows: rows.map((d) => ({
      deviceId: d.device_id,
      hostname: str(d.hostname),
      fields: { osType: str(d.os_type), lastSeenAt: iso(d.last_seen_at) },
    })),
    total: totalFrom(rows),
  };
}

/**
 * Stamps `maintenanceWindowResolves` / `inMaintenanceNow` onto the rows that
 * will actually be shown (capped first — never one lookup per uncapped row).
 * Calls `resolveMaintenanceConfigForDevice` in the CALLER'S system context —
 * never `maintenanceService.isDeviceInMaintenance`, whose own
 * `runOutsideDbContext(withSystemDbAccessContext(…))` would hold a second
 * pooled connection per device under the run loop's open transaction. The
 * legacy standalone `maintenance_windows` table is not consulted (the patch
 * path runs on config-policy maintenance).
 *
 * One lookup per distinct device, sequentially (one connection). A failed
 * lookup aborts the shared transaction, so every row after it reports
 * `null` ("not measured") rather than a guessed `false`.
 */
async function stampMaintenance(orgId: string, sections: PatchEvidenceRow[][]): Promise<void> {
  const verdicts = new Map<string, { resolves: boolean | null; now: boolean | null }>();
  let failed = false;
  for (const rows of sections) {
    for (const row of rows.slice(0, PATCH_EVIDENCE_MAX_ROWS_PER_SECTION)) {
      if (!row.deviceId) continue;
      let verdict = verdicts.get(row.deviceId);
      if (!verdict) {
        if (failed) {
          verdict = { resolves: null, now: null };
        } else {
          try {
            const settings = await resolveMaintenanceConfigForDevice(row.deviceId);
            verdict = settings
              ? { resolves: true, now: isInMaintenanceWindow(settings).active === true }
              : { resolves: false, now: false };
          } catch (error) {
            failed = true;
            reportLoaderFailure(orgId, 'maintenance', error);
            verdict = { resolves: null, now: null };
          }
        }
        verdicts.set(row.deviceId, verdict);
      }
      row.fields.maintenanceWindowResolves = verdict.resolves;
      row.fields.inMaintenanceNow = verdict.now;
    }
  }
}

function reportLoaderFailure(orgId: string, loader: string, error: unknown): void {
  console.warn('[patchEvidence] loader failed; section reported as unavailable', { orgId, loader, error });
  captureException(error, undefined, { service: 'aiAgents', operation: 'loadPatchEvidence', loader, orgId });
}

async function settled<T>(orgId: string, loader: string, load: () => Promise<T>): Promise<T | null> {
  const [result] = await Promise.allSettled([load()]);
  if (result?.status === 'fulfilled') return result.value;
  reportLoaderFailure(orgId, loader, result?.reason);
  return null;
}

/**
 * Load the bounded patch evidence for one org. The caller already holds a
 * SYSTEM DB context (see the header on tenancy) and passes the org's partner
 * id from the org row it already read.
 *
 * Statements run sequentially (one pooled connection inside one transaction —
 * concurrent issuance would only queue). The rollup runs FIRST and is the one
 * read allowed to fail the run.
 */
export async function loadPatchEvidence(orgId: string, partnerId: string | null): Promise<PatchEvidence> {
  let rollup: Omit<PatchEvidenceRollup, 'snapshot'>;
  try {
    rollup = await loadRollup(orgId);
  } catch (error) {
    reportLoaderFailure(orgId, 'rollup', error);
    throw error instanceof PatchEvidenceUnavailableError ? error : new PatchEvidenceUnavailableError();
  }
  const snapshot = await settled(orgId, 'snapshot', () => loadSnapshot(orgId));

  const rings: RawSection = partnerId === null
    ? { unavailable: 'no_partner' }
    : (await settled(orgId, 'ringPosture', () => loadRingPosture(orgId, partnerId))) ?? { unavailable: 'loader_failed' };
  const top = await settled(orgId, 'topNonCompliant', () => loadTopNonCompliant(orgId));
  const reboot = await settled(orgId, 'rebootBacklog', () => loadRebootBacklog(orgId));

  await stampMaintenance(orgId, [top?.rows ?? [], reboot?.rows ?? []]);

  return assemblePatchEvidence({
    rollup: { ...rollup, snapshot },
    sections: {
      ringPosture: rings,
      topNonCompliant: top ?? { unavailable: 'loader_failed' },
      rebootBacklog: reboot ?? { unavailable: 'loader_failed' },
    },
  });
}
