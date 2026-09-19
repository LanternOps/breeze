/**
 * Live-Postgres proof for the Phase 2 wave P2-3 weekly org narrative — the
 * SCHEDULE half (task 8): `ai_agent_schedules.kind` and the narrative fan-out.
 *
 * Four things here are Postgres answers a mocked-`../../db` unit suite cannot
 * give, and each is load-bearing for the feature:
 *
 *  1. **One narrative run per org, and only one.** The dedupe key is
 *     `narrative-<scheduleId>-<orgId>-<occurrenceKey>` and it is enforced by
 *     the REAL `(org_id, dedupe_key)` unique index, not a pre-check. Its
 *     `narrative-` prefix is what keeps a narrative run from colliding with a
 *     sweep run for the same (schedule, org, occurrence) — a shared prefix
 *     would silently drop one of the two, and only a real index shows that.
 *  2. **The empty-kinds guard really is kind-gated.** A narrative baseline
 *     stores `sweep_kinds = '{}'` (`ai_agent_schedules_kind_kinds_chk` forbids
 *     anything else), which is the exact shape that makes the SWEEP path skip
 *     every org. The sweep baseline in the same fixture is the control.
 *  3. **The composite self-FK.** `ai_agent_schedules_baseline_kind_fk` is
 *     `(baseline_schedule_id, kind) -> (id, kind)`; an org override whose kind
 *     disagrees with its baseline is a 23503 at insert time. That constraint is
 *     the only thing standing behind `createSchedule`'s "copy the baseline's
 *     kind", and it cannot be exercised without a database.
 *  4. **`override_disabled` still works for a narrative schedule**, whose
 *     override has `enabled` as its ONLY lever (its kinds are pinned to `[]`
 *     on both sides).
 *
 * NOTE FOR TASK 7: this suite deliberately covers the FAN-OUT only. The
 * `persistNarrativeReport` round-trip (reports/report_runs rows with
 * `principal_kind='system'`, the second-persist conflict, the cross-org forge
 * of `ai_agent_runs.report_run_id`, and the post-persist org erasure through
 * `tenantCascade`) belongs to that module and is APPENDED here by task 7 —
 * the module does not exist at the time this file was written.
 *
 * Lives under `src/__tests__/integration/` so both vitest configs' wholesale
 * globs pick it up — anywhere else runs in ZERO CI jobs.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

// `createAndEnqueueAgentRun` re-reads the kill switch through `envFlag`, but
// `config/env` also freezes a module-scope const at import time. `vi.hoisted`
// runs before every import in this file, including `./setup`'s transitive
// `config/env` load — without it every admission below would skip with
// `kill_switch_off` and the assertions would be vacuously green.
vi.hoisted(() => {
  process.env.BREEZE_AI_AGENTS_ENABLED = 'true';
});

// publishEvent writes to a Redis stream; spy on it instead (same precedent as
// aiAgentSweepFanout.integration.test.ts).
const { publishEventMock } = vi.hoisted(() => ({
  publishEventMock: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'test-event-id'),
}));
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: publishEventMock };
});

import type { AiSweepKind } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../../db';
import { aiAgentRuns, aiAgentSchedules, aiAgents, organizations } from '../../db/schema';
import { processSweepOccurrence } from '../../jobs/aiAgentSweepScheduler';
import {
  registerAgentRunEnqueuer,
  type AgentRunEnqueuer,
} from '../../services/aiAgents/runService';
import { loadNarrativeContext } from '../../services/aiAgents/narrativeContext';
import { createOrganization, createPartner, createUser } from './db-utils';

/** Monday 07:00 UTC — the only cron shape `isWeeklyLiteralCron` admits. */
const NARRATIVE_CRON = '0 7 * * 1';
const SWEEP_CRON = '0 * * * *';
const SWEEP_KINDS: AiSweepKind[] = ['disk_pressure', 'stale_agents'];
const OCCURRENCE_KEY = '2026-08-31T07:00@UTC';
const SECOND_OCCURRENCE_KEY = '2026-09-07T07:00@UTC';

/** Wide caps on purpose: every skip this suite asserts must be the one the
 *  test is about, never an incidental concurrency/rate/cooldown trip. */
