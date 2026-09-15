/**
 * Live-Postgres contract for #4442 W04 — the partner ∩ org op-key ceiling, and
 * the auto-halt, ON THE SWEEP ACT PATH.
 *
 * This file exists because the constraint it pins needs NO new code:
 * `mergeAgentPolicies` already intersects `actAssets.supervisedActionKeys`
 * (`effectivePolicy.ts`, `intersectToolRefs`) and an org with no row of its own
 * already resolves to `[]` ("partner keys are a CEILING, never an inherited
 * GRANT", C3). What has never been asserted is that those properties still hold
 * for an intent minted by a SWEEP — a device-scoped proposal from a device-less
 * run, which is exactly the path W04 opens to unattended execution.
 *
 * Cases 1-3 must pass on the merge alone. If one of them fails, the
 * intersection is not holding on this path and that is a tenancy finding, not a
 * test bug.
 *
 * Lives under `src/__tests__/integration/`, so `vitest.integration.config.ts`'s
 * wholesale include covers it and the unit runner's identical exclude drops it.
 * A file placed anywhere else runs in ZERO CI jobs.
 */
import './setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { sweepTriggerKey } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../../db';
import { getTestDb } from './setup';
import {
  actionIntents,
  aiAgentRuns,
  aiAgentSchedules,
  aiAgents,
  aiUnattendedExposure,
  devices,
  serviceProcessCheckResults,
} from '../../db/schema';
import { buildAgentAuthContext } from '../../services/aiAgents/agentAuthContext';
import { createActionIntent } from '../../services/actionIntents/intentService';
import { attemptPolicyDecision } from '../../services/actionIntents/policyDecide';
import { demoteSupervisedKey } from '../../services/aiAgents/supervisedKeyDemote';
import {
  checkSweepScheduleBrake,
  resolveEffectiveScheduleActMode,
} from '../../services/aiAgents/sweepActMode';
import {
  createOrganization,
  createPartner,
  createSite,
  createUser,
} from './db-utils';

const TOOL_NAME = 'manage_services';
const SERVICE_NAME = 'MSSQLSERVER';
const OP_KEY = 'manage_services:restart';
/** A registered POLICY_DECIDABLE_TIER3 key that is NOT the one under test. */
const OTHER_OP_KEY = 'manage_startup_items:disable';

function effectivePolicyFields(supervisedActionKeys: string[]) {
  return {
    enabled: true,
    // Policy-decide requires mode 'act' — this is the lane's own precondition,
    // not something this file is testing.
    mode: 'act' as const,
    model: null,
    toolAllowlist: [TOOL_NAME],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    // The fleet blast cap is a percentage of the org's contract devices; the
    // fixture org has ONE device, so the 5% default would refuse the single
    // authorization this file is about. Widened deliberately — the cap has its
    // own tests (`exposureBudget.ts`), and refusing here would mask the gate
    // actually under test.
    limits: { maxFleetPercentPerDay: 100, maxPolicyDecisionsPerDay: 50 },
    triggers: {},
    recipients: { userIds: [], roleIds: [] },
    actAssets: { scriptIds: [], supervisedActionKeys },
    instructions: null,
    cooldownSeconds: 900,
  };
}

interface Scenario {
  partnerId: string;
  orgId: string;
  siteId: string;
  deviceId: string;
  /** The PARTNER baseline agent — the effective agent id everything keys on. */
  agentId: string;
  scheduleId: string;
  creatorId: string;
}

/**
 * @param partnerKeys keys on the PARTNER baseline (the ceiling)
 * @param orgKeys     keys on the ORG row (the grant), or `null` for NO org row
 */
async function seedScenario(
  partnerKeys: string[],
  orgKeys: string[] | null,
  opts: { actMode?: boolean | null } = {},
): Promise<Scenario> {
  const adminDb = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const creator = await createUser({
    partnerId: partner.id, orgId: org.id, email: `creator-${randomUUID()}@sweepact.test`,
  });

  const unique = randomUUID().slice(0, 8);
  const [device] = await adminDb
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: `sweepact-agent-${unique}`,
      hostname: `sweepact-host-${unique}`,
      osType: 'windows',
      osVersion: '2022',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
    })
    .returning({ id: devices.id });

  const [partnerAgent] = await withSystemDbAccessContext(() => db
    .insert(aiAgents)
    .values({
      partnerId: partner.id,
      orgId: null,
      kind: 'triage',
      name: 'Sweep Act',
      ...effectivePolicyFields(partnerKeys),
      createdBy: creator.id,
    })
    .returning({ id: aiAgents.id }));

  if (orgKeys !== null) {
    await withSystemDbAccessContext(() => db
      .insert(aiAgents)
      .values({
        partnerId: null,
        orgId: org.id,
        kind: 'triage',
        name: 'Sweep Act (org)',
        ...effectivePolicyFields(orgKeys),
        createdBy: creator.id,
      }));
  }

  const [schedule] = await withSystemDbAccessContext(() => db
    .insert(aiAgentSchedules)
    .values({
      orgId: null,
      partnerId: partner.id,
      agentId: partnerAgent!.id,
      baselineScheduleId: null,
      kind: 'sweep',
      cron: '0 * * * *',
      timezone: 'UTC',
      sweepKinds: ['service_down'],
      enabled: true,
      actMode: opts.actMode === undefined ? true : opts.actMode,
      createdBy: creator.id,
    })
    .returning({ id: aiAgentSchedules.id }));

  return {
    partnerId: partner.id,
    orgId: org.id,
    siteId: site.id,
    deviceId: device!.id,
    agentId: partnerAgent!.id,
    scheduleId: schedule!.id,
    creatorId: creator.id,
  };
}

