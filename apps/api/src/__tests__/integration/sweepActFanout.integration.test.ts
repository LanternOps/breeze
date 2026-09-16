/**
 * Live-Postgres contract for #4442 W05 — the readiness cohort's fan-out
 * arithmetic, against the REAL exposure ledger and the REAL contract-device
 * count, plus the two-arm sweep-lane graduation counter.
 *
 * Why this has to be live and cannot be a unit test: every number the cohort
 * walks against comes out of a query. `computeExposureBudget` counts DISTINCT
 * devices in a 24 h window (a set, not a sum) and `countContractDevices`
 * decides the allowance with `floor(n * pct / 100)` and NO `max(1, ·)`. Mock
 * either and the test proves only that the mock was wired up. The graduation
 * counter is worse: its two EXISTS arms and two regex guards are pure SQL, so
 * a unit test can pin their SHAPE (`graduationService.test.ts` does) but only
 * a real server can prove which rows they actually count.
 *
 * Lives under `src/__tests__/integration/`, so `vitest.integration.config.ts`'s
 * wholesale include covers it and the unit runner's identical exclude drops it.
 * A file placed anywhere else runs in ZERO CI jobs.
 */
import './setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';

import {
  AI_AGENT_GRADUATION_MIN_AGE_DAYS,
  AI_AGENT_LIMIT_DEFAULTS,
  type SweepFindingsOutcome,
} from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../../db';
import { getTestDb } from './setup';
import {
  actionIntents,
  aiAgentFixWatches,
  aiAgentOpEvidence,
  aiAgentRuns,
  aiAgentSchedules,
  aiAgents,
  aiUnattendedExposure,
  devices,
} from '../../db/schema';
import { buildAgentAuthContext } from '../../services/aiAgents/agentAuthContext';
import { evaluateEligibility, evaluateGraduation } from '../../services/aiAgents/graduationService';
import { persistSweepFindings } from '../../services/aiAgents/sweepFindings';
import { sweepSubjectIndexKey, type SweepEvidenceSubject } from '../../services/aiAgents/sweepEvidence';
import { PERMISSIONS } from '../../services/permissions';
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
const OP_KEY = 'manage_services:restart';
/** 40 devices at the 5 % default allows exactly 2 — the starvation arithmetic
 *  that killed all-or-nothing (OD-2 A). */
const FLEET_SIZE = 40;

function effectivePolicyFields() {
  return {
    enabled: true,
    mode: 'act' as const,
    model: null,
    toolAllowlist: [TOOL_NAME],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: {
      maxFleetPercentPerDay: AI_AGENT_LIMIT_DEFAULTS.maxFleetPercentPerDay,
      maxPolicyDecisionsPerDay: AI_AGENT_LIMIT_DEFAULTS.maxPolicyDecisionsPerDay,
      maxActionsPerRun: 10,
    },
    triggers: {},
    recipients: { userIds: [], roleIds: [] },
    actAssets: { scriptIds: [], supervisedActionKeys: [OP_KEY] },
    instructions: null,
    cooldownSeconds: 900,
  };
}

interface Scenario {
  partnerId: string;
  orgId: string;
  deviceIds: string[];
  agentId: string;
  scheduleId: string;
  creatorId: string;
  runId: string;
}

