/**
 * Top detection-rule hits of one IOC sweep (#6263 W05, PR B — the AI
 * `ioc_hunt sweep_status` read).
 *
 * `security_threats` carries no scan id. A threat row is bound to the scan
 * whose result inserted it: result ingest (`routes/agents/helpers.ts`) stamps
 * the threat's `detected_at` and the scan's `completed_at` with the SAME
 * timestamp, on the same device and org. Only threats of the sweep's own
 * pinned rule sets (`details.ruleSetId`) count.
 *
 * Bounded by the caller's ceilings exactly as sweep progress is
 * (`sweepScanVisibility`, PR A): a site- or device-restricted caller sees the
 * hits of its slice only. Ambient (caller) DB context.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { SweepSummary } from '@breeze/shared';
import { db } from '../db';
import { devices, securityScans, securityThreats } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import { hasPermission } from './permissions';
import { sweepScanVisibility } from './securityScanSweeps';
import { createOrgPermissionResolver } from './securityScanSweepTargets';

export interface SweepRuleHit {
  ruleName: string;
  ruleSetId: string;
  hits: number;
}

const RULE_NAME_MAX = 128;

export async function topSweepRuleHits(
  auth: AuthContext,
  sweep: Pick<SweepSummary, 'id' | 'orgId' | 'ruleSets'>,
  limit = 10,
): Promise<SweepRuleHit[]> {
  const setIds = [...new Set(sweep.ruleSets.map((r) => r.id.toLowerCase()))];
  if (setIds.length === 0) return [];
  const perms = await createOrgPermissionResolver(auth)(sweep.orgId);
  if (!perms || !hasPermission(perms, 'devices', 'read')) return [];

  const ruleName = sql<string>`${securityThreats.details}->>'ruleName'`;
  const ruleSetId = sql<string>`lower(${securityThreats.details}->>'ruleSetId')`;
  const hits = sql<number>`count(*)::int`;
  const rows = await db
    .select({ ruleName, ruleSetId, hits })
    .from(securityThreats)
    .innerJoin(
      securityScans,
      and(
        eq(securityScans.deviceId, securityThreats.deviceId),
        eq(securityScans.orgId, securityThreats.orgId),
        eq(securityScans.completedAt, securityThreats.detectedAt),
      ),
    )
    .innerJoin(devices, eq(devices.id, securityScans.deviceId))
    .where(
      and(
        eq(securityScans.sweepId, sweep.id),
        eq(securityThreats.orgId, sweep.orgId),
        eq(securityThreats.provider, 'breeze'),
        // YARA rule identifiers only: the name is agent-reported and goes back
        // to the model, so anything else (free text) is never returned.
        sql`${ruleName} ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'`,
        inArray(ruleSetId, setIds),
        sweepScanVisibility(auth, sweep.orgId, perms),
      ),
    )
    .groupBy(ruleName, ruleSetId)
    .orderBy(desc(hits), ruleName)
    .limit(Math.min(Math.max(1, limit), 50));

  return rows.map((r) => ({
    ruleName: String(r.ruleName).slice(0, RULE_NAME_MAX),
    ruleSetId: r.ruleSetId,
    hits: Number(r.hits),
  }));
}
