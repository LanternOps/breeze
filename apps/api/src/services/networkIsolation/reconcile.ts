import { and, eq, sql } from 'drizzle-orm';
import {
  ISOLATION_RELEASE_JOURNAL_TYPES, agentAcceptsPolicyAllow, failureCodeFromJournalType, isUnresolvedTerminalIsolationState, networkIsolationReportSchema,
  type ContainmentDesiredBlock, type IsolationAllowEntry, type NetworkIsolationReport, type IsolationFailureCode, type SafeAgentReport,
} from '@breeze/shared';
import { deviceNetworkIsolations, incidents, type DeviceNetworkIsolation } from '../../db/schema';
import { captureException } from '../sentry';
import { decryptSecret } from '../secretCrypto';
import { columnAad } from '../encryptedColumnTransform';
import { buildIsolationAllowlist, IsolationAllowlistError } from './allowlist';
import { findHeartbeatEpisode, toEpisodeSnapshot, withEpisodeLock, writeEpisodeSnapshot, writeAgentReport, writePolicyEventProgress, type EpisodeTx } from './episodeStore';
import { applyEpisodeEvent, type EpisodeEvent } from './stateMachine';
import { synchronizeEpisodeOutcome } from './outcome';
import { auditRefusedPolicyGroups, hasUnreadPolicyEvents, readIsolationPolicy, readPolicyEvents, type IsolationPolicy } from './policy';

interface IsolationDevice { id: string; orgId: string; agentServerUrl?: string | null; networkIsolationVersion?: number | null }
export const ISOLATION_SECRET_COLUMN = {
  table: 'device_network_isolations', column: 'break_glass_secret_enc', kind: 'text', aadBinding: 'row', description: 'Per-episode offline release secret',
} as const;

/** Per-beat lookup cache, shared by reconciliation and response construction. */
export interface HeartbeatEpisodeContext { row?: DeviceNetworkIsolation | null }
const faults = new Map<string, number>();
/** A refused group stays refused for days; once per process per few hours keeps it on record without flooding. */
const REFUSED_GROUP_AUDIT_WINDOW_MS = 6 * 3_600_000;
function throttled(key: string, emit: () => void, windowMs = 60_000): void {
  const now = Date.now();
  if (now - (faults.get(key) ?? -Infinity) < windowMs) return;
  if (faults.size >= 10_000) faults.delete(faults.keys().next().value!);
  faults.set(key, now);
  emit();
}
export function __resetIsolationLogThrottleForTests(): void { faults.clear(); }

/** Report validation failures without copying attacker-controlled values to logs or Sentry. */
export function noteIsolationReportDropped(deviceId: string, raw: unknown): void {
  if (raw === undefined) return;
  const parsed = networkIsolationReportSchema.safeParse(raw);
  if (parsed.success) return;
  const paths: string[] = [];
  const visit = (issues: readonly { path: PropertyKey[]; errors?: unknown }[]) => {
    for (const issue of issues) {
      if (Array.isArray(issue.errors)) {
        for (const branch of issue.errors) if (Array.isArray(branch)) visit(branch);
      } else paths.push(issue.path.map(String).join('.'));
    }
  };
  visit(parsed.error.issues);
  throttled(`report:${deviceId}`, () => {
    console.warn('[isolation] report dropped', { deviceId, paths });
    captureException(new Error('isolation report validation failed'), undefined, { phase: 'isolation_report_dropped', deviceId, paths: paths.join(',') });
  });
}

/**
 * Stored management-plane permits provide a response even when a current read or decrypt fails. They
 * go out under the revision the snapshot was built with, because the agent rejects `scope:"any"`
 * entries without one. An agent that cannot take them gets the rest, which is a narrowing it applies.
 */
export function storedContainmentHeartbeatBlock(row?: DeviceNetworkIsolation | null, device?: Pick<IsolationDevice, 'networkIsolationVersion'> | null): ContainmentDesiredBlock {
  if (!row || (row.desiredState === 'released' && row.releaseConfirmedAt)) return { networkIsolation: null };
  const base = { isolationId: row.id, generation: row.generation, expiresAt: row.expiresAt.toISOString(), deadManSeconds: row.deadManSeconds, remoteRelay: row.remoteRelay };
  if (row.desiredState === 'released') return { networkIsolation: { ...base, desired: 'released', allow: [] } };
  const revision = agentAcceptsPolicyAllow(device?.networkIsolationVersion) ? row.allowSnapshotRevision : null;
  const allow = revision ? row.allowSnapshot : row.allowSnapshot.filter(entry => entry.scope !== 'any');
  return { networkIsolation: { ...base, desired: 'isolated', allow, ...(revision && allow.some(entry => entry.scope === 'any') ? { policyRevision: revision } : {}) } };
}
async function heartbeatEpisode(tx: EpisodeTx, deviceId: string, context: HeartbeatEpisodeContext) {
  if (context.row === undefined) context.row = await findHeartbeatEpisode(tx, deviceId);
  return context.row;
}