async function seedScenario(opts: { fleetSize?: number; actMode?: boolean } = {}): Promise<Scenario> {
  const adminDb = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const creator = await createUser({
    partnerId: partner.id, orgId: org.id, email: `fanout-${randomUUID()}@sweepact.test`,
  });
  // An eligible human approver. Without one `createActionIntent` commits the
  // intent and instantly CANCELS it (`no_eligible_approvers`) — which would
  // make "nothing is dropped" vacuously false for exactly the non-cohort
  // proposals this file is about.
  const orgRole = await createRole({ scope: 'organization', orgId: org.id });
  // Both are required: APPROVALS_DECIDE for the four-eyes pool, and the tool's
  // own RBAC (manage_services -> devices:execute) for the agent pool — a human
  // approving an agent proposal must hold what they would need to do it
  // themselves (`resolveAgentIntentApprovers`).
  await grantRolePermissions(orgRole.id, [PERMISSIONS.APPROVALS_DECIDE, PERMISSIONS.DEVICES_EXECUTE]);
  const approver = await createUser({
    partnerId: partner.id, orgId: org.id, email: `approver-${randomUUID()}@sweepact.test`,
  });
  await assignUserToOrganization(approver.id, org.id, orgRole.id);

  const fleetSize = opts.fleetSize ?? FLEET_SIZE;
  const deviceRows = await adminDb
    .insert(devices)
    .values(Array.from({ length: fleetSize }, (_unused, i) => {
      const unique = randomUUID().slice(0, 8);
      return {
        orgId: org.id,
        siteId: site.id,
        agentId: `fanout-agent-${unique}`,
        // Hostname drives nothing here, but the ids do: the cohort's
        // documented order tie-breaks on `deviceId asc`, so the fixture must
        // not assume insertion order equals sort order — every assertion
        // below sorts explicitly.
        hostname: `fanout-host-${String(i).padStart(3, '0')}-${unique}`,
        osType: 'windows' as const,
        osVersion: '2022',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'online' as const,
      };
    }))
    .returning({ id: devices.id });

  const [partnerAgent] = await withSystemDbAccessContext(() => db
    .insert(aiAgents)
    .values({
      partnerId: partner.id,
      orgId: null,
      kind: 'triage',
      name: 'Sweep Fanout',
      ...effectivePolicyFields(),
      createdBy: creator.id,
    })
    .returning({ id: aiAgents.id }));

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
      actMode: opts.actMode ?? true,
      createdBy: creator.id,
    })
    .returning({ id: aiAgentSchedules.id }));

  const [run] = await withSystemDbAccessContext(() => db
    .insert(aiAgentRuns)
    .values({
      agentId: partnerAgent!.id,
      orgId: org.id,
      deviceId: null,
      alertId: null,
      profile: 'sweep',
      triggerKind: 'schedule',
      scheduleId: schedule!.id,
      dedupeKey: `sweep-fanout-${randomUUID()}`,
      modeAtStart: 'act',
      policySnapshot: {
        schemaVersion: 1,
        agentId: partnerAgent!.id,
        kind: 'triage',
        effective: effectivePolicyFields(),
        resolvedAt: new Date().toISOString(),
      } as never,
    })
    .returning({ id: aiAgentRuns.id }));

  return {
    partnerId: partner.id,
    orgId: org.id,
    deviceIds: deviceRows.map((r) => r.id),
    agentId: partnerAgent!.id,
    scheduleId: schedule!.id,
    creatorId: creator.id,
    runId: run!.id,
  };
}

/** One `service_down` finding per device, all at the same severity/kind so the
 *  order reduces to `deviceId asc` — which is what makes the expected cohort
 *  computable here without re-implementing the comparator. */
function outcomeFor(deviceIds: readonly string[], serviceName = 'Spooler'): SweepFindingsOutcome {
  return {
    summary: 'Spooler is stopped across the fleet.',
    findings: deviceIds.map((deviceId) => ({
      kind: 'service_down' as const,
      severity: 'critical' as const,
      deviceId,
      title: `${serviceName} is stopped`,
      detail: `${serviceName} has been stopped for 3 days.`,
      evidence: { state: 'stopped' },
      proposedAction: {
        tool: 'manage_services' as const,
        action: 'restart' as const,
        deviceId,
        serviceName,
      },
    })),
  };
}

function subjectIndex(
  deviceIds: readonly string[],
  serviceName = 'Spooler',
): ReadonlyMap<string, SweepEvidenceSubject> {
  const observedAt = new Date().toISOString();
  return new Map(deviceIds.map((deviceId) => [
    sweepSubjectIndexKey('service_down', deviceId, serviceName),
    { kind: 'service_down' as const, deviceId, key: serviceName, observedAt },
  ]));
}

function runInput(s: Scenario, deviceIds: readonly string[], over: Record<string, unknown> = {}) {
  return {
    id: s.runId,
    orgId: s.orgId,
    agentId: s.agentId,
    deviceId: null as null,
    scheduleId: s.scheduleId,
    toolAllowlist: [TOOL_NAME],
    maxActionsPerRun: 10,
    evidenceDeviceIds: new Set(deviceIds) as ReadonlySet<string>,
    evidenceSubjects: subjectIndex(deviceIds),
    maxFleetPercentPerDay: AI_AGENT_LIMIT_DEFAULTS.maxFleetPercentPerDay,
    maxPolicyDecisionsPerDay: AI_AGENT_LIMIT_DEFAULTS.maxPolicyDecisionsPerDay,
    maxUnattendedDevicesPerSweep: AI_AGENT_LIMIT_DEFAULTS.maxUnattendedDevicesPerSweep,
    ...over,
  };
}

