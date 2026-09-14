/**
 * Bounded fleet evidence bundle for a `designer`-profile agent run (Fleet
 * Designer W01, Task 6).
 *
 * ## Why the evidence is SYSTEM-ASSEMBLED
 *
 * A fleet design run's model never wanders the tenant's data with its own
 * tool calls to build its picture of the fleet: every number, name, and
 * device row it may reason about is assembled here, by hand-written,
 * org-pinned statements, and handed to it in one bounded object. Same
 * posture as `narrativeContext.ts`/`sweepEvidence.ts`, applied to a
 * quarterly design rather than a weekly narrative or a scheduled sweep — the
 * bundle is bigger (it carries device rows, not just counts) but the three
 * governing properties are identical.
 *
 * ## The four properties this module holds
 *
 *  - **Display fields and operator-authored names only, never a raw jsonb
 *    blob.** No alert message, ticket body, script content beyond name/tags/
 *    purpose/first-200-chars-of-description, backup error log, or raw jsonb
 *    column ever reaches the bundle. `customFields` — an open jsonb
 *    container — is flattened to a `k=v, k=v` string (≤ 8 entries, values
 *    ≤ 40 chars) rather than passed through as an object. Every
 *    operator-authored string is sanitized with `sanitizeSweepText`.
 *
 *  - **Bounded twice.** `DESIGN_EVIDENCE_MAX_DEVICES` caps devices
 *    independently of the byte ceiling (devices are NEVER byte-trimmed —
 *    that cap is the only device limit); `DESIGN_EVIDENCE_BOUNDS` caps every
 *    other variable-length list; `DESIGN_EVIDENCE_HARD_LIMIT_BYTES` is then
 *    enforced over the ENTIRE UTF-8-serialized bundle, trimming whole
 *    entries off the lists least load-bearing to the design (software,
 *    then services, then network assets, then network topology, then logs,
 *    then posture, then automation scripts, then configuration policies)
 *    until the bundle fits.
 *
 *  - **Honest availability.** A loader that fails costs exactly its own
 *    section: `unavailable` names it and the section renders empty/null —
 *    never an invented zero. Isolated per loader by the `settled()` idiom
 *    (copied from `narrativeContext.ts`, module-private there).
 *
 *  - **Truncation is observable, and reported once.** `truncated` is `true`
 *    whenever anything was dropped by the byte trim (device overflow is
 *    reported separately via `devicesNotAssessed`, since it is bounded by
 *    count, not by bytes).
 *
 * ## Tenancy
 *
 * `loadDesignEvidence` is called from the design run's context loader, which
 * already holds a SYSTEM DB context (full RLS bypass) — no context
 * management here, matching `loadNarrativeContext`/`loadSweepEvidence`. That
 * makes the `org_id = $orgId` predicate in every statement below the ONLY
 * thing keeping one tenant's design evidence out of another tenant's rows.
 * Every statement pins the org on its PRIMARY table AND on every
 * tenant-bearing table it joins; a table with no `org_id` of its own
 * with no tenant column of its own (`patches`) is reached exclusively through
 * an org-pinned join partner; `script_tags` does carry the org/partner axis
 * and is predicated on it directly in `loadAutomation`.
 *
 * Partner-wide config rows (`configuration_policies`, `alert_templates`,
 * `scripts`, `script_tags`) admit `org_id IS NULL AND partner_id =
 * $partnerId` — `$partnerId` resolved ONCE from this org's own row in
 * `loadHeader`, never from caller input (same rule as
 * `narrativeContext.ts`'s alert-rule/ticket-category joins).
 *
 * `assembleDesignEvidence` is the pure core (fixture-testable, no DB) that
 * `loadDesignEvidence` wraps with the actual reads.
 */
import { and, eq, sql, type SQL } from 'drizzle-orm';

import { FLEET_DESIGN_PRECURSOR_THRESHOLDS, type FleetDesignBaselineNumbers, type FleetDesignPrecursorCondition } from '@breeze/shared';

import { devices } from '../../db/schema/devices';
import { MANAGEMENT_POSTURE_CATEGORIES } from '../../routes/agents/schemas';
import { fetchFleetFindingRows } from '../vulnerabilityFleetQueries';
import { computeStats } from '../vulnerabilityFleetAggregation';
import { getManagementPostureSummary } from '../managementPostureReport';
import { listReliabilityDevices } from '../reliabilityScoring';
import { getSecurityPostureTrend } from '../securityPosture';
import { captureException } from '../sentry';
import { loadApprovedDesign, loadDriftLiveState, uuidArray, type ApprovedDesignSummary, type DriftLiveState } from '../fleetDesign/drift';
import { sanitizeSweepText } from './runnerPrompt';

// Late-bound namespace import (NOT `const { db } = dbModule`): destructuring
// at module scope freezes the binding at import time, before a test's
// `vi.mock('../../db')` factory can be observed. Same idiom as
// `narrativeContext.ts` / `sweepEvidence.ts`.
import * as dbModule from '../../db';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Aim: the serialized bundle should fit under this many UTF-8 bytes — see
 *  this module's header on the trim order that gets there. */
export const DESIGN_EVIDENCE_HARD_LIMIT_BYTES = 192 * 1024;

/** The ONLY device cap — devices are never trimmed by the byte ceiling. */
export const DESIGN_EVIDENCE_MAX_DEVICES = 2000;

/** Per-section caps applied before the byte trim ever runs. */
export const DESIGN_EVIDENCE_BOUNDS = Object.freeze({
  software: 500,
  services: 2000,
  networkAssets: 2000,
  topology: 2000,
  openChanges: 200,
  reliabilityWorst: 50,
  fleetFindings: 200,
  policies: 100,
  alertTemplates: 200,
  playbooks: 200,
  scripts: 1000,
  logs: 500,
});

/** Defensive clamp on every operator-authored string that reaches the
 *  bundle. `sanitizeSweepText` appends an ellipsis when it truncates. */
const MAX_TEXT_CHARS = 256;

/** Fixed order the precursor block always renders in — mirrors
 *  `FleetDesignPrecursorCondition`. */
const PRECURSOR_CONDITION_ORDER: readonly FleetDesignPrecursorCondition[] = [
  'disk_used_over_threshold',
  'reboot_pending_over_threshold',
  'patch_age_over_threshold',
  'certificate_expiring',
  'backup_missed',
  'service_restarted_over_threshold',
];

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export interface DesignEvidenceDevice {
  id: string;
  hostname: string;
  osType: string;
  osVersion: string | null;
  role: string;
  roleSource: string;
  lastSeenAt: string | null;
  status: string;
  siteName: string | null;
  groupNames: string[];
  tags: string[];
  customFields: string;
  pendingReboot: boolean;
  reliabilityScore: number | null;
}

