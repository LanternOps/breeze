/**
 * AI Suggested Fixes W3 (#7143, Q1 = C) — live-Postgres proof of the shadow
 * short-circuit through the REAL automation `ai_triage` path: alert event →
 * managed triage automation → execute-run → admission. Harness copied from
 * aiTriageBinding.integration.test.ts.
 *
 * - shadow + an attachable proven fix → no full triage run; the fix is
 *   attached to the alert as an origin='memory' suggestion;
 * - shadow without one → the full run is admitted as before;
 * - act → the full run is admitted, and its context load resolves the fix;
 * - the verdict lane is unchanged.
 *
 * This file must live under `src/__tests__/integration/`; anywhere else it
 * runs in ZERO CI jobs.
 */
import './setup';

import { createHash, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
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
  automations,
  devices,
  fixMemory,
  remediationSuggestions,
  scripts,
  scriptVersions,
} from '../../db/schema';
import { __testOnly, getAutomationQueue, shutdownAutomationWorker } from '../../jobs/automationWorker';
import { automationQueueJobDataSchema } from '../../jobs/queueSchemas';
import { ensureManagedTriageAutomation } from '../../services/aiAgents/managedAutomation';
import {
  createAndEnqueueAgentRun,
  registerAgentRunEnqueuer,
  type AgentRunEnqueuer,
} from '../../services/aiAgents/runService';
import { alertSignature } from '../../services/fixMemory/signatureLoader';
import { loadProvenFixesForRun } from '../../services/fixMemory/runMemory';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { usePlatformAiKeyPlaceholder } from './helpers/platformAiKey';

usePlatformAiKeyPlaceholder();

function policyFields(mode: 'shadow' | 'act') {
  return {
    enabled: true,
    mode,
    model: null,
    toolAllowlist: ['query_devices'],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: { maxConcurrentRuns: 5, maxRunsPerHour: 50, maxBudgetCentsPerDay: 1000 },
    triggers: {
      alertSeverities: ['critical', 'high'],
      respectMaintenanceWindows: false,
    } satisfies Partial<AiAgentTriggers>,
    recipients: { userIds: [], roleIds: [] },
    instructions: null,
    cooldownSeconds: 0,
  };
}

async function seedTriageWorld(mode: 'shadow' | 'act') {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await db.execute(sql`UPDATE organizations SET settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{mlFeatureFlags}', '{"ml.remediation_suggestions.enabled": true}'::jsonb) WHERE id = ${org.id}`);
    const site = await createSite({ orgId: org.id });
    const user = await createUser({ partnerId: partner.id, orgId: org.id, email: `w3-sc-${randomUUID()}@integration.test` });
    const suffix = randomUUID().slice(0, 8);
    const [device] = await db.insert(devices).values({
      orgId: org.id, siteId: site.id, agentId: `w3-${suffix}`, hostname: `w3-${suffix}`,
      osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online',
    }).returning({ id: devices.id });
    const [agent] = await db.insert(aiAgents).values({
      partnerId: partner.id, orgId: null, kind: 'triage', name: 'Fleet Triage', ...policyFields(mode), createdBy: user.id,
    }).returning({
      id: aiAgents.id, kind: aiAgents.kind, name: aiAgents.name, enabled: aiAgents.enabled,
      orgId: aiAgents.orgId, partnerId: aiAgents.partnerId, createdBy: aiAgents.createdBy,
    });
    await ensureManagedTriageAutomation(agent!);
    const [automation] = await db.select().from(automations).where(eq(automations.managedByAgentId, agent!.id)).limit(1);
    const mkScript = async () => {
      const [s] = await db.insert(scripts).values({
        name: `fix-${randomUUID().slice(0, 6)}`, language: 'powershell', content: 'Restart-Service Spooler',
        osTypes: ['windows'], orgId: null, partnerId: partner.id,
      }).returning({ id: scripts.id, name: scripts.name });
      const [v] = await db.insert(scriptVersions).values({
        scriptId: s!.id, version: 1, content: 'Restart-Service Spooler', language: 'powershell', timeoutSeconds: 300,
        runAs: 'system', contentDigest: createHash('sha256').update(s!.id).digest('hex'),
      }).returning({ id: scriptVersions.id });
      return { scriptId: s!.id, name: s!.name, versionId: v!.id };
    };
    const watched = await mkScript();
    const fix = await mkScript();
    const [alert] = await db.insert(alerts).values({
      orgId: org.id, deviceId: device!.id, severity: 'critical', status: 'active', title: 'exit 3',
      context: { source: 'script_exit_code', scriptId: watched.scriptId, exitCode: 3 },
    }).returning({ id: alerts.id });
    return { partnerId: partner.id, orgId: org.id, deviceId: device!.id, alertId: alert!.id, automation: automation!, fix };
  });
}

type World = Awaited<ReturnType<typeof seedTriageWorld>>;