/** The live observation `probeSweepSubject` re-reads at decide time. */
async function seedServiceDownObservation(
  s: Scenario,
  status: 'running' | 'stopped' | 'not_found' | 'error' = 'stopped',
): Promise<void> {
  await withSystemDbAccessContext(() => db
    .insert(serviceProcessCheckResults)
    .values({
      orgId: s.orgId,
      deviceId: s.deviceId,
      watchType: 'service',
      name: SERVICE_NAME,
      status,
      timestamp: new Date(),
    }));
}

/** A sweep run: device-LESS, alert-LESS, carrying the baseline schedule id. */
async function seedSweepRun(s: Scenario, supervisedActionKeys: string[]): Promise<string> {
  const [run] = await withSystemDbAccessContext(() => db
    .insert(aiAgentRuns)
    .values({
      agentId: s.agentId,
      orgId: s.orgId,
      deviceId: null,
      alertId: null,
      profile: 'sweep',
      triggerKind: 'schedule',
      scheduleId: s.scheduleId,
      dedupeKey: `sweep-act-${randomUUID()}`,
      modeAtStart: 'act',
      policySnapshot: {
        schemaVersion: 1,
        agentId: s.agentId,
        kind: 'triage',
        effective: effectivePolicyFields(supervisedActionKeys),
        resolvedAt: new Date().toISOString(),
      } as never,
    })
    .returning({ id: aiAgentRuns.id }));
  return run!.id;
}

/** Mint the device-scoped, sweep-triggered intent exactly as `persistSweepFindings` does. */
async function mintSweepIntent(
  s: Scenario,
  runId: string,
  opts: { scheduleActMode?: boolean; argumentsMatchSubject?: boolean } = {},
): Promise<string> {
  const auth = buildAgentAuthContext(
    { id: s.agentId, orgId: null, partnerId: s.partnerId, name: 'Sweep Act', kind: 'triage' },
    { id: runId, orgId: s.orgId, deviceId: null, deviceSiteId: null },
    { id: s.orgId, partnerId: s.partnerId },
  );
  const snapshot = await createActionIntent(auth, {
    trigger: {
      kind: 'sweep_finding',
      refId: runId,
      key: sweepTriggerKey('service_down', SERVICE_NAME),
    },
    toolName: TOOL_NAME,
    input: { deviceId: s.deviceId, action: 'restart', serviceName: SERVICE_NAME },
    source: 'ai_agent',
    orgId: s.orgId,
    scope: { deviceId: s.deviceId },
    sweepAct: {
      scheduleActMode: opts.scheduleActMode ?? true,
      subject: { kind: 'service_down', key: SERVICE_NAME, observedAt: new Date().toISOString() },
      argumentsMatchSubject: opts.argumentsMatchSubject ?? true,
    },
  });
  return snapshot.id;
}

async function intentDecision(intentId: string) {
  const [row] = await withSystemDbAccessContext(() => db
    .select({
      status: actionIntents.status,
      policyDecisionState: actionIntents.policyDecisionState,
      decidedVia: actionIntents.decidedVia,
    })
    .from(actionIntents)
    .where(eq(actionIntents.id, intentId))
    .limit(1));
  return row!;
}

async function exposureRowsFor(intentId: string): Promise<number> {
  const rows = await withSystemDbAccessContext(() => db
    .select({ id: aiUnattendedExposure.id })
    .from(aiUnattendedExposure)
    .where(eq(aiUnattendedExposure.intentId, intentId)));
  return rows.length;
}

beforeEach(() => {
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  vi.stubEnv('BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED', 'true');
  vi.stubEnv('BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED', 'true');
  return () => vi.unstubAllEnvs();
});