export interface DesignEvidence {
  org: { name: string; partnerName: string; timezone: string; siteName: string | null };
  window: { start: string; end: string };
  devices: DesignEvidenceDevice[];
  deviceIds: ReadonlySet<string>;
  devicesTotal: number;
  devicesNotAssessed: number;
  software: { name: string; vendor: string | null; versions: number; deviceCount: number }[];
  services: { deviceId: string; watchType: string; name: string; status: string; restarts30d: number }[];
  network: {
    assets: { ip: string; type: string; hostname: string | null; openPorts: number[]; linkedDeviceId: string | null }[];
    topology: { source: string; target: string; connectionType: string | null }[];
    baselines: number;
    openChanges: { eventType: string; detectedAt: string }[];
  };
  posture: { category: string; product: string; managedCount: number; staleCount: number }[];
  health: {
    reliabilityWorst: { deviceId: string; score: number; trend: string | null }[];
    fleetFindings: { kind: string; title: string; deviceCount: number }[];
    vulnerability: { critical: number; high: number; devicesAffected: number } | null;
    patching: { patchScore: number | null; devicesPending: number; pendingPatches: number } | null;
    backups: { ok: number; failed: number; missed: number; devicesFailed: number } | null;
    cis: { devicesAssessed: number; avgScore: number | null } | null;
  };
  configuration: {
    policies: {
      id: string; name: string; status: string; ownerScope: 'organization' | 'partner';
      watches: { name: string; watchType: string; enabled: boolean }[];
      rules: { name: string; severity: string; cooldownMinutes: number }[];
    }[];
    assignments: { policyId: string; level: string; targetId: string; priority: number; roleFilter: string[] | null }[];
    alertTemplates: { id: string; name: string; category: string | null; severity: string; isBuiltIn: boolean }[];
  };
  automation: {
    playbooks: { id: string; name: string; isBuiltIn: boolean; category: string | null }[];
    scripts: { id: string; name: string; language: string; osTypes: string[]; tags: string[]; legacyImport: boolean; description: string }[];
  };
  logs: { eventId: string; source: string; level: string; count: number; deviceCount: number }[];
  counts: { alerts90d: number; tickets90d: number; endpoints: number };
  precursors: {
    diskOver: number; rebootPending: number; rebootPendingOver: number; patchAgeOver: number;
    certificateExpiring: number | null; backupMissed: number; serviceRestartsOver: number;
  };
  thresholds: typeof FLEET_DESIGN_PRECURSOR_THRESHOLDS;
  unavailable: string[];
  truncated: boolean;
  /**
   * W05 (#5655): the org's newest APPLIED design (null when none), and the
   * live state `computeDrift` compares it against. Loaded together, never
   * byte-trimmed (deterministic, bounded by the ledger), and rendered to the
   * model only as the approved design's watches/rules — the drift itself is
   * computed by the finaliser, not the model.
   */
  approvedDesign: ApprovedDesignSummary | null;
  driftLive: DriftLiveState | null;
}

// NOTE: `'devices'` is ALSO in the base `Omit` (not just the four
// byte/count-derived fields) — without it, intersecting a type that still
// carries `devices: DesignEvidenceDevice[]` with `{ devices: (...)[] }`
// merges the two array ELEMENT types instead of overriding, which collapses
// `customFields` back down to `string & Record<string, unknown>` (effectively
// unusable — `string & null` in the union vanishes to `never`).
export type RawDesignEvidence = Omit<DesignEvidence, 'deviceIds' | 'devicesNotAssessed' | 'thresholds' | 'truncated' | 'devices'> & {
  devices: (Omit<DesignEvidenceDevice, 'customFields'> & { displayName: string | null; customFields: Record<string, unknown> | null })[];
};

// ---------------------------------------------------------------------------
// Small value helpers — same idiom as narrativeContext.ts / sweepEvidence.ts.
// ---------------------------------------------------------------------------

