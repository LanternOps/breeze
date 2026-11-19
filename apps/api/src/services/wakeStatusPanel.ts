import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { configPolicyAssignments } from '../db/schema/configurationPolicies';
import { devices } from '../db/schema/devices';
import { deviceWakeAttempts, deviceWakeStatus, WAKE_READINESS_STATES } from '../db/schema/deviceWake';
import { resolveAssignmentDeviceIds, resolveWakeOnLanWinnersForDevices } from './featureConfigResolver';
import { decideWakeAvailability, type WakeEffectiveState } from './wakeAvailability';
import {
  WAKE_OBSERVATION_INTERFACES,
  WAKE_OBSERVATION_VENDORS,
} from '@breeze/shared/validators';

/**
 * Per-policy Wake-on-LAN status panel (#10838 W02 Task 11).
 *
 * "Which devices does this policy govern, and how ready are they?" is answered
 * by walking the policy's own assignments to candidate devices and keeping the
 * ones whose winning wake_on_lan link is this policy. That is a bounded scan,
 * not a count over the fleet: candidates are sorted by id and capped at
 * {@link WAKE_STATUS_SCAN_CAP}; past the cap the response says `capped: true`
 * and the counts describe the scanned set only.
 */

export const WAKE_STATUS_SCAN_CAP = 5000;
const CHUNK = 500;

export const WAKE_PANEL_STATES = [
  ...WAKE_READINESS_STATES,
  'unsupported_os',
  'agent_update_required',
  'no_data',
] as const satisfies readonly WakeEffectiveState[];

export interface WakeStatusRow {
  deviceId: string;
  hostname: string;
  osType: 'windows' | 'macos' | 'linux';
  status: string;
  state: WakeEffectiveState;
  reasonCodes: string[];
  vendor: string | null;
  model: string | null;
  lastAttempt: { outcome: string; refusalCode: string | null; at: string } | null;
  consecutiveTimeouts: number;
  testWakeAllowed: boolean;
  show: boolean;
  mode: 'none' | 'verified' | 'always' | 'unknown';
  /**
   * Observe-first amendment §2: which vendor interface the agent is observing
   * and what it found. Summary only: setting values stay in
   * details.vendorObservation and are read by our own staff's evidence query,
   * never shown here.
   */
  observation: WakeObservationSummary | null;
}

export interface WakeObservationSummary {
  vendor: (typeof WAKE_OBSERVATION_VENDORS)[number];
  interface: (typeof WAKE_OBSERVATION_INTERFACES)[number];
  errorCode: string | null;
}

const OBSERVATION_ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Re-checks the stored summary fields: only known values leave the service. */
function observationSummary(vendor: unknown, iface: unknown, errorCode: unknown): WakeObservationSummary | null {
  const v = WAKE_OBSERVATION_VENDORS.find((x) => x === vendor);
  const i = WAKE_OBSERVATION_INTERFACES.find((x) => x === iface);
  if (!v || !i) return null;
  return {
    vendor: v,
    interface: i,
    errorCode: typeof errorCode === 'string' && OBSERVATION_ERROR_CODE.test(errorCode) ? errorCode : null,
  };
}

export interface WakeStatusPage {
  data: WakeStatusRow[];
  counts: Record<string, number>;
  total: number;
  page: number;
  limit: number;
  scanned: number;
  capped: boolean;
}

interface ScopedDevice {
  id: string;
  hostname: string;
  osType: 'windows' | 'macos' | 'linux';
  status: string;
  agentVersion: string | null;
  siteId: string;
  orgId: string;
}

function chunked<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/**
 * Devices (in the caller's RLS context and, when site-restricted, only the
 * caller's allowed sites: the same restriction the device list applies) whose
 * wake_on_lan winner is `policyId`.
 */
