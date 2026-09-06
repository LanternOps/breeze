/**
 * Boot-time report for PAM rules whose risk tier no longer resolves (#3128).
 *
 * WHY AT BOOT, not on a schedule: the tool tier tables are static code that
 * ships in the API image, so the only moment a stored rule can go stale is a
 * deploy. A repeating job would re-log the same finding on an interval and add
 * no signal a restart doesn't already give.
 *
 * Advisory only. It never mutates a rule, never blocks startup, and never
 * throws — a stale rule already fails safe at match time (no match -> pending),
 * so the cost of the drift is discoverability, which is what this fixes.
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { pamRules } from '../db/schema';
import { describePamRuleTierDrift } from './pamRuleTierDrift';
import { captureMessage } from './sentry';

/** Hard ceiling on the advisory scan so boot can't be held by a huge table. */
const MAX_RULES_SCANNED = 5000;
/** Ids listed inline in the log line; the count is always exact. */
const MAX_IDS_LOGGED = 20;

export interface StalePamRuleTier {
  id: string;
  orgId: string;
  name: string;
  matchToolName: string | null;
  matchRiskTier: number;
  validTiers: number[];
}

export interface PamRuleTierDriftReport {
  scanned: number;
  stale: StalePamRuleTier[];
}

/**
 * Scan enabled, tier-pinned PAM rules across every tenant and report the ones
 * that can no longer match. Disabled rules are skipped deliberately: they are
 * already inert, and including them would bury the actionable findings.
 */
export async function reportStalePamRuleTiers(): Promise<PamRuleTierDriftReport> {
  try {
    // Cross-tenant read: must run in a system DB context, never a request one.
    const rows = await withSystemDbAccessContext(async () =>
      db
        .select({
          id: pamRules.id,
          orgId: pamRules.orgId,
          name: pamRules.name,
          matchToolName: pamRules.matchToolName,
          matchRiskTier: pamRules.matchRiskTier,
          // Required: a negated riskTier/toolName changes what "reachable"
          // means, so omitting this column would flag healthy rules.
          matchNegate: pamRules.matchNegate,
        })
        .from(pamRules)
        .where(and(eq(pamRules.enabled, true), isNotNull(pamRules.matchRiskTier)))
        .limit(MAX_RULES_SCANNED),
    );

    const stale: StalePamRuleTier[] = [];
    for (const row of rows) {
      const drift = describePamRuleTierDrift(row);
      if (!drift) continue;
      stale.push({
        id: row.id,
        orgId: row.orgId,
        name: row.name,
        matchToolName: drift.matchToolName,
        matchRiskTier: drift.matchRiskTier,
        validTiers: drift.validTiers,
      });
    }

    if (stale.length > 0) {
      const listed = stale.slice(0, MAX_IDS_LOGGED);
      const detail = listed
        .map(
          (s) =>
            `${s.id} (org=${s.orgId}, tool=${s.matchToolName ?? 'any'}, ` +
            `tier=${s.matchRiskTier}, valid=${s.validTiers.join('/')})`,
        )
        .join('; ');
      const overflow = stale.length > listed.length ? ` …and ${stale.length - listed.length} more` : '';
      console.warn(
        `[pam-rule-tier-drift] ${stale.length} of ${rows.length} enabled tier-pinned PAM rule(s) ` +
          `reference a risk tier no tool resolves to any more and can never match: ${detail}${overflow}`,
      );
      // A breadcrumb would be pointless here: scrubEvent deletes `breadcrumbs`
      // (and `message`/`extra`) from every outbound event, so the event_code
      // tag is the only thing that survives to Sentry. Rule ids stay in the
      // console line above, which is where operators can act on them.
      captureMessage('PAM rules reference an unreachable risk tier', {
        eventCode: 'pam_rule_risk_tier_unreachable',
        level: 'warning',
      });
    } else if (rows.length > 0) {
      console.log(`[pam-rule-tier-drift] ${rows.length} tier-pinned PAM rule(s) checked; none stale`);
    }

    return { scanned: rows.length, stale };
  } catch (err) {
    console.error('[pam-rule-tier-drift] advisory scan failed (non-fatal):', err);
    return { scanned: 0, stale: [] };
  }
}