function sanitize(value: string): string {
  return sanitizeSweepText(value, MAX_TEXT_CHARS);
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function count(value: unknown): number {
  return numberOrNull(value) ?? 0;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isoOrNull(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function flattenCustomFields(cf: Record<string, unknown> | null | undefined): string {
  return Object.entries(cf ?? {})
    .slice(0, 8)
    .map(([k, v]) => `${sanitize(k)}=${sanitize(String(v)).slice(0, 40)}`)
    .join(', ');
}

// ---------------------------------------------------------------------------
// Pure assembly
// ---------------------------------------------------------------------------

/**
 * Pure assembly from already-loaded rows. Exported so unit tests can drive
 * every cap/trim/availability branch deterministically without a DB.
 *
 * `limitBytes` exists ONLY as a testing seam for the trim order — see this
 * module's header.
 */
export function assembleDesignEvidence(raw: RawDesignEvidence, opts: { limitBytes?: number } = {}): DesignEvidence {
  const devices: DesignEvidenceDevice[] = raw.devices.slice(0, DESIGN_EVIDENCE_MAX_DEVICES).map((d) => ({
    id: d.id,
    hostname: sanitize(d.hostname),
    osType: d.osType,
    osVersion: d.osVersion,
    role: d.role,
    roleSource: d.roleSource,
    lastSeenAt: d.lastSeenAt,
    status: d.status,
    siteName: d.siteName === null ? null : sanitize(d.siteName),
    groupNames: d.groupNames.map(sanitize),
    tags: d.tags.map(sanitize),
    customFields: flattenCustomFields(d.customFields),
    pendingReboot: d.pendingReboot,
    reliabilityScore: d.reliabilityScore,
  }));
  const devicesNotAssessed = raw.devicesTotal - devices.length;
  const deviceIds = new Set(devices.map((d) => d.id));

  const evidence: DesignEvidence = {
    org: {
      name: sanitize(raw.org.name),
      partnerName: sanitize(raw.org.partnerName),
      timezone: raw.org.timezone,
      siteName: raw.org.siteName === null ? null : sanitize(raw.org.siteName),
    },
    window: raw.window,
    devices,
    deviceIds,
    devicesTotal: raw.devicesTotal,
    devicesNotAssessed,
    software: raw.software.slice(0, DESIGN_EVIDENCE_BOUNDS.software).map((s) => ({
      name: sanitize(s.name), vendor: s.vendor === null ? null : sanitize(s.vendor), versions: s.versions, deviceCount: s.deviceCount,
    })),
    services: raw.services.slice(0, DESIGN_EVIDENCE_BOUNDS.services).map((s) => ({
      deviceId: s.deviceId, watchType: s.watchType, name: sanitize(s.name), status: s.status, restarts30d: s.restarts30d,
    })),
    network: {
      assets: raw.network.assets.slice(0, DESIGN_EVIDENCE_BOUNDS.networkAssets).map((a) => ({
        ip: a.ip, type: a.type, hostname: a.hostname === null ? null : sanitize(a.hostname), openPorts: a.openPorts, linkedDeviceId: a.linkedDeviceId,
      })),
      topology: raw.network.topology.slice(0, DESIGN_EVIDENCE_BOUNDS.topology),
      baselines: raw.network.baselines,
      openChanges: raw.network.openChanges.slice(0, DESIGN_EVIDENCE_BOUNDS.openChanges),
    },
    posture: raw.posture,
    health: {
      reliabilityWorst: raw.health.reliabilityWorst.slice(0, DESIGN_EVIDENCE_BOUNDS.reliabilityWorst),
      fleetFindings: raw.health.fleetFindings.slice(0, DESIGN_EVIDENCE_BOUNDS.fleetFindings).map((f) => ({ ...f, title: sanitize(f.title) })),
      vulnerability: raw.health.vulnerability,
      patching: raw.health.patching,
      backups: raw.health.backups,
      cis: raw.health.cis,
    },
    configuration: {
      policies: raw.configuration.policies.slice(0, DESIGN_EVIDENCE_BOUNDS.policies).map((p) => ({
        ...p, name: sanitize(p.name),
        watches: p.watches.map((w) => ({ ...w, name: sanitize(w.name) })),
        rules: p.rules.map((r) => ({ ...r, name: sanitize(r.name) })),
      })),
      assignments: raw.configuration.assignments,
      alertTemplates: raw.configuration.alertTemplates.slice(0, DESIGN_EVIDENCE_BOUNDS.alertTemplates).map((t) => ({ ...t, name: sanitize(t.name) })),
    },
    automation: {
      playbooks: raw.automation.playbooks.slice(0, DESIGN_EVIDENCE_BOUNDS.playbooks).map((p) => ({ ...p, name: sanitize(p.name) })),
      // Legacy-import first (stable), so both the count cap here and the
      // byte trim below — which drops from the END of the list — spend
      // ordinary library rows before any of the inventory (W04 #5654).
      scripts: [...raw.automation.scripts]
        .sort((a, b) => Number(b.legacyImport) - Number(a.legacyImport))
        .slice(0, DESIGN_EVIDENCE_BOUNDS.scripts).map((s) => ({
        ...s, name: sanitize(s.name), tags: s.tags.map(sanitize), description: sanitize(s.description).slice(0, 200),
      })),
    },
    logs: raw.logs.slice(0, DESIGN_EVIDENCE_BOUNDS.logs).map((l) => ({ ...l, source: sanitize(l.source) })),
    counts: raw.counts,
    precursors: raw.precursors,
    thresholds: FLEET_DESIGN_PRECURSOR_THRESHOLDS,
    unavailable: raw.unavailable,
    truncated: false,
    // Never trimmed: the drift comparison must see the whole approved design
    // or it would report trimmed-away items as "missing".
    approvedDesign: raw.approvedDesign,
    driftLive: raw.driftLive,
  };

  // Byte ceiling, measured over the WHOLE serialized bundle. Each pass drops
  // exactly one whole entry — never a partial entry — from the largest of
  // the CURRENT trim-order victim lists, so the model can trust every entry
  // it can still see. Devices are never touched here (see header).
  const limit = opts.limitBytes ?? DESIGN_EVIDENCE_HARD_LIMIT_BYTES;
  const victims: Array<{ list: () => unknown[]; drop: () => void }> = [
    { list: () => evidence.software, drop: () => { evidence.software = evidence.software.slice(0, -1); } },
    { list: () => evidence.services, drop: () => { evidence.services = evidence.services.slice(0, -1); } },
    { list: () => evidence.network.assets, drop: () => { evidence.network.assets = evidence.network.assets.slice(0, -1); } },
    { list: () => evidence.network.topology, drop: () => { evidence.network.topology = evidence.network.topology.slice(0, -1); } },
    { list: () => evidence.logs, drop: () => { evidence.logs = evidence.logs.slice(0, -1); } },
    { list: () => evidence.posture, drop: () => { evidence.posture = evidence.posture.slice(0, -1); } },
    { list: () => evidence.automation.scripts, drop: () => { evidence.automation.scripts = evidence.automation.scripts.slice(0, -1); } },
    { list: () => evidence.configuration.policies, drop: () => { evidence.configuration.policies = evidence.configuration.policies.slice(0, -1); } },
  ];
  while (Buffer.byteLength(JSON.stringify(evidence), 'utf8') > limit) {
    let target: (typeof victims)[number] | null = null;
    for (const victim of victims) {
      if (victim.list().length === 0) continue;
      if (target === null || victim.list().length > target.list().length) target = victim;
    }
    if (target === null) {
      // Nothing left to drop in the trim order: the residual bytes are the
      // device rows or the fixed envelope. Bail rather than spin.
      evidence.truncated = true;
      break;
    }
    target.drop();
    evidence.truncated = true;
  }

  return evidence;
}

/**
 * `baseline.notes` is the model's own text; `baseline.numbers` is entirely
 * server-computed from evidence already assembled above — never something
 * the model can influence.
 */
export function designBaselineNumbers(e: DesignEvidence): FleetDesignBaselineNumbers {
  // A loader that failed lands in `unavailable` and its section carries the
  // neutral shape (zeros) so the bundle stays serializable — those zeros are
  // NOT measurements. The persisted baseline reports them as null ("not
  // measured"), never as a reassuring 0.
  const countsMeasured = !e.unavailable.includes('counts');
  const precursorsMeasured = !e.unavailable.includes('precursors');
  const alertsPer100EndpointsPerMonth = countsMeasured && e.counts.endpoints > 0
    ? Math.round((e.counts.alerts90d / 3) / e.counts.endpoints * 100)
    : null;
  const ticketsPerMonth = countsMeasured ? Math.round(e.counts.tickets90d / 3) : null;
  const precursorValue = (condition: FleetDesignPrecursorCondition): number | null => {
    if (!precursorsMeasured) return null;
    switch (condition) {
      case 'disk_used_over_threshold': return e.precursors.diskOver;
      case 'reboot_pending_over_threshold': return e.precursors.rebootPendingOver;
      case 'patch_age_over_threshold': return e.precursors.patchAgeOver;
      case 'certificate_expiring': return e.precursors.certificateExpiring;
      case 'backup_missed': return e.precursors.backupMissed;
      case 'service_restarted_over_threshold': return e.precursors.serviceRestartsOver;
    }
  };
  return {
    alertsPer100EndpointsPerMonth,
    ticketsPerMonth,
    precursors: PRECURSOR_CONDITION_ORDER.map((condition) => ({ condition, deviceCount: precursorValue(condition) })),
  };
}

// ---------------------------------------------------------------------------
// Loader failure reporting — same shape as narrativeContext.ts.
// ---------------------------------------------------------------------------

function reportLoaderFailure(orgId: string, loader: string, error: unknown): void {
  console.warn('[designEvidence] context loader failed; section reported as unavailable', { orgId, loader, error });
  captureException(error, undefined, { service: 'aiAgents', operation: 'loadDesignEvidence', loader, orgId });
}

/**
 * `Promise.allSettled` over ONE loader: its value on fulfil, `null` on
 * reject. Copied from `narrativeContext.ts` (module-private there) — see
 * this module's header on why a rejected loader costs exactly its own
 * section rather than the whole run.
 */
async function settled<T>(orgId: string, loader: string, load: () => Promise<T>): Promise<T | null> {
  const [result] = await Promise.allSettled([load()]);
  if (result?.status === 'fulfilled') return result.value;
  reportLoaderFailure(orgId, loader, result?.reason);
  return null;
}

// ---------------------------------------------------------------------------
// Loaders. Raw SQL (not the Drizzle builder), same rationale as
// narrativeContext.ts/sweepEvidence.ts: several loaders need FILTER/DISTINCT
// ON forms the builder cannot express cleanly, and a hand-written statement
// is the only form whose tenancy predicate a unit test can actually READ
// back. Every statement pins `org_id` on its primary table AND on every
// tenant-bearing table it joins.
// ---------------------------------------------------------------------------

async function query<T extends Record<string, unknown>>(statement: SQL): Promise<T[]> {
  const rows = await dbModule.db.execute<T>(statement);
  // See narrativeContext.ts's `query` helper for why the spread is needed:
  // drizzle's postgres-js RowList is not a plain array.
  return [...rows] as T[];
}

const DEVICE_FETCH_LIMIT = DESIGN_EVIDENCE_MAX_DEVICES + 1;

type HeaderRow = {
  org_name: string | null; partner_id: string | null; partner_name: string | null;
  timezone: string | null; site_name: string | null;
};

/**
 * Org header + partner identity every partner-wide config/script join below
 * needs. Runs FIRST and alone — every downstream partner-axis predicate
 * resolves `partnerId` from THIS org's own row, never from caller input.
 * `organizations` is id-keyed (RLS shape 2): the pin is `o.id`.
 */
async function loadHeader(orgId: string, siteId: string | null | undefined): Promise<{
  name: string; partnerName: string; timezone: string; siteName: string | null; partnerId: string | null;
}> {
  const rows = await query<HeaderRow>(sql`
    SELECT o.name AS org_name,
           o.partner_id AS partner_id,
           p.name AS partner_name,
           p.timezone AS timezone,
           (SELECT s.name FROM sites s WHERE s.id = ${siteId ?? null} AND s.org_id = ${orgId}) AS site_name
    FROM organizations o
    JOIN partners p ON p.id = o.partner_id
    WHERE o.id = ${orgId}
  `);
  const row = rows[0];
  if (!row) throw new Error('design evidence: organization not found');
  return {
    name: row.org_name ?? '',
    partnerName: row.partner_name ?? '',
    timezone: row.timezone ?? 'UTC',
    siteName: row.site_name,
    partnerId: row.partner_id,
  };
}

type DeviceRow = {
  id: string; hostname: string; display_name: string | null; os_type: string; os_version: string | null;
  device_role: string; device_role_source: string; last_seen_at: Date | string | null; status: string;
  site_name: string | null; group_names: string[] | null; tags: string[] | null;
  custom_fields: Record<string, unknown> | null; pending_reboot: boolean; reliability_score: number | null;
};

/**
 * Devices: primary table `org_id`-pinned; `sites`/`device_group_memberships`/
 * `device_groups`/`device_reliability` are all ALSO org-pinned in their join
 * condition (shape 5's own tables carry `org_id` directly). `siteId`, when
 * given, narrows on `devices.site_id`. Ephemeral (Quick Support) and
 * decommissioned devices are excluded — a fleet design is not written about
 * a one-off support session or a device already retired.
 */
async function loadDevices(orgId: string, siteId: string | null | undefined): Promise<{ devices: RawDesignEvidence['devices']; devicesTotal: number }> {
  const siteFilter = siteId ? sql`AND d.site_id = ${siteId}` : sql``;
  const rows = await query<DeviceRow>(sql`
    SELECT d.id, d.hostname, d.display_name, d.os_type::text AS os_type, d.os_version,
           d.device_role, d.device_role_source, d.last_seen_at, d.status::text AS status,
           s.name AS site_name,
           (
             SELECT array_agg(g.name ORDER BY g.name)
             FROM device_group_memberships m
             JOIN device_groups g ON g.id = m.group_id AND g.org_id = ${orgId}
             WHERE m.device_id = d.id AND m.org_id = ${orgId}
           ) AS group_names,
           d.tags, d.custom_fields,
           d.pending_reboot, r.reliability_score
    FROM devices d
    LEFT JOIN sites s ON s.id = d.site_id AND s.org_id = ${orgId}
    LEFT JOIN device_reliability r ON r.device_id = d.id AND r.org_id = ${orgId}
    WHERE d.org_id = ${orgId} AND d.is_ephemeral = false AND d.status <> 'decommissioned'
      ${siteFilter}
    ORDER BY d.last_seen_at DESC NULLS LAST
    LIMIT ${DEVICE_FETCH_LIMIT}
  `);
  const [totalRow] = await query<{ total: number | string | null }>(sql`
    SELECT COUNT(*)::int AS total
    FROM devices d
    WHERE d.org_id = ${orgId} AND d.is_ephemeral = false AND d.status <> 'decommissioned'
      ${siteFilter}
  `);
  return {
    devices: rows.slice(0, DESIGN_EVIDENCE_MAX_DEVICES).map((row) => ({
      id: row.id,
      hostname: row.hostname,
      displayName: row.display_name,
      osType: row.os_type,
      osVersion: row.os_version,
      role: row.device_role,
      roleSource: row.device_role_source,
      lastSeenAt: isoOrNull(row.last_seen_at),
      status: row.status,
      siteName: row.site_name,
      groupNames: row.group_names ?? [],
      tags: row.tags ?? [],
      customFields: row.custom_fields,
      pendingReboot: row.pending_reboot,
      reliabilityScore: row.reliability_score,
    })),
    devicesTotal: count(totalRow?.total),
  };
}

type SoftwareRow = { name: string | null; vendor: string | null; versions: number | string | null; device_count: number | string | null };

/**
 * Software: aggregated from `software_inventory` INNER JOIN `devices`, both
 * pinned on `org_id` (adapted from `routes/softwareInventory.ts:290-317`'s
 * shape rather than reused directly — that route also merges live policy
 * status, which is out of scope for design evidence).
 */
async function loadSoftware(orgId: string, siteId: string | null | undefined): Promise<RawDesignEvidence['software']> {
  const siteFilter = siteId ? sql`AND d.site_id = ${siteId}` : sql``;
  const rows = await query<SoftwareRow>(sql`
    SELECT MIN(si.name) AS name, MIN(si.vendor) AS vendor,
           COUNT(DISTINCT si.version)::int AS versions,
           COUNT(DISTINCT si.device_id)::int AS device_count
    FROM software_inventory si
    JOIN devices d ON d.id = si.device_id AND d.org_id = ${orgId}
    WHERE si.org_id = ${orgId} ${siteFilter}
    GROUP BY LOWER(si.name), LOWER(COALESCE(si.vendor, ''))
    ORDER BY COUNT(DISTINCT si.device_id) DESC
    LIMIT ${DESIGN_EVIDENCE_BOUNDS.software}
  `);
  return rows.map((r) => ({ name: r.name ?? '', vendor: r.vendor, versions: count(r.versions), deviceCount: count(r.device_count) }));
}

type ServiceRow = { device_id: string; watch_type: string; name: string; status: string; restarts_30d: number | string | null };

/**
 * Services: latest `service_process_check_results` per (device, watch_type,
 * name), all statuses (unlike `sweepEvidence.ts`'s stopped-only filter — the
 * designer needs to know what IS being watched, not just what is broken),
 * `org_id`-pinned on both the primary table (shape 5 denormalizes `org_id`
 * onto this table) and the `devices` join. `restarts30d` is a second,
 * separately org-pinned aggregate over the same table.
 */
async function loadServices(orgId: string, siteId: string | null | undefined): Promise<RawDesignEvidence['services']> {
  const siteFilter = siteId ? sql`AND d.site_id = ${siteId}` : sql``;
  const latest = await query<{ device_id: string; watch_type: string; name: string; status: string }>(sql`
    SELECT DISTINCT ON (r.device_id, r.watch_type, r.name)
           r.device_id, r.watch_type::text AS watch_type, r.name, r.status::text AS status
    FROM service_process_check_results r
    JOIN devices d ON d.id = r.device_id AND d.org_id = ${orgId}
    WHERE r.org_id = ${orgId} ${siteFilter}
    ORDER BY r.device_id, r.watch_type, r.name, r.timestamp DESC
    LIMIT ${DESIGN_EVIDENCE_BOUNDS.services}
  `);
  const restarts = await query<{ device_id: string; watch_type: string; name: string; restarts_30d: number | string | null }>(sql`
    SELECT r.device_id, r.watch_type::text AS watch_type, r.name,
           COUNT(*) FILTER (WHERE r.auto_restart_attempted)::int AS restarts_30d
    FROM service_process_check_results r
    JOIN devices d ON d.id = r.device_id AND d.org_id = ${orgId}
    WHERE r.org_id = ${orgId} AND r.timestamp > now() - interval '30 days' ${siteFilter}
    GROUP BY r.device_id, r.watch_type, r.name
  `);
  const restartMap = new Map(restarts.map((r) => [`${r.device_id}:${r.watch_type}:${r.name}`, count(r.restarts_30d)]));
  return latest.map((row) => ({
    deviceId: row.device_id, watchType: row.watch_type, name: row.name, status: row.status,
    restarts30d: restartMap.get(`${row.device_id}:${row.watch_type}:${row.name}`) ?? 0,
  }));
}

/**
 * Network: `discovered_assets`/`network_topology`/`network_baselines`/
 * `network_change_events` all carry `org_id` directly (shape 1) — every
 * statement pins it, plus `site_id` when given.
 */
async function loadNetwork(orgId: string, siteId: string | null | undefined): Promise<RawDesignEvidence['network']> {
  const siteFilter = siteId ? sql`AND site_id = ${siteId}` : sql``;
  const assets = await query<{ ip_address: string | null; asset_type: string; hostname: string | null; open_ports: unknown; linked_device_id: string | null }>(sql`
    SELECT ip_address::text AS ip_address, asset_type::text AS asset_type, hostname, open_ports, linked_device_id
    FROM discovered_assets
    WHERE org_id = ${orgId} ${siteFilter}
    LIMIT ${DESIGN_EVIDENCE_BOUNDS.networkAssets}
  `);
  const topology = await query<{ source_id: string; target_id: string; connection_type: string | null }>(sql`
    SELECT source_id::text AS source_id, target_id::text AS target_id, connection_type
    FROM network_topology
    WHERE org_id = ${orgId} ${siteFilter}
    LIMIT ${DESIGN_EVIDENCE_BOUNDS.topology}
  `);
  const [baselineRow] = await query<{ total: number | string | null }>(sql`
    SELECT COUNT(*)::int AS total FROM network_baselines WHERE org_id = ${orgId} ${siteFilter}
  `);
  const openChanges = await query<{ event_type: string; detected_at: Date | string }>(sql`
    SELECT event_type::text AS event_type, detected_at
    FROM network_change_events
    WHERE org_id = ${orgId} AND acknowledged = false ${siteFilter}
    ORDER BY detected_at DESC
    LIMIT ${DESIGN_EVIDENCE_BOUNDS.openChanges}
  `);
  return {
    assets: assets.map((a) => ({
      ip: a.ip_address ?? '', type: a.asset_type, hostname: a.hostname,
      openPorts: Array.isArray(a.open_ports) ? (a.open_ports as unknown[]).map((p) => Number(p)).filter((p) => Number.isFinite(p)) : [],
      linkedDeviceId: a.linked_device_id,
    })),
    topology: topology.map((t) => ({ source: t.source_id, target: t.target_id, connectionType: t.connection_type })),
    baselines: count(baselineRow?.total),
    openChanges: openChanges.map((c) => ({ eventType: c.event_type, detectedAt: isoOrNull(c.detected_at) ?? '' })),
  };
}

/**
 * Posture: one `getManagementPostureSummary` call per
 * `MANAGEMENT_POSTURE_CATEGORIES` entry, scoped with `eq(devices.orgId,
 * orgId)` (+ site narrowing) exactly as that service's `scope` contract
 * requires. Flattens `orgs[0]`'s per-product rows — there is at most one org
 * in the result set, this one.
 */
async function loadPosture(orgId: string, siteId: string | null | undefined): Promise<RawDesignEvidence['posture']> {
  const scope = siteId ? and(eq(devices.orgId, orgId), eq(devices.siteId, siteId)) : eq(devices.orgId, orgId);
  const out: RawDesignEvidence['posture'] = [];
  for (const category of MANAGEMENT_POSTURE_CATEGORIES) {
    // eslint-disable-next-line no-await-in-loop -- sequential under the caller's system context, same as every other loader here.
    const summary = await getManagementPostureSummary({ category, stalenessDays: 14, scope });
    const org = summary.orgs[0];
    if (!org) continue;
    for (const product of org.products) {
      out.push({
        category,
        product: sanitize(product.product),
        managedCount: product.deviceCount,
        staleCount: product.deviceCount - product.freshDeviceCount,
      });
    }
  }
  return out;
}

/**
 * Health: reliability worst-N via `listReliabilityDevices` (org+site scoped,
 * already sorted worst-first by ascending score — see that function's
 * ORDER BY); open `fleet_findings` grouped by kind (org-pinned direct
 * query); vulnerability stats via `fetchFleetFindingRows` + `computeStats`
 * (both org-scoped); the last `getSecurityPostureTrend` point folded into
 * `patching.patchScore`; `backup_jobs` 30-day terminal counts +
 * `backup_sla_events` unresolved `missed_backup` distinct devices; CIS from
 * the latest `cis_baseline_results` row per device.
 */
async function loadHealth(orgId: string, siteId: string | null | undefined): Promise<RawDesignEvidence['health']> {
  const siteJoinFilter = siteId ? sql`AND d.site_id = ${siteId}` : sql``;

  const reliability = await listReliabilityDevices({ orgId, siteId: siteId ?? undefined, limit: DESIGN_EVIDENCE_BOUNDS.reliabilityWorst });
  const reliabilityWorst = reliability.rows.map((r) => ({ deviceId: r.deviceId, score: r.reliabilityScore, trend: r.trendDirection }));

  const findingRows = await query<{ kind: string; title: string; device_count: number | string | null }>(sql`
    SELECT kind, MIN(title) AS title, SUM(device_count)::int AS device_count
    FROM fleet_findings
    WHERE org_id = ${orgId} AND status = 'open'
    GROUP BY kind
    ORDER BY SUM(device_count) DESC
    LIMIT ${DESIGN_EVIDENCE_BOUNDS.fleetFindings}
  `);
  const fleetFindings = findingRows.map((r) => ({ kind: r.kind, title: r.title ?? r.kind, deviceCount: count(r.device_count) }));

  const vulnRows = await fetchFleetFindingRows({ status: 'open', orgId });
  const vulnStats = computeStats(vulnRows, new Date());
  const highCount = vulnRows.filter((r) => r.status === 'open' && (r.severity ?? '').toLowerCase() === 'high').length;
  const devicesAffected = new Set(vulnRows.filter((r) => r.status === 'open').map((r) => r.deviceId)).size;
  const vulnerability = { critical: vulnStats.criticalOpen, high: highCount, devicesAffected };

  const trend = await getSecurityPostureTrend({ orgId, days: 14 });
  const lastPoint = trend[trend.length - 1];
  const patchScore = lastPoint ? numberOrNull(lastPoint.patchComplianceScore) : null;
  const [patchCountsRow] = await query<{ devices_pending: number | string | null; pending_patches: number | string | null }>(sql`
    SELECT COUNT(DISTINCT dp.device_id)::int AS devices_pending, COUNT(*)::int AS pending_patches
    FROM device_patches dp
    JOIN devices d ON d.id = dp.device_id AND d.org_id = ${orgId}
    WHERE dp.org_id = ${orgId} AND dp.status = 'pending' ${siteJoinFilter}
  `);
  const patching = { patchScore, devicesPending: count(patchCountsRow?.devices_pending), pendingPatches: count(patchCountsRow?.pending_patches) };

  const [backupRow] = await query<{ ok: number | string | null; failed: number | string | null; devices_failed: number | string | null }>(sql`
    SELECT COUNT(*) FILTER (WHERE bj.status = 'completed')::int AS ok,
           COUNT(*) FILTER (WHERE bj.status = 'failed')::int AS failed,
           COUNT(DISTINCT bj.device_id) FILTER (WHERE bj.status = 'failed')::int AS devices_failed
    FROM backup_jobs bj
    JOIN devices d ON d.id = bj.device_id AND d.org_id = ${orgId}
    WHERE bj.org_id = ${orgId} AND bj.started_at > now() - interval '30 days' ${siteJoinFilter}
  `);
  const [missedRow] = await query<{ missed: number | string | null }>(sql`
    SELECT COUNT(DISTINCT bse.device_id)::int AS missed
    FROM backup_sla_events bse
    JOIN devices d ON d.id = bse.device_id AND d.org_id = ${orgId}
    WHERE bse.org_id = ${orgId} AND bse.event_type = 'missed_backup' AND bse.resolved_at IS NULL ${siteJoinFilter}
  `);
  const backups = {
    ok: count(backupRow?.ok), failed: count(backupRow?.failed), missed: count(missedRow?.missed), devicesFailed: count(backupRow?.devices_failed),
  };

  const [cisRow] = await query<{ devices_assessed: number | string | null; avg_score: number | string | null }>(sql`
    SELECT COUNT(*)::int AS devices_assessed, AVG(latest.score)::float AS avg_score
    FROM (
      SELECT DISTINCT ON (cbr.device_id) cbr.device_id, cbr.score
      FROM cis_baseline_results cbr
      JOIN devices d ON d.id = cbr.device_id AND d.org_id = ${orgId}
      WHERE cbr.org_id = ${orgId} ${siteJoinFilter}
      ORDER BY cbr.device_id, cbr.checked_at DESC
    ) latest
  `);
  const cis = cisRow ? { devicesAssessed: count(cisRow.devices_assessed), avgScore: numberOrNull(cisRow.avg_score) } : { devicesAssessed: 0, avgScore: null };

  return { reliabilityWorst, fleetFindings, vulnerability, patching, backups, cis };
}

type PolicyRow = { id: string; name: string; status: string; org_id: string | null; partner_id: string | null };
type WatchRow = { policy_id: string; name: string; watch_type: string; enabled: boolean };
type RuleRow = { policy_id: string; name: string; severity: string; cooldown_minutes: number };
type AssignmentRow = { policy_id: string; level: string; target_id: string; priority: number; role_filter: string[] | null };
type AlertTemplateRow = { id: string; name: string; category: string | null; severity: string; is_built_in: boolean };

/**
 * Configuration: `configuration_policies` where `org_id = $org OR (org_id IS
 * NULL AND partner_id = $partnerId)` (Partner-Wide config shape, epic
 * #2135) — `$partnerId` resolved once in `loadHeader`, never from caller
 * input. Watches/rules are read via direct org-or-partner-pinned joins down
 * through `config_policy_feature_links` rather than through
 * `listFeatureLinks`'s generic assembled-settings shape, which mixes
 * per-feature-type JSON the evidence bundle's closed-schema contract cannot
 * safely pass through. `alert_templates` carries the same owner predicate
 * (or `is_built_in`).
 */
async function loadConfiguration(orgId: string, partnerId: string | null): Promise<RawDesignEvidence['configuration']> {
  const ownerPredicate = sql`(cp.org_id = ${orgId} OR (cp.org_id IS NULL AND cp.partner_id = ${partnerId}))`;
  const policies = await query<PolicyRow>(sql`
    SELECT cp.id, cp.name, cp.status::text AS status, cp.org_id, cp.partner_id
    FROM configuration_policies cp
    WHERE ${ownerPredicate} AND cp.status <> 'archived'
    LIMIT ${DESIGN_EVIDENCE_BOUNDS.policies}
  `);
  const policyIds = policies.map((p) => p.id);

  const watches = policyIds.length === 0 ? [] : await query<WatchRow>(sql`
    SELECT fl.config_policy_id AS policy_id, w.name, w.watch_type::text AS watch_type, w.enabled
    FROM config_policy_monitoring_watches w
    JOIN config_policy_monitoring_settings ms ON ms.id = w.settings_id
    JOIN config_policy_feature_links fl ON fl.id = ms.feature_link_id AND fl.config_policy_id = ANY(${uuidArray(policyIds)})
    JOIN configuration_policies cp ON cp.id = fl.config_policy_id AND ${ownerPredicate}
  `);
  const rules = policyIds.length === 0 ? [] : await query<RuleRow>(sql`
    SELECT fl.config_policy_id AS policy_id, r.name, r.severity::text AS severity, r.cooldown_minutes
    FROM config_policy_alert_rules r
    JOIN config_policy_feature_links fl ON fl.id = r.feature_link_id AND fl.config_policy_id = ANY(${uuidArray(policyIds)})
    JOIN configuration_policies cp ON cp.id = fl.config_policy_id AND ${ownerPredicate}
  `);
  const watchesByPolicy = new Map<string, RawDesignEvidence['configuration']['policies'][number]['watches']>();
  for (const w of watches) {
    const list = watchesByPolicy.get(w.policy_id) ?? [];
    list.push({ name: w.name, watchType: w.watch_type, enabled: w.enabled });
    watchesByPolicy.set(w.policy_id, list);
  }
  const rulesByPolicy = new Map<string, RawDesignEvidence['configuration']['policies'][number]['rules']>();
  for (const r of rules) {
    const list = rulesByPolicy.get(r.policy_id) ?? [];
    list.push({ name: r.name, severity: r.severity, cooldownMinutes: r.cooldown_minutes });
    rulesByPolicy.set(r.policy_id, list);
  }

  const assignments = policyIds.length === 0 ? [] : await query<AssignmentRow>(sql`
    SELECT a.config_policy_id AS policy_id, a.level::text AS level, a.target_id::text AS target_id, a.priority, a.role_filter
    FROM config_policy_assignments a
    JOIN configuration_policies cp ON cp.id = a.config_policy_id AND ${ownerPredicate}
    WHERE a.config_policy_id = ANY(${uuidArray(policyIds)})
  `);

  const alertTemplates = await query<AlertTemplateRow>(sql`
    SELECT at.id, at.name, at.category, at.severity::text AS severity, at.is_built_in
    FROM alert_templates at
    WHERE (at.org_id = ${orgId} OR (at.org_id IS NULL AND at.partner_id = ${partnerId}) OR at.is_built_in = true)
    LIMIT ${DESIGN_EVIDENCE_BOUNDS.alertTemplates}
  `);

  return {
    policies: policies.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      ownerScope: p.org_id ? 'organization' as const : 'partner' as const,
      watches: watchesByPolicy.get(p.id) ?? [],
      rules: rulesByPolicy.get(p.id) ?? [],
    })),
    assignments: assignments.map((a) => ({ policyId: a.policy_id, level: a.level, targetId: a.target_id, priority: a.priority, roleFilter: a.role_filter })),
    alertTemplates: alertTemplates.map((t) => ({ id: t.id, name: t.name, category: t.category, severity: t.severity, isBuiltIn: t.is_built_in })),
  };
}

