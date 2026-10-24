/**
 * Wisp W05 Task 15 (w00 A33) — the readiness turn: which watch kinds Wisp can
 * actually service for each org of a grant's ceiling, and which integrations
 * are missing. Deterministic reads only (no model call), run in system scope
 * and bounded by the ceiling: an org outside `ceiling.orgIds` is never read and
 * never returned, whatever `opts.orgIds` says.
 *
 * One read per source table across every org (`org_id IN (...)`), never one
 * per org. Serviceable rules, in `WATCH_KINDS` terms:
 *   - backup_health     an active `backup_configs` row for the org, OR a
 *                       backup-vendor customer mapped to the org under an
 *                       active `backup_provider_connections` row.
 *   - security_findings `device_vulnerabilities` detected or updated in the
 *                       last 30 days, OR `edr_detections` updated in 30 days,
 *                       OR `edr_endpoints` seen/updated in 30 days (an EDR
 *                       feed that is syncing but quiet still counts).
 *   - patch_compliance  an active configuration policy the org may use (its own
 *                       or its partner's) whose EFFECTIVE feature links
 *                       (`config_policy_effective_feature_links`, so an
 *                       inherited parent link counts) carry a `patch` link with
 *                       patch settings — the same join the patch resolver in
 *                       featureConfigResolver.ts uses — assigned to the org's
 *                       partner, the org, or one of the org's sites, device
 *                       groups or devices. Role/OS filters are ignored: a
 *                       filtered assignment still means compliance data exists.
 *   - ticket_waiting /
 *     ticket_cluster    a non-deleted ticket created or updated in 90 days.
 *   - alert_pattern     an enabled monitor definition, an active non-retired
 *                       alert rule, or an active network monitor owned by the
 *                       org or partner-wide for the org's partner.
 *   - custom_query      always serviceable (it reads whatever the org has).
 *
 * `missingIntegrations` names only the gaps an external integration would fill:
 * 'backup' (backup_health) and 'edr/vulnerability' (security_findings). Patch
 * policy, tickets and monitors are configuration, not integrations.
 */
