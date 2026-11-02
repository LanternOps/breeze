/**
 * Reinstall candidates (#8318 spec §7.3,
 * docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md).
 *
 * After an enrollment and after a hardware report, look for an OLDER, SILENT
 * record in the source's partner that the newly enrolled (source) device is
 * probably a reinstall of, by evidence: the SMBIOS system UUID (either byte
 * order), then serial + manufacturer, then hostname. Flag the best one on the
 * SOURCE row only (`possible_replacement_of_device_id`, `_reason`,
 * `_detected_at`) and, when the flag was written or upgraded, notify the
 * TARGET's org (notify.ts). Nothing is reattached here; a human decides (§8).
 *
 * Shape (each phase in its own short system DB context, never one held across
 * Redis or BullMQ work, #1105):
 *  1. read  — the source, the candidates, the ledger; decide (ranking.ts);
 *  2. write — the source row locked FOR UPDATE and bound to the install that
 *     was read (agent_id + install_incarnation, and the flag read, as a
 *     compare-and-swap), so a reattach confirm or a concurrent detection that
 *     commits first wins and this one writes nothing;
 *  3. notify — event, alert and audit, after phase 2 committed.
 *
 * Never throws to its caller: a failure is logged and swallowed, because the
 * enrollment or the report that triggered it has already committed.
 */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { deviceHardware, deviceReattachments, devices, organizations } from '../../db/schema';
import { updateOwnDeviceRow } from '../agentOwnDeviceRow';
import { captureException } from '../sentry';
import { isUnassignedPoolOrgType } from '../unassignedPool/orgType';
import { isHiddenOrgType } from '../unassignedPool/visibility';
import { serialManufacturerKey } from './hardwareIdentity';
import {
  decideFlagWrite,
  rankCandidates,
  targetIneligibility,
  type CandidateRow,
  type CandidateSource,
  type RankedCandidate,
  type ReinstallEvidence,
} from './ranking';
import {
  publishReinstallSuspectedEvent,
  raiseReinstallSuspectedAlert,
  writeReinstallSuspectedAudit,
  type ReinstallSuspicion,
} from './notify';
import { systemUuidMatchForms } from './systemUuid';

export type ReinstallTrigger = 'enroll' | 'hardware_report';

/** At most this many matches are read per kind of evidence. */
export const MAX_MATCHES_PER_EVIDENCE = 25;

export interface DetectReinstallCandidatesInput {
  sourceDeviceId: string;
  trigger: ReinstallTrigger;
}

export type DetectReinstallCandidatesResult =
  | { written: false; why: string }
  | { written: true; kind: 'new' | 'upgrade' | 'replace'; targetDeviceId: string; reason: RankedCandidate['reason'] };

interface SourceSnapshot extends CandidateSource {
  orgId: string;
  hostname: string;
  agentId: string;
  installIncarnation: number;
  isEphemeral: boolean;
  orgType: string | null;
  partnerId: string;
  systemUuid: string | null;
  serialNumber: string | null;
  manufacturer: string | null;
  storedTargetId: string | null;
  storedReason: string | null;
}

const candidateColumns = {
  id: devices.id,
  orgId: devices.orgId,
  siteId: devices.siteId,
  hostname: devices.hostname,
  osType: devices.osType,
  orgType: organizations.type,
  createdAt: devices.createdAt,
  lastSeenAt: devices.lastSeenAt,
  watchdogLastSeen: devices.watchdogLastSeen,
  isEphemeral: devices.isEphemeral,
  linkGroupId: devices.linkGroupId,
  status: devices.status,
  decommissionedAt: devices.decommissionedAt,
};

async function readSource(sourceDeviceId: string): Promise<SourceSnapshot | null> {
  const [row] = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      hostname: devices.hostname,
      osType: devices.osType,
      agentId: devices.agentId,
      installIncarnation: devices.installIncarnation,
      isEphemeral: devices.isEphemeral,
      linkGroupId: devices.linkGroupId,
      createdAt: devices.createdAt,
      enrolledAt: devices.enrolledAt,
      storedTargetId: devices.possibleReplacementOfDeviceId,
      storedReason: devices.possibleReplacementReason,
      orgType: organizations.type,
      partnerId: organizations.partnerId,
      systemUuid: deviceHardware.systemUuid,
      serialNumber: deviceHardware.serialNumber,
      manufacturer: deviceHardware.manufacturer,
    })
    .from(devices)
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .leftJoin(deviceHardware, eq(deviceHardware.deviceId, devices.id))
    .where(eq(devices.id, sourceDeviceId))
    .limit(1);
  if (!row || !row.agentId) return null;
  return { ...row, agentId: row.agentId, enrolledAt: row.enrolledAt ?? row.createdAt };
}

