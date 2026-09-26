/**
 * Source row -> fix-memory signature. Reads only; runs on the ambient db, so
 * the CALLER chooses the context. The outcome watcher and memory attach run it
 * under system context, so a partner-wide template invisible to an org token
 * never produces a different signature for the same alert.
 */
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  alertCorrelationGroups, alertRules, alertTemplates, alerts, devices, metricAnomalies, metricAnomalyEpisodes,
} from '../../db/schema';
import { episodeKeyFor } from '../metricAnomalyEpisodeKeys';
import {
  alertConditionFacets, anomalyConditionFacets, computeSignature, isFixOsFamily,
  type FixOsFamily, type FixSignature,
} from './signature';

export type FixSourceRef =
  | { kind: 'alert'; alertId: string }
  | { kind: 'anomaly'; anomalyId?: string | null; anomalyEpisodeId?: string | null }
  | { kind: 'correlation'; correlationGroupId: string };

export interface ResolvedFixSource {
  signature: FixSignature;
  deviceId: string;
  alertId: string | null;
  anomalyEpisodeId: string | null;
}

export function sourceRefFor(row: { sourceType: string; sourceId: string; anomalyEpisodeId?: string | null }): FixSourceRef | null {
  switch (row.sourceType) {
    case 'alert': return { kind: 'alert', alertId: row.sourceId };
    case 'anomaly': return { kind: 'anomaly', anomalyId: row.sourceId, anomalyEpisodeId: row.anomalyEpisodeId ?? null };
    case 'correlation': return { kind: 'correlation', correlationGroupId: row.sourceId };
    default: return null; // rca: no observable condition
  }
}

async function deviceOs(deviceId: string): Promise<FixOsFamily | null> {
  const [row] = await db.select({ osType: devices.osType }).from(devices).where(eq(devices.id, deviceId)).limit(1);
  return isFixOsFamily(row?.osType) ? row!.osType as FixOsFamily : null;
}

async function ruleConditionsFor(ruleId: string | null): Promise<unknown | null> {
  if (!ruleId) return null;
  const [rule] = await db
    .select({ templateId: alertRules.templateId, overrideSettings: alertRules.overrideSettings })
    .from(alertRules).where(eq(alertRules.id, ruleId)).limit(1);
  if (!rule) return null;
  const overrides = rule.overrideSettings as Record<string, unknown> | null;
  if (overrides && overrides.conditions !== undefined && overrides.conditions !== null) return overrides.conditions;
  const [template] = await db
    .select({ conditions: alertTemplates.conditions })
    .from(alertTemplates).where(eq(alertTemplates.id, rule.templateId)).limit(1);
  return template?.conditions ?? null;
}

async function anomalySource(ref: { anomalyId?: string | null; anomalyEpisodeId?: string | null }):
  Promise<{ episodeKey: string; deviceId: string; episodeId: string | null } | null> {
  if (ref.anomalyEpisodeId) {
    const [ep] = await db
      .select({ episodeKey: metricAnomalyEpisodes.episodeKey, deviceId: metricAnomalyEpisodes.deviceId })
      .from(metricAnomalyEpisodes).where(eq(metricAnomalyEpisodes.id, ref.anomalyEpisodeId)).limit(1);
    if (ep) return { episodeKey: ep.episodeKey, deviceId: ep.deviceId, episodeId: ref.anomalyEpisodeId };
  }
  if (!ref.anomalyId) return null;
  const [a] = await db
    .select({
      sourceTable: metricAnomalies.sourceTable, anomalyType: metricAnomalies.anomalyType,
      metricName: metricAnomalies.metricName, episodeId: metricAnomalies.episodeId, deviceId: metricAnomalies.deviceId,
    })
    .from(metricAnomalies).where(eq(metricAnomalies.id, ref.anomalyId)).limit(1);
  if (!a) return null;
  return { episodeKey: episodeKeyFor(a.sourceTable, a.anomalyType, a.metricName).episodeKey, deviceId: a.deviceId, episodeId: a.episodeId ?? null };
}

export async function alertSignature(alertId: string, family: 'alert' | 'correlation' = 'alert'): Promise<ResolvedFixSource | null> {
  const [alert] = await db
    .select({ id: alerts.id, deviceId: alerts.deviceId, ruleId: alerts.ruleId, context: alerts.context, requiresHuman: alerts.requiresHuman })
    .from(alerts).where(eq(alerts.id, alertId)).limit(1);
  if (!alert) return null;
  const os = await deviceOs(alert.deviceId);
  if (!os) return null;
  const context = (alert.context ?? null) as Record<string, unknown> | null;

  if (context?.source === 'metric_anomaly' && typeof context.anomalyId === 'string') {
    const anomaly = await anomalySource({ anomalyId: context.anomalyId });
    if (!anomaly) return null;
    const facets = anomalyConditionFacets(anomaly.episodeKey);
    // A direct alert lookup (family 'alert', the default) always maps to the
    // anomaly family — the metric-anomaly semantics ARE the signature. A
    // correlation lookup (root alert happens to be metric-anomaly-sourced)
    // keeps family 'correlation' with rootInferred true, same as every other
    // correlation path below — the root's condition, not its own family.
    const signature = computeSignature({
      family: family === 'correlation' ? 'correlation' : 'anomaly',
      condition: facets.condition,
      osFamily: os,
      discriminator: null,
      rootInferred: family === 'correlation',
    });
    return signature ? { signature, deviceId: alert.deviceId, alertId: alert.id, anomalyEpisodeId: anomaly.episodeId } : null;
  }

  const facets = alertConditionFacets({
    requiresHuman: alert.requiresHuman,
    context,
    ruleConditions: await ruleConditionsFor(alert.ruleId),
  });
  if (!facets) return null;
  const signature = computeSignature({
    family, condition: facets.condition, osFamily: os, discriminator: facets.discriminator, rootInferred: family === 'correlation',
  });
  return signature ? { signature, deviceId: alert.deviceId, alertId: alert.id, anomalyEpisodeId: null } : null;
}

export async function signatureForSource(ref: FixSourceRef): Promise<ResolvedFixSource | null> {
  if (ref.kind === 'alert') return alertSignature(ref.alertId, 'alert');
  if (ref.kind === 'correlation') {
    const [group] = await db
      .select({ rootAlertId: alertCorrelationGroups.rootAlertId })
      .from(alertCorrelationGroups).where(eq(alertCorrelationGroups.id, ref.correlationGroupId)).limit(1);
    return group?.rootAlertId ? alertSignature(group.rootAlertId, 'correlation') : null;
  }
  const anomaly = await anomalySource(ref);
  if (!anomaly) return null;
  const os = await deviceOs(anomaly.deviceId);
  if (!os) return null;
  const facets = anomalyConditionFacets(anomaly.episodeKey);
  const signature = computeSignature({ family: 'anomaly', condition: facets.condition, osFamily: os, discriminator: null, rootInferred: false });
  return signature ? { signature, deviceId: anomaly.deviceId, alertId: null, anomalyEpisodeId: anomaly.episodeId } : null;
}
