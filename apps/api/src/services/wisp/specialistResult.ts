/**
 * Wisp delegation W2 (#11085, feature #11083) — a device-troubleshooting
 * specialist reports back into the Wisp thread it was handed off from.
 *
 * Two posts, both a `specialist_result` thread post delivered through
 * `notifyUser` (the one Wisp delivery primitive; no push — the run's steps
 * already pushed their own approval cards):
 *   - `postSpecialistResult(runId)`: the run settled (completed, failed,
 *     waiting for approval, cancelled). Called from `finishRun` (runLoop.ts)
 *     and re-swept by the grant reconciler for any run whose post is missing
 *     (a crash between the status write and the post, a cancel or reaper that
 *     never passes `finishRun`).
 *   - `postSpecialistStepOutcome(intentId)`: one of the run's proposed steps
 *     was approved and released. Called from the intent release worker.
 *
 * Exactly one post per (run, status) and per (intent, status) (Review Focus
 * 5): the dedupe key is the post's `(thread_id, dedupe_key)` unique key, so a
 * finalizer retry, a reconciler re-sweep and a release redelivery all land on
 * the same row. A pre-check skips the delivery when the post already exists.
 *
 * Tenancy: the post carries the run's org (never null) and is refused unless
 * the grant's thread could show that org (`isOrgReadableOnThread`, the
 * timeline's own rule), so an out-of-ceiling run never reaches the thread.
 *
 * Device text (the run summary, a step's result, the hostname) is untrusted.
 * A post is rendered to a person as plain text and is never read back into a
 * prompt (no seed or tool reads wisp_thread_posts), so it is sanitized
 * (`sanitizeUntrustedToolText`: injection spans, dangerous Unicode, forged
 * fences) and capped rather than fenced; the fence is applied where the same
 * text enters a prompt (chatRunBridge drain, the continuation seed).
 *
 * Both functions read under short system contexts of their own and never
 * throw for a run or intent that should not post: they return
 * `{ posted: false, reason }`. A real failure (DB, notifyUser) throws, and
 * the callers report it without failing the run or the release.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { wispEnabled } from '../../config/env';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { actionIntents } from '../../db/schema/actionIntents';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { approvalRequests } from '../../db/schema/approvals';
import { devices } from '../../db/schema/devices';
import { wispGrants } from '../../db/schema/wisp';
import { wispThreadPosts } from '../../db/schema/wispThreadPosts';
import { sanitizeUntrustedToolText } from '../aiInputSanitizer';
import { captureException } from '../sentry';
import { notifyUser, resolveSpecialistPostAudience, SpecialistAudienceRefusedError } from './notifyUser';
import { getOrCreateThread } from './threads';

/** The post body cap, in characters (code points), whatever it carries. */
export const SPECIALIST_RESULT_BODY_MAX_CHARS = 1500;
/** The reconciler looks back this far for a run whose post is missing. */
export const SPECIALIST_RESULT_RESWEEP_WINDOW_MS = 24 * 60 * 60 * 1000;
/** At most this many runs per reconciler tick (newest first). */
export const SPECIALIST_RESULT_RESWEEP_LIMIT = 100;

const PROFILE = 'device_troubleshooting';
const SETTLED_STATUSES = ['completed', 'failed', 'awaiting_approval', 'cancelled'] as const;
type SettledStatus = (typeof SETTLED_STATUSES)[number];
const HOSTNAME_MAX_CHARS = 64;
const LABEL_MAX_CHARS = 200;

export type SpecialistPostSkip =
  | 'wisp_disabled'
  | 'run_not_found'
  | 'intent_not_found'
  | 'not_a_specialist_run'
  | 'not_settled'
  | 'not_terminal'
  | 'no_grant'
  | 'grant_inactive'
  | 'org_out_of_ceiling'
  | 'already_posted';

export type SpecialistPostResult = { posted: true } | { posted: false; reason: SpecialistPostSkip };

export function specialistResultDedupeKey(runId: string, status: string): string {
  return `wisp.specialist_result:${runId}:${status}`;
}

export function specialistStepDedupeKey(intentId: string, status: string): string {
  return `wisp.specialist_step:${intentId}:${status}`;
}

