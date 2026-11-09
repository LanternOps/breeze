/**
 * Wisp check-in timers (#10991 W03 #10994) — the three chat tools over
 * services/wisp/checkIns.ts (W02).
 *
 *   schedule_check_in  (T2)  set a follow-up on this grant's thread, 1 minute
 *                            to 7 days ahead, or on an event with a deadline
 *                            in that window (default 24 h). When it fires the
 *                            grantor is notified and the instruction is put in
 *                            front of the model on their next message
 *                            (consumption wave #10995).
 *   list_check_ins     (T1)  the thread's scheduled and fired-not-consumed rows
 *   cancel_check_in    (T2)  scheduled | fired → cancelled
 *
 * Neither write shows an approval card under per_step: both are in
 * WISP_SELF_STATE_TOOLS (selfStateTools.ts) — schedule only adds a row, cancel
 * only touches this grant's own rows (`cancelCheckIn` is keyed on the grant).
 * Both keep Tier 2, so the executing audit row, the rate limits
 * (aiToolRateLimits.ts) and the ceiling gate still apply.
 *
 * Every tool refuses without `auth.wispGrant` (`wisp_grant_required`): an
 * ordinary chat, an MCP key or an `ai_agent` principal without a stamped grant
 * reads and writes nothing. Exposure is dark too: with `wispEnabled()` off none
 * is declared to chat (`wispCheckInToolDefinitions`) or listed or callable over
 * Breeze's MCP server (`isToolEnvGatedOff`).
 *
 * The thread is always the grant's own (`threadForGrant`); nothing the model
 * passes names a thread, a grant or an org. A `subject` is resolved through
 * `resolveEntityRef` (the caller's authority ∩ the live ceiling) and its org is
 * taken FROM THE OBJECT. Instructions are model-written text derived from tool
 * output, so `list_check_ins` sanitizes each and fences the list.
 *
 * W04 (#11493, #10410): `trigger` schedules an event check-in instead (a device
 * comes online, a script / command finishes, a run settles), with a deadline
 * (default 24 h). Its subject is read by id (checkInTriggers.ts), must be
 * inside the live ceiling with the kind's read permission and inside the
 * caller's own reach, and the row's org is the subject's. Another partner's
 * subject reads as not found.
 *
 * W07 (#11496, #10410): `mode: 'run'` makes Wisp check on its own (read-only,
 * one assessment run under the grant) when the check-in fires, and post the
 * result. It needs an org to assess: the trigger subject's, else the context
 * subject's, else the grant's scope org, else the thread's focus org when the
 * live ceiling holds it (`run_needs_org` otherwise), and that org must be
 * assessable, i.e. reached without a site term (`run_org_not_assessable`).
 * Unlike a notify check-in it keeps its per_step card (selfStateTools.ts).
 *
 * The per-call ceiling gate (tool allowlist, denied tools, permission) is
 * `createSessionPreToolUse`, which runs before any handler; it is not repeated.
 */
import { z } from 'zod';
import {
  cancelCheckInSchema,
  scheduleCheckInSchema,
  WISP_CHECK_IN_DEFAULT_DEADLINE_MINUTES,
  WISP_CHECK_IN_MAX_SCHEDULED_PER_THREAD,
  type WispCheckInContext,
  type WispCheckInTriggerEvent,
} from '@breeze/shared';
import type { AuthContext } from '../../middleware/auth';
import type { WispCheckInRow } from '../../db/schema/wispCheckIns';
import { sanitizeUntrustedToolText, wrapUntrustedData } from '../aiInputSanitizer';
import type { AiTool } from '../aiTools';
import {
  cancelCheckInShape,
  LIST_CHECK_INS_DEFAULT_LIMIT,
  listCheckInsInputSchema,
  listCheckInsShape,
  scheduleCheckInShape,
} from '../aiToolSchemas';
import { captureException } from '../sentry';
import {
  cancelCheckIn,
  CheckInLimitReachedError,
  CheckInWindowError,
  createCheckIn,
  listCheckIns,
  threadForGrant,
} from './checkIns';
import { loadTriggerSubject, triggerSubjectScope, type TriggerSubject } from './checkInTriggers';
import { assessableOrgIds } from './assessableOrgs';
import { isResolveFailure, resolveEntityRef } from './entityRefs';
import { CeilingViolationError, GrantInactiveError, resolveGrantCeiling, type GrantCeiling } from './grantAuthority';

