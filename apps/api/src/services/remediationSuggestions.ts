import { and, eq } from 'drizzle-orm';

import { db } from '../db';
import {
  alertCorrelationGroups,
  alerts,
  metricAnomalies,
  remediationSuggestions,
} from '../db/schema';
import { attachProvenFixes } from './fixMemory/attach';
import {
  listCatalogPlaybooks, listCatalogScripts, listCatalogTemplates, NON_REMEDIATION_SYSTEM_SCRIPT_NAMES,
  resolveDeviceOs, resolveOrgPartnerId, TEMPLATE_LANGUAGES_BY_OS,
} from './fixMemory/catalog';
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
}

export interface RemediationSuggestionGenerateResult {
  sourceType: RemediationSourceType;
  sourceId: string;
  orgId: string;
  skipped: boolean;
  /**
   * True when no real script/template/playbook matched and the only persisted
   * suggestion is the canned "collect diagnostics" fallback nudge. Lets callers
   * and eval distinguish "found a real fix" from "found nothing".
   */
  usedFallback: boolean;
  suggestions: Array<typeof remediationSuggestions.$inferSelect>;
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
  text: string;
  metricName?: string | null;
  anomalyType?: string | null;
  severity?: string | null;
}

interface Candidate {
  targetType: 'script' | 'script_template' | 'playbook' | 'diagnostic';
  scriptId?: string | null;
  scriptTemplateId?: string | null;
  playbookId?: string | null;
  name: string;
  description?: string | null;
  category?: string | null;
  riskTier: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  expectedAction: string;
  matchedTerms: string[];
  /** Set only on the canned diagnostic nudge pushed when nothing else matched. */
  fallback?: boolean;
}

function sourceTextParts(...parts: Array<string | null | undefined>): string {
  return parts.filter(Boolean).join(' ').toLowerCase();
}

function termsForSource(ctx: SourceContext): string[] {
  const text = ctx.text;
  const terms = new Set<string>();
  const add = (...items: string[]) => items.forEach((item) => terms.add(item));

  if (ctx.anomalyType === 'network_egress' || text.includes('network') || text.includes('egress') || text.includes('bandwidth')) {
    add('network', 'egress', 'dns', 'security', 'connection');
  }
  if (ctx.anomalyType === 'process_runaway' || text.includes('process')) {
    add('process', 'cpu', 'service', 'restart', 'diagnostic');
  }
  if (ctx.anomalyType === 'memory_growth' || text.includes('memory') || text.includes('ram')) {
    add('memory', 'ram', 'process', 'leak', 'restart');
  }
  if (ctx.anomalyType === 'disk_growth' || text.includes('disk') || text.includes('storage')) {
    add('disk', 'cleanup', 'storage', 'temp');
  }
  if (text.includes('patch') || text.includes('update')) {
    add('patch', 'update', 'reboot');
  }
  if (ctx.severity === 'critical' || ctx.severity === 'high') {
    add('diagnostic', 'incident');
  }

  if (terms.size === 0) {
    add('diagnostic', 'health', 'status');
  }

  return [...terms];
}

