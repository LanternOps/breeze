import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { monitorDeliveryModeSchema } from '@breeze/shared';
import { db, getCurrentDbAccessContext, withDbAccessContext } from '../../../db';
import { automations, configPolicyAlertRules, configPolicyAutomations, configPolicyFeatureLinks,
  configPolicyMonitoringWatches, configPolicyMonitors, devices, monitorConversions, monitorConversionOutputs, monitorDefinitions } from '../../../db/schema';
import type { AuthContext } from '../../../middleware/auth';
import { addFeatureLink } from '../../configurationPolicy';
import { resolveDelivery } from '../../delivery/resolveDelivery';
import { resolveLegacyDeliveryBaseline } from './legacyDeliveryBaseline';
import { canManagePartnerWidePolicies } from '../../partnerWideAccess';
import { canMutateOrgWideGovernance } from '../../siteCeilingAccess';
import { createMonitorDefinition } from '../monitorService';
import { resolveMonitorsForDevice } from '../monitorResolver';
import { applyOverrides, getMonitorKindSpec } from '../kinds';
import { resolveLegacyBaseline, type DbExecutor, type LegacyBaseline } from './legacyBaseline';
import { loadPolicySources, type PolicySources } from './loadSources';
import { canonical, sha, mapInlineRule, mapWatch, mapAutomationResponses, mergeResponseProposals, monitorSignature } from './mapping';
import type { ConversionPreviewItem, ConversionSourceTable, EquivalenceDelta, ProposedMonitor } from './types';
import { ConversionError } from './convert';
import { rehomePolicyWorkflow } from './workflows';
import { carryOpenAlerts } from './history';

export { resolveDeviceIdsForPolicy } from './legacyBaseline';
export interface EquivalenceProposal {
  previewHash?: string;
  policy: PolicySources['policy'];
  inheritanceMode: 'cumulative' | 'replace';
  bySource: Array<{ sourceTable: ConversionSourceTable; sourceId: string; monitors: ProposedMonitor[];
    workflow?: ConversionPreviewItem['workflow']; responseTargetSourceId?: string }>;
}
class PreviewRollback extends Error {}

async function effectiveSignature(p: ProposedMonitor, input: Parameters<typeof resolveDelivery>[0], executor: DbExecutor,
  legacy?: Parameters<typeof resolveLegacyDeliveryBaseline>[1]) {
  const resolved = legacy === undefined
    ? await resolveDelivery(input, executor)
    : await resolveLegacyDeliveryBaseline(input, legacy, executor);
  return sha(canonical({ behavior: monitorSignature({ ...p, deliveryMode: 'channels',
    deliveryChannelIds: resolved.channelIds, escalationPolicyId: resolved.escalationPolicyId }),
    skippedChannelIds: [...resolved.skippedChannelIds].sort((a, b) => a.id.localeCompare(b.id)),
  }));
}

export async function signatureMapForLegacy(deviceId: string, effective: LegacyBaseline, executor: DbExecutor): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const [device] = await executor.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
  if (!device) throw new ConversionError('preview_stale', 'Device no longer visible');
  for (const row of effective.rules) {
    if (row.retiredAt) continue;
    const mapped = mapInlineRule(row);
    if (!mapped.ok) { out.set(`legacy:${row.id}`, sha(canonical(row))); continue; }
    const candidates = await executor.select().from(automations).where(and(isNull(automations.retiredAt),
      isNull(automations.managedByMonitorId), eq(automations.enabled, true),
      sql`${automations.trigger}->>'type' = 'event'`, sql`${automations.trigger}->>'eventType' = 'alert.triggered'`,
      sql`${automations.trigger}->'filter'->>'configPolicyAlertRuleId' = ${row.id}`)).orderBy(automations.id);
    const responses: ConversionPreviewItem[] = candidates.map((a) => ({ sourceTable: 'automations', sourceId: a.id, name: a.name,
      outcome: 'convertible', proposed: [], notes: [], openAlerts: 0,
      responseTargetSourceId: row.id, responseActions: mapAutomationResponses(a).actions }));
    const [item] = mergeResponseProposals([{ sourceTable: 'config_policy_alert_rules', sourceId: row.id, name: row.name,
      outcome: 'convertible', proposed: mapped.proposed, notes: [], openAlerts: 0 }, ...responses]);
    for (const p of item!.proposed) out.set(`rule:${row.id}:${p.role}`, await effectiveSignature(p, {
      orgId: device.orgId, siteId: device.siteId, severity: p.severity, kind: null,
    }, executor, { channelIds: row.notificationChannelIds, escalationPolicyId: row.escalationPolicyId }));
  }
  for (const row of effective.monitoring?.watches ?? []) {
    if (!row.enabled || row.retiredAt) continue;
    const mapped = mapWatch(row);
    if (!mapped.ok) { out.set(`legacy:watch:${row.id}`, sha(canonical(row))); continue; }
    for (const p of mapped.proposed) out.set(`watch:${row.id}:${p.role}`, await effectiveSignature(p,
      { orgId: device.orgId, siteId: device.siteId, severity: p.severity, kind: null }, executor, {}));
  }
  return out;
}