/** Devices of the source's partner (any org), the source excluded. */
function inSourcePartner(source: SourceSnapshot) {
  return and(eq(organizations.partnerId, source.partnerId), ne(devices.id, source.id));
}

async function readMatches(source: SourceSnapshot): Promise<Array<{ target: CandidateRow; evidence: ReinstallEvidence }>> {
  const matches: Array<{ target: CandidateRow; evidence: ReinstallEvidence }> = [];

  const uuidForms = systemUuidMatchForms(source.systemUuid);
  if (uuidForms.length > 0) {
    const rows = await db
      .select(candidateColumns)
      .from(deviceHardware)
      .innerJoin(devices, eq(devices.id, deviceHardware.deviceId))
      .innerJoin(organizations, eq(organizations.id, devices.orgId))
      .where(and(inSourcePartner(source), inArray(deviceHardware.systemUuid, uuidForms)))
      .limit(MAX_MATCHES_PER_EVIDENCE);
    for (const target of rows) matches.push({ target, evidence: 'system_uuid' });
  }

  const serialKey = serialManufacturerKey(source.serialNumber, source.manufacturer);
  if (serialKey) {
    // The exact expressions of device_hardware_serial_vendor_idx, with its
    // partial predicate spelled out so the planner can use it.
    const rows = await db
      .select(candidateColumns)
      .from(deviceHardware)
      .innerJoin(devices, eq(devices.id, deviceHardware.deviceId))
      .innerJoin(organizations, eq(organizations.id, devices.orgId))
      .where(and(
        inSourcePartner(source),
        sql`${deviceHardware.serialNumber} IS NOT NULL AND ${deviceHardware.manufacturer} IS NOT NULL`,
        sql`upper(btrim(${deviceHardware.serialNumber})) = ${serialKey.serialKey}`,
        sql`lower(btrim(${deviceHardware.manufacturer})) = ${serialKey.manufacturerKey}`,
      ))
      .limit(MAX_MATCHES_PER_EVIDENCE);
    for (const target of rows) matches.push({ target, evidence: 'serial' });
  }

  if (source.hostname.trim()) {
    const rows = await db
      .select(candidateColumns)
      .from(devices)
      .innerJoin(organizations, eq(organizations.id, devices.orgId))
      .where(and(inSourcePartner(source), sql`lower(${devices.hostname}) = lower(${source.hostname})`))
      .limit(MAX_MATCHES_PER_EVIDENCE);
    for (const target of rows) matches.push({ target, evidence: 'hostname' });
  }
  return matches;
}

/** Device ids that were ever the SOURCE of a confirmed reattach (the ledger; cf. wasRetiredReattachSource). */
async function readRetiredSources(deviceIds: string[]): Promise<Set<string>> {
  if (deviceIds.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ id: deviceReattachments.sourceDeviceId })
    .from(deviceReattachments)
    .where(inArray(deviceReattachments.sourceDeviceId, deviceIds));
  return new Set(rows.map((row) => row.id));
}

async function readTarget(targetId: string): Promise<CandidateRow | null> {
  const [row] = await db
    .select(candidateColumns)
    .from(devices)
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .where(eq(devices.id, targetId))
    .limit(1);
  return row ?? null;
}

interface Plan {
  source: SourceSnapshot;
  best: RankedCandidate;
  kind: 'new' | 'upgrade' | 'replace';
}