type PlaybookRow = { id: string; name: string; is_built_in: boolean; category: string | null };
type ScriptRow = { id: string; name: string; language: string; os_types: string[] | null; description: string | null; tags: string[] | null };

/**
 * Automation: `playbook_definitions` where `is_built_in OR org_id = $org`;
 * `scripts` where not soft-deleted and `org_id = $org OR (org_id IS NULL AND
 * partner_id = $partnerId)`, tags aggregated through the org/partner-pinned
 * `script_to_tags` -> `script_tags` join.
 */
async function loadAutomation(orgId: string, partnerId: string | null): Promise<RawDesignEvidence['automation']> {
  const playbooks = await query<PlaybookRow>(sql`
    SELECT id, name, is_built_in, category
    FROM playbook_definitions
    WHERE is_active = true AND (is_built_in = true OR org_id = ${orgId})
    LIMIT ${DESIGN_EVIDENCE_BOUNDS.playbooks}
  `);
  const scripts = await query<ScriptRow>(sql`
    SELECT s.id, s.name, s.language::text AS language, s.os_types, s.description,
           (
             SELECT array_agg(t.name)
             FROM script_to_tags stt
             JOIN script_tags t ON t.id = stt.tag_id AND (t.org_id = ${orgId} OR (t.org_id IS NULL AND t.partner_id = ${partnerId}))
             WHERE stt.script_id = s.id
           ) AS tags
    FROM scripts s
    WHERE s.deleted_at IS NULL AND (s.org_id = ${orgId} OR (s.org_id IS NULL AND s.partner_id = ${partnerId}))
    -- Legacy-import scripts first (W04 #5654): the legacy section owes one
    -- entry per such script, so an org with more than the bound must lose
    -- ordinary library rows to the LIMIT, never the inventory.
    ORDER BY EXISTS (
               SELECT 1 FROM script_to_tags stt2
               JOIN script_tags t2 ON t2.id = stt2.tag_id AND (t2.org_id = ${orgId} OR (t2.org_id IS NULL AND t2.partner_id = ${partnerId}))
               WHERE stt2.script_id = s.id AND lower(t2.name) = 'legacy-import'
             ) DESC,
             s.name, s.id
    LIMIT ${DESIGN_EVIDENCE_BOUNDS.scripts}
  `);
  return {
    playbooks: playbooks.map((p) => ({ id: p.id, name: p.name, isBuiltIn: p.is_built_in, category: p.category })),
    scripts: scripts.map((s) => {
      const tags = s.tags ?? [];
      return {
        id: s.id, name: s.name, language: s.language, osTypes: s.os_types ?? [], tags,
        legacyImport: tags.some((t) => t.toLowerCase() === 'legacy-import'),
        description: (s.description ?? '').slice(0, 200),
      };
    }),
  };
}

