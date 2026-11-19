/**
 * Retired arguments a STORED action intent may still carry at release (#11861).
 *
 * Tool input now refuses any key the tool does not define. Before that change
 * the AI time-entry lane (`services/aiTimeEntryProposal.ts`) minted its
 * `manage_tickets` `log_time_entry` proposals with two keys the tool never
 * defined and no handler read: `durationMinutes` (the duration is the
 * startedAt/endedAt block) and `proposedForUserId` (the technician, traceable
 * through the requesting run and its consumed draft). The lane no longer
 * mints them, but a proposal created before the deploy and still awaiting
 * approval carries them, and refusing it would fail a time entry a human has
 * already approved.
 *
 * So the release worker strips exactly those two keys, and only from a stored
 * intent minted by that lane. Every other key, tool and caller stays strict:
 * this is not applied in `validateToolInput` and never to a live model call.
 *
 * DELETE this module (and its call in intentReleaseWorker.ts) once no
 * pre-#11861 AI time-entry proposal remains pending or approved:
 *   SELECT count(*) FROM action_intents
 *    WHERE action_name = 'manage_tickets' AND idempotency_key LIKE 'ai-time-entry:%'
 *      AND status IN ('pending_approval', 'approved')
 *      AND (arguments ? 'durationMinutes' OR arguments ? 'proposedForUserId');
 */

/** The lane's idempotency key prefix: `ai-time-entry:<runId>:<trigger>` (aiTimeEntryProposal.ts). */
const AI_TIME_ENTRY_IDEMPOTENCY_PREFIX = 'ai-time-entry:';

/** The two keys the AI time-entry lane minted before #11861. Nothing else. */
const LEGACY_AI_TIME_ENTRY_KEYS: readonly string[] = ['durationMinutes', 'proposedForUserId'];

interface StoredIntentArgs {
  actionName: string;
  source: string;
  idempotencyKey: string;
  arguments: Record<string, unknown>;
}

/**
 * The arguments to execute a stored intent with. The stored object itself is
 * returned unless the intent is a pre-#11861 AI time-entry proposal carrying
 * one of the two retired keys, in which case a copy without them is returned.
 */
export function releaseArgumentsForStoredIntent(intent: StoredIntentArgs): Record<string, unknown> {
  const args = intent.arguments;
  if (
    intent.actionName !== 'manage_tickets'
    || intent.source !== 'ai_agent'
    || !intent.idempotencyKey.startsWith(AI_TIME_ENTRY_IDEMPOTENCY_PREFIX)
    || args?.action !== 'log_time_entry'
    || !LEGACY_AI_TIME_ENTRY_KEYS.some((k) => Object.hasOwn(args, k))
  ) {
    return args;
  }
  const stripped = { ...args };
  for (const k of LEGACY_AI_TIME_ENTRY_KEYS) delete stripped[k];
  return stripped;
}