async function plan(sourceDeviceId: string): Promise<Plan | { skip: string }> {
  const source = await readSource(sourceDeviceId);
  if (!source) return { skip: 'source_not_found' };
  // A Quick Support session (the hidden org that is not the holding org) is a
  // stranger's machine for one support call, not a reinstall of anything; a
  // parked source IS searched (§7.3).
  const quickSupportSource = isHiddenOrgType(source.orgType) && !isUnassignedPoolOrgType(source.orgType);
  if (source.isEphemeral || quickSupportSource) return { skip: 'source_ephemeral' };

  const matches = await readMatches(source);
  const ids = [...new Set(matches.map((m) => m.target.id))];
  if (source.storedTargetId && !ids.includes(source.storedTargetId)) ids.push(source.storedTargetId);
  const retired = await readRetiredSources(ids);
  const qualifying = matches.filter((m) => targetIneligibility(source, m.target, retired.has(m.target.id)) === null);
  const [best] = rankCandidates(source, qualifying);

  let storedTargetQualifies = true;
  if (best && source.storedTargetId && source.storedTargetId !== best.target.id) {
    const storedInSet = qualifying.find((m) => m.target.id === source.storedTargetId)?.target;
    const stored = storedInSet ?? (await readTarget(source.storedTargetId));
    storedTargetQualifies = Boolean(stored)
      && targetIneligibility(source, stored!, retired.has(source.storedTargetId)) === null;
  }

  const decision = decideFlagWrite(
    { targetDeviceId: source.storedTargetId, reason: source.storedReason },
    best ? { targetDeviceId: best.target.id, reason: best.reason } : null,
    storedTargetQualifies,
  );
  if (!decision.write) return { skip: decision.why };
  return { source, best: best!, kind: decision.kind };
}

/**
 * Write the flag on the source, bound to the install and the flag that were
 * read. Returns the write time, or null when the row moved on (0 rows).
 */
async function writeFlag(p: Plan): Promise<Date | null> {
  const { source, best } = p;
  const storedMatches = sql`${devices.possibleReplacementOfDeviceId} IS NOT DISTINCT FROM ${source.storedTargetId}::uuid
    AND ${devices.possibleReplacementReason} IS NOT DISTINCT FROM ${source.storedReason}::text`;
  const boundToReadInstall = and(eq(devices.installIncarnation, source.installIncarnation), storedMatches);
  const [locked] = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.id, source.id), eq(devices.agentId, source.agentId), boundToReadInstall))
    .for('update');
  if (!locked) return null;
  const detectedAt = new Date();
  const updated = await updateOwnDeviceRow(
    db,
    { deviceId: source.id, agentId: source.agentId },
    {
      possibleReplacementOfDeviceId: best.target.id,
      possibleReplacementReason: best.reason,
      possibleReplacementDetectedAt: detectedAt,
      updatedAt: detectedAt,
    },
    { where: boundToReadInstall },
  );
  return updated.length === 1 ? detectedAt : null;
}

async function notify(s: ReinstallSuspicion): Promise<void> {
  const report = (what: string) => (err: unknown) => {
    console.error(`[reinstallCandidates] ${what} failed for target ${s.target.id}:`, err instanceof Error ? err.message : err);
    captureException(err);
  };
  await Promise.all([
    publishReinstallSuspectedEvent(s).catch(report('device.reinstall_suspected event')),
    withSystemDbAccessContext(() => raiseReinstallSuspectedAlert(s)).catch(report('reinstall-suspected alert')),
    writeReinstallSuspectedAudit(s).catch(report('device.reinstall_suspected audit')),
  ]);
}

/**
 * Search, flag and notify. Call with no DB context held (after the caller's
 * transaction committed: enrollment calls it after its context resolved, the
 * hardware report through runAfterDbContextCommit). Never throws.
 */
export async function detectReinstallCandidates(
  input: DetectReinstallCandidatesInput,
): Promise<DetectReinstallCandidatesResult> {
  try {
    const planned = await withSystemDbAccessContext(() => plan(input.sourceDeviceId), 'reinstall-candidates:read');
    if ('skip' in planned) return { written: false, why: planned.skip };

    const detectedAt = await withSystemDbAccessContext(() => writeFlag(planned), 'reinstall-candidates:write');
    if (!detectedAt) return { written: false, why: 'source_changed' };

    const { source, best, kind } = planned;
    await notify({
      source: {
        id: source.id,
        orgId: source.orgId,
        hostname: source.hostname,
        parked: isUnassignedPoolOrgType(source.orgType),
      },
      target: { id: best.target.id, orgId: best.target.orgId, siteId: best.target.siteId, hostname: best.target.hostname },
      reason: best.reason,
      evidence: best.evidence,
      detectedAt,
      kind,
      trigger: input.trigger,
    });
    return { written: true, kind, targetDeviceId: best.target.id, reason: best.reason };
  } catch (err) {
    console.error(
      `[reinstallCandidates] detection failed for source ${input.sourceDeviceId} (${input.trigger}):`,
      err instanceof Error ? err.message : err,
    );
    captureException(err);
    return { written: false, why: 'error' };
  }
}

export { normalizeSystemUuid, systemUuidMatchForms, byteSwapSystemUuid } from './systemUuid';
export { shouldDetectAfterHardwareReport } from './ranking';
