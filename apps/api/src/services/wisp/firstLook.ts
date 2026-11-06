/**
 * #10402 — one "first look" post per grant. Onboarding assesses the first orgs
 * of a new grant within minutes, but the first thing the user used to hear was
 * the next morning's brief: the home kept saying "I'm looking around", with no
 * sign of whether it had finished. When the batch has settled, this writes one
 * `first_look` thread post through `notifyUser` (no push): orgs looked at and
 * still queued, open concerns by severity, what Wisp cannot watch.
 *
 * Two callers: `finishRun` (runLoop.ts) after every assessment's final status is
 * committed, and the grant reconciler's sweep, which picks up what that misses:
 * a crash before the post, a run that a cancel or the reaper ended, and a batch
 * org that never got a run at all (its admission was skipped, so nothing else
 * would ever call this).
 *
 * The batch is the org list onboarding asked for (`onboardingBatch`). It is done
 * when each of those orgs has a settled run, or FIRST_LOOK_GRACE_MS after the
 * grant was created, whichever comes first.
 *
 * #11145: a batch that settles with nothing looked at gets a post of its own, a
 * `first_look` with the couldn't-look key: "I've had a first look" would be
 * false, and without it the user keeps reading "I'm looking around" while every
 * run fails. It says what was attempted, why by category, and when Wisp retries.
 * The retry is the floor tick, one org per tick (the reconciler only re-checks
 * this post; it runs no assessment), which a spent budget holds off until the UTC
 * day rolls. A look on a later tick still gets the real first look, even past the
 * first day, because the user was told one was coming.
 *
 * Exactly one post of each per grant: the dedupe key is the post's (thread_id,
 * dedupe_key) unique key, so concurrent runs and the sweep land on one row. The
 * body is built from counts and fixed labels only: no org or device names, and
 * no text that came from a device, a model or a provider. An `error_code` picks a
 * category and is never shown.
 *
 * Reads run under short system contexts of their own (the callers hold none).
 * A grant that should not post returns `{ posted: false, reason }`; a real
 * failure (DB, notifyUser) throws and the callers report it.
 */
