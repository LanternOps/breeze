import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { monitorConditionSchemas, NETWORK_CHECK_OPTION_KEYS, type AlertSeverity, type NetworkCheckMonitorCondition } from '@breeze/shared';
import { alerts, configurationPolicies, configPolicyAssignments, configPolicyFeatureLinks, configPolicyMonitors, discoveredAssets, monitorConversionOutputs, monitorConversions, networkMonitorAlertRules, networkMonitors, organizations } from '../../../db/schema';
import type { AuthContext } from '../../../middleware/auth';
import { addFeatureLink, assignPolicy, createConfigPolicy } from '../../configurationPolicy';
import { canMutateOrgWideGovernance } from '../../siteCeilingAccess';
import { buildMonitorCommand } from '../../monitorCommands';
import { createMonitorDefinition } from '../monitorService';
import type { DbExecutor } from '../monitorCompiler';
import * as networkCheckRuntime from '../../alertConditions/handlers/networkCheck';
import { carryNetworkAlerts, snapshotNetworkSource } from './networkHistory';
import { inCallerTransaction, lockConversion } from './convert';
import { canonical, sha } from './mapping';
import { OPEN_ALERT_STATUSES } from './loadSources';
import { ConversionPrerequisiteMissingError } from './prerequisites';
import type { ConversionPreviewItem } from './types';
export { retireNetworkCheck, revertNetworkCheckConversion } from './networkHistory';