function authFor(s: Scenario) {
  return buildAgentAuthContext(
    { id: s.agentId, orgId: null, partnerId: s.partnerId, name: 'Sweep Fanout', kind: 'triage' },
    { id: s.runId, orgId: s.orgId, deviceId: null, deviceSiteId: null },
    { id: s.orgId, partnerId: s.partnerId },
  );
}

/** A committed exposure row, exactly as `runAuthorizeTransaction` writes one. */
async function seedExposure(
  s: Scenario,
  deviceId: string,
  owner: { orgId: string; partnerId: string } = { orgId: s.orgId, partnerId: s.partnerId },
): Promise<void> {
  await withSystemDbAccessContext(() => db
    .insert(aiUnattendedExposure)
    .values({
      orgId: owner.orgId,
      partnerId: owner.partnerId,
      agentId: s.agentId,
      runId: s.runId,
      deviceId,
      intentId: null,
      source: 'policy_intent',
    }));
}

async function mintedIntentDevices(runId: string): Promise<string[]> {
  const rows = await withSystemDbAccessContext(() => db
    .select({ deviceId: actionIntents.scopeDeviceId, state: actionIntents.policyDecisionState })
    .from(actionIntents)
    .where(eq(actionIntents.requestingAgentRunId, runId)));
  return rows.map((r) => r.deviceId!).filter(Boolean).sort();
}

beforeEach(() => {
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  vi.stubEnv('BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED', 'true');
  vi.stubEnv('BREEZE_AI_AGENTS_SWEEP_ACT_ENABLED', 'true');
  return () => vi.unstubAllEnvs();
});

