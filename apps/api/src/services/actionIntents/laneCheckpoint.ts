import type { ScriptReviewerEvidence } from '@breeze/shared';
import type { ActionIntent } from '../../db/schema/actionIntents';
import { ensureRestoreCheckpoint, type RestoreCheckpointRefusal } from '../deviceRecovery/restoreCheckpoint';

export type LaneCheckpointOutcome =
  | { ok: true; checkpointRef: string | null }
  | { ok: false; reason: RestoreCheckpointRefusal | 'device_unavailable' | 'evidence_missing' };

/**
 * AI script authoring W04 (#5612), spec §4.6 invariant 11: the recovery
 * prerequisite is a RELEASE precondition, taken immediately before the
 * effect. Shared by the durable release worker and the inline chat release
 * so the two paths cannot disagree on when a rollback point exists.
 *
 * Placed after the digest recompute (so a drifted proposal never costs a
 * checkpoint) and before the dispatch (so nothing mutates the device without
 * a rollback point). A non-lane intent, or a lane intent whose evidence says
 * no checkpoint was required, returns `ok` without touching the device.
 *
 * Feasibility (a Windows device for checkpoint-needing classes) was proved
 * at creation by `evaluateScriptReviewerAutonomy`; this is where the
 * checkpoint is actually created.
 */
export async function ensureLaneCheckpointBeforeRelease(
  intent: Pick<ActionIntent, 'decidedVia' | 'scriptReviewerEvidence' | 'arguments'>,
): Promise<LaneCheckpointOutcome> {
  if (intent.decidedVia !== 'script_reviewer') return { ok: true, checkpointRef: null };
  const evidence = intent.scriptReviewerEvidence as ScriptReviewerEvidence | null;
  // A lane row without evidence is not a shape the grant writes; revalidation
  // already refuses it, and this gate must not be the one that lets it through.
  if (!evidence) return { ok: false, reason: 'evidence_missing' };
  if (!evidence.checkpointRequired) return { ok: true, checkpointRef: null };
  const deviceIds = (intent.arguments as { deviceIds?: unknown } | null)?.deviceIds;
  const deviceId = Array.isArray(deviceIds) && typeof deviceIds[0] === 'string' ? deviceIds[0] : null;
  if (!deviceId) return { ok: false, reason: 'device_unavailable' };
  const checkpoint = await ensureRestoreCheckpoint(deviceId);
  return checkpoint.ok
    ? { ok: true, checkpointRef: checkpoint.checkpointRef }
    : { ok: false, reason: checkpoint.reason };
}
