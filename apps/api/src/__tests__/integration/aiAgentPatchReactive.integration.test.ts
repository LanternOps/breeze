/**
 * AI patch agent W04 (#5750), Task 7 — reactive routing and reboot planning
 * against live PostgreSQL.
 *
 * Sibling of `aiAgentPatchLane` (W01), `aiAgentPatchInstall` (W02) and
 * `aiAgentPatchChase` (W03). What only a real database can show:
 *
 *  1. **A failing patch job raises exactly one patch-categorised alert**
 *     through the real finalizer → `createAlert` path (global built-in
 *     template carrying `PATCH_ALERT_CATEGORY`, org-owned rule), and a
 *     second finalisation of the same job does not raise a second one.
 *  2. **The classifier is join-based and fails closed** — it sees the alert
 *     through `alerts.rule_id → alert_rules → alert_templates.category`, and
 *     the SAME alert read with a sibling org's id is "not patch work".
 *  3. **Routing is exclusive with a recorded fallback.** With a patch agent
 *     the alert becomes ONE device-less `profile: 'patch'` run with a focus
 *     hint and NO triage run; with no patch agent it becomes a triage run
 *     carrying `patchWorkFallbackReason: 'no_patch_agent'`; with the patch
 *     agent's circuit OPEN it falls back with `patch_agent_circuit_open`
 *     and never admits a patch run — the fallback does not bypass the
 *     circuit.
 *  4. **The verdict lane still mints its own `profile: 'verdict'` run** for
 *     the same alert (untouched by W04).
 *  5. **The next-window projector agrees with `isInMaintenanceWindow` at the
 *     boundary** for a real config-policy window resolved through the real
 *     hierarchy — the one assertion that stops the two implementations
 *     drifting.
 *  6. **A `reboot_plan` for a device whose policy is `if_required` is refused
 *     and its escalation recorded**, with nothing dispatched.
 *  7. **The scheduled occurrence still admits after five patch runs the
 *     same day** (`maxPatchRunsPerDay` 6), and the seventh is `patch_rate`.
 */
import './setup';

import { vi } from 'vitest';
vi.hoisted(() => {
  process.env.BREEZE_AI_AGENTS_ENABLED = 'true';
});

const { publishEventMock } = vi.hoisted(() => ({
  publishEventMock: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'test-event-id'),
}));
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: publishEventMock };
});

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { AI_AGENT_LIMIT_DEFAULTS, PATCH_ALERT_CATEGORY, type PatchPlanOutcome } from '@breeze/shared';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { db, withSystemDbAccessContext } from '../../db';
import {
  aiAgentCircuitState, aiAgents, aiAgentRuns, alertRules, alerts, alertTemplates,
  configPolicyAssignments, configPolicyFeatureLinks, configPolicyMaintenanceSettings, configPolicyPatchSettings,
  configurationPolicies, deviceCommands, devices, patches, patchJobs, patchPolicies,
} from '../../db/schema';
import { __testOnly } from '../../services/automationRuntime';
import { buildAgentAuthContext } from '../../services/aiAgents/agentAuthContext';
import { classifyAlertAsPatchWork, resolveAlertCategory } from '../../services/aiAgents/patchWorkClassifier';
import { loadPatchEvidence, patchEvidenceRefs } from '../../services/aiAgents/patchEvidence';
import { persistPatchPlan } from '../../services/aiAgents/patchPlan';
import { createAndEnqueueAgentRun, registerAgentRunEnqueuer, type AgentRunEnqueuer } from '../../services/aiAgents/runService';
import { enqueueVerdictRunForAlert } from '../../services/aiAgents/alertVerdictSubscriber';
import { finalizePatchJobDevice } from '../../services/patchJobFinalizer';
import { checkDeviceMaintenanceWindow } from '../../services/featureConfigResolver';
import { resolveNextMaintenanceWindow } from '../../services/maintenanceWindowProjection';