function matchesTerm(searchable: string, term: string): boolean {
  // Word-start match: "ram" must not hit "programdata", "update" still hits "updates".
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}`).test(searchable);
}

function scoreCandidate(searchable: string, terms: string[]): { score: number; matchedTerms: string[] } {
  const matchedTerms = terms.filter((term) => matchesTerm(searchable, term));
  if (matchedTerms.length === 0) return { score: 0, matchedTerms };
  const score = matchedTerms.length / Math.max(terms.length, 1);
  return { score, matchedTerms };
}

function riskTierForCandidate(ctx: SourceContext, candidateText: string): Candidate['riskTier'] {
  if (candidateText.includes('delete') || candidateText.includes('cleanup') || candidateText.includes('remove')) {
    return ctx.severity === 'critical' ? 'high' : 'medium';
  }
  if (candidateText.includes('restart') || candidateText.includes('reboot')) {
    return 'medium';
  }
  if (ctx.severity === 'critical') return 'high';
  return 'low';
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
    text: sourceTextParts(row.groupKey, row.status, JSON.stringify(row.metadata ?? {}), input.sourceId),
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
      text: sourceTextParts(row.anomalyType, row.metricType, row.metricName, JSON.stringify(row.evidence ?? {})),
      metricName: row.metricName,
      anomalyType: row.anomalyType,
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
      text: sourceTextParts(row.title, row.message, row.severity, JSON.stringify(row.context ?? {})),
      severity: row.severity,
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
      text: sourceTextParts(row.groupKey, row.status, JSON.stringify(row.metadata ?? {})),
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
    text: sourceTextParts(input.sourceId),
  };
}

async function listCandidates(ctx: SourceContext, limit: number): Promise<Candidate[]> {
  const terms = termsForSource(ctx);
  // Without a single target device (e.g. a correlation group) there is no OS to
  // filter on; every per-device execution path re-checks OS at dispatch.
  const deviceOs = await resolveDeviceOs(ctx.deviceId);
  const catalogCtx = { orgId: ctx.orgId, partnerId: await resolveOrgPartnerId(ctx.orgId), deviceOs };
  const [scriptRows, templateRows, playbookRows] = await Promise.all([
    listCatalogScripts(catalogCtx),
    listCatalogTemplates(catalogCtx),
    listCatalogPlaybooks(catalogCtx),
  ]);

  const candidates: Candidate[] = [];
  for (const row of scriptRows) {
    // Mirrors the SQL filters above so a widened query can never leak these through.
    if (row.isSystem && NON_REMEDIATION_SYSTEM_SCRIPT_NAMES.includes(row.name)) continue;
    if (deviceOs && !row.osTypes.includes(deviceOs)) continue;
    const searchable = sourceTextParts(row.name, row.description, row.category, row.runAs);
    const scored = scoreCandidate(searchable, terms);
    if (scored.score <= 0) continue;
    candidates.push({
      targetType: 'script',
      scriptId: row.id,
      name: row.name,
      description: row.description,
      category: row.category,
      riskTier: riskTierForCandidate(ctx, searchable),
      confidence: Math.min(0.95, 0.45 + scored.score / 2),
      expectedAction: `Run script "${row.name}" through the existing script execution flow.`,
      matchedTerms: scored.matchedTerms,
    });
  }

  for (const row of playbookRows) {
    const searchable = sourceTextParts(row.name, row.description, row.category);
    const scored = scoreCandidate(searchable, terms);
    if (scored.score <= 0) continue;
    candidates.push({
      targetType: 'playbook',
      playbookId: row.id,
      name: row.name,
      description: row.description,
      category: row.category,
      riskTier: riskTierForCandidate(ctx, searchable),
      confidence: Math.min(0.94, 0.42 + scored.score / 2),
      expectedAction: `Start playbook "${row.name}" through the existing playbook execution flow.`,
      matchedTerms: scored.matchedTerms,
    });
  }

  for (const row of templateRows) {
    if (deviceOs && row.language && !TEMPLATE_LANGUAGES_BY_OS[deviceOs].has(row.language)) continue;
    const searchable = sourceTextParts(row.name, row.description, row.category);
    const scored = scoreCandidate(searchable, terms);
    if (scored.score <= 0) continue;
    candidates.push({
      targetType: 'script_template',
      scriptTemplateId: row.id,
      name: row.name,
      description: row.description,
      category: row.category,
      riskTier: riskTierForCandidate(ctx, searchable),
      confidence: Math.min(0.9, 0.38 + scored.score / 2),
      expectedAction: `Review script template "${row.name}" and create an org script before execution.`,
      matchedTerms: scored.matchedTerms,
    });
  }

  if (candidates.length === 0) {
    candidates.push({
      targetType: 'diagnostic',
      name: 'Collect diagnostics before remediation',
      description: 'Run existing diagnostic tools and review evidence before taking action.',
      category: 'diagnostic',
      riskTier: 'low',
      confidence: 0.35,
      expectedAction: 'Use existing diagnostic commands or playbooks to gather more evidence before changing the device.',
      matchedTerms: terms.slice(0, 3),
      fallback: true,
    });
  }

  return candidates
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, limit);
}

function sameTarget(row: typeof remediationSuggestions.$inferSelect, candidate: Candidate): boolean {
  return row.targetType === candidate.targetType
    && (row.scriptId ?? null) === (candidate.scriptId ?? null)
    && (row.scriptTemplateId ?? null) === (candidate.scriptTemplateId ?? null)
    && (row.playbookId ?? null) === (candidate.playbookId ?? null);
}

export async function generateRemediationSuggestions(
  input: GenerateRemediationSuggestionsInput
): Promise<RemediationSuggestionGenerateResult> {
  const ctx = await resolveSourceContext(input);
  if (!ctx) {
    throw new Error('Remediation suggestion source not found');
  }

  if (!(await shouldProduceMlOutput(ctx.orgId, 'ml.remediation_suggestions.enabled'))) {
    return {
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      orgId: ctx.orgId,
      skipped: true,
      usedFallback: false,
      suggestions: [],
    };
  }

  // AI Suggested Fixes W1 — proven memory first; free, and the catalog loop
  // below then reuses (never duplicates) a script memory already attached.
  const memoryAttached = await attachProvenFixes({ sourceType: input.sourceType, sourceId: input.sourceId, orgId: ctx.orgId });

  const existing = await db
    .select()
    .from(remediationSuggestions)
    .where(and(
      eq(remediationSuggestions.orgId, ctx.orgId),
      eq(remediationSuggestions.sourceType, input.sourceType),
      eq(remediationSuggestions.sourceId, input.sourceId),
    ));

  const candidates = await listCandidates(ctx, Math.min(Math.max(input.limit ?? 3, 1), 10));
  const usedFallback = candidates.some((candidate) => candidate.fallback === true);
  const created: Array<typeof remediationSuggestions.$inferSelect> = [];
  for (const candidate of candidates) {
    const prior = existing.find((row) => sameTarget(row, candidate));
    if (prior) {
      created.push(prior);
      continue;
    }

    const [inserted] = await db
      .insert(remediationSuggestions)
      .values({
        orgId: ctx.orgId,
        sourceType: ctx.sourceType,
        sourceId: ctx.sourceId,
        deviceId: ctx.deviceId,
        alertId: ctx.alertId,
        anomalyId: ctx.anomalyId,
        correlationGroupId: ctx.correlationGroupId,
        rcaId: ctx.rcaId,
        targetType: candidate.targetType,
        scriptId: candidate.scriptId ?? null,
        scriptTemplateId: candidate.scriptTemplateId ?? null,
        playbookId: candidate.playbookId ?? null,
        title: candidate.name,
        rationale: candidate.description ?? `Matched ${candidate.matchedTerms.join(', ')} from ${ctx.title}.`,
        expectedAction: candidate.expectedAction,
        riskTier: candidate.riskTier,
        confidence: candidate.confidence,
        targetDeviceIds: ctx.deviceId ? [ctx.deviceId] : [],
        createdBy: input.actorUserId ?? null,
        evidence: {
          modelVersion: REMEDIATION_SUGGESTION_VERSION,
          sourceTitle: ctx.title,
          matchedTerms: candidate.matchedTerms,
          category: candidate.category,
          metricName: ctx.metricName,
          anomalyType: ctx.anomalyType,
          // Tag the canned "collect diagnostics" nudge so eval/consumers can tell
          // it apart from a real script/template/playbook match.
          ...(candidate.fallback ? { fallback: true, reason: 'no_term_match' } : {}),
        },
      })
      .returning();
    if (inserted) created.push(inserted);
  }

  // AI Suggested Fixes W1 — a memory row the catalog loop above never touched
  // (no keyword-matched candidate for that script) still belongs in the
  // result; `existing` was queried after attachProvenFixes, so it already
  // reflects anything just attached.
  const createdIds = new Set(created.map((row) => row.id));
  const memoryRows = memoryAttached > 0
    ? existing.filter((row) => row.origin === 'memory' && !createdIds.has(row.id))
    : [];

  return {
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    orgId: ctx.orgId,
    skipped: false,
    usedFallback,
    suggestions: [...memoryRows, ...created],
  };
}

export const __testOnly = {
  termsForSource,
  scoreCandidate,
  riskTierForCandidate,
  rcaContextFromCorrelationGroup,
};
