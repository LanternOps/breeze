import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { alerts, alertRules, monitorDefinitions, monitorConversions, monitorConversionOutputs, configPolicyMonitors } from '../../../db/schema';
import { OPEN_ALERT_STATUSES } from './loadSources';
import type { DbExecutor } from '../monitorCompiler';
import type { ConversionSourceTable } from './types';
export async function carryOpenAlerts(tx: DbExecutor, source: {
  sourceTable: ConversionSourceTable; sourceId: string; ruleId?: string;
  compiledRuleId: string; monitorId: string;
}) {
  const match = source.ruleId ? eq(alerts.ruleId, source.ruleId)
    : source.sourceTable === 'network_monitors'
      ? sql`${alerts.context}->>'source' = 'network_monitor' AND ${alerts.context}->>'monitorId' = ${source.sourceId}`
      : eq(alerts.configPolicyId, source.sourceId);
  const original = await tx.select({ id: alerts.id, ruleId: alerts.ruleId, configPolicyId: alerts.configPolicyId,
    monitorId: alerts.monitorId, context: alerts.context }).from(alerts)
    .where(and(match, inArray(alerts.status, [...OPEN_ALERT_STATUSES]))).for('update');
  // Refuse malformed historical JSON before changing any references.
  // The ledger's context contract is object-or-null; never coerce away history.
  for (const row of original) {
    if (row.context !== null && (typeof row.context !== 'object' || Array.isArray(row.context))) {
      throw new Error(`Alert ${row.id} has unsupported context`);
    }
  }
  for (const row of original) await tx.update(alerts).set({ ruleId: source.compiledRuleId, configPolicyId: null,
    monitorId: source.monitorId, context: { ...(row.context as Record<string, unknown> ?? {}), convertedFrom: {
      sourceTable: source.sourceTable, sourceId: source.sourceId, ruleId: source.ruleId ?? null,
    } } }).where(eq(alerts.id, row.id));
  return original as Array<{ id: string; ruleId: string | null; configPolicyId: string | null; monitorId: string | null; context: Record<string, unknown> | null }>;
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
