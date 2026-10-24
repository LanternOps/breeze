/**
 * Wisp W06a Task 5 — the digest sweep (w00 A28). Concerns that have already
 * been nudged twice without an answer ("digest-only", see `isDigestOnly` in
 * concerns.ts) stop producing individual pushes and ride ONE digest per grant,
 * at most once per the user's `digestCadenceMinutes`.
 *
 * Shape: one system-context SELECT finds the candidates (closed before any
 * delivery), then each candidate is re-checked against the grant's LIVE
 * ceiling (it may have narrowed since the nudges, and the summaries go to a
 * lock screen) and delivered through `notifyUser`, which opens its own DB
 * contexts — so nothing here holds a context across that call.
 * Dark by default: zeros while `wispEnabled()` is false, checked every run.
 */
import { and, eq, gt, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { resolveWispNudgePrefs, type ConcernSeverity, type WispNudgePreferences } from '@breeze/shared';
import { wispEnabled } from '../../config/env';
import { db } from '../../db';
import { wispGrants } from '../../db/schema/wisp';
import { wispConcernRecipients, wispConcerns } from '../../db/schema/wispConcerns';
import { wispThreads } from '../../db/schema/wispThreads';
import { captureException } from '../sentry';
import { listConcernsForCeiling } from './concerns';
import { GrantInactiveError, inSystemContext, resolveGrantCeiling } from './grantAuthority';
import { mobileDeepLink } from './nudgeLinks';
import { loadNudgeBookkeeping, markDigestSent } from './nudgePreferences';
import { notifyUser } from './notifyUser';

const LOG_PREFIX = '[WispNudgeDigest]';
const SUMMARY_MAX = 40;
const BODY_ENTRIES = 3;
const SEVERITY_RANK: Record<ConcernSeverity, number> = { info: 0, low: 1, medium: 2, high: 3 };

export type DigestCandidate = {
  grantId: string;
  threadId: string;
  userId: string;
  partnerId: string;
  currentRevisionId: string;
  concerns: Array<{ id: string; summary: string; severity: ConcernSeverity }>;
};

/** Never sent, or at least `digestCadenceMinutes` since the last digest. */
export function digestDue(prefs: WispNudgePreferences, lastDigestAt: Date | null, now: Date): boolean {
  if (lastDigestAt === null) return true;
  return now.getTime() - lastDigestAt.getTime() >= prefs.digestCadenceMinutes * 60_000;
}

function clip(text: string): string {
  const cps = [...text];
  return cps.length <= SUMMARY_MAX ? text : `${cps.slice(0, SUMMARY_MAX - 1).join('')}…`;
}

export function buildDigestText(concerns: DigestCandidate['concerns']): { title: string; body: string } {
  const n = concerns.length;
  const body = [...concerns]
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
    .slice(0, BODY_ENTRIES)
    .map((c) => clip(c.summary))
    .join(' · ');
  return { title: `Wisp: ${n} concern${n === 1 ? '' : 's'} waiting`, body };
}

/** Active, unexpired, pinned grants with ≥ 2 open digest-only, un-snoozed, undismissed concerns. */
export async function selectDigestCandidates(now: Date): Promise<DigestCandidate[]> {
  const rows = await inSystemContext(() => db
    .select({
      grantId: wispGrants.id,
      threadId: wispThreads.id,
      userId: wispGrants.grantorUserId,
      partnerId: wispGrants.partnerId,
      currentRevisionId: wispGrants.currentRevisionId,
      concernId: wispConcerns.id,
      summary: wispConcerns.summary,
      severity: wispConcerns.severity,
    })
    .from(wispGrants)
    .innerJoin(wispThreads, eq(wispThreads.grantId, wispGrants.id))
    .innerJoin(wispConcernRecipients, eq(wispConcernRecipients.grantId, wispGrants.id))
    .innerJoin(wispConcerns, and(
      eq(wispConcerns.id, wispConcernRecipients.concernId),
      eq(wispConcerns.partnerId, wispGrants.partnerId),
    ))
    .where(and(
      eq(wispGrants.status, 'active'),
      gt(wispGrants.expiresAt, now),
      isNotNull(wispGrants.currentRevisionId),
      eq(wispConcerns.status, 'open'),
      sql`${wispConcernRecipients.nudgeCount} >= 2`,
      // Mirrors isDigestOnly: not answered since the last nudge.
      or(
        isNull(wispConcernRecipients.answeredAt),
        and(
          isNotNull(wispConcernRecipients.lastNudgedAt),
          sql`${wispConcernRecipients.answeredAt} < ${wispConcernRecipients.lastNudgedAt}`,
        ),
      ),
      isNull(wispConcernRecipients.dismissedAt),
      or(isNull(wispConcernRecipients.snoozedUntil), lte(wispConcernRecipients.snoozedUntil, now)),
    )));

  const byGrant = new Map<string, DigestCandidate>();
  for (const r of rows) {
    if (!r.currentRevisionId) continue;
    let cand = byGrant.get(r.grantId);
    if (!cand) {
      cand = {
        grantId: r.grantId,
        threadId: r.threadId,
        userId: r.userId,
        partnerId: r.partnerId,
        currentRevisionId: r.currentRevisionId,
        concerns: [],
      };
      byGrant.set(r.grantId, cand);
    }
    if (!cand.concerns.some((c) => c.id === r.concernId)) {
      cand.concerns.push({ id: r.concernId, summary: r.summary, severity: r.severity });
    }
  }
  return [...byGrant.values()].filter((c) => c.concerns.length >= 2);
}

function reportFailure(candidate: DigestCandidate, err: unknown): void {
  console.error(`${LOG_PREFIX} grant ${candidate.grantId} failed:`, err);
  captureException(err, undefined, { op: 'wisp.nudgeDigest', grantId: candidate.grantId });
}

export async function runNudgeDigest(now: Date = new Date()): Promise<{ candidates: number; sent: number; suppressed: number }> {
  const result = { candidates: 0, sent: 0, suppressed: 0 };
  if (!wispEnabled()) return result;

  const candidates = await selectDigestCandidates(now);
  result.candidates = candidates.length;
  if (candidates.length === 0) return result;

  const bookkeeping = await loadNudgeBookkeeping(candidates.map((c) => c.userId));

  for (const cand of candidates) {
    try {
      const book = bookkeeping.get(cand.userId);
      const prefs = book?.prefs ?? resolveWispNudgePrefs(null);
      if (!digestDue(prefs, book?.lastDigestAt ?? null, now)) continue;

      let ceiling;
      try {
        ceiling = await resolveGrantCeiling(cand.grantId, cand.currentRevisionId);
      } catch (err) {
        if (err instanceof GrantInactiveError) {
          if (err.kind === 'corrupt') reportFailure(cand, err);
          continue;
        }
        throw err;
      }
      const visible = new Set((await listConcernsForCeiling(ceiling, { status: ['open'] })).map((c) => c.id));
      const kept = cand.concerns.filter((c) => visible.has(c.id));
      if (kept.length < 2) continue;

      const out = await notifyUser({
        userId: cand.userId,
        category: 'wisp_nudge',
        kind: 'digest',
        concernId: null,
        threadId: cand.threadId,
        grantId: cand.grantId,
        deepLink: mobileDeepLink(cand.threadId, null),
        ...buildDigestText(kept),
      });
      if (out.inApp || out.pushed > 0) {
        await markDigestSent(cand.userId, cand.partnerId, now);
        result.sent += 1;
      } else {
        result.suppressed += 1;
      }
    } catch (err) {
      reportFailure(cand, err);
    }
  }
  return result;
}