import { and, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { CONCERN_SEVERITIES, type ConcernSeverity, type WatchKind } from '@breeze/shared';
import { wispEnabled } from '../../config/env';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { ASSESSMENT_BUDGET_CENTS_PER_RUN } from '../aiAgents/assessmentProfile';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { wispGrants } from '../../db/schema/wisp';
import { wispThreadPosts } from '../../db/schema/wispThreadPosts';
import { captureException } from '../sentry';
import { assessableOrgIds } from './assessableOrgs';
import type { OrgReadiness } from './assessmentTypes';
import { chargeableUnderGrant, utcDayWindow } from './budget';
import { listConcernsForCeiling } from './concerns';
import { GrantInactiveError, resolveGrantCeiling, type GrantCeiling } from './grantAuthority';
import { firstLookDedupeKey, notifyUser } from './notifyUser';
import { mobileDeepLink } from './nudgeLinks';
import { loadBriefSchedule } from './nudgePreferences';
import { readinessInventory } from './readiness';
import { ASSESSED_STATUSES, IN_FLIGHT_STATUSES, SETTLED_STATUSES } from './standingLoop';
import { couldntLookDedupeKey, FIRST_LOOK_WINDOW_MS } from './threadPosts';
import { getOrCreateThread } from './threads';
import { loadLivePartnerOrgs, onboardingBatch, WISP_WAKE_TICK_INTERVAL_MS } from './wake';

export { firstLookDedupeKey } from './notifyUser';
// The post is about a grant's first day, and must not reach grants that predate it.
export { couldntLookDedupeKey, FIRST_LOOK_WINDOW_MS };
/** How long a batch org with no settled run holds the post (its admission may have been skipped: no run is coming). */
export const FIRST_LOOK_GRACE_MS = 30 * 60 * 1000;
/** At most this many grants per reconciler tick (newest first). */
export const FIRST_LOOK_RESWEEP_LIMIT = 100;

export type FirstLookSkip =
  | 'wisp_disabled'
  | 'grant_not_found'
  | 'grant_inactive'
  | 'past_window'
  | 'already_posted'
  | 'in_progress'
  /** No org to look at: nothing was attempted, so there is nothing to report. */
  | 'nothing_looked_at'
  | 'couldnt_look_posted';

export type FirstLookResult = { posted: true; variant: 'first_look' | 'couldnt_look' } | { posted: false; reason: FirstLookSkip };

/** `evidence.reason` on the no-agent readiness concern (assessment.ts raiseNoAgentReadiness). */
const NO_AGENT_EVIDENCE_REASON = 'no_effective_agent';

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

export function firstLookBatchDone(input: {
  batchOrgIds: string[];
  settledOrgIds: ReadonlySet<string>;
  grantCreatedAt: Date;
  now: Date;
}): boolean {
  const { batchOrgIds, settledOrgIds, grantCreatedAt, now } = input;
  if (now.getTime() - grantCreatedAt.getTime() >= FIRST_LOOK_GRACE_MS) return true;
  return batchOrgIds.length > 0 && batchOrgIds.every((id) => settledOrgIds.has(id));
}

/** What the user reads for a kind Wisp cannot watch; null = always serviceable. The two ticket kinds are one topic. */
const WATCH_TOPIC: Record<WatchKind, string | null> = {
  ticket_waiting: 'tickets',
  ticket_cluster: 'tickets',
  alert_pattern: 'monitors and alert rules',
  backup_health: 'backups',
  patch_compliance: 'patch compliance',
  security_findings: 'security findings',
  custom_query: null,
};

export type WatchGap = { label: string; orgCount: number };

/** Orgs per topic Wisp cannot watch, most affected first. */
export function summarizeWatchGaps(inventory: OrgReadiness[]): WatchGap[] {
  const orgsByTopic = new Map<string, Set<string>>();
  for (const org of inventory) {
    for (const check of org.checks) {
      const label = WATCH_TOPIC[check.watchKind];
      if (check.serviceable || label === null) continue;
      const orgs = orgsByTopic.get(label) ?? new Set<string>();
      orgs.add(org.orgId);
      orgsByTopic.set(label, orgs);
    }
  }
  return [...orgsByTopic]
    .map(([label, orgs]) => ({ label, orgCount: orgs.size }))
    .sort((a, b) => (b.orgCount - a.orgCount) || (a.label < b.label ? -1 : 1));
}

const orgs = (n: number) => `${n} ${n === 1 ? 'organization' : 'organizations'}`;

export function renderFirstLookPost(input: {
  totalOrgs: number;
  lookedAtOrgs: number;
  unfinishedOrgs: number;
  stillQueuedOrgs: number;
  /** In the ceiling but reached only through some sites: never assessed (assessableOrgIds). */
  restrictedOrgs: number;
  concerns: Record<ConcernSeverity, number>;
  /** null = the readiness inventory could not be read: unknown, which must not read as "no gaps". */
  watchGaps: WatchGap[] | null;
}): { title: string; body: string } {
  const { totalOrgs, lookedAtOrgs, unfinishedOrgs, stillQueuedOrgs, restrictedOrgs, concerns, watchGaps } = input;

  const coverage = [
    lookedAtOrgs === totalOrgs
      ? `I looked at your ${orgs(totalOrgs)}.`
      : `I looked at ${lookedAtOrgs} of your ${orgs(totalOrgs)}.`,
  ];
  if (stillQueuedOrgs > 0) {
    coverage.push(`${stillQueuedOrgs} more ${stillQueuedOrgs === 1 ? 'is' : 'are'} still queued for my regular checks.`);
  }
  if (unfinishedOrgs > 0) coverage.push(`I could not finish ${orgs(unfinishedOrgs)}; my regular checks try again.`);

  // CONCERN_SEVERITIES runs low → high; the post reads worst first.
  const open = [...CONCERN_SEVERITIES].reverse().filter((s) => concerns[s] > 0).map((s) => `${concerns[s]} ${s}`);
  const concernLine = open.length > 0 ? `Open concerns: ${open.join(', ')}.` : 'No open concerns so far.';

  const cannotWatch = (watchGaps ?? []).map((g) => `${g.label} in ${orgs(g.orgCount)}`);
  if (restrictedOrgs > 0) cannotWatch.push(`${orgs(restrictedOrgs)} you reach only through some of their sites`);

  const paragraphs = [coverage.join(' '), concernLine];
  if (watchGaps === null) {
    const known = cannotWatch.length > 0 ? ` I do know I can't watch ${cannotWatch.join('; ')}.` : '';
    paragraphs.push(`I couldn't check what I can't watch yet.${known}`);
  } else if (cannotWatch.length > 0) {
    paragraphs.push(`What I can't watch yet: ${cannotWatch.join('; ')}.`);
  }
  return {
    title: `First look done: ${lookedAtOrgs} of ${orgs(totalOrgs)}`,
    body: paragraphs.join('\n\n'),
  };
}

export type FirstLookFailureCategory = 'budget' | 'model_unavailable' | 'no_agent' | 'not_admitted' | 'internal';
export type FirstLookFailureSummary = { category: FirstLookFailureCategory; orgCount: number };
type FailedRun = { status: string; errorCode: string | null };

/** The codes `ai_agent_runs.error_code` carries that have a category of their own (agentCircuit.ts lists where they come from). */
const FAILURE_CODE_CATEGORY: ReadonlyMap<string, FirstLookFailureCategory> = new Map<string, FirstLookFailureCategory>([
  ['llm_unavailable', 'model_unavailable'],
  ['sdk_error', 'model_unavailable'],
  ['sdk_output_error', 'model_unavailable'],
  // Out of time or turns with nothing produced: "couldn't finish" is what happened.
  ['wall_clock_exceeded', 'model_unavailable'],
  ['max_turns_exceeded', 'model_unavailable'],
  ['model_unavailable', 'model_unavailable'],
  ['model_refused', 'model_unavailable'],
  ['org_budget_exceeded', 'budget'],
  ['budget_exceeded', 'budget'],
]);

/** Which cause a user can act on first: an org counts once, under the first of these it has. */
const FAILURE_PRIORITY: readonly FirstLookFailureCategory[] = ['budget', 'model_unavailable', 'no_agent', 'not_admitted', 'internal'];

export function firstLookFailureCategory(run: FailedRun): FirstLookFailureCategory {
  const known = run.errorCode === null ? undefined : FAILURE_CODE_CATEGORY.get(run.errorCode);
  if (known) return known;
  // Stopped before the model by a policy or a person, as opposed to the platform failing it (stalled, enqueue_failed, ...).
  return run.status === 'skipped' || run.status === 'cancelled' ? 'not_admitted' : 'internal';
}

/**
 * Why each attempted org was not looked at. An org with no run never got past
 * admission, whose skip reason is not stored: the grant's own budget and the
 * no-agent readiness concern are what can still say why.
 */
export function summarizeFirstLookFailures(
  attemptedOrgIds: string[],
  failedRunsByOrg: ReadonlyMap<string, FailedRun[]>,
  context: { noAgentOrgIds: ReadonlySet<string>; grantBudgetExhausted: boolean },
): FirstLookFailureSummary[] {
  const counts = new Map<FirstLookFailureCategory, number>();
  for (const orgId of attemptedOrgIds) {
    const runs = failedRunsByOrg.get(orgId) ?? [];
    const categories: FirstLookFailureCategory[] = runs.length > 0
      ? runs.map(firstLookFailureCategory)
      : [context.grantBudgetExhausted ? 'budget' : context.noAgentOrgIds.has(orgId) ? 'no_agent' : 'not_admitted'];
    const category = FAILURE_PRIORITY.find((c) => categories.includes(c)) ?? 'internal';
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return FAILURE_PRIORITY
    .filter((category) => counts.has(category))
    .map((category) => ({ category, orgCount: counts.get(category)! }))
    .sort((a, b) => b.orgCount - a.orgCount);
}

export type FirstLookRetry = { kind: 'next_check' | 'budget_reset'; at: Date };

/**
 * When Wisp next tries. A spent budget suspends the floor tick until the UTC day
 * rolls (wispWakeScheduler), and the first tick after that can be up to a cadence
 * later, so `at` is the reset rather than a promise of the retry itself. Otherwise
 * it is the next floor tick, which assesses one org and which the scheduler picks
 * up on its own 5-minute tick, so a tick already due is that far away at most,
 * never a time in the past.
 */
export function firstLookRetry(input: {
  grantBudgetExhausted: boolean;
  lastFloorTickAt: Date | null;
  floorTickMinutes: number;
  now: Date;
}): FirstLookRetry {
  const { grantBudgetExhausted, lastFloorTickAt, floorTickMinutes, now } = input;
  if (grantBudgetExhausted) return { kind: 'budget_reset', at: utcDayWindow(now).end };
  const earliest = now.getTime() + WISP_WAKE_TICK_INTERVAL_MS;
  const due = lastFloorTickAt ? lastFloorTickAt.getTime() + floorTickMinutes * 60_000 : earliest;
  return { kind: 'next_check', at: new Date(Math.max(due, earliest)) };
}

/** `Jan 22, 14:30 UTC`. A zone this server's ICU does not know reads as UTC rather than failing a post written once. */
function formatRetryAt(at: Date, timezone: string): string {
  const format = (timeZone: string) => new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone,
  }).format(at);
  try {
    return `${format(timezone)} ${timezone}`;
  } catch (err) {
    console.warn('[wisp.firstLook] unknown time zone; the post uses UTC', { timezone, err });
    return `${format('UTC')} UTC`;
  }
}

