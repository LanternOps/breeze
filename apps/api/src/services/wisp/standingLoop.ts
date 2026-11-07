/**
 * #10391 — the standing loop, told to the chat model. Without it the model
 * only saw the generic "You are Breeze AI" prompt plus the behaviour block, and
 * told users it does not watch the fleet between chats (the orchestrator
 * design says Wisp is "always watching"). The section is filled from the grant
 * when the seed is built — floor-tick cadence and cursor, first-look progress,
 * the grantor's brief schedule — and from the session's model, never from
 * prompt text.
 *
 * Context only: it grants nothing and names no tenant value (counts, a cadence,
 * a clock time, an IANA zone and the model id).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { WispFirstLookProgress } from '@breeze/shared';
import { db } from '../../db';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { wispGrants } from '../../db/schema/wisp';
import { assessableOrgIds, ONBOARDING_ORG_LIMIT } from './assessableOrgs';
import { inSystemContext, type GrantCeiling } from './grantAuthority';

/**
 * Byte ceilings the tests pin: a typical grant (17-char model id, two-digit
 * counts) renders within the first; the worst case (80-char model id, five-digit
 * counts, the longest IANA zone) within the second.
 */
export const STANDING_LOOP_TYPICAL_MAX_BYTES = 600;
export const STANDING_LOOP_MAX_BYTES = 700;
/** A model id we are willing to echo into the prompt; anything else is dropped. */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,79}$/;
/** assessment.ts WATERMARK_RUN_STATUSES: the runs that count as a look taken. */
export const ASSESSED_STATUSES = ['completed', 'awaiting_approval'] as const;
export const IN_FLIGHT_STATUSES = ['queued', 'running'] as const;
/** A run in any of these is over, whether or not it looked. */
export const SETTLED_STATUSES = [...ASSESSED_STATUSES, 'failed', 'cancelled', 'expired', 'skipped', 'blocked'] as const;

/** Orgs this grant may assess; how many have had a look; how many have any settled run; assessment runs waiting or running. */
export type FirstLookCounts = { assessedOrgs: number; settledOrgs: number; inFlight: number; totalOrgs: number };

export type StandingLoopFacts = {
  status: string;
  floorTickMinutes: number;
  lastFloorTickAt: Date | null;
  firstLook: FirstLookCounts;
  /** `timeLocal` null = briefs off. */
  brief: { timeLocal: string | null; timezone: string };
};

/** Must run inside the caller's system context. */
async function readFirstLookCounts(ceiling: GrantCeiling, orgIds: string[]): Promise<FirstLookCounts> {
  const [runs] = orgIds.length === 0 ? [] : await db
    .select({
      assessedOrgs: sql<number>`count(DISTINCT ${aiAgentRuns.orgId}) FILTER (WHERE ${inArray(aiAgentRuns.status, [...ASSESSED_STATUSES])})`.mapWith(Number),
      settledOrgs: sql<number>`count(DISTINCT ${aiAgentRuns.orgId}) FILTER (WHERE ${inArray(aiAgentRuns.status, [...SETTLED_STATUSES])})`.mapWith(Number),
      inFlight: sql<number>`count(*) FILTER (WHERE ${inArray(aiAgentRuns.status, [...IN_FLIGHT_STATUSES])})`.mapWith(Number),
    })
    .from(aiAgentRuns)
    .where(and(
      eq(aiAgentRuns.grantId, ceiling.grantId),
      eq(aiAgentRuns.profile, 'assessment'),
      inArray(aiAgentRuns.orgId, orgIds),
    ));
  return {
    assessedOrgs: Number(runs?.assessedOrgs ?? 0),
    settledOrgs: Number(runs?.settledOrgs ?? 0),
    inFlight: Number(runs?.inFlight ?? 0),
    totalOrgs: orgIds.length,
  };
}

/** Just the grant's first-look run counts (system context), for the home's progress line (#11146). */
export function loadFirstLookCounts(ceiling: GrantCeiling): Promise<FirstLookCounts> {
  return inSystemContext(() => readFirstLookCounts(ceiling, [...assessableOrgIds(ceiling)]));
}

