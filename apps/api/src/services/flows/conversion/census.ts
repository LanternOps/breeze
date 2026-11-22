/**
 * Tool Catalog W06 (#5221) Task A8 — the conversion census of one
 * installation: how many automations of each class, how the standalone Jobs
 * would convert (fidelity and finding counts), how many are compliance
 * remediation targets, how many are switched. AGGREGATES ONLY — never an id,
 * a name or any other row content — so the output of a production run can
 * leave the host. System context; read-only.
 *
 * Flows completion W02a (#12439) adds class C (config-policy automations),
 * the enabled unswitched S rows the flow editor cannot open in its form, and
 * the enabled unswitched webhook Jobs that run a script (plan P9, P10). Still
 * numbers only.
 *
 * Run by an operator through `apps/api/scripts/automationConversionCensus.ts`.
 */
import { inArray, isNull, sql } from 'drizzle-orm';
import {
  FLOW_CONVERSION_FIDELITIES,
  FLOW_CONVERSION_FINDING_CODES,
  recognizeFlowForm,
  type FlowConversionFidelity,
  type FlowConversionFindingCode,
  type FlowDocumentV1,
} from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../../db';
import { automations, configPolicyAutomations, flowAutomationConversions } from '../../../db/schema';
import { classifyAutomation, type AutomationClass } from './classify';
import { loadConversionContext } from './context';
import { convertAutomation } from './convertAutomation';

export interface ConversionCensus {
  /**
   * M, A, P and S partition the `automations` rows that are not retired. C is
   * the `config_policy_automations` rows that are not retired, read from that
   * table only, never joined to its feature links (plan P10).
   */
  byClass: Record<AutomationClass | 'C', { total: number; enabled: number }>;
  /** S rows that a compliance policy remediates through (never converted in W06). */
  remediationTargets: number;
  byFidelity: Record<FlowConversionFidelity, number>;
  byFinding: Record<FlowConversionFindingCode, number>;
  switched: number;
  enabledUnswitchedS: number;
  /**
   * Enabled unswitched S rows whose converted document the editor opens
   * read-only (Document tab), because it is not form-shaped. A row that
   * converts to no document is in `byFidelity.unconvertible` instead.
   */
  notFormShapedEnabledUnswitchedS: number;
  /** Enabled unswitched S rows with a webhook trigger and a `run_script` or `execute_command` action. */
  webhookScriptJobs: number;
  oldestSwitchAgeMs: number | null;
  /** S rows whose context could not be read (counted, never listed). */
  contextErrors: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Reads the row's jsonb with guards, so a malformed row is not counted rather than thrown. */
function isWebhookScriptJob(row: { trigger: unknown; actions: unknown }): boolean {
  if (!isRecord(row.trigger) || row.trigger.type !== 'webhook') return false;
  return Array.isArray(row.actions)
    && row.actions.some((a) => isRecord(a) && (a.type === 'run_script' || a.type === 'execute_command'));
}

/**
 * Only `.formShaped` is read: a form-shaped result also carries the decoded
 * values, which include the Job's name. A recognizer that throws is counted as
 * not form-shaped (the editor could not open it in the form either), and its
 * message, which could carry row content, is never surfaced.
 */
function isFormShaped(document: FlowDocumentV1): boolean {
  try {
    return recognizeFlowForm(document).formShaped;
  } catch {
    return false;
  }
}

export async function conversionCensus(now: Date = new Date()): Promise<ConversionCensus> {
  const { rows, live, policyRows } = await runOutsideDbContext(() => withSystemDbAccessContext(async () => ({
    rows: await db.select().from(automations).where(sql`true`),
    live: await db
      .select({ automationId: flowAutomationConversions.automationId, state: flowAutomationConversions.state, switchedAt: flowAutomationConversions.switchedAt })
      .from(flowAutomationConversions)
      .where(inArray(flowAutomationConversions.state, ['shadow', 'switched'])),
    policyRows: await db
      .select({ enabled: configPolicyAutomations.enabled })
      .from(configPolicyAutomations)
      .where(isNull(configPolicyAutomations.retiredAt)),
  }), 'flows.conversion.census'));

  const census: ConversionCensus = {
    byClass: {
      M: { total: 0, enabled: 0 }, A: { total: 0, enabled: 0 }, P: { total: 0, enabled: 0 }, S: { total: 0, enabled: 0 }, C: { total: 0, enabled: 0 },
    },
    remediationTargets: 0,
    byFidelity: Object.fromEntries(FLOW_CONVERSION_FIDELITIES.map((f) => [f, 0])) as ConversionCensus['byFidelity'],
    byFinding: Object.fromEntries(FLOW_CONVERSION_FINDING_CODES.map((c) => [c, 0])) as ConversionCensus['byFinding'],
    switched: 0,
    enabledUnswitchedS: 0,
    notFormShapedEnabledUnswitchedS: 0,
    webhookScriptJobs: 0,
    oldestSwitchAgeMs: null,
    contextErrors: 0,
  };

  const switchedIds = new Set<string>();
  let oldest: number | null = null;
  for (const c of live) {
    if (c.state !== 'switched') continue;
    census.switched += 1;
    switchedIds.add(c.automationId);
    if (c.switchedAt) oldest = oldest === null ? c.switchedAt.getTime() : Math.min(oldest, c.switchedAt.getTime());
  }
  census.oldestSwitchAgeMs = oldest === null ? null : now.getTime() - oldest;

  for (const p of policyRows) {
    census.byClass.C.total += 1;
    if (p.enabled) census.byClass.C.enabled += 1;
  }

  for (const row of rows) {
    const cls = classifyAutomation(row);
    if (cls === 'retired') continue;
    census.byClass[cls].total += 1;
    if (row.enabled) census.byClass[cls].enabled += 1;
    if (cls !== 'S') continue;
    const enabledUnswitched = row.enabled && !switchedIds.has(row.id);
    if (enabledUnswitched) {
      census.enabledUnswitchedS += 1;
      if (isWebhookScriptJob(row)) census.webhookScriptJobs += 1;
    }
    let ctx;
    try {
      ctx = await loadConversionContext(row, now);
    } catch {
      census.contextErrors += 1;
      continue;
    }
    if (ctx.isRemediationTarget) census.remediationTargets += 1;
    const result = convertAutomation(row, ctx);
    census.byFidelity[result.fidelity] += 1;
    for (const code of new Set(result.findings.map((f) => f.code))) census.byFinding[code] += 1;
    if (enabledUnswitched && result.document && !isFormShaped(result.document)) census.notFormShapedEnabledUnswitchedS += 1;
  }
  return census;
}