async function governedDevices(
  candidateIds: readonly string[],
  policyId: string,
  allowedSiteIds: readonly string[] | undefined,
): Promise<Array<{ device: ScopedDevice; settings: { configureSettings: false; buttonMode: 'verified' | 'always' } }>> {
  if (allowedSiteIds && allowedSiteIds.length === 0) return [];
  const out: Array<{ device: ScopedDevice; settings: { configureSettings: false; buttonMode: 'verified' | 'always' } }> = [];
  for (const chunk of chunked(candidateIds)) {
    const conditions = [inArray(devices.id, chunk), sql`${devices.status} != 'decommissioned'`];
    if (allowedSiteIds) conditions.push(inArray(devices.siteId, [...allowedSiteIds]));
    const rows = await db
      .select({
        id: devices.id,
        hostname: devices.hostname,
        osType: devices.osType,
        status: devices.status,
        agentVersion: devices.agentVersion,
        siteId: devices.siteId,
        orgId: devices.orgId,
      })
      .from(devices)
      .where(and(...conditions));
    // The SQL predicate already restricts sites; re-check here so a site-restricted
    // caller can never see a row even if a predicate is ever dropped.
    const visible = (rows as ScopedDevice[]).filter((d) => !allowedSiteIds || allowedSiteIds.includes(d.siteId));
    if (visible.length === 0) continue;
    const winners = await resolveWakeOnLanWinnersForDevices(visible.map((d) => d.id));
    for (const device of visible) {
      const winner = winners.get(device.id);
      if (winner && winner.assignedPolicyId === policyId) out.push({ device, settings: winner.settings });
    }
  }
  return out;
}

export async function listWakeStatusForPolicy(input: {
  policyId: string;
  allowedSiteIds: readonly string[] | undefined;
  page: number;
  limit: number;
  state?: string;
}): Promise<WakeStatusPage> {
  const { policyId, allowedSiteIds, page, limit, state } = input;

  const assignments = (await db
    .select({ level: configPolicyAssignments.level, targetId: configPolicyAssignments.targetId })
    .from(configPolicyAssignments)
    .where(eq(configPolicyAssignments.configPolicyId, policyId))) as Array<{ level: string; targetId: string }>;

  const candidates = new Set<string>();
  for (const assignment of assignments) {
    for (const id of await resolveAssignmentDeviceIds(assignment.level, assignment.targetId)) candidates.add(id);
  }
  const sorted = Array.from(candidates).sort();
  const capped = sorted.length > WAKE_STATUS_SCAN_CAP;
  const scannedIds = capped ? sorted.slice(0, WAKE_STATUS_SCAN_CAP) : sorted;

  const governed = await governedDevices(scannedIds, policyId, allowedSiteIds);

  const statusById = new Map<string, {
    readinessState: (typeof WAKE_READINESS_STATES)[number] | null;
    reasonCodes: string[];
    vendor: string | null;
    model: string | null;
    fingerprint: string | null;
    proofFingerprint: string | null;
    lastCameOnlineAt: Date | null;
    consecutiveTimeouts: number;
    obsVendor: string | null;
    obsInterface: string | null;
    obsErrorCode: string | null;
  }>();
  for (const chunk of chunked(governed.map((g) => g.device.id))) {
    const rows = await db
      .select({
        deviceId: deviceWakeStatus.deviceId,
        readinessState: deviceWakeStatus.readinessState,
        reasonCodes: deviceWakeStatus.reasonCodes,
        vendor: deviceWakeStatus.vendor,
        model: sql<string | null>`${deviceWakeStatus.details}->>'model'`,
        fingerprint: deviceWakeStatus.fingerprint,
        proofFingerprint: deviceWakeStatus.proofFingerprint,
        lastCameOnlineAt: deviceWakeStatus.lastCameOnlineAt,
        consecutiveTimeouts: deviceWakeStatus.consecutiveTimeouts,
        // Three summary paths only; the observation's settings are never read here.
        obsVendor: sql<string | null>`${deviceWakeStatus.details}->'vendorObservation'->>'vendor'`,
        obsInterface: sql<string | null>`${deviceWakeStatus.details}->'vendorObservation'->>'interface'`,
        obsErrorCode: sql<string | null>`${deviceWakeStatus.details}->'vendorObservation'->>'errorCode'`,
      })
      .from(deviceWakeStatus)
      .where(inArray(deviceWakeStatus.deviceId, chunk));
    for (const row of rows as Array<{ deviceId: string } & (typeof statusById extends Map<string, infer V> ? V : never)>) {
      statusById.set(row.deviceId, row);
    }
  }

  const now = new Date();
  const counts: Record<string, number> = {};
  const rows: WakeStatusRow[] = governed.map(({ device, settings }) => {
    const status = statusById.get(device.id) ?? null;
    const availability = decideWakeAvailability({
      settings,
      status: status && {
        readinessState: status.readinessState,
        fingerprint: status.fingerprint,
        proofFingerprint: status.proofFingerprint,
        lastCameOnlineAt: status.lastCameOnlineAt,
        consecutiveTimeouts: status.consecutiveTimeouts,
      },
      device: { osType: device.osType, agentVersion: device.agentVersion },
      now,
    });
    counts[availability.state] = (counts[availability.state] ?? 0) + 1;
    return {
      deviceId: device.id,
      hostname: device.hostname,
      osType: device.osType,
      status: device.status,
      state: availability.state,
      reasonCodes: status?.reasonCodes ?? [],
      vendor: status?.vendor ?? null,
      model: status?.model ?? null,
      lastAttempt: null,
      consecutiveTimeouts: status?.consecutiveTimeouts ?? 0,
      testWakeAllowed: availability.testWakeAllowed,
      show: availability.show,
      mode: availability.mode,
      observation: status ? observationSummary(status.obsVendor, status.obsInterface, status.obsErrorCode) : null,
    };
  });

  const filtered = (state ? rows.filter((r) => r.state === state) : rows)
    .sort((a, b) => a.hostname.localeCompare(b.hostname) || a.deviceId.localeCompare(b.deviceId));
  const pageRows = filtered.slice((page - 1) * limit, page * limit);

  if (pageRows.length > 0) {
    // One DISTINCT ON read: the newest attempt per device on this page.
    const attempts = await db
      .selectDistinctOn([deviceWakeAttempts.deviceId], {
        deviceId: deviceWakeAttempts.deviceId,
        outcome: deviceWakeAttempts.outcome,
        refusalCode: deviceWakeAttempts.refusalCode,
        at: deviceWakeAttempts.requestedAt,
      })
      .from(deviceWakeAttempts)
      .where(inArray(deviceWakeAttempts.deviceId, pageRows.map((r) => r.deviceId)))
      .orderBy(deviceWakeAttempts.deviceId, desc(deviceWakeAttempts.requestedAt));
    const byDevice = new Map(
      (attempts as Array<{ deviceId: string; outcome: string; refusalCode: string | null; at: Date }>)
        .map((a) => [a.deviceId, a] as const),
    );
    for (const row of pageRows) {
      const attempt = byDevice.get(row.deviceId);
      if (attempt) row.lastAttempt = { outcome: attempt.outcome, refusalCode: attempt.refusalCode, at: attempt.at.toISOString() };
    }
  }

  return { data: pageRows, counts, total: filtered.length, page, limit, scanned: scannedIds.length, capped };
}

