/**
 * Seed ONE eval case into a DISPOSABLE stack and run real research on it:
 * requestResearch -> executeAgentRun inline (in-process enqueuer) -> read the
 * run row. Budget ceilings are lifted (quick 50c, the validator max; deep 100c) so the measured cost is
 * never truncated by the cap being measured; turn caps stay as shipped.
 *
 * Fixture tenants are never cleaned up: run only against a disposable stack.
 *
 * The model is whatever the production path resolves for the fixture org
 * (resolveLlmConfigForOrg -> the platform LLM from ANTHROPIC_API_KEY); the row's
 * `resolved_model` is returned so the report records it.
 */
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../../db';
import { aiAgentRuns, aiAgents } from '../../../db/schema/aiAgents';
import { alertRules, alertTemplates, alerts, devices, organizations, partners, scripts, sites } from '../../../db/schema';
import { cutScriptVersion } from '../../scriptVersions';
import { ensureResearchAgent } from '../../aiAgents/researchProvisioning';
import { registerAgentRunEnqueuer } from '../../aiAgents/runService';
import { executeAgentRun } from '../../aiAgents/runLoop';
import { requestResearch } from '../../fixMemory/research';
import type { CaseRun } from './score';
import type { ResearchEvalCase } from './cases';

const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

/**
 * Budget ceilings lifted so the cap under measurement never truncates a run.
 * Quick is capped at 50 (the limits validator's max); deep at 100.
 */
export const LIFTED_LIMITS = { researchQuickBudgetCentsPerRun: 50, researchDeepBudgetCentsPerRun: 100, maxBudgetCentsPerDay: 5000 };

/** Seed one case's tenant, device, catalog and alert, and lift the research agent's budgets. Fixture rows are never cleaned up (disposable stack). */
export async function seedResearchEvalCase(c: ResearchEvalCase): Promise<{ orgId: string; alertId: string; partnerId: string; deviceId: string }> {
  const tag = `eval-${c.id}-${randomUUID().slice(0, 6)}`;
  const seeded = await sys(async () => {
    const [p] = await db.insert(partners).values({ name: tag, slug: tag, type: 'msp', status: 'active' }).returning({ id: partners.id });
    const [o] = await db.insert(organizations).values({
      partnerId: p!.id, name: tag, slug: tag, status: 'active', currencyCode: 'USD',
      settings: { mlFeatureFlags: { 'ml.remediation_suggestions.enabled': true } },
    }).returning({ id: organizations.id });
    const [s] = await db.insert(sites).values({ orgId: o!.id, name: 'Main' }).returning({ id: sites.id });
    const [d] = await db.insert(devices).values({
      orgId: o!.id, siteId: s!.id, agentId: randomUUID().replace(/-/g, ''), hostname: 'EVAL-01', osType: c.os,
      osVersion: 'eval', architecture: 'x86_64', agentVersion: '0.0.0-eval',
    }).returning({ id: devices.id });
    for (const sc of c.catalog) {
      // The row and its v1 version are one unit of work (#5622): version 0 is
      // transient, cutScriptVersion moves it to 1 and snapshots it.
      await db.transaction(async (tx) => {
        const [row] = await tx.insert(scripts).values({
          orgId: o!.id, name: sc.name, description: sc.description, language: sc.language, osTypes: sc.osTypes,
          content: '# eval fixture', version: 0, origin: 'human',
        }).returning({ id: scripts.id });
        await cutScriptVersion(tx, { scriptId: row!.id, provenance: { origin: 'human', changelog: 'Eval fixture', createdBy: null } });
      });
    }
    let ruleId: string | null = null;
    if (c.alert.ruleConditions !== undefined) {
      const [t] = await db.insert(alertTemplates).values({
        orgId: o!.id, name: `${tag}-template`, conditions: c.alert.ruleConditions as never, severity: c.alert.severity,
        titleTemplate: c.alert.title, messageTemplate: c.alert.message,
      }).returning({ id: alertTemplates.id });
      const [r] = await db.insert(alertRules).values({
        orgId: o!.id, templateId: t!.id, name: `${tag}-rule`, targetType: 'all', targetId: o!.id,
        overrideSettings: { conditions: c.alert.ruleConditions } as never,
      }).returning({ id: alertRules.id });
      ruleId = r!.id;
    }
    const [a] = await db.insert(alerts).values({
      orgId: o!.id, deviceId: d!.id, ruleId, severity: c.alert.severity, title: c.alert.title, message: c.alert.message,
      context: c.alert.context ?? {},
    }).returning({ id: alerts.id });
    return { orgId: o!.id, alertId: a!.id, partnerId: p!.id, deviceId: d!.id };
  });
  await sys(async () => {
    await ensureResearchAgent(seeded.partnerId);
    await db.update(aiAgents).set({
      limits: sql`coalesce(${aiAgents.limits}, '{}'::jsonb) || ${JSON.stringify(LIFTED_LIMITS)}::jsonb`,
    }).where(eq(aiAgents.partnerId, seeded.partnerId));
  });
  return seeded;
}

export async function runResearchEvalCase(c: ResearchEvalCase, depth: 'quick' | 'deep'): Promise<CaseRun & { model: string | null }> {
  const { orgId, alertId } = await seedResearchEvalCase(c);
  // In-process enqueuer: admission never touches BullMQ; the run is executed inline below.
  registerAgentRunEnqueuer(async () => ({ enqueued: true }));
  const requested = await sys(() => requestResearch({ orgId, sourceType: 'alert', sourceId: alertId, depth, trigger: 'manual', actorUserId: null }));
  if (requested.status === 'denied') {
    return { caseId: c.id, depth, status: 'denied', errorCode: requested.code, costCents: 0, turns: 0, outcome: null, denial: requested.message, model: null };
  }
  await executeAgentRun(requested.runId);
  const [row] = await sys(() => db.select().from(aiAgentRuns).where(eq(aiAgentRuns.id, requested.runId)).limit(1));
  const research = (row?.outcome as { research?: CaseRun['outcome'] } | undefined)?.research ?? null;
  return {
    caseId: c.id, depth, status: row?.status ?? 'missing', errorCode: row?.errorCode ?? null,
    costCents: row?.costCents ?? 0, turns: row?.turnCount ?? 0, outcome: research, model: row?.resolvedModel ?? null,
  };
}
