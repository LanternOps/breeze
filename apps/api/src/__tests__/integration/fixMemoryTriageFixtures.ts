/**
 * AI Suggested Fixes W3 — shared real-Postgres fixtures for the fix-memory
 * consumer suites (fixMemoryTriageShortCircuit, fixMemoryTxSafety). Harness
 * copied from aiTriageBinding.integration.test.ts: a partner-wide triage
 * agent with its managed automation, one Windows device, and a
 * script-exit-code alert (which carries a non-broad fix signature).
 */
import { createHash, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { AiAgentTriggers } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../../db';
import {
  aiAgentRuns,
  aiAgents,
  alerts,
  automations,
  devices,
  fixMemory,
  remediationSuggestions,
  scripts,
  scriptVersions,
} from '../../db/schema';
import { __testOnly, getAutomationQueue } from '../../jobs/automationWorker';
import { automationQueueJobDataSchema } from '../../jobs/queueSchemas';
import { ensureManagedTriageAutomation } from '../../services/aiAgents/managedAutomation';
import { alertSignature } from '../../services/fixMemory/signatureLoader';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';

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

export async function seedTriageWorld(mode: 'shadow' | 'act') {
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

export type TriageWorld = Awaited<ReturnType<typeof seedTriageWorld>>;

/** A proven, partner-wide memory row for the alert's exact signature. */
export async function seedProven(w: TriageWorld) {
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
export async function fireTriage(w: TriageWorld): Promise<string> {
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

export const fullRuns = (alertId: string) => withSystemDbAccessContext(() => db.select().from(aiAgentRuns)
  .where(and(eq(aiAgentRuns.alertId, alertId), eq(aiAgentRuns.profile, 'full'))));

export const memorySuggestions = (alertId: string) => withSystemDbAccessContext(() => db.select().from(remediationSuggestions)
  .where(and(eq(remediationSuggestions.alertId, alertId), eq(remediationSuggestions.origin, 'memory'))));