export async function signatureMapForMonitors(deviceId: string, executor: DbExecutor): Promise<Map<string, string>> {
  const res = await resolveMonitorsForDevice(deviceId, executor);
  const out = new Map<string, string>();
  if (res.kind !== 'resolved') throw new ConversionError('preview_stale', 'Device no longer visible');
  const enabled = res.monitors.filter((m) => m.enabled);
  if (enabled.length === 0) return out;
  const defs = await executor.select().from(monitorDefinitions).where(inArray(monitorDefinitions.id, enabled.map((m) => m.monitorId)));
  const [device] = await executor.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
  if (!device) throw new ConversionError('preview_stale', 'Device no longer visible');
  for (const def of defs) {
    if (!def.enabled) continue;
    const eff = enabled.find((m) => m.monitorId === def.id)!;
    const spec = getMonitorKindSpec(def.kind);
    const condition = applyOverrides(spec, spec.conditionSchema.parse(def.condition), eff.overrides);
    const severity = (eff.overrides?.severity as ProposedMonitor['severity']) ?? def.severity;
    out.set(`monitor:${def.id}`, await effectiveSignature({
      enabled: true, role: 'primary', name: def.name, kind: def.kind, condition, severity,
      cooldownMinutes: def.cooldownMinutes, autoResolve: def.autoResolve, deliveryMode: monitorDeliveryModeSchema.parse(def.deliveryMode),
      deliveryChannelIds: def.deliveryChannelIds, escalationPolicyId: def.escalationPolicyId, responses: def.responses,
    }, { orgId: device.orgId, siteId: device.siteId, monitorId: def.id, kind: def.kind, severity }, executor));
  }
  return out;
}

export function diffSignatureSets(before: Map<string, string>, after: Map<string, string>): string[] {
  const counts = (values: Map<string, string>) => {
    const out = new Map<string, number>();
    for (const value of values.values()) out.set(value, (out.get(value) ?? 0) + 1);
    return out;
  };
  const a = counts(before), b = counts(after), deltas: string[] = [];
  for (const signature of new Set([...a.keys(), ...b.keys()])) {
    const delta = (b.get(signature) ?? 0) - (a.get(signature) ?? 0);
    if (delta) deltas.push(`${delta > 0 ? 'gains' : 'loses'} ${Math.abs(delta)} condition instance(s): ${signature}`);
  }
  return deltas;
}

