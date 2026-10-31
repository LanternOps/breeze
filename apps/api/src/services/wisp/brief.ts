/**
 * Wisp W06 Task 13 — the morning brief (feature #9906, w00 A28).
 *
 * One deterministic daily brief per grant (NO model call), sent at the user's
 * chosen local time through `notifyUser({ kind: 'brief' })` — which owns the
 * channels, the dedupe key `wisp.brief:${threadId}:${localDate}` and the rule
 * that a brief always pushes and ignores quiet hours. Runs in the W06
 * 15-minute nudge sweep lane beside the digest.
 *
 * Lock-screen safety: the title and body carry counts and concern summaries
 * Wisp itself wrote; this file never adds org or device names of its own.
 */
import { and, asc, eq, gt, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { CONCERN_SEVERITIES, resolveWispNudgePrefs } from '@breeze/shared';
import type { BriefSection, Concern, ConcernSeverity } from '@breeze/shared';
import { wispEnabled } from '../../config/env';
import { db } from '../../db';
import { mobileDevices } from '../../db/schema/mobile';
import { wispGrants } from '../../db/schema/wisp';
import { captureException } from '../sentry';
import { listActivity } from './activity';
import { spendSummary } from './budget';
import { listConcernsForCeiling } from './concerns';
import { GrantInactiveError, inSystemContext, resolveGrantCeiling } from './grantAuthority';
import type { SYSTEM_PAUSE_REASONS } from './grants';
import { notifyUser } from './notifyUser';
import { mobileDeepLink } from './nudgeLinks';
import { loadNudgeBookkeeping, markBriefSent } from './nudgePreferences';
import { getOrCreateThread } from './threads';
import { listWatches } from './watches';

export type { BriefSection } from '@breeze/shared';

type SystemPauseReason = (typeof SYSTEM_PAUSE_REASONS)[number];

/** Plain-words reason for the one-line brief of a system-paused grant (exhaustive over SYSTEM_PAUSE_REASONS). */
const PAUSE_REASON_COPY: Record<SystemPauseReason, string> = {
  grantor_access_lost: 'Your access changed, so Wisp stopped checking in. Open Wisp to review.',
  grantor_suspended: 'Your account is suspended, so Wisp stopped checking in.',
  factor_expired: 'Your sign-in check expired. Open Wisp to confirm it and resume.',
  entitlement_lost: 'Your plan no longer includes Wisp, so it stopped checking in.',
  budget_exhausted: "Today's Wisp budget is used up. It resumes when the budget resets.",
  partner_disabled: 'Wisp was switched off for your company.',
};
const SYSTEM_PAUSE_REASON_VALUES = Object.keys(PAUSE_REASON_COPY) as SystemPauseReason[];

const BODY_ITEM_MAX = 40;
const BODY_ITEMS = 3;
const SECTION_LINES_MAX = 10;
const ACTIVITY_LIMIT = 100;
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** High → info. */
const SEVERITY_DESC = [...CONCERN_SEVERITIES].reverse() as ConcernSeverity[];

// ---------------------------------------------------------------------------
// briefDue (pure)
// ---------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    formatters.set(tz, f);
  }
  return f;
}

function safeTimeZone(tz: string | null | undefined): string {
  if (!tz) return 'UTC';
  try {
    formatterFor(tz);
    return tz;
  } catch {
    return 'UTC';
  }
}

/** The wall-clock date (YYYY-MM-DD) and minute-of-day of `d` in `tz`. */
function localParts(d: Date, tz: string): { date: string; minutes: number } {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(tz).formatToParts(d)) parts[p.type] = p.value;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function briefDue(
  prefs: { briefTimeLocal: string | null; briefTimezone: string | null },
  lastBriefAt: Date | null,
  now: Date,
  fallbackTz: string,
): { due: boolean; localDate: string } {
  const tz = safeTimeZone(prefs.briefTimezone ?? fallbackTz);
  const today = localParts(now, tz);
  const m = prefs.briefTimeLocal === null ? null : /^([01]\d|2[0-3]):([0-5]\d)$/.exec(prefs.briefTimeLocal);
  if (!m) return { due: false, localDate: today.date };
  if (today.minutes < Number(m[1]) * 60 + Number(m[2])) return { due: false, localDate: today.date };
  // YYYY-MM-DD compares correctly as a string.
  const due = lastBriefAt === null || localParts(lastBriefAt, tz).date < today.date;
  return { due, localDate: today.date };
}

