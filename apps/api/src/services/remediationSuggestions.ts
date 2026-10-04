import { and, eq } from 'drizzle-orm';

import { db } from '../db';
import {
  alertCorrelationGroups,
  alerts,
  metricAnomalies,
  remediationSuggestions,
} from '../db/schema';
import { attachProvenFixes } from './fixMemory/attach';
import { requestResearch, type ResearchRequestResult } from './fixMemory/research';
import { captureException } from './sentry';
import { shouldProduceMlOutput } from './mlFeatureFlags';

export const REMEDIATION_SUGGESTION_VERSION = 'remediation-suggestions-v1';

export type RemediationSourceType = 'alert' | 'anomaly' | 'correlation' | 'rca';

export interface GenerateRemediationSuggestionsInput {
  sourceType: RemediationSourceType;
  sourceId: string;
  orgId?: string;
  deviceId?: string;
  actorUserId?: string | null;
  limit?: number;
  /** Caller holds ai_sessions:use, so Generate may also start (paid) quick research. */
  allowResearch?: boolean;
}

export interface RemediationSuggestionGenerateResult {
  sourceType: RemediationSourceType;
  sourceId: string;
  orgId: string;
  skipped: boolean;
  suggestions: Array<typeof remediationSuggestions.$inferSelect>;
  /** Quick research outcome; null for rca sources and when the feature is skipped. */
  research: ResearchRequestResult | null;
}

interface SourceContext {
  sourceType: RemediationSourceType;
  sourceId: string;
  orgId: string;
  deviceId: string | null;
  alertId: string | null;
  anomalyId: string | null;
  correlationGroupId: string | null;
  rcaId: string | null;
  title: string;
}

function rcaContextFromCorrelationGroup(
  row: Pick<typeof alertCorrelationGroups.$inferSelect, 'id' | 'orgId' | 'rootAlertId' | 'groupKey' | 'status' | 'metadata'>,
  input: GenerateRemediationSuggestionsInput,
): SourceContext {
  return {
    sourceType: 'rca',
    sourceId: input.sourceId,
    orgId: row.orgId,
    deviceId: input.deviceId ?? null,
    alertId: row.rootAlertId,
    anomalyId: null,
    correlationGroupId: row.id,
    rcaId: input.sourceId,
    title: `RCA for correlation group ${row.groupKey}`,
  };
}

async function resolveSourceContext(input: GenerateRemediationSuggestionsInput): Promise<SourceContext | null> {
  if (input.sourceType === 'anomaly') {
    const [row] = await db.select().from(metricAnomalies).where(eq(metricAnomalies.id, input.sourceId)).limit(1);
    if (!row) return null;
    return {
      sourceType: 'anomaly',
      sourceId: input.sourceId,
      orgId: row.orgId,
      deviceId: row.deviceId,
      alertId: row.linkedAlertId,
      anomalyId: row.id,
      correlationGroupId: row.linkedCorrelationGroupId,
      rcaId: null,
      title: `${row.anomalyType} on ${row.metricName}`,
    };
  }

  if (input.sourceType === 'alert') {
    const [row] = await db.select().from(alerts).where(eq(alerts.id, input.sourceId)).limit(1);
    if (!row) return null;
    return {
      sourceType: 'alert',
      sourceId: input.sourceId,
      orgId: row.orgId,
      deviceId: row.deviceId,
      alertId: row.id,
      anomalyId: null,
      correlationGroupId: null,
      rcaId: null,
      title: row.title,
    };
  }

  if (input.sourceType === 'correlation') {
    const [row] = await db.select().from(alertCorrelationGroups).where(eq(alertCorrelationGroups.id, input.sourceId)).limit(1);
    if (!row) return null;
    return {
      sourceType: 'correlation',
      sourceId: input.sourceId,
      orgId: row.orgId,
      deviceId: null,
      alertId: row.rootAlertId,
      anomalyId: null,
      correlationGroupId: row.id,
      rcaId: null,
      title: `Correlation group ${row.groupKey}`,
    };
  }

  if (input.sourceType === 'rca') {
    const [row] = await db.select().from(alertCorrelationGroups).where(eq(alertCorrelationGroups.id, input.sourceId)).limit(1);
    if (row) return rcaContextFromCorrelationGroup(row, input);
  }

  if (!input.orgId) return null;
  return {
    sourceType: 'rca',
    sourceId: input.sourceId,
    orgId: input.orgId,
    deviceId: input.deviceId ?? null,
    alertId: null,
    anomalyId: null,
    correlationGroupId: null,
    rcaId: input.sourceId,
    title: `RCA ${input.sourceId}`,
  };
}

