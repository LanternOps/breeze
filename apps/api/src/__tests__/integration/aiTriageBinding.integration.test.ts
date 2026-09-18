/**
 * Live-Postgres proof for wave 3d's managed AI-triage binding (#3824).
 *
 * Why integration and not unit: the worker unit suites mock `../../db` and
 * `createAutomationRunRecord`, so they cannot expose the original failure:
 * resolving a partner-wide automation's configured target set and creating
 * one `ai_agent_runs` row per fleet device for a single alert. This suite
 * carries the real BullMQ payload through its strict wire schema and executes
 * it against real Postgres, including unmanaged event-device binding and
 * cross-partner rejection (#5240).
 *
 * This file must live under `src/__tests__/integration/`; anywhere else it
 * runs in ZERO CI jobs.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { AiAgentTriggers } from '@breeze/shared';

const { publishEventMock } = vi.hoisted(() => ({
  publishEventMock: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'test-event-id'),
}));
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: publishEventMock };
});

import { db, withSystemDbAccessContext } from '../../db';
import {
  aiAgentRuns,
  aiAgents,
  alerts,
  automationActionResults,
  automationRunDeviceResults,
  automationRuns,
  automations,
  devices,
} from '../../db/schema';
import {
  __testOnly,
  getAutomationQueue,
  shutdownAutomationWorker,
} from '../../jobs/automationWorker';
import {
  automationQueueJobDataSchema,
  type AutomationQueueJobData,
} from '../../jobs/queueSchemas';
import { ensureManagedTriageAutomation } from '../../services/aiAgents/managedAutomation';
import {
  registerAgentRunEnqueuer,
  type AgentRunEnqueuer,
} from '../../services/aiAgents/runService';
import { resolveAutomationTargetDeviceIds } from '../../services/automationRuntime';
import { handleAgentRunTerminalForAutomation } from '../../services/automationTerminalEvidence';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';

type ExecuteRunJobData = Extract<AutomationQueueJobData, { type: 'execute-run' }>;

interface Fixture {
  partner: { id: string };
  orgA: { id: string };
  orgB: { id: string };
  user: { id: string };
  agent: { id: string };
  managedAutomation: typeof automations.$inferSelect;
  deviceA1: { id: string };
  deviceA2: { id: string };
  deviceA3: { id: string };
  deviceB1: { id: string };
  fleetDeviceIds: string[];
}

function policyFields() {
  return {
    enabled: true,
    mode: 'shadow' as const,
    model: null,
    toolAllowlist: ['query_devices'],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: { maxConcurrentRuns: 5, maxRunsPerHour: 50, maxBudgetCentsPerDay: 1000 },
    // `satisfies` rather than a bare literal: without a contextual type the
    // severity array infers as `string[]`, which the jsonb column's
    // `Partial<AiAgentTriggers>` rejects.
    triggers: {
      alertSeverities: ['critical', 'high'],
      respectMaintenanceWindows: false,
    } satisfies Partial<AiAgentTriggers>,
    recipients: { userIds: [], roleIds: [] },
    instructions: null,
    cooldownSeconds: 0,
  };
}

async function seedFixture(): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const siteA = await createSite({ orgId: orgA.id });
    const siteB = await createSite({ orgId: orgB.id });
    const user = await createUser({
      partnerId: partner.id,
      orgId: orgA.id,
      email: `ai-triage-binding-${randomUUID()}@integration.test`,
    });

    const suffix = randomUUID().slice(0, 8);
    const insertedDevices = await db
      .insert(devices)
      .values([
        {
          orgId: orgA.id,
          siteId: siteA.id,
          agentId: `triage-a1-${suffix}`,
          hostname: `triage-a1-${suffix}`,
          osType: 'linux',
          osVersion: '22.04',
          architecture: 'x86_64',
          agentVersion: '0.0.0-test',
          status: 'online',
        },
        {
          orgId: orgA.id,
          siteId: siteA.id,
          agentId: `triage-a2-${suffix}`,
          hostname: `triage-a2-${suffix}`,
          osType: 'linux',
          osVersion: '22.04',
          architecture: 'x86_64',
          agentVersion: '0.0.0-test',
          status: 'online',
        },
        {
          orgId: orgA.id,
          siteId: siteA.id,
          agentId: `triage-a3-${suffix}`,
          hostname: `triage-a3-${suffix}`,
          osType: 'linux',
          osVersion: '22.04',
          architecture: 'x86_64',
          agentVersion: '0.0.0-test',
          status: 'online',
        },
        {
          orgId: orgB.id,
          siteId: siteB.id,
          agentId: `triage-b1-${suffix}`,
          hostname: `triage-b1-${suffix}`,
          osType: 'linux',
          osVersion: '22.04',
          architecture: 'x86_64',
          agentVersion: '0.0.0-test',
          status: 'online',
        },
      ])
      .returning({ id: devices.id });

    if (insertedDevices.length !== 4) {
      throw new Error(`expected four fixture devices, inserted ${insertedDevices.length}`);
    }
    const [deviceA1, deviceA2, deviceA3, deviceB1] = insertedDevices;

    const [agent] = await db
      .insert(aiAgents)
      .values({
        partnerId: partner.id,
        orgId: null,
        kind: 'triage',
        name: 'Fleet Triage',
        ...policyFields(),
        createdBy: user.id,
      })
      .returning({
        id: aiAgents.id,
        kind: aiAgents.kind,
        name: aiAgents.name,
        // The seeded automation mirrors the agent's own switch rather than
        // hardcoding true, so the projection has to carry it.
        enabled: aiAgents.enabled,
        orgId: aiAgents.orgId,
        partnerId: aiAgents.partnerId,
        createdBy: aiAgents.createdBy,
      });
    if (!agent) throw new Error('failed to insert the partner-wide triage agent');

    await ensureManagedTriageAutomation(agent);
    const [managedAutomation] = await db
      .select()
      .from(automations)
      .where(eq(automations.managedByAgentId, agent.id))
      .limit(1);
    if (!managedAutomation) throw new Error('managed triage automation was not created');

    return {
      partner,
      orgA,
      orgB,
      user: { id: user.id },
      agent: { id: agent.id },
      managedAutomation,
      deviceA1: deviceA1!,
      deviceA2: deviceA2!,
      deviceA3: deviceA3!,
      deviceB1: deviceB1!,
      fleetDeviceIds: insertedDevices.map((device) => device.id),
    };
  });
}

async function seedAlert(orgId: string, deviceId: string) {
  return withSystemDbAccessContext(async () => {
    const [alert] = await db
      .insert(alerts)
      .values({
        orgId,
        deviceId,
        severity: 'critical',
        status: 'active',
        title: 'Critical integration-test alert',
        message: 'A single alert must create a single AI triage run',
      })
      .returning({ id: alerts.id });
    if (!alert) throw new Error('failed to insert the alert fixture');
    return { alertId: alert.id, ruleId: randomUUID() };
  });
}

async function triggerEvent(
  automationId: string,
  eventPayload: Record<string, unknown>,
  eventId = randomUUID(),
) {
  const result = await withSystemDbAccessContext(() =>
    __testOnly.processTriggerEvent({
      type: 'trigger-event',
      automationId,
      eventType: 'alert.triggered',
      eventId,
      eventPayload,
      eventTimestamp: '2026-08-24T12:00:00.000Z',
    }),
  );
  return { result, eventId };
}

function requireRunId(result: { runId?: string; skipped?: string }): string {
  if (typeof result.runId !== 'string') {
    throw new Error(`expected an automation run id, got ${JSON.stringify(result)}`);
  }
  expect(result.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  expect(result).toEqual({ runId: result.runId });
  return result.runId;
}

async function queuedExecuteRun(runId: string): Promise<ExecuteRunJobData> {
  const expectedJobId = `automation-run-${runId}`;
  const job = await getAutomationQueue().getJob(expectedJobId);
  if (!job) throw new Error(`BullMQ job ${expectedJobId} was not found`);

  expect(job.id).toBe(expectedJobId);
  expect(job.name).toBe('execute-run');
  const parsed = automationQueueJobDataSchema.parse(job.data);
  if (parsed.type !== 'execute-run') {
    throw new Error(`expected execute-run data, got ${parsed.type}`);
  }
  expect(parsed.runId).toBe(runId);
  return parsed;
}

async function executeQueuedRun(runId: string): Promise<ExecuteRunJobData> {
  const jobData = await queuedExecuteRun(runId);
  await withSystemDbAccessContext(() => __testOnly.processExecuteRun(jobData));
  return jobData;
}

async function allAgentRuns() {
  return withSystemDbAccessContext(() => db.select().from(aiAgentRuns));
}

async function allAutomationRuns() {
  return withSystemDbAccessContext(() => db.select().from(automationRuns));
}

beforeEach(() => {
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  publishEventMock.mockClear();
  const enqueuer: AgentRunEnqueuer = async (runId) => ({
    enqueued: true,
    jobId: `agent-run:${runId}`,
  });
  registerAgentRunEnqueuer(enqueuer);
});

afterEach(() => {
  registerAgentRunEnqueuer(null);
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await shutdownAutomationWorker();
});

describe('managed AI-triage event binding against real Postgres', () => {
  it('one alert creates exactly one agent run bound to that alert and device', async () => {
    const fixture = await seedFixture();

    const configuredTargets = await withSystemDbAccessContext(() =>
      resolveAutomationTargetDeviceIds(fixture.managedAutomation),
    );
    expect(configuredTargets.sort()).toEqual([...fixture.fleetDeviceIds].sort());
    expect(configuredTargets).toHaveLength(4);

    const alert = await seedAlert(fixture.orgA.id, fixture.deviceA1.id);
    const { result, eventId } = await triggerEvent(
      fixture.managedAutomation.id,
      {
        alertId: alert.alertId,
        ruleId: alert.ruleId,
        deviceId: fixture.deviceA1.id,
        severity: 'critical',
        title: 'Critical integration-test alert',
        message: 'A single alert must create a single AI triage run',
      },
    );
    const runId = requireRunId(result);
    const jobData = await queuedExecuteRun(runId);
    expect(jobData.targetDeviceIds).toEqual([fixture.deviceA1.id]);
    expect(jobData.triggerContext).toEqual({
      alertId: alert.alertId,
      eventId,
      severity: 'critical',
      ruleId: alert.ruleId,
    });

    await withSystemDbAccessContext(() => __testOnly.processExecuteRun(jobData));

    const rows = await allAgentRuns();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      deviceId: fixture.deviceA1.id,
      alertId: alert.alertId,
      orgId: fixture.orgA.id,
      agentId: fixture.agent.id,
      dedupeKey: `alert:${alert.alertId}`,
      triggerKind: 'alert',
      status: 'queued',
      // The event id survived worker -> queue -> runtime -> admission gate. No
      // unit seam can show this: the worker suite mocks the runtime and the
      // runtime suite mocks the gate, so each proves only its own hop.
      triggerEventId: eventId,
    });
    // Attribution (Task 4's triggerRef contract): the run must be traceable
    // back to the managed automation and the specific automation run that
    // dispatched it, not merely to the effective agent the gate resolved.
    expect(rows[0]?.triggerRef).toEqual({
      automationId: fixture.managedAutomation.id,
      automationRunId: runId,
      alertRuleId: alert.ruleId,
      managedByAgentId: fixture.agent.id,
      // AI patch agent W04 (#5750): a rule-less alert resolves to no template
      // category, so the classifier fails closed and triage keeps it — with
      // the reason recorded on the run.
      patchWorkFallbackReason: 'not_patch_work',
    });
  });

  it('the automation run targeted exactly the alert device', async () => {
    const fixture = await seedFixture();
    const alert = await seedAlert(fixture.orgA.id, fixture.deviceA1.id);
    const { result } = await triggerEvent(fixture.managedAutomation.id, {
      alertId: alert.alertId,
      ruleId: alert.ruleId,
      deviceId: fixture.deviceA1.id,
      severity: 'critical',
      title: 'Critical integration-test alert',
      message: 'Only device A1 should be targeted',
    });
    const runId = requireRunId(result);
    await executeQueuedRun(runId);

    const loadRun = () => withSystemDbAccessContext(() =>
      db.select().from(automationRuns).where(eq(automationRuns.id, runId)),
    );
    const loadDeviceResults = () => withSystemDbAccessContext(() =>
      db
        .select()
        .from(automationRunDeviceResults)
        .where(eq(automationRunDeviceResults.runId, runId)),
    );

    // #5290 — enqueueing the child agent run is NOT a completed remediation.
    // The action stays queued (carrying the agent-run correlation) and the run
    // aggregates as still running with nothing succeeded yet; before #5290 this
    // read `completed` / devicesSucceeded 1 for a triage that had not run.
    const agentRuns = await allAgentRuns();
    expect(agentRuns).toHaveLength(1);
    const agentRunId = agentRuns[0]!.id;

    const queuedRuns = await loadRun();
    expect(queuedRuns).toHaveLength(1);
    expect(queuedRuns[0]).toMatchObject({
      devicesTargeted: 1,
      devicesSucceeded: 0,
      devicesFailed: 0,
      status: 'running',
    });

    const actionResults = await withSystemDbAccessContext(() =>
      db
        .select()
        .from(automationActionResults)
        .where(eq(automationActionResults.runId, runId)),
    );
    expect(actionResults).toHaveLength(1);
    expect(actionResults[0]).toMatchObject({
      deviceId: fixture.deviceA1.id,
      orgId: fixture.orgA.id,
      actionType: 'ai_triage',
      status: 'queued',
      agentRunId,
    });

    const queuedDeviceResults = await loadDeviceResults();
    expect(queuedDeviceResults).toHaveLength(1);
    expect(queuedDeviceResults[0]).toMatchObject({
      runId,
      deviceId: fixture.deviceA1.id,
      orgId: fixture.orgA.id,
    });
    expect(queuedDeviceResults[0]!.status).not.toBe('success');

    // The child run's own terminal event — delivered by the durable
    // `ai.agent.run.*` subscriber — is what terminalises the action and lets
    // the run aggregate to completed with exactly the alert device succeeded.
    await withSystemDbAccessContext(() =>
      handleAgentRunTerminalForAutomation({
        type: 'ai.agent.run.completed',
        payload: { runId: agentRunId },
      }),
    );

    const runs = await loadRun();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      devicesTargeted: 1,
      devicesSucceeded: 1,
      devicesFailed: 0,
      status: 'completed',
    });

    const deviceResults = await loadDeviceResults();
    expect(deviceResults).toHaveLength(1);
    expect(deviceResults[0]).toMatchObject({
      runId,
      deviceId: fixture.deviceA1.id,
      orgId: fixture.orgA.id,
      status: 'success',
    });
  });

  it('re-delivering the same alert is idempotent end to end', async () => {
    const fixture = await seedFixture();
    const alert = await seedAlert(fixture.orgA.id, fixture.deviceA1.id);
    const payload = {
      alertId: alert.alertId,
      ruleId: alert.ruleId,
      deviceId: fixture.deviceA1.id,
      severity: 'critical',
      title: 'Critical integration-test alert',
      message: 'This alert is delivered twice',
    };

    const first = await triggerEvent(fixture.managedAutomation.id, payload, randomUUID());
    const firstRunId = requireRunId(first.result);
    await executeQueuedRun(firstRunId);

    const second = await triggerEvent(fixture.managedAutomation.id, payload, randomUUID());
    const secondRunId = requireRunId(second.result);
    expect(second.eventId).not.toBe(first.eventId);
    expect(secondRunId).not.toBe(firstRunId);
    await executeQueuedRun(secondRunId);

    const agentRuns = await allAgentRuns();
    expect(agentRuns).toHaveLength(1);
    expect(agentRuns[0]?.dedupeKey).toBe(`alert:${alert.alertId}`);

    const [secondAutomationRun] = await withSystemDbAccessContext(() =>
      db.select().from(automationRuns).where(eq(automationRuns.id, secondRunId)).limit(1),
    );
    expect(secondAutomationRun).toMatchObject({
      id: secondRunId,
      status: 'completed',
      devicesTargeted: 1,
      devicesSucceeded: 1,
      devicesFailed: 0,
    });
  });

  it('an org B alert creates its run in org B', async () => {
    const fixture = await seedFixture();
    const alert = await seedAlert(fixture.orgB.id, fixture.deviceB1.id);
    const { result } = await triggerEvent(fixture.managedAutomation.id, {
      alertId: alert.alertId,
      ruleId: alert.ruleId,
      deviceId: fixture.deviceB1.id,
      severity: 'critical',
      title: 'Org B critical alert',
      message: 'The device org must own the agent run',
    });
    await executeQueuedRun(requireRunId(result));

    const rows = await allAgentRuns();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId: fixture.orgB.id,
      deviceId: fixture.deviceB1.id,
      alertId: alert.alertId,
      agentId: fixture.agent.id,
    });
  });

  it('a device-less payload skips without creating an automation run', async () => {
    const fixture = await seedFixture();
    const { result } = await triggerEvent(fixture.managedAutomation.id, {
      alertId: randomUUID(),
      ruleId: randomUUID(),
      severity: 'critical',
      title: 'Device-less alert',
      message: 'There is no device to triage',
    });

    expect(result).toEqual({ skipped: 'managed_automation_event_has_no_device' });
    expect(await allAutomationRuns()).toEqual([]);
    expect(await allAgentRuns()).toEqual([]);
  });

  it('an automation-created alert is skipped', async () => {
    const fixture = await seedFixture();
    const { result } = await triggerEvent(fixture.managedAutomation.id, {
      alertId: randomUUID(),
      ruleId: randomUUID(),
      deviceId: fixture.deviceA1.id,
      automationId: randomUUID(),
      severity: 'critical',
      title: 'Automation-created alert',
      message: 'Managed triage must not create a feedback loop',
    });

    expect(result).toEqual({ skipped: 'managed_automation_skips_automation_created_alerts' });
    expect(await allAutomationRuns()).toEqual([]);
    expect(await allAgentRuns()).toEqual([]);
  });

  it('kill switch off still completes the automation run without an agent run', async () => {
    const fixture = await seedFixture();
    const alert = await seedAlert(fixture.orgA.id, fixture.deviceA1.id);
    vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'false');

    const { result } = await triggerEvent(fixture.managedAutomation.id, {
      alertId: alert.alertId,
      ruleId: alert.ruleId,
      deviceId: fixture.deviceA1.id,
      severity: 'critical',
      title: 'Kill-switch test alert',
      message: 'The outer automation should still succeed',
    });
    const runId = requireRunId(result);
    await executeQueuedRun(runId);

    const [automationRun] = await withSystemDbAccessContext(() =>
      db.select().from(automationRuns).where(eq(automationRuns.id, runId)).limit(1),
    );
    expect(automationRun).toMatchObject({
      id: runId,
      status: 'completed',
      devicesTargeted: 1,
      devicesSucceeded: 1,
      devicesFailed: 0,
    });
    expect(await allAgentRuns()).toEqual([]);
  });

  it('an unmanaged event automation binds to the event device (no fleet fan-out, #5240)', async () => {
    const fixture = await seedFixture();
    const alert = await seedAlert(fixture.orgA.id, fixture.deviceA1.id);
    const [unmanagedAutomation] = await withSystemDbAccessContext(() =>
      db
        .insert(automations)
        .values({
          orgId: null,
          partnerId: fixture.partner.id,
          managedByAgentId: null,
          name: 'Unmanaged partner-wide alert automation',
          enabled: true,
          trigger: { type: 'event', eventType: 'alert.triggered' },
          actions: [{
            type: 'create_alert',
            alertSeverity: 'low',
            alertMessage: 'Unmanaged event-device binding',
          }],
          onFailure: 'stop',
          createdBy: fixture.user.id,
        })
        .returning(),
    );
    if (!unmanagedAutomation) throw new Error('failed to insert unmanaged automation');

    const { result } = await triggerEvent(unmanagedAutomation.id, {
      alertId: alert.alertId,
      ruleId: alert.ruleId,
      deviceId: fixture.deviceA1.id,
      severity: 'critical',
      title: 'Critical integration-test alert',
      message: 'Unmanaged automations target only the event device',
    });
    const runId = requireRunId(result);
    const jobData = await queuedExecuteRun(runId);

    expect(jobData.targetDeviceIds).toEqual([fixture.deviceA1.id]);
    expect(jobData.targetDeviceIds).toHaveLength(1);
    expect('triggerContext' in jobData).toBe(false);

    const [automationRun] = await withSystemDbAccessContext(() =>
      db.select().from(automationRuns).where(eq(automationRuns.id, runId)).limit(1),
    );
    expect(automationRun).toMatchObject({
      id: runId,
      automationId: unmanagedAutomation.id,
      devicesTargeted: 1,
      devicesSucceeded: 0,
      devicesFailed: 0,
      status: 'running',
    });
  });

  it('an unmanaged event automation rejects an event device in a different partner (#5240)', async () => {
    const fixture = await seedFixture();
    const foreignDevice = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const site = await createSite({ orgId: org.id });
      const suffix = randomUUID().slice(0, 8);
      const [device] = await db.insert(devices).values({
        orgId: org.id,
        siteId: site.id,
        agentId: `triage-foreign-${suffix}`,
        hostname: `triage-foreign-${suffix}`,
        osType: 'linux',
        osVersion: '22.04',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'online',
      }).returning({ id: devices.id, orgId: devices.orgId });
      if (!device) throw new Error('failed to insert foreign-partner device');
      return device;
    });
    const alert = await seedAlert(foreignDevice.orgId, foreignDevice.id);
    const [unmanagedAutomation] = await withSystemDbAccessContext(() =>
      db
        .insert(automations)
        .values({
          orgId: null,
          partnerId: fixture.partner.id,
          managedByAgentId: null,
          name: 'Unmanaged partner-wide alert automation',
          enabled: true,
          trigger: { type: 'event', eventType: 'alert.triggered' },
          actions: [{
            type: 'create_alert',
            alertSeverity: 'low',
            alertMessage: 'Unmanaged event-device binding',
          }],
          onFailure: 'stop',
          createdBy: fixture.user.id,
        })
        .returning(),
    );
    if (!unmanagedAutomation) throw new Error('failed to insert unmanaged automation');

    const { result } = await triggerEvent(unmanagedAutomation.id, {
      alertId: alert.alertId,
      ruleId: alert.ruleId,
      deviceId: foreignDevice.id,
      severity: 'critical',
      title: 'Different-partner alert',
      message: 'The event device is outside the automation partner',
    });

    expect(result.skipped).toBe('event_device_outside_automation_scope');
    expect(await allAutomationRuns()).toEqual([]);
  });
});