type Row = typeof networkMonitors.$inferSelect;
type Rule = typeof networkMonitorAlertRules.$inferSelect;
export const NETWORK_CHECK_UNCONVERTIBLE = {
  alreadyManaged: 'unconvertible:already_managed', noOrg: 'unconvertible:no_org',
  assetMissing: 'unconvertible:asset_missing', conditionInvalid: 'unconvertible:condition_invalid',
  noActiveRules: 'unconvertible:no_active_rules', multipleRules: 'unconvertible:multiple_network_rules',
  predicate: 'unconvertible:network_predicate_unsupported', threshold: 'unconvertible:network_threshold_out_of_range',
  siteBinding: 'unconvertible:site_binding_unrepresentable',
  configOverride: 'unconvertible:config_override_unrepresentable',
} as const;
export const NETWORK_CHECKS_POLICY_NAME = (orgName: string) => `Network checks — ${orgName}`;
export interface NetworkCheckMapping {
  condition: NetworkCheckMonitorCondition; severity: AlertSeverity; deliveryMode: 'inherit' | 'none'; description?: string; notes: string[];
}
export interface NetworkCheckConversionPreview {
  orgId: string; previewHash: string; blockedBy?: 'prerequisite_missing'; missingPrerequisites?: string[]; items: ConversionPreviewItem[];
}
export class NetworkCheckConversionError extends Error {
  constructor(public readonly code: 'org_not_found' | 'source_not_found' | 'stale_preview' | 'site_restricted_conversion' | 'already_converted', public readonly status: 404 | 409 | 403) { super(code); }
}
function assertOrgAccess(orgId: string, auth: AuthContext) {
  if (!canMutateOrgWideGovernance(auth)) throw new NetworkCheckConversionError('site_restricted_conversion', 403);
  if (!auth.canAccessOrg(orgId)) throw new NetworkCheckConversionError('org_not_found', 404);
}
export function missingNetworkCheckPrerequisites(runtime: { NETWORK_CHECK_DEVICE_INDEPENDENT_EVALUATION?: unknown } = networkCheckRuntime): string[] {
  return runtime.NETWORK_CHECK_DEVICE_INDEPENDENT_EVALUATION === true ? []
    : ['#6353 network checks evaluate once per managed check independently of alert-device online status'];
}
function assertPrerequisites() {
  const missing = missingNetworkCheckPrerequisites();
  if (missing.length) throw new ConversionPrerequisiteMissingError(missing);
}
export function mapNetworkMonitorToDefinition(row: Row, rules: Rule[]): { ok: true; mapping: NetworkCheckMapping } | { ok: false; reason: string } {
  const refuse = (reason: string) => ({ ok: false as const, reason });
  if (row.managedByMonitorId) return refuse(NETWORK_CHECK_UNCONVERTIBLE.alreadyManaged);
  if (!row.orgId) return refuse(NETWORK_CHECK_UNCONVERTIBLE.noOrg);
  if (row.siteId && !row.assetId) return refuse(NETWORK_CHECK_UNCONVERTIBLE.siteBinding);
  const config = (row.config ?? {}) as Record<string, unknown>;
  // The legacy command spreads config after the columns. Read the same payload
  // so adoption preserves target/timeout overrides and HTTP/DNS fallback rules.
  const { payload } = buildMonitorCommand(row);
  if (payload.monitorId !== row.id) return refuse(NETWORK_CHECK_UNCONVERTIBLE.configOverride);
  const targetKey = row.monitorType === 'http_check' ? 'url' : row.monitorType === 'dns_check' ? 'hostname' : 'target';
  const condition: Record<string, unknown> = {
    checkType: row.monitorType,
    target: payload[targetKey],
    ...(row.assetId ? { assetId: row.assetId } : {}), pollingIntervalSeconds: row.pollingInterval, timeoutSeconds: payload.timeout,
  };
  const keys = new Set<string>(NETWORK_CHECK_OPTION_KEYS[row.monitorType]);
  const ignored: string[] = [];
  for (const [legacyKey, value] of Object.entries(config)) {
    if (value == null || ['url', 'hostname', 'target', 'timeout', 'monitorId'].includes(legacyKey)) continue;
    const key = legacyKey === 'expectedStatus' ? 'expectStatus' : legacyKey;
    if (keys.has(key)) condition[key] = value; else ignored.push(legacyKey);
  }
  if (row.monitorType === 'http_check') condition.followRedirects = config.followRedirects ?? true;
  const active = rules.filter(r => r.isActive && !r.retiredAt);
  if (!active.length) return refuse(NETWORK_CHECK_UNCONVERTIBLE.noActiveRules);
  if (active.length !== 1) return refuse(NETWORK_CHECK_UNCONVERTIBLE.multipleRules);
  const rule = active[0]!;
  let consecutiveFailures = 1;
  if (rule.condition === 'consecutive_failures_gt') {
    const n = typeof rule.threshold === 'string' && rule.threshold.trim() ? Number(rule.threshold) : NaN;
    if (!Number.isFinite(n) || n < 0 || Math.floor(n) + 1 > 100) return refuse(NETWORK_CHECK_UNCONVERTIBLE.threshold);
    consecutiveFailures = Math.floor(n) + 1;
  } else if (rule.condition !== 'offline') return refuse(NETWORK_CHECK_UNCONVERTIBLE.predicate);
  const parsed = monitorConditionSchemas.network_check.safeParse({ ...condition, consecutiveFailures, degradedIsFailure: false });
  if (!parsed.success) {
    const invalidOverride = parsed.error.issues.some(issue =>
      (issue.path[0] === 'target' && Object.hasOwn(config, targetKey))
      || (issue.path[0] === 'timeoutSeconds' && Object.hasOwn(config, 'timeout')));
    return refuse(invalidOverride ? NETWORK_CHECK_UNCONVERTIBLE.configOverride : NETWORK_CHECK_UNCONVERTIBLE.conditionInvalid);
  }
  return { ok: true, mapping: { condition: parsed.data, severity: rule.severity, deliveryMode: 'inherit', description: rule.message ?? undefined,
    notes: ignored.length ? [`Ignored config keys with no monitor equivalent: ${ignored.sort().join(', ')}`] : [] } };
}
function groupBy<T>(rows: T[], key: (row: T) => string) {
  const result = new Map<string, T[]>();
  for (const row of rows) { const k = key(row); result.set(k, [...(result.get(k) ?? []), row]); }
  return result;
}
export async function loadPendingNetworkChecks(orgId: string, tx: DbExecutor) {
  const rows = await tx.select().from(networkMonitors).where(and(eq(networkMonitors.orgId, orgId), isNull(networkMonitors.managedByMonitorId), isNull(networkMonitors.retiredAt))).orderBy(networkMonitors.id);
  const ids = rows.map(r => r.id);
  const rules = ids.length ? await tx.select().from(networkMonitorAlertRules).where(inArray(networkMonitorAlertRules.monitorId, ids)) : [];
  const bound = [...new Set(rows.flatMap(r => r.assetId ? [r.assetId] : []))];
  const assets = bound.length ? await tx.select({ id: discoveredAssets.id }).from(discoveredAssets).where(and(eq(discoveredAssets.orgId, orgId), inArray(discoveredAssets.id, bound))) : [];
  const open = ids.length ? await tx.select({ id: alerts.id, monitorId: sql<string>`${alerts.context}->>'monitorId'` }).from(alerts)
    .where(and(eq(alerts.orgId, orgId), inArray(alerts.status, [...OPEN_ALERT_STATUSES]), sql`${alerts.context}->>'source' = 'network_monitor'`, inArray(sql`${alerts.context}->>'monitorId'`, ids))) : [];
  return { rows, rulesByMonitor: groupBy(rules, r => r.monitorId), assetIds: new Set(assets.map(a => a.id)), openAlertsByMonitor: groupBy(open, a => a.monitorId) };
}
export function networkPreviewHash(rows: Row[], rules: Map<string, Rule[]>): string {
  return sha(canonical([...rows].sort((a, b) => a.id.localeCompare(b.id)).map(r => ({
    id: r.id, name: r.name, orgId: r.orgId, monitorType: r.monitorType, target: r.target, config: r.config,
    assetId: r.assetId, siteId: r.siteId, pollingInterval: r.pollingInterval, timeout: r.timeout, isActive: r.isActive,
    rules: [...(rules.get(r.id) ?? [])].sort((a, b) => a.id.localeCompare(b.id)).map(x => ({ id: x.id, condition: x.condition, threshold: x.threshold,
      severity: x.severity, message: x.message, isActive: x.isActive, retiredAt: x.retiredAt })),
  }))));
}
export async function previewNetworkChecksInTx(orgId: string, auth: AuthContext, tx: DbExecutor): Promise<NetworkCheckConversionPreview> {
  assertOrgAccess(orgId, auth);
  const missingPrerequisites = missingNetworkCheckPrerequisites();
  if (missingPrerequisites.length) return { orgId, previewHash: '', items: [], blockedBy: 'prerequisite_missing', missingPrerequisites };
  const full = await loadPendingNetworkChecks(orgId, tx);
  return { orgId, previewHash: networkPreviewHash(full.rows, full.rulesByMonitor), items: full.rows.map(row => {
    const mapped = row.assetId && !full.assetIds.has(row.assetId) ? { ok: false as const, reason: NETWORK_CHECK_UNCONVERTIBLE.assetMissing }
      : mapNetworkMonitorToDefinition(row, full.rulesByMonitor.get(row.id) ?? []);
    const openAlerts = full.openAlertsByMonitor.get(row.id)?.length ?? 0;
    return { sourceTable: 'network_monitors', sourceId: row.id, name: row.name, outcome: mapped.ok ? 'convertible' : 'unconvertible',
      ...(mapped.ok ? {} : { reason: mapped.reason }), openAlerts, notes: [...(mapped.ok ? mapped.mapping.notes : []), ...(openAlerts ? [`${openAlerts} open alert(s) retain their status and history`] : [])],
      proposed: mapped.ok ? [{ role: 'primary', kind: 'network_check', name: row.name, condition: mapped.mapping.condition, severity: mapped.mapping.severity,
        enabled: row.isActive, cooldownMinutes: 5, autoResolve: true, deliveryMode: mapped.mapping.deliveryMode, deliveryChannelIds: [], escalationPolicyId: null, responses: [] }] : [] };
  }) };
}
export async function previewNetworkCheckConversion(orgId: string, auth: AuthContext): Promise<NetworkCheckConversionPreview> {
  assertOrgAccess(orgId, auth);
  const missingPrerequisites = missingNetworkCheckPrerequisites();
  if (missingPrerequisites.length) return { orgId, previewHash: '', items: [], blockedBy: 'prerequisite_missing', missingPrerequisites };
  return inCallerTransaction(auth, async tx => { await lockConversion(tx, { orgId, partnerId: null }); return previewNetworkChecksInTx(orgId, auth, tx); });
}

