/**
 * Wisp W06 Task 13 — the morning brief (feature #9906, w00 A28).
 *
 * One deterministic daily brief per grant (NO model call), sent at the user's
 * chosen local time through `notifyUser({ kind: 'brief' })` — which owns the
 * channels, the dedupe key `wisp.brief:${threadId}:${localDate}` and the rule
 * that a brief always pushes and ignores quiet hours. Runs in the W06
 * 15-minute nudge sweep lane beside the digest.
 *
 * Lock-screen safety: the title and body carry counts, concern summaries Wisp
 * itself wrote and, for a device or org subject only, that subject's own name
 * as the grant's live ceiling resolves it (#11428). Free text that is not
 * Wisp's (a ticket, quote or alert title) never reaches the body.
 */
import { and, eq, gt, inArray, or, sql } from 'drizzle-orm';
import { CONCERN_SEVERITIES, resolveBriefTimezone, resolveWispNudgePrefs } from '@breeze/shared';
import type { BriefSection, Concern, ConcernSeverity, ConcernSubjectKind, WispEntityKind } from '@breeze/shared';
import { wispEnabled } from '../../config/env';
import { db } from '../../db';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { wispGrants } from '../../db/schema/wisp';
import { captureException } from '../sentry';
import { listActivity } from './activity';
import { spendSummary } from './budget';
import { isConcernRollup } from './concernRollup';
import { listConcernsForCeiling } from './concerns';
import { createEntityResolver, isResolveFailure } from './entityRefs';
import { GrantInactiveError, inSystemContext, resolveGrantCeiling, type GrantCeiling } from './grantAuthority';
import type { SYSTEM_PAUSE_REASONS } from './grants';
import { notifyUser } from './notifyUser';
import { mobileDeepLink } from './nudgeLinks';
import { loadNudgeBookkeeping, markBriefSent, partnerTimezones, phoneTimezones } from './nudgePreferences';
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

/** One body item's problem text, in code points with the ellipsis (#11428; was 40). */
const BODY_ITEM_MAX = 90;
/** The subject name that may lead a body item. */
const BODY_LABEL_MAX = 40;
const BODY_ITEMS = 3;
/**
 * The whole body: `buildWispNudgePush` clips a push body at 120 code points
 * (W06: a lock-screen body is ≤ 120), so the body is built to fit it rather
 * than be cut mid-word there.
 */
const BODY_MAX = 120;
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

