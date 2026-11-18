/**
 * Tool Catalog W06 (#5221) Task A8 — the conversion census of one
 * installation: how many automations of each class, how the standalone Jobs
 * would convert (fidelity and finding counts), how many are compliance
 * remediation targets, how many are switched. AGGREGATES ONLY — never an id,
 * a name or any other row content — so the output of a production run can
 * leave the host. System context; read-only.
 *
 * Run by an operator through `apps/api/scripts/automationConversionCensus.ts`.
 */
import { inArray, sql } from 'drizzle-orm';
import {
  FLOW_CONVERSION_FIDELITIES,
  FLOW_CONVERSION_FINDING_CODES,
  type FlowConversionFidelity,
  type FlowConversionFindingCode,
} from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../../db';
import { automations, flowAutomationConversions } from '../../../db/schema';
import { classifyAutomation, type AutomationClass } from './classify';
import { loadConversionContext } from './context';
import { convertAutomation } from './convertAutomation';

export interface ConversionCensus {
  byClass: Record<AutomationClass, { total: number; enabled: number }>;
  /** S rows that a compliance policy remediates through (never converted in W06). */
  remediationTargets: number;
  byFidelity: Record<FlowConversionFidelity, number>;
  byFinding: Record<FlowConversionFindingCode, number>;
  switched: number;
  enabledUnswitchedS: number;
  oldestSwitchAgeMs: number | null;
  /** S rows whose context could not be read (counted, never listed). */
  contextErrors: number;
}

export async function conversionCensus(now: Date = new Date()): Promise<ConversionCensus> {
  const { rows, live } = await runOutsideDbContext(() => withSystemDbAccessContext(async () => ({
    rows: await db.select().from(automations).where(sql`true`),
    live: await db
      .select({ automationId: flowAutomationConversions.automationId, state: flowAutomationConversions.state, switchedAt: flowAutomationConversions.switchedAt })
      .from(flowAutomationConversions)
      .where(inArray(flowAutomationConversions.state, ['shadow', 'switched'])),
  }), 'flows.conversion.census'));

  const census: ConversionCensus = {
    byClass: { M: { total: 0, enabled: 0 }, A: { total: 0, enabled: 0 }, P: { total: 0, enabled: 0 }, S: { total: 0, enabled: 0 } },
    remediationTargets: 0,
    byFidelity: Object.fromEntries(FLOW_CONVERSION_FIDELITIES.map((f) => [f, 0])) as ConversionCensus['byFidelity'],
    byFinding: Object.fromEntries(FLOW_CONVERSION_FINDING_CODES.map((c) => [c, 0])) as ConversionCensus['byFinding'],
    switched: 0,
    enabledUnswitchedS: 0,
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

  for (const row of rows) {
    const cls = classifyAutomation(row);
    if (cls === 'retired') continue;
    census.byClass[cls].total += 1;
    if (row.enabled) census.byClass[cls].enabled += 1;
    if (cls !== 'S') continue;
    if (row.enabled && !switchedIds.has(row.id)) census.enabledUnswitchedS += 1;
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
  }
  return census;
}
