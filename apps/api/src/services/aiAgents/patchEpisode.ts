// apps/api/src/services/aiAgents/patchEpisode.ts
//
// AI patch agent W02 Task 2
// (docs/superpowers/plans/ai-mcp/2026-09-13-ai-patch-agent-02-actionable-installs.md).
//
// Pure decision logic for whether a "patch episode" — a single missing patch
// on a single device — should be re-proposed as a new action intent on a
// nightly sweep, or suppressed because a recent decision already covers it.
// No DB access here; the caller (Task 2's query helper, `intentQuery.ts`)
// loads the history and this module decides.
//
// ## Why a suppression READ is needed at all
//
// `action_intents_org_idem_uniq` is `UNIQUE (org_id, idempotency_key) WHERE
// status IN ('pending_approval', 'approved', 'executing')` — LIVE statuses
// only. The instant an intent leaves a live status (rejected, expired,
// cancelled, completed, or failed), the unique index stops covering its row
// and the idempotency key is free again: `createActionIntent` would happily
// mint a brand-new intent with the same key on the very next sweep. The
// index alone therefore only prevents a DUPLICATE live intent — it does
// nothing to stop the same problem from being re-proposed every night after
// a human has already said no (or yes-but-it-didn't-take). That's what
// `shouldSuppressPatchEpisode` is for: it reads the intent's decision
// history and applies a cooldown per terminal status, on top of (not instead
// of) the live-status check the unique index already guarantees.
import type { ActionIntentStatus } from '../../db/schema/actionIntents';

export const PATCH_EPISODE_SUPPRESSION_DAYS = 14;
export const PATCH_EPISODE_COMPLETED_COOLDOWN_DAYS = 7;

/**
 * Literal `patch:<orgId>:<deviceId>:<patchId>` — problem-scoped (OD-4 A),
 * NOT run-scoped like sweep keys (`sweep:<runId>:<index>`). A sweep key is
 * unique per run so the same underlying problem gets a fresh key on every
 * run and the live-status unique index never sees a collision to dedupe
 * against; a patch episode is the opposite — the whole point is that the
 * SAME key recurs across nightly runs so `createActionIntent`'s unique index
 * (while live) and `shouldSuppressPatchEpisode`'s cooldown (once terminal)
 * both have something stable to key off.
 */
export function patchEpisodeIdempotencyKey(orgId: string, deviceId: string, patchId: string): string {
  return `patch:${orgId}:${deviceId}:${patchId}`;
}

export type PatchEpisodeSuppressionReason =
  | 'live_intent_exists'
  | 'recently_rejected'
  | 'recently_cancelled'
  | 'recently_completed';

export type PatchEpisodeSuppression =
  | { suppress: false }
  | { suppress: true; reason: PatchEpisodeSuppressionReason };

export interface PatchEpisodeHistoryEntry {
  status: ActionIntentStatus;
  createdAt: Date;
  decidedAt: Date | null;
}

const LIVE_STATUSES: ReadonlySet<ActionIntentStatus> = new Set([
  'pending_approval',
  'approved',
  'executing',
]);

function daysBetween(earlier: Date, later: Date): number {
  return (later.getTime() - earlier.getTime()) / (24 * 60 * 60 * 1000);
}

/**
 * Decides whether a new patch episode intent should be suppressed given the
 * episode's full decision history (any order — sorted here by `createdAt`
 * DESC so the most recent entry decides among terminal outcomes).
 *
 * Rule order:
 *  1. ANY live entry (`pending_approval`/`approved`/`executing`) suppresses
 *     unconditionally — there is already something for a human to act on or
 *     that is actively running; proposing a duplicate would just confuse the
 *     approval queue (the DB unique index would refuse it anyway, but this
 *     read is what stops us from even trying, and covers the read-only
 *     preview paths that never call `createActionIntent`).
 *  2. Otherwise, only the MOST RECENT entry's decision matters — older
 *     terminal entries are superseded history, not additional reasons to
 *     suppress or not. Its decision time is `decidedAt ?? createdAt` (not
 *     every terminal path stamps `decidedAt`; see `alertVerdicts.ts` /
 *     `sweepFindings.ts` siblings for the same fallback convention).
 *     - `rejected` within 14 days → suppressed (`recently_rejected`); a human
 *       explicitly said no, so don't nag them again tomorrow. At/after 14
 *       days it is NOT suppressed — decisions age out; if the patch is still
 *       missing two weeks later it is worth asking again (a rejection is not
 *       a permanent policy the way "recently_completed" implicitly assumes
 *       success was final).
 *     - `cancelled` within 14 days → suppressed (`recently_cancelled`); same
 *       cooldown as rejection — a human (or an automated cancellation path)
 *       chose not to proceed, so treat it the same as an explicit no rather
 *       than inventing a separate policy for it.
 *     - `completed` within 7 days → suppressed (`recently_completed`). A
 *       shorter window than rejection/cancellation on purpose: an install
 *       that reports "completed" but the patch is STILL missing on the next
 *       sweep is a genuine anomaly worth re-flagging (the install silently
 *       failed to take, a reboot was needed and never happened, etc.) — but
 *       not on the very next nightly run, which would just be racing normal
 *       propagation/reboot delay. Seven days gives that time to resolve
 *       itself before treating it as a new problem.
 *     - `expired` → NEVER suppressed. Expiry means nobody made a decision —
 *       the approval card simply aged out unattended. Suppressing here would
 *       silently drop a real, never-adjudicated problem off the radar
 *       indefinitely just because the UI happened to let the card go stale.
 *     - `failed` → NEVER suppressed. A failed install attempt must be
 *       re-proposable on the very next sweep — W03 turns repeated failures
 *       into an escalation ("chase"), which requires the episode to keep
 *       resurfacing rather than going quiet after one failed try.
 *  3. Empty history → not suppressed (nothing has ever been proposed for
 *     this episode).
 */
export function shouldSuppressPatchEpisode(
  history: PatchEpisodeHistoryEntry[],
  now: Date,
): PatchEpisodeSuppression {
  if (history.some((entry) => LIVE_STATUSES.has(entry.status))) {
    return { suppress: true, reason: 'live_intent_exists' };
  }

  if (history.length === 0) {
    return { suppress: false };
  }

  const mostRecent = history.reduce((latest, entry) =>
    (entry.createdAt.getTime() > latest.createdAt.getTime() ? entry : latest));
  const decisionTime = mostRecent.decidedAt ?? mostRecent.createdAt;
  const ageDays = daysBetween(decisionTime, now);

  switch (mostRecent.status) {
    case 'rejected':
      return ageDays < PATCH_EPISODE_SUPPRESSION_DAYS
        ? { suppress: true, reason: 'recently_rejected' }
        : { suppress: false };
    case 'cancelled':
      return ageDays < PATCH_EPISODE_SUPPRESSION_DAYS
        ? { suppress: true, reason: 'recently_cancelled' }
        : { suppress: false };
    case 'completed':
      return ageDays < PATCH_EPISODE_COMPLETED_COOLDOWN_DAYS
        ? { suppress: true, reason: 'recently_completed' }
        : { suppress: false };
    case 'expired':
    case 'failed':
      return { suppress: false };
    // Live statuses are already handled above; a defensive default keeps
    // this function total if the union ever grows.
    default:
      return { suppress: false };
  }
}