/** A brief time is `HH:MM` (24 h); anything else means no brief. */
const BRIEF_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Whether the brief is due now: past today's brief time in the brief's zone and
 * not yet sent today.
 *
 * @param grantCreatedAt a grant created at or after today's brief time first
 *   becomes due at the next one, not on the next sweep (#11287).
 */
export function briefDue(
  prefs: { briefTimeLocal: string | null; briefTimezone: string | null },
  lastBriefAt: Date | null,
  now: Date,
  fallbackTz: string,
  grantCreatedAt: Date | null = null,
): { due: boolean; localDate: string } {
  const tz = safeTimeZone(prefs.briefTimezone ?? fallbackTz);
  const today = localParts(now, tz);
  const m = prefs.briefTimeLocal === null ? null : BRIEF_TIME_RE.exec(prefs.briefTimeLocal);
  if (!m) return { due: false, localDate: today.date };
  const briefMinutes = Number(m[1]) * 60 + Number(m[2]);
  if (today.minutes < briefMinutes) return { due: false, localDate: today.date };
  if (grantCreatedAt) {
    const created = localParts(grantCreatedAt, tz);
    // Today's brief time came before the grant existed: the first brief is the next one.
    if (created.date === today.date && created.minutes >= briefMinutes) return { due: false, localDate: today.date };
  }
  // YYYY-MM-DD compares correctly as a string.
  const due = lastBriefAt === null || localParts(lastBriefAt, tz).date < today.date;
  return { due, localDate: today.date };
}

// ---------------------------------------------------------------------------
// buildBrief (deterministic)
// ---------------------------------------------------------------------------

const flatten = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * At most `max` code points, the ellipsis included, cut back to the last whole
 * word (a single word longer than half the room is cut where it falls).
 */
function cutAtWord(s: string, max: number): string {
  const chars = [...s];
  if (chars.length <= max) return s;
  const head = chars.slice(0, max - 1).join('');
  const space = head.lastIndexOf(' ');
  const wordEndsAtCut = chars[max - 1] === ' ';
  const cut = wordEndsAtCut || space < head.length / 2 ? head : head.slice(0, space);
  return `${cut.replace(/[\s,;:–—-]+$/u, '')}…`;
}

/** The summary's first sentence, without its full stop. A `.` inside `v0.127.0` or `2.5` does not end one. */
function firstSentence(summary: string): string {
  const flat = flatten(summary);
  const end = /[.!?](?=\s|$)/.exec(flat);
  const sentence = end ? flat.slice(0, end.index + 1) : flat;
  return sentence.replace(/\.$/, '');
}

/** Whether the summary opens with the name as a whole word (`web-10 …` does not open with `web-1`). */
function leadsWith(summary: string, name: string): boolean {
  const s = flatten(summary).toLocaleLowerCase();
  const n = name.toLocaleLowerCase();
  return s.startsWith(n) && !/^[\p{L}\p{N}_-]/u.test(s.slice(n.length));
}

/** One lock-screen body item: `<subject name>: <problem>`, or the problem alone when the summary already leads with the name. */
function bodyItem(c: Concern, label: string | undefined): string {
  const problem = cutAtWord(firstSentence(c.summary), BODY_ITEM_MAX);
  if (!label || leadsWith(c.summary, label)) return problem;
  return `${cutAtWord(label, BODY_LABEL_MAX)}: ${problem}`;
}

/** As many whole items as fit `BODY_MAX`, most urgent first; a first item too long on its own is cut at a word. */
function joinBodyItems(items: [string, ...string[]]): string {
  let body = '';
  for (const item of items) {
    const next = body ? `${body} · ${item}` : item;
    if ([...next].length > BODY_MAX) break;
    body = next;
  }
  return body || cutAtWord(items[0], BODY_MAX);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const rank = (c: Concern) => SEVERITY_DESC.indexOf(c.severity);
/** HIGH first, then the most recently updated. */
const byUrgency = (a: Concern, b: Concern) => rank(a) - rank(b) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

/** A live readiness concern (assessmentFinalizer `applyReadiness`): readiness subject (#10386), `evidence.readiness`. */
function isReadinessGap(c: Concern): boolean {
  return c.subject.kind === 'readiness' && typeof c.evidence?.readiness === 'object' && c.evidence.readiness !== null;
}

/** #11428: a concern needs you when an approval card waits on it, or when it is open and HIGH. */
function needsYou(c: Concern): boolean {
  return Boolean(c.approvalIntentId) || (c.status === 'open' && c.severity === 'high');
}

/** #11428: what "N open" counts and the body lists — open (not snoozed), and not Wisp's own readiness note. */
function isOpenConcern(c: Concern): boolean {
  return c.status === 'open' && c.subject.kind !== 'readiness';
}

/**
 * #11426: the children of an OPEN same-org rollup parent in the list. The
 * parent stands for them in the counts and the body ("3 devices: …"); they
 * stay listed under it everywhere else. A snoozed parent folds nothing: it
 * counts nowhere, so its children must count on their own.
 */
function foldedUnderRollup(live: Concern[]): Set<string> {
  const folded = new Set<string>();
  for (const c of live) {
    if (c.status === 'open' && isConcernRollup(c)) for (const id of c.childConcernIds) folded.add(id);
  }
  return folded;
}

/**
 * Subjects whose own name may lead a body item: identifiers, never free text
 * (a ticket subject stays off the lock screen, as in ticket push D11).
 */
const NAMED_SUBJECTS: Partial<Record<ConcernSubjectKind, WispEntityKind>> = { device: 'device', org: 'organization' };

/**
 * Each item's subject name, read through the ceiling-checked entity resolver.
 * A refusal or a failed read leaves that item without a name, not the brief
 * unsent.
 */
async function subjectNames(ceiling: GrantCeiling, items: Concern[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const named = items.filter((c) => NAMED_SUBJECTS[c.subject.kind]);
  if (named.length === 0) return names;
  const resolve = createEntityResolver({ ceiling });
  for (const c of named) {
    try {
      const entity = await resolve({ kind: NAMED_SUBJECTS[c.subject.kind]!, id: c.subject.id });
      if (!isResolveFailure(entity)) names.set(c.id, entity.label);
    } catch (error) {
      console.warn('[wisp/brief] subject name read failed; the item goes without it', { grantId: ceiling.grantId, concernId: c.id, error });
      captureException(error, undefined, { grantId: ceiling.grantId, concernId: c.id, area: 'wisp_brief' });
    }
  }
  return names;
}

/** The `ai_agent_runs.profile` of an assessment (activity.ts reads the same literal). */
const ASSESSMENT_PROFILE = 'assessment';
/**
 * The error code of a `skipped` assessment that #11423's deterministic
 * "nothing changed" gate is to record. Until it ships no run carries it, and
 * the skipped count is 0.
 */
const NO_CHANGES_ERROR_CODE = 'no_changes';

/**
 * Orgs whose runs this ceiling may read — the concerns.ts / activity.ts
 * `readableOrgIds` rule: a site-restricted ceiling cannot be shown to cover an
 * org-level row, so those orgs read nothing.
 */
function readableOrgIds(ceiling: GrantCeiling): string[] {
  if (ceiling.siteIds !== null) return [];
  return [...ceiling.orgIds].filter((id) => (ceiling.orgTerms.get(id)?.siteIds ?? null) === null);
}

/**
 * The grant's assessment runs since `since`, split into those that ran and
 * those #11423 skipped because nothing had changed. Counted in SQL, so the
 * Overnight line is not capped by the activity feed's page.
 */
async function assessmentCounts(ceiling: GrantCeiling, since: Date): Promise<{ ran: number; skipped: number }> {
  const readable = readableOrgIds(ceiling);
  if (readable.length === 0) return { ran: 0, skipped: 0 };
  // IS NOT DISTINCT FROM: a NULL error_code is "not skipped", never unknown (which FILTER would drop from both counts).
  const skipped = sql`(${aiAgentRuns.status} = 'skipped' AND ${aiAgentRuns.errorCode} IS NOT DISTINCT FROM ${NO_CHANGES_ERROR_CODE})`;
  const [row] = await inSystemContext(() => db
    .select({
      ran: sql<number>`count(*) FILTER (WHERE NOT ${skipped})::int`,
      skipped: sql<number>`count(*) FILTER (WHERE ${skipped})::int`,
    })
    .from(aiAgentRuns)
    .where(and(
      eq(aiAgentRuns.grantId, ceiling.grantId),
      eq(aiAgentRuns.profile, ASSESSMENT_PROFILE),
      inArray(aiAgentRuns.orgId, readable),
      sql`COALESCE(${aiAgentRuns.finishedAt}, ${aiAgentRuns.queuedAt}) >= ${since.toISOString()}::timestamptz`,
    )));
  return { ran: Number(row?.ran ?? 0), skipped: Number(row?.skipped ?? 0) };
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

  const [live, resolved, activity, spend, watches, runs] = await Promise.all([
    listConcernsForCeiling(ceiling, { status: ['open', 'snoozed'] }),
    listConcernsForCeiling(ceiling, { status: ['resolved'] }),
    listActivity(ceiling, { limit: ACTIVITY_LIMIT }),
    spendSummary(grantId, now),
    listWatches(ceiling),
    assessmentCounts(ceiling, since),
  ]);

  const sorted = [...live].sort(byUrgency);
  // A folded child needs you only for its own approval card; its HIGH is the parent's (severity = max).
  const folded = foldedUnderRollup(live);
  const needing = sorted.filter((c) => needsYou(c) && (!folded.has(c.id) || Boolean(c.approvalIntentId)));
  const open = sorted.filter((c) => isOpenConcern(c) && !folded.has(c.id));

  const title = needing.length === 0 && open.length === 0
    ? 'Good morning — nothing needs you'
    : `Good morning — ${needing.length} need you, ${open.length} open`;
  const items = open.slice(0, BODY_ITEMS);
  const names = await subjectNames(ceiling, items);
  const bodyItems = items.map((c) => bodyItem(c, names.get(c.id)));
  const body = bodyItems.length > 0
    ? joinBodyItems(bodyItems as [string, ...string[]])
    // Only snoozed concerns with an approval card waiting: the title already counts them.
    : needing.length > 0 ? 'Open Wisp to review.' : 'Nothing needs you right now.';

  const sections: BriefSection[] = [];
  const push = (heading: string, lines: string[]) => {
    if (lines.length > 0) sections.push({ heading, lines: lines.slice(0, SECTION_LINES_MAX) });
  };

  push('Needs you', needing.map((c) => c.summary));
  push('Open concerns', SEVERITY_DESC.flatMap((sev) => {
    const n = open.filter((c) => c.severity === sev).length;
    return n > 0 ? [`${sev}: ${n}`] : [];
  }));

  const recent = activity.items.filter((i) => new Date(i.at).getTime() >= since.getTime());
  const specialists = recent.filter((i) => i.kind === 'specialist').length;
  const resolvedCount = resolved.filter((c) => c.resolvedAt && new Date(c.resolvedAt).getTime() >= since.getTime()).length;
  push('Overnight', [
    ...(runs.ran > 0 ? [plural(runs.ran, 'assessment run', 'assessments run')] : []),
    ...(runs.skipped > 0 ? [`${plural(runs.skipped, 'assessment skipped', 'assessments skipped')} — nothing had changed`] : []),
    ...(specialists > 0 ? [plural(specialists, 'specialist launched', 'specialists launched')] : []),
    ...(resolvedCount > 0 ? [plural(resolvedCount, 'concern resolved', 'concerns resolved')] : []),
  ]);

  // Dollars, the same figures as the web spend meter (which orders them differently); AI spend is USD.
  // #10414: the total includes chat, so the line names both parts: "$2.00 of $5.00 today (background $0.30 · chat $1.70)".
  push('Spend', [`${usd(spend.spentTodayCents)} of ${usd(spend.budgetCentsPerDay)} today (background ${usd(spend.backgroundCents)} · chat ${usd(spend.chatCents)})`]);

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

type SweepGrant = {
  id: string; partnerId: string; grantorUserId: string; status: string; pausedReason: string | null;
  createdAt: Date;
};

/**
 * #10391: when this user's brief fires, resolved exactly as the sweep resolves it
 * (preference → phone → browser → partner → UTC) — for the Wisp chat seed.
 * `timeLocal` null = briefs off. Elects system scope for the device/partner reads.
 */
export async function briefScheduleFor(
  userId: string,
  partnerId?: string | null,
): Promise<{ timeLocal: string | null; timezone: string }> {
  const book = (await loadNudgeBookkeeping([userId])).get(userId);
  const prefs = book?.prefs ?? resolveWispNudgePrefs(null);
  const timeLocal = prefs.briefTimeLocal !== null && BRIEF_TIME_RE.test(prefs.briefTimeLocal) ? prefs.briefTimeLocal : null;
  // A valid preference zone wins outright: no device or partner read, as in the sweep.
  const preferred = prefs.briefTimezone && resolveBriefTimezone({ preference: prefs.briefTimezone }) === prefs.briefTimezone
    ? prefs.briefTimezone
    : null;
  if (preferred) return { timeLocal, timezone: preferred };
  const { phoneTz, partnerTz } = await inSystemContext(async () => ({
    phoneTz: await phoneTimezones([userId]),
    partnerTz: partnerId ? await partnerTimezones([partnerId]) : new Map<string, string>(),
  }));
  const timezone = resolveBriefTimezone({
    phone: phoneTz.get(userId),
    browser: book?.browserTimezone,
    partner: partnerId ? partnerTz.get(partnerId) : null,
  });
  return { timeLocal, timezone: safeTimeZone(timezone) };
}

export async function runMorningBriefs(now: Date = new Date()): Promise<{ due: number; sent: number; suppressed: number }> {
  const result = { due: 0, sent: 0, suppressed: 0 };
  // Dark by default: checked every run so the flag can flip without a restart.
  if (!wispEnabled()) return result;

  const { grants, phoneTz, partnerTz } = await inSystemContext(async () => {
    const rows: SweepGrant[] = await db
      .select({
        id: wispGrants.id,
        partnerId: wispGrants.partnerId,
        grantorUserId: wispGrants.grantorUserId,
        status: wispGrants.status,
        pausedReason: wispGrants.pausedReason,
        createdAt: wispGrants.createdAt,
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
    const partnerIds = [...new Set(eligible.map((g) => g.partnerId))];
    return { grants: eligible, phoneTz: await phoneTimezones(userIds), partnerTz: await partnerTimezones(partnerIds) };
  });
  if (grants.length === 0) return result;

  const userIds = [...new Set(grants.map((g) => g.grantorUserId))];
  const bookkeeping = await loadNudgeBookkeeping(userIds);

  for (const grant of grants) {
    try {
      const book = bookkeeping.get(grant.grantorUserId);
      const prefs = book?.prefs ?? resolveWispNudgePrefs(null);
      const lastBriefAt = book?.lastBriefAt ?? null;
      const zone = resolveBriefTimezone({
        preference: prefs.briefTimezone,
        phone: phoneTz.get(grant.grantorUserId),
        browser: book?.browserTimezone,
        partner: partnerTz.get(grant.partnerId),
      });
      const { due, localDate } = briefDue({ ...prefs, briefTimezone: zone }, lastBriefAt, now, 'UTC', grant.createdAt);
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
