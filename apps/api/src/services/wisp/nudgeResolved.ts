/**
 * #11427 — the follow-up to a nudge whose concern closed (by an assessment, by
 * its linked alert resolving, by a person, or by the reaper). Each thread that
 * carried a `nudge` post for the concern gets a `nudge_resolved` post + in-app
 * notification through `notifyUser`:
 * "<subject> — <outcome in one sentence>; no action needed."
 *
 * Called only from `resolveConcern` (concerns.ts), after a COMMITTED
 * live→resolved transition, outside any DB context; best-effort (a failed
 * delivery is reported, never thrown; resolveConcern also catches). Shape
 * mirrors the digest sweep (nudgeDigest.ts): one system-context read, closed
 * before any delivery; then each recipient is re-checked against the grant's
 * LIVE ceiling (it may have narrowed since the nudge) before `notifyUser`,
 * which opens its own contexts. Skipped: a recipient who dismissed the concern,
 * the person who resolved it themselves, a grant with no pinned revision, an
 * inactive grant (a corrupt one is reported), and a grantor who can no longer
 * see the concern. The dedupe key is `wisp.nudge_resolved:<concern>`: at most
 * one post per thread and one notification per user, and a second resolve of
 * the same concern never reaches here. Never pushed (notifyUser withholds it).
 * Dark while `wispEnabled()` is false.
 */
import { and, eq } from 'drizzle-orm';
import { wispEnabled } from '../../config/env';
import { db } from '../../db';
import { wispGrants } from '../../db/schema/wisp';
import { wispConcernRecipients, wispConcerns } from '../../db/schema/wispConcerns';
import { wispThreadPosts } from '../../db/schema/wispThreadPosts';
import { wispThreads } from '../../db/schema/wispThreads';
import { captureException } from '../sentry';
import { getConcernForCeiling } from './concerns';
import { GrantInactiveError, inSystemContext, resolveGrantCeiling } from './grantAuthority';
import { mobileDeepLink } from './nudgeLinks';
import { notifyUser } from './notifyUser';

const LOG_PREFIX = '[wisp.nudgeResolved]';
const SUBJECT_MAX = 80;
const OUTCOME_MAX = 200;
/** Nudge posts read per concern (a concern is nudged on a handful of threads at most). */
const THREAD_LIMIT = 100;

/** The machine outcomes system paths record, in words. */
const MACHINE_OUTCOMES: Readonly<Record<string, string>> = {
  alert_resolved: 'the alert behind it resolved',
  subject_gone: 'what it was about no longer exists',
  auto_closed: 'it went quiet and was closed automatically',
  ai_agent_configured: 'an AI agent is now set up',
  superseded_no_effective_agent: 'a newer concern replaced it',
};

function clip(text: string, max: number): string {
  const cps = [...text];
  return cps.length <= max ? text : `${cps.slice(0, max - 1).join('')}…`;
}

