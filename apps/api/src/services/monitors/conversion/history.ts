import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { alerts, alertRules, monitorDefinitions, monitorConversions, monitorConversionOutputs, configPolicyMonitors } from '../../../db/schema';
import { OPEN_ALERT_STATUSES } from './loadSources';
import type { DbExecutor } from '../monitorCompiler';
import type { MonitorConversionOutputRow } from '../../../db/schema/monitorConversions';
import type { ConversionSourceTable } from './types';
export async function carryOpenAlerts(tx: DbExecutor, source: {
  sourceTable: ConversionSourceTable; sourceId: string; ruleId?: string; orgId?: string;
  compiledRuleId: string; monitorId: string;
}) {
  const match = source.ruleId ? eq(alerts.ruleId, source.ruleId)
    : source.sourceTable === 'network_monitors'
      ? sql`${alerts.context}->>'source' = 'network_monitor' AND ${alerts.context}->>'monitorId' = ${source.sourceId}`
      : eq(alerts.configPolicyId, source.sourceId);
  const original = await tx.select({ id: alerts.id, ruleId: alerts.ruleId, configPolicyId: alerts.configPolicyId,
    monitorId: alerts.monitorId, context: alerts.context, deviceId: alerts.deviceId, subjectKey: alerts.subjectKey }).from(alerts)
    .where(and(source.orgId ? eq(alerts.orgId, source.orgId) : undefined, match, inArray(alerts.status, [...OPEN_ALERT_STATUSES]))).for('update');
  // Refuse malformed historical JSON before changing any references.
  // The ledger's context contract is object-or-null; never coerce away history.
  for (const row of original) {
    if (row.context !== null && (typeof row.context !== 'object' || Array.isArray(row.context))) {
      throw new Error(`Alert ${row.id} has unsupported context`);
    }
  }
  const network = source.sourceTable === 'network_monitors';
  const subjectIdentity = (deviceId: string, subjectKey: string | null) => JSON.stringify([deviceId, subjectKey ?? '']);
  const reserved = new Set(original.map(row => subjectIdentity(row.deviceId, row.subjectKey)));
  const carried = new Set<string>();
  for (const row of original) {
    let subjectKey = row.subjectKey ?? null;
    const key = subjectIdentity(row.deviceId, subjectKey);
    // Legacy rules can each have an open alert for the same probe/device.
    // Preserve them all without violating the compiled rule's unique subject index.
    if (network && carried.has(key)) {
      const base = `network-conversion:${source.sourceId}:${row.id}`;
      subjectKey = base;
      let suffix = 0;
      while (reserved.has(subjectIdentity(row.deviceId, subjectKey))) subjectKey = `${base}:${++suffix}`;
      reserved.add(subjectIdentity(row.deviceId, subjectKey));
    }
    carried.add(key);
    await tx.update(alerts).set({ ruleId: source.compiledRuleId, configPolicyId: null,
      ...(network ? { subjectKey } : {}),
      monitorId: source.monitorId, context: { ...(row.context as Record<string, unknown> ?? {}), convertedFrom: {
        sourceTable: source.sourceTable, sourceId: source.sourceId, ruleId: source.ruleId ?? null,
      } } }).where(eq(alerts.id, row.id));
  }
  return original.map(({ deviceId: _deviceId, subjectKey, ...refs }) => ({
    ...refs, ...(network ? { subjectKey: subjectKey ?? null } : {}),
  })) as MonitorConversionOutputRow['movedAlertRefs'];
}
export async function restoreMovedAlertRefs(tx: DbExecutor, refs: Awaited<ReturnType<typeof carryOpenAlerts>>) {
  for (const { id, ...original } of refs) await tx.update(alerts).set(original).where(eq(alerts.id, id));
}
export async function canDeleteConversionMonitor(tx: DbExecutor, monitorId: string, conversionId: string) {
  const live = await tx.select({ id: monitorConversionOutputs.id }).from(monitorConversionOutputs)
    .innerJoin(monitorConversions, eq(monitorConversions.id, monitorConversionOutputs.conversionId))
    .where(and(eq(monitorConversionOutputs.monitorId, monitorId), ne(monitorConversions.id, conversionId), isNull(monitorConversions.revertedAt))).limit(1);
  const attachments = await tx.select({ id: configPolicyMonitors.id }).from(configPolicyMonitors)
    .where(eq(configPolicyMonitors.monitorId, monitorId)).limit(1);
  const history = await tx.select({ id: alerts.id }).from(alerts).where(eq(alerts.monitorId, monitorId)).limit(1);
  // Deleting the definition also deletes its compiled template. Preserve it
  // while any unmanaged rule owns a deployment through that template, even
  // when disabled or retired: those rows remain historical configuration.
  const unmanaged = await tx.select({ id: alertRules.id }).from(alertRules)
    .innerJoin(monitorDefinitions, eq(alertRules.templateId, monitorDefinitions.compiledAlertTemplateId))
    .where(and(eq(monitorDefinitions.id, monitorId), isNull(alertRules.managedByMonitorId))).limit(1);
  return live.length === 0 && attachments.length === 0 && history.length === 0 && unmanaged.length === 0;
}