/** The parse schemas, by tool name — the shared validators, never a re-typed copy. */
export const WISP_CHECK_IN_TOOL_SCHEMAS = {
  schedule_check_in: scheduleCheckInSchema,
  list_check_ins: listCheckInsInputSchema,
  cancel_check_in: cancelCheckInSchema,
} as const;

type Handler = (input: Record<string, unknown>, auth: AuthContext) => Promise<string>;

const GRANT_REQUIRED = JSON.stringify({ error: 'wisp_grant_required' });
const THREAD_NOT_FOUND = JSON.stringify({ error: 'thread_not_found' });
const CHECK_IN_NOT_FOUND = JSON.stringify({ error: 'check_in_not_found' });
const SUBJECT_NOT_FOUND = JSON.stringify({ error: 'subject_not_found' });
const SUBJECT_OUTSIDE_GRANT = JSON.stringify({ error: 'subject_outside_grant' });
const RUN_NEEDS_ORG = JSON.stringify({
  error: 'run_needs_org',
  message: 'A run check-in needs one organization to check: give a subject or a trigger in that organization.',
});
const RUN_ORG_NOT_ASSESSABLE = JSON.stringify({
  error: 'run_org_not_assessable',
  message: 'This grant reaches that organization only for some sites, so Wisp cannot check it on its own. Use mode notify.',
});
const FENCE_SOURCE = 'wisp_check_ins';

function inputSchemaFor(shape: z.ZodRawShape): AiTool['definition']['input_schema'] {
  const { $schema: _dropped, ...schema } = z.toJSONSchema(z.object(shape), { io: 'input' }) as Record<string, unknown>;
  return schema as AiTool['definition']['input_schema'];
}

function invalid(error: z.ZodError): string {
  const message = error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
  return JSON.stringify({ error: 'invalid_input', message });
}

/**
 * Typed refusals → model-facing JSON. Anything else is a real failure and
 * propagates to the dispatcher (which sanitizes it) — never swallowed into a
 * success-shaped string.
 */
function mapServiceError(err: unknown): string {
  if (err instanceof CheckInWindowError) {
    return JSON.stringify({ error: 'check_in_window', message: 'The check-in must be due between 1 minute and 7 days from now.' });
  }
  if (err instanceof CheckInLimitReachedError) {
    return JSON.stringify({ error: 'check_in_limit_reached', limit: WISP_CHECK_IN_MAX_SCHEDULED_PER_THREAD });
  }
  if (err instanceof GrantInactiveError) {
    // A corrupt pin is data damage, not a pause: surface it (the routes do the same).
    if (err.kind === 'corrupt') {
      captureException(err, undefined, { grantId: err.grantId, op: 'wisp.check_in_tool' });
      return JSON.stringify({ error: 'grant_corrupt' });
    }
    return JSON.stringify({ error: 'grant_inactive' });
  }
  if (err instanceof CeilingViolationError) return JSON.stringify({ error: 'ceiling_violation', code: err.code });
  throw err;
}

/**
 * Grant check → parse → ceiling → the grant's thread → body. The grant check
 * comes first so a grantless caller learns nothing about input shape and
 * nothing is read. Parse (not just validate): zod strips unknown keys, so
 * nothing the model adds (a grantId, a threadId) reaches the service.
 */
type GrantThread = { id: string; focusOrgId: string | null };

function grantTool<S extends z.ZodType>(
  schema: S,
  body: (input: z.infer<S>, ceiling: GrantCeiling, thread: GrantThread, auth: AuthContext) => Promise<string>,
): Handler {
  return async (input, auth) => {
    const grant = auth.wispGrant;
    if (!grant) return GRANT_REQUIRED;
    const parsed = schema.safeParse(input);
    if (!parsed.success) return invalid(parsed.error);
    try {
      const ceiling = await resolveGrantCeiling(grant.grantId, grant.grantRevisionId);
      const thread = await threadForGrant(ceiling.grantId);
      if (!thread) return THREAD_NOT_FOUND;
      return await body(parsed.data, ceiling, { id: thread.id, focusOrgId: thread.focusOrgId ?? null }, auth);
    } catch (err) {
      return mapServiceError(err);
    }
  };
}

/** One line per check-in; the instruction is model-written text, so it is sanitized and the list rides one fence. */
function renderCheckIns(rows: WispCheckInRow[]): string {
  const lines = rows.map((r) => [
    r.id,
    r.status,
    `due ${r.dueAt.toISOString()}`,
    sanitizeUntrustedToolText(r.instruction.replace(/\s+/g, ' ').trim()),
  ].join(' | '));
  return wrapUntrustedData(FENCE_SOURCE, lines.join('\n'));
}