const runDb = it.runIf(!!process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

async function insertDevice(orgId: string, siteId: string, over: { pendingReboot?: boolean } = {}) {
  const unique = randomUUID().slice(0, 8);
  const [device] = await withSystemDbAccessContext(() => db
    .insert(devices)
    .values({
      orgId, siteId, agentId: `w04-agent-${unique}`, hostname: `w04-host-${unique}`, osType: 'windows', osVersion: '10',
      architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online', lastSeenAt: new Date(),
      pendingReboot: over.pendingReboot ?? false, uptimeSeconds: 10 * 86400,
    })
    .returning());
  return device!;
}

async function insertPatch() {
  const unique = randomUUID().slice(0, 8);
  const [patch] = await withSystemDbAccessContext(() => db
    .insert(patches)
    .values({
      source: 'microsoft', externalId: `KB-${unique}`, vendor: 'Microsoft', title: `Security update ${unique}`,
      severity: 'critical', requiresReboot: true, releaseDate: '2026-01-01',
    })
    .returning());
  return patch!;
}

async function insertJob(orgId: string) {
  const [job] = await withSystemDbAccessContext(() => db
    .insert(patchJobs)
    .values({ orgId, name: `W04 job ${randomUUID().slice(0, 8)}`, status: 'running', devicesTotal: 1, devicesPending: 1 })
    .returning({ id: patchJobs.id }));
  return job!.id;
}

function effectivePolicyFields(over: Partial<{ triggers: Record<string, unknown> }> = {}) {
  return {
    enabled: true,
    mode: 'shadow' as const,
    model: null,
    toolAllowlist: ['manage_patches:install'],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: {},
    triggers: over.triggers ?? {},
    recipients: { userIds: [], roleIds: [] },
    instructions: null,
    cooldownSeconds: 900,
  };
}

interface Fixture {
  partnerId: string; orgId: string; siteId: string; deviceId: string; patchId: string; creatorId: string;
}

async function seedFixture(): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const device = await insertDevice(org.id, site.id);
  const patch = await insertPatch();
  const creator = await createUser({ partnerId: partner.id, orgId: org.id, email: `creator-${randomUUID()}@w04.test` });
  return { partnerId: partner.id, orgId: org.id, siteId: site.id, deviceId: device.id, patchId: patch.id, creatorId: creator.id };
}

async function insertAgent(f: Fixture, kind: 'patch' | 'triage', over: { triggers?: Record<string, unknown> } = {}) {
  const [agent] = await withSystemDbAccessContext(() => db
    .insert(aiAgents)
    .values({
      partnerId: f.partnerId, orgId: null, kind, name: `${kind} agent`,
      ...effectivePolicyFields({ triggers: over.triggers }), createdBy: f.creatorId,
    })
    .returning({ id: aiAgents.id }));
  return agent!.id;
}

/** Drive the real finalizer with an agent-reported failure for ONE device (under the system context every production door holds). */
async function failPatchJob(f: Fixture, jobId: string) {
  return withSystemDbAccessContext(() => finalizePatchJobDevice({
    patchJobId: jobId,
    deviceId: f.deviceId,
    commandId: randomUUID(),
    terminal: { kind: 'result', commandResult: { status: 'failed', exitCode: 1, stdout: '', stderr: '0x80070070 not enough space' } },
    completedAt: new Date(),
    source: {
      kind: 'synchronous',
      context: { orgId: f.orgId, rebootPolicy: 'never', approvedPatches: [{ patchId: f.patchId, externalId: null, requiresReboot: false }] },
    },
  }));
}

async function alertsForDevice(deviceId: string) {
  return withSystemDbAccessContext(() => db
    .select({ id: alerts.id, ruleId: alerts.ruleId, severity: alerts.severity, orgId: alerts.orgId, status: alerts.status })
    .from(alerts)
    .where(eq(alerts.deviceId, deviceId)));
}

async function raisePatchAlert(f: Fixture): Promise<{ alertId: string; ruleId: string }> {
  const jobId = await insertJob(f.orgId);
  await failPatchJob(f, jobId);
  const rows = await alertsForDevice(f.deviceId);
  const alert = rows[0];
  if (!alert || !alert.ruleId) throw new Error('fixture: no patch alert was raised');
  return { alertId: alert.id, ruleId: alert.ruleId };
}

function triageActionContext(f: Fixture, alertId: string, ruleId: string, managedByAgentId: string) {
  return {
    automation: { id: randomUUID(), orgId: f.orgId, name: 'Alert triage', createdBy: f.creatorId, managedByAgentId },
    runId: randomUUID(),
    trigger: { alertId, eventId: randomUUID(), severity: 'high' as const, ruleId },
    device: {
      id: f.deviceId, orgId: f.orgId, hostname: 'w04', displayName: null, osType: 'windows' as const, status: 'online' as const,
      agentId: 'agent', siteId: f.siteId, customFields: {},
    },
    scriptsById: new Map(),
    channelsById: new Map(),
    variableScope: { orgIds: new Set([f.orgId]) },
  } as unknown as Parameters<typeof __testOnly.executeAiTriageAction>[2];
}

