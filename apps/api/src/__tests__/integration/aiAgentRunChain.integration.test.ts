/**
 * Wisp analysis sessions W06 — real-PostgreSQL proof of the run-detail chain
 * read (`GET /ai-agents/runs/:runId`): the SQL `trigger_ref->>'goal'`
 * projection, the root-or-member predicate, ordering and the site-name read,
 * as `breeze_app` under forced RLS. The unit suite (routes/aiAgents.test.ts)
 * pins the bound parameters against a mocked db; this one proves the query
 * Postgres actually runs returns the right rows.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { aiAgentRuns, aiAgents } from '../../db/schema';
import { aiAgentsRoutes } from '../../routes/aiAgents';
import { createIntegrationTestClient, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function makeApp() {
  const app = new Hono();
  app.route('/ai-agents', aiAgentsRoutes);
  return app;
}

type ChainStep = { id: string; step: number; continuedFromRunId: string | null; goal: string | null; costCents: number };
type RunDetail = {
  id: string;
  chainDepth: number;
  chainRootRunId: string | null;
  analysisGoal: string | null;
  analysisScope: { kind: string; siteId: string | null; siteName: string | null; deviceCount: number } | null;
  chain: ChainStep[] | null;
};

describe('run detail lists the analysis chain (real PostgreSQL as breeze_app)', () => {
  runDb('lists every step of the chain from the root and from a member, and nothing else', async () => {
    const app = makeApp();
    const reader = await createIntegrationTestClient(app, {
      scope: 'organization',
      rolePermissions: [{ resource: 'ai_agents', action: 'read' }],
    });
    const orgId = reader.env.organization.id;
    const site = await createSite({ orgId, name: 'Chain test site' });

    const [agent] = await getTestDb().insert(aiAgents).values({
      orgId, partnerId: null, kind: 'triage', name: 'Chain triage', createdBy: reader.env.user.id,
    }).returning();
    if (!agent) throw new Error('agent fixture insert failed');

    async function insertRun(o: {
      label: string;
      continuedFromRunId?: string | null;
      chainRootRunId?: string | null;
      chainDepth?: number;
      goal?: string;
      queuedAt: Date;
      costCents?: number;
      computeCents?: number | null;
      profile?: 'analysis' | 'full';
      scope?: { kind: 'devices' | 'site' | 'org'; siteId: string | null; deviceCount: number };
    }): Promise<string> {
      const [row] = await getTestDb().insert(aiAgentRuns).values({
        agentId: agent!.id,
        orgId,
        triggerKind: 'manual',
        dedupeKey: `chain-route-${o.label}-${randomUUID()}`,
        modeAtStart: 'shadow',
        policySnapshot: { schemaVersion: 1 } as never,
        status: 'completed',
        finishedAt: new Date(),
        profile: o.profile ?? 'analysis',
        continuedFromRunId: o.continuedFromRunId ?? null,
        chainRootRunId: o.chainRootRunId ?? null,
        chainDepth: o.chainDepth ?? 0,
        // A large seed beside the goal: the route projects only the goal.
        triggerRef: { source: 'chat_analysis', goal: o.goal ?? `goal ${o.label}`, seed: 'x'.repeat(4000) },
        stagedInputs: { handles: [], deviceIds: ['d1'], region: 'us', ...(o.scope ? { scope: o.scope } : {}) },
        costCents: o.costCents ?? 10,
        computeCents: o.computeCents ?? null,
        outcome: {},
        queuedAt: o.queuedAt,
      } as never).returning({ id: aiAgentRuns.id });
      return row!.id;
    }

    const t = (m: number) => new Date(Date.UTC(2026, 10, 13, 10, m));
    const root = await insertRun({
      label: 'root', queuedAt: t(0), costCents: 30, computeCents: 5, goal: `  ${'g'.repeat(400)}  `,
      scope: { kind: 'site', siteId: site.id, deviceCount: 7 },
    });
    const stepB = await insertRun({ label: 'b', continuedFromRunId: root, chainRootRunId: root, chainDepth: 1, queuedAt: t(6) });
    const stepA = await insertRun({ label: 'a', continuedFromRunId: root, chainRootRunId: root, chainDepth: 1, queuedAt: t(5) });
    const leaf = await insertRun({ label: 'leaf', continuedFromRunId: stepA, chainRootRunId: root, chainDepth: 2, queuedAt: t(7), goal: 'leaf goal' });
    // Not part of the chain: an unrelated analysis run, and a non-analysis run.
    const stranger = await insertRun({ label: 'stranger', queuedAt: t(1) });
    await insertRun({ label: 'full', profile: 'full', queuedAt: t(2) });

    const fromLeaf = await reader.get(`/ai-agents/runs/${leaf}`);
    expect(fromLeaf.status).toBe(200);
    const leafDto = (await fromLeaf.json() as { data: RunDetail }).data;
    expect(leafDto).toMatchObject({ chainDepth: 2, chainRootRunId: root, analysisGoal: 'leaf goal' });
    expect(leafDto.chain!.map((s) => [s.id, s.step])).toEqual([[root, 1], [stepA, 2], [stepB, 2], [leaf, 3]]);
    expect(leafDto.chain![0]!.costCents).toBe(35);
    expect(leafDto.chain![0]!.goal).toHaveLength(300);
    expect(leafDto.chain![3]!.continuedFromRunId).toBe(stepA);

    // The root has no lineage of its own and still lists its chain.
    const rootDto = (await (await reader.get(`/ai-agents/runs/${root}`)).json() as { data: RunDetail }).data;
    expect(rootDto.chainRootRunId).toBeNull();
    expect(rootDto.chain!.map((s) => s.id)).toEqual([root, stepA, stepB, leaf]);
    expect(rootDto.analysisScope).toEqual({ kind: 'site', siteId: site.id, siteName: 'Chain test site', deviceCount: 7 });

    const strangerDto = (await (await reader.get(`/ai-agents/runs/${stranger}`)).json() as { data: RunDetail }).data;
    expect(strangerDto.chain).toBeNull();
    expect(strangerDto.analysisScope).toEqual({ kind: 'devices', siteId: null, siteName: null, deviceCount: 1 });
  });
});