import { and, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { WATCH_KINDS, type WatchKind } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { wispEnabled } from '../../config/env';
import { organizations, sites } from '../../db/schema/orgs';
import { deviceGroups, devices } from '../../db/schema/devices';
import { backupConfigs } from '../../db/schema/backup';
import { backupProviderConnections, backupProviderCustomers } from '../../db/schema/backupProviders';
import { deviceVulnerabilities } from '../../db/schema/vulnerabilityManagement';
import { edrDetections, edrEndpoints } from '../../db/schema/edrProviders';
import {
  configPolicyAssignments,
  configPolicyEffectiveFeatureLinks,
  configPolicyPatchSettings,
  configurationPolicies,
} from '../../db/schema/configurationPolicies';
import { tickets } from '../../db/schema/portal';
import { monitorDefinitions } from '../../db/schema/monitorDefinitions';
import { alertRules } from '../../db/schema/alerts';
import { networkMonitors } from '../../db/schema/monitors';
import type { GrantCeiling } from './grantAuthority';
import type { OrgReadiness, ReadinessCheck } from './assessmentTypes';

export type { ReadinessCheck, OrgReadiness } from './assessmentTypes';

const DAY_MS = 86_400_000;
export const READINESS_SECURITY_WINDOW_DAYS = 30;
export const READINESS_TICKET_WINDOW_DAYS = 90;

type CheckKey = 'backup' | 'security' | 'patch' | 'tickets' | 'alerts';

const KIND_RULE: Record<WatchKind, { key: CheckKey | null; reason: string | null }> = {
  ticket_waiting: { key: 'tickets', reason: 'no tickets in 90 days' },
  alert_pattern: { key: 'alerts', reason: 'no monitors or alert rules' },
  backup_health: { key: 'backup', reason: 'no backup integration configured' },
  patch_compliance: { key: 'patch', reason: 'no patch policy' },
  security_findings: { key: 'security', reason: 'no vulnerability or EDR data in 30 days' },
  custom_query: { key: null, reason: null },
  ticket_cluster: { key: 'tickets', reason: 'no tickets in 90 days' },
};

const MISSING_INTEGRATION: Partial<Record<CheckKey, string>> = {
  backup: 'backup',
  security: 'edr/vulnerability',
};

type OrgRef = { id: string; name: string; partnerId: string };
type OwnedRow = { orgId: string | null; partnerId?: string | null };

/** Byte-order compare, so ordering never depends on the host locale. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function orgIdSet(rows: readonly OwnedRow[]): Set<string> {
  const s = new Set<string>();
  for (const r of rows) if (r.orgId) s.add(r.orgId);
  return s;
}

/** Org-owned rows count for that org; partner-wide rows (orgId null) count for every org of that partner. */
function coveredOrgs(rows: readonly OwnedRow[], orgs: readonly OrgRef[]): Set<string> {
  const direct = orgIdSet(rows);
  const partners = new Set<string>();
  for (const r of rows) if (!r.orgId && r.partnerId) partners.add(r.partnerId);
  return new Set(orgs.filter((o) => direct.has(o.id) || partners.has(o.partnerId)).map((o) => o.id));
}

async function readCoverage(orgs: readonly OrgRef[], now: Date): Promise<Record<CheckKey, Set<string>>> {
  const orgIds = orgs.map((o) => o.id);
  const partnerIds = [...new Set(orgs.map((o) => o.partnerId))];
  const securitySince = new Date(now.getTime() - READINESS_SECURITY_WINDOW_DAYS * DAY_MS);
  const ticketsSince = new Date(now.getTime() - READINESS_TICKET_WINDOW_DAYS * DAY_MS);

  // backup_health
  const backupConfigRows = await db
    .selectDistinct({ orgId: backupConfigs.orgId })
    .from(backupConfigs)
    .where(and(inArray(backupConfigs.orgId, orgIds), eq(backupConfigs.isActive, true)));
  const backupVendorRows = await db
    .selectDistinct({ orgId: backupProviderCustomers.orgId })
    .from(backupProviderCustomers)
    .innerJoin(
      backupProviderConnections,
      and(
        eq(backupProviderConnections.id, backupProviderCustomers.connectionId),
        eq(backupProviderConnections.isActive, true),
      ),
    )
    .where(inArray(backupProviderCustomers.orgId, orgIds));

  // security_findings
  const vulnRows = await db
    .selectDistinct({ orgId: deviceVulnerabilities.orgId })
    .from(deviceVulnerabilities)
    .where(and(
      inArray(deviceVulnerabilities.orgId, orgIds),
      or(gte(deviceVulnerabilities.detectedAt, securitySince), gte(deviceVulnerabilities.updatedAt, securitySince)),
    ));
  const edrDetectionRows = await db
    .selectDistinct({ orgId: edrDetections.orgId })
    .from(edrDetections)
    .where(and(inArray(edrDetections.orgId, orgIds), gte(edrDetections.updatedAt, securitySince)));
  const edrEndpointRows = await db
    .selectDistinct({ orgId: edrEndpoints.orgId })
    .from(edrEndpoints)
    .where(and(
      inArray(edrEndpoints.orgId, orgIds),
      or(gte(edrEndpoints.lastSeenAt, securitySince), gte(edrEndpoints.updatedAt, securitySince)),
    ));

  // patch_compliance — see the file header for the rule.
  const a = configPolicyAssignments;
  const patchRows = await db
    .selectDistinct({ orgId: organizations.id })
    .from(configPolicyAssignments)
    .innerJoin(
      organizations,
      sql`(
        (${a.level} = 'partner' AND ${a.targetId} = ${organizations.partnerId})
        OR (${a.level} = 'organization' AND ${a.targetId} = ${organizations.id})
        OR (${a.level} = 'site' AND ${a.targetId} IN (SELECT ${sites.id} FROM ${sites} WHERE ${sites.orgId} = ${organizations.id}))
        OR (${a.level} = 'device_group' AND ${a.targetId} IN (SELECT ${deviceGroups.id} FROM ${deviceGroups} WHERE ${deviceGroups.orgId} = ${organizations.id}))
        OR (${a.level} = 'device' AND ${a.targetId} IN (SELECT ${devices.id} FROM ${devices} WHERE ${devices.orgId} = ${organizations.id}))
      )`,
    )
    .innerJoin(
      configurationPolicies,
      and(
        eq(configurationPolicies.id, a.configPolicyId),
        eq(configurationPolicies.status, 'active'),
        or(
          eq(configurationPolicies.orgId, organizations.id),
          eq(configurationPolicies.partnerId, organizations.partnerId),
        ),
      ),
    )
    .innerJoin(
      configPolicyEffectiveFeatureLinks,
      and(
        eq(configPolicyEffectiveFeatureLinks.configPolicyId, configurationPolicies.id),
        eq(configPolicyEffectiveFeatureLinks.featureType, 'patch'),
      ),
    )
    .innerJoin(configPolicyPatchSettings, eq(configPolicyPatchSettings.featureLinkId, configPolicyEffectiveFeatureLinks.id))
    .where(inArray(organizations.id, orgIds));

  // ticket_waiting / ticket_cluster
  const ticketRows = await db
    .selectDistinct({ orgId: tickets.orgId })
    .from(tickets)
    .where(and(
      inArray(tickets.orgId, orgIds),
      isNull(tickets.deletedAt),
      or(gte(tickets.createdAt, ticketsSince), gte(tickets.updatedAt, ticketsSince)),
    ));

  // alert_pattern — org-owned or partner-wide rows.
  const monitorRows = await db
    .selectDistinct({ orgId: monitorDefinitions.orgId, partnerId: monitorDefinitions.partnerId })
    .from(monitorDefinitions)
    .where(and(
      eq(monitorDefinitions.enabled, true),
      or(inArray(monitorDefinitions.orgId, orgIds), inArray(monitorDefinitions.partnerId, partnerIds)),
    ));
  const alertRuleRows = await db
    .selectDistinct({ orgId: alertRules.orgId, partnerId: alertRules.partnerId })
    .from(alertRules)
    .where(and(
      eq(alertRules.isActive, true),
      isNull(alertRules.retiredAt),
      or(inArray(alertRules.orgId, orgIds), inArray(alertRules.partnerId, partnerIds)),
    ));
  const networkMonitorRows = await db
    .selectDistinct({ orgId: networkMonitors.orgId, partnerId: networkMonitors.partnerId })
    .from(networkMonitors)
    .where(and(
      eq(networkMonitors.isActive, true),
      or(inArray(networkMonitors.orgId, orgIds), inArray(networkMonitors.partnerId, partnerIds)),
    ));

  return {
    backup: coveredOrgs([...backupConfigRows, ...backupVendorRows], orgs),
    security: coveredOrgs([...vulnRows, ...edrDetectionRows, ...edrEndpointRows], orgs),
    patch: coveredOrgs(patchRows, orgs),
    tickets: coveredOrgs(ticketRows, orgs),
    alerts: coveredOrgs([...monitorRows, ...alertRuleRows, ...networkMonitorRows], orgs),
  };
}

export async function readinessInventory(ceiling: GrantCeiling, opts?: { orgIds?: string[] }): Promise<OrgReadiness[]> {
  if (!wispEnabled()) return [];
  // An inactive grant reaches nothing (assertWithinCeiling refuses it too).
  if (ceiling.status !== 'active') return [];
  const requested = opts?.orgIds ? new Set(opts.orgIds) : null;
  const eligible = [...ceiling.orgIds].filter((id) => !requested || requested.has(id)).sort(cmp);
  if (eligible.length === 0) return [];

  const now = new Date();
  const { orgs, coverage } = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const rows = await db
      .select({ id: organizations.id, name: organizations.name, partnerId: organizations.partnerId })
      .from(organizations)
      .where(and(inArray(organizations.id, eligible), isNull(organizations.deletedAt)));
    // Belt and braces: the read is already bounded by the ceiling; re-check
    // membership and the grant's partner before anything is reported.
    const inCeiling = rows.filter((o) => ceiling.orgIds.has(o.id) && o.partnerId === ceiling.partnerId);
    if (inCeiling.length === 0) return { orgs: inCeiling, coverage: null };
    return { orgs: inCeiling, coverage: await readCoverage(inCeiling, now) };
  }, 'wisp-readiness-inventory'));
  if (!coverage) return [];

  return [...orgs]
    .sort((x, y) => cmp(x.name, y.name) || cmp(x.id, y.id))
    .map((org) => {
      const gaps = new Set<CheckKey>();
      const checks: ReadinessCheck[] = WATCH_KINDS.map((watchKind) => {
        const rule = KIND_RULE[watchKind];
        if (rule.key === null) return { watchKind, serviceable: true, reason: null };
        const serviceable = coverage[rule.key].has(org.id);
        if (!serviceable) gaps.add(rule.key);
        return { watchKind, serviceable, reason: serviceable ? null : rule.reason };
      });
      const missingIntegrations = (['backup', 'security'] as const)
        .filter((k) => gaps.has(k))
        .map((k) => MISSING_INTEGRATION[k])
        .filter((v): v is string => typeof v === 'string');
      return { orgId: org.id, orgName: org.name, checks, missingIntegrations };
    });
}