/** The worker runs every action inside a system context (`withAutomationRuntimeDb`); mirror that. */
async function triage(f: Fixture, alertId: string, ruleId: string, managedByAgentId: string) {
  return withSystemDbAccessContext(() =>
    __testOnly.executeAiTriageAction({ type: 'ai_triage' }, 0, triageActionContext(f, alertId, ruleId, managedByAgentId)));
}

async function runsForAlert(alertId: string) {
  return withSystemDbAccessContext(() => db
    .select({
      id: aiAgentRuns.id, agentId: aiAgentRuns.agentId, profile: aiAgentRuns.profile, deviceId: aiAgentRuns.deviceId,
      triggerRef: aiAgentRuns.triggerRef, dedupeKey: aiAgentRuns.dedupeKey, status: aiAgentRuns.status,
    })
    .from(aiAgentRuns)
    .where(eq(aiAgentRuns.alertId, alertId)));
}

let enqueued: string[] = [];
beforeEach(() => {
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  publishEventMock.mockClear();
  enqueued = [];
  const enqueuer: AgentRunEnqueuer = async (runId) => {
    enqueued.push(runId);
    return { enqueued: true, jobId: `agent-run-${runId}` };
  };
  registerAgentRunEnqueuer(enqueuer);
});
afterEach(() => {
  registerAgentRunEnqueuer(null);
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// 1 + 2: the alert source and the classifier
// ---------------------------------------------------------------------------

describe('patch job failure → patch-categorised alert', () => {
  runDb('a failing patch job raises exactly one alert whose template carries the patch category; the same job does not raise a second', async () => {
    const f = await seedFixture();
    const jobId = await insertJob(f.orgId);
    const first = await failPatchJob(f, jobId);
    expect(first.applied).toBe(true);

    const rows = await alertsForDevice(f.deviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orgId: f.orgId, severity: 'high', status: 'active' });

    const [joined] = await withSystemDbAccessContext(() => db
      .select({ category: alertTemplates.category, templateOrg: alertTemplates.orgId, isBuiltIn: alertTemplates.isBuiltIn, ruleOrg: alertRules.orgId })
      .from(alertRules)
      .innerJoin(alertTemplates, eq(alertTemplates.id, alertRules.templateId))
      .where(eq(alertRules.id, rows[0]!.ruleId!)));
    expect(joined).toEqual({ category: PATCH_ALERT_CATEGORY, templateOrg: null, isBuiltIn: true, ruleOrg: f.orgId });

    // The second door is fenced by the terminal rows: no second alert.
    const second = await failPatchJob(f, jobId);
    expect(second.applied).toBe(false);
    expect(await alertsForDevice(f.deviceId)).toHaveLength(1);
  });

  runDb('the classifier resolves the category through the rule join, and a cross-tenant read fails closed', async () => {
    const f = await seedFixture();
    const { alertId } = await raisePatchAlert(f);
    await expect(withSystemDbAccessContext(() => classifyAlertAsPatchWork(alertId, f.orgId))).resolves.toBe(true);
    await expect(withSystemDbAccessContext(() => resolveAlertCategory(alertId, f.orgId))).resolves.toMatchObject({
      category: PATCH_ALERT_CATEGORY, isPatchWork: true,
    });

    const sibling = await createOrganization({ partnerId: f.partnerId });
    await expect(withSystemDbAccessContext(() => classifyAlertAsPatchWork(alertId, sibling.id))).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3 + 4: exclusive routing, recorded fallback, the verdict lane
// ---------------------------------------------------------------------------

describe('reactive routing', () => {
  runDb('routes the alert to the patch agent as ONE device-less run with a focus hint, and admits NO triage run', async () => {
    const f = await seedFixture();
    const patchAgentId = await insertAgent(f, 'patch');
    const triageAgentId = await insertAgent(f, 'triage');
    const { alertId, ruleId } = await raisePatchAlert(f);

    const result = await triage(f, alertId, ruleId, triageAgentId);
    expect(result.outcome.status).toBe('queued');

    const runs = await runsForAlert(alertId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      agentId: patchAgentId, profile: 'patch', deviceId: null, dedupeKey: `patch-alert:${alertId}`, status: 'queued',
    });
    expect(runs[0]!.triggerRef).toMatchObject({ focusDeviceId: f.deviceId, routedFrom: 'triage', alertRuleId: ruleId });
    expect(enqueued).toEqual([runs[0]!.id]);
  });

  runDb('with no patch agent, routes to triage and records patchWorkFallbackReason on the run', async () => {
    const f = await seedFixture();
    const triageAgentId = await insertAgent(f, 'triage');
    const { alertId, ruleId } = await raisePatchAlert(f);

    await triage(f, alertId, ruleId, triageAgentId);

    const runs = await runsForAlert(alertId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agentId: triageAgentId, profile: 'full', deviceId: f.deviceId, dedupeKey: `alert:${alertId}` });
    expect(runs[0]!.triggerRef).toMatchObject({ patchWorkFallbackReason: 'no_patch_agent' });
  });

  runDb('with the patch agent circuit OPEN, falls back to triage and never admits a patch run', async () => {
    const f = await seedFixture();
    const patchAgentId = await insertAgent(f, 'patch');
    const triageAgentId = await insertAgent(f, 'triage');
    await withSystemDbAccessContext(() => db.insert(aiAgentCircuitState).values({
      orgId: f.orgId, agentId: patchAgentId, partnerId: f.partnerId, consecutiveFailures: 3, state: 'open',
      openedAt: new Date(), openedReason: 'w04 test',
    }));
    const { alertId, ruleId } = await raisePatchAlert(f);

    await triage(f, alertId, ruleId, triageAgentId);

    const runs = await runsForAlert(alertId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agentId: triageAgentId, deviceId: f.deviceId });
    expect(runs[0]!.triggerRef).toMatchObject({ patchWorkFallbackReason: 'patch_agent_circuit_open' });
    expect(runs.some((r) => r.profile === 'patch')).toBe(false);
  });

  runDb('a non-patch alert stays on triage with not_patch_work recorded', async () => {
    const f = await seedFixture();
    await insertAgent(f, 'patch');
    const triageAgentId = await insertAgent(f, 'triage');
    // A plain rule-less alert: neither join leg resolves → fail closed.
    const [alert] = await withSystemDbAccessContext(() => db
      .insert(alerts)
      .values({ ruleId: null, deviceId: f.deviceId, orgId: f.orgId, severity: 'high', title: 'Disk full', message: null, status: 'active' })
      .returning({ id: alerts.id }));

    await triage(f, alert!.id, randomUUID(), triageAgentId);

    const runs = await runsForAlert(alert!.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agentId: triageAgentId, deviceId: f.deviceId });
    expect(runs[0]!.triggerRef).toMatchObject({ patchWorkFallbackReason: 'not_patch_work' });
  });

  runDb('the verdict lane still mints its own profile: verdict run for the same alert', async () => {
    const f = await seedFixture();
    const patchAgentId = await insertAgent(f, 'patch');
    const triageAgentId = await insertAgent(f, 'triage');
    const { alertId, ruleId } = await raisePatchAlert(f);

    await triage(f, alertId, ruleId, triageAgentId);
    await enqueueVerdictRunForAlert(f.orgId, alertId, 'ungrouped');

    const runs = await runsForAlert(alertId);
    expect(runs.map((r) => [r.agentId, r.profile]).sort()).toEqual([[patchAgentId, 'patch'], [triageAgentId, 'verdict']].sort());
  });
});

// ---------------------------------------------------------------------------
// 5: the projector agrees with isInMaintenanceWindow at the boundary
// ---------------------------------------------------------------------------

async function seedMaintenancePolicy(f: Fixture, over: Partial<typeof configPolicyMaintenanceSettings.$inferInsert> = {}) {
  return withSystemDbAccessContext(async () => {
    const [policy] = await db
      .insert(configurationPolicies)
      .values({ orgId: f.orgId, partnerId: null, name: 'W04 maintenance', status: 'active' })
      .returning({ id: configurationPolicies.id });
    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policy!.id, featureType: 'maintenance', featurePolicyId: null, inlineSettings: {} })
      .returning({ id: configPolicyFeatureLinks.id });
    const [settings] = await db
      .insert(configPolicyMaintenanceSettings)
      .values({
        featureLinkId: link!.id, recurrence: 'daily', durationHours: 2, timezone: 'America/New_York', windowStart: '02:30',
        rebootIfPending: true, ...over,
      })
      .returning({ id: configPolicyMaintenanceSettings.id });
    await db.insert(configPolicyAssignments).values({ configPolicyId: policy!.id, level: 'organization', targetId: f.orgId, priority: 0 });
    return settings!.id;
  });
}

