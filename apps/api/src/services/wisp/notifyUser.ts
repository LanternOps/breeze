/**
 * Wisp W06 — `notifyUser`, the ONE nudge delivery primitive (Wisp design
 * §7.4, §7.6; w00 "Nudges (W06)", A18, A20, A28, A29).
 *
 * Callers: the assessment finalizer's `nudge` step, the incident correlator's
 * partner-level nudge, the digest sweep, the morning brief and the check-in
 * fire path (services/wisp/checkIns.ts, #10991), the specialist post-back
 * (services/wisp/specialistResult.ts, #11085), the first-look post
 * (services/wisp/firstLook.ts, #10402) and the resolved-nudge follow-up
 * (services/wisp/nudgeResolved.ts, #11427)
 * (pinned by notifyUser.callers.contract.test.ts). None is reached while
 * `wispEnabled()` is false.
 *
 * Shape (two-phase, like ticketPush.ts — no network call inside an open DB
 * context, #1105):
 *   1. ONE system context opened from outside any request context reads the
 *      thread + grant (cross-checked against the payload), the concern and
 *      the recipient's backoff state, the user's preferences, the partner's
 *      urgent-capable set and the user's push targets. The context closes.
 *   2. `deliverInApp` (W05's single `createNotification` site, A18) writes the
 *      in-app row under its own system context; its dedupe key makes a repeat
 *      call inside one backoff window a no-op. The delivery is also recorded
 *      as a thread post (W02a #10212, quorum B) WHATEVER the channels: with
 *      the in-app channel on, `deliverInApp` writes notification and post in
 *      one callback; with it off, `recordThreadPost` runs under its own
 *      system context here. Same dedupe key, so a retry writes no second post.
 *   3. A concern nudge is COUNTED (`recordNudge`) whenever it got past the
 *      recipient backoff gate — delivered, filtered by preferences or quiet
 *      hours, throttled, or found already delivered by an earlier attempt that
 *      died before counting it. Counting here (not in each caller) is what
 *      keeps a crash between delivery and count from silencing the concern
 *      forever: the dedupe key is derived from `next_eligible_nudge_at`, so an
 *      uncounted delivery would otherwise dedupe every later attempt.
 *   4. Push, after every context has closed.
 */
import { and, eq } from 'drizzle-orm';
import type { BriefSection, ConcernSeverity, WispNudgeKind, WispNudgePreferences } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { wispGrants } from '../../db/schema/wisp';
import { wispConcerns } from '../../db/schema/wispConcerns';
import { wispThreads } from '../../db/schema/wispThreads';
import { buildWispNudgePush, dispatchPushToTokens, type TaggedPushToken } from '../expoPush';
import { checkNotificationThrottle } from '../notificationThrottle';
import { captureException } from '../sentry';
import { isInQuietHours, type QuietHoursConfig } from '../quietHours';
import { userPushTargetsQuery } from '../ticketPush';
import { recipientState, recordNudge } from './concerns';
import { deliverInApp, type ThreadPostDraft } from './deliver';
import { webCheckInLink, webDeepLink } from './nudgeLinks';
import { loadNudgePrefs } from './nudgePreferences';
import { loadUrgentCapableSeverities } from './partnerNudgeSettings';
import { couldntLookDedupeKey, recordThreadPost, type ThreadPostKind } from './threadPosts';
import { GrantInactiveError, resolveGrantCeiling, type GrantCeiling } from './grantAuthority';
import { incWispNudge } from '../wispMetrics';

/** The post kind of each nudge kind (explicit: a budget notice is never a post). */
const POST_KIND: Record<WispNudgeKind, ThreadPostKind> = {
  concern: 'nudge', digest: 'digest', brief: 'brief', check_in: 'check_in', specialist_result: 'specialist_result', first_look: 'first_look',
  nudge_resolved: 'nudge_resolved',
};

/** Kinds that name one concern (`concernId` set iff the kind is one of these). */
const CONCERN_KINDS: ReadonlySet<WispNudgeKind> = new Set(['concern', 'nudge_resolved']);