/**
 * The caller's own reach over a trigger subject's org, on top of the ceiling
 * (resolveEntityRef steps 3 and 5): an org-scoped token reaches only its own
 * org, `canAccessOrg` when the context carries it, and a device-pinned
 * principal only its allowlisted devices (and no other kind).
 */
function callerReaches(auth: AuthContext, subject: TriggerSubject, subjectId: string): boolean {
  if (auth.scope === 'organization' && subject.orgId !== auth.orgId) return false;
  if (typeof auth.canAccessOrg === 'function' && !auth.canAccessOrg(subject.orgId)) return false;
  if (auth.allowedDeviceIds !== undefined && (subject.kind !== 'device_online' || !auth.allowedDeviceIds.includes(subjectId))) return false;
  return true;
}

/** What the scheduling reply says the check-in waits for. */
const TRIGGER_WAITS_FOR: Readonly<Record<WispCheckInTriggerEvent, string>> = Object.freeze({
  device_online: 'the device comes online',
  script_finished: 'the script finishes',
  command_finished: 'the command finishes',
  run_settled: 'the run settles',
});
/** What the scheduling reply says when the event had already happened. */
const TRIGGER_ALREADY: Readonly<Record<WispCheckInTriggerEvent, string>> = Object.freeze({
  device_online: 'The device has already come online',
  script_finished: 'The script has already finished',
  command_finished: 'The command has already finished',
  run_settled: 'The run has already settled',
});

/**
 * The org a run check-in assesses when nothing else named one: the thread's
 * focus org, only while the live ceiling holds it and the caller reaches it.
 */
function focusOrgForRun(thread: GrantThread, ceiling: GrantCeiling, auth: AuthContext): string | null {
  const org = thread.focusOrgId;
  if (org === null || !ceiling.orgIds.has(org)) return null;
  if (auth.scope === 'organization' && org !== auth.orgId) return null;
  if (typeof auth.canAccessOrg === 'function' && !auth.canAccessOrg(org)) return null;
  return org;
}

const scheduleCheckInHandler = grantTool(scheduleCheckInSchema, async (input, ceiling, thread, auth) => {
  const threadId = thread.id;
  const runMode = input.mode === 'run';
  // One clock for the delay, the window check and `created_at` (the DB CHECK
  // bounds due_at by the row's own created_at).
  const now = new Date();
  const dueAt = input.trigger
    ? new Date(now.getTime() + (input.trigger.deadlineMinutes ?? WISP_CHECK_IN_DEFAULT_DEADLINE_MINUTES) * 60_000)
    : input.delayMinutes !== undefined
      ? new Date(now.getTime() + input.delayMinutes * 60_000)
      : new Date(input.at!);

  let orgId = ceiling.scopeOrgId;
  let trigger: { kind: WispCheckInTriggerEvent; subjectId: string } | null = null;
  if (input.trigger) {
    // The subject's org is read FROM THE SUBJECT, and the subject must be
    // inside the live ceiling (org, site, the kind's read permission) and the
    // caller's own reach. Another partner's subject reads as not found.
    const { event, subjectId } = input.trigger;
    const subject = await loadTriggerSubject(event, subjectId);
    const scope = triggerSubjectScope(subject, ceiling);
    if (scope === 'subject_deleted') return SUBJECT_NOT_FOUND;
    if (scope === 'outside_ceiling' || !callerReaches(auth, subject!, subjectId)) return SUBJECT_OUTSIDE_GRANT;
    orgId = subject!.orgId;
    trigger = { kind: event, subjectId };
  }

  let context: WispCheckInContext | null = null;
  if (input.subject) {
    const resolved = await resolveEntityRef({ auth, ceiling }, input.subject);
    if (isResolveFailure(resolved)) return JSON.stringify({ error: 'subject_not_resolvable', reason: resolved.reason });
    // A trigger pins the org to its own subject; a context subject alone decides it otherwise.
    if (!trigger) orgId = resolved.orgId;
    context = { subject: { kind: input.subject.kind, id: input.subject.id } };
  }

  if (runMode) {
    orgId ??= focusOrgForRun(thread, ceiling, auth);
    if (orgId === null) return RUN_NEEDS_ORG;
    // The assessment's digest reads are org-wide (enqueueAssessment refuses a
    // site-restricted org at fire time); refuse it now rather than then.
    if (!assessableOrgIds(ceiling).has(orgId)) return RUN_ORG_NOT_ASSESSABLE;
  }

  const row = await createCheckIn(ceiling, {
    threadId,
    sessionId: auth.wispGrant?.sessionId ?? null,
    dueAt,
    instruction: input.instruction,
    orgId,
    context,
    trigger,
    ...(runMode ? { mode: 'run' as const } : {}),
  }, now);
  if (!trigger) {
    if (runMode) {
      return `Check-in scheduled (ID: ${row.id}) for ${row.dueAt.toISOString()}. When it fires you check on your own (read-only) and Breeze posts the result to this thread.`;
    }
    return `Check-in scheduled (ID: ${row.id}) for ${row.dueAt.toISOString()}. Breeze will notify the user then, and the instruction comes back to you with their next message in this thread.`;
  }
  // The fire-at-scheduling re-check found the subject gone or the grant unusable.
  if (row.status === 'cancelled') return JSON.stringify({ error: 'check_in_cancelled', reason: row.cancelReason });
  if (row.status === 'running') {
    return `${TRIGGER_ALREADY[trigger.kind]}, so check-in ${row.id} started now: you are checking on your own (read-only), and Breeze posts the result to this thread.`;
  }
  if (row.status === 'fired' && runMode) {
    return `${TRIGGER_ALREADY[trigger.kind]}, but check-in ${row.id} could not run on its own: Breeze asked the user whether to run it now.`;
  }
  if (row.status === 'fired') {
    return `${TRIGGER_ALREADY[trigger.kind]}, so check-in ${row.id} fired now: Breeze notified the user, and the instruction comes back to you with their next message in this thread.`;
  }
  if (runMode) {
    return `Check-in scheduled (ID: ${row.id}): it fires when ${TRIGGER_WAITS_FOR[trigger.kind]}, or at ${row.dueAt.toISOString()} if it has not by then. You then check on your own (read-only) and Breeze posts the result to this thread.`;
  }
  return `Check-in scheduled (ID: ${row.id}): it fires when ${TRIGGER_WAITS_FOR[trigger.kind]}, or at ${row.dueAt.toISOString()} if it has not by then. Breeze will notify the user, and the instruction comes back to you with their next message in this thread.`;
});

