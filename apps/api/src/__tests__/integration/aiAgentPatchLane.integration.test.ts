/**
 * AI patch agent W01 (#5747), Task 14 — the patch lane against live
 * PostgreSQL, as the unprivileged `breeze_app` role with forced RLS on.
 *
 * Direct sibling of `aiAgentFleetDesign.integration.test.ts`; read that file's
 * header for the shared rationale. Four things are specific to this lane and
 * cannot be shown by the mocked-db unit suites:
 *
 *  1. **The migration's three CHECK widenings actually landed.** A `patch`
 *     run profile, a `patch` schedule kind and a patch baseline are all
 *     rejected by a CHECK constraint until `2026-10-16-182700` runs; the unit
 *     suites never touch a constraint.
 *  2. **`loadPatchEvidence` is a dozen hand-written, org-pinned statements**
 *     running under a SYSTEM context — i.e. with RLS bypassed, so the `org_id`
 *     predicate in each statement IS the tenant boundary. A sibling tenant's
 *     device must never appear in the bundle, and only a second org with real
 *     outstanding patches can prove it.
 *  3. **The fan-out's fourth arm.** One `patch`-profile run per live org,
 *     driven by the `patch` agent — not `triage`, not `designer`.
 *  4. **Zero action intents.** W01 is findings-only by construction; this
 *     counts the intents a completed patch run left behind, which is the one
 *     assertion no unit test can make about the real table.
 *
 * Lives under `src/__tests__/integration/` so both vitest configs' wholesale
 * globs pick it up — anywhere else runs in ZERO CI jobs.
 */
import './setup';

// `AI_AGENTS_ENABLED` is a module-scope const in config/env, frozen at import
// time — `vi.stubEnv` alone cannot move it.
import { vi } from 'vitest';
vi.hoisted(() => {
  process.env.BREEZE_AI_AGENTS_ENABLED = 'true';
});

// publishEvent writes to a Redis stream; spy on it instead of exercising real
// Redis (same precedent as aiAgentFleetDesign.integration.test.ts).
const { publishEventMock } = vi.hoisted(() => ({
  publishEventMock: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'test-event-id'),
}));
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: publishEventMock };
});

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { PATCH_DEFAULT_CRON, type PatchPlanOutcome } from '@breeze/shared';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import {
  db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext,
} from '../../db';
import {
  actionIntents, aiAgentRuns, aiAgents, aiAgentSchedules, devicePatches, devices, patches,
} from '../../db/schema';
import { loadPatchEvidence, patchEvidenceRefs } from '../../services/aiAgents/patchEvidence';
import { persistPatchPlan } from '../../services/aiAgents/patchPlan';
import { backfillDefaultPatchSchedules } from '../../jobs/patchScheduleBackfill';
import {
  createSchedule, ScheduleValidationError, type CreateAiAgentScheduleInput,
} from '../../services/aiAgents/scheduleService';
import { processSweepOccurrence } from '../../jobs/aiAgentSweepScheduler';
import { registerAgentRunEnqueuer, type AgentRunEnqueuer } from '../../services/aiAgents/runService';
import type { AuthContext } from '../../middleware/auth';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
    currentPartnerId: partnerId,
  };
}

function partnerAuth(opts: { partnerId: string; userId: string }): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: opts.userId, email: 't@example.com', name: 'Tech', isPlatformAdmin: false },
    token: null,
    partnerId: opts.partnerId,
    orgId: null,
    scope: 'partner',
    accessibleOrgIds: [],
    partnerOrgAccess: 'all',
    orgCondition: () => undefined,
    canAccessOrg: () => true,
  } as unknown as AuthContext;
}

function sqlCause(error: unknown): { code?: string; message?: string } {
  return (error as { cause?: { code?: string; message?: string } }).cause ?? {};
}

async function countWhere(query: ReturnType<typeof sql>): Promise<number> {
  const rows = (await getTestDb().execute(query)) as unknown as Array<Record<string, unknown>>;
  return Number(Object.values(rows[0] ?? { c: 0 })[0]);
}

async function insertDevice(orgId: string, siteId: string, over: Record<string, unknown> = {}) {
  const unique = randomUUID().slice(0, 8);
  const [device] = await withSystemDbAccessContext(() => db
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `patch-agent-${unique}`,
      hostname: `patch-host-${unique}`,
      osType: 'windows',
      osVersion: '10',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      lastSeenAt: new Date(),
      ...over,
    })
    .returning());
  return device!;
}

