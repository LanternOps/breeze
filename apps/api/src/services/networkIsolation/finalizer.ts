import { z } from 'zod';
import { isIsolationFailureCode, networkIsolationResultSchema, type IsolationFailureCode, type SafeAgentReport } from '@breeze/shared';
import { db } from '../../db';
import type { CommandResultHandler } from '../commandResultHandlers';
import { captureException } from '../sentry';
import { toEpisodeSnapshot, withEpisodeLock, writeAgentReport, writeEpisodeSnapshot } from './episodeStore';
import { applyEpisodeEvent, type EpisodeEvent } from './stateMachine';
import { journalIsolationEvent, reportEpisodeEvent } from './reconcile';
import { synchronizeEpisodeOutcome } from './outcome';

type ResultArgs = Parameters<CommandResultHandler>[0];
type IgnoredReason = 'stdout_missing' | 'stdout_oversize' | 'stdout_not_json' | 'identity_schema' | 'identity_mismatch' | 'episode_mismatch' | 'transport_timeout';
const bindingSchema = z.object({ isolationId: z.uuid(), generation: z.number().int().min(1) });

/** Only typed wire codes classify a failure. Agent prose never enters the episode or incident. */
function typedFailureCode(code: unknown): IsolationFailureCode | undefined {
  const normalized = typeof code === 'string' ? code.replace(/^isolation_/, '') : code;
  return isIsolationFailureCode(normalized) ? normalized : undefined;
}

async function finalize(args: ResultArgs, release: boolean): Promise<void> {
  const { command, commandId, stdout, resolvedDeviceId, result } = args;
  const ignored = (reason: IgnoredReason) => {
    const tags = { commandId, deviceId: command.deviceId, reason };
    console.warn('[isolation] result ignored', tags);
    if (reason === 'identity_mismatch' || reason === 'episode_mismatch') captureException(new Error('isolation_result_identity_mismatch'), undefined, { ...tags, phase: 'isolation_result_ignored' });
  };
  // Transport status is not device evidence and cannot subsequently reopen an episode.
  const priorResult = command.result as { status?: unknown } | null;
  if (command.status === 'cancelled' || (command.status === 'failed' && priorResult?.status === 'timeout')) { ignored('transport_timeout'); return; }
  if (command.id !== commandId || command.deviceId !== resolvedDeviceId) { ignored('identity_mismatch'); return; }
  const payload = command.payload as Record<string, unknown> | null;
  const binding = bindingSchema.safeParse(release ? payload : payload?.parameters);
  if ((!release && payload?.actionType !== 'network_isolation') || !binding.success) { ignored('episode_mismatch'); return; }
  let report: z.infer<typeof networkIsolationResultSchema> | undefined;
  let badStdout: IgnoredReason | undefined;
  if (!stdout) badStdout = 'stdout_missing';
  else if (stdout.length > 8_000) badStdout = 'stdout_oversize';
  else {
    let raw: unknown;
    try { raw = JSON.parse(stdout); } catch { badStdout = 'stdout_not_json'; }
    if (!badStdout) {
      const parsed = networkIsolationResultSchema.safeParse(raw);
      if (!parsed.success) badStdout = 'identity_schema';
      else report = parsed.data;
    }
  }
  const fallbackCode = result.status === 'failed' ? typedFailureCode(result.errorCode) : undefined;
  if (badStdout) {
    ignored(badStdout);
    if (!fallbackCode) return;
  }
  if (report && (binding.data.isolationId !== report.isolationId || binding.data.generation !== report.generation)) { ignored('episode_mismatch'); return; }
  if (report && result.status !== 'completed' && report.state !== 'failed') { ignored('identity_schema'); return; }
  const at = new Date();
  await db.transaction(async tx => {
    const locked = await withEpisodeLock(tx, binding.data.isolationId, async row => {
      if (row.deviceId !== resolvedDeviceId || (release ? row.releaseCommandId : row.commandId) !== commandId) { ignored('episode_mismatch'); return; }
      const prev = toEpisodeSnapshot(row);
      // A typed failure without usable stdout still belongs to the command's bound generation.
      // Reserve the next server high-water mark, never invent or adopt a reported generation.
      const event: EpisodeEvent = report
        ? reportEpisodeEvent(row, report, at, typedFailureCode(report.errorCode) ?? typedFailureCode(result.errorCode))
        : { type: 'agent_failed', isolationId: row.id, generation: binding.data.generation, journalSeq: row.lastJournalSeq + 1, at, code: fallbackCode! };
      const transition = applyEpisodeEvent(prev, event);
      if ('ignored' in transition) {
        await journalIsolationEvent(tx, row, 'isolation_result_ignored', at, { reason: transition.ignored, journalSeq: event.journalSeq, reportedGeneration: event.generation });
        return;
      }
      if (!await writeEpisodeSnapshot(tx, row.id, prev, transition.next, at)) throw new Error('isolation_snapshot_conflict');
      await synchronizeEpisodeOutcome(tx, row, prev, transition.next, at);
      if (report) {
        const safe: SafeAgentReport = { isolationId: report.isolationId, generation: report.generation, journalSeq: report.journalSeq, state: report.state, phase: report.phase, mechanism: report.mechanism ?? null, ruleDigest: report.ruleDigest ?? null };
        const ackSeq = report.secretAckSeq !== undefined && report.secretAckSeq > 0 && report.secretAckSeq <= report.journalSeq ? report.secretAckSeq : undefined;
        await writeAgentReport(tx, row.id, safe, ackSeq);
      }
    });
    if (!locked.found) ignored('episode_mismatch');
  });
}

export async function handleNetworkIsolationResult(args: ResultArgs): Promise<void> { return finalize(args, false); }
export async function handleReleaseContainmentResult(args: ResultArgs): Promise<void> { return finalize(args, true); }