/** The run page (relative, same origin): the post's link and the in-app row's deep link. */
export function specialistRunLink(runId: string): string {
  return `/ai-agents/runs/${runId}`;
}

// ---------------------------------------------------------------------------
// Pure text
// ---------------------------------------------------------------------------

/** Cap by code point (never mid surrogate pair), marking the cut. */
function capChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/**
 * Device- or model-written text, made safe to show: filtered, single spaces
 * kept, capped. Also the run check-in result's body (checkInRuns.ts, W07).
 */
export function cleanText(value: string, max: number): string {
  return capChars(sanitizeUntrustedToolText(value).trim(), max);
}

function hostLabel(hostname: string | null): string {
  const clean = hostname ? cleanText(hostname, HOSTNAME_MAX_CHARS).replace(/\s+/g, ' ') : '';
  return clean.length > 0 ? clean : 'the device';
}

const FAILURE_TITLES: Readonly<Record<string, string>> = {
  grant_inactive: 'stopped because the Wisp grant is no longer active',
  budget_exceeded: 'stopped at its spending limit',
  max_turns_exceeded: 'stopped at its step limit',
  wall_clock_exceeded: 'stopped at its time limit',
};

function statusPhrase(status: SettledStatus, errorCode: string | null): string {
  if (status === 'completed') return 'finished';
  if (status === 'awaiting_approval') return 'waiting for your approval';
  if (status === 'cancelled') return 'cancelled';
  return (errorCode && FAILURE_TITLES[errorCode]) || 'failed';
}

/** Title + body of a settled run's post (pure; exported for the tests' sake only through behaviour). */
function runPostText(run: { status: SettledStatus; errorCode: string | null; summary: string | null; hostname: string | null }, pendingCount: number) {
  const title = `Device troubleshooting on ${hostLabel(run.hostname)}: ${statusPhrase(run.status, run.errorCode)}`;
  const waiting = run.status === 'awaiting_approval' && pendingCount > 0
    ? `${pendingCount} ${pendingCount === 1 ? 'step is' : 'steps are'} waiting for your approval.`
    : '';
  const room = SPECIALIST_RESULT_BODY_MAX_CHARS - (waiting ? Array.from(waiting).length + 2 : 0);
  const summary = run.summary?.trim() ? cleanText(run.summary, room) : 'The run left no summary. Open the run for its steps.';
  return { title, body: waiting ? `${summary}\n\n${waiting}` : summary };
}

/** A released step's result, as one short line of text (device output: cleaned and capped). */
function stepOutcomeText(result: unknown, max: number): string {
  if (result === null || result === undefined) return 'no result recorded';
  const r = result as Record<string, unknown>;
  const raw = typeof result === 'string'
    ? result
    : typeof r.summary === 'string' ? r.summary
      : typeof r.stdout === 'string' ? r.stdout
        : typeof r.message === 'string' ? r.message
          : JSON.stringify(result);
  const clean = cleanText(raw ?? '', max);
  return clean.length > 0 ? clean : 'no output';
}

// ---------------------------------------------------------------------------
// Reads (each its own short system context, opened outside any caller context)
// ---------------------------------------------------------------------------

const systemRead = <T>(fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn));

type RunForPost = {
  id: string;
  orgId: string;
  deviceId: string | null;
  profile: string;
  status: string;
  summary: string | null;
  errorCode: string | null;
  grantId: string | null;
  grantRevisionId: string | null;
  triggerRef: Record<string, unknown> | null;
  hostname: string | null;
};

async function loadRun(runId: string): Promise<RunForPost | null> {
  const [row] = await systemRead(() => db
    .select({
      id: aiAgentRuns.id,
      orgId: aiAgentRuns.orgId,
      deviceId: aiAgentRuns.deviceId,
      profile: aiAgentRuns.profile,
      status: aiAgentRuns.status,
      summary: aiAgentRuns.summary,
      errorCode: aiAgentRuns.errorCode,
      grantId: aiAgentRuns.grantId,
      grantRevisionId: aiAgentRuns.grantRevisionId,
      triggerRef: aiAgentRuns.triggerRef,
      // Org-pinned: a device row of another org never names this run's device.
      hostname: devices.hostname,
    })
    .from(aiAgentRuns)
    .leftJoin(devices, and(eq(devices.id, aiAgentRuns.deviceId), eq(devices.orgId, aiAgentRuns.orgId)))
    .where(eq(aiAgentRuns.id, runId))
    .limit(1));
  return (row as RunForPost | undefined) ?? null;
}