type LogRow = { event_id: string | null; source: string; level: string; count: number | string | null; device_count: number | string | null };

/**
 * Logs: `device_event_logs` JOIN `devices`, both org-pinned, grouped over a
 * 30-day window.
 */
async function loadLogs(orgId: string, siteId: string | null | undefined): Promise<RawDesignEvidence['logs']> {
  const siteFilter = siteId ? sql`AND d.site_id = ${siteId}` : sql``;
  const rows = await query<LogRow>(sql`
    SELECT l.event_id, l.source, l.level::text AS level,
           COUNT(*)::int AS count, COUNT(DISTINCT l.device_id)::int AS device_count
    FROM device_event_logs l
    JOIN devices d ON d.id = l.device_id AND d.org_id = ${orgId}
    WHERE l.org_id = ${orgId} AND l.timestamp > now() - interval '30 days' ${siteFilter}
    GROUP BY l.event_id, l.source, l.level
    ORDER BY COUNT(*) DESC
    LIMIT ${DESIGN_EVIDENCE_BOUNDS.logs}
  `);
  return rows.map((r) => ({ eventId: r.event_id ?? '', source: r.source, level: r.level, count: count(r.count), deviceCount: count(r.device_count) }));
}

/** Alerts created in 90 days, tickets created in 90 days (excluding soft
 *  deletes), live endpoint count — all `org_id`-pinned. */
