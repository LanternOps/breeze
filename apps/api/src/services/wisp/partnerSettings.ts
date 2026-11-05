/**
 * Wisp W08 Task 6 (#9914, w00 A35) — the partner's Wisp enable switch, a
 * column on W06's one partner settings row (`wisp_partner_nudge_settings`).
 * A missing row means enabled.
 *
 * Spec §17.2 (4): the entitlement is commercial, this switch is governance,
 * BREEZE_WISP_ENABLED is the deployment kill switch — none overrides another.
 * While the switch is off:
 *   - createGrant / userResumeGrant / refreshGrant refuse `partner_disabled`
 *     (grants.ts);
 *   - every ACTIVE grant of the partner is paused `partner_disabled` — right
 *     after the write commits, and again by the wake tick (wispWakeScheduler);
 *   - re-enabling resumes ONLY grants paused with that reason (never
 *     `user_paused`, never `entitlement_lost`, never any other reason): every
 *     pause is `onlyFromActive` and every resume a CAS on 'partner_disabled',
 *     so this reconcile and the entitlement reconcile never fight over a grant.
 *
 * Partner-wide state (epic #2135): the writer refuses a caller without
 * canManagePartnerWidePolicies itself, before any database access, and takes
 * the partner and the author from auth — never from a body.
 *
 * Settings rule 9 (docs/agents/settings.md): home = the Wisp card under
 * Settings → AI Agents; level = partner only (no org override, no document
 * snapshot); resolver = getPartnerSettings(partnerId).enabled (default true).
 */
import { and, eq, gt, sql } from 'drizzle-orm';
import { CONCERN_SEVERITIES, type ConcernSeverity } from '@breeze/shared';
import { db, runAfterDbContextCommit } from '../../db';
import { wispGrants } from '../../db/schema/wisp';
import { wispPartnerNudgeSettings } from '../../db/schema/wispNudgePreferences';
import type { AuthContext } from '../../middleware/auth';
import { canManagePartnerWidePolicies, PartnerWideWriteDeniedError } from '../partnerWideAccess';
import { captureException } from '../sentry';
import { inSystemContext } from './grantAuthority';
// grants.ts imports getPartnerSettings from here; both sides use the other
// only inside function bodies, so the import cycle is harmless at load time.
import { pauseGrant, resumeGrant } from './grants';

export type WispPartnerSettingsResolved = {
  enabled: boolean;
  /** W06's urgent-capable severities (spec §7.4; missing row = none). */
  urgentCapableSeverities: ConcernSeverity[];
};

const SEVERITY_SET: ReadonlySet<string> = new Set(CONCERN_SEVERITIES);

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function report(err: unknown, tags: Record<string, string>): void {
  captureException(err, undefined, { component: 'wisp.partnerSettings', ...tags });
}

/**
 * The partner's Wisp settings, from ONE read of its row. A missing row is
 * `enabled: true` with no urgent-capable severities. Runs in whatever DB
 * context the caller holds (the route under the caller's RLS; createGrant and
 * the reconcile wrap it in system context).
 */
export async function getPartnerSettings(partnerId: string): Promise<WispPartnerSettingsResolved> {
  const [row] = await db
    .select({ enabled: wispPartnerNudgeSettings.enabled, urgentCapableSeverities: wispPartnerNudgeSettings.urgentCapableSeverities })
    .from(wispPartnerNudgeSettings)
    .where(eq(wispPartnerNudgeSettings.partnerId, partnerId))
    .limit(1);
  const severities = (row?.urgentCapableSeverities ?? []).filter((s): s is ConcernSeverity => SEVERITY_SET.has(s));
  return { enabled: row?.enabled ?? true, urgentCapableSeverities: [...new Set(severities)] };
}

/**
 * Turn Wisp on or off for the caller's partner. Throws
 * PartnerWideWriteDeniedError unless the caller may manage partner-wide state.
 *
 * The grant reconcile is registered to run AFTER the request's transaction
 * commits: it reads the switch on its own system connection, which would
 * still see the old value inside the uncommitted write. Best effort — a
 * failure is logged and reported, never surfaced to the caller; the wake tick
 * reconciles every partner again within one tick interval.
 */
export async function setPartnerEnabled(
  auth: Pick<AuthContext, 'scope' | 'partnerOrgAccess' | 'partnerId' | 'user'>,
  enabled: boolean,
): Promise<{ enabled: boolean }> {
  if (!canManagePartnerWidePolicies(auth) || !auth.partnerId) throw new PartnerWideWriteDeniedError();
  const partnerId = auth.partnerId;
  const [row] = await db
    .insert(wispPartnerNudgeSettings)
    .values({ partnerId, enabled, updatedByUserId: auth.user.id })
    .onConflictDoUpdate({
      target: wispPartnerNudgeSettings.partnerId,
      // urgent_capable_severities is W06's field: never touched here.
      set: { enabled, updatedByUserId: auth.user.id, updatedAt: sql`now()` },
    })
    .returning({ enabled: wispPartnerNudgeSettings.enabled });
  if (!row) throw new Error('wisp partner settings upsert returned no row');

  runAfterDbContextCommit('wisp-partner-enabled-reconcile', async () => {
    try {
      await reconcilePartnerDisabled(partnerId);
    } catch (err) {
      console.error('[wisp] partner switch reconcile failed; the wake tick retries', { partnerId, error: errMessage(err) });
      report(err, { op: 'reconcile_after_write' });
    }
  });
  return { enabled: row.enabled };
}

/**
 * Bring the partner's grants in line with its switch. Reads run in system
 * context (the tick has no request); each pause / resume is W02's own
 * system-context CAS. A grant that fails is logged, reported and not counted.
 */
export async function reconcilePartnerDisabled(partnerId: string, now: Date = new Date()): Promise<{ paused: number; resumed: number }> {
  const { enabled, grantIds } = await inSystemContext(async () => {
    const settings = await getPartnerSettings(partnerId);
    const rows = await db
      .select({ id: wispGrants.id })
      .from(wispGrants)
      .where(settings.enabled
        ? and(
          eq(wispGrants.partnerId, partnerId),
          eq(wispGrants.status, 'paused'),
          eq(wispGrants.pausedReason, 'partner_disabled'),
          gt(wispGrants.expiresAt, now),
        )
        : and(
          eq(wispGrants.partnerId, partnerId),
          eq(wispGrants.status, 'active'),
          gt(wispGrants.expiresAt, now),
        ))
      .orderBy(wispGrants.id);
    return { enabled: settings.enabled, grantIds: rows.map((r) => r.id) };
  });

  let paused = 0;
  let resumed = 0;
  for (const grantId of grantIds) {
    try {
      if (enabled) {
        // CAS on exactly this reason: a user pause or another system pause set meanwhile is left alone.
        await resumeGrant(grantId, 'partner_disabled');
        resumed += 1;
      } else {
        // onlyFromActive: a pause the grantor (or another reconciler) made meanwhile stays theirs.
        await pauseGrant(grantId, 'partner_disabled', { onlyFromActive: true });
        paused += 1;
      }
    } catch (err) {
      console.error('[wisp] reconcilePartnerDisabled: grant update failed', { partnerId, grantId, error: errMessage(err) });
      report(err, { op: 'reconcile_grant_update' });
    }
  }
  return { paused, resumed };
}