// ---------------------------------------------------------------------------
// buildBrief (deterministic)
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  const chars = [...s.replace(/\s+/g, ' ').trim()];
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const rank = (c: Concern) => SEVERITY_DESC.indexOf(c.severity);
const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

/** A live readiness concern (assessmentFinalizer `applyReadiness`): org subject, `evidence.readiness`. */
function isReadinessGap(c: Concern): boolean {
  return c.subject.kind === 'org' && typeof c.evidence?.readiness === 'object' && c.evidence.readiness !== null;
}

/**
 * Build the brief under the grant's LIVE ceiling. `opts.since` is the previous
 * brief's time (the "Overnight" window); default the last 24 h. Throws
 * `GrantInactiveError` when the grant cannot be used.
 */
export async function buildBrief(
  grantId: string,
  now: Date,
  opts: { since?: Date | null } = {},
): Promise<{ title: string; body: string; sections: BriefSection[] }> {
  const grant = await inSystemContext(async () => {
    const [row] = await db
      .select({ currentRevisionId: wispGrants.currentRevisionId, status: wispGrants.status })
      .from(wispGrants)
      .where(eq(wispGrants.id, grantId))
      .limit(1);
    return row;
  });
  if (!grant) throw new GrantInactiveError(grantId, 'revoked', 'grant not found', 'ended');
  if (!grant.currentRevisionId) throw new GrantInactiveError(grantId, grant.status, 'no pinned revision', 'corrupt');
  const ceiling = await resolveGrantCeiling(grantId, grant.currentRevisionId);
  const since = opts.since ?? new Date(now.getTime() - DEFAULT_LOOKBACK_MS);

  const [live, resolved, activity, spend, watches] = await Promise.all([
    listConcernsForCeiling(ceiling, { status: ['open', 'snoozed'] }),
    listConcernsForCeiling(ceiling, { status: ['resolved'] }),
    listActivity(ceiling, { limit: ACTIVITY_LIMIT }),
    spendSummary(grantId, now),
    listWatches(ceiling),
  ]);

  const sorted = [...live].sort((a, b) => rank(a) - rank(b));
  const needsYou = sorted.filter((c) => c.approvalIntentId);
  const openOnly = sorted.filter((c) => c.status === 'open');

  const title = live.length === 0
    ? 'Good morning — nothing needs you'
    : `Good morning — ${needsYou.length} need you, ${live.length} open`;
  const body = openOnly.length === 0
    ? 'Nothing needs you right now.'
    : openOnly.slice(0, BODY_ITEMS).map((c) => truncate(c.summary, BODY_ITEM_MAX)).join(' · ');

  const sections: BriefSection[] = [];
  const push = (heading: string, lines: string[]) => {
    if (lines.length > 0) sections.push({ heading, lines: lines.slice(0, SECTION_LINES_MAX) });
  };

  push('Needs you', needsYou.map((c) => c.summary));
  push('Open concerns', SEVERITY_DESC.flatMap((sev) => {
    const n = live.filter((c) => c.severity === sev).length;
    return n > 0 ? [`${sev}: ${n}`] : [];
  }));

  const recent = activity.items.filter((i) => new Date(i.at).getTime() >= since.getTime());
  const assessments = recent.filter((i) => i.kind === 'assessment').length;
  const specialists = recent.filter((i) => i.kind === 'specialist').length;
  const resolvedCount = resolved.filter((c) => c.resolvedAt && new Date(c.resolvedAt).getTime() >= since.getTime()).length;
  push('Overnight', [
    ...(assessments > 0 ? [plural(assessments, 'assessment run', 'assessments run')] : []),
    ...(specialists > 0 ? [plural(specialists, 'specialist launched', 'specialists launched')] : []),
    ...(resolvedCount > 0 ? [plural(resolvedCount, 'concern resolved', 'concerns resolved')] : []),
  ]);

  // Dollars, matching the web spend meter ("$0.42 of $2.00 today"); AI spend is USD.
  push('Spend', [`${usd(spend.spentTodayCents)} of ${usd(spend.budgetCentsPerDay)} today`]);

  const activeWatches = watches.filter((w) => w.status === 'active').length;
  const gaps = live.filter(isReadinessGap).length;
  push('Watching', [
    ...(activeWatches > 0 ? [plural(activeWatches, 'active watch', 'active watches')] : []),
    ...(gaps > 0 ? [plural(gaps, 'readiness gap', 'readiness gaps')] : []),
  ]);

  return { title, body, sections };
}

// ---------------------------------------------------------------------------
// runMorningBriefs (the sweep)
// ---------------------------------------------------------------------------

type SweepGrant = { id: string; partnerId: string; grantorUserId: string; status: string; pausedReason: string | null };