function agentPolicyFields() {
  return {
    enabled: true,
    mode: 'shadow' as const,
    model: null,
    toolAllowlist: [] as string[],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    // At the schema ceiling, not above it: `aiAgentLimitsSchema` caps the
    // narrative pair at 5/50 and `normalizeAgentPolicy` PARSES the stored row,
    // so an over-wide fixture fails policy resolution instead of widening.
    limits: {
      maxConcurrentRuns: 10,
      maxRunsPerHour: 100,
      maxBudgetCentsPerDay: 10_000,
      maxConcurrentSweepRuns: 10,
      maxSweepRunsPerHour: 200,
      maxConcurrentNarrativeRuns: 5,
      maxNarrativeRunsPerHour: 50,
    },
    triggers: { respectMaintenanceWindows: false },
    recipients: { userIds: [], roleIds: [] },
    instructions: null,
    cooldownSeconds: 0,
  };
}

interface Fixture {
  partner: { id: string };
  orgA: { id: string };
  orgB: { id: string };
  agent: { id: string };
  user: { id: string };
  /** kind: 'narrative' — weekly cron, no sweep kinds. */
  narrative: { id: string };
  /** kind: 'sweep' — the control that must stay untouched. */
  sweep: { id: string };
}

async function insertSchedule(values: Record<string, unknown>) {
  const [row] = await withSystemDbAccessContext(() =>
    db.insert(aiAgentSchedules).values(values as never).returning(),
  );
  return row!;
}

async function seedFixture(): Promise<Fixture> {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const user = await createUser({
    partnerId: partner.id,
    orgId: orgA.id,
    email: `narrative-${randomUUID()}@narrativefanout.test`,
  });

  // PARTNER baseline agent: resolveEffectiveAgentSystem returns null without
  // one, so no org under this partner could admit a run at all.
  const [agent] = await withSystemDbAccessContext(() =>
    db
      .insert(aiAgents)
      .values({
        partnerId: partner.id,
        orgId: null,
        kind: 'triage',
        name: 'Weekly Narrator',
        ...agentPolicyFields(),
        createdBy: user.id,
      })
      .returning(),
  );

  const narrative = await insertSchedule({
    orgId: null,
    partnerId: partner.id,
    agentId: agent!.id,
    baselineScheduleId: null,
    kind: 'narrative',
    cron: NARRATIVE_CRON,
    timezone: 'UTC',
    sweepKinds: [],
    enabled: true,
    createdBy: user.id,
    updatedAt: new Date(),
  });

  const sweep = await insertSchedule({
    orgId: null,
    partnerId: partner.id,
    agentId: agent!.id,
    baselineScheduleId: null,
    kind: 'sweep',
    cron: SWEEP_CRON,
    timezone: 'UTC',
    sweepKinds: SWEEP_KINDS,
    enabled: true,
    createdBy: user.id,
    updatedAt: new Date(),
  });

  return {
    partner,
    orgA,
    orgB,
    agent: { id: agent!.id },
    user: { id: user.id },
    narrative: { id: narrative.id },
    sweep: { id: sweep.id },
  };
}

async function runsForOrg(orgId: string) {
  return withSystemDbAccessContext(() =>
    db.select().from(aiAgentRuns).where(eq(aiAgentRuns.orgId, orgId)),
  );
}

/**
 * Drizzle wraps every driver error in a DrizzleQueryError whose own `.code` is
 * undefined — the real PostgresError is on `.cause` (the same trap
 * `utils/pgErrors.ts` exists for). A top-level `err.code` check matches
 * NOTHING a drizzle insert can throw, so a constraint assertion written that
 * way passes for the wrong reason.
 */
async function expectPgErrorCode(promise: Promise<unknown>, code: string): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (err) {
    thrown = err;
  }
  expect(thrown, `expected the insert to be rejected with SQLSTATE ${code}`).toBeDefined();
  const found = (thrown as { code?: string })?.code
    ?? ((thrown as { cause?: { code?: string } })?.cause)?.code;
  expect(found).toBe(code);
}

async function readSchedule(scheduleId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(aiAgentSchedules).where(eq(aiAgentSchedules.id, scheduleId)).limit(1),
  );
  return row!;
}

let enqueued: string[] = [];