/** Only a delivered copy contains the secret; neither permits nor ciphertext enter telemetry. */
export async function buildContainmentHeartbeatBlock(tx: EpisodeTx, device: IsolationDevice, context: HeartbeatEpisodeContext = {}): Promise<ContainmentDesiredBlock> {
  const row = await heartbeatEpisode(tx, device.id, context);
  const block = storedContainmentHeartbeatBlock(row, device);
  const desired = block.networkIsolation;
  if (!row || !desired || desired.desired === 'released') return block;
  let policy: IsolationPolicy;
  try {
    policy = await readIsolationPolicy(device);
  } catch (err) {
    // No new answer, so the held one stands: a read fault must not look like a policy removal.
    policy = { extras: desired.allow.filter(entry => entry.scope === 'any'), revision: desired.policyRevision ?? null, refusedGroups: [], invalidStoredSettings: false };
    throttled(`policy:${row.id}`, () => {
      console.error('[isolation] policy unavailable', { deviceId: device.id, isolationId: row.id });
      captureException(err, undefined, { phase: 'isolation_policy_unavailable', deviceId: device.id, isolationId: row.id });
    });
  }
  if (policy.refusedGroups.length > 0) throttled(`refused:${row.id}`, () => auditRefusedPolicyGroups(device.orgId, policy), REFUSED_GROUP_AUDIT_WINDOW_MS);
  try {
    desired.allow = buildIsolationAllowlist({ serverUrl: device.agentServerUrl ?? process.env.AGENT_SERVER_URL ?? '', remoteRelay: row.remoteRelay, policyExtras: policy.extras });
    if (policy.revision) desired.policyRevision = policy.revision;
    else delete desired.policyRevision;
  } catch (err) {
    throttled(`allow:${row.id}`, () => {
      const source = err instanceof IsolationAllowlistError ? 'configuration' : 'builder';
      console.error('[isolation] allowlist fallback', { deviceId: device.id, isolationId: row.id, source });
      captureException(err, undefined, { phase: 'isolation_allowlist_fallback', source });
    });
    return withBreakGlassSecret(block, row, device);
  }
  // Outside both try blocks on purpose: a failed write has aborted this savepoint, so it must reach
  // the caller, which answers from the stored block and rolls all of it back.
  if (row.allowSnapshotRevision === policy.revision) return withBreakGlassSecret(block, row, device);
  // Build from the row read under the lock, whole: an extend may have won it, and an expiry older than
  // its generation would stick on the agent, which treats an equal generation as already applied. Not
  // written to `context`: this is uncommitted until the caller's savepoint releases, and the caller's
  // fallback must not send a generation that rolled back.
  const current = await recordPolicyChange(tx, row.id, desired.allow, policy, new Date());
  return withBreakGlassSecret(storedContainmentHeartbeatBlock(current, device), current, device);
}

/**
 * Bump the generation in the same statement that records the permits it delivers: at a generation it
 * has already adopted, the agent refuses a different revision or added permits, and would keep the old
 * rules. Only a removal would pass without a new generation; every change takes one, for one rule.
 * Re-reads under the row lock, because a release, an extend or another beat may have moved the episode
 * since the unlocked read.
 */
async function recordPolicyChange(tx: EpisodeTx, id: string, allow: IsolationAllowEntry[], policy: IsolationPolicy, at: Date): Promise<DeviceNetworkIsolation> {
  const revision = policy.revision;
  const locked = await withEpisodeLock(tx, id, async (row) => {
    if (row.allowSnapshotRevision === revision) return row;
    const prev = toEpisodeSnapshot(row);
    const transition = applyEpisodeEvent(prev, { type: 'policy_changed', generation: row.generation, at });
    if ('ignored' in transition) return row;
    if (!await writeEpisodeSnapshot(tx, row.id, prev, transition.next, at, { allowSnapshot: allow, allowSnapshotRevision: revision })) throw new Error('isolation_snapshot_conflict');
    const updated: DeviceNetworkIsolation = { ...row, ...transition.next, allowSnapshot: allow, allowSnapshotRevision: revision };
    await journalIsolationEvent(tx, updated, 'isolation_policy_changed', at, { fromRevision: row.allowSnapshotRevision, toRevision: revision, ...(policy.invalidStoredSettings ? { invalidStoredSettings: true } : {}) });
    return updated;
  });
  if (!locked.found) throw new Error('isolation_episode_vanished');
  return locked.value;
}

