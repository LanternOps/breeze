import { and, eq, isNull, ne } from 'drizzle-orm';
import { alerts, configPolicyFeatureLinks, configPolicyMonitors, discoveredAssets, monitorConversions,
  monitorConversionOutputs, monitorDefinitions, networkMonitors, networkMonitorAlertRules } from '../../../db/schema';
import type { MonitorConversionOutputRow } from '../../../db/schema/monitorConversions';
import type { AuthContext } from '../../../middleware/auth';
import { canMutateOrgWideGovernance } from '../../siteCeilingAccess';
import type { DbExecutor } from '../monitorCompiler';
import { networkIdentityTlsReset } from '../networkIdentity';
import { carryOpenAlerts } from './history';
import { inCallerTransaction, lockConversion } from './convert';
import { canonical, sha } from './mapping';
import { isRevertAvailable } from './lifecycle';

type Row = typeof networkMonitors.$inferSelect;
type Definition = typeof monitorDefinitions.$inferSelect;
type Conversion = typeof monitorConversions.$inferSelect;
type RuleSnapshot = { id: string; retiredAt: string | null; retiredReason: string | null; isActive: boolean };
export type NetworkSourceSnapshot = Pick<Row, 'name' | 'monitorType' | 'target' | 'pollingInterval' | 'timeout'
  | 'assetId' | 'siteId' | 'isActive' | 'retiredReason'> & {
  config: Record<string, unknown>; retiredAt: string | null; rules: RuleSnapshot[];
};
export class NetworkHistoryError extends Error {
  constructor(public code: string, public status: 400 | 403 | 404 | 409) { super(code); }
}
function assertAccess(orgId: string | null, auth: AuthContext): asserts orgId is string {
  if (!canMutateOrgWideGovernance(auth)) throw new NetworkHistoryError('site_restricted_conversion', 403);
  if (!orgId || !auth.canAccessOrg(orgId)) throw new NetworkHistoryError('source_not_found', 404);
}
export async function snapshotNetworkSource(tx: DbExecutor, row: Row): Promise<NetworkSourceSnapshot> {
  const rules = await tx.select().from(networkMonitorAlertRules).where(eq(networkMonitorAlertRules.monitorId, row.id)).for('update');
  return { name: row.name, monitorType: row.monitorType, target: row.target, config: row.config as Record<string, unknown>,
    pollingInterval: row.pollingInterval, timeout: row.timeout, assetId: row.assetId, siteId: row.siteId, isActive: row.isActive,
    retiredAt: row.retiredAt?.toISOString() ?? null, retiredReason: row.retiredReason,
    rules: rules.map(r => ({ id: r.id, retiredAt: r.retiredAt?.toISOString() ?? null,
      retiredReason: r.retiredReason, isActive: r.isActive })) };
}
export async function carryNetworkAlerts(tx: DbExecutor, row: Row, def: Definition): Promise<MonitorConversionOutputRow['movedAlertRefs']> {
  if (!def.compiledAlertRuleId) throw new Error('network_compiled_rule_missing');
  if (!row.orgId) throw new NetworkHistoryError('source_not_found', 404);
  return carryOpenAlerts(tx, { sourceTable: 'network_monitors', sourceId: row.id, orgId: row.orgId,
    compiledRuleId: def.compiledAlertRuleId, monitorId: def.id });
}
export async function retireNetworkCheckInTx(tx: DbExecutor, sourceId: string, reason: string, auth: AuthContext): Promise<{ conversionId: string }> {
  if (!canMutateOrgWideGovernance(auth)) throw new NetworkHistoryError('site_restricted_conversion', 403);
  if (reason !== 'operator' && !/^unconvertible:[a-z][a-z0-9_]*$/.test(reason)) throw new NetworkHistoryError('invalid_retirement_reason', 400);
  // Check caller visibility before the global live-source key or any writes.
  const [first] = await tx.select().from(networkMonitors).where(eq(networkMonitors.id, sourceId)).limit(1);
  assertAccess(first?.orgId ?? null, auth);
  await lockConversion(tx, first!);
  const [row] = await tx.select().from(networkMonitors).where(eq(networkMonitors.id, sourceId)).for('update');
  assertAccess(row?.orgId ?? null, auth);
  if (!row || row.retiredAt || row.managedByMonitorId) throw new NetworkHistoryError('already_converted', 409);
  const [live] = await tx.select().from(monitorConversions).where(and(eq(monitorConversions.sourceTable, 'network_monitors'),
    eq(monitorConversions.sourceId, sourceId), isNull(monitorConversions.revertedAt))).limit(1);
  if (live) throw new NetworkHistoryError('already_converted', 409);
  const networkSourceSnapshot = await snapshotNetworkSource(tx, row);
  const [entry] = await tx.insert(monitorConversions).values({ orgId: row.orgId, partnerId: null,
    sourceTable: 'network_monitors', sourceId, policyId: null, sourceState: { name: row.name },
    convertedBy: auth.scope === 'system' ? null : auth.user.id,
    previewHash: sha(canonical({ sourceId, reason, networkSourceSnapshot })), networkSourceSnapshot,
  }).onConflictDoNothing().returning({ id: monitorConversions.id });
  if (!entry) throw new NetworkHistoryError('already_converted', 409);
  const now = new Date();
  await tx.update(networkMonitors).set({ retiredAt: now, retiredReason: reason, isActive: false, updatedAt: now })
    .where(and(eq(networkMonitors.id, sourceId), eq(networkMonitors.orgId, row.orgId!)));
  await tx.update(networkMonitorAlertRules).set({ retiredAt: now, retiredReason: reason })
    .where(and(eq(networkMonitorAlertRules.monitorId, sourceId), isNull(networkMonitorAlertRules.retiredAt)));
  return { conversionId: entry.id };
}
export async function retireNetworkCheck(sourceId: string, reason: string, auth: AuthContext): Promise<{ conversionId: string }> {
  return inCallerTransaction(auth, tx => retireNetworkCheckInTx(tx, sourceId, reason, auth));
}

