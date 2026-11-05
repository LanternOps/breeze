/**
 * Wisp W08 (feature #9906; w00 A35, spec §17.2) — the Wisp home's sections,
 * composed from what W04–W07 already store. NOTHING here runs a model: the
 * brief is the stored `user_notifications.metadata.brief` W06 wrote, concerns,
 * activity and links are table reads (pinned by home.noModel.contract.test.ts).
 *
 * The ceiling-bound sections (needs-you, activity, the live line, links) read
 * only under the grant's LIVE ceiling; a paused or ended grant (no ceiling)
 * still gets its brief and the partner switch, so the page can say why it is
 * quiet and offer resume.
 */
import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import type { BriefSection, Concern, WispHomePayload } from '@breeze/shared';
import { db } from '../../db';
import { userNotifications } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { currentActivity, listActivity } from './activity';
import { listConcernsForCeiling } from './concerns';
import { assertWithinCeiling, CeilingViolationError, inSystemContext, type GrantCeiling } from './grantAuthority';
import { getPartnerSettings } from './partnerSettings';
import { listWorkingSet } from './threadLinks';

export const BRIEF_MAX_AGE_HOURS = 36;
export const NEEDS_YOU_LIMIT = 50;
export const HOME_ACTIVITY_LIMIT = 20;

export type HomeSections = Pick<WispHomePayload, 'brief' | 'needsYou' | 'activity' | 'current' | 'links' | 'partner'>;

const SEVERITY_RANK: Record<Concern['severity'], number> = { high: 0, medium: 1, low: 2, info: 3 };

/** Concerns waiting on an approval first, then severity high → info; stable otherwise; capped. */
export function needsYouOrder(concerns: Concern[]): Concern[] {
  return concerns
    .map((c, i) => ({ c, i }))
    .sort((a, b) =>
      Number(b.c.approvalIntentId !== null) - Number(a.c.approvalIntentId !== null)
      || SEVERITY_RANK[a.c.severity] - SEVERITY_RANK[b.c.severity]
      || a.i - b.i)
    .slice(0, NEEDS_YOU_LIMIT)
    .map(({ c }) => c);
}

function briefSections(raw: unknown): BriefSection[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is BriefSection =>
    !!s && typeof s === 'object'
    && typeof (s as BriefSection).heading === 'string'
    && Array.isArray((s as BriefSection).lines)
    && (s as BriefSection).lines.every((l) => typeof l === 'string'));
}

/** The newest brief W06 delivered to the grantor for this grant in the last 36 h. */
async function latestBrief(userId: string, grantId: string): Promise<HomeSections['brief']> {
  const since = new Date(Date.now() - BRIEF_MAX_AGE_HOURS * 3_600_000);
  const [row] = await inSystemContext(() => db
    .select({ createdAt: userNotifications.createdAt, metadata: userNotifications.metadata })
    .from(userNotifications)
    .where(and(
      eq(userNotifications.userId, userId),
      gte(userNotifications.createdAt, since),
      isNotNull(userNotifications.metadata),
      sql`${userNotifications.metadata}->>'grantId' = ${grantId}`,
      sql`${userNotifications.metadata} ? 'brief'`,
    ))
    .orderBy(desc(userNotifications.createdAt))
    .limit(1));
  if (!row) return null;
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  return { sentAt: row.createdAt.toISOString(), sections: briefSections(metadata.brief) };
}

function currentWithinCeiling(ceiling: GrantCeiling, current: HomeSections['current']): HomeSections['current'] {
  if (!current) return null;
  try {
    assertWithinCeiling(ceiling, { orgId: current.orgId });
    return current;
  } catch (err) {
    if (err instanceof CeilingViolationError) return null;
    throw err;
  }
}

export async function buildHomeSections(input: {
  auth: AuthContext;
  partnerId: string;
  grantId: string;
  grantorUserId: string;
  threadId: string;
  /** The grant's live ceiling; null when the grant is paused / ended. */
  ceiling: GrantCeiling | null;
}): Promise<HomeSections> {
  const { ceiling } = input;
  const [brief, settings] = await Promise.all([
    latestBrief(input.grantorUserId, input.grantId),
    getPartnerSettings(input.partnerId),
  ]);
  const partner = { enabled: settings.enabled };
  if (!ceiling) {
    return { brief, needsYou: [], activity: { items: [], nextCursor: null }, current: null, links: [], partner };
  }
  // Sequential: each reads through its own context; the links resolve one by one.
  const concerns = await listConcernsForCeiling(ceiling, { status: ['open', 'snoozed'] });
  const activity = await listActivity(ceiling, { limit: HOME_ACTIVITY_LIMIT, threadId: input.threadId });
  const current = currentWithinCeiling(ceiling, await currentActivity(input.grantId));
  const links = await listWorkingSet({ auth: input.auth, ceiling }, input.threadId, { concerns });
  return { brief, needsYou: needsYouOrder(concerns), activity, current, links, partner };
}