/** null when the grant has no org to look at: "0 of 0" says nothing. */
export function firstLookProgressFrom(counts: FirstLookCounts): WispFirstLookProgress | null {
  if (counts.totalOrgs === 0) return null;
  return {
    lookedAtOrgs: counts.assessedOrgs,
    failedOrgs: Math.max(0, counts.settledOrgs - counts.assessedOrgs),
    queuedOrgs: Math.max(0, counts.totalOrgs - counts.settledOrgs),
    totalOrgs: counts.totalOrgs,
  };
}

/** The grant's loop facts (system context); null when the grant row is gone. */
export async function loadStandingLoopFacts(ceiling: GrantCeiling): Promise<StandingLoopFacts | null> {
  const orgIds = [...assessableOrgIds(ceiling)];
  const read = await inSystemContext(async () => {
    const [grant] = await db
      .select({
        status: wispGrants.status,
        floorTickMinutes: wispGrants.floorTickMinutes,
        lastFloorTickAt: wispGrants.lastFloorTickAt,
      })
      .from(wispGrants)
      .where(and(eq(wispGrants.id, ceiling.grantId), eq(wispGrants.partnerId, ceiling.partnerId)))
      .limit(1);
    if (!grant) return null;
    return { grant, firstLook: await readFirstLookCounts(ceiling, orgIds) };
  });
  if (!read) return null;
  // Lazy: brief.ts imports threads.ts, which imports this module.
  const { briefScheduleFor } = await import('./brief');
  return {
    status: read.grant.status,
    floorTickMinutes: read.grant.floorTickMinutes,
    lastFloorTickAt: read.grant.lastFloorTickAt ?? null,
    firstLook: read.firstLook,
    brief: await briefScheduleFor(ceiling.grantorUserId, ceiling.partnerId),
  };
}

/** `2026-11-05 14:30 UTC` — minute precision, no seconds. */
function utcMinute(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * The `## Wisp standing loop` section. `facts` null (the read failed) keeps the
 * identity and a numberless description of the loop.
 */
export function renderStandingLoop(facts: StandingLoopFacts | null, model: string): string {
  const identity = MODEL_ID_RE.test(model) ? `You are Wisp, running on ${model}.` : 'You are Wisp.';
  const lines = [
    '## Wisp standing loop',
    `${identity} "Breeze AI" is the product's assistant surface, not your name. Between chats you keep working:`,
  ];
  if (facts === null) {
    lines.push('- A first look at each org, then floor ticks, events and a morning brief (schedule unavailable now).');
  } else {
    if (facts.status !== 'active') lines.push('- Paused right now: nothing runs until it resumes.');
    const { assessedOrgs, inFlight, totalOrgs } = facts.firstLook;
    const queued = inFlight > 0 ? `, ${inFlight} queued` : '';
    const rest = totalOrgs > ONBOARDING_ORG_LIMIT ? `; orgs past the first ${ONBOARDING_ORG_LIMIT} come up on floor ticks` : '';
    lines.push(`- First look: ${assessedOrgs} of ${totalOrgs} orgs assessed${queued}${rest}.`);
    const last = facts.lastFloorTickAt ? `last ${utcMinute(facts.lastFloorTickAt)}` : 'no tick yet';
    lines.push(`- Floor tick every ${facts.floorTickMinutes} min, one org each; ${last}.`);
    lines.push(facts.brief.timeLocal === null
      ? '- Morning brief: off.'
      : `- Morning brief ${facts.brief.timeLocal} ${facts.brief.timezone}.`);
  }
  lines.push(
    '- Alerts, integration incidents, stale tickets and finished tasks wake you early.',
    '- `create_watch` and `schedule_check_in` set your own wake-ups.',
    'Never say you only act when messaged; answer "are you still looking?" from these facts.',
  );
  return lines.join('\n');
}
