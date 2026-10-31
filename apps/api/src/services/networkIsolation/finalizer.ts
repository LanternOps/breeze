import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { ISOLATION_FAILURE_CODES, networkIsolationReportSchema } from '@breeze/shared';
import { db } from '../../db';
import { deviceNetworkIsolations } from '../../db/schema';
import type { CommandResultHandler } from '../commandResultHandlers';
import { toEpisodeSnapshot, withEpisodeLock, writeEpisodeSnapshot } from './episodeStore';
import { applyEpisodeEvent } from './stateMachine';
import { journalIsolationEvent, reportEpisodeEvent } from './reconcile';
import { synchronizeEpisodeOutcome } from './outcome';

type ResultArgs = Parameters<CommandResultHandler>[0];
const resultIdentitySchema = z.object({
  isolationId: z.uuid(), generation: z.number().int().min(1), journalSeq: z.number().int().min(0),
  state: z.string(), phase: z.string().optional(), mechanism: z.string().nullish(),
  appliedAt: z.string().datetime({ offset: true }).nullish(), verifiedAt: z.string().datetime({ offset: true }).nullish(),
  rollback: z.boolean().optional(), errorCode: z.string().max(128).regex(/^[a-z0-9_]+$/).optional(),
});

/** Only typed wire codes classify a failure. Agent prose never enters the episode or incident. */
function failureCode(code: unknown): typeof ISOLATION_FAILURE_CODES[number] {
  if (typeof code !== 'string') return 'apply_error';
  const normalized = code.replace(/^isolation_/, '');
  return ISOLATION_FAILURE_CODES.includes(normalized as never) ? normalized as typeof ISOLATION_FAILURE_CODES[number] : 'apply_error';
}

async function finalize(args: ResultArgs, release: boolean): Promise<void> {
  const { command, commandId, stdout, resolvedDeviceId, result } = args;
  // A transport timeout isn't device evidence and cannot subsequently reopen the episode. A failed
  // persistence attempt, in contrast, deliberately remains retryable (#3530).
  const priorResult = command.result as { status?: unknown } | null;
  if (command.status === 'cancelled' || (command.status === 'failed' && priorResult?.status === 'timeout')) return;
  if (!stdout || stdout.length > 8_000 || command.id !== commandId || command.deviceId !== resolvedDeviceId) return;
  let raw: unknown;
  try { raw = JSON.parse(stdout); } catch { return; }
  const parsed = resultIdentitySchema.safeParse(raw);
  if (!parsed.success) return;
  const wire = parsed.data;
  if (result.status !== 'completed' && wire.state !== 'failed') return;
  const payload = command.payload as Record<string, unknown> | null;
  if (!release && payload?.actionType !== 'network_isolation') return;
  const binding = release ? payload : payload?.parameters as Record<string, unknown> | undefined;
  if (!binding || binding.isolationId !== wire.isolationId || binding.generation !== wire.generation) return;
  // Spec §3.3 / W1d result bodies omit the heartbeat-only phase. Accept it when present.
  const phase = wire.phase ?? (wire.state === 'failed' ? 'rolled_back' : wire.state === 'applying' ? 'provisional' : ['applied', 'verified'].includes(wire.state) ? 'committed' : 'released');
  const parsedReport = networkIsolationReportSchema.safeParse({ ...wire, phase, lastVerifiedAt: wire.verifiedAt });
  if (!parsedReport.success) return;
  const report = parsedReport.data;
  const at = new Date();
  await db.transaction(async tx => {
    await withEpisodeLock(tx, wire.isolationId, async row => {
      if (row.deviceId !== resolvedDeviceId || (release ? row.releaseCommandId : row.commandId) !== commandId) return;
      const prev = toEpisodeSnapshot(row);
      const transition = applyEpisodeEvent(prev, reportEpisodeEvent(row, report, at, failureCode(wire.errorCode ?? result.errorCode)));
      if ('ignored' in transition) {
        await journalIsolationEvent(tx, row, 'isolation_result_ignored', at, { reason: transition.ignored, journalSeq: wire.journalSeq, reportedGeneration: wire.generation });
        return;
      }
      if (!await writeEpisodeSnapshot(tx, row.id, prev, transition.next, at)) throw new Error('isolation_snapshot_conflict');
      await synchronizeEpisodeOutcome(tx, row, prev, transition.next, at);
      await tx.update(deviceNetworkIsolations).set({
        mechanism: report.isolationId ? report.mechanism ?? null : null,
        lastAgentReport: { isolationId: wire.isolationId, generation: wire.generation, journalSeq: wire.journalSeq, state: wire.state, phase, mechanism: wire.mechanism ?? null },
      }).where(eq(deviceNetworkIsolations.id, row.id));
    });
  });
}

export async function handleNetworkIsolationResult(args: ResultArgs): Promise<void> { return finalize(args, false); }
export async function handleReleaseContainmentResult(args: ResultArgs): Promise<void> { return finalize(args, true); }