describe('#4442 W05 — the readiness cohort against a live ledger', () => {
  it('mints exactly the cohort act-eligible and the REMAINDER as ordinary cards — and drops nothing', async () => {
    const s = await seedScenario();
    // Six candidates, 40 contract devices: floor(40 * 5 / 100) = 2 allowed.
    const candidates = [...s.deviceIds].sort().slice(0, 6);

    const { proposals } = await persistSweepFindings(
      runInput(s, candidates), outcomeFor(candidates), authFor(s),
    );

    // NOTHING is dropped: every proposal became a real intent.
    expect(proposals).toHaveLength(6);
    expect(proposals.every((p) => p.disposition === 'intent_created')).toBe(true);
    expect(await mintedIntentDevices(s.runId)).toEqual([...candidates].sort());

    // Exactly 2 are cohort members, and they are the deterministic PREFIX.
    const members = proposals.filter((p) => p.cohort === true).map((p) => p.deviceId).sort();
    expect(members).toEqual(candidates.slice(0, 2));
    expect(proposals.filter((p) => p.cohort === false)).toHaveLength(4);
    expect(proposals.find((p) => p.cohort === false)!.stoppedBy).toBe('fleet_cap');
  });

  it('a SECOND occurrence in the same 24h window sees the UNION, not a fresh budget', async () => {
    const s = await seedScenario();
    const sorted = [...s.deviceIds].sort();
    const [d1, d2, d3] = sorted;
    // Occurrence 1 already exposed d1 and d2 — allowance 2 is fully spent by
    // devices already IN the window.
    await seedExposure(s, d1!);
    await seedExposure(s, d2!);

    const candidates = [d1!, d3!];
    const { proposals } = await persistSweepFindings(
      runInput(s, candidates), outcomeFor(candidates), authFor(s),
    );

    const byDevice = new Map(proposals.map((p) => [p.deviceId, p]));
    // d1 is already in the window, so the UNION stays at 2 and it may act.
    // A running SUM (2 existing + 1) would have refused it — that is the bug
    // this case exists to catch.
    expect(byDevice.get(d1!)!.cohort).toBe(true);
    // d3 would make the union 3, over the allowance.
    expect(byDevice.get(d3!)!.cohort).toBe(false);
    expect(byDevice.get(d3!)!.stoppedBy).toBe('fleet_cap');
  });

  it('counts ANOTHER org\'s exposure rows against nobody — the window is org-scoped', async () => {
    const s = await seedScenario();
    const other = await seedScenario({ fleetSize: 1 });
    const sorted = [...s.deviceIds].sort();
    // Two rows in a DIFFERENT org, for the same 24h window. If the window
    // query were not org-pinned these would consume this org's allowance.
    // NOTE: the exposure rows carry the OTHER org's agent/run too — the
    // `(org_id, partner_id)` FK to organizations makes a half-forged row a
    // 23503, so the whole row belongs to that tenant.
    await seedExposure(other, other.deviceIds[0]!);
    await seedExposure(other, s.deviceIds[0]!);

    const candidates = sorted.slice(0, 2);
    const { proposals } = await persistSweepFindings(
      runInput(s, candidates), outcomeFor(candidates), authFor(s),
    );

    expect(proposals.filter((p) => p.cohort === true)).toHaveLength(2);
  });

  it('two proposals on ONE device consume one device slot and TWO day slots', async () => {
    const s = await seedScenario();
    const device = [...s.deviceIds].sort()[0]!;
    // One device, two distinct services -> two findings, two ACTIONS.
    const outcome: SweepFindingsOutcome = {
      summary: 'Two services are stopped on one machine.',
      findings: [
        ...outcomeFor([device], 'AAA-Spooler').findings,
        ...outcomeFor([device], 'BBB-W32Time').findings,
      ],
    };
    const subjects = new Map([
      ...subjectIndex([device], 'AAA-Spooler'),
      ...subjectIndex([device], 'BBB-W32Time'),
    ]);

    const { proposals } = await persistSweepFindings(
      runInput(s, [device], { evidenceSubjects: subjects, maxPolicyDecisionsPerDay: 1 }),
      outcome,
      authFor(s),
    );

    expect(proposals).toHaveLength(2);
    // ONE device slot was enough for both, but the DAY cap counts actions:
    // the second proposal is over it.
    expect(proposals.filter((p) => p.cohort === true)).toHaveLength(1);
    const excluded = proposals.find((p) => p.cohort === false)!;
    expect(excluded.stoppedBy).toBe('day_cap');
  });

  it('a fleet too small for one whole device\'s allowance acts on NOTHING — no max(1, .)', async () => {
    // 10 devices at 5 % is floor(0.5) = 0.
    const s = await seedScenario({ fleetSize: 10 });
    const candidates = [...s.deviceIds].sort().slice(0, 2);

    const { proposals } = await persistSweepFindings(
      runInput(s, candidates), outcomeFor(candidates), authFor(s),
    );

    expect(proposals).toHaveLength(2);
    expect(proposals.every((p) => p.cohort === false)).toBe(true);
    expect(proposals[0]!.stoppedBy).toBe('fleet_cap');
    // Still minted, still approvable — the fleet cap bounds autonomy, not work.
    expect(proposals.every((p) => p.disposition === 'intent_created')).toBe(true);
  });

  it('a DISARMED schedule computes no cohort — every proposal is an ordinary card', async () => {
    const s = await seedScenario({ actMode: false });
    const candidates = [...s.deviceIds].sort().slice(0, 3);

    const { proposals } = await persistSweepFindings(
      runInput(s, candidates), outcomeFor(candidates), authFor(s),
    );

    expect(proposals).toHaveLength(3);
    expect(proposals.every((p) => p.cohort === undefined)).toBe(true);
  });

  it('is REPRODUCIBLE: the same evidence set yields the same cohort across two occurrences', async () => {
    const s = await seedScenario();
    const candidates = [...s.deviceIds].sort().slice(0, 5);
    // Shuffled input to the SECOND call: the cohort must not depend on the
    // model's array order.
    const shuffled = [...candidates].reverse();

    const first = await persistSweepFindings(
      runInput(s, candidates), outcomeFor(candidates), authFor(s),
    );
    const second = await persistSweepFindings(
      runInput(s, shuffled), outcomeFor(shuffled), authFor(s),
    );

    const membersOf = (r: { proposals: Array<{ cohort?: boolean; deviceId: string }> }) =>
      r.proposals.filter((p) => p.cohort === true).map((p) => p.deviceId).sort();
    expect(membersOf(second)).toEqual(membersOf(first));
  });
});