/** Grantor → timezone of the oldest active mobile device that has one. */
async function fallbackTimezones(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const tzExpr = sql<string | null>`${mobileDevices.quietHours}->>'timezone'`;
  const rows = await db
    .select({ userId: mobileDevices.userId, timezone: tzExpr })
    .from(mobileDevices)
    .where(and(inArray(mobileDevices.userId, userIds), eq(mobileDevices.status, 'active'), isNotNull(tzExpr)))
    .orderBy(asc(mobileDevices.createdAt));
  const out = new Map<string, string>();
  for (const r of rows) if (r.timezone && !out.has(r.userId)) out.set(r.userId, r.timezone);
  return out;
}

export async function runMorningBriefs(now: Date = new Date()): Promise<{ due: number; sent: number; suppressed: number }> {
  const result = { due: 0, sent: 0, suppressed: 0 };
  // Dark by default: checked every run so the flag can flip without a restart.
  if (!wispEnabled()) return result;

  const { grants, tzByUser } = await inSystemContext(async () => {
    const rows: SweepGrant[] = await db
      .select({
        id: wispGrants.id,
        partnerId: wispGrants.partnerId,
        grantorUserId: wispGrants.grantorUserId,
        status: wispGrants.status,
        pausedReason: wispGrants.pausedReason,
      })
      .from(wispGrants)
      .where(and(
        gt(wispGrants.expiresAt, now),
        or(
          eq(wispGrants.status, 'active'),
          and(eq(wispGrants.status, 'paused'), inArray(wispGrants.pausedReason, SYSTEM_PAUSE_REASON_VALUES)),
        ),
      ));
    // Defence in depth: a user-paused grant never gets a brief, whatever the query returned.
    const eligible = rows.filter((g) => g.status === 'active' || (g.status === 'paused' && isSystemPauseReason(g.pausedReason)));
    const userIds = [...new Set(eligible.map((g) => g.grantorUserId))];
    return { grants: eligible, tzByUser: await fallbackTimezones(userIds) };
  });
  if (grants.length === 0) return result;

  const userIds = [...new Set(grants.map((g) => g.grantorUserId))];
  const bookkeeping = await loadNudgeBookkeeping(userIds);

  for (const grant of grants) {
    try {
      const book = bookkeeping.get(grant.grantorUserId);
      const prefs = book?.prefs ?? resolveWispNudgePrefs(null);
      const lastBriefAt = book?.lastBriefAt ?? null;
      const { due, localDate } = briefDue(prefs, lastBriefAt, now, tzByUser.get(grant.grantorUserId) ?? 'UTC');
      if (!due) continue;
      result.due += 1;

      const thread = await getOrCreateThread(grant.id);
      const content = grant.status === 'active'
        ? await buildBrief(grant.id, now, { since: lastBriefAt })
        : {
          title: 'Wisp is paused',
          body: PAUSE_REASON_COPY[grant.pausedReason as SystemPauseReason],
          sections: [] as BriefSection[],
        };

      // Every read above returned its DB context; notifyUser runs outside one.
      const delivered = await notifyUser({
        userId: grant.grantorUserId,
        category: 'wisp_nudge',
        kind: 'brief',
        concernId: null,
        threadId: thread.id,
        grantId: grant.id,
        deepLink: mobileDeepLink(thread.id, null),
        title: content.title,
        body: content.body,
        briefLocalDate: localDate,
        briefSections: content.sections,
      });
      // Stamp the day whenever notifyUser returned: delivered, already
      // delivered (dedupe hit after a failed stamp) or withheld by the user's
      // channels — otherwise every sweep would rebuild it until midnight.
      await markBriefSent(grant.grantorUserId, grant.partnerId, now);
      if (delivered.inApp || delivered.pushed > 0) result.sent += 1;
      else result.suppressed += 1;
    } catch (error) {
      // A grant that went inactive between the sweep read and the build is a race, not a fault.
      if (error instanceof GrantInactiveError && error.kind !== 'corrupt') {
        console.warn('[wisp/brief] grant inactive at brief time; skipped', { grantId: grant.id, kind: error.kind });
        continue;
      }
      console.error('[wisp/brief] morning brief failed for grant', { grantId: grant.id, error });
      captureException(error, undefined, { grantId: grant.id, area: 'wisp_brief' });
    }
  }
  return result;
}

function isSystemPauseReason(reason: string | null): reason is SystemPauseReason {
  return reason !== null && (SYSTEM_PAUSE_REASON_VALUES as string[]).includes(reason);
}
