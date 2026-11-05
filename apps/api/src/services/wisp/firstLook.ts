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
 * grant was created, whichever comes first. Nothing is posted until at least one
 * org was actually looked at: "I've had a first look" would be false, and each
 * way of getting there already has its own signal (the no-agent readiness
 * concern, the budget notice).
 *
 * Exactly one post per grant: the dedupe key is the post's (thread_id,
 * dedupe_key) unique key, so concurrent runs and the sweep land on one row. The
 * body is built from counts and fixed labels only: no org or device names, and
 * no text that came from a device or a model.
 *
 * Reads run under short system contexts of their own (the callers hold none).
 * A grant that should not post returns `{ posted: false, reason }`; a real
 * failure (DB, notifyUser) throws and the callers report it.
 */
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { CONCERN_SEVERITIES, type ConcernSeverity, type WatchKind } from '@breeze/shared';
import { wispEnabled } from '../../config/env';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { wispGrants } from '../../db/schema/wisp';
import { wispThreadPosts } from '../../db/schema/wispThreadPosts';
import { captureException } from '../sentry';
import { assessableOrgIds } from './assessableOrgs';
import type { OrgReadiness } from './assessmentTypes';
import { listConcernsForCeiling } from './concerns';
import { GrantInactiveError, resolveGrantCeiling, type GrantCeiling } from './grantAuthority';
import { firstLookDedupeKey, notifyUser } from './notifyUser';
import { mobileDeepLink } from './nudgeLinks';
import { readinessInventory } from './readiness';
import { getOrCreateThread } from './threads';
import { loadLivePartnerOrgs, onboardingBatch } from './wake';

export { firstLookDedupeKey } from './notifyUser';

/** A grant older than this never gets the post: it is about a grant's first day, and must not reach grants that predate it. */
export const FIRST_LOOK_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How long a batch org with no settled run holds the post (its admission may have been skipped: no run is coming). */
export const FIRST_LOOK_GRACE_MS = 30 * 60 * 1000;
/** At most this many grants per reconciler tick (newest first). */
export const FIRST_LOOK_RESWEEP_LIMIT = 100;

/** The org was looked at: the same two statuses that advance an assessment's watermark. */
const LOOKED_AT_STATUSES = ['completed', 'awaiting_approval'] as const;
/** A run in any of these is over, whether or not it looked. */
const SETTLED_STATUSES = [...LOOKED_AT_STATUSES, 'failed', 'cancelled', 'expired', 'skipped', 'blocked'] as const;

export type FirstLookSkip =
  | 'wisp_disabled'
  | 'grant_not_found'
  | 'grant_inactive'
  | 'past_window'
  | 'already_posted'
  | 'in_progress'
  | 'nothing_looked_at';

export type FirstLookResult = { posted: true } | { posted: false; reason: FirstLookSkip };

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
  watchGaps: WatchGap[];
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

  const cannotWatch = watchGaps.map((g) => `${g.label} in ${orgs(g.orgCount)}`);
  if (restrictedOrgs > 0) cannotWatch.push(`${orgs(restrictedOrgs)} you reach only through some of their sites`);

  const paragraphs = [coverage.join(' '), concernLine];
  if (cannotWatch.length > 0) paragraphs.push(`What I can't watch yet: ${cannotWatch.join('; ')}.`);
  return {
    title: `First look done: ${lookedAtOrgs} of ${orgs(totalOrgs)}`,
    body: paragraphs.join('\n\n'),
  };
}

// ---------------------------------------------------------------------------
// The post
// ---------------------------------------------------------------------------

const systemRead = <T>(fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn));

async function postExists(threadId: string, dedupeKey: string): Promise<boolean> {
  const rows = await systemRead(() => db
    .select({ id: wispThreadPosts.id })
    .from(wispThreadPosts)
    .where(and(eq(wispThreadPosts.threadId, threadId), eq(wispThreadPosts.dedupeKey, dedupeKey)))
    .limit(1));
  return rows.length > 0;
}