beforeEach(() => {
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  publishEventMock.mockClear();
  enqueued = [];
  // Without a registered enqueuer every admitted run is immediately marked
  // failed/enqueue_failed by design, which would invalidate every assertion
  // about admitted runs below.
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

describe('narrative schedule fan-out (real Postgres)', () => {
  it('admits exactly one narrative-profile run per live org under the partner', async () => {
    const f = await seedFixture();

    const summary = await processSweepOccurrence({
      scheduleId: f.narrative.id,
      occurrenceKey: OCCURRENCE_KEY,
    });

    expect(summary).toMatchObject({
      occurrenceKey: OCCURRENCE_KEY,
      orgsTotal: 2,
      runsAdmitted: 2,
      runsSkipped: 0,
      skipReasons: {},
    });
    // The invariant the whole summary contract rests on.
    expect(summary.orgsTotal).toBe(summary.runsAdmitted + summary.runsSkipped);

    for (const org of [f.orgA, f.orgB]) {
      const runs = await runsForOrg(org.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        orgId: org.id,
        agentId: f.agent.id,
        // A narrative run is fleet-wide for the org, so it is device-less —
        // the same shape as a sweep run.
        deviceId: null,
        profile: 'narrative',
        triggerKind: 'schedule',
        scheduleId: f.narrative.id,
        status: 'queued',
      });
      expect(runs[0]!.dedupeKey).toBe(`narrative-${f.narrative.id}-${org.id}-${OCCURRENCE_KEY}`);
      expect(runs[0]!.triggerRef).toEqual({
        scheduleId: f.narrative.id,
        occurrenceKey: OCCURRENCE_KEY,
        kind: 'narrative',
      });
    }
    expect(enqueued).toHaveLength(2);

    // The summary really landed on the row, and carries no org identifier.
    const stored = await readSchedule(f.narrative.id);
    expect(stored.lastRunSummary).toMatchObject({ orgsTotal: 2, runsAdmitted: 2 });
    const serialized = JSON.stringify(stored.lastRunSummary);
    expect(serialized).not.toContain(f.orgA.id);
    expect(serialized).not.toContain(f.orgB.id);
  });

  it('an org override that disables is skipped as override_disabled and never admitted', async () => {
    const f = await seedFixture();
    // `enabled` is the ONLY lever an override of a narrative baseline has:
    // its kinds are `[]` on both sides (the CHECK), and its `kind` is pinned
    // to the baseline's by the composite FK.
    await insertSchedule({
      orgId: f.orgB.id,
      partnerId: null,
      agentId: f.agent.id,
      baselineScheduleId: f.narrative.id,
      kind: 'narrative',
      cron: NARRATIVE_CRON,
      timezone: 'UTC',
      sweepKinds: [],
      enabled: false,
      createdBy: f.user.id,
      updatedAt: new Date(),
    });

    const summary = await processSweepOccurrence({
      scheduleId: f.narrative.id,
      occurrenceKey: OCCURRENCE_KEY,
    });

    expect(summary).toMatchObject({
      orgsTotal: 2,
      runsAdmitted: 1,
      runsSkipped: 1,
      skipReasons: { override_disabled: 1 },
    });
    expect(await runsForOrg(f.orgA.id)).toHaveLength(1);
    expect(await runsForOrg(f.orgB.id)).toHaveLength(0);
  });

  it('re-running the SAME occurrence is a duplicate no-op; a new occurrence admits again', async () => {
    const f = await seedFixture();

    await processSweepOccurrence({ scheduleId: f.narrative.id, occurrenceKey: OCCURRENCE_KEY });
    const second = await processSweepOccurrence({
      scheduleId: f.narrative.id,
      occurrenceKey: OCCURRENCE_KEY,
    });

    // The skip is the REAL `(org_id, dedupe_key)` unique index, not a
    // hand-rolled pre-check — see agentRunAdmission.integration.test.ts.
    expect(second).toMatchObject({
      orgsTotal: 2,
      runsAdmitted: 0,
      runsSkipped: 2,
      skipReasons: { duplicate: 2 },
    });
    expect(await runsForOrg(f.orgA.id)).toHaveLength(1);
    expect(await runsForOrg(f.orgB.id)).toHaveLength(1);

    // Next week's occurrence has its own key, so it is NOT deduped — a dedupe
    // key that dropped `occurrenceKey` would make the schedule fire exactly
    // once and then never again.
    const third = await processSweepOccurrence({
      scheduleId: f.narrative.id,
      occurrenceKey: SECOND_OCCURRENCE_KEY,
    });
    expect(third).toMatchObject({ orgsTotal: 2, runsAdmitted: 2, runsSkipped: 0 });
    expect(await runsForOrg(f.orgA.id)).toHaveLength(2);
  });

  it('a SWEEP baseline under the same partner still admits sweep runs, untouched', async () => {
    const f = await seedFixture();

    const summary = await processSweepOccurrence({
      scheduleId: f.sweep.id,
      occurrenceKey: OCCURRENCE_KEY,
    });

    expect(summary).toMatchObject({ orgsTotal: 2, runsAdmitted: 2, runsSkipped: 0 });

    const runs = await runsForOrg(f.orgA.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ profile: 'sweep', scheduleId: f.sweep.id });
    expect(runs[0]!.dedupeKey).toBe(`sweep-${f.sweep.id}-${f.orgA.id}-${OCCURRENCE_KEY}`);
    expect(runs[0]!.triggerRef).toEqual({
      scheduleId: f.sweep.id,
      occurrenceKey: OCCURRENCE_KEY,
      sweepKinds: SWEEP_KINDS,
    });

    // Both baselines firing for the same org on the same occurrence key
    // produce TWO distinct runs — the profile-namespaced dedupe keys do not
    // collide. A shared `sweep-` prefix would silently drop one of them.
    await processSweepOccurrence({ scheduleId: f.narrative.id, occurrenceKey: OCCURRENCE_KEY });
    const both = await runsForOrg(f.orgA.id);
    expect(both).toHaveLength(2);
    expect(both.map((r) => r.profile).sort()).toEqual(['narrative', 'sweep']);
  });

  it('a narrative baseline sweeps NO kinds, which is exactly what makes a sweep baseline skip', async () => {
    // The control for the kind-gated empty-kinds guard: the stored narrative
    // row really does hold `'{}'` (the CHECK admits nothing else), and a SWEEP
    // baseline in that same shape skips every org. Without the gate the
    // narrative fan-out would never admit anything.
    const f = await seedFixture();
    const stored = await readSchedule(f.narrative.id);
    expect(stored.kind).toBe('narrative');
    expect(stored.sweepKinds).toEqual([]);

    const emptySweep = await insertSchedule({
      orgId: null,
      partnerId: f.partner.id,
      agentId: f.agent.id,
      baselineScheduleId: null,
      kind: 'sweep',
      cron: SWEEP_CRON,
      timezone: 'UTC',
      // Legal only because every org override tightens to `[]` too — the
      // partner arm of the CHECK requires at least one kind, so this is
      // forged through an org row instead. See the guard below.
      sweepKinds: SWEEP_KINDS,
      enabled: true,
      createdBy: f.user.id,
      updatedAt: new Date(),
    });
    for (const org of [f.orgA, f.orgB]) {
      await insertSchedule({
        orgId: org.id,
        partnerId: null,
        agentId: f.agent.id,
        baselineScheduleId: emptySweep.id,
        kind: 'sweep',
        cron: SWEEP_CRON,
        timezone: 'UTC',
        sweepKinds: [],
        enabled: true,
        createdBy: f.user.id,
        updatedAt: new Date(),
      });
    }

    const sweepSummary = await processSweepOccurrence({
      scheduleId: emptySweep.id,
      occurrenceKey: OCCURRENCE_KEY,
    });
    expect(sweepSummary).toMatchObject({
      runsAdmitted: 0,
      runsSkipped: 2,
      skipReasons: { override_disabled: 2 },
    });

    const narrativeSummary = await processSweepOccurrence({
      scheduleId: f.narrative.id,
      occurrenceKey: OCCURRENCE_KEY,
    });
    expect(narrativeSummary).toMatchObject({ runsAdmitted: 2, runsSkipped: 0 });
  });
});