/** Shared transactional write core. The caller owns commit/rollback and freshness locking. */
export async function applyProposalInTx(tx: DbExecutor, proposal: EquivalenceProposal, auth: AuthContext) {
  if (!canMutateOrgWideGovernance(auth)) throw new ConversionError('partner_wide_denied', 'Full policy scope is required');
  // D29: use caller RLS, and verify EVERY source before touching the global ledger index.
  const sources = await loadPolicySources(proposal.policy.id, tx);
  if (!sources) throw new ConversionError('policy_not_found', 'Policy not found');
  const policy = sources.policy;
  if (policy.orgId ? !auth.canAccessOrg(policy.orgId)
    : (!canManagePartnerWidePolicies(auth) || (auth.scope !== 'system' && auth.partnerId !== policy.partnerId))) {
    throw new ConversionError('partner_wide_denied', 'Policy owner access denied');
  }
  if (policy.orgId !== proposal.policy.orgId || policy.partnerId !== proposal.policy.partnerId) {
    throw new ConversionError('preview_stale', 'Policy ownership changed');
  }
  const sourceRows = proposal.bySource.map((item) => {
    const rows = item.sourceTable === 'config_policy_alert_rules' ? sources.inlineRules
      : item.sourceTable === 'config_policy_monitoring_watches' ? sources.watches
      : item.sourceTable === 'config_policy_automations' ? sources.policyAutomations
      : item.sourceTable === 'automations' ? sources.standaloneAutomations : [];
    const row = rows.find((r) => r.id === item.sourceId);
    if (!row || row.retiredAt) throw new ConversionError('source_not_found', 'Source not found');
    return { item, row };
  });
  if (!sourceRows.length) return { conversionIds: [], retired: 0, monitorsCreated: 0 };
  const owner = { orgId: policy.orgId, partnerId: policy.partnerId };
  const visibleDefinitions = await tx.select().from(monitorDefinitions).where(policy.orgId
    ? eq(monitorDefinitions.orgId, policy.orgId)
    : and(isNull(monitorDefinitions.orgId), eq(monitorDefinitions.partnerId, policy.partnerId!)));
  let link = sources.links.monitors;
  const previousLink = link ? structuredClone(link) : null;
  let monitorsCreated = 0;
  const conversionIds: string[] = [];
  const targets = new Map<string, { conversionId: string; monitorId: string; reusedMonitor: boolean }>();
  // Response sources refer to the ledger/primary output of their already-merged target.
  sourceRows.sort((a, b) => Number(!!a.item.responseTargetSourceId) - Number(!!b.item.responseTargetSourceId));
  for (const { item, row } of sourceRows) {
    const [live] = await tx.select().from(monitorConversions).where(and(
      eq(monitorConversions.sourceTable, item.sourceTable), eq(monitorConversions.sourceId, item.sourceId),
      isNull(monitorConversions.revertedAt))).limit(1);
    if (live) throw new ConversionError('already_converted', 'Source already converted');
    const sourceState: Record<string, unknown> = { source: row, monitorsLink: previousLink };
    let workflowId: string | undefined;
    if (item.sourceTable === 'config_policy_automations') {
      workflowId = await rehomePolicyWorkflow(tx, row as typeof configPolicyAutomations.$inferSelect, policy, auth);
      sourceState.workflowId = workflowId;
    }
    const target = item.responseTargetSourceId ? targets.get(item.responseTargetSourceId) : undefined;
    if (item.responseTargetSourceId && !target) throw new ConversionError('blocked', 'Response target must be converted with its source');
    if (target) {
      sourceState.targetConversionId = target.conversionId;
      sourceState.targetReusedMonitor = target.reusedMonitor;
      sourceState.addedActions = mapAutomationResponses(row as typeof automations.$inferSelect).actions;
    }
    const [ledger] = await tx.insert(monitorConversions).values({ ...owner, sourceTable: item.sourceTable,
      sourceId: item.sourceId, policyId: policy.id, convertedBy: auth.scope === 'system' ? null : auth.user.id,
      previewHash: proposal.previewHash ?? sha(canonical(proposal)), sourceState,
    }).onConflictDoNothing().returning();
    if (!ledger) throw new ConversionError('already_converted', 'Source already converted');
    conversionIds.push(ledger.id);
    let primaryId: string | null = target?.monitorId ?? null;
    for (const proposed of item.monitors) {
      let monitor = visibleDefinitions.find((candidate) => candidate.orgId === policy.orgId && candidate.partnerId === policy.partnerId
        && candidate.autoResolveConditions === null && candidate.aiAgentId === null
        && candidate.recurrenceThreshold === null && candidate.recurrenceWindowHours === null
        && candidate.recurrenceActions.length === 0 && candidate.pauseResponsesOnEscalation
        && monitorSignature({ ...candidate, deliveryMode: monitorDeliveryModeSchema.parse(candidate.deliveryMode) }) === monitorSignature(proposed));
      const reusedMonitor = !!monitor;
      if (!monitor) {
        monitor = await createMonitorDefinition({ ...proposed, ownerScope: policy.orgId ? 'organization' : 'partner',
          orgId: policy.orgId ?? undefined, recurrenceActions: [], pauseResponsesOnEscalation: true,
        } as Parameters<typeof createMonitorDefinition>[0], { ...auth, partnerId: policy.partnerId ?? auth.partnerId }, {}, tx);
        visibleDefinitions.push(monitor);
        monitorsCreated++;
      }
      if (!link) {
        const created = await addFeatureLink(policy.id, 'monitors', null, { inheritance: proposal.inheritanceMode, items: [] }, undefined, tx);
        if (!created) throw new ConversionError('preview_stale', 'Monitor link changed');
        link = { id: created.id, inheritance: proposal.inheritanceMode, items: [] };
      }
      const existing = await tx.select().from(configPolicyMonitors).where(eq(configPolicyMonitors.featureLinkId, link.id));
      const inserted = existing.some((e) => e.monitorId === monitor!.id) ? []
        : await tx.insert(configPolicyMonitors).values({ featureLinkId: link.id, monitorId: monitor.id,
          enabled: proposed.enabled, overrides: null, sortOrder: Math.max(-1, ...existing.map((e) => e.sortOrder)) + 1 }).returning();
      await tx.update(configPolicyFeatureLinks).set({ inlineSettings: { inheritance: proposal.inheritanceMode,
        items: [...existing, ...inserted].map((r) => ({ monitorId: r.monitorId, enabled: r.enabled, overrides: r.overrides, sortOrder: r.sortOrder })) },
        updatedAt: new Date() }).where(eq(configPolicyFeatureLinks.id, link.id));
      let movedAlertRefs: Awaited<ReturnType<typeof carryOpenAlerts>> = [];
      if (item.sourceTable === 'config_policy_alert_rules' && proposed.role === 'primary') {
        if (!monitor.compiledAlertRuleId) throw new ConversionError('blocked', 'Converted monitor has no compiled alert rule');
        movedAlertRefs = await carryOpenAlerts(tx, { sourceTable: item.sourceTable, sourceId: item.sourceId,
          compiledRuleId: monitor.compiledAlertRuleId, monitorId: monitor.id });
      }
      await tx.insert(monitorConversionOutputs).values({ ...owner, conversionId: ledger.id, monitorId: monitor.id,
        role: proposed.role, policyId: policy.id, attachmentId: inserted[0]?.id ?? null, reusedMonitor,
        movedAlertIds: movedAlertRefs.map((a) => a.id), movedAlertRefs });
      if (proposed.role === 'primary') { primaryId = monitor.id; targets.set(item.sourceId, { conversionId: ledger.id, monitorId: monitor.id, reusedMonitor }); }
    }
    if (target) await tx.insert(monitorConversionOutputs).values({ ...owner, conversionId: ledger.id,
      monitorId: target.monitorId, role: 'response', policyId: policy.id, attachmentId: null, reusedMonitor: true });
    const retirement = { retiredAt: new Date(), retiredReason: 'operator', convertedToMonitorId: primaryId };
    const table = item.sourceTable === 'config_policy_alert_rules' ? configPolicyAlertRules
      : item.sourceTable === 'config_policy_monitoring_watches' ? configPolicyMonitoringWatches
      : item.sourceTable === 'config_policy_automations' ? configPolicyAutomations : automations;
    const retired = await tx.update(table).set(retirement).where(and(eq(table.id, item.sourceId), isNull(table.retiredAt))).returning({ id: table.id });
    if (!retired.length) throw new ConversionError('already_converted', 'Source already converted');
  }
  return { conversionIds, retired: conversionIds.length, monitorsCreated };
}

