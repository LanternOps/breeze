/**
 * Seed ONE eval case into a DISPOSABLE stack and run real research on it:
 * requestResearch -> executeAgentRun inline (in-process enqueuer) -> read the
 * run row. Budget ceilings are lifted to 100 cents so the measured cost is
 * never truncated by the cap being measured; turn caps stay as shipped.
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
import { ensureResearchAgent } from '../../aiAgents/researchProvisioning';
import { registerAgentRunEnqueuer } from '../../aiAgents/runService';
import { executeAgentRun } from '../../aiAgents/runLoop';
import { requestResearch } from '../../fixMemory/research';
import type { CaseRun } from './score';
import type { ResearchEvalCase } from './cases';

const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

/** Budget ceilings lifted so the cap under measurement never truncates a run. */
const LIFTED_LIMITS = { researchQuickBudgetCentsPerRun: 100, researchDeepBudgetCentsPerRun: 100, maxBudgetCentsPerDay: 5000 };

export async function runResearchEvalCase(c: ResearchEvalCase, depth: 'quick' | 'deep'): Promise<CaseRun & { model: string | null }> {
  const tag = `eval-${c.id}-${randomUUID().slice(0, 6)}`;
  const { orgId, alertId, partnerId } = await sys(async () => {
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
      await db.insert(scripts).values({ orgId: o!.id, name: sc.name, description: sc.description, language: sc.language, osTypes: sc.osTypes, content: '# eval fixture' });
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
    return { orgId: o!.id, alertId: a!.id, partnerId: p!.id };
  });
  await sys(async () => {
    await ensureResearchAgent(partnerId);
    await db.update(aiAgents).set({
      limits: sql`coalesce(${aiAgents.limits}, '{}'::jsonb) || ${JSON.stringify(LIFTED_LIMITS)}::jsonb`,
    }).where(eq(aiAgents.partnerId, partnerId));
  });
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