describe('ai_agent_schedules.kind constraints (real Postgres)', () => {
  it("rejects an org override whose kind disagrees with its baseline's (23503)", async () => {
    // `ai_agent_schedules_baseline_kind_fk` is the composite self-FK
    // `(baseline_schedule_id, kind) -> (id, kind)`. It is the only thing
    // backing `createSchedule`'s "copy the baseline's kind" — an override that
    // wrote the column DEFAULT instead would flip one org's schedule into a
    // run profile the partner never configured.
    const f = await seedFixture();

    await expectPgErrorCode(
      insertSchedule({
        orgId: f.orgB.id,
        partnerId: null,
        agentId: f.agent.id,
        baselineScheduleId: f.narrative.id,
        kind: 'sweep',
        cron: NARRATIVE_CRON,
        timezone: 'UTC',
        sweepKinds: [],
        enabled: true,
        createdBy: f.user.id,
        updatedAt: new Date(),
      }),
      '23503',
    );

    expect(
      await withSystemDbAccessContext(() =>
        db
          .select({ id: aiAgentSchedules.id })
          .from(aiAgentSchedules)
          .where(and(eq(aiAgentSchedules.orgId, f.orgB.id), eq(aiAgentSchedules.baselineScheduleId, f.narrative.id))),
      ),
    ).toHaveLength(0);
  });

  it('rejects a narrative schedule that carries sweep kinds (23514)', async () => {
    const f = await seedFixture();

    await expectPgErrorCode(
      insertSchedule({
        orgId: null,
        partnerId: f.partner.id,
        agentId: f.agent.id,
        baselineScheduleId: null,
        kind: 'narrative',
        cron: NARRATIVE_CRON,
        timezone: 'UTC',
        sweepKinds: ['disk_pressure'] as AiSweepKind[],
        enabled: true,
        createdBy: f.user.id,
        updatedAt: new Date(),
      }),
      '23514',
    );
  });

  it('every schedule row a fixture writes really belongs to its own partner', async () => {
    // Guard against a seeding miss making the fan-out counts above vacuous.
    const f = await seedFixture();
    const orgs = await withSystemDbAccessContext(() =>
      db.select({ id: organizations.id }).from(organizations).where(eq(organizations.partnerId, f.partner.id)),
    );
    expect(orgs.map((o) => o.id).sort()).toEqual([f.orgA.id, f.orgB.id].sort());
  });
});