/** `wisp.specialist_result:<runId>:<status>` or `wisp.specialist_step:<intentId>:<status>` (specialistResult.ts). */
const SPECIALIST_DEDUPE_KEY_RE = /^wisp\.specialist_(result|step):[A-Za-z0-9-]{1,64}:[a-z_]{1,32}$/;
/** A same-origin relative path: one leading slash, never `//` or a scheme. */
const RELATIVE_LINK_RE = /^\/(?!\/)[^\s\\]*$/;

export type NudgePayload = {
  userId: string;
  category: 'wisp_nudge';
  /** w00 A28: one concern, the digest of digest-only concerns, or the morning brief. */
  kind: WispNudgeKind;
  title: string;
  body: string;
  deepLink: string;
  /**
   * Set iff kind is 'concern' or 'nudge_resolved' (#11427: the follow-up that a
   * nudged concern closed; the concern must already read `resolved`).
   */
  concernId: string | null;
  threadId: string;
  /** w00 A20: must equal the thread's grant; the thread is a cross-check, not the source. */
  grantId: string;
  approvalIntentId?: string | null;
  /** kind 'brief' only: the brief's local calendar date (YYYY-MM-DD) — the dedupe key. */
  briefLocalDate?: string;
  /** kind 'brief' only: stored in the in-app row's `metadata.brief`. */
  briefSections?: BriefSection[];
  /**
   * Set iff kind === 'check_in' (#10991): the fired `wisp_check_ins` row. Its
   * id is the dedupe key and the link fragment; its org (the thread's) is the
   * notification's and the post's org. `link` (W07 #11496) replaces the
   * post's check-in link: a run check-in's result links to its run page
   * (relative, same origin).
   */
  checkIn?: { id: string; orgId: string | null; link?: string };
  /**
   * Set iff kind === 'specialist_result' (#11085): a device-troubleshooting
   * run's report (or one of its approved steps). `orgId` is the run's org: it
   * is validated against the grant ceiling (the same readable-org rule the
   * thread timeline applies, pinned revision ∩ live, a paused grant allowed)
   * and becomes the notification's and the post's org. `dedupeKey` is the
   * caller's per-run / per-step key; `link` the run page (relative).
   */
  specialist?: { orgId: string; grantRevisionId: string; dedupeKey: string; link: string };
  /**
   * kind 'first_look' only (#11145): the post that says no org could be looked
   * at. It has its own dedupe key, so it leaves the real first look still to come.
   */
  firstLookVariant?: 'couldnt_look';
  /**
   * `false` withholds the push channel for this delivery (the in-app row and
   * the post are still written per the user's channels). A specialist_result
   * never pushes whatever this says: its steps already pushed their own
   * approval cards.
   */
  push?: false;
};

/** One first-look post per grant (#10402). */
export function firstLookDedupeKey(grantId: string): string {
  return `wisp.first_look:${grantId}`;
}

/** One resolved-nudge follow-up per concern (#11427); unique per thread (post) and per user (notification). */
export function nudgeResolvedDedupeKey(concernId: string): string {
  return `wisp.nudge_resolved:${concernId}`;
}

export type NudgeSuppressedReason = 'quiet_hours' | 'prefs' | 'backoff' | null;
export type NotifyUserResult = { inApp: boolean; pushed: number; suppressed: NudgeSuppressedReason };

/** Push throttle: at most 12 Wisp pushes per user per hour (reported as 'backoff'). */
export const WISP_NUDGE_THROTTLE_CHANNEL = 'wisp-nudge';
export const WISP_NUDGE_THROTTLE_MAX = 12;
export const WISP_NUDGE_THROTTLE_WINDOW_S = 3600;

const BACKOFF: NotifyUserResult = { inApp: false, pushed: 0, suppressed: 'backoff' };

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