const isSpecialistRun = (run: RunForPost) =>
  run.profile === PROFILE && (run.triggerRef as { source?: unknown } | null)?.source === 'wisp_specialist';

async function postExists(threadId: string, dedupeKey: string): Promise<boolean> {
  const rows = await systemRead(() => db
    .select({ id: wispThreadPosts.id })
    .from(wispThreadPosts)
    .where(and(eq(wispThreadPosts.threadId, threadId), eq(wispThreadPosts.dedupeKey, dedupeKey)))
    .limit(1));
  return rows.length > 0;
}

async function pendingIntentCount(run: RunForPost): Promise<number> {
  const [row] = await systemRead(() => db
    .select({ count: sql<number>`count(*)::int` })
    .from(actionIntents)
    .where(and(
      eq(actionIntents.requestingAgentRunId, run.id),
      eq(actionIntents.orgId, run.orgId),
      eq(actionIntents.status, 'pending_approval'),
    )));
  return Number(row?.count ?? 0);
}

/**
 * The grantor + thread a run's post goes to, or why it may not go there. A
 * paused grant still reads (its thread stays readable; a run stopped by the
 * pause must say so); revoked / expired / Wisp-off do not.
 */
async function resolveDestination(run: { grantId: string; grantRevisionId: string; orgId: string }):
  Promise<{ ok: true; userId: string; threadId: string } | { ok: false; reason: SpecialistPostSkip }> {
  const audience = await resolveSpecialistPostAudience(run.grantId, run.grantRevisionId, run.orgId);
  if (!audience.ok) return { ok: false, reason: audience.reason };
  const thread = await runOutsideDbContext(() => getOrCreateThread(run.grantId));
  return { ok: true, userId: audience.grantorUserId, threadId: thread.id };
}