/**
 * The task-5 follow-up the wave carried open: `loadNarrativeContext`'s sixteen
 * hand-written statements had NEVER been executed against a real database.
 * Every unit test in `narrativeContext.test.ts` mocks `../../db` and asserts
 * COMPILED SQL, so the driver is never reached — and the driver is exactly
 * where they failed.
 *
 * A JS `Date` bound through a drizzle `sql` template is not serialisable by
 * postgres-js on this path (`TypeError: The "string" argument must be of type
 * string ... Received an instance of Date`), so every windowed loader rejected,
 * `settled()` recorded the block as `unavailable`, and the prompt would have
 * rendered the entire narrative as "(not measured)" — while the run itself
 * died on an unhandled rejection and never left `queued`. Found on the wave's
 * live wt-stack check, not by any suite.
 *
 * This test is the guard: it asserts the loaders actually RUN. Only the two
 * blocks that are structurally unavailable by design may appear in
 * `unavailable`; anything else means a statement threw.
 */
describe('loadNarrativeContext against real Postgres', () => {
  /** The seven windowed loaders. A statement that throws shows up as its own
   *  block name in `unavailable` AND as `available: false` — both are asserted,
   *  because the first is what a reader greps for and the second is what the
   *  prompt actually renders. */
  const LOADER_BLOCKS = ['alerts', 'sweeps', 'fixes', 'tickets', 'patching', 'backups', 'fleet'];

  it('executes every statement — no windowed loader block is reported unavailable', async () => {
    const f = await seedFixture();

    const context = await withSystemDbAccessContext(() => loadNarrativeContext(f.orgA.id));

    expect(context.alerts.available).toBe(true);
    expect(context.sweeps.available).toBe(true);
    expect(context.fixes.available).toBe(true);
    expect(context.tickets.available).toBe(true);
    // NOT `patching.available` — that flag tracks whether a posture SNAPSHOT
    // exists for the org, not whether the loader ran. A fixture org has none,
    // so the bare-name check below is what proves the statement executed.
    expect(context.backups.available).toBe(true);
    expect(context.fleet.available).toBe(true);

    // `unavailable` legitimately carries the two STRUCTURALLY_UNAVAILABLE
    // entries, and `patching.postureScores` for an org with no posture
    // snapshots — all sub-block names. A bare loader name in this list means a
    // statement threw.
    expect(context.unavailable.filter((entry) => LOADER_BLOCKS.includes(entry))).toEqual([]);
    expect(context.unavailable).toContain('alerts.suppressedInWindow');
    expect(context.unavailable).toContain('fleet.onlineOfflineDelta');
  });

  it('the header statement ran: the org identity comes back off the real row', async () => {
    const f = await seedFixture();

    const context = await withSystemDbAccessContext(() => loadNarrativeContext(f.orgA.id));

    expect(context.org.name).not.toBe('');
    expect(context.org.partnerName).not.toBe('');
    expect(context.period.start < context.period.end).toBe(true);
  });
});