describe('sweep act path — partner ∩ org op-key ceiling', () => {
  it('key in the partner baseline but NOT in the org row -> the sweep intent is never authorized', async () => {
    const s = await seedScenario([OP_KEY], [OTHER_OP_KEY]);
    await seedServiceDownObservation(s);
    const runId = await seedSweepRun(s, [OP_KEY]);
    const intentId = await mintSweepIntent(s, runId);

    await attemptPolicyDecision(intentId);

    const decision = await intentDecision(intentId);
    expect(decision.policyDecisionState).toBe('human_required');
    expect(decision.decidedVia).not.toBe('policy');
    expect(await exposureRowsFor(intentId)).toBe(0);
  });

  it('key in the org row but NOT in the partner baseline -> never authorized (the ceiling holds)', async () => {
    const s = await seedScenario([OTHER_OP_KEY], [OP_KEY]);
    await seedServiceDownObservation(s);
    const runId = await seedSweepRun(s, [OP_KEY]);
    const intentId = await mintSweepIntent(s, runId);

    await attemptPolicyDecision(intentId);

    expect((await intentDecision(intentId)).policyDecisionState).toBe('human_required');
    expect(await exposureRowsFor(intentId)).toBe(0);
  });

  it('NO org row at all, key in the partner baseline -> never authorized (the effective set is [])', async () => {
    const s = await seedScenario([OP_KEY], null);
    await seedServiceDownObservation(s);
    const runId = await seedSweepRun(s, [OP_KEY]);
    const intentId = await mintSweepIntent(s, runId);

    await attemptPolicyDecision(intentId);

    expect((await intentDecision(intentId)).policyDecisionState).toBe('human_required');
    expect(await exposureRowsFor(intentId)).toBe(0);
  });

  it('key in BOTH -> the sweep intent authorizes, and exactly one exposure row is written', async () => {
    const s = await seedScenario([OP_KEY], [OP_KEY]);
    await seedServiceDownObservation(s);
    const runId = await seedSweepRun(s, [OP_KEY]);
    const intentId = await mintSweepIntent(s, runId);

    await attemptPolicyDecision(intentId);

    const decision = await intentDecision(intentId);
    expect(decision.policyDecisionState).toBe('authorized');
    expect(decision.decidedVia).toBe('policy');
    expect(decision.status).toBe('approved');
    expect(await exposureRowsFor(intentId)).toBe(1);
  });
});

describe('sweep act path — the gates that are specific to this wave', () => {
  it('a DISARMED schedule keeps the intent human_required even with the key in both rows', async () => {
    const s = await seedScenario([OP_KEY], [OP_KEY], { actMode: false });
    await seedServiceDownObservation(s);
    const runId = await seedSweepRun(s, [OP_KEY]);
    // What `persistSweepFindings` would compute for a disarmed schedule.
    const intentId = await mintSweepIntent(s, runId, { scheduleActMode: false });

    await attemptPolicyDecision(intentId);

    expect((await intentDecision(intentId)).policyDecisionState).toBe('human_required');
    expect(await exposureRowsFor(intentId)).toBe(0);
  });

  it('a condition that has CLEARED since the sweep degrades to human_required and writes no exposure row', async () => {
    const s = await seedScenario([OP_KEY], [OP_KEY]);
    // The live re-probe sees the service running again.
    await seedServiceDownObservation(s, 'running');
    const runId = await seedSweepRun(s, [OP_KEY]);
    const intentId = await mintSweepIntent(s, runId);

    await attemptPolicyDecision(intentId);

    expect((await intentDecision(intentId)).policyDecisionState).toBe('human_required');
    expect(await exposureRowsFor(intentId)).toBe(0);
  });

  it('an UNKNOWN condition (no fresh observation at all) fails closed', async () => {
    const s = await seedScenario([OP_KEY], [OP_KEY]);
    // No service_process_check_results row: the probe cannot answer.
    const runId = await seedSweepRun(s, [OP_KEY]);
    const intentId = await mintSweepIntent(s, runId);

    await attemptPolicyDecision(intentId);

    expect((await intentDecision(intentId)).policyDecisionState).toBe('human_required');
    expect(await exposureRowsFor(intentId)).toBe(0);
  });
});