const listCheckInsHandler = grantTool(listCheckInsInputSchema, async (input, ceiling) => {
  const limit = input.limit ?? LIST_CHECK_INS_DEFAULT_LIMIT;
  // One extra row says whether there are more without a count query.
  const rows = await listCheckIns(ceiling.grantId, { limit: limit + 1 });
  if (rows.length === 0) return 'No check-ins are pending on this thread.';
  const page = rows.slice(0, limit);
  const more = rows.length > limit ? '\n(more pending; raise limit to see them.)' : '';
  return renderCheckIns(page) + more;
});

const cancelCheckInHandler = grantTool(cancelCheckInSchema, async (input, ceiling) => {
  // Keyed on the grant: another grant's id reads the same as an unknown one.
  const row = await cancelCheckIn(ceiling.grantId, input.checkInId);
  if (!row) return CHECK_IN_NOT_FOUND;
  return `Check-in ${row.id} cancelled.`;
});

export function registerWispCheckInTools(aiTools: Map<string, AiTool>): void {
  aiTools.set('schedule_check_in', {
    tier: 2,
    domain: 'ai',
    deviceArgs: [],
    searchHint: 'set a timer to follow up later in this conversation: re-check a device, ticket or job in a few minutes or hours',
    definition: {
      name: 'schedule_check_in',
      description: 'Schedule a check-in on this Wisp thread instead of asking the user to come back later: after a delay, or when a device comes online, a script/command finishes or a run settles (with a deadline). The user is notified and your instruction returns with their next message. Max 5 pending.',
      input_schema: inputSchemaFor(scheduleCheckInShape),
    },
    handler: scheduleCheckInHandler,
  });

  aiTools.set('list_check_ins', {
    tier: 1,
    domain: 'ai',
    deviceArgs: [],
    searchHint: 'the follow-up timers Wisp has set on this thread',
    definition: {
      name: 'list_check_ins',
      description: "List this thread's pending check-ins (scheduled or fired but not yet acted on): id, status, due time and instruction.",
      input_schema: inputSchemaFor(listCheckInsShape),
    },
    handler: listCheckInsHandler,
  });

  aiTools.set('cancel_check_in', {
    tier: 2,
    domain: 'ai',
    deviceArgs: [],
    searchHint: 'cancel a follow-up timer Wisp set on this thread',
    definition: {
      name: 'cancel_check_in',
      description: 'Cancel one check-in on this thread (scheduled, or fired and not yet acted on).',
      input_schema: inputSchemaFor(cancelCheckInShape),
    },
    handler: cancelCheckInHandler,
  });
}