export interface GenerateRemediationSuggestionsOptions {
  /**
   * Runs `fn` in a short DB context that COMMITS when it returns; the route
   * passes `(fn) => withAuthDbAccessContext(auth, fn)`. Generate is a
   * self-managed DB-context route because requestResearch provisions and
   * admits in their own system transactions and must run with no context held
   * (#2417 / #6671). Three phases, never nested: (1) resolve the source, check
   * the flag and attach proven memory; (2) quick research with nothing held, so
   * a research failure cannot poison a transaction the memory result still
   * needs; (3) read the source's rows.
   */
  runInDbContext: <T>(fn: () => Promise<T>) => Promise<T>;
}

export async function generateRemediationSuggestions(
  input: GenerateRemediationSuggestionsInput,
  options: GenerateRemediationSuggestionsOptions,
): Promise<RemediationSuggestionGenerateResult> {
  const { runInDbContext } = options;
  const phase1 = await runInDbContext(async () => {
    const resolved = await resolveSourceContext(input);
    if (!resolved) {
      throw new Error('Remediation suggestion source not found');
    }
    if (!(await shouldProduceMlOutput(resolved.orgId, 'ml.remediation_suggestions.enabled'))) {
      return { ctx: resolved, skipped: true as const };
    }
    // AI Suggested Fixes W2: proven memory first (free), then quick research.
    // The keyword matcher is gone (#7118 root cause).
    await attachProvenFixes({ sourceType: input.sourceType, sourceId: input.sourceId, orgId: resolved.orgId });
    return { ctx: resolved, skipped: false as const };
  });
  const { ctx } = phase1;
  if (phase1.skipped) {
    return {
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      orgId: ctx.orgId,
      skipped: true,
      suggestions: [],
      research: null,
    };
  }

  let research: ResearchRequestResult | null;
  if (input.sourceType === 'rca') {
    research = null;
  } else if (input.allowResearch) {
    // Memory is attached and committed above; a research failure must never take it down.
    try {
      research = await requestResearch({
        orgId: ctx.orgId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        depth: 'quick',
        trigger: 'manual',
        actorUserId: input.actorUserId ?? null,
        runReads: runInDbContext,
      });
    } catch (error) {
      console.error('[remediationSuggestions] quick research failed to start', { orgId: ctx.orgId, sourceId: input.sourceId, error });
      captureException(error instanceof Error ? error : new Error(String(error)), undefined, {
        component: 'remediationSuggestions.generateResearch', orgId: ctx.orgId, sourceType: input.sourceType, sourceId: input.sourceId,
      });
      research = { status: 'denied', code: 'research_unavailable', message: 'Research could not be started right now. Proven fixes are still shown.' };
    }
  } else {
    research = { status: 'denied', code: 'permission', message: 'You need permission to use AI to research fixes.' };
  }

  const suggestions = await runInDbContext(() => db
    .select()
    .from(remediationSuggestions)
    .where(and(
      eq(remediationSuggestions.orgId, ctx.orgId),
      eq(remediationSuggestions.sourceType, input.sourceType),
      eq(remediationSuggestions.sourceId, input.sourceId),
    )));

  return { sourceType: input.sourceType, sourceId: input.sourceId, orgId: ctx.orgId, skipped: false, suggestions, research };
}

export const __testOnly = {
  rcaContextFromCorrelationGroup,
};