async function loadCounts(orgId: string, siteId: string | null | undefined): Promise<RawDesignEvidence['counts']> {
  const deviceSiteFilter = siteId ? sql`AND site_id = ${siteId}` : sql``;
  const [alertsRow] = await query<{ total: number | string | null }>(sql`
    SELECT COUNT(*)::int AS total FROM alerts a
    WHERE a.org_id = ${orgId} AND a.created_at > now() - interval '90 days'
      ${siteId ? sql`AND a.device_id IN (SELECT id FROM devices WHERE org_id = ${orgId} AND site_id = ${siteId})` : sql``}
  `);
  const [ticketsRow] = await query<{ total: number | string | null }>(sql`
    SELECT COUNT(*)::int AS total FROM tickets t
    WHERE t.org_id = ${orgId} AND t.deleted_at IS NULL AND t.created_at > now() - interval '90 days'
  `);
  const [endpointsRow] = await query<{ total: number | string | null }>(sql`
    SELECT COUNT(*)::int AS total FROM devices
    WHERE org_id = ${orgId} AND is_ephemeral = false AND status <> 'decommissioned' ${deviceSiteFilter}
  `);
  return { alerts90d: count(alertsRow?.total), tickets90d: count(ticketsRow?.total), endpoints: count(endpointsRow?.total) };
}