/** One outstanding (`pending`) patch on one device — the shape every evidence
 *  loader's `OUTSTANDING_DEVICE_PATCH_STATUSES` filter selects. */
async function insertOutstandingPatch(orgId: string, deviceId: string) {
  const unique = randomUUID().slice(0, 8);
  const [patch] = await withSystemDbAccessContext(() => db
    .insert(patches)
    .values({
      source: 'microsoft',
      externalId: `KB-${unique}`,
      vendor: 'Microsoft',
      title: `Security update ${unique}`,
      severity: 'critical',
      requiresReboot: true,
      releaseDate: '2026-08-01',
    })
    .returning());
  await withSystemDbAccessContext(() => db
    .insert(devicePatches)
    .values({ deviceId, orgId, patchId: patch!.id, status: 'pending' }));
  return patch!;
}

async function seedPatchAgent(partnerId: string, createdBy: string) {
  const [agent] = await withSystemDbAccessContext(() => db
    .insert(aiAgents)
    .values({
      partnerId,
      orgId: null,
      kind: 'patch',
      name: 'Patch Agent',
      enabled: true,
      mode: 'shadow',
      limits: {},
      createdBy,
    })
    .returning());
  return agent!;
}

async function seedTriageAgent(partnerId: string, createdBy: string) {
  const [agent] = await withSystemDbAccessContext(() => db
    .insert(aiAgents)
    .values({
      partnerId, orgId: null, kind: 'triage', name: 'Nightly Triage', enabled: true, mode: 'shadow', createdBy,
    })
    .returning());
  return agent!;
}

async function seedPatchBaseline(opts: { partnerId: string; agentId: string; userId: string }) {
  const [baseline] = await withSystemDbAccessContext(() => db
    .insert(aiAgentSchedules)
    .values({
      orgId: null,
      partnerId: opts.partnerId,
      agentId: opts.agentId,
      baselineScheduleId: null,
      kind: 'patch',
      cron: PATCH_DEFAULT_CRON,
      timezone: 'UTC',
      sweepKinds: [],
      enabled: true,
      createdBy: opts.userId,
      updatedAt: new Date(),
    })
    .returning());
  return baseline!;
}

// ---------------------------------------------------------------------------
// Case 1-2: the migration's CHECK widenings, stored end to end.
// ---------------------------------------------------------------------------