async function deliver(args: {
  userId: string; threadId: string; grantId: string; grantRevisionId: string; orgId: string;
  runId: string; dedupeKey: string; title: string; body: string;
}): Promise<SpecialistPostResult> {
  if (await postExists(args.threadId, args.dedupeKey)) return { posted: false, reason: 'already_posted' };
  const link = specialistRunLink(args.runId);
  let res: Awaited<ReturnType<typeof notifyUser>>;
  try {
    res = await notifyUser({
    userId: args.userId,
    category: 'wisp_nudge',
    kind: 'specialist_result',
    title: args.title,
    body: args.body,
    deepLink: link,
    concernId: null,
    threadId: args.threadId,
    grantId: args.grantId,
    push: false,
    specialist: { orgId: args.orgId, grantRevisionId: args.grantRevisionId, dedupeKey: args.dedupeKey, link },
    });
  } catch (err) {
    // The grant changed between our audience check and notifyUser's: a skip.
    if (err instanceof SpecialistAudienceRefusedError) return { posted: false, reason: err.reason };
    throw err;
  }
  // 'backoff' is notifyUser's dedupe hit: a racing caller wrote it first.
  return res.suppressed === 'backoff' ? { posted: false, reason: 'already_posted' } : { posted: true };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export async function postSpecialistResult(runId: string): Promise<SpecialistPostResult> {
  if (!wispEnabled()) return { posted: false, reason: 'wisp_disabled' };
  const run = await loadRun(runId);
  if (!run) return { posted: false, reason: 'run_not_found' };
  if (!isSpecialistRun(run)) return { posted: false, reason: 'not_a_specialist_run' };
  if (!(SETTLED_STATUSES as readonly string[]).includes(run.status)) return { posted: false, reason: 'not_settled' };
  if (!run.grantId || !run.grantRevisionId) return { posted: false, reason: 'no_grant' };
  const status = run.status as SettledStatus;

  const pending = status === 'awaiting_approval' ? await pendingIntentCount(run) : 0;
  const dest = await resolveDestination({ grantId: run.grantId, grantRevisionId: run.grantRevisionId, orgId: run.orgId });
  if (!dest.ok) return { posted: false, reason: dest.reason };

  const { title, body } = runPostText({ status, errorCode: run.errorCode, summary: run.summary, hostname: run.hostname }, pending);
  return deliver({
    userId: dest.userId,
    threadId: dest.threadId,
    grantId: run.grantId,
    grantRevisionId: run.grantRevisionId,
    orgId: run.orgId,
    runId: run.id,
    dedupeKey: specialistResultDedupeKey(run.id, status),
    title,
    body,
  });
}

export async function postSpecialistStepOutcome(intentId: string): Promise<SpecialistPostResult> {
  if (!wispEnabled()) return { posted: false, reason: 'wisp_disabled' };
  const [intent] = await systemRead(() => db
    .select({
      id: actionIntents.id,
      orgId: actionIntents.orgId,
      status: actionIntents.status,
      requestingAgentRunId: actionIntents.requestingAgentRunId,
      actionName: actionIntents.actionName,
      result: actionIntents.result,
      errorCode: actionIntents.errorCode,
    })
    .from(actionIntents)
    .where(eq(actionIntents.id, intentId))
    .limit(1));
  if (!intent) return { posted: false, reason: 'intent_not_found' };
  if (intent.status !== 'completed' && intent.status !== 'failed') return { posted: false, reason: 'not_terminal' };
  if (!intent.requestingAgentRunId) return { posted: false, reason: 'not_a_specialist_run' };

  const run = await loadRun(intent.requestingAgentRunId);
  // The intent's org must be the run's: a mismatch is never this run's step.
  if (!run || !isSpecialistRun(run) || run.orgId !== intent.orgId) return { posted: false, reason: 'not_a_specialist_run' };
  if (!run.grantId || !run.grantRevisionId) return { posted: false, reason: 'no_grant' };

  // The approval card's own copy (approval_requests.action_label, built
  // server-side when the intent was minted); the tool name when there is none.
  const [label] = await systemRead(() => db
    .select({ actionLabel: approvalRequests.actionLabel })
    .from(approvalRequests)
    .where(eq(approvalRequests.intentId, intent.id))
    .limit(1));
  const stepLabel = cleanText(label?.actionLabel ?? intent.actionName, LABEL_MAX_CHARS) || intent.actionName;

  const dest = await resolveDestination({ grantId: run.grantId, grantRevisionId: run.grantRevisionId, orgId: run.orgId });
  if (!dest.ok) return { posted: false, reason: dest.reason };

  const ran = intent.status === 'completed';
  const head = `Approved step ${ran ? 'ran' : 'failed'}: ${stepLabel} — `;
  const room = SPECIALIST_RESULT_BODY_MAX_CHARS - Array.from(head).length;
  const outcome = ran ? stepOutcomeText(intent.result, room) : cleanText(intent.errorCode ?? 'error', room) || 'error';
  return deliver({
    userId: dest.userId,
    threadId: dest.threadId,
    grantId: run.grantId,
    grantRevisionId: run.grantRevisionId,
    orgId: run.orgId,
    runId: run.id,
    dedupeKey: specialistStepDedupeKey(intent.id, intent.status),
    title: `Device troubleshooting on ${hostLabel(run.hostname)}: approved step ${ran ? 'ran' : 'failed'}`,
    body: `${head}${outcome}`,
  });
}

/** Skips that mean a bug (the item should have posted), not a state change: reported. */
const SUSPICIOUS_SKIPS: ReadonlySet<SpecialistPostSkip> = new Set(['run_not_found', 'intent_not_found', 'not_a_specialist_run', 'no_grant']);

export type SpecialistResweepResult = {
  scanned: number;
  posted: number;
  failed: number;
  /** Why a candidate did not post, by reason (an org that left the ceiling, a race, …). */
  skipped: Partial<Record<SpecialistPostSkip, number>>;
};

/**
 * The grant reconciler's re-sweep, two halves, each idempotent through its
 * dedupe key (so a finalizer or release posting right now still ends with
 * one post):
 *   - settled troubleshooting runs of the last 24 h whose thread has no
 *     `wisp.specialist_result:<run>:<status>` post → `postSpecialistResult`;
 *   - completed / failed steps of those runs whose status changed in the last
 *     24 h with no `wisp.specialist_step:<intent>:<status>` post →
 *     `postSpecialistStepOutcome` (a release whose post-back failed).
 * Only grants that can still carry a post (active or paused) are scanned, so
 * a revoked or expired grant's runs never crowd the per-tick limit. Per-item
 * failures are reported, never thrown; skips are tallied, and a skip that
 * means a bug is reported too.
 */
export async function resweepSpecialistResults(now: Date): Promise<SpecialistResweepResult> {
  const out: SpecialistResweepResult = { scanned: 0, posted: 0, failed: 0, skipped: {} };
  if (!wispEnabled()) return out;
  // Raw `sql` carries no column type to encode a Date with: bind the ISO string.
  const since = sql`${new Date(now.getTime() - SPECIALIST_RESULT_RESWEEP_WINDOW_MS).toISOString()}::timestamptz`;
  const settledAt = sql`coalesce(${aiAgentRuns.finishedAt}, ${aiAgentRuns.queuedAt})`;
  const liveSpecialistRun = and(
    eq(aiAgentRuns.profile, PROFILE),
    sql`${aiAgentRuns.triggerRef}->>'source' = 'wisp_specialist'`,
    inArray(wispGrants.status, ['active', 'paused']),
  );

  const runs = await systemRead(() => db
    .select({ id: aiAgentRuns.id })
    .from(aiAgentRuns)
    .innerJoin(wispGrants, eq(wispGrants.id, aiAgentRuns.grantId))
    .where(and(
      liveSpecialistRun,
      inArray(aiAgentRuns.status, [...SETTLED_STATUSES]),
      sql`${settledAt} >= ${since}`,
      sql`NOT EXISTS (
        SELECT 1 FROM ${wispThreadPosts}
        WHERE ${wispThreadPosts.grantId} = ${aiAgentRuns.grantId}
          AND ${wispThreadPosts.dedupeKey} = 'wisp.specialist_result:' || ${aiAgentRuns.id}::text || ':' || ${aiAgentRuns.status}
      )`,
    ))
    .orderBy(desc(settledAt))
    .limit(SPECIALIST_RESULT_RESWEEP_LIMIT));

  const steps = await systemRead(() => db
    .select({ id: actionIntents.id })
    .from(actionIntents)
    .innerJoin(aiAgentRuns, and(eq(aiAgentRuns.id, actionIntents.requestingAgentRunId), eq(aiAgentRuns.orgId, actionIntents.orgId)))
    .innerJoin(wispGrants, eq(wispGrants.id, aiAgentRuns.grantId))
    .where(and(
      liveSpecialistRun,
      inArray(actionIntents.status, ['completed', 'failed']),
      sql`${actionIntents.statusChangedAt} >= ${since}`,
      sql`NOT EXISTS (
        SELECT 1 FROM ${wispThreadPosts}
        WHERE ${wispThreadPosts.grantId} = ${aiAgentRuns.grantId}
          AND ${wispThreadPosts.dedupeKey} = 'wisp.specialist_step:' || ${actionIntents.id}::text || ':' || ${actionIntents.status}
      )`,
    ))
    .orderBy(desc(actionIntents.statusChangedAt))
    .limit(SPECIALIST_RESULT_RESWEEP_LIMIT));

  const attempt = async (kind: 'run' | 'step', id: string) => {
    out.scanned += 1;
    try {
      const res = kind === 'run' ? await postSpecialistResult(id) : await postSpecialistStepOutcome(id);
      if (res.posted) { out.posted += 1; return; }
      out.skipped[res.reason] = (out.skipped[res.reason] ?? 0) + 1;
      if (SUSPICIOUS_SKIPS.has(res.reason)) {
        console.warn('[wisp.specialistResult] re-sweep candidate cannot post', { kind, id, reason: res.reason });
        captureException(new Error(`specialist ${kind} ${id} cannot post: ${res.reason}`), undefined, {
          op: 'wisp.specialistResult.resweep.skip', kind, id, reason: res.reason,
        });
      }
    } catch (err) {
      out.failed += 1;
      console.error('[wisp.specialistResult] re-sweep post failed', { kind, id, err });
      captureException(err, undefined, { op: 'wisp.specialistResult.resweep', kind, id });
    }
  };
  for (const { id } of runs) await attempt('run', id);
  for (const { id } of steps) await attempt('step', id);
  return out;
}