/** The outcome as one lower-case-led clause without its closing punctuation. */
function outcomeClause(outcome: string | null): string {
  const raw = (outcome ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return 'it was resolved';
  const machine = MACHINE_OUTCOMES[raw];
  if (machine) return machine;
  if (/^[a-z]+(_[a-z]+)+$/.test(raw)) return raw.replace(/_/g, ' ');
  const first = (raw.split(/(?<=[.!?])\s+/)[0] ?? raw).replace(/[.!?]+$/, '').trim() || raw;
  // "The device restarted" → "the device restarted"; "SSD replaced" keeps its acronym.
  const led = /^[A-Z][a-z]/.test(first) ? first[0]!.toLowerCase() + first.slice(1) : first;
  return clip(led, OUTCOME_MAX);
}

/** "<subject> — <outcome in one sentence>; no action needed." (subject = the concern's summary). */
export function buildNudgeResolvedText(c: { summary: string; outcome: string | null }): { title: string; body: string } {
  const subject = clip(c.summary.replace(/\s+/g, ' ').trim(), SUBJECT_MAX);
  return { title: `Resolved: ${subject}`, body: `${subject} — ${outcomeClause(c.outcome)}; no action needed.` };
}

type NudgedThread = {
  threadId: string;
  grantId: string;
  grantorUserId: string;
  currentRevisionId: string | null;
  dismissedAt: Date | null;
};

function report(op: string, err: unknown, extra: Record<string, unknown>): void {
  console.error(`${LOG_PREFIX} ${op} failed`, { ...extra, err });
  captureException(err, undefined, { op: `wisp.nudgeResolved.${op}`, ...extra });
}

/**
 * Tell each thread that was nudged about `concernId` that it closed. Returns
 * how many nudged threads were found and how many got a follow-up written.
 */
export async function notifyNudgeResolved(concernId: string): Promise<{ recipients: number; sent: number }> {
  const result = { recipients: 0, sent: 0 };
  if (!wispEnabled()) return result;

  const read = await inSystemContext(async () => {
    const [concern] = await db
      .select({
        id: wispConcerns.id,
        partnerId: wispConcerns.partnerId,
        status: wispConcerns.status,
        resolvedByUserId: wispConcerns.resolvedByUserId,
        summary: wispConcerns.summary,
        outcome: wispConcerns.outcome,
      })
      .from(wispConcerns)
      .where(eq(wispConcerns.id, concernId))
      .limit(1);
    if (!concern || concern.status !== 'resolved') return null;
    const rows: NudgedThread[] = await db
      .select({
        threadId: wispThreadPosts.threadId,
        grantId: wispThreadPosts.grantId,
        grantorUserId: wispGrants.grantorUserId,
        currentRevisionId: wispGrants.currentRevisionId,
        dismissedAt: wispConcernRecipients.dismissedAt,
      })
      .from(wispThreadPosts)
      .innerJoin(wispThreads, and(eq(wispThreads.id, wispThreadPosts.threadId), eq(wispThreads.grantId, wispThreadPosts.grantId)))
      .innerJoin(wispGrants, and(eq(wispGrants.id, wispThreadPosts.grantId), eq(wispGrants.partnerId, wispThreadPosts.partnerId)))
      .leftJoin(wispConcernRecipients, and(
        eq(wispConcernRecipients.concernId, wispThreadPosts.concernId),
        eq(wispConcernRecipients.grantId, wispThreadPosts.grantId),
      ))
      .where(and(
        eq(wispThreadPosts.kind, 'nudge'),
        eq(wispThreadPosts.concernId, concernId),
        eq(wispThreadPosts.partnerId, concern.partnerId),
      ))
      .limit(THREAD_LIMIT);
    return { concern, rows };
  });
  if (!read) return result;

  // A thread can carry several nudge posts (one per backoff window): one follow-up per thread.
  const threads = new Map<string, NudgedThread>();
  for (const row of read.rows) if (!threads.has(row.threadId)) threads.set(row.threadId, row);
  result.recipients = threads.size;
  const text = buildNudgeResolvedText(read.concern);

  for (const t of threads.values()) {
    if (t.dismissedAt) continue; // they already said they did not want to hear about it
    if (read.concern.resolvedByUserId === t.grantorUserId) continue; // they closed it themselves
    if (!t.currentRevisionId) continue;
    try {
      let ceiling;
      try {
        ceiling = await resolveGrantCeiling(t.grantId, t.currentRevisionId);
      } catch (err) {
        if (err instanceof GrantInactiveError) {
          if (err.kind === 'corrupt') report('ceiling', err, { concernId, grantId: t.grantId });
          continue;
        }
        throw err;
      }
      // The grantor may have lost the concern's org (or reach it only through a
      // site restriction) since the nudge: say nothing about what they cannot see.
      if (!(await getConcernForCeiling(ceiling, concernId))) continue;
      const res = await notifyUser({
        userId: t.grantorUserId,
        category: 'wisp_nudge',
        kind: 'nudge_resolved',
        concernId,
        threadId: t.threadId,
        grantId: t.grantId,
        deepLink: mobileDeepLink(t.threadId, concernId),
        ...text,
      });
      // 'backoff' = no new notification: a dedupe hit (another thread of the same
      // user may still get its post) or a concern that no longer reads resolved.
      if (res.suppressed !== 'backoff') result.sent += 1;
    } catch (err) {
      report('deliver', err, { concernId, grantId: t.grantId });
    }
  }
  return result;
}
