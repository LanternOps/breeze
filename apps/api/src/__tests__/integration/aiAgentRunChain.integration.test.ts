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
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { aiAgentRuns, aiAgents, devices, organizationUsers } from '../../db/schema';
import { aiAgentsRoutes } from '../../routes/aiAgents';
import { clearPermissionCache } from '../../services/permissions';
import { createIntegrationTestClient, createSite, type IntegrationTestClient } from './db-utils';
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

// #12137: the chain read spans runs, so the tenant and site boundaries need
// their own proof against real RLS, not only the mocked-db unit suite.

async function seedAgent(reader: IntegrationTestClient): Promise<string> {
  const [agent] = await getTestDb().insert(aiAgents).values({
    orgId: reader.env.organization.id, partnerId: null, kind: 'triage', name: 'Chain triage',
    createdBy: reader.env.user.id,
  }).returning();
  if (!agent) throw new Error('agent fixture insert failed');
  return agent.id;
}

async function seedDevice(orgId: string, siteId: string, label: string): Promise<string> {
  const [device] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId: `chain-${label}-${randomUUID().slice(0, 8)}`,
    hostname: `chain-${label}`,
    osType: 'linux',
    osVersion: '1',
    architecture: 'amd64',
    agentVersion: '1',
    status: 'online',
  }).returning();
  if (!device) throw new Error('device fixture insert failed');
  return device.id;
}

async function seedChainRun(o: {
  agentId: string;
  orgId: string;
  label: string;
  queuedAt: Date;
  deviceId?: string | null;
  continuedFromRunId?: string | null;
  chainRootRunId?: string | null;
  chainDepth?: number;
}): Promise<string> {
  const [row] = await getTestDb().insert(aiAgentRuns).values({
    agentId: o.agentId,
    orgId: o.orgId,
    deviceId: o.deviceId ?? null,
    triggerKind: 'manual',
    dedupeKey: `chain-boundary-${o.label}-${randomUUID()}`,
    modeAtStart: 'shadow',
    policySnapshot: { schemaVersion: 1 } as never,
    status: 'completed',
    finishedAt: new Date(),
    profile: 'analysis',
    continuedFromRunId: o.continuedFromRunId ?? null,
    chainRootRunId: o.chainRootRunId ?? null,
    chainDepth: o.chainDepth ?? 0,
    triggerRef: { source: 'chat_analysis', goal: `goal ${o.label}` },
    stagedInputs: { handles: [], deviceIds: [], region: 'us' },
    costCents: 10,
    outcome: {},
    queuedAt: o.queuedAt,
  } as never).returning({ id: aiAgentRuns.id });
  return row!.id;
}

const at = (m: number) => new Date(Date.UTC(2026, 10, 14, 10, m));

async function readChain(reader: IntegrationTestClient, runId: string): Promise<string[] | null> {
  const res = await reader.get(`/ai-agents/runs/${runId}`);
  expect(res.status, runId).toBe(200);
  return ((await res.json()) as { data: RunDetail }).data.chain?.map((s) => s.id) ?? null;
}