// The two act-mode resolvers are the only things standing between "an operator
// turned this off" and an unattended Tier-3 execution, and both are pure DB
// reads. Their unit suite drives a SCRIPTED select queue, which proves the
// branching but not the SQL — a wrong column, a broken join or an RLS surprise
// on `ai_agent_schedules` / `ai_agent_runs` would survive it. These cases run
// them against the real rows the rest of this file seeds.
describe('sweep act path — the schedule resolvers against real Postgres', () => {
  it('resolves ARMED for a partner baseline with no org override', async () => {
    const s = await seedScenario([OP_KEY], [OP_KEY]);

    await expect(resolveEffectiveScheduleActMode(s.scheduleId, s.orgId)).resolves.toBe(true);
  });

  it('an ORG OVERRIDE row disarms the same baseline — the live join, not a mock', async () => {
    const s = await seedScenario([OP_KEY], [OP_KEY]);
    await withSystemDbAccessContext(() => db
      .insert(aiAgentSchedules)
      .values({
        orgId: s.orgId,
        partnerId: null,
        agentId: s.agentId,
        baselineScheduleId: s.scheduleId,
        kind: 'sweep',
        cron: '0 * * * *',
        timezone: 'UTC',
        sweepKinds: ['service_down'],
        enabled: true,
        actMode: false,
        createdBy: s.creatorId,
      }));

    await expect(resolveEffectiveScheduleActMode(s.scheduleId, s.orgId)).resolves.toBe(false);
  });

  it('an UNARMED baseline resolves false, and a deleted one does too', async () => {
    const unarmed = await seedScenario([OP_KEY], [OP_KEY], { actMode: null });
    await expect(resolveEffectiveScheduleActMode(unarmed.scheduleId, unarmed.orgId)).resolves.toBe(false);

    const armed = await seedScenario([OP_KEY], [OP_KEY]);
    await withSystemDbAccessContext(() => db
      .delete(aiAgentSchedules)
      .where(eq(aiAgentSchedules.id, armed.scheduleId)));
    await expect(resolveEffectiveScheduleActMode(armed.scheduleId, armed.orgId)).resolves.toBe(false);
  });

  it('the RELEASE brake resolves a real run to its schedule and releases while armed', async () => {
    const s = await seedScenario([OP_KEY], [OP_KEY]);
    const runId = await seedSweepRun(s, [OP_KEY]);

    await expect(checkSweepScheduleBrake({ requestingAgentRunId: runId, orgId: s.orgId }))
      .resolves.toEqual({ ok: true });
  });

  it('the RELEASE brake refuses once the partner turns act mode off between decide and release', async () => {
    const s = await seedScenario([OP_KEY], [OP_KEY]);
    const runId = await seedSweepRun(s, [OP_KEY]);
    await withSystemDbAccessContext(() => db
      .update(aiAgentSchedules)
      .set({ actMode: false })
      .where(eq(aiAgentSchedules.id, s.scheduleId)));

    await expect(checkSweepScheduleBrake({ requestingAgentRunId: runId, orgId: s.orgId }))
      .resolves.toMatchObject({ ok: false });
  });

  it('the RELEASE brake refuses a run that belongs to a DIFFERENT org', async () => {
    const s = await seedScenario([OP_KEY], [OP_KEY]);
    const other = await seedScenario([OP_KEY], [OP_KEY]);
    const runId = await seedSweepRun(s, [OP_KEY]);

    await expect(checkSweepScheduleBrake({ requestingAgentRunId: runId, orgId: other.orgId }))
      .resolves.toMatchObject({ ok: false });
  });
});

describe('sweep act path — the auto-halt', () => {
  it('a demotion revokes the org key, and the NEXT sweep occurrence produces a human card instead of an authorization', async () => {
    const s = await seedScenario([OP_KEY], [OP_KEY]);
    await seedServiceDownObservation(s);

    // First occurrence: the key is live in both rows, so it authorizes.
    const firstRun = await seedSweepRun(s, [OP_KEY]);
    const firstIntent = await mintSweepIntent(s, firstRun);
    await attemptPolicyDecision(firstIntent);
    expect((await intentDecision(firstIntent)).policyDecisionState).toBe('authorized');

    // P2-5's auto-demote on a terminal failure: the key leaves the ORG row.
    // The PARTNER ceiling is deliberately untouched — narrowing it is a
    // partner-level decision no single org's signal may make.
    const demotion = await demoteSupervisedKey({
      orgId: s.orgId,
      agentId: s.agentId,
      opKey: OP_KEY,
      reason: 'attempted_failure',
      runId: firstRun,
      watchId: null,
      intentId: firstIntent,
    });
    expect(demotion.revoked).toBe(true);

    // Second occurrence, same org, same subject: a pending human card.
    await seedServiceDownObservation(s);
    const secondRun = await seedSweepRun(s, [OP_KEY]);
    const secondIntent = await mintSweepIntent(s, secondRun);
    await attemptPolicyDecision(secondIntent);

    const decision = await intentDecision(secondIntent);
    expect(decision.policyDecisionState).toBe('human_required');
    // It went down the HUMAN path, which is the contract. This fixture seeds
    // no user holding `devices:execute`, so that human path immediately
    // cancels for want of an approver (`createActionIntent` commits then
    // cancels — P2-1) — what matters is that it was never authorized and
    // reserved no unattended exposure.
    expect(decision.decidedVia).not.toBe('policy');
    expect(decision.status).not.toBe('approved');
    expect(await exposureRowsFor(secondIntent)).toBe(0);
  });
});