/**
 * The in-app dedupe key (user_notifications_user_dedupe_key_uq):
 *   concern → wisp.nudge:<concern>:<grant>:<next_eligible_nudge_at | first>
 *   digest  → wisp.digest:<thread>:<now floored to the cadence, UTC>
 *   brief   → wisp.brief:<thread>:<local date>
 *   check_in → wisp.check_in:<check-in id> (one delivery per check-in, ever)
 *   first_look → wisp.first_look:<grant> (one per grant, ever)
 *                wisp.first_look_failed:<grant> for the couldn't-look variant (likewise)
 *   nudge_resolved → wisp.nudge_resolved:<concern> (one follow-up per concern and thread/user, ever)
 */
export function nudgeDedupeKey(k: {
  kind?: WispNudgeKind;
  concernId: string | null;
  grantId: string;
  threadId: string;
  nextEligibleNudgeAt: Date | null;
  now: Date;
  digestCadenceMinutes: number;
  briefLocalDate?: string;
  checkInId?: string;
  firstLookVariant?: 'couldnt_look';
}): string {
  const kind = k.kind ?? (k.concernId ? 'concern' : 'digest');
  if (kind === 'check_in') {
    if (!k.checkInId) throw new Error('nudgeDedupeKey: a check_in key needs checkInId');
    return `wisp.check_in:${k.checkInId}`;
  }
  if (kind === 'first_look') return k.firstLookVariant === 'couldnt_look' ? couldntLookDedupeKey(k.grantId) : firstLookDedupeKey(k.grantId);
  if (kind === 'nudge_resolved') {
    if (!k.concernId) throw new Error('nudgeDedupeKey: a nudge_resolved key needs concernId');
    return nudgeResolvedDedupeKey(k.concernId);
  }
  if (kind === 'concern') {
    return `wisp.nudge:${k.concernId}:${k.grantId}:${k.nextEligibleNudgeAt?.toISOString() ?? 'first'}`;
  }
  if (kind === 'brief') return `wisp.brief:${k.threadId}:${k.briefLocalDate}`;
  const bucketMs = Math.max(1, Math.trunc(k.digestCadenceMinutes)) * 60_000;
  return `wisp.digest:${k.threadId}:${new Date(Math.floor(k.now.getTime() / bucketMs) * bucketMs).toISOString()}`;
}

const SEVERITY_RANK: Record<ConcernSeverity, number> = { info: 0, low: 1, medium: 2, high: 3 };
const PROACTIVITY_FLOOR: Record<WispNudgePreferences['proactivity'], number> = { quiet: 3, normal: 2, chatty: 0 };

/**
 * Who gets what (pure). Order: channels → proactivity floor (w00 A29: quiet ⇒
 * high only, normal ⇒ medium+, chatty ⇒ all; the brief and a nudge carrying
 * an approval card always pass, and so does a check-in — the user's own thread
 * asked for it; a digest ranks as medium) → per-device quiet
 * hours (a device breaks through only for an urgent-capable concern when the
 * user chose `urgent_only`; the brief ignores quiet hours — the user picked
 * its time). `suppressed` is null whenever something was pushed.
 */