export async function computeEquivalence(proposal: EquivalenceProposal, deviceIds: string[], auth: AuthContext,
  onProgress?: (checked: number, total: number) => Promise<void> | void, executor: DbExecutor = db): Promise<{ devicesChecked: number; deltas: EquivalenceDelta[] }> {
  const deltas: EquivalenceDelta[] = [];
  const before = new Map<string, Map<string, string>>();
  let checked = 0, omitted = 0;
  const ids = [...new Set(deviceIds)];
  const signatures = async (id: string, tx: DbExecutor) => new Map([
    ...await signatureMapForLegacy(id, await resolveLegacyBaseline(id, tx), tx),
    ...await signatureMapForMonitors(id, tx),
  ]);
  try {
    const evaluate = () => executor.transaction(async (tx) => {
      for (const id of ids) before.set(id, await signatures(id, tx));
      await applyProposalInTx(tx, proposal, auth);
      for (const id of ids) {
        for (const detail of diffSignatureSets(before.get(id)!, await signatures(id, tx))) {
          if (deltas.length < 200) deltas.push({ deviceId: id, detail }); else omitted++;
        }
        checked++;
        if (onProgress && (checked % 50 === 0 || checked === ids.length)) await onProgress(checked, ids.length);
      }
      throw new PreviewRollback();
    }, { isolationLevel: 'repeatable read' });
    if (executor === db) {
      const context = getCurrentDbAccessContext();
      if (!context) throw new Error('Equivalence requires caller DB context');
      await withDbAccessContext(context, evaluate, { isolationLevel: 'repeatable read' });
    } else {
      // The preview builder passes an executor from its repeatable-read snapshot.
      await evaluate();
    }
  } catch (err) {
    if (!(err instanceof PreviewRollback)) throw err;
  }
  if (omitted) deltas.push({ deviceId: '*', detail: `… and ${omitted} more differences` });
  return { devicesChecked: checked, deltas };
}