function withBreakGlassSecret(block: ContainmentDesiredBlock, row: DeviceNetworkIsolation, device: IsolationDevice): ContainmentDesiredBlock {
  const desired = block.networkIsolation;
  if (desired?.desired !== 'isolated') return block;
  if (row.breakGlassAckSeq === null && row.breakGlassSecretEnc) {
    try {
      const secret = decryptSecret(row.breakGlassSecretEnc, { aad: columnAad(ISOLATION_SECRET_COLUMN, row.id), strict: true });
      if (!secret) throw new Error('isolation_secret_unavailable');
      desired.breakGlassSecret = secret;
    } catch (err) {
      throttled(`secret:${row.id}`, () => {
        console.error('[isolation] heartbeat secret unavailable', { deviceId: device.id, isolationId: row.id });
        captureException(err, undefined, { phase: 'isolation_heartbeat_block', deviceId: device.id, isolationId: row.id });
      });
    }
  }
  return block;
}

/** Append bounded, structured journal metadata; never copy agent prose or arbitrary JSON. */
export async function journalIsolationEvent(tx: Pick<EpisodeTx, 'update'>, row: DeviceNetworkIsolation, type: string, at: Date, metadata: Record<string, unknown> = {}): Promise<void> {
  if (!row.incidentId) return;
  const entry = { at: at.toISOString(), type, actor: 'system', summary: type, metadata: { isolationId: row.id, generation: row.generation, ...metadata } };
  await tx.update(incidents).set({ timeline: sql`coalesce(${incidents.timeline}, '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb`, updatedAt: at })
    .where(and(eq(incidents.id, row.incidentId), eq(incidents.orgId, row.orgId)));
}

/** Shared translation for heartbeat and command results. Ordering is enforced by the state machine. */
export function reportEpisodeEvent(row: DeviceNetworkIsolation, report: NetworkIsolationReport, at: Date, errorCode?: IsolationFailureCode): EpisodeEvent {
  if (!report.isolationId) return { type: 'agent_absent', generation: row.generation, journalSeq: report.journalSeq, at };
  const base = { isolationId: report.isolationId, generation: report.generation, journalSeq: report.journalSeq, at };
  // W1d journals closed codes in event types; lastError is diagnostic prose, never a classifier.
  const events = (report.events ?? []).filter(event => event.seq <= report.journalSeq
    && (!event.isolationId || event.isolationId === row.id)
    && (event.generation === undefined || event.generation === report.generation)).sort((a, b) => b.seq - a.seq);
  const reportedFailure = events.map(event => failureCodeFromJournalType(event.type)).find(code => code !== undefined);
  const releaseType = events.find(event => Object.hasOwn(ISOLATION_RELEASE_JOURNAL_TYPES, event.type))?.type;
  const release = releaseType ? ISOLATION_RELEASE_JOURNAL_TYPES[releaseType as keyof typeof ISOLATION_RELEASE_JOURNAL_TYPES] : undefined;

  switch (report.state) {
    case 'applying': return { ...base, type: 'agent_ack' };
    case 'applied': return { ...base, type: 'agent_applied' };
    case 'verified': return { ...base, type: 'agent_verified' };
    case 'released':
      if (row.desiredState === 'released') return { ...base, type: 'agent_absent' };
      if (release === 'dead_man') return { ...base, type: 'agent_self_released' };
      return { ...base, type: 'agent_released_locally', kind: release === 'local_code' ? 'local_code' : 'local_forced' };
    case 'expired': return { ...base, type: 'agent_expired' };
    case 'self_released': return { ...base, type: 'agent_self_released' };
    case 'released_locally': return { ...base, type: 'agent_released_locally', kind: release === 'local_code' ? 'local_code' : 'local_forced' };
    case 'failed': return { ...base, type: 'agent_failed', code: errorCode ?? reportedFailure ?? 'apply_error' };
  }
}

function safeAgentReport(report: NetworkIsolationReport): SafeAgentReport {
  return report.isolationId ? {
    isolationId: report.isolationId, generation: report.generation, journalSeq: report.journalSeq,
    state: report.state, phase: report.phase, mechanism: report.mechanism ?? null, ruleDigest: report.ruleDigest ?? null,
  } : { isolationId: null, phase: 'none' };
}