export function decideNudgeDelivery(input: {
  prefs: WispNudgePreferences;
  kind: WispNudgeKind;
  severity: ConcernSeverity | null;
  hasApprovalCard: boolean;
  urgentCapable: boolean;
  devices: Array<{ tokens: TaggedPushToken[]; quietHours: QuietHoursConfig | null }>;
  now: Date;
}): { inApp: boolean; pushTokens: TaggedPushToken[]; suppressed: NudgeSuppressedReason } {
  const { prefs } = input;
  const inApp = prefs.channels.inApp;
  if (!prefs.channels.inApp && !prefs.channels.push) return { inApp: false, pushTokens: [], suppressed: 'prefs' };
  if (!prefs.channels.push) return { inApp, pushTokens: [], suppressed: 'prefs' };

  const alwaysPush = input.kind === 'brief' || input.kind === 'check_in' || (input.kind === 'concern' && input.hasApprovalCard);
  if (!alwaysPush) {
    const rank = input.severity ? SEVERITY_RANK[input.severity] : SEVERITY_RANK.medium;
    if (rank < PROACTIVITY_FLOOR[prefs.proactivity]) return { inApp, pushTokens: [], suppressed: 'prefs' };
  }

  const withTokens = input.devices.filter((d) => d.tokens.length > 0);
  if (withTokens.length === 0) return { inApp, pushTokens: [], suppressed: null };

  const breakThrough = input.kind === 'brief' || (input.urgentCapable && prefs.quietOverride === 'urgent_only');
  const awake = breakThrough ? withTokens : withTokens.filter((d) => !isInQuietHours(d.quietHours, input.now));
  if (awake.length === 0) return { inApp, pushTokens: [], suppressed: 'quiet_hours' };
  return { inApp, pushTokens: awake.flatMap((d) => d.tokens), suppressed: null };
}

// ---------------------------------------------------------------------------
// notifyUser
// ---------------------------------------------------------------------------

type DeviceRow = { fcm: string | null; apns: string | null; platform: 'ios' | 'android'; quietHours: unknown };

function tagTokens(row: DeviceRow): TaggedPushToken[] {
  const out: TaggedPushToken[] = [];
  for (const token of [row.apns, row.fcm]) {
    if (!token) continue;
    out.push({
      token,
      platform: row.platform,
      provider: token.startsWith('ExponentPushToken') ? 'expo' : row.platform === 'ios' ? 'apns' : 'fcm',
    });
  }
  return out;
}

function assertPayloadShape(p: NudgePayload): void {
  if (CONCERN_KINDS.has(p.kind) && !p.concernId) throw new Error(`notifyUser: a ${p.kind} nudge needs a concernId`);
  if (!CONCERN_KINDS.has(p.kind) && p.concernId !== null) throw new Error(`notifyUser: a ${p.kind} nudge carries no concernId`);
  if (p.kind === 'brief' && !p.briefLocalDate) throw new Error('notifyUser: a brief needs briefLocalDate');
  if (p.kind === 'check_in' && !p.checkIn?.id) throw new Error('notifyUser: a check_in nudge needs checkIn');
  if (p.kind !== 'check_in' && p.checkIn !== undefined) throw new Error(`notifyUser: a ${p.kind} nudge carries no checkIn`);
  if (p.checkIn?.link !== undefined && !RELATIVE_LINK_RE.test(p.checkIn.link)) throw new Error('notifyUser: a check_in link must be a relative path');
  if (p.kind === 'specialist_result') {
    if (!p.specialist?.orgId || !p.specialist.grantRevisionId) throw new Error('notifyUser: a specialist_result needs specialist');
    if (!SPECIALIST_DEDUPE_KEY_RE.test(p.specialist.dedupeKey)) {
      throw new Error(`notifyUser: a specialist_result dedupe key must be wisp.specialist_(result|step):<id>:<status>`);
    }
    if (!RELATIVE_LINK_RE.test(p.specialist.link)) throw new Error('notifyUser: a specialist_result link must be a relative path');
  } else if (p.specialist !== undefined) {
    throw new Error(`notifyUser: a ${p.kind} nudge carries no specialist`);
  }
}

/**
 * Could the grant's thread timeline show a post of `orgId`? The timeline's own
 * rule (threadTimeline.ts `readableOrgIds`): the org is inside the ceiling and
 * neither the ceiling nor the grantor's membership of that org is
 * site-restricted. Posting anything the timeline would hide is refused.
 */
export function isOrgReadableOnThread(ceiling: Pick<GrantCeiling, 'orgIds' | 'siteIds' | 'orgTerms'>, orgId: string): boolean {
  if (ceiling.siteIds !== null) return false;
  if (!ceiling.orgIds.has(orgId)) return false;
  return (ceiling.orgTerms.get(orgId)?.siteIds ?? null) === null;
}