const FAILURE_SENTENCE: Record<FirstLookFailureCategory, (n: number) => string> = {
  budget: (n) => `An AI budget limit stopped me for ${orgs(n)}.`,
  model_unavailable: (n) => `The AI model wasn't available or couldn't finish for ${orgs(n)}.`,
  no_agent: (n) => `${orgs(n)} ${n === 1 ? 'has' : 'have'} no Triage agent switched on. You can set one up under Settings → AI Agents.`,
  not_admitted: (n) => `My check wasn't allowed to start for ${orgs(n)}: an AI limit or policy refused it.`,
  internal: (n) => `Something went wrong on my side for ${orgs(n)}.`,
};

/** #11145: never claims a look. Counts and fixed sentences only; see the file header. */
export function renderCouldntLookPost(input: {
  totalOrgs: number;
  attemptedOrgs: number;
  reasons: FirstLookFailureSummary[];
  retry: FirstLookRetry;
  /** The grantor's resolved brief zone. */
  timezone: string;
}): { title: string; body: string } {
  const { totalOrgs, attemptedOrgs, reasons, retry, timezone } = input;
  const scope = attemptedOrgs === totalOrgs ? `your ${orgs(totalOrgs)}` : `${attemptedOrgs} of your ${orgs(totalOrgs)}`;
  const at = formatRetryAt(retry.at, timezone);
  const when = retry.kind === 'budget_reset'
    ? `I'll try again on my regular checks once the daily budget resets at ${at}.`
    : `I'll try again around ${at} on my regular checks, one organization at a time, and post what I find.`;
  return {
    title: `I couldn't look yet: 0 of ${orgs(totalOrgs)}`,
    body: [
      `I tried to look at ${scope} and couldn't finish ${attemptedOrgs === 1 ? 'it' : 'any of them'}, so I have no findings yet.`,
      reasons.map((r) => FAILURE_SENTENCE[r.category](r.orgCount)).join(' '),
      when,
    ].join('\n\n'),
  };
}