async function seedPatchPolicy(f: Fixture, rebootPolicy: string) {
  return withSystemDbAccessContext(async () => {
    const [ring] = await db
      .insert(patchPolicies)
      .values({ partnerId: f.partnerId, kind: 'ring', name: `W04 ring ${randomUUID().slice(0, 8)}`, deferralDays: 0, autoApprove: { enabled: false, severities: [] }, categoryRules: [] })
      .returning({ id: patchPolicies.id });
    const [policy] = await db
      .insert(configurationPolicies)
      .values({ orgId: f.orgId, partnerId: null, name: 'W04 patch policy', status: 'active' })
      .returning({ id: configurationPolicies.id });
    const [link] = await db
      .insert(configPolicyFeatureLinks)
      .values({ configPolicyId: policy!.id, featureType: 'patch', featurePolicyId: ring!.id, inlineSettings: {} })
      .returning({ id: configPolicyFeatureLinks.id });
    await db.insert(configPolicyPatchSettings).values({ featureLinkId: link!.id, sources: ['os'], rebootPolicy });
    await db.insert(configPolicyAssignments).values({ configPolicyId: policy!.id, level: 'organization', targetId: f.orgId, priority: 0 });
  });
}

describe('next-window projector', () => {
  runDb('agrees with isInMaintenanceWindow at both boundaries for a real config-policy window (DST gap night included)', async () => {
    const f = await seedFixture();
    const settingsId = await seedMaintenancePolicy(f);

    for (const from of [new Date(), new Date('2026-03-08T00:00:00Z'), new Date('2026-11-01T00:00:00Z')]) {
      const window = await withSystemDbAccessContext(() => resolveNextMaintenanceWindow(f.deviceId, f.orgId, from));
      expect(window, from.toISOString()).not.toBeNull();
      expect(window!.windowId).toBe(`${settingsId}@${window!.startsAt.toISOString()}`);
      expect(window!.source).toBe('config_policy');
      expect(window!.rebootIfPending).toBe(true);

      const at = async (t: Date) => (await withSystemDbAccessContext(() => checkDeviceMaintenanceWindow(f.deviceId, t))).active;
      expect(await at(new Date(window!.startsAt.getTime() - 1000)), `before ${from.toISOString()}`).toBe(false);
      expect(await at(window!.startsAt), `start ${from.toISOString()}`).toBe(true);
      expect(await at(new Date(window!.endsAt.getTime() - 1000)), `inside ${from.toISOString()}`).toBe(true);
      expect(await at(window!.endsAt), `end ${from.toISOString()}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 6: reboot_plan refused for a non-window-gated policy, escalation recorded
// ---------------------------------------------------------------------------

describe('reboot planning', () => {
  runDb('a reboot_plan for a device whose policy is if_required is refused; its escalation is recorded; nothing is dispatched', async () => {
    const f = await seedFixture();
    await withSystemDbAccessContext(() => db.update(devices).set({ pendingReboot: true, tags: ['role:dc'] }).where(eq(devices.id, f.deviceId)));
    await seedMaintenancePolicy(f);
    await seedPatchPolicy(f, 'if_required');
    const patchAgentId = await insertAgent(f, 'patch');

    const evidence = await withSystemDbAccessContext(() => loadPatchEvidence(f.orgId, f.partnerId));
    const row = evidence.sections.rebootBacklog.rows.find((r) => r.deviceId === f.deviceId);
    expect(row).toBeDefined();
    expect(typeof row!.fields.nextWindowId).toBe('string');
    expect(row!.fields).toMatchObject({ rebootPolicy: 'if_required', redundancyGroup: 'dc', unplannableReason: 'reboot_policy_not_window_gated' });
    const refs = patchEvidenceRefs(evidence);
    expect(refs.windowIds.has(row!.fields.nextWindowId as string)).toBe(true);

    const [run] = await withSystemDbAccessContext(() => db
      .insert(aiAgentRuns)
      .values({
        agentId: patchAgentId, orgId: f.orgId, deviceId: null, profile: 'patch', scheduleId: null, triggerKind: 'manual',
        triggerRef: { kind: 'patch' }, dedupeKey: `w04-${randomUUID()}`, modeAtStart: 'shadow',
        policySnapshot: { schemaVersion: 1, agentId: patchAgentId, kind: 'patch', effective: effectivePolicyFields(), resolvedAt: new Date().toISOString() } as never,
        status: 'running',
      })
      .returning({ id: aiAgentRuns.id }));
    const plan: PatchPlanOutcome = {
      schemaVersion: 1, summary: 'Plan', posture: { compliancePct: 50, devicesAtRisk: 1, oldestOutstandingDays: null },
      items: [
        { class: 'reboot_plan', severity: 'medium', deviceId: f.deviceId, windowId: row!.fields.nextWindowId as string, title: 'Reboot DC-01', detail: 'd', evidenceRef: 'rebootBacklog:0' },
        { class: 'escalation', severity: 'medium', deviceId: f.deviceId, title: 'DC-01 reboots outside windows', detail: 'd', evidenceRef: 'rebootBacklog:0' },
      ],
      dispositions: [], evidenceTruncated: false, generatedAt: new Date().toISOString(),
    };
    const auth = buildAgentAuthContext(
      { id: patchAgentId, orgId: null, partnerId: f.partnerId, name: 'Patch Agent', kind: 'patch' },
      { id: run!.id, orgId: f.orgId, deviceId: null, deviceSiteId: null },
      { id: f.orgId, partnerId: f.partnerId },
    );
    const { dispositions, intentIds } = await persistPatchPlan(
      { id: run!.id, orgId: f.orgId, agentId: patchAgentId, scheduleId: null, toolAllowlist: ['manage_patches:install'], maxActionsPerRun: 5 },
      plan, refs, auth,
    );
    expect(dispositions.map((d) => [d.disposition, d.reason ?? null])).toEqual([
      ['refused', 'reboot_policy_not_window_gated'], ['recorded', null],
    ]);
    expect(intentIds).toEqual([]);

    const commands = await withSystemDbAccessContext(() => db.select({ id: deviceCommands.id }).from(deviceCommands).where(eq(deviceCommands.deviceId, f.deviceId)));
    expect(commands).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7: reactive runs cannot starve the scheduled occurrence
// ---------------------------------------------------------------------------

describe('capacity', () => {
  runDb('the scheduled occurrence still admits after five patch runs the same day; the seventh is patch_rate', async () => {
    expect(AI_AGENT_LIMIT_DEFAULTS.maxPatchRunsPerDay).toBe(6);
    const f = await seedFixture();
    await insertAgent(f, 'patch');
    for (let i = 0; i < 5; i += 1) {
      const result = await createAndEnqueueAgentRun({
        orgId: f.orgId, kind: 'patch', profile: 'patch', triggerKind: 'alert', deviceId: null, alertId: null,
        triggerRef: { routedFrom: 'triage' }, dedupeKey: `w04-reactive-${i}-${randomUUID()}`,
      });
      expect(result, `reactive ${i}`).toMatchObject({ created: true });
      // Terminalise so the concurrency cap does not mask the daily cap.
      await withSystemDbAccessContext(() => db.update(aiAgentRuns).set({ status: 'completed' }).where(eq(aiAgentRuns.id, (result as { run: { id: string } }).run.id)));
    }
    const scheduled = await createAndEnqueueAgentRun({
      orgId: f.orgId, kind: 'patch', profile: 'patch', triggerKind: 'schedule', deviceId: null,
      triggerRef: { kind: 'patch', occurrenceKey: 'nightly' }, dedupeKey: `w04-sched-${randomUUID()}`,
    });
    expect(scheduled).toMatchObject({ created: true });
    await withSystemDbAccessContext(() => db.update(aiAgentRuns).set({ status: 'completed' }).where(eq(aiAgentRuns.id, (scheduled as { run: { id: string } }).run.id)));

    const seventh = await createAndEnqueueAgentRun({
      orgId: f.orgId, kind: 'patch', profile: 'patch', triggerKind: 'alert', deviceId: null,
      triggerRef: { routedFrom: 'triage' }, dedupeKey: `w04-reactive-7-${randomUUID()}`,
    });
    expect(seventh).toEqual({ created: false, skipped: 'patch_rate' });

    const count = await withSystemDbAccessContext(() => db.select({ id: aiAgentRuns.id }).from(aiAgentRuns)
      .where(and(eq(aiAgentRuns.orgId, f.orgId), eq(aiAgentRuns.profile, 'patch'))));
    expect(count).toHaveLength(6);
  });
});