/**
 * Precursors: every count `org_id`-pinned (directly, or through an
 * org-pinned `devices` join for `patches`, which carries no tenant column of
 * its own). `certificateExpiring` stays `null` — no source table tracks
 * certificate expiry today (spec §4.3, "where known").
 */
async function loadPrecursors(orgId: string, siteId: string | null | undefined, thresholds: typeof FLEET_DESIGN_PRECURSOR_THRESHOLDS): Promise<RawDesignEvidence['precursors']> {
  const deviceSiteFilter = siteId ? sql`AND d.site_id = ${siteId}` : sql``;
  const [diskRow] = await query<{ total: number | string | null }>(sql`
    SELECT COUNT(DISTINCT dd.device_id)::int AS total
    FROM device_disks dd
    JOIN devices d ON d.id = dd.device_id AND d.org_id = ${orgId}
    WHERE dd.org_id = ${orgId} AND dd.used_percent >= ${thresholds.diskUsedPercent} ${deviceSiteFilter}
  `);
  const [rebootRow] = await query<{ pending: number | string | null; pending_over: number | string | null }>(sql`
    SELECT COUNT(*) FILTER (WHERE d.pending_reboot)::int AS pending,
           COUNT(*) FILTER (WHERE d.pending_reboot AND d.reboot_scheduled_at < now() - (${thresholds.rebootPendingDays}::text || ' days')::interval)::int AS pending_over
    FROM devices d
    WHERE d.org_id = ${orgId} AND d.is_ephemeral = false AND d.status <> 'decommissioned' ${deviceSiteFilter}
  `);
  const [patchRow] = await query<{ total: number | string | null }>(sql`
    SELECT COUNT(DISTINCT dp.device_id)::int AS total
    FROM device_patches dp
    JOIN patches p ON p.id = dp.patch_id
    JOIN devices d ON d.id = dp.device_id AND d.org_id = ${orgId}
    WHERE dp.org_id = ${orgId} AND dp.status = 'pending'
      AND p.release_date < (now() - interval '30 days')::date ${deviceSiteFilter}
  `);
  const [backupRow] = await query<{ total: number | string | null }>(sql`
    SELECT COUNT(DISTINCT bse.device_id)::int AS total
    FROM backup_sla_events bse
    JOIN devices d ON d.id = bse.device_id AND d.org_id = ${orgId}
    WHERE bse.org_id = ${orgId} AND bse.event_type = 'missed_backup' AND bse.resolved_at IS NULL ${deviceSiteFilter}
  `);
  const [restartRow] = await query<{ total: number | string | null }>(sql`
    SELECT COUNT(*)::int AS total FROM (
      SELECT r.device_id, r.name
      FROM service_process_check_results r
      JOIN devices d ON d.id = r.device_id AND d.org_id = ${orgId}
      WHERE r.org_id = ${orgId} AND r.timestamp > now() - interval '30 days' ${deviceSiteFilter}
      GROUP BY r.device_id, r.name
      HAVING COUNT(*) FILTER (WHERE r.auto_restart_attempted) > ${thresholds.serviceRestartsPer30d}
    ) offenders
  `);
  return {
    diskOver: count(diskRow?.total),
    rebootPending: count(rebootRow?.pending),
    rebootPendingOver: count(rebootRow?.pending_over),
    patchAgeOver: count(patchRow?.total),
    certificateExpiring: null,
    backupMissed: count(backupRow?.total),
    serviceRestartsOver: count(restartRow?.total),
  };
}

