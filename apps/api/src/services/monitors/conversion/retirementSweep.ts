/**
 * W05d — boot-time retirement sweep for legacy alerting.
 *
 * Converts whatever the W05c release left unconverted (self-hosters who never
 * pressed "Convert everything"), retires the unconvertible rows with a reason,
 * and then counts what is still unretired so a skipped or failed sweep is loud
 * rather than silent. Mirrors ensureBuiltInMonitorsForAllPartners: called
 * WITHOUT an enclosing DB context, after the HTTP listener is up, one system
 * authorization context per partner so one failure never
 * blocks the rest. Never refuses boot.
 */
import { eq, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../../db';
import { configPolicyAlertRules, configPolicyMonitoringWatches, partners } from '../../../db/schema';
import { captureException } from '../../sentry';
import { createSystemAuthContext } from '../../featureConfigResolver';
import { previewPartnerConversion, convertPartnerLegacy, retireSource, ConversionError } from './index';
import type { AuthContext } from '../../../middleware/auth';
import type { ConversionSourceTable, PartnerConversionPreview } from './types';

export interface RetiredSource { sourceTable: ConversionSourceTable; sourceId: string; name: string; reason: string; policyId: string | null }

export const LEGACY_ALERTING_RETIREMENT_VERSION = 1;
const MARKER_UNCONVERTIBLE_CAP = 200;
// Match Task 6's removed runtimes. Never sweep network checks or future sources.
const RETIRED_RUNTIME_SOURCE_TABLES: ReadonlySet<ConversionSourceTable> = new Set([
  'config_policy_alert_rules', 'config_policy_monitoring_watches', 'alert_templates',
  'automations', 'config_policy_automations',
]);

export interface LegacyAlertingRemaining { configPolicyAlertRules: number; configPolicyMonitoringWatches: number }
export interface RetirementRunResult { partners: number; converted: number; retired: number; failed: number; remaining: LegacyAlertingRemaining }

export class LegacyAlertingUnretiredError extends Error {
  constructor(readonly remaining: LegacyAlertingRemaining) {
    super(
      `Legacy alerting rows are still unretired after the W05d sweep: ` +
      `${remaining.configPolicyAlertRules} config_policy_alert_rules, ` +
      `${remaining.configPolicyMonitoringWatches} config_policy_monitoring_watches. ` +
      `Nothing evaluates them any more. Open Alerts → Monitors for the list, or run the ` +
      `partner "Convert everything" action; set BREEZE_LEGACY_ALERTING_SWEEP=true if it was disabled.`,
    );
    this.name = 'LegacyAlertingUnretiredError';
  }
}

function sweepEnabled(): boolean {
  return process.env.BREEZE_LEGACY_ALERTING_SWEEP !== 'false';
}

/** Partners that still own an unretired legacy source row, on either axis. */
export async function listPartnersWithUnretiredLegacyAlerting(): Promise<string[]> {
  const rows = await db.execute<{ partner_id: string }>(sql`
    SELECT DISTINCT partner_id FROM (
      SELECT COALESCE(cp.partner_id, o.partner_id) AS partner_id
        FROM config_policy_alert_rules r
        JOIN config_policy_feature_links l ON l.id = r.feature_link_id
        JOIN configuration_policies cp ON cp.id = l.config_policy_id
        LEFT JOIN organizations o ON o.id = cp.org_id
       WHERE r.retired_at IS NULL
      UNION ALL
      SELECT COALESCE(cp.partner_id, o.partner_id)
        FROM config_policy_monitoring_watches w
        JOIN config_policy_monitoring_settings s ON s.id = w.settings_id
        JOIN config_policy_feature_links l ON l.id = s.feature_link_id
        JOIN configuration_policies cp ON cp.id = l.config_policy_id
        LEFT JOIN organizations o ON o.id = cp.org_id
       WHERE w.retired_at IS NULL
      UNION ALL
      SELECT COALESCE(ar.partner_id, o.partner_id)
        FROM alert_rules ar LEFT JOIN organizations o ON o.id = ar.org_id
       WHERE ar.retired_at IS NULL AND ar.managed_by_monitor_id IS NULL
      UNION ALL
      SELECT COALESCE(t.partner_id, o.partner_id)
        FROM alert_templates t LEFT JOIN organizations o ON o.id = t.org_id
       WHERE t.retired_at IS NULL AND t.managed_by_monitor_id IS NULL AND t.is_built_in = false
      UNION ALL
      SELECT COALESCE(cp.partner_id, o.partner_id)
        FROM config_policy_automations a
        JOIN config_policy_feature_links l ON l.id = a.feature_link_id
        JOIN configuration_policies cp ON cp.id = l.config_policy_id
        LEFT JOIN organizations o ON o.id = cp.org_id
       WHERE a.retired_at IS NULL AND a.trigger_type = 'event' AND a.event_type = 'alert.triggered'
      UNION ALL
      SELECT COALESCE(a.partner_id, o.partner_id)
        FROM automations a LEFT JOIN organizations o ON o.id = a.org_id
       WHERE a.retired_at IS NULL AND a.managed_by_monitor_id IS NULL
         AND a.trigger->>'type' = 'event' AND a.trigger->>'eventType' = 'alert.triggered'
         AND (a.trigger->'filter'->>'ruleId' IS NOT NULL
           OR a.trigger->'filter'->>'configPolicyAlertRuleId' IS NOT NULL)
    ) u
    JOIN partners p ON p.id = u.partner_id AND p.deleted_at IS NULL
  `);
  return rows.map((r) => r.partner_id);
}

export async function retirePreviewRefusals(preview: PartnerConversionPreview, auth: AuthContext): Promise<RetiredSource[]> {
  const retired: RetiredSource[] = [];
  for (const item of preview.unconvertible) {
    if (!RETIRED_RUNTIME_SOURCE_TABLES.has(item.sourceTable)) continue;
    // C1 rehomes these workflows and does not return them as refusals.
    // Defensive compatibility with a stale pre-D12 preview; never disable one.
    if (item.reason === 'unconvertible:alert_workflow_kept') continue;
    // Item reasons are ALREADY prefixed. Only C1's bare blockedBy values
    // are prefixed when it builds the partner preview, not here.
    const reason = item.reason ?? 'unconvertible:unknown';
    try {
      await retireSource(item.sourceTable, item.sourceId, reason, auth);
      retired.push({ sourceTable: item.sourceTable, sourceId: item.sourceId,
        name: item.name, reason, policyId: item.policyId });
    } catch (error) {
      if (error instanceof ConversionError && error.code === 'already_converted') continue;
      throw error;
    }
  }
  return retired;
}

export async function sweepPartnerLegacyAlerting(partnerId: string): Promise<{ converted: number; retired: RetiredSource[] }> {
  return runOutsideDbContext(async () => {
    // Conversion APIs own their serializable transactions (D30). Only the
    // marker write below opens a sweep-owned system transaction.
    const auth = createSystemAuthContext();
    const preview = await previewPartnerConversion(partnerId, auth);
    const result = await convertPartnerLegacy(partnerId, preview.previewHash, auth);
    const retired = await retirePreviewRefusals(preview, auth);
    const now = new Date().toISOString();
    await withSystemDbAccessContext(() => db
      .update(partners)
      .set({
        settings: sql`COALESCE(${partners.settings}, '{}'::jsonb) || jsonb_build_object('legacyAlertingRetirement', jsonb_build_object(
          'version', ${LEGACY_ALERTING_RETIREMENT_VERSION}::int,
          'sweptAt', ${now}::text,
          'converted', ${result.converted}::int,
          'retired', ${retired.length}::int,
          'unconvertible', ${JSON.stringify(retired.slice(0, MARKER_UNCONVERTIBLE_CAP))}::jsonb
        ))`,
      })
      .where(eq(partners.id, partnerId)));
    return { converted: result.converted, retired };
  });
}

export async function checkLegacyAlertingRetired(): Promise<LegacyAlertingRemaining> {
  const [row] = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db
        .select({
          rules: sql<number>`(SELECT count(*)::int FROM ${configPolicyAlertRules} WHERE ${configPolicyAlertRules.retiredAt} IS NULL)`,
          watches: sql<number>`(SELECT count(*)::int FROM ${configPolicyMonitoringWatches} WHERE ${configPolicyMonitoringWatches.retiredAt} IS NULL)`,
        })
        .from(sql`(SELECT 1) AS one`),
    ),
  );
  const remaining = { configPolicyAlertRules: row?.rules ?? 0, configPolicyMonitoringWatches: row?.watches ?? 0 };
  if (remaining.configPolicyAlertRules > 0 || remaining.configPolicyMonitoringWatches > 0) {
    const err = new LegacyAlertingUnretiredError(remaining);
    console.error(`[legacy-alerting-retirement] ${err.message}`);
    captureException(err, undefined, { area: 'legacy_alerting_unretired' });
  }
  return remaining;
}

export async function runLegacyAlertingRetirement(): Promise<RetirementRunResult> {
  let swept = 0, converted = 0, retired = 0, failed = 0;
  if (!sweepEnabled()) {
    console.warn('[legacy-alerting-retirement] sweep disabled by BREEZE_LEGACY_ALERTING_SWEEP=false; only counting');
  } else {
    const partnerIds = await runOutsideDbContext(() => withSystemDbAccessContext(listPartnersWithUnretiredLegacyAlerting));
    for (const partnerId of partnerIds) {
      try {
        const r = await runOutsideDbContext(() => sweepPartnerLegacyAlerting(partnerId));
        swept += 1; converted += r.converted; retired += r.retired.length;
      } catch (err) {
        failed += 1;
        console.error(`[legacy-alerting-retirement] partner ${partnerId} failed:`, err);
        captureException(err, undefined, { area: 'legacy_alerting_sweep', partnerId });
      }
    }
  }
  const remaining = await checkLegacyAlertingRetired();
  return { partners: swept, converted, retired, failed, remaining };
}
