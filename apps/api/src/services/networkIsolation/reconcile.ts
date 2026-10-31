import { and, eq, sql } from 'drizzle-orm';
import {
  ISOLATION_FAILURE_CODES, isResolvedTerminalIsolationState, networkIsolationReportSchema,
  type ContainmentDesiredBlock, type NetworkIsolationReport, type IsolationFailureCode,
} from '@breeze/shared';
import { deviceNetworkIsolations, incidents, type DeviceNetworkIsolation } from '../../db/schema';
import { decryptSecret } from '../secretCrypto';
import { columnAad } from '../encryptedColumnTransform';
import { buildIsolationAllowlist, IsolationAllowlistError } from './allowlist';
import { findUnconfirmedTombstone, findUnresolvedEpisode, toEpisodeSnapshot, withEpisodeLock, writeEpisodeSnapshot, type EpisodeTx } from './episodeStore';
import { applyEpisodeEvent, type EpisodeEvent } from './stateMachine';
import { synchronizeEpisodeOutcome } from './outcome';

interface IsolationDevice { id: string; orgId: string; agentServerUrl?: string | null }
export const ISOLATION_SECRET_COLUMN = {
  table: 'device_network_isolations', column: 'break_glass_secret_enc', kind: 'text', aadBinding: 'row', description: 'Per-episode offline release secret',
} as const;

/** Only a delivered copy contains the secret; neither permits nor ciphertext enter telemetry. */
export async function buildContainmentHeartbeatBlock(tx: EpisodeTx, device: IsolationDevice): Promise<ContainmentDesiredBlock> {
  // Old, unconfirmed tombstones win over a new request: prove absence before applying anything else.
  const row = await findUnconfirmedTombstone(tx, device.id) ?? await findUnresolvedEpisode(tx, device.id);
  if (!row || (row.desiredState === 'released' && row.releaseConfirmedAt)) return { networkIsolation: null };
  const base = { isolationId: row.id, generation: row.generation, expiresAt: row.expiresAt.toISOString(), deadManSeconds: row.deadManSeconds, remoteRelay: row.remoteRelay };
  if (row.desiredState === 'released') return { networkIsolation: { ...base, desired: 'released', allow: [] } };
  let allow = row.allowSnapshot;
  try {
    allow = buildIsolationAllowlist({ serverUrl: device.agentServerUrl ?? process.env.AGENT_SERVER_URL ?? '', remoteRelay: row.remoteRelay });
  } catch (err) {
    if (!(err instanceof IsolationAllowlistError)) throw err;
    // Configuration changed since start. Keep the last known management-plane permits.
  }
  const secret = row.breakGlassAckSeq === null && row.breakGlassSecretEnc
    ? decryptSecret(row.breakGlassSecretEnc, { aad: columnAad(ISOLATION_SECRET_COLUMN, row.id), strict: true }) : null;
  if (row.breakGlassAckSeq === null && row.breakGlassSecretEnc && !secret) throw new Error('isolation_secret_unavailable');
  return { networkIsolation: {
    ...base, desired: 'isolated', allow,
    ...(secret ? { breakGlassSecret: secret } : {}),
  } };
}

/** Append bounded, structured journal metadata; never copy agent prose or arbitrary JSON. */
export async function journalIsolationEvent(tx: EpisodeTx, row: DeviceNetworkIsolation, type: string, at: Date, metadata: Record<string, unknown> = {}): Promise<void> {
  if (!row.incidentId) return;
  const entry = { at: at.toISOString(), type, actor: 'system', summary: type, metadata: { isolationId: row.id, generation: row.generation, ...metadata } };
  await tx.update(incidents).set({ timeline: sql`coalesce(${incidents.timeline}, '[]'::jsonb) || ${JSON.stringify([entry])}::jsonb`, updatedAt: at })
    .where(and(eq(incidents.id, row.incidentId), eq(incidents.orgId, row.orgId)));
}