/** A proven, partner-wide memory row for the alert's exact signature. */
async function seedProven(w: World) {
  await withSystemDbAccessContext(async () => {
    const resolved = await alertSignature(w.alertId);
    expect(resolved?.signature.broad).toBe(false);
    await db.insert(fixMemory).values({
      orgId: null, partnerId: w.partnerId,
      signatureVersion: resolved!.signature.version, signatureKey: resolved!.signature.key, broadKey: resolved!.signature.broadKey,
      osType: 'windows', fixKind: 'partner_script', fixIdentity: `script_version:${w.fix.versionId}`,
      scriptId: w.fix.scriptId, scriptVersionId: w.fix.versionId,
      attempts: 4, verifiedCount: 4, rollingSuccessRate: 1, recentOutcomes: ['verified', 'verified', 'verified', 'verified'],
      status: 'active', lastVerifiedAt: new Date(),
    });
  });
}

/** Fire the alert through the managed automation and run its execute-run job. Returns the automation run id. */
async function fireTriage(w: World): Promise<string> {
  const result = await withSystemDbAccessContext(() => __testOnly.processTriggerEvent({
    type: 'trigger-event',
    automationId: w.automation.id,
    eventType: 'alert.triggered',
    eventId: randomUUID(),
    eventPayload: { alertId: w.alertId, ruleId: randomUUID(), deviceId: w.deviceId, severity: 'critical', title: 'exit 3' },
    eventTimestamp: '2026-08-24T12:00:00.000Z',
  }));
  if (typeof result.runId !== 'string') throw new Error(`expected an automation run id, got ${JSON.stringify(result)}`);
  const job = await getAutomationQueue().getJob(`automation-run-${result.runId}`);
  if (!job) throw new Error('execute-run job not found');
  const parsed = automationQueueJobDataSchema.parse(job.data);
  if (parsed.type !== 'execute-run') throw new Error(`expected execute-run, got ${parsed.type}`);
  await withSystemDbAccessContext(() => __testOnly.processExecuteRun(parsed));
  return result.runId;
}

const fullRuns = (alertId: string) => withSystemDbAccessContext(() => db.select().from(aiAgentRuns)
  .where(and(eq(aiAgentRuns.alertId, alertId), eq(aiAgentRuns.profile, 'full'))));

const memorySuggestions = (alertId: string) => withSystemDbAccessContext(() => db.select().from(remediationSuggestions)
  .where(and(eq(remediationSuggestions.alertId, alertId), eq(remediationSuggestions.origin, 'memory'))));

beforeEach(() => {
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  publishEventMock.mockClear();
  const enqueuer: AgentRunEnqueuer = async (runId) => ({ enqueued: true, jobId: `agent-run:${runId}` });
  registerAgentRunEnqueuer(enqueuer);
});

afterEach(() => {
  registerAgentRunEnqueuer(null);
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await shutdownAutomationWorker();
});

describe('W3 shadow short-circuit through the automation ai_triage path (real Postgres)', () => {
  it('shadow + proven fix → no full triage run, the proven fix is attached, and the action succeeds', async () => {
    const w = await seedTriageWorld('shadow');
    await seedProven(w);
    const automationRunId = await fireTriage(w);

    expect(await fullRuns(w.alertId)).toEqual([]);
    expect((await memorySuggestions(w.alertId)).map((r) => r.scriptId)).toEqual([w.fix.scriptId]);
    const actions = await withSystemDbAccessContext(() => db.select().from(automationActionResults)
      .where(eq(automationActionResults.runId, automationRunId)));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ status: 'succeeded' });
  });

  it('shadow without a proven fix → the full run is admitted as today', async () => {
    const w = await seedTriageWorld('shadow');
    await fireTriage(w);
    expect(await fullRuns(w.alertId)).toHaveLength(1);
    expect(await memorySuggestions(w.alertId)).toEqual([]);
  });

  it('act mode → the full run is admitted, and its context load will carry the proven fix', async () => {
    const w = await seedTriageWorld('act');
    await seedProven(w);
    await fireTriage(w);
    const runs = await fullRuns(w.alertId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ modeAtStart: 'act', dedupeKey: `alert:${w.alertId}` });
    const memory = await withSystemDbAccessContext(() => loadProvenFixesForRun({
      orgId: w.orgId, partnerId: w.partnerId, alertId: w.alertId, correlationGroupId: null,
    }));
    expect(memory?.proven.map((p) => p.scriptName)).toEqual([w.fix.name]);
  });

  it('verdict behaviour is unchanged: the verdict lane is admitted even in shadow with a proven fix', async () => {
    const w = await seedTriageWorld('shadow');
    await seedProven(w);
    const verdict = await createAndEnqueueAgentRun({
      orgId: w.orgId, kind: 'triage', profile: 'verdict', triggerKind: 'alert', deviceId: w.deviceId, alertId: w.alertId,
      dedupeKey: `alert-verdict:${w.alertId}`,
    });
    expect(verdict).toMatchObject({ created: true });
  });
});