describe('run detail chain honours the tenant and site boundaries (real PostgreSQL as breeze_app)', () => {
  runDb('another org cannot open any step of a chain, and each org lists only its own chain', async () => {
    const app = makeApp();
    const perms = [{ resource: 'ai_agents', action: 'read' }];
    const readerA = await createIntegrationTestClient(app, { scope: 'organization', rolePermissions: perms });
    const readerB = await createIntegrationTestClient(app, { scope: 'organization', rolePermissions: perms });
    const orgA = readerA.env.organization.id;
    const orgB = readerB.env.organization.id;
    expect(orgA).not.toBe(orgB);

    const agentA = await seedAgent(readerA);
    const rootA = await seedChainRun({ agentId: agentA, orgId: orgA, label: 'a-root', queuedAt: at(0) });
    const leafA = await seedChainRun({
      agentId: agentA, orgId: orgA, label: 'a-leaf', queuedAt: at(1),
      continuedFromRunId: rootA, chainRootRunId: rootA, chainDepth: 1,
    });
    const agentB = await seedAgent(readerB);
    const rootB = await seedChainRun({ agentId: agentB, orgId: orgB, label: 'b-root', queuedAt: at(2) });
    const leafB = await seedChainRun({
      agentId: agentB, orgId: orgB, label: 'b-leaf', queuedAt: at(3),
      continuedFromRunId: rootB, chainRootRunId: rootB, chainDepth: 1,
    });

    // Positive control: each org reads its own chain whole, and only it.
    expect(await readChain(readerA, leafA)).toEqual([rootA, leafA]);
    expect(await readChain(readerA, rootA)).toEqual([rootA, leafA]);
    expect(await readChain(readerB, leafB)).toEqual([rootB, leafB]);

    // Across the org boundary every step is opaque, root and member alike.
    for (const runId of [rootA, leafA]) {
      expect((await readerB.get(`/ai-agents/runs/${runId}`)).status, runId).toBe(404);
    }
    for (const runId of [rootB, leafB]) {
      expect((await readerA.get(`/ai-agents/runs/${runId}`)).status, runId).toBe(404);
    }
  });

  runDb('a site-restricted caller sees only the chain steps whose device is in its sites', async () => {
    const app = makeApp();
    const reader = await createIntegrationTestClient(app, {
      scope: 'organization',
      rolePermissions: [{ resource: 'ai_agents', action: 'read' }],
    });
    const orgId = reader.env.organization.id;
    const hiddenSite = await createSite({ orgId, name: 'Hidden chain site' });
    const visibleDevice = await seedDevice(orgId, reader.env.site.id, 'visible');
    const hiddenDevice = await seedDevice(orgId, hiddenSite.id, 'hidden');
    const agentId = await seedAgent(reader);

    const root = await seedChainRun({ agentId, orgId, label: 'root', queuedAt: at(0), deviceId: visibleDevice });
    const hiddenStep = await seedChainRun({
      agentId, orgId, label: 'hidden', queuedAt: at(1), deviceId: hiddenDevice,
      continuedFromRunId: root, chainRootRunId: root, chainDepth: 1,
    });
    const deviceLessStep = await seedChainRun({
      agentId, orgId, label: 'device-less', queuedAt: at(2), deviceId: null,
      continuedFromRunId: root, chainRootRunId: root, chainDepth: 1,
    });
    const visibleStep = await seedChainRun({
      agentId, orgId, label: 'visible', queuedAt: at(3), deviceId: visibleDevice,
      continuedFromRunId: root, chainRootRunId: root, chainDepth: 1,
    });
    const leaf = await seedChainRun({
      agentId, orgId, label: 'leaf', queuedAt: at(4), deviceId: visibleDevice,
      continuedFromRunId: hiddenStep, chainRootRunId: root, chainDepth: 2,
    });

    // Positive control: unrestricted, the chain lists every step.
    expect(await readChain(reader, leaf)).toEqual([root, hiddenStep, deviceLessStep, visibleStep, leaf]);

    await getTestDb().update(organizationUsers).set({ siteIds: [reader.env.site.id] }).where(and(
      eq(organizationUsers.userId, reader.env.user.id),
      eq(organizationUsers.orgId, orgId),
    ));
    await clearPermissionCache(reader.env.user.id);

    // The chain drops the steps the caller could not open (another site's
    // device, no device), from a member and from the root alike.
    expect(await readChain(reader, leaf)).toEqual([root, visibleStep, leaf]);
    expect(await readChain(reader, root)).toEqual([root, visibleStep, leaf]);
    for (const runId of [hiddenStep, deviceLessStep]) {
      expect((await reader.get(`/ai-agents/runs/${runId}`)).status, runId).toBe(404);
    }
  });
});