/** Shared translation for heartbeat and command results. Ordering is enforced by the state machine. */
export function reportEpisodeEvent(row: DeviceNetworkIsolation, report: NetworkIsolationReport, at: Date, errorCode?: IsolationFailureCode): EpisodeEvent {
  if (!report.isolationId) return { type: 'agent_absent', generation: row.generation, journalSeq: report.journalSeq, at };
  const base = { generation: report.generation, journalSeq: report.journalSeq, at };
  // W1d journals closed codes in event types; lastError is diagnostic prose, never a classifier.
  const events = (report.events ?? []).filter(event => event.seq <= report.journalSeq
    && (!event.isolationId || event.isolationId === row.id)
    && (event.generation === undefined || event.generation === report.generation)).sort((a, b) => b.seq - a.seq);
  const failed = events.find(event => ISOLATION_FAILURE_CODES.some(code => event.type === `failed_${code}`));
  const reportedFailure = failed?.type.slice('failed_'.length) as IsolationFailureCode | undefined;
  const release = events.find(event => ['released_dead_man', 'released_local_code', 'released_local_forced'].includes(event.type))?.type;

  switch (report.state) {
    case 'applying': return { ...base, type: 'agent_ack' };
    case 'applied': return { ...base, type: 'agent_applied' };
    case 'verified': return { ...base, type: 'agent_verified' };
    case 'released':
      if (row.desiredState === 'released') return { ...base, type: 'agent_absent' };
      if (release === 'released_dead_man') return { ...base, type: 'agent_self_released' };
      return { ...base, type: 'agent_released_locally', kind: release === 'released_local_code' ? 'local_code' : 'local_forced' };
    case 'expired': return { ...base, type: 'agent_expired' };
    case 'self_released': return { ...base, type: 'agent_self_released' };
    case 'released_locally': return { ...base, type: 'agent_released_locally', kind: release === 'released_local_code' ? 'local_code' : 'local_forced' };
    case 'failed': return { ...base, type: 'agent_failed', code: errorCode ?? reportedFailure ?? 'apply_error' };
  }
}

export async function reconcileContainmentReport(tx: EpisodeTx, device: IsolationDevice, raw: unknown, serverNow: Date): Promise<void> {
  if (raw === undefined) return;
  const parsed = networkIsolationReportSchema.safeParse(raw);
  if (!parsed.success) return; // Tolerant informational field; never log the raw body.
  const report = parsed.data;
  const id = report.isolationId ?? (await findUnconfirmedTombstone(tx, device.id))?.id ?? (await findUnresolvedEpisode(tx, device.id))?.id;
  if (!id) return;
  await withEpisodeLock(tx, id, async (row) => {
    if (row.deviceId !== device.id || row.orgId !== device.orgId) return;
    const prev = toEpisodeSnapshot(row);
    // Bare absence has no generation: it confirms a tombstone, but cannot cancel an isolate
    // the agent has not received yet. A local release must name the issued generation.
    const event = reportEpisodeEvent(row, report, serverNow);
    const transition = applyEpisodeEvent(prev, event);
    if ('ignored' in transition) {
      await journalIsolationEvent(tx, row, 'isolation_report_ignored', serverNow, { reason: transition.ignored, reportedGeneration: report.isolationId ? report.generation : null, journalSeq: report.journalSeq });
      return;
    }
    if (!await writeEpisodeSnapshot(tx, row.id, prev, transition.next, serverNow)) throw new Error('isolation_snapshot_conflict');
    await synchronizeEpisodeOutcome(tx, row, prev, transition.next, serverNow);
    // Deliberate whitelist: no secret, resolved addresses, agent prose, or journal detail is stored.
    const safeReport = report.isolationId ? {
      isolationId: report.isolationId, generation: report.generation, journalSeq: report.journalSeq,
      state: report.state, phase: report.phase, mechanism: report.mechanism ?? null,
      ruleDigest: report.ruleDigest ?? null,
    } : { isolationId: null, phase: 'none' };
    if (report.isolationId && report.ruleDigest && row.lastAgentReport?.ruleDigest && report.ruleDigest !== row.lastAgentReport.ruleDigest) {
      await journalIsolationEvent(tx, row, 'drift_reapplied', serverNow);
    }
    const ack = report.secretAckSeq !== undefined && report.secretAckSeq > 0 && report.journalSeq !== undefined && report.secretAckSeq <= report.journalSeq;
    await tx.update(deviceNetworkIsolations).set({
      lastAgentReport: safeReport,
      ...(report.isolationId ? { mechanism: report.mechanism ?? null } : {}),
      ...(ack && row.breakGlassAckSeq === null ? { breakGlassAckSeq: report.secretAckSeq } : {}),
      ...(isResolvedTerminalIsolationState(transition.next.state) ? { breakGlassSecretEnc: '' } : {}),
    }).where(eq(deviceNetworkIsolations.id, row.id));
    if (prev.state !== transition.next.state && ['released_locally', 'self_released'].includes(transition.next.state)) {
      await journalIsolationEvent(tx, row, transition.next.state, serverNow);
    }
  });
}
