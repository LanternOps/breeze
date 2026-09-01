/**
 * Live-Postgres proof for the wave 6 PR 2 (#3828) per-org circuit breaker:
 * `agentCircuit.ts`'s `recordRunTerminal`/`isCircuitOpen`/`resetCircuit`
 * against the REAL `ai_agent_circuit_state` table (composite `(org_id,
 * partner_id)` FK, `(org_id, agent_id)` primary key, RLS), driven end-to-end
 * through `transitionRunStatus` and `createAndEnqueueAgentRun` — the same
 * gap `agentRunAdmission.integration.test.ts`'s header explains for
 * admission generally: a mocked `../../db` proves ORDER, not what Postgres
 * actually enforces (the composite FK, the advisory-lock-free row locking
 * the "opens exactly once" guarantee actually relies on, RLS on the new
 * table).
 *
 * Lives under `src/__tests__/integration/` so both vitest configs' wholesale
 * globs pick it up — anywhere else runs in ZERO CI jobs.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

const { publishEventMock } = vi.hoisted(() => ({
  publishEventMock: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'test-event-id'),
}));
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: publishEventMock };
});

import { db, withSystemDbAccessContext } from '../../db';
import { aiAgentRuns, aiAgents, auditLogs, devices } from '../../db/schema';
import { aiAgentCircuitState } from '../../db/schema/aiAgentCircuitState';
import {
  createAndEnqueueAgentRun,
  registerAgentRunEnqueuer,
  transitionRunStatus,
  type AgentRunEnqueuer,
  type CreateAgentRunInput,
  type CreateAgentRunResult,
} from '../../services/aiAgents/runService';
import { getCircuitState, isCircuitOpen, resetCircuit } from '../../services/aiAgents/agentCircuit';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';

interface Tenant {
  partner: { id: string };
  org: { id: string };
  device: { id: string };
  user: { id: string };
  agent: { id: string };
}

async function seedTenant(maxConsecutiveFailures: number): Promise<Tenant> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const user = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `agentcircuit-${randomUUID()}@agentcircuit.test`,
  });

  const unique = randomUUID().slice(0, 8);
  const [device] = await withSystemDbAccessContext(() =>
    db
      .insert(devices)
      .values({
        orgId: org.id,
        siteId: site.id,
        agentId: `circuit-agent-${unique}`,
        hostname: `circuit-host-${unique}`,
        osType: 'linux',
        osVersion: '22.04',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'online',
      })
      .returning({ id: devices.id }),
  );

  const [agent] = await withSystemDbAccessContext(() =>
    db
      .insert(aiAgents)
      .values({
        partnerId: partner.id,
        orgId: null,
        kind: 'triage',
        name: 'Circuit Test Agent',
        enabled: true,
        mode: 'shadow',
        toolAllowlist: ['query_devices'],
        protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
        limits: {
          maxConcurrentRuns: 5, maxRunsPerHour: 50, maxBudgetCentsPerDay: 1000,
          maxConsecutiveFailures,
        },
        triggers: { alertSeverities: ['critical', 'high'], respectMaintenanceWindows: false },
        recipients: { userIds: [], roleIds: [] },
        cooldownSeconds: 0,
        createdBy: user.id,
      })
      .returning({ id: aiAgents.id }),
  );

  return { partner, org, device: device!, user: { id: user.id }, agent: agent! };
}

function triggerInput(t: Tenant): CreateAgentRunInput {
  return {
    orgId: t.org.id,
    kind: 'triage',
    triggerKind: 'manual',
    deviceId: t.device.id,
    dedupeKey: `manual:${randomUUID()}`,
  };
}

function expectCreated(result: CreateAgentRunResult) {
  if (!result.created) throw new Error(`expected the run to be admitted, got skip "${result.skipped}"`);
  return result.run;
}

async function circuitOpenedAuditCount(orgId: string, agentId: string): Promise<number> {
  const rows = await withSystemDbAccessContext(() =>
    db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(
        eq(auditLogs.orgId, orgId),
        eq(auditLogs.resourceId, agentId),
        eq(auditLogs.action, 'ai_agent.circuit_opened'),
      )),
  );
  return rows.length;
}

let enqueued: string[] = [];

beforeEach(() => {
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  publishEventMock.mockClear();
  enqueued = [];
  const enqueuer: AgentRunEnqueuer = async (runId) => {
    enqueued.push(runId);
    return { enqueued: true, jobId: `agent-run:${runId}` };
  };
  registerAgentRunEnqueuer(enqueuer);
});

afterEach(() => {
  registerAgentRunEnqueuer(null);
  vi.unstubAllEnvs();
});

describe('per-org circuit breaker against real Postgres (#3828)', () => {
  it('stays closed below threshold, opens exactly once at threshold, then refuses admission', async () => {
    const t = await seedTenant(2);

    // Failure 1: below threshold, circuit stays closed.
    const run1 = expectCreated(await createAndEnqueueAgentRun(triggerInput(t)));
    await transitionRunStatus(run1.id, ['queued', 'running'], 'failed', {
      errorCode: 'sdk_error', finishedAt: new Date(),
    });
    expect(await isCircuitOpen(t.org.id, t.agent.id)).toBe(false);
    const afterOne = await getCircuitState(t.org.id, t.agent.id);
    expect(afterOne).toMatchObject({ state: 'closed', consecutiveFailures: 1 });

    // Failure 2: crosses the threshold — opens.
    const run2 = expectCreated(await createAndEnqueueAgentRun(triggerInput(t)));
    await transitionRunStatus(run2.id, ['queued', 'running'], 'failed', {
      errorCode: 'sdk_error', finishedAt: new Date(),
    });
    expect(await isCircuitOpen(t.org.id, t.agent.id)).toBe(true);
    const afterTwo = await getCircuitState(t.org.id, t.agent.id);
    expect(afterTwo).toMatchObject({ state: 'open', consecutiveFailures: 2 });
    expect(afterTwo.openedAt).not.toBeNull();
    expect(await circuitOpenedAuditCount(t.org.id, t.agent.id)).toBe(1);

    // Admission-only, never blocking in-flight work: a run already admitted
    // before the circuit opened (simulated directly, bypassing admission)
    // still gets to finish, and its own terminalization must not re-open (or
    // double-audit) an already-open circuit.
    const [inFlight] = await withSystemDbAccessContext(() =>
      db
        .insert(aiAgentRuns)
        .values({
          agentId: t.agent.id,
          orgId: t.org.id,
          deviceId: t.device.id,
          triggerKind: 'manual',
          dedupeKey: `manual:${randomUUID()}`,
          modeAtStart: 'shadow',
          policySnapshot: {
            schemaVersion: 4, agentId: t.agent.id, kind: 'triage',
            effective: {}, provenance: {}, resolvedAt: new Date().toISOString(),
          } as never,
          status: 'running',
        })
        .returning({ id: aiAgentRuns.id }),
    );
    await transitionRunStatus(inFlight!.id, 'running', 'failed', {
      errorCode: 'sdk_error', finishedAt: new Date(),
    });
    // Opens exactly once: no second audit row from the already-open circuit
    // absorbing one more failure.
    expect(await circuitOpenedAuditCount(t.org.id, t.agent.id)).toBe(1);

    // NEW admissions are refused while open.
    expect(await createAndEnqueueAgentRun(triggerInput(t))).toEqual({
      created: false, skipped: 'circuit_open',
    });
    expect(publishEventMock).toHaveBeenCalledWith(
      'ai.agent.run.skipped',
      t.org.id,
      expect.objectContaining({ reason: 'circuit_open', agentId: t.agent.id }),
      'ai-agent-runner',
    );

    // Manual MFA reset (simulated: this IS the route's own service call) is
    // the ONLY way it closes — never automatic.
    const reset = await resetCircuit(t.org.id, t.agent.id, t.user.id);
    expect(reset).toMatchObject({ state: 'closed', consecutiveFailures: 0, resetBy: t.user.id });
    expect(reset.resetAt).not.toBeNull();
    expect(await isCircuitOpen(t.org.id, t.agent.id)).toBe(false);

    // Admission works again post-reset.
    const run3 = expectCreated(await createAndEnqueueAgentRun(triggerInput(t)));
    expect(run3.status).toBe('queued');
  });

  it('a clean success zeroes the counter but does NOT itself close an already-open circuit', async () => {
    const t = await seedTenant(1);

    const run1 = expectCreated(await createAndEnqueueAgentRun(triggerInput(t)));
    await transitionRunStatus(run1.id, ['queued', 'running'], 'failed', {
      errorCode: 'sdk_error', finishedAt: new Date(),
    });
    expect(await isCircuitOpen(t.org.id, t.agent.id)).toBe(true);

    // A run admitted just before the open (simulated) finishes CLEAN.
    const [inFlight] = await withSystemDbAccessContext(() =>
      db
        .insert(aiAgentRuns)
        .values({
          agentId: t.agent.id,
          orgId: t.org.id,
          deviceId: t.device.id,
          triggerKind: 'manual',
          dedupeKey: `manual:${randomUUID()}`,
          modeAtStart: 'shadow',
          policySnapshot: {
            schemaVersion: 4, agentId: t.agent.id, kind: 'triage',
            effective: {}, provenance: {}, resolvedAt: new Date().toISOString(),
          } as never,
          status: 'running',
        })
        .returning({ id: aiAgentRuns.id }),
    );
    await transitionRunStatus(inFlight!.id, 'running', 'completed', {
      outcome: {}, finishedAt: new Date(),
    });

    const snapshot = await getCircuitState(t.org.id, t.agent.id);
    // Counter zeroed by the clean run...
    expect(snapshot.consecutiveFailures).toBe(0);
    // ...but the circuit itself stays open — manual reset only.
    expect(snapshot.state).toBe('open');
    expect(await isCircuitOpen(t.org.id, t.agent.id)).toBe(true);
  });

  it('circuit state is keyed per (org, agent) — a failure streak in one org never blocks another', async () => {
    const a = await seedTenant(1);
    const b = await createOrganization({ partnerId: a.partner.id });

    const runA = expectCreated(await createAndEnqueueAgentRun(triggerInput(a)));
    await transitionRunStatus(runA.id, ['queued', 'running'], 'failed', {
      errorCode: 'sdk_error', finishedAt: new Date(),
    });
    expect(await isCircuitOpen(a.org.id, a.agent.id)).toBe(true);
    expect(await isCircuitOpen(b.id, a.agent.id)).toBe(false);

    const siteB = await createSite({ orgId: b.id });
    const [device] = await withSystemDbAccessContext(() =>
      db
        .insert(devices)
        .values({
          orgId: b.id,
          siteId: siteB.id,
          agentId: `circuit-agent-b-${randomUUID().slice(0, 8)}`,
          hostname: `circuit-host-b-${randomUUID().slice(0, 8)}`,
          osType: 'linux', osVersion: '22.04', architecture: 'x86_64',
          agentVersion: '0.0.0-test', status: 'online',
        })
        .returning({ id: devices.id }),
    );
    const admittedInB = await createAndEnqueueAgentRun({
      orgId: b.id, kind: 'triage', triggerKind: 'manual', deviceId: device!.id,
      dedupeKey: `manual:${randomUUID()}`,
    });
    expect(admittedInB.created).toBe(true);
  });

  it('resetCircuit on a never-tripped (org, agent) pair is a harmless no-op', async () => {
    const t = await seedTenant(3);
    const before = await getCircuitState(t.org.id, t.agent.id);
    expect(before).toMatchObject({ state: 'closed', consecutiveFailures: 0 });

    const after = await resetCircuit(t.org.id, t.agent.id, t.user.id);
    expect(after).toMatchObject({ state: 'closed', consecutiveFailures: 0, resetBy: null });

    // No row was created for a pair with nothing to reset.
    const rows = await withSystemDbAccessContext(() =>
      db
        .select({ orgId: aiAgentCircuitState.orgId })
        .from(aiAgentCircuitState)
        .where(and(eq(aiAgentCircuitState.orgId, t.org.id), eq(aiAgentCircuitState.agentId, t.agent.id))),
    );
    expect(rows).toHaveLength(0);
  });
});