/** A specialist report the grant's thread may not carry (now): an expected skip, not a fault. */
export class SpecialistAudienceRefusedError extends Error {
  constructor(public readonly reason: 'grant_inactive' | 'org_out_of_ceiling', message: string) {
    super(message);
    this.name = 'SpecialistAudienceRefusedError';
  }
}

/**
 * Who a specialist report about `orgId` goes to under (grant, revision), or
 * why it may not go anywhere. The ONE non-route `allowPaused` read
 * (allowPaused.contract.test.ts): READ-ONLY — the ceiling only answers "could
 * the grant's own thread show this org" (`isOrgReadableOnThread`) and names
 * the grantor; it never authorises an action. Paused is allowed on purpose: a
 * run stopped by a pause must still say so on the thread (Review Focus 2),
 * while a grantor who lost the org (or every org) gets nothing.
 */
export async function resolveSpecialistPostAudience(grantId: string, grantRevisionId: string, orgId: string):
  Promise<{ ok: true; grantorUserId: string } | { ok: false; reason: 'grant_inactive' | 'org_out_of_ceiling' }> {
  let ceiling: GrantCeiling;
  try {
    ceiling = await runOutsideDbContext(() => resolveGrantCeiling(grantId, grantRevisionId, { allowPaused: true }));
  } catch (err) {
    if (err instanceof GrantInactiveError) return { ok: false, reason: 'grant_inactive' };
    throw err;
  }
  if (!isOrgReadableOnThread(ceiling, orgId)) return { ok: false, reason: 'org_out_of_ceiling' };
  return { ok: true, grantorUserId: ceiling.grantorUserId };
}

const sameInstant = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

export async function notifyUser(p: NudgePayload): Promise<NotifyUserResult> {
  const result = await deliverNudge(p);
  incWispNudge(result.suppressed ? (`suppressed_${result.suppressed}` as const) : 'sent');
  return result;
}

