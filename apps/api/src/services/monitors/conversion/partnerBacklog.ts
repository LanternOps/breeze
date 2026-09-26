import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../../db';

export interface PartnerConversionBacklogRow {
  partnerId: string; partnerName: string; pendingRows: number; pendingPolicies: number; networkChecks: number;
}

/** The source tables this count reads — pinned by partnerBacklog.test.ts. */
export const PARTNER_BACKLOG_SQL_SOURCES = [
  'config_policy_alert_rules', 'config_policy_monitoring_watches', 'alert_templates', 'automations', 'config_policy_automations', 'network_monitors',
] as const;

type Row = { partner_id: string; partner_name: string; pending_rows: number | string; pending_policies: number | string; network_checks: number | string };

/**
 * Unretired legacy rows per partner, for the hosted post-deploy sweep. Reads
 * every partner, so it runs under the system DB context (this is a
 * platform-admin surface; the caller is gated by platformAdminMiddleware).
 * `retired_at` columns land in W05c1's `2026-10-23-120000-legacy-source-retirement-columns.sql`.
 */
export async function listPartnerConversionBacklog(): Promise<PartnerConversionBacklogRow[]> {
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(async () => db.execute<Row>(sql`
    WITH policy_partner AS (
      SELECT cp.id AS policy_id, COALESCE(cp.partner_id, o.partner_id) AS partner_id
      FROM configuration_policies cp
      LEFT JOIN organizations o ON o.id = cp.org_id
      -- Same predicate as the converter (convert.ts) and countPendingConversions
      -- (loadSources.ts): rows on inactive policies are never converted.
      WHERE cp.status = 'active'
    ),
    pending AS (
      SELECT pp.partner_id, fl.config_policy_id AS policy_id
        FROM config_policy_alert_rules r
        JOIN config_policy_feature_links fl ON fl.id = r.feature_link_id
        JOIN policy_partner pp ON pp.policy_id = fl.config_policy_id
       WHERE r.retired_at IS NULL
      UNION ALL
      SELECT pp.partner_id, fl.config_policy_id
        FROM config_policy_monitoring_watches w
        JOIN config_policy_monitoring_settings s ON s.id = w.settings_id
        JOIN config_policy_feature_links fl ON fl.id = s.feature_link_id
        JOIN policy_partner pp ON pp.policy_id = fl.config_policy_id
       WHERE w.retired_at IS NULL
      UNION ALL
      SELECT pp.partner_id, fl.config_policy_id
        FROM config_policy_automations ca
        JOIN config_policy_feature_links fl ON fl.id = ca.feature_link_id
        JOIN policy_partner pp ON pp.policy_id = fl.config_policy_id
       WHERE ca.retired_at IS NULL AND ca.trigger_type = 'event' AND ca.event_type = 'alert.triggered'
      UNION ALL
      SELECT COALESCE(t.partner_id, o.partner_id), NULL::uuid
        FROM alert_templates t
        LEFT JOIN organizations o ON o.id = t.org_id
       WHERE t.retired_at IS NULL AND t.managed_by_monitor_id IS NULL
      UNION ALL
      SELECT COALESCE(a.partner_id, o.partner_id), NULL::uuid
        FROM automations a
        LEFT JOIN organizations o ON o.id = a.org_id
       WHERE a.retired_at IS NULL AND a.managed_by_monitor_id IS NULL
         AND a.trigger->>'type' = 'event'
         AND COALESCE(a.trigger->>'event', a.trigger->>'eventType') = 'alert.triggered'
         AND (a.trigger->'filter'->>'ruleId' IS NOT NULL OR a.trigger->'filter'->>'configPolicyAlertRuleId' IS NOT NULL)
    )
    SELECT p.id AS partner_id, p.name AS partner_name,
           count(pd.partner_id)::int AS pending_rows,
           count(DISTINCT pd.policy_id)::int AS pending_policies,
           (SELECT count(*)::int FROM network_monitors nm
              JOIN organizations o ON o.id = nm.org_id
             WHERE o.partner_id = p.id AND nm.managed_by_monitor_id IS NULL
               AND nm.retired_at IS NULL) AS network_checks
      FROM partners p
      LEFT JOIN pending pd ON pd.partner_id = p.id
     GROUP BY p.id, p.name
     ORDER BY pending_rows DESC, p.name ASC
  `)));
  return [...rows].map((r) => ({
    partnerId: r.partner_id, partnerName: r.partner_name,
    pendingRows: Number(r.pending_rows), pendingPolicies: Number(r.pending_policies), networkChecks: Number(r.network_checks),
  })).sort((a, b) => b.pendingRows - a.pendingRows || a.partnerName.localeCompare(b.partnerName));
}