describe('patch profile and schedule kind are storable', () => {
  runDb('stores a patch-profile run and a patch baseline', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    const org = await createOrganization({ partnerId: partner.id });
    const agent = await seedPatchAgent(partner.id, user.id);

    const baseline = await seedPatchBaseline({ partnerId: partner.id, agentId: agent.id, userId: user.id });
    expect(baseline.kind).toBe('patch');

    const [run] = await withDbAccessContext(SYSTEM_CTX, () => db
      .insert(aiAgentRuns)
      .values({
        agentId: agent.id,
        orgId: org.id,
        deviceId: null,
        profile: 'patch',
        scheduleId: baseline.id,
        triggerKind: 'schedule',
        triggerRef: { scheduleId: baseline.id, occurrenceKey: 'k', kind: 'patch' },
        dedupeKey: `patch-${baseline.id}-${org.id}-k`,
        modeAtStart: 'shadow',
        policySnapshot: {} as never,
        status: 'running',
      })
      .returning());
    expect(run!.profile).toBe('patch');
  });

  runDb('the schedule CHECK still rejects kind=patch with non-empty sweep_kinds (23514)', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    const agent = await seedPatchAgent(partner.id, user.id);

    let caught: unknown;
    try {
      await withSystemDbAccessContext(() => db
        .insert(aiAgentSchedules)
        .values({
          orgId: null,
          partnerId: partner.id,
          agentId: agent.id,
          baselineScheduleId: null,
          kind: 'patch',
          cron: PATCH_DEFAULT_CRON,
          timezone: 'UTC',
          sweepKinds: ['disk_pressure'],
          enabled: true,
          createdBy: user.id,
          updatedAt: new Date(),
        }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(sqlCause(caught).code).toBe('23514');
  });

  runDb('the run-profile CHECK still rejects an unknown profile (23514)', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    const org = await createOrganization({ partnerId: partner.id });
    const agent = await seedPatchAgent(partner.id, user.id);

    let caught: unknown;
    try {
      await withDbAccessContext(SYSTEM_CTX, () => db.execute(sql`
        INSERT INTO ai_agent_runs (agent_id, org_id, device_id, profile, trigger_kind, dedupe_key, mode_at_start, policy_snapshot, status)
        VALUES (${agent.id}::uuid, ${org.id}::uuid, NULL, 'patchwork', 'schedule', ${randomUUID()}, 'shadow', '{}'::jsonb, 'running')
      `));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect(sqlCause(caught).code).toBe('23514');
  });
});

// ---------------------------------------------------------------------------
// Case 3: evidence is org-pinned under a SYSTEM context (RLS bypassed).
// ---------------------------------------------------------------------------

describe('loadPatchEvidence is org-pinned', () => {
  runDb('names zero rows belonging to a sibling org under the same partner', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const siteA = await createSite({ orgId: orgA.id });
    const siteB = await createSite({ orgId: orgB.id });

    const deviceA = await insertDevice(orgA.id, siteA.id);
    const deviceB = await insertDevice(orgB.id, siteB.id);
    await insertOutstandingPatch(orgA.id, deviceA.id);
    await insertOutstandingPatch(orgB.id, deviceB.id);

    const evidence = await withSystemDbAccessContext(() => loadPatchEvidence(orgA.id, partner.id));

    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(deviceB.id);
    expect(serialized).not.toContain(orgB.id);

    const refs = patchEvidenceRefs(evidence);
    expect(refs.deviceIds.has(deviceB.id)).toBe(false);
    // The org's OWN device is reachable — otherwise this assertion would pass
    // against a bundle that simply loaded nothing at all.
    expect(refs.deviceIds.has(deviceA.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Case 4: persistPatchPlan re-validates against the assembled evidence.
// ---------------------------------------------------------------------------

describe('persistPatchPlan re-validation', () => {
  function planWith(items: PatchPlanOutcome['items']): PatchPlanOutcome {
    return {
      schemaVersion: 1,
      summary: 'Plan',
      posture: { compliancePct: 50, devicesAtRisk: 1, oldestOutstandingDays: 10 },
      items,
      dispositions: [],
      evidenceTruncated: false,
      generatedAt: new Date().toISOString(),
    };
  }

  runDb('refuses an install item naming a device absent from the evidence', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const device = await insertDevice(org.id, site.id);
    const patch = await insertOutstandingPatch(org.id, device.id);

    const evidence = await withSystemDbAccessContext(() => loadPatchEvidence(org.id, partner.id));
    const refs = patchEvidenceRefs(evidence);

    const strangerDeviceId = randomUUID();
    // W02: an EMPTY agent allowlist keeps this a gate-1/gate-2 test — the
    // surviving install item is then refused as not_allowlisted before any
    // eligibility read (aiAgentPatchInstall.integration.test.ts covers minting).
    const { dispositions } = await persistPatchPlan(
      { id: randomUUID(), orgId: org.id, agentId: randomUUID(), scheduleId: null, toolAllowlist: [], maxActionsPerRun: 0 },
      planWith([
        {
          class: 'install', severity: 'critical', deviceId: device.id, patchIds: [patch.id],
          title: 'Install', detail: 'd', evidenceRef: 'topNonCompliant:0',
        },
        {
          class: 'install', severity: 'critical', deviceId: strangerDeviceId, patchIds: [patch.id],
          title: 'Install elsewhere', detail: 'd', evidenceRef: 'topNonCompliant:1',
        },
      ]),
      refs,
      partnerAuth({ partnerId: partner.id, userId: randomUUID() }),
    );

    expect(dispositions[0]).toMatchObject({ index: 0, disposition: 'refused', reason: 'not_allowlisted' });
    expect(dispositions[1]).toMatchObject({ index: 1, disposition: 'refused', reason: 'device_not_in_evidence' });
  });

  runDb('refuses an item whose device belongs to another org even when the evidence knows it', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const siteA = await createSite({ orgId: orgA.id });
    const siteB = await createSite({ orgId: orgB.id });
    const deviceA = await insertDevice(orgA.id, siteA.id);
    const deviceB = await insertDevice(orgB.id, siteB.id);
    const patchA = await insertOutstandingPatch(orgA.id, deviceA.id);
    await insertOutstandingPatch(orgB.id, deviceB.id);

    const evidence = await withSystemDbAccessContext(() => loadPatchEvidence(orgA.id, partner.id));
    const refs = patchEvidenceRefs(evidence);
    // Forge the cross-tenant reference INTO the refs — the device-org read is
    // the second gate, and this is the only way to reach it.
    const forged = {
      ...refs,
      deviceIds: new Set([...refs.deviceIds, deviceB.id]),
      patchIdsByDevice: new Map([...refs.patchIdsByDevice, [deviceB.id, new Set([patchA.id])]]),
    };

    const { dispositions } = await persistPatchPlan(
      { id: randomUUID(), orgId: orgA.id, agentId: randomUUID(), scheduleId: null, toolAllowlist: [], maxActionsPerRun: 0 },
      planWith([{
        class: 'install', severity: 'critical', deviceId: deviceB.id, patchIds: [patchA.id],
        title: 'Cross-tenant install', detail: 'd', evidenceRef: 'topNonCompliant:0',
      }]),
      forged,
      partnerAuth({ partnerId: partner.id, userId: randomUUID() }),
    );

    expect(dispositions[0]).toMatchObject({ disposition: 'refused', reason: 'device_not_in_org' });
  });
});

// ---------------------------------------------------------------------------
// Case 5-8: the `patch` schedule kind — fan-out, the create gate, org
// visibility, zero intents, and the backfill.
// ---------------------------------------------------------------------------

describe('patch schedule kind — fan-out and DB contracts', () => {
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

  runDb('fans out one patch run per live org, targeting the patch agent, and mints zero intents', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const agent = await seedPatchAgent(partner.id, user.id);
    const baseline = await seedPatchBaseline({ partnerId: partner.id, agentId: agent.id, userId: user.id });

    const occurrenceKey = '2026-10-01T02:00@UTC';
    const summary = await processSweepOccurrence({ scheduleId: baseline.id, occurrenceKey });

    expect(summary.orgsTotal).toBe(2);
    expect(summary.runsAdmitted).toBe(2);
    expect(summary.runsSkipped).toBe(0);

    for (const orgId of [orgA.id, orgB.id]) {
      const runs = await withSystemDbAccessContext(() => db
        .select()
        .from(aiAgentRuns)
        .where(eq(aiAgentRuns.orgId, orgId)));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        orgId, agentId: agent.id, deviceId: null, profile: 'patch', triggerKind: 'schedule', scheduleId: baseline.id,
      });
      // W01 is findings-only BY CONSTRUCTION: `maxActionsPerRun` is 0 and the
      // floor carries no mutating tool, so a patch run can leave no intent
      // behind. This is the one place that can be asserted against the table.
      expect(await countWhere(sql`
        SELECT count(*)::int FROM action_intents WHERE org_id = ${orgId}::uuid
      `)).toBe(0);
    }
    expect(enqueued).toHaveLength(2);
    // Belt and braces: the drizzle-typed read agrees with the raw count above.
    expect(await withSystemDbAccessContext(() => db
      .select({ id: actionIntents.id })
      .from(actionIntents)
      .where(eq(actionIntents.orgId, orgA.id)))).toHaveLength(0);
  });

  runDb('createSchedule rejects a patch baseline targeting a triage agent with agent_kind_not_patch', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    const triageAgent = await seedTriageAgent(partner.id, user.id);

    const auth = partnerAuth({ partnerId: partner.id, userId: user.id });
    const scheduleInput: CreateAiAgentScheduleInput = {
      ownerScope: 'partner',
      kind: 'patch',
      agentId: triageAgent.id,
      cron: PATCH_DEFAULT_CRON,
      timezone: 'UTC',
      sweepKinds: [],
      enabled: true,
    };

    let caught: unknown;
    try {
      await withDbAccessContext(partnerContext(partner.id, []), () => createSchedule(auth, scheduleInput));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ScheduleValidationError);
    expect((caught as ScheduleValidationError).code).toBe('agent_kind_not_patch');

    expect(await countWhere(sql`
      SELECT count(*)::int FROM ai_agent_schedules WHERE partner_id = ${partner.id}::uuid
    `)).toBe(0);
  });

  runDb('the backfill creates exactly one baseline for an already-enabled patch agent, and is idempotent', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    await createOrganization({ partnerId: partner.id });
    const agent = await seedPatchAgent(partner.id, user.id);

    await backfillDefaultPatchSchedules();
    await backfillDefaultPatchSchedules();

    const rows = await withSystemDbAccessContext(() => db
      .select()
      .from(aiAgentSchedules)
      .where(and(eq(aiAgentSchedules.agentId, agent.id), eq(aiAgentSchedules.kind, 'patch'))));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cron: PATCH_DEFAULT_CRON, orgId: null, partnerId: partner.id, enabled: true });
  });
});