/**
 * Clears the repeated-timeout block for a device this policy governs.
 * Returns null (route answers 404) for an invisible, site-restricted-out, or
 * ungoverned device, or one with no device_wake_status row yet, and writes
 * nothing in that case.
 */
export async function allowWakeAgain(input: {
  policyId: string;
  deviceId: string;
  allowedSiteIds: readonly string[] | undefined;
}): Promise<{ orgId: string; hostname: string } | null> {
  const { policyId, deviceId, allowedSiteIds } = input;
  if (allowedSiteIds && allowedSiteIds.length === 0) return null;

  const rows = (await db
    .select({ id: devices.id, hostname: devices.hostname, siteId: devices.siteId, orgId: devices.orgId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1)) as Array<{ id: string; hostname: string; siteId: string; orgId: string }>;
  const device = rows[0];
  if (!device) return null;
  if (allowedSiteIds && !allowedSiteIds.includes(device.siteId)) return null;

  const winner = (await resolveWakeOnLanWinnersForDevices([deviceId])).get(deviceId);
  if (!winner || winner.assignedPolicyId !== policyId) return null;

  const updated = await db
    .update(deviceWakeStatus)
    .set({ consecutiveTimeouts: 0, updatedAt: new Date() })
    .where(eq(deviceWakeStatus.deviceId, deviceId))
    .returning({ deviceId: deviceWakeStatus.deviceId });
  // No status row yet (the agent has not reported): nothing was cleared, so
  // the route answers 404 and writes no audit row.
  if (updated.length === 0) return null;
  return { orgId: device.orgId, hostname: device.hostname };
}
