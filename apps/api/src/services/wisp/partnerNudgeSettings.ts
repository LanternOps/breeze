/**
 * Wisp W06 — the partner's "urgent-capable" severities (Wisp design §7.4):
 * a concern of one of these severities may break through quiet hours for a
 * user who chose `quiet_override = 'urgent_only'`. One row per partner in
 * `wisp_partner_nudge_settings`; a missing row means none (spec "default:
 * none").
 *
 * This is partner-wide state (epic #2135): the writer refuses a caller
 * without canManagePartnerWidePolicies itself, before any database access,
 * and takes the partner and the author from auth — never from a body. Reads
 * run in whatever context the caller holds (the route under the caller's RLS,
 * notifyUser inside its system context).
 */
import { eq, sql } from 'drizzle-orm';
import { CONCERN_SEVERITIES, type ConcernSeverity } from '@breeze/shared';
import { db } from '../../db';
import { wispPartnerNudgeSettings } from '../../db/schema/wispNudgePreferences';
import type { AuthContext } from '../../middleware/auth';
import { canManagePartnerWidePolicies, PartnerWideWriteDeniedError } from '../partnerWideAccess';

const SEVERITY_SET: ReadonlySet<string> = new Set(CONCERN_SEVERITIES);
const cleanSeverities = (raw: readonly string[] | null | undefined): ConcernSeverity[] =>
  [...new Set((raw ?? []).filter((s): s is ConcernSeverity => SEVERITY_SET.has(s)))];

/** Missing row = none. */
export async function loadUrgentCapableSeverities(partnerId: string): Promise<ConcernSeverity[]> {
  const [row] = await db.select({ urgentCapableSeverities: wispPartnerNudgeSettings.urgentCapableSeverities })
    .from(wispPartnerNudgeSettings).where(eq(wispPartnerNudgeSettings.partnerId, partnerId)).limit(1);
  return cleanSeverities(row?.urgentCapableSeverities);
}

/** Throws PartnerWideWriteDeniedError unless the caller may manage partner-wide state. */
export async function upsertUrgentCapableSeverities(
  auth: Pick<AuthContext, 'scope' | 'partnerOrgAccess' | 'partnerId' | 'user'>,
  severities: ConcernSeverity[],
): Promise<ConcernSeverity[]> {
  if (!canManagePartnerWidePolicies(auth) || !auth.partnerId) throw new PartnerWideWriteDeniedError();
  const clean = cleanSeverities(severities);
  const [row] = await db.insert(wispPartnerNudgeSettings)
    .values({ partnerId: auth.partnerId, urgentCapableSeverities: clean, updatedByUserId: auth.user.id })
    .onConflictDoUpdate({
      target: wispPartnerNudgeSettings.partnerId,
      set: { urgentCapableSeverities: clean, updatedByUserId: auth.user.id, updatedAt: sql`now()` },
    })
    .returning({ urgentCapableSeverities: wispPartnerNudgeSettings.urgentCapableSeverities });
  return cleanSeverities(row?.urgentCapableSeverities);
}