export async function reconcileContainmentReport(tx: EpisodeTx, device: IsolationDevice, raw: unknown, serverNow: Date, context: HeartbeatEpisodeContext = {}): Promise<void> {
  const candidate = await heartbeatEpisode(tx, device.id, context);
  if (raw === undefined) return;
  const parsed = networkIsolationReportSchema.safeParse(raw);
  if (!parsed.success) { noteIsolationReportDropped(device.id, raw); return; }
  const report = parsed.data;
  if (!candidate) return;
  const id = report.isolationId ?? candidate.id;
  // A device can only report the episode selected for this heartbeat.
  if (id !== candidate.id) return;
  const ack = report.secretAckSeq !== undefined && report.secretAckSeq > 0 && report.journalSeq !== undefined && report.secretAckSeq <= report.journalSeq ? report.secretAckSeq : undefined;
  const safeReport = safeAgentReport(report);
  const sameState = report.isolationId && candidate.lastAgentReport?.isolationId && report.state === candidate.lastAgentReport.state;
  // A command result can advance the sequence past events only a heartbeat carries.
  if (report.isolationId && report.journalSeq <= candidate.lastJournalSeq && sameState && !hasUnreadPolicyEvents(candidate, report)) {
    // Held generation is evidence even on a duplicate sequence (break-glass code generation).
    await writeAgentReport(tx, id, safeReport, ack);
    context.row = { ...candidate, lastAgentReport: safeReport, ...(ack !== undefined && candidate.breakGlassAckSeq === null ? { breakGlassAckSeq: ack } : {}) };
    return;
  }
  await withEpisodeLock(tx, id, async (row) => {
    if (row.deviceId !== device.id || row.orgId !== device.orgId) return;
    const prev = toEpisodeSnapshot(row);
    const transition = applyEpisodeEvent(prev, reportEpisodeEvent(row, report, serverNow));
    // Before the outcome: a rejection arrives on exactly the reports the state machine ignores, from an
    // agent still holding the older generation it refused to leave.
    const policyEvents = readPolicyEvents(row, report);
    const policyPatch = policyEvents ? {
      policyEventSeq: policyEvents.policyEventSeq,
      ...(policyEvents.appliedPolicyRevision !== undefined ? { appliedPolicyRevision: policyEvents.appliedPolicyRevision } : {}),
    } : {};
    if (policyEvents) {
      await writePolicyEventProgress(tx, row.id, policyEvents);
      for (const entry of policyEvents.timeline) await journalIsolationEvent(tx, row, entry.type, serverNow, entry.metadata);
    }
    const previousReport = row.lastAgentReport;
    const newEvidence = report.isolationId && (!previousReport?.isolationId || report.journalSeq !== previousReport.journalSeq || report.generation !== previousReport.generation || report.state !== previousReport.state);
    if ('ignored' in transition) {
      if (transition.ignored !== 'already_terminal' && newEvidence) await journalIsolationEvent(tx, row, 'isolation_report_ignored', serverNow, { reason: transition.ignored, reportedGeneration: report.isolationId ? report.generation : null, journalSeq: report.journalSeq });
      await writeAgentReport(tx, row.id, safeReport, ack);
      context.row = { ...row, ...policyPatch, lastAgentReport: safeReport, ...(ack !== undefined && row.breakGlassAckSeq === null ? { breakGlassAckSeq: ack } : {}) };
      return;
    }
    if (!await writeEpisodeSnapshot(tx, row.id, prev, transition.next, serverNow)) throw new Error('isolation_snapshot_conflict');
    await synchronizeEpisodeOutcome(tx, row, prev, transition.next, serverNow);
    if (report.isolationId && report.ruleDigest && previousReport?.isolationId && previousReport.ruleDigest && report.ruleDigest !== previousReport.ruleDigest && !policyEvents?.committed) await journalIsolationEvent(tx, row, 'drift_reapplied', serverNow);
    await writeAgentReport(tx, row.id, safeReport, ack);
    if (prev.state !== transition.next.state && isUnresolvedTerminalIsolationState(transition.next.state)) await journalIsolationEvent(tx, row, transition.next.state, serverNow);
    context.row = { ...row, ...transition.next, ...policyPatch, lastAgentReport: safeReport, ...(ack !== undefined && row.breakGlassAckSeq === null ? { breakGlassAckSeq: ack } : {}) };
  });
}
