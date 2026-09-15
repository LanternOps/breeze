/**
 * Live-Postgres control for #5751 W02 (#5753) — sweep-condition fix watches.
 *
 * The defect this file exists to pin: `watchReleasedIntent`
 * (`jobs/intentReleaseWorker.ts`) grades a released intent three ways, and its
 * middle branch — "no watch is POSSIBLE (the run has no triggering alert) ->
 * credit `verified` on the same source id" — fires for EVERY sweep-minted
 * intent, because a sweep run is `trigger_kind: 'schedule'` with
 * `alert_id IS NULL` and `createIntentFixWatchRow` requires a non-null alert.
 * P2-5's graduation ladder therefore counted an unverified click as a
 * verification for the whole sweep lane (spec §1.1).
 *
 * The three cases below discriminate rather than merely assert an absence:
 *  1. a sweep-minted intent must open a SUBJECT watch and credit nothing;
 *  2. an alert-anchored intent must be unaffected;
 *  3. an intent with NEITHER an alert nor a sweep trigger must STILL be
 *     credited `verified` on release — P2-5's C4 fallback is narrowed here,
 *     not deleted, and case 3 is the regression guard that says so.
 *
 * Harness (fixture, approval route, the single `executeTool` fake) is lifted
 * from `aiAgentOpEvidence.integration.test.ts`; read that file's header for
 * why the tool boundary is the only thing mocked.
 *
 * Lives under `src/__tests__/integration/`, so `vitest.integration.config.ts`'s
 * wholesale include covers it and the unit runner's identical exclude drops
 * it. A file placed anywhere else runs in ZERO CI jobs.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, like } from 'drizzle-orm';
import { Hono } from 'hono';

const h = vi.hoisted(() => ({
  executeTool: vi.fn(async () => JSON.stringify({ ok: true })),
}));
vi.mock('../../services/aiTools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/aiTools')>();
  return { ...actual, executeTool: h.executeTool };
});

import { sweepTriggerKey, type RemediationTrigger } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../../db';
import { getTestDb } from './setup';
import {
  actionIntents,
  aiAgentFixWatches,
  aiAgentOpEvidence,
  aiAgentRuns,
  aiAgents,
  alerts,
  approvalRequests,
  devices,
  serviceProcessCheckResults,
} from '../../db/schema';
import { buildAgentAuthContext } from '../../services/aiAgents/agentAuthContext';
import { createActionIntent } from '../../services/actionIntents/intentService';
import { releaseApprovedIntent } from '../../jobs/intentReleaseWorker';
import {
  checkFixWatchPhase1,
  checkFixWatchPhase2,
  createSweepFixWatchRow,
} from '../../services/aiAgents/fixWatch';
import { SWEEP_PROBE_FRESHNESS_MS } from '../../services/aiAgents/sweepSubjectProbe';
import { approvalRoutes } from '../../routes/approvals';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';

const TOOL_NAME = 'manage_services';
const SERVICE_NAME = 'MSSQLSERVER';
const DEVICES_EXECUTE = { resource: 'devices', action: 'execute' } as const;

function effectivePolicyFields() {
  return {
    enabled: true,
    mode: 'shadow' as const,
    model: null,
    toolAllowlist: [TOOL_NAME],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: {},
    triggers: {},
    recipients: { userIds: [], roleIds: [] },
    instructions: null,
    cooldownSeconds: 900,
  };
}

interface Scenario {
  partnerId: string;
  orgId: string;
  siteId: string;
  deviceId: string;
  agentId: string;
  creatorId: string;
  eligible: { id: string; email: string };
  eligibleRoleId: string;
}

async function seedScenario(): Promise<Scenario> {
  const adminDb = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });

  const creator = await createUser({
    partnerId: partner.id, orgId: org.id, email: `creator-${randomUUID()}@sweepwatch.test`,
  });
  const eligibleRole = await createRole({ scope: 'organization', orgId: org.id });
  await grantRolePermissions(eligibleRole.id, [DEVICES_EXECUTE]);
  const eligible = await createUser({
    partnerId: partner.id, orgId: org.id, email: `eligible-${randomUUID()}@sweepwatch.test`,
  });
  await assignUserToOrganization(eligible.id, org.id, eligibleRole.id);

  const unique = randomUUID().slice(0, 8);
  const [device] = await adminDb
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: `sweepwatch-agent-${unique}`,
      hostname: `sweepwatch-host-${unique}`,
      osType: 'windows',
      osVersion: '2022',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
    })
    .returning({ id: devices.id });

  const [agent] = await withSystemDbAccessContext(() => db
    .insert(aiAgents)
    .values({
      partnerId: partner.id,
      orgId: null,
      kind: 'triage',
      name: 'Sweep Watch',
      ...effectivePolicyFields(),
      createdBy: creator.id,
    })
    .returning({ id: aiAgents.id }));

  return {
    partnerId: partner.id,
    orgId: org.id,
    siteId: site.id,
    deviceId: device!.id,
    agentId: agent!.id,
    creatorId: creator.id,
    eligible: { id: eligible.id, email: eligible.email },
    eligibleRoleId: eligibleRole.id,
  };
}

/** A sweep run: device-LESS, alert-LESS, `trigger_kind: 'schedule'`. */
async function seedRun(
  s: Scenario,
  overrides: {
    deviceId?: string | null;
    alertId?: string | null;
    triggerKind?: 'alert' | 'schedule';
    profile?: 'full' | 'sweep';
  },
): Promise<string> {
  const [run] = await withSystemDbAccessContext(() => db
    .insert(aiAgentRuns)
    .values({
      agentId: s.agentId,
      orgId: s.orgId,
      deviceId: overrides.deviceId ?? null,
      alertId: overrides.alertId ?? null,
      profile: overrides.profile ?? 'full',
      triggerKind: overrides.triggerKind ?? 'schedule',
      dedupeKey: `sweep-watch-${randomUUID()}`,
      modeAtStart: 'shadow',
      policySnapshot: {
        schemaVersion: 1,
        agentId: s.agentId,
        kind: 'triage',
        effective: effectivePolicyFields(),
        resolvedAt: new Date().toISOString(),
      } as never,
    })
    .returning({ id: aiAgentRuns.id }));
  return run!.id;
}