export async function findOrCreateNetworkChecksPolicy(orgId: string, auth: AuthContext, tx: DbExecutor) {
  const prior = await tx.select({ policyId: monitorConversions.policyId }).from(monitorConversions)
    .where(and(eq(monitorConversions.orgId, orgId), eq(monitorConversions.sourceTable, 'network_monitors'), isNull(monitorConversions.revertedAt))).orderBy(desc(monitorConversions.convertedAt));
  for (const policyId of new Set(prior.flatMap(p => p.policyId ? [p.policyId] : []))) {
    const [policy] = await tx.select().from(configurationPolicies).where(and(eq(configurationPolicies.id, policyId), eq(configurationPolicies.orgId, orgId), eq(configurationPolicies.status, 'active'))).for('update');
    if (!policy || policy.parentPolicyId) continue;
    const assignments = await tx.select().from(configPolicyAssignments).where(eq(configPolicyAssignments.configPolicyId, policyId)).for('update');
    if (!assignments.some(a => a.level === 'organization' && a.targetId === orgId && !a.roleFilter?.length && !a.osFilter?.length)) continue;
    const [link] = await tx.select().from(configPolicyFeatureLinks).where(and(eq(configPolicyFeatureLinks.configPolicyId, policyId), eq(configPolicyFeatureLinks.featureType, 'monitors'))).for('update');
    if (link && ((link.inlineSettings as { inheritance?: string } | null)?.inheritance ?? 'cumulative') === 'cumulative') return { policyId, monitorsLinkId: link.id };
  }
  const [org] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) throw new NetworkCheckConversionError('org_not_found', 404);
  const actor = auth.scope === 'system' ? null : auth.user.id;
  const policy = await createConfigPolicy({ orgId }, { name: NETWORK_CHECKS_POLICY_NAME(org.name) }, actor, tx);
  if (!policy) throw new Error('Failed to create network checks policy');
  await assignPolicy(policy.id, 'organization', orgId, 0, actor, undefined, undefined, tx);
  const link = await addFeatureLink(policy.id, 'monitors', null, { items: [], inheritance: 'cumulative' }, undefined, tx);
  if (!link) throw new Error('Failed to create monitors feature link');
  return { policyId: policy.id, monitorsLinkId: link.id };
}
export async function adoptNetworkChecksInTx(orgId: string, previewHash: string, auth: AuthContext,
  full: Awaited<ReturnType<typeof loadPendingNetworkChecks>>, selected: Row[], tx: DbExecutor) {
  assertOrgAccess(orgId, auth);
  assertPrerequisites();
  const convertible = selected.filter(row => (!row.assetId || full.assetIds.has(row.assetId)) && mapNetworkMonitorToDefinition(row, full.rulesByMonitor.get(row.id) ?? []).ok);
  if (!convertible.length) return { conversionIds: [] as string[], retired: 0, monitorsCreated: 0, policyId: null };
  const { policyId, monitorsLinkId } = await findOrCreateNetworkChecksPolicy(orgId, auth, tx);
  const [next] = await tx.select({ nextSort: sql<number>`coalesce(max(${configPolicyMonitors.sortOrder}), -1) + 1` }).from(configPolicyMonitors).where(eq(configPolicyMonitors.featureLinkId, monitorsLinkId));
  let sort = Number(next?.nextSort ?? 0);
  const conversionIds: string[] = [];
  for (const row of convertible) {
    const mapped = mapNetworkMonitorToDefinition(row, full.rulesByMonitor.get(row.id) ?? []);
    if (!mapped.ok) continue;
    const networkSourceSnapshot = await snapshotNetworkSource(tx, row);
    const def = await createMonitorDefinition({ ownerScope: 'organization', orgId, name: row.name, description: mapped.mapping.description,
      kind: 'network_check', enabled: row.isActive, condition: mapped.mapping.condition, severity: mapped.mapping.severity,
      cooldownMinutes: 5, autoResolve: true, responses: [], deliveryMode: mapped.mapping.deliveryMode, deliveryChannelIds: [], escalationPolicyId: null,
      recurrenceActions: [], pauseResponsesOnEscalation: true }, auth, { adoptNetworkMonitorId: row.id }, tx);
    const [attachment] = await tx.insert(configPolicyMonitors).values({ featureLinkId: monitorsLinkId, monitorId: def.id, enabled: row.isActive, sortOrder: sort++ })
      .returning({ id: configPolicyMonitors.id });
    if (!attachment) throw new Error('Converted attachment unavailable');
    await tx.update(networkMonitorAlertRules).set({ retiredAt: new Date(), retiredReason: 'converted' }).where(and(eq(networkMonitorAlertRules.monitorId, row.id), isNull(networkMonitorAlertRules.retiredAt)));
    const movedAlertRefs = await carryNetworkAlerts(tx, row, def);
    const [entry] = await tx.insert(monitorConversions).values({ orgId, partnerId: null, sourceTable: 'network_monitors', sourceId: row.id, policyId,
      sourceState: { name: row.name }, convertedBy: auth.scope === 'system' ? null : auth.user.id, previewHash, networkSourceSnapshot }).returning({ id: monitorConversions.id });
    await tx.insert(monitorConversionOutputs).values({ orgId, partnerId: null, conversionId: entry!.id, monitorId: def.id, role: 'primary',
      policyId, attachmentId: attachment.id,
      movedAlertIds: movedAlertRefs.map(a => a.id), movedAlertRefs, reusedMonitor: false });
    conversionIds.push(entry!.id);
  }
  const items = await tx.select().from(configPolicyMonitors).where(eq(configPolicyMonitors.featureLinkId, monitorsLinkId)).orderBy(configPolicyMonitors.sortOrder);
  const [link] = await tx.select().from(configPolicyFeatureLinks).where(eq(configPolicyFeatureLinks.id, monitorsLinkId)).for('update');
  await tx.update(configPolicyFeatureLinks).set({ inlineSettings: { ...(link?.inlineSettings as Record<string, unknown> ?? {}), inheritance: 'cumulative', items: items.map(r => ({ monitorId: r.monitorId, enabled: r.enabled, overrides: r.overrides, sortOrder: r.sortOrder })) }, updatedAt: new Date() }).where(eq(configPolicyFeatureLinks.id, monitorsLinkId));
  return { conversionIds, retired: 0, monitorsCreated: conversionIds.length, policyId };
}
export async function convertNetworkChecks(orgId: string, expectedHash: string, auth: AuthContext, opts: { sourceIds?: string[] } = {}) {
  assertOrgAccess(orgId, auth);
  assertPrerequisites();
  return inCallerTransaction(auth, async tx => {
    await lockConversion(tx, { orgId, partnerId: null });
    const full = await loadPendingNetworkChecks(orgId, tx);
    // Validate requested visibility before writing the globally unique ledger key.
    if (opts.sourceIds?.some(id => !full.rows.some(row => row.id === id))) throw new NetworkCheckConversionError('source_not_found', 404);
    if (networkPreviewHash(full.rows, full.rulesByMonitor) !== expectedHash) throw new NetworkCheckConversionError('stale_preview', 409);
    const selected = opts.sourceIds ? full.rows.filter(r => opts.sourceIds!.includes(r.id)) : full.rows;
    return adoptNetworkChecksInTx(orgId, expectedHash, auth, full, selected, tx);
  });
}
export async function countPendingNetworkChecks(orgId: string, auth: AuthContext): Promise<number> {
  assertOrgAccess(orgId, auth);
  return inCallerTransaction(auth, async tx => {
    const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(networkMonitors).where(and(eq(networkMonitors.orgId, orgId), isNull(networkMonitors.managedByMonitorId), isNull(networkMonitors.retiredAt)));
    return Number(row?.n ?? 0);
  });
}