// ---------------------------------------------------------------------------
// The post
// ---------------------------------------------------------------------------

const systemRead = <T>(fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn));

async function postExists(grantId: string, dedupeKey: string): Promise<boolean> {
  const rows = await systemRead(() => db
    .select({ id: wispThreadPosts.id })
    .from(wispThreadPosts)
    .where(and(eq(wispThreadPosts.grantId, grantId), eq(wispThreadPosts.dedupeKey, dedupeKey)))
    .limit(1));
  return rows.length > 0;
}

type RunProgress = {
  settled: Set<string>;
  lookedAt: Set<string>;
  inFlight: Set<string>;
  /** Only what is used for an org nothing looked at: its settled, unsuccessful runs. */
  failedRunsByOrg: Map<string, FailedRun[]>;
};

/** The orgs among `orgIds` this grant has a settled assessment for, those it actually looked at, and those still running. */
async function loadRunProgress(grantId: string, orgIds: string[]): Promise<RunProgress> {
  const rows = orgIds.length === 0 ? [] : await systemRead(() => db
    .selectDistinct({ orgId: aiAgentRuns.orgId, status: aiAgentRuns.status, errorCode: aiAgentRuns.errorCode })
    .from(aiAgentRuns)
    .where(and(
      eq(aiAgentRuns.grantId, grantId),
      eq(aiAgentRuns.profile, 'assessment'),
      inArray(aiAgentRuns.orgId, orgIds),
      inArray(aiAgentRuns.status, [...SETTLED_STATUSES, ...IN_FLIGHT_STATUSES]),
    )));
  const assessed: readonly string[] = ASSESSED_STATUSES;
  const inFlight: readonly string[] = IN_FLIGHT_STATUSES;
  const progress: RunProgress = { settled: new Set(), lookedAt: new Set(), inFlight: new Set(), failedRunsByOrg: new Map() };
  for (const { orgId, status, errorCode } of rows) {
    if (inFlight.includes(status)) {
      progress.inFlight.add(orgId);
      continue;
    }
    progress.settled.add(orgId);
    if (assessed.includes(status)) {
      progress.lookedAt.add(orgId);
      continue;
    }
    const failed = progress.failedRunsByOrg.get(orgId) ?? [];
    failed.push({ status, errorCode: errorCode ?? null });
    progress.failedRunsByOrg.set(orgId, failed);
  }
  return progress;
}