export async function revertNetworkCheckConversionInTx(tx: DbExecutor, conversion: Conversion, auth: AuthContext): Promise<void> {
  assertAccess(conversion.orgId, auth);
  if (!isRevertAvailable('network_monitors')) throw new NetworkHistoryError('conversion_revert_unavailable', 409);
  await lockConversion(tx, conversion);
  let [entry] = await tx.select().from(monitorConversions).where(eq(monitorConversions.id, conversion.id));
  if (!entry || entry.revertedAt) throw new NetworkHistoryError('already_reverted', 409);
  assertAccess(entry.orgId, auth);
  if (entry.sourceTable !== 'network_monitors') throw new NetworkHistoryError('source_not_found', 404);
  if (entry.sourceState?.sourceReleased === true) throw new NetworkHistoryError('source_released', 409);
  const initialOutputs = await tx.select().from(monitorConversionOutputs).where(eq(monitorConversionOutputs.conversionId, entry.id));
  const ids = [...new Set(initialOutputs.flatMap(o => o.monitorId ? [o.monitorId] : []))].sort();
  // Global row-lock order: monitor_definitions -> network_monitors -> ledger rows.
  // Read output ownership without locking first; the serializable caller transaction
  // retries if a concurrent deletion/revert changes it before these locks are held.
  const definitions = new Map<string, Definition>();
  for (const id of ids) {
    const [definition] = await tx.select().from(monitorDefinitions).where(eq(monitorDefinitions.id, id)).for('update');
    if (definition) definitions.set(id, definition);
  }
  const [row] = await tx.select().from(networkMonitors)
    .where(and(eq(networkMonitors.id, entry.sourceId), eq(networkMonitors.orgId, entry.orgId))).for('update');
  const [lockedEntry] = await tx.select().from(monitorConversions).where(eq(monitorConversions.id, conversion.id)).for('update');
  if (!lockedEntry || lockedEntry.revertedAt) throw new NetworkHistoryError('already_reverted', 409);
  if (lockedEntry.sourceState?.sourceReleased === true) throw new NetworkHistoryError('source_released', 409);
  if (lockedEntry.orgId !== entry.orgId || lockedEntry.sourceId !== entry.sourceId || lockedEntry.sourceTable !== 'network_monitors') {
    throw new NetworkHistoryError('source_not_found', 404);
  }
  entry = lockedEntry;
  assertAccess(entry.orgId, auth);
  if (!row) throw new NetworkHistoryError('source_not_found', 404);
  const source = entry.networkSourceSnapshot as NetworkSourceSnapshot | null;
  if (!source) throw new NetworkHistoryError('network_source_snapshot_missing', 409);
  const outputs = await tx.select().from(monitorConversionOutputs).where(eq(monitorConversionOutputs.conversionId, entry.id)).for('update');
  const lockedIds = [...new Set(outputs.flatMap(o => o.monitorId ? [o.monitorId] : []))].sort();
  if (canonical(ids) !== canonical(lockedIds) || (row.managedByMonitorId && !ids.includes(row.managedByMonitorId))) {
    throw new NetworkHistoryError('network_revert_in_use', 409);
  }
  const links = new Set<string>();
  for (const id of ids) {
    const definition = definitions.get(id);
    if (!definition || definition.orgId !== entry.orgId) throw new NetworkHistoryError('network_revert_in_use', 409);
    const [other] = await tx.select({ id: monitorConversions.id }).from(monitorConversionOutputs)
      .innerJoin(monitorConversions, eq(monitorConversions.id, monitorConversionOutputs.conversionId))
      .where(and(eq(monitorConversionOutputs.monitorId, id), ne(monitorConversions.id, entry.id), isNull(monitorConversions.revertedAt))).limit(1);
    const attachments = await tx.select({ id: configPolicyMonitors.id, featureLinkId: configPolicyMonitors.featureLinkId,
      policyId: configPolicyFeatureLinks.configPolicyId }).from(configPolicyMonitors)
      .innerJoin(configPolicyFeatureLinks, eq(configPolicyFeatureLinks.id, configPolicyMonitors.featureLinkId))
      .where(eq(configPolicyMonitors.monitorId, id));
    if (other || attachments.some(a => a.policyId !== entry.policyId || !outputs.some(o => o.attachmentId === a.id))) {
      throw new NetworkHistoryError('network_revert_in_use', 409);
    }
    for (const attachment of attachments) links.add(attachment.featureLinkId);
  }
  let siteId = source.siteId;
  if (source.assetId) {
    const [asset] = await tx.select({ siteId: discoveredAssets.siteId }).from(discoveredAssets)
      .where(and(eq(discoveredAssets.id, source.assetId), eq(discoveredAssets.orgId, entry.orgId))).for('update');
    if (!asset) throw new NetworkHistoryError('source_not_found', 404);
    siteId = asset.siteId;
  }
  for (const output of outputs) {
    for (const { id, ...refs } of output.movedAlertRefs) await tx.update(alerts).set(refs)
      .where(and(eq(alerts.id, id), eq(alerts.orgId, entry.orgId)));
    if (!output.monitorId) continue;
    const later = await tx.select().from(alerts).where(and(eq(alerts.monitorId, output.monitorId), eq(alerts.orgId, entry.orgId))).for('update');
    for (const alert of later) await tx.update(alerts).set({ ruleId: null, configPolicyId: null, monitorId: null,
      context: { ...(alert.context as Record<string, unknown> ?? {}), source: 'network_monitor',
        monitorId: entry.sourceId, legacyNetworkMonitorId: entry.sourceId,
        alertRuleId: source.rules.find(r => r.isActive && !r.retiredAt)?.id,
        convertedFrom: { sourceTable: 'network_monitors', sourceId: entry.sourceId, revertedConversionId: entry.id } },
    }).where(and(eq(alerts.id, alert.id), eq(alerts.orgId, entry.orgId)));
  }
  // Release before deleting the definition: its FK otherwise cascades the probe and results.
  const { rules, retiredAt, ...values } = source;
  await tx.update(networkMonitors).set({ ...values, siteId, retiredAt: retiredAt ? new Date(retiredAt) : null,
    ...networkIdentityTlsReset(row, source), managedByMonitorId: null, updatedAt: new Date() })
    .where(and(eq(networkMonitors.id, entry.sourceId), eq(networkMonitors.orgId, entry.orgId)));
  for (const rule of rules) await tx.update(networkMonitorAlertRules).set({ isActive: rule.isActive,
    retiredAt: rule.retiredAt ? new Date(rule.retiredAt) : null, retiredReason: rule.retiredReason })
    .where(and(eq(networkMonitorAlertRules.id, rule.id), eq(networkMonitorAlertRules.monitorId, entry.sourceId)));
  for (const id of ids) await tx.delete(monitorDefinitions).where(and(eq(monitorDefinitions.id, id), eq(monitorDefinitions.orgId, entry.orgId)));
  // Keep retained feature links, but remove cascaded attachments from their inline projection.
  for (const id of links) {
    const [link] = await tx.select().from(configPolicyFeatureLinks).where(eq(configPolicyFeatureLinks.id, id)).for('update');
    if (!link) continue;
    const remaining = await tx.select().from(configPolicyMonitors).where(eq(configPolicyMonitors.featureLinkId, id)).orderBy(configPolicyMonitors.sortOrder);
    await tx.update(configPolicyFeatureLinks).set({ inlineSettings: { ...(link.inlineSettings as Record<string, unknown> ?? {}),
      items: remaining.map(r => ({ monitorId: r.monitorId, enabled: r.enabled, overrides: r.overrides, sortOrder: r.sortOrder })) },
      updatedAt: new Date() }).where(eq(configPolicyFeatureLinks.id, id));
  }
  await tx.update(monitorConversions).set({ revertedAt: new Date() }).where(eq(monitorConversions.id, entry.id));
}
export async function revertNetworkCheckConversion(conversion: Conversion, _outputMonitorIds: string[], auth: AuthContext): Promise<void> {
  // Output ownership is reloaded from the ledger under the lock, never trusted from a caller.
  return inCallerTransaction(auth, tx => revertNetworkCheckConversionInTx(tx, conversion, auth));
}