describe('#4442 W05 — the sweep-lane graduation counter against live rows', () => {
  const NAMESPACE = 'policy_key';

  async function seedEvidence(
    s: Scenario,
    row: { sourceKind: 'intent' | 'watch'; sourceId: string; metric: 'verified' | 'executed' },
  ): Promise<void> {
    await withSystemDbAccessContext(() => db
      .insert(aiAgentOpEvidence)
      .values({
        orgId: s.orgId,
        agentId: s.agentId,
        namespace: NAMESPACE,
        opKey: OP_KEY,
        ruleId: null,
        sourceKind: row.sourceKind,
        sourceId: row.sourceId,
        metric: row.metric,
        runId: s.runId,
        occurredAt: new Date(),
      }));
  }

  /** The sweep-minted intent for one device, as `persistSweepFindings` mints
   *  it. Needed by BOTH watch shapes below: `intent_shape_chk` requires a real
   *  `intent_id` whenever `source_kind = 'intent'`. */
  async function mintOneSweepIntent(s: Scenario, deviceId: string): Promise<string> {
    const { proposals } = await persistSweepFindings(
      runInput(s, [deviceId]), outcomeFor([deviceId]), authFor(s),
    );
    const intentId = proposals[0]?.intentId;
    if (!intentId) throw new Error(`no intent minted: ${JSON.stringify(proposals)}`);
    return intentId;
  }

  /** A subject-anchored watch — what W02's sweep lane writes evidence from. */
  async function seedWatch(
    s: Scenario,
    deviceId: string,
    intentId: string,
    subject: { kind: 'service_down'; key: string } | null,
  ): Promise<string> {
    const [watch] = await withSystemDbAccessContext(() => db
      .insert(aiAgentFixWatches)
      .values({
        orgId: s.orgId,
        partnerId: s.partnerId,
        agentId: s.agentId,
        runId: s.runId,
        alertId: null,
        deviceId,
        intentId,
        sourceKind: 'intent',
        opKeys: [OP_KEY],
        subjectKind: subject?.kind ?? null,
        subjectKey: subject?.key ?? null,
      })
      .returning({ id: aiAgentFixWatches.id }));
    return watch!.id;
  }

  async function sweepVerifiedFor(s: Scenario): Promise<number> {
    const evaluation = await withSystemDbAccessContext(
      () => evaluateGraduation(s.orgId, s.agentId, OP_KEY),
    );
    return evaluation.window.sweepVerified;
  }

  it('counts a WATCH-sourced verified row whose watch is subject-anchored (W02)', async () => {
    const s = await seedScenario();
    const device = s.deviceIds[0]!;
    const intentId = await mintOneSweepIntent(s, device);
    const watchId = await seedWatch(s, device, intentId, { kind: 'service_down', key: 'Spooler' });
    // `${watchId}:${opKey}` — `opEvidence.ts`'s watch source id shape, NOT a
    // bare uuid. A single-arm (intent-only) join counts ZERO here.
    await seedEvidence(s, { sourceKind: 'watch', sourceId: `${watchId}:${OP_KEY}`, metric: 'verified' });

    expect(await sweepVerifiedFor(s)).toBe(1);
  });

  it('counts an INTENT-sourced verified row whose intent is trigger_kind sweep_finding', async () => {
    const s = await seedScenario();
    const device = s.deviceIds[0]!;
    await persistSweepFindings(runInput(s, [device]), outcomeFor([device]), authFor(s));
    const [intent] = await withSystemDbAccessContext(() => db
      .select({ id: actionIntents.id, triggerKind: actionIntents.triggerKind })
      .from(actionIntents)
      .where(and(
        eq(actionIntents.requestingAgentRunId, s.runId),
        eq(actionIntents.orgId, s.orgId),
      ))
      .limit(1));
    expect(intent!.triggerKind).toBe('sweep_finding');

    await seedEvidence(s, { sourceKind: 'intent', sourceId: intent!.id, metric: 'verified' });

    expect(await sweepVerifiedFor(s)).toBe(1);
  });

  it('does NOT count an alert-triggered verified row, nor an alert-anchored watch', async () => {
    const s = await seedScenario();
    const device = s.deviceIds[0]!;
    // An alert-anchored watch: `subject_kind IS NULL` is exactly the predicate
    // that classifies it, and arm B requires NOT NULL.
    const intentId = await mintOneSweepIntent(s, device);
    const alertWatchId = await seedWatch(s, device, intentId, null);
    await seedEvidence(s, {
      sourceKind: 'watch', sourceId: `${alertWatchId}:${OP_KEY}`, metric: 'verified',
    });
    // An intent id that exists but is NOT sweep-triggered cannot be forged
    // here cheaply, so use a well-formed uuid that matches no intent at all —
    // arm A's EXISTS must reject it either way.
    await seedEvidence(s, { sourceKind: 'intent', sourceId: randomUUID(), metric: 'verified' });

    expect(await sweepVerifiedFor(s)).toBe(0);
  });

  it('a malformed source_id cannot crash the query — the ::uuid casts are shape-guarded', async () => {
    const s = await seedScenario();
    // Unguarded, either cast raises 22P02 and takes the whole graduation
    // sweep down. This must simply not count.
    await seedEvidence(s, { sourceKind: 'intent', sourceId: 'not-a-uuid', metric: 'verified' });
    await seedEvidence(s, { sourceKind: 'watch', sourceId: 'also:not-a-uuid', metric: 'verified' });

    await expect(sweepVerifiedFor(s)).resolves.toBe(0);
  });

  it('counts ANOTHER org\'s sweep evidence against nobody — both EXISTS arms are org-pinned', async () => {
    // Review fix: the cohort's ledger query has a live cross-org case; the
    // graduation counter had only a SQL-text assertion. The ladder runs from a
    // system-scoped worker, so these two predicates ARE the isolation
    // boundary — a text assertion cannot prove they bind the right org.
    const s = await seedScenario();
    const other = await seedScenario({ fleetSize: 1 });
    const otherDevice = other.deviceIds[0]!;

    // A perfectly valid sweep-lane verified row — in the OTHER tenant.
    const otherIntentId = await mintOneSweepIntent(other, otherDevice);
    const otherWatchId = await seedWatch(
      other, otherDevice, otherIntentId, { kind: 'service_down', key: 'Spooler' },
    );
    await seedEvidence(other, {
      sourceKind: 'watch', sourceId: `${otherWatchId}:${OP_KEY}`, metric: 'verified',
    });
    await seedEvidence(other, {
      sourceKind: 'intent', sourceId: otherIntentId, metric: 'verified',
    });

    // This org has none of its own.
    expect(await sweepVerifiedFor(s)).toBe(0);
    // …and the other org's ladder does see them, so the zero above is
    // isolation, not a query that counts nothing at all.
    expect(await sweepVerifiedFor(other)).toBe(2);
  });

  // CI repair (r2) — the sweep bar is scoped to keys with sweep-lane
  // EXPOSURE (`sweepExecuted > 0`). `aiAgentGraduation.integration.test.ts`
  // proves the other half live: an alert-lane key (no sweep provenance at
  // all) walks the ordinary P2-5 ladder to `promoted` untouched by this bar.
  it('a sweep-lane key with live provenance is EXPOSED, and stays below_sweep_threshold until the sweep bar is met', async () => {
    const s = await seedScenario();
    const device = s.deviceIds[0]!;
    const intentId = await mintOneSweepIntent(s, device);
    await seedEvidence(s, { sourceKind: 'intent', sourceId: intentId, metric: 'executed' });
    // An alert-lane `executed` row (no sweep provenance) — must not count as
    // exposure, exactly as it does not count as sweep-verified.
    await seedEvidence(s, { sourceKind: 'intent', sourceId: randomUUID(), metric: 'executed' });

    const evaluation = await withSystemDbAccessContext(
      () => evaluateGraduation(s.orgId, s.agentId, OP_KEY),
    );
    expect(evaluation.window.executed).toBe(2);
    expect(evaluation.window.sweepExecuted).toBe(1);
    expect(evaluation.window.sweepVerified).toBe(0);

    // The pure ladder over the LIVE window: with every ordinary rung met, the
    // one sweep execution above is what keeps the key at the sweep bar.
    const now = new Date();
    const ordinaryBarsMet = {
      opKey: OP_KEY,
      window: {
        ...evaluation.window,
        verified: AI_AGENT_LIMIT_DEFAULTS.promoteThreshold,
        firstVerifiedAt: new Date(
          now.getTime() - (AI_AGENT_GRADUATION_MIN_AGE_DAYS + 1) * 24 * 60 * 60 * 1000,
        ).toISOString(),
      },
      partnerCeilingKeys: [OP_KEY],
      orgGrantedKeys: [],
      promoteThreshold: AI_AGENT_LIMIT_DEFAULTS.promoteThreshold,
      sweepPromoteThreshold: AI_AGENT_LIMIT_DEFAULTS.sweepPromoteThreshold,
      storedState: null,
      now,
    };
    expect(evaluateEligibility(ordinaryBarsMet).blockedReason).toBe('below_sweep_threshold');
    expect(evaluateEligibility({
      ...ordinaryBarsMet,
      window: { ...ordinaryBarsMet.window, sweepExecuted: 0 },
    }).blockedReason).toBeNull();
  });
});