/**
 * Best effort: a failed inventory is null, and the post says it could not check.
 * The post is written once, so it must not read as "no gaps" for good.
 */
async function loadWatchGaps(grantId: string, ceiling: GrantCeiling, orgIds: string[]): Promise<WatchGap[] | null> {
  try {
    return summarizeWatchGaps(await readinessInventory(ceiling, { orgIds }));
  } catch (err) {
    console.warn('[wisp.firstLook] readiness inventory failed; the post says it could not check', { grantId, err });
    captureException(err, undefined, { op: 'wisp.firstLook.readiness', grantId });
    return null;
  }
}

/**
 * Post the grant's first look if its onboarding batch has settled and it has
 * none yet. Safe to call any number of times, concurrently.
 */
export async function postFirstLookIfDone(grantId: string, now: Date = new Date()): Promise<FirstLookResult> {
  const skip = (reason: FirstLookSkip): FirstLookResult => ({ posted: false, reason });
  if (!wispEnabled()) return skip('wisp_disabled');

  const [grant] = await systemRead(() => db
    .select({
      id: wispGrants.id,
      partnerId: wispGrants.partnerId,
      grantorUserId: wispGrants.grantorUserId,
      status: wispGrants.status,
      currentRevisionId: wispGrants.currentRevisionId,
      createdAt: wispGrants.createdAt,
      floorTickMinutes: wispGrants.floorTickMinutes,
      lastFloorTickAt: wispGrants.lastFloorTickAt,
    })
    .from(wispGrants)
    .where(eq(wispGrants.id, grantId))
    .limit(1));
  if (!grant) return skip('grant_not_found');
  if (grant.status !== 'active' || !grant.currentRevisionId) return skip('grant_inactive');
  // A grant told "I couldn't look yet" is still owed the real post, however long the outage lasted.
  if (now.getTime() - grant.createdAt.getTime() > FIRST_LOOK_WINDOW_MS && !(await postExists(grant.id, couldntLookDedupeKey(grant.id)))) {
    return skip('past_window');
  }
  if (await postExists(grant.id, firstLookDedupeKey(grant.id))) return skip('already_posted');

  const thread = await getOrCreateThread(grant.id);

  let ceiling: GrantCeiling;
  try {
    ceiling = await runOutsideDbContext(() => resolveGrantCeiling(grant.id, grant.currentRevisionId!));
  } catch (err) {
    if (err instanceof GrantInactiveError) return skip('grant_inactive');
    throw err;
  }

  const assessable = assessableOrgIds(ceiling);
  const liveOrgs = (await loadLivePartnerOrgs(grant.partnerId)).filter((o) => assessable.has(o.id));
  const liveOrgIds = liveOrgs.map((o) => o.id);
  const progress = await loadRunProgress(grant.id, liveOrgIds);
  const { settled, lookedAt } = progress;

  const batchOrgIds = onboardingBatch(liveOrgs).map((o) => o.id);
  if (!firstLookBatchDone({ batchOrgIds, settledOrgIds: settled, grantCreatedAt: grant.createdAt, now })) return skip('in_progress');

  const liveConcerns = () => listConcernsForCeiling(ceiling, { status: ['open', 'snoozed'] });
  if (lookedAt.size === 0) {
    if (liveOrgIds.length === 0) return skip('nothing_looked_at');
    // Past the grace limit a run can still be going: it may yet look.
    if (progress.inFlight.size > 0) return skip('in_progress');
    if (await postExists(grant.id, couldntLookDedupeKey(grant.id))) return skip('couldnt_look_posted');

    const budget = await chargeableUnderGrant(grant.id, ASSESSMENT_BUDGET_CENTS_PER_RUN, now);
    const grantBudgetExhausted = !budget.ok;
    const noAgentOrgIds = new Set((await liveConcerns())
      .filter((c) => c.evidence.reason === NO_AGENT_EVIDENCE_REASON && c.orgId !== null)
      .map((c) => c.orgId as string));
    const attempted = [...new Set([...batchOrgIds, ...settled])];
    const { title, body } = renderCouldntLookPost({
      totalOrgs: liveOrgIds.length,
      attemptedOrgs: attempted.length,
      reasons: summarizeFirstLookFailures(attempted, progress.failedRunsByOrg, { noAgentOrgIds, grantBudgetExhausted }),
      retry: firstLookRetry({ grantBudgetExhausted, lastFloorTickAt: grant.lastFloorTickAt, floorTickMinutes: grant.floorTickMinutes, now }),
      timezone: (await loadBriefSchedule(grant.grantorUserId, grant.partnerId)).timezone,
    });
    const delivered = await notifyUser({
      userId: grant.grantorUserId,
      category: 'wisp_nudge',
      kind: 'first_look',
      firstLookVariant: 'couldnt_look',
      concernId: null,
      threadId: thread.id,
      grantId: grant.id,
      deepLink: mobileDeepLink(thread.id, null),
      title,
      body,
      push: false,
    });
    // 'backoff' here is the dedupe key's answer: another caller wrote the row first.
    return delivered.suppressed === 'backoff' ? skip('couldnt_look_posted') : { posted: true, variant: 'couldnt_look' };
  }

  const concerns: Record<ConcernSeverity, number> = { high: 0, medium: 0, low: 0, info: 0 };
  for (const c of await liveConcerns()) concerns[c.severity] += 1;

  const unfinishedOrgs = settled.size - lookedAt.size;
  const { title, body } = renderFirstLookPost({
    totalOrgs: liveOrgIds.length,
    lookedAtOrgs: lookedAt.size,
    unfinishedOrgs,
    stillQueuedOrgs: liveOrgIds.length - settled.size,
    restrictedOrgs: ceiling.orgIds.size - assessable.size,
    concerns,
    watchGaps: await loadWatchGaps(grant.id, ceiling, liveOrgIds),
  });

  const delivered = await notifyUser({
    userId: grant.grantorUserId,
    category: 'wisp_nudge',
    kind: 'first_look',
    concernId: null,
    threadId: thread.id,
    grantId: grant.id,
    deepLink: mobileDeepLink(thread.id, null),
    title,
    body,
    push: false,
  });
  // 'backoff' here is the dedupe key's answer: another caller wrote the row first.
  return delivered.suppressed === 'backoff' ? skip('already_posted') : { posted: true, variant: 'first_look' };
}