/** The orgs among `orgIds` this grant has a settled assessment for, and those it actually looked at. */
async function loadRunProgress(grantId: string, orgIds: string[]): Promise<{ settled: Set<string>; lookedAt: Set<string> }> {
  const rows = orgIds.length === 0 ? [] : await systemRead(() => db
    .selectDistinct({ orgId: aiAgentRuns.orgId, status: aiAgentRuns.status })
    .from(aiAgentRuns)
    .where(and(
      eq(aiAgentRuns.grantId, grantId),
      eq(aiAgentRuns.profile, 'assessment'),
      inArray(aiAgentRuns.orgId, orgIds),
      inArray(aiAgentRuns.status, [...SETTLED_STATUSES]),
    )));
  const lookedAtStatuses: readonly string[] = LOOKED_AT_STATUSES;
  return {
    settled: new Set(rows.map((r) => r.orgId)),
    lookedAt: new Set(rows.filter((r) => lookedAtStatuses.includes(r.status)).map((r) => r.orgId)),
  };
}

/** Best effort: without the inventory the post simply says nothing about what cannot be watched. */
async function loadWatchGaps(grantId: string, ceiling: GrantCeiling, orgIds: string[]): Promise<WatchGap[]> {
  try {
    return summarizeWatchGaps(await readinessInventory(ceiling, { orgIds }));
  } catch (err) {
    console.warn('[wisp.firstLook] readiness inventory failed; the post omits what cannot be watched', { grantId, err });
    captureException(err, undefined, { op: 'wisp.firstLook.readiness', grantId });
    return [];
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
    })
    .from(wispGrants)
    .where(eq(wispGrants.id, grantId))
    .limit(1));
  if (!grant) return skip('grant_not_found');
  if (grant.status !== 'active' || !grant.currentRevisionId) return skip('grant_inactive');
  if (now.getTime() - grant.createdAt.getTime() > FIRST_LOOK_WINDOW_MS) return skip('past_window');

  const thread = await getOrCreateThread(grant.id);
  if (await postExists(thread.id, firstLookDedupeKey(grant.id))) return skip('already_posted');

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
  const { settled, lookedAt } = await loadRunProgress(grant.id, liveOrgIds);

  const batchOrgIds = onboardingBatch(liveOrgs).map((o) => o.id);
  if (!firstLookBatchDone({ batchOrgIds, settledOrgIds: settled, grantCreatedAt: grant.createdAt, now })) return skip('in_progress');
  if (lookedAt.size === 0) return skip('nothing_looked_at');

  const concerns: Record<ConcernSeverity, number> = { high: 0, medium: 0, low: 0, info: 0 };
  for (const c of await listConcernsForCeiling(ceiling, { status: ['open', 'snoozed'] })) concerns[c.severity] += 1;

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

  await notifyUser({
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
  return { posted: true };
}

export type FirstLookResweepResult = { scanned: number; posted: number; failed: number };

/**
 * The grant reconciler's sweep: active grants in their first day with no first
 * look yet. Per-grant failures are reported, never thrown. A grant still inside
 * its grace period is a normal skip; it comes back on a later tick.
 */
export async function resweepFirstLookPosts(now: Date): Promise<FirstLookResweepResult> {
  const out: FirstLookResweepResult = { scanned: 0, posted: 0, failed: 0 };
  if (!wispEnabled()) return out;
  const candidates = await systemRead(() => db
    .select({ id: wispGrants.id })
    .from(wispGrants)
    .where(and(
      eq(wispGrants.status, 'active'),
      gte(wispGrants.createdAt, new Date(now.getTime() - FIRST_LOOK_WINDOW_MS)),
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
      if (res.posted) out.posted += 1;
    } catch (err) {
      out.failed += 1;
      console.error('[wisp.firstLook] re-sweep post failed', { grantId: id, err });
      captureException(err, undefined, { op: 'wisp.firstLook.resweep', grantId: id });
    }
  }
  return out;
}