/**
 * Load the full fleet design evidence bundle for one org, bounded and
 * honest.
 *
 * The caller already holds a SYSTEM DB context — see this module's header on
 * tenancy. NEVER throws: a rejected loader costs exactly its own section.
 *
 * The header runs FIRST and alone because every partner-axis predicate below
 * needs its `partnerId`. The rest run sequentially, each isolated by
 * `settled` — `withSystemDbAccessContext` holds one pooled connection inside
 * one open transaction for the whole call (same reasoning as
 * `loadNarrativeContext`), so concurrent issuance would only queue on that
 * same connection, and a genuine statement error aborts the shared
 * transaction for every loader after it (under-reporting availability is the
 * safe direction here, same as `narrativeContext.ts`).
 */
export async function loadDesignEvidence(orgId: string, opts: { siteId?: string | null }): Promise<DesignEvidence> {
  const siteId = opts.siteId ?? null;
  const unavailable: string[] = [];
  const missing = (section: string): void => { unavailable.push(section); };

  const header = await settled(orgId, 'org', () => loadHeader(orgId, siteId));
  if (!header) missing('org');
  const partnerId = header?.partnerId ?? null;

  const start = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const end = new Date();
  const window = { start: start.toISOString(), end: end.toISOString() };

  const deviceResult = await settled(orgId, 'devices', () => loadDevices(orgId, siteId));
  if (!deviceResult) missing('devices');
  const software = await settled(orgId, 'software', () => loadSoftware(orgId, siteId));
  if (!software) missing('software');
  const services = await settled(orgId, 'services', () => loadServices(orgId, siteId));
  if (!services) missing('services');
  const network = await settled(orgId, 'network', () => loadNetwork(orgId, siteId));
  if (!network) missing('network');
  const posture = await settled(orgId, 'posture', () => loadPosture(orgId, siteId));
  if (!posture) missing('posture');
  const health = await settled(orgId, 'health', () => loadHealth(orgId, siteId));
  if (!health) missing('health');
  const configuration = await settled(orgId, 'configuration', () => loadConfiguration(orgId, partnerId));
  if (!configuration) missing('configuration');
  const automation = await settled(orgId, 'automation', () => loadAutomation(orgId, partnerId));
  if (!automation) missing('automation');
  const logs = await settled(orgId, 'logs', () => loadLogs(orgId, siteId));
  if (!logs) missing('logs');
  const counts = await settled(orgId, 'counts', () => loadCounts(orgId, siteId));
  if (!counts) missing('counts');
  const precursors = await settled(orgId, 'precursors', () => loadPrecursors(orgId, siteId, FLEET_DESIGN_PRECURSOR_THRESHOLDS));
  if (!precursors) missing('precursors');
  // W05: the approved design and the live state it is compared against. A
  // loader failure lands in `unavailable` like any other section — the run
  // then simply carries no drift, never an invented empty one.
  const approved = await settled(orgId, 'approvedDesign', async () => {
    const design = await loadApprovedDesign(orgId);
    if (!design) return { approvedDesign: null, driftLive: null };
    return { approvedDesign: design, driftLive: await loadDriftLiveState(orgId, design) };
  });
  if (!approved) missing('approvedDesign');

  const raw: RawDesignEvidence = {
    org: {
      name: header?.name ?? '',
      partnerName: header?.partnerName ?? '',
      timezone: header?.timezone ?? 'UTC',
      siteName: header?.siteName ?? null,
    },
    window,
    devices: deviceResult?.devices ?? [],
    devicesTotal: deviceResult?.devicesTotal ?? 0,
    software: software ?? [],
    services: services ?? [],
    network: network ?? { assets: [], topology: [], baselines: 0, openChanges: [] },
    posture: posture ?? [],
    health: health ?? { reliabilityWorst: [], fleetFindings: [], vulnerability: null, patching: null, backups: null, cis: null },
    configuration: configuration ?? { policies: [], assignments: [], alertTemplates: [] },
    automation: automation ?? { playbooks: [], scripts: [] },
    logs: logs ?? [],
    counts: counts ?? { alerts90d: 0, tickets90d: 0, endpoints: 0 },
    precursors: precursors ?? { diskOver: 0, rebootPending: 0, rebootPendingOver: 0, patchAgeOver: 0, certificateExpiring: null, backupMissed: 0, serviceRestartsOver: 0 },
    unavailable,
    approvedDesign: approved?.approvedDesign ?? null,
    driftLive: approved?.driftLive ?? null,
  };

  return assembleDesignEvidence(raw);
}