export type FirstLookResweepResult = {
  scanned: number;
  /** Posts of either variant. */
  posted: number;
  /** Of `posted`, how many said nothing could be looked at. */
  couldntLook: number;
  failed: number;
  skipped: Partial<Record<FirstLookSkip, number>>;
};

/**
 * The grant reconciler's sweep: active grants with no first look yet, either in
 * their first day or later if they were told they couldn't be looked at and a look
 * has since landed (finishRun posts that, and this covers it failing). A grant with
 * no look stays out past the first day, so one with no agent is not rescanned for
 * good. Per-grant failures are reported, never thrown. A grant still inside its
 * grace period is a normal skip; it comes back on a later tick, as does one told it
 * couldn't be looked at. Skips are tallied for the tick's log.
 */
export async function resweepFirstLookPosts(now: Date): Promise<FirstLookResweepResult> {
  const out: FirstLookResweepResult = { scanned: 0, posted: 0, couldntLook: 0, failed: 0, skipped: {} };
  if (!wispEnabled()) return out;
  const candidates = await systemRead(() => db
    .select({ id: wispGrants.id })
    .from(wispGrants)
    .where(and(
      eq(wispGrants.status, 'active'),
      or(
        gte(wispGrants.createdAt, new Date(now.getTime() - FIRST_LOOK_WINDOW_MS)),
        and(
          sql`EXISTS (
            SELECT 1 FROM ${wispThreadPosts}
            WHERE ${wispThreadPosts.grantId} = ${wispGrants.id}
              AND ${wispThreadPosts.dedupeKey} = 'wisp.first_look_failed:' || ${wispGrants.id}::text
          )`,
          sql`EXISTS (
            SELECT 1 FROM ${aiAgentRuns}
            WHERE ${aiAgentRuns.grantId} = ${wispGrants.id}
              AND ${aiAgentRuns.profile} = 'assessment'
              AND ${inArray(aiAgentRuns.status, [...ASSESSED_STATUSES])}
          )`,
        ),
      ),
      sql`NOT EXISTS (
        SELECT 1 FROM ${wispThreadPosts}
        WHERE ${wispThreadPosts.grantId} = ${wispGrants.id}
          AND ${wispThreadPosts.dedupeKey} = 'wisp.first_look:' || ${wispGrants.id}::text
      )`,
    ))
    .orderBy(desc(wispGrants.createdAt))
    .limit(FIRST_LOOK_RESWEEP_LIMIT));

  for (const { id } of candidates) {
    out.scanned += 1;
    try {
      const res = await postFirstLookIfDone(id, now);
      if (res.posted) {
        out.posted += 1;
        if (res.variant === 'couldnt_look') out.couldntLook += 1;
      } else out.skipped[res.reason] = (out.skipped[res.reason] ?? 0) + 1;
    } catch (err) {
      out.failed += 1;
      console.error('[wisp.firstLook] re-sweep post failed', { grantId: id, err });
      captureException(err, undefined, { op: 'wisp.firstLook.resweep', grantId: id });
    }
  }
  return out;
}