/**
 * Friendly nouns, in display order. Several watch kinds may share a noun
 * (both ticket kinds read as "tickets"); `custom_query` has none and is never
 * mentioned.
 */
const NOUN_ORDER = ['alerts', 'tickets', 'backups', 'patch compliance', 'security findings'] as const;
const KIND_NOUN: Record<WatchKind, (typeof NOUN_ORDER)[number] | null> = {
  alert_pattern: 'alerts',
  ticket_waiting: 'tickets',
  ticket_cluster: 'tickets',
  backup_health: 'backups',
  patch_compliance: 'patch compliance',
  security_findings: 'security findings',
  custom_query: null,
};

/** "a", "a or b", "a, b, or c" (Oxford comma). */
function joinList(items: readonly string[], conj: 'and' | 'or'): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} ${conj} ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, ${conj} ${items[items.length - 1]}`;
}

/**
 * One or two sentences for the onboarding concern / thread summary, e.g.
 * "I can watch alerts and tickets here. I can't watch backups (no backup
 * integration configured) or patch compliance (no patch policy)."
 * Pure and deterministic; a noun is a gap when any of its kinds is not
 * serviceable (never claim a watch that cannot run), and the gap shows the
 * first reason found for it.
 */
export function renderReadinessSummary(r: OrgReadiness): string {
  const gapReason = new Map<string, string>();
  const seen = new Set<string>();
  for (const c of r.checks) {
    const noun = KIND_NOUN[c.watchKind];
    if (!noun) continue;
    seen.add(noun);
    if (!c.serviceable && !gapReason.has(noun)) gapReason.set(noun, c.reason ?? 'not available');
  }
  const can = NOUN_ORDER.filter((n) => seen.has(n) && !gapReason.has(n));
  const cannot = NOUN_ORDER.filter((n) => gapReason.has(n)).map((n) => `${n} (${gapReason.get(n)})`);

  if (cannot.length === 0) {
    return `I can watch everything I know how to watch here: ${joinList(can, 'and')}.`;
  }
  const first = can.length > 0 ? `I can watch ${joinList(can, 'and')} here.` : 'There is nothing here I can watch yet.';
  return `${first} I can't watch ${joinList(cannot, 'or')}.`;
}
