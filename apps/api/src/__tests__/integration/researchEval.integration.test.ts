import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { aiAgentLimitsSchema } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../../db';
import { aiAgentRuns, aiAgents, scripts } from '../../db/schema';
import { requestResearch } from '../../services/fixMemory/research';
import { registerAgentRunEnqueuer } from '../../services/aiAgents/runService';
import { LIFTED_LIMITS, seedResearchEvalCase } from '../../services/llm/researchEval/runCase';
import { RESEARCH_EVAL_CASES } from '../../services/llm/researchEval/cases';
import { usePlatformAiKeyPlaceholder } from './helpers/platformAiKey';

// Admission resolves the agent's model first; no model call is made (stub enqueuer, run never executed).
usePlatformAiKeyPlaceholder();

const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

describe('research eval seeding (real Postgres)', () => {
  beforeEach(() => {
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
    registerAgentRunEnqueuer(async () => ({ enqueued: true }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    registerAgentRunEnqueuer(null);
  });

  it.each(['w-disk-2', 'l-svc-1'])('seeds %s so requestResearch admits a run at both depths', async (id) => {
    const c = RESEARCH_EVAL_CASES.find((x) => x.id === id)!;
    const { orgId, alertId, partnerId } = await seedResearchEvalCase(c);

    const catalog = await sys(() => db.select({ name: scripts.name, osTypes: scripts.osTypes }).from(scripts).where(eq(scripts.orgId, orgId)));
    expect(catalog.map((s) => s.name).sort()).toEqual(c.catalog.map((s) => s.name).sort());
    expect(catalog.some((s) => !s.osTypes.includes(c.os))).toBe(true);

    const [agent] = await sys(() => db.select().from(aiAgents).where(eq(aiAgents.partnerId, partnerId)));
    expect(aiAgentLimitsSchema.safeParse(agent!.limits).success).toBe(true);
    expect(agent!.limits).toMatchObject(LIFTED_LIMITS);

    for (const depth of ['quick', 'deep'] as const) {
      const result = await requestResearch({ orgId, sourceType: 'alert', sourceId: alertId, depth, trigger: 'manual', actorUserId: null, runReads: sys });
      expect(result.status, JSON.stringify(result)).toBe('started');
      if (result.status !== 'started') return;
      const [run] = await sys(() => db.select().from(aiAgentRuns).where(eq(aiAgentRuns.id, result.runId)));
      expect(run).toMatchObject({ orgId, status: 'queued', triggerRef: expect.objectContaining({ depth, sourceId: alertId }) });
    }
  });
});