async function deliverNudge(p: NudgePayload): Promise<NotifyUserResult> {
  assertPayloadShape(p);
  const now = new Date();

  // A specialist report carries the run's org: refuse it unless the thread
  // could show it (an org-less or out-of-ceiling post would bypass the
  // timeline's org filter). Resolved before any context opens: the ceiling
  // read opens its own. Throws (nothing written) — the caller decides.
  if (p.specialist) {
    const audience = await resolveSpecialistPostAudience(p.grantId, p.specialist.grantRevisionId, p.specialist.orgId);
    if (!audience.ok) {
      // Typed: the grant can change between the caller's check and this one.
      throw new SpecialistAudienceRefusedError(
        audience.reason,
        `notifyUser: org ${p.specialist.orgId} is outside what grant ${p.grantId}'s thread may show (${audience.reason})`,
      );
    }
    if (audience.grantorUserId !== p.userId) throw new Error(`notifyUser: user ${p.userId} is not the grantor of grant ${p.grantId}`);
  }

  // Phase 1 — reads, in one system context opened outside any request context.
  const read = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const [thread] = await db
      .select({ grantId: wispThreads.grantId, partnerId: wispThreads.partnerId, grantorUserId: wispGrants.grantorUserId })
      .from(wispThreads)
      .innerJoin(wispGrants, and(eq(wispGrants.id, wispThreads.grantId), eq(wispGrants.partnerId, wispThreads.partnerId)))
      .where(eq(wispThreads.id, p.threadId))
      .limit(1);
    if (!thread) throw new Error(`notifyUser: thread ${p.threadId} not found`);
    if (thread.grantId !== p.grantId) throw new Error(`notifyUser: thread ${p.threadId} belongs to another grant`);
    if (thread.grantorUserId !== p.userId) throw new Error(`notifyUser: user ${p.userId} is not the grantor of grant ${p.grantId}`);

    let concern: { orgId: string | null; severity: ConcernSeverity } | null = null;
    let state: Awaited<ReturnType<typeof recipientState>> | null = null;
    if (p.concernId) {
      const [c] = await db
        .select({ orgId: wispConcerns.orgId, partnerId: wispConcerns.partnerId, severity: wispConcerns.severity, status: wispConcerns.status })
        .from(wispConcerns)
        .where(eq(wispConcerns.id, p.concernId))
        .limit(1);
      if (!c || c.partnerId !== thread.partnerId) throw new Error(`notifyUser: concern ${p.concernId} not found under the thread's partner`);
      if (p.kind === 'nudge_resolved') {
        // The follow-up says the concern closed: only a committed resolution
        // qualifies (a resolve inside a caller's still-open transaction, or
        // one rolled back, reads live here and writes nothing). Not a nudge:
        // no recipient backoff applies and nothing is counted.
        if (c.status !== 'resolved') return { backoff: true as const };
        concern = { orgId: c.orgId, severity: c.severity };
      } else {
        if (c.status !== 'open' && c.status !== 'snoozed') return { backoff: true as const };
        state = await recipientState(p.concernId, p.grantId);
        const future = (d: Date | null) => d !== null && d.getTime() > now.getTime();
        if (state.dismissedAt || future(state.snoozedUntil) || future(state.nextEligibleNudgeAt)) return { backoff: true as const };
        concern = { orgId: c.orgId, severity: c.severity };
      }
    }

    const prefs = await loadNudgePrefs(p.userId);
    const urgent = concern && p.kind === 'concern' ? await loadUrgentCapableSeverities(thread.partnerId) : [];
    const devices = (await userPushTargetsQuery([p.userId])) as DeviceRow[];
    return { backoff: false as const, partnerId: thread.partnerId, concern, state, prefs, urgent, devices };
  }));
  if (read.backoff) return BACKOFF;

  const { concern, state, prefs, partnerId } = read;
  const decision = decideNudgeDelivery({
    prefs,
    kind: p.kind,
    severity: concern?.severity ?? null,
    hasApprovalCard: !!p.approvalIntentId,
    urgentCapable: concern !== null && read.urgent.includes(concern.severity),
    devices: read.devices.map((d) => ({ tokens: tagTokens(d), quietHours: (d.quietHours ?? null) as QuietHoursConfig | null })),
    now,
  });

  // Phase 2 — the in-app row and the thread post (one system context, closed
  // on return). The post is written whatever the channels (W02a, quorum B):
  // a push-only or all-off user still keeps the history on the thread.
  const orgId = p.specialist ? p.specialist.orgId : p.checkIn ? p.checkIn.orgId : concern?.orgId ?? null;
  const link = p.specialist
    ? p.specialist.link
    : p.checkIn ? p.checkIn.link ?? webCheckInLink(p.threadId, p.checkIn.id) : webDeepLink(p.threadId, p.concernId);
  const dedupeKey = p.specialist ? p.specialist.dedupeKey : nudgeDedupeKey({
    kind: p.kind,
    concernId: p.concernId,
    grantId: p.grantId,
    threadId: p.threadId,
    nextEligibleNudgeAt: state?.nextEligibleNudgeAt ?? null,
    now,
    digestCadenceMinutes: prefs.digestCadenceMinutes,
    briefLocalDate: p.briefLocalDate,
    checkInId: p.checkIn?.id,
    firstLookVariant: p.firstLookVariant,
  });
  const post: ThreadPostDraft = {
    threadId: p.threadId,
    partnerId,
    grantId: p.grantId,
    orgId,
    kind: POST_KIND[p.kind],
    title: p.title,
    body: p.body,
    link,
    sections: p.kind === 'brief' ? p.briefSections ?? null : null,
    concernId: p.concernId,
  };
  let created = false;
  if (!decision.inApp) {
    // Throws like deliverInApp would: nothing is committed yet, the caller retries.
    await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      recordThreadPost({ ...post, dedupeKey, notificationId: null })));
  } else {
    const res = await deliverInApp({
      userId: p.userId,
      orgId,
      title: p.title,
      body: p.body,
      link,
      priority: p.kind === 'concern' && concern?.severity === 'high' ? 'high' : 'normal',
      dedupeKey,
      concernId: p.concernId,
      approvalIntentId: p.approvalIntentId ?? null,
      threadId: p.threadId,
      grantId: p.grantId,
      deepLink: p.deepLink,
      ...(p.kind === 'brief' && p.briefSections ? { brief: p.briefSections } : {}),
      post,
    });
    created = res.created;
    if (!created) {
      // Already delivered for this window by an earlier attempt. Count it only
      // if nobody has since (that attempt may have died before counting).
      if (p.concernId && state) {
        const again = await recipientState(p.concernId, p.grantId);
        if (sameInstant(again.nextEligibleNudgeAt, state.nextEligibleNudgeAt)) await countNudge(p.concernId, p.grantId, now);
      }
      return BACKOFF;
    }
  }

  // From here on the in-app row is committed: a later failure must not throw
  // (a retry would hit the dedupe key and never push), so each step reports
  // and carries on.

  // Phase 3 — count the concern nudge (a nudge_resolved follow-up is not one).
  if (p.kind === 'concern' && p.concernId) await countNudge(p.concernId, p.grantId, now);

  // Phase 4 — push, outside every DB context. Withheld entirely (not a
  // suppression) for `push: false`, every specialist report, the first look
  // and a resolved-nudge follow-up ("no action needed" never wakes a phone).
  const pushKind = p.kind === 'specialist_result' || p.kind === 'first_look' || p.kind === 'nudge_resolved' || p.push === false
    ? null
    : p.kind;
  let pushTokens = pushKind ? decision.pushTokens : [];
  let suppressed = pushKind ? decision.suppressed : null;
  if (pushTokens.length > 0) {
    try {
      const throttle = await checkNotificationThrottle(WISP_NUDGE_THROTTLE_CHANNEL, `user:${p.userId}`, WISP_NUDGE_THROTTLE_MAX, WISP_NUDGE_THROTTLE_WINDOW_S);
      if (!throttle.allowed) {
        console.warn(`[wisp.notifyUser] push throttled user=${p.userId} count=${throttle.currentCount}`);
        pushTokens = [];
        suppressed = 'backoff';
      }
    } catch (err) {
      // Fail open, like the throttle itself when Redis is unavailable.
      reportAfterCommit('throttle', err, p);
    }
  }
  let pushed = 0;
  if (pushKind && pushTokens.length > 0) {
    try {
      const result = await dispatchPushToTokens(
      pushTokens,
      buildWispNudgePush({
        threadId: p.threadId,
        concernId: p.concernId,
        grantId: p.grantId,
        title: p.title,
        body: p.body,
        deepLink: p.deepLink,
        approvalIntentId: p.approvalIntentId ?? null,
        kind: pushKind,
      }),
      WISP_NUDGE_THROTTLE_CHANNEL,
    );
      pushed = result.dispatched;
    } catch (err) {
      reportAfterCommit('push', err, p);
    }
  }
  return { inApp: created, pushed, suppressed };
}

function reportAfterCommit(op: string, err: unknown, p: NudgePayload): void {
  console.error(`[wisp.notifyUser] ${op} failed after the in-app row was written`, { grantId: p.grantId, kind: p.kind, err });
  captureException(err, undefined, { op: `wisp.notifyUser.${op}`, grantId: p.grantId, kind: p.kind });
}

/**
 * recordNudge, reported instead of thrown: a lost count is recovered by the
 * next attempt (its dedupe hit counts it), a thrown one would cost the push.
 */
async function countNudge(concernId: string, grantId: string, now: Date): Promise<void> {
  try {
    await recordNudge(concernId, grantId, now);
  } catch (err) {
    console.error('[wisp.notifyUser] recordNudge failed; the next attempt counts it', { concernId, grantId, err });
    captureException(err, undefined, { op: 'wisp.notifyUser.recordNudge', concernId, grantId });
  }
}