async function seedAlert(s: Scenario): Promise<string> {
  const [alert] = await withSystemDbAccessContext(() => db
    .insert(alerts)
    .values({
      ruleId: null,
      deviceId: s.deviceId,
      orgId: s.orgId,
      configPolicyId: null,
      configItemName: 'service_down',
      severity: 'high',
      title: 'Service down',
      message: 'MSSQLSERVER stopped',
      status: 'active',
      triggeredAt: new Date(),
    })
    .returning({ id: alerts.id }));
  return alert!.id;
}

async function accessTokenFor(s: Scenario): Promise<string> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: s.eligible.id,
    email: s.eligible.email,
    roleId: s.eligibleRoleId,
    orgId: s.orgId,
    partnerId: s.partnerId,
    scope: 'organization',
    mfa: false,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  return createAccessToken(payload);
}

/** Agent proposes (optionally with a sweep trigger + explicit device scope) ->
 *  the eligible human approves through the REAL route -> released. */
async function createApproveAndRelease(
  s: Scenario,
  runId: string,
  opts: { runDeviceId: string | null; trigger?: RemediationTrigger },
): Promise<string> {
  const auth = buildAgentAuthContext(
    { id: s.agentId, orgId: null, partnerId: s.partnerId, name: 'Sweep Watch', kind: 'triage' },
    { id: runId, orgId: s.orgId, deviceId: opts.runDeviceId, deviceSiteId: opts.runDeviceId ? s.siteId : null },
    { id: s.orgId, partnerId: s.partnerId },
  );
  const snapshot = await createActionIntent(auth, {
    trigger: opts.trigger,
    toolName: TOOL_NAME,
    input: { deviceId: s.deviceId, action: 'restart', serviceName: SERVICE_NAME },
    source: 'ai_agent',
    orgId: s.orgId,
    ...(opts.runDeviceId ? {} : { scope: { deviceId: s.deviceId } }),
  });
  expect(snapshot.status).toBe('pending_approval');

  const rows = await withSystemDbAccessContext(() => db
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(eq(approvalRequests.intentId, snapshot.id)));
  expect(rows).toHaveLength(1);

  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  const res = await app.request(`/approvals/${rows[0]!.id}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessTokenFor(s)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);

  await releaseApprovedIntent(snapshot.id);
  const [intent] = await withSystemDbAccessContext(() => db
    .select({ status: actionIntents.status })
    .from(actionIntents)
    .where(eq(actionIntents.id, snapshot.id))
    .limit(1));
  expect(intent!.status).toBe('completed');
  return snapshot.id;
}

async function metricsFor(intentId: string): Promise<string[]> {
  const rows = await withSystemDbAccessContext(() => db
    .select({ metric: aiAgentOpEvidence.metric })
    .from(aiAgentOpEvidence)
    .where(eq(aiAgentOpEvidence.sourceId, intentId))
    .orderBy(asc(aiAgentOpEvidence.metric)));
  return rows.map((r) => r.metric);
}

async function watchFor(intentId: string) {
  const [row] = await withSystemDbAccessContext(() => db
    .select()
    .from(aiAgentFixWatches)
    .where(eq(aiAgentFixWatches.intentId, intentId))
    .limit(1));
  return row;
}

let s: Scenario;

beforeEach(async () => {
  h.executeTool.mockClear();
  h.executeTool.mockResolvedValue(JSON.stringify({ ok: true }));
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  s = await seedScenario();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('sweep-minted intents open a verification episode (#5753)', () => {
  it('a released sweep-minted intent opens a subject watch and is NOT credited verified on release', async () => {
    const runId = await seedRun(s, { deviceId: null, alertId: null, triggerKind: 'schedule', profile: 'sweep' });
    const intentId = await createApproveAndRelease(s, runId, {
      runDeviceId: null,
      trigger: { kind: 'sweep_finding', refId: runId, key: sweepTriggerKey('service_down', SERVICE_NAME) },
    });

    expect(await metricsFor(intentId)).toEqual(['executed']);

    const watch = await watchFor(intentId);
    expect(watch, 'a sweep-minted intent must open a subject-anchored fix watch').toBeDefined();
    expect(watch!.state).toBe('pending');
    expect(watch!.subjectKind).toBe('service_down');
    expect(watch!.subjectKey).toBe(SERVICE_NAME);
    expect(watch!.alertId).toBeNull();
    expect(watch!.ruleId).toBeNull();
    expect(watch!.sourceKind).toBe('intent');
    expect(watch!.deviceId).toBe(s.deviceId);
  });

  it('an ALERT-anchored intent is unaffected — it still opens an alert watch and is still not credited on release', async () => {
    const alertId = await seedAlert(s);
    const runId = await seedRun(s, { deviceId: s.deviceId, alertId, triggerKind: 'alert', profile: 'full' });
    const intentId = await createApproveAndRelease(s, runId, { runDeviceId: s.deviceId });

    expect(await metricsFor(intentId)).toEqual(['executed']);

    const watch = await watchFor(intentId);
    expect(watch).toBeDefined();
    expect(watch!.alertId).toBe(alertId);
    expect(watch!.subjectKind).toBeNull();
    expect(watch!.subjectKey).toBeNull();
  });

  it('a released intent with neither an alert nor a sweep trigger is STILL credited verified on release (P2-5 C4 preserved)', async () => {
    const runId = await seedRun(s, { deviceId: s.deviceId, alertId: null, triggerKind: 'alert', profile: 'full' });
    const intentId = await createApproveAndRelease(s, runId, { runDeviceId: s.deviceId });

    expect(await metricsFor(intentId)).toEqual(['executed', 'verified']);
    expect(await watchFor(intentId)).toBeUndefined();
  });

  it('two createSweepFixWatchRow calls for the same intent leave exactly ONE row (the partial intent_id UNIQUE really arbitrates)', async () => {
    // A compiled-SQL test proves the ON CONFLICT clause was WRITTEN; only a
    // real partial index proves it ARBITRATES — and a partial unique index
    // cannot be inferred as the arbiter without its predicate repeated
    // (42P10), which is precisely what a mock cannot catch.
    const runId = await seedRun(s, { deviceId: null, alertId: null, triggerKind: 'schedule', profile: 'sweep' });
    const intentId = await createApproveAndRelease(s, runId, {
      runDeviceId: null,
      trigger: { kind: 'sweep_finding', refId: runId, key: sweepTriggerKey('service_down', SERVICE_NAME) },
    });
    const first = await watchFor(intentId);
    expect(first).toBeDefined();

    const second = await withSystemDbAccessContext(() => createSweepFixWatchRow({
      intentId,
      orgId: s.orgId,
      runId,
      agentId: s.agentId,
      deviceId: s.deviceId,
      subjectKind: 'service_down',
      subjectKey: SERVICE_NAME,
      opKey: 'manage_services:restart',
    }));

    // The EXISTING row's id, never null — the caller reads null as "nothing
    // will ever verify this" and credits `verified` on the spot.
    expect(second).toBe(first!.id);
    const all = await withSystemDbAccessContext(() => db
      .select({ id: aiAgentFixWatches.id })
      .from(aiAgentFixWatches)
      .where(eq(aiAgentFixWatches.intentId, intentId)));
    expect(all).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The full verification episode, against real Postgres: phase 1 and phase 2
// driven by REAL check-result rows, not a mocked probe.
// ---------------------------------------------------------------------------
describe('a subject watch is graded by re-probing the real condition (#5753)', () => {
  /** A service/process check result for the fixture device, `ageMs` old. */
  async function seedCheckResult(status: 'running' | 'stopped', ageMs = 0): Promise<void> {
    await withSystemDbAccessContext(() => db
      .insert(serviceProcessCheckResults)
      .values({
        orgId: s.orgId,
        deviceId: s.deviceId,
        watchType: 'service',
        name: SERVICE_NAME,
        status,
        timestamp: new Date(Date.now() - ageMs),
      }));
  }

  /** Release a sweep intent and return its (pending) watch. */
  async function releasedSweepWatch(): Promise<{ intentId: string; watchId: string }> {
    const runId = await seedRun(s, { deviceId: null, alertId: null, triggerKind: 'schedule', profile: 'sweep' });
    const intentId = await createApproveAndRelease(s, runId, {
      runDeviceId: null,
      trigger: { kind: 'sweep_finding', refId: runId, key: sweepTriggerKey('service_down', SERVICE_NAME) },
    });
    const watch = await watchFor(intentId);
    expect(watch!.state).toBe('pending');
    return { intentId, watchId: watch!.id };
  }

  async function watchStateOf(watchId: string): Promise<string> {
    const [row] = await withSystemDbAccessContext(() => db
      .select({ state: aiAgentFixWatches.state })
      .from(aiAgentFixWatches)
      .where(eq(aiAgentFixWatches.id, watchId))
      .limit(1));
    return row!.state;
  }

  /** Every watch-sourced evidence row for this watch. */
  async function watchEvidence(watchId: string) {
    return withSystemDbAccessContext(() => db
      .select({
        namespace: aiAgentOpEvidence.namespace,
        metric: aiAgentOpEvidence.metric,
        sourceKind: aiAgentOpEvidence.sourceKind,
        opKey: aiAgentOpEvidence.opKey,
      })
      .from(aiAgentOpEvidence)
      .where(like(aiAgentOpEvidence.sourceId, `${watchId}%`))
      .orderBy(asc(aiAgentOpEvidence.metric)));
  }

  it('a fresh `running` result clears the condition: phase 1 moves the watch to watching', async () => {
    const { watchId } = await releasedSweepWatch();
    await seedCheckResult('running');

    await expect(checkFixWatchPhase1(watchId)).resolves.toEqual({ action: 'recovered' });
    expect(await watchStateOf(watchId)).toBe('watching');
    // Phase 1 grades nothing.
    expect(await watchEvidence(watchId)).toEqual([]);
  });

  it('a still-`stopped` result keeps phase 1 waiting, and a STALE result is unknown — never a clear', async () => {
    const stillDown = await releasedSweepWatch();
    await seedCheckResult('stopped');
    await expect(checkFixWatchPhase1(stillDown.watchId)).resolves.toEqual({ action: 'still_pending' });
    expect(await watchStateOf(stillDown.watchId)).toBe('pending');

    // A device that stopped reporting: its newest row is `running`, but far
    // outside the freshness window. Reading that as recovery would credit
    // `verified` for a machine that has said nothing since.
    const stale = await releasedSweepWatch();
    await seedCheckResult('running', SWEEP_PROBE_FRESHNESS_MS * 4);
    await expect(checkFixWatchPhase1(stale.watchId)).resolves.toEqual({ action: 'still_pending' });
    expect(await watchStateOf(stale.watchId)).toBe('pending');
  });

  it('phase 2 with the condition still cleared -> held_qualified and exactly ONE `verified` row on policy_key', async () => {
    const { watchId } = await releasedSweepWatch();
    await seedCheckResult('running');
    await checkFixWatchPhase1(watchId);

    await expect(checkFixWatchPhase2(watchId)).resolves.toEqual({ action: 'held_qualified' });
    expect(await watchStateOf(watchId)).toBe('held_qualified');
    expect(await watchEvidence(watchId)).toEqual([
      { namespace: 'policy_key', metric: 'verified', sourceKind: 'watch', opKey: 'manage_services:restart' },
    ]);
  });

  it('phase 2 with the condition back -> recurred, one `recurred` row, and the colon key is auto-demoted', async () => {
    const { watchId } = await releasedSweepWatch();
    await seedCheckResult('running');
    await checkFixWatchPhase1(watchId);
    // The condition returns inside the hold window.
    await seedCheckResult('stopped');

    await expect(checkFixWatchPhase2(watchId)).resolves.toEqual({ action: 'recurred' });
    expect(await watchStateOf(watchId)).toBe('recurred');
    expect(await watchEvidence(watchId)).toEqual([
      { namespace: 'policy_key', metric: 'recurred', sourceKind: 'watch', opKey: 'manage_services:restart' },
    ]);
    // The operator-facing attention alert names the condition that returned.
    const [raised] = await withSystemDbAccessContext(() => db
      .select({ message: alerts.message })
      .from(alerts)
      .where(and(eq(alerts.orgId, s.orgId), eq(alerts.configItemName, 'ai_agent_fix_watch')))
      .limit(1));
    expect(raised!.message).toContain(`service_down:${SERVICE_NAME}`);
  });

  it('phase 2 that cannot answer -> inconclusive, with NO evidence row at all — never `failed`', async () => {
    const { watchId } = await releasedSweepWatch();
    await seedCheckResult('running');
    await checkFixWatchPhase1(watchId);
    // Wipe the observations: the device has gone silent since recovery.
    await withSystemDbAccessContext(() => db
      .delete(serviceProcessCheckResults)
      .where(eq(serviceProcessCheckResults.deviceId, s.deviceId)));

    await expect(checkFixWatchPhase2(watchId)).resolves.toEqual({ action: 'inconclusive' });
    expect(await watchStateOf(watchId)).toBe('inconclusive');
    expect(await watchEvidence(watchId)).toEqual([]);
  });
});
