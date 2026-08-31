/**
 * Live-Postgres proof for the Phase 2 wave P2-2 scheduled sweeper (task 9).
 *
 * Three things here cannot be shown by a mocked-`../../db` unit suite, and
 * each of them has already been a real bug class in this repo:
 *
 *  1. **The fan-out is a property of real rows.** Which orgs a partner-wide
 *     schedule reaches (`partner_id` + `type <> 'quick_support'`), whether the
 *     org override actually tightens, and whether the per-org admission gate
 *     really refuses a circuit-open org are all Postgres answers. A mocked
 *     `where` returns whatever it is handed.
 *  2. **The tick's compare-and-set.** `last_occurrence_key IS NOT DISTINCT
 *     FROM $1::text` is the whole exactly-once story for a schedule that has
 *     never fired (`NULL = NULL` is NULL — an `=` form would never match, and
 *     the sweeper would re-enqueue the same occurrence every 5 minutes
 *     forever). Only a real UPDATE against a real row proves the binding.
 *  3. **Task 3's intent target scope, end to end from a DEVICE-LESS run.**
 *     A sweep run has `device_id IS NULL`, so an intent it mints is bound to
 *     one device only through `action_intents.scope_kind`/`scope_device_id`.
 *     The rebuild has to pin `allowedDeviceIds` to the SCOPE, and a deleted
 *     device has to tombstone the scope (FK `ON DELETE SET NULL`) and make
 *     release fail closed with `agent_scope_lost`. The tombstone transition is
 *     enforced by a DB trigger; there is no way to exercise it without a DB.
 *
 * It ALSO executes all six `loadSweepEvidence` statements (task 5) against
 * live Postgres for the first time — that module's own suite verifies the
 * statements STATICALLY (it reads the SQL text back), so nothing had ever
 * asked Postgres to parse or plan them. The fixture deliberately includes a
 * never-seen device and more than `SWEEP_EVIDENCE_MAX_ROWS_PER_KIND` stale
 * ones, because `NOT (last_seen_at < …)` over a NULL silently drops rows
 * (`[[sql_not_over_nullable_drops_rows]]`) and a bare `LIMIT MAX` makes
 * `truncated` unreachable.
 *
 * Lives under `src/__tests__/integration/` so both vitest configs' wholesale
 * globs pick it up — anywhere else runs in ZERO CI jobs.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// `AI_AGENTS_ENABLED` is a module-scope const in config/env, frozen at import
// time — `vi.stubEnv` cannot move it, and `processSweepTick` early-returns
// when it is false, which would make the tick assertions below vacuously
// green. `vi.hoisted` runs before every import in this file, including
// `./setup`'s transitive `config/env` load.
vi.hoisted(() => {
  process.env.BREEZE_AI_AGENTS_ENABLED = 'true';
});

// publishEvent writes to a Redis stream; spy on it instead (same precedent as
// agentRunAdmission.integration.test.ts).
const { publishEventMock } = vi.hoisted(() => ({
  publishEventMock: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'test-event-id'),
}));
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: publishEventMock };
});

import { AI_SWEEP_KINDS, type AiSweepKind } from '@breeze/shared';
import { db, withSystemDbAccessContext } from '../../db';
import {
  actionIntents,
  aiAgentRuns,
  aiAgentSchedules,
  aiAgents,
  backupConfigs,
  backupJobs,
  deviceDisks,
  deviceVulnerabilities,
  devices,
  organizations,
  serviceProcessCheckResults,
  vulnerabilities,
} from '../../db/schema';
import { aiAgentCircuitState } from '../../db/schema/aiAgentCircuitState';
import { AI_AGENTS_ENABLED } from '../../config/env';
import {
  getAiAgentSweepQueue,
  getSweepOccurrenceJobId,
  processSweepOccurrence,
  processSweepTick,
  shutdownAiAgentSweepScheduler,
} from '../../jobs/aiAgentSweepScheduler';
import { latestCronOccurrence } from '../../services/aiAgents/sweepOccurrence';
import {
  SWEEP_EVIDENCE_MAX_ROWS_PER_KIND,
  loadSweepEvidence,
} from '../../services/aiAgents/sweepEvidence';
import {
  registerAgentRunEnqueuer,
  type AgentRunEnqueuer,
} from '../../services/aiAgents/runService';
import { buildAgentAuthContext } from '../../services/aiAgents/agentAuthContext';
import { createActionIntent } from '../../services/actionIntents/intentService';
import { buildAuthContextForIntent } from '../../services/actionIntents/actorContext';
import { IntentScopeLostError } from '../../services/actionIntents/intentTargetScope';
import { revalidateApprovedIntentForRelease } from '../../services/actionIntents/revalidateRelease';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';

const TOOL_NAME = 'manage_services';
const SERVICE_NAME = 'spooler';
const BASELINE_KINDS: AiSweepKind[] = ['disk_pressure', 'stale_agents'];

/** Wide caps on purpose: every skip this suite asserts must be the one the
 *  test is about, never an incidental concurrency/rate/cooldown trip. */
function agentPolicyFields() {
  return {
    enabled: true,
    mode: 'shadow' as const,
    model: null,
    toolAllowlist: [TOOL_NAME],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    // At the schema ceiling, not above it: `aiAgentLimitsSchema` caps both
    // concurrency fields at 10 and `normalizeAgentPolicy` PARSES the stored
    // row, so an over-wide fixture fails policy resolution instead of
    // widening the caps.
    limits: {
      maxConcurrentRuns: 10,
      maxRunsPerHour: 100,
      maxBudgetCentsPerDay: 10_000,
      maxConcurrentSweepRuns: 10,
      maxSweepRunsPerHour: 100,
    },
    triggers: { respectMaintenanceWindows: false },
    recipients: { userIds: [], roleIds: [] },
    instructions: null,
    cooldownSeconds: 0,
  };
}

/**
 * Direct org insert for the shapes db-utils' typed options cannot express —
 * `type: 'quick_support'` and the non-live statuses (`offboarding`, …) this
 * suite needs as negative controls.
 */
async function insertOrg(
  partnerId: string,
  over: { type?: 'customer' | 'quick_support'; status?: string; deletedAt?: Date | null } = {},
): Promise<{ id: string }> {
  const unique = randomUUID().slice(0, 8);
  const [org] = await withSystemDbAccessContext(() =>
    db
      .insert(organizations)
      .values({
        partnerId,
        name: `Sweep org ${unique}`,
        slug: `sweep-org-${unique}`,
        type: (over.type ?? 'customer') as 'customer',
        status: (over.status ?? 'active') as 'active',
        deletedAt: over.deletedAt ?? null,
        currencyCode: 'USD',
      })
      .returning({ id: organizations.id }),
  );
  return org!;
}

async function insertDevice(orgId: string, siteId: string, over: Record<string, unknown> = {}) {
  const unique = randomUUID().slice(0, 8);
  const [device] = await withSystemDbAccessContext(() =>
    db
      .insert(devices)
      .values({
        orgId,
        siteId,
        agentId: `sweep-agent-${unique}`,
        hostname: `sweep-host-${unique}`,
        osType: 'linux',
        osVersion: '22.04',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'online',
        lastSeenAt: new Date(),
        ...over,
      })
      .returning(),
  );
  return device!;
}

// ---------------------------------------------------------------------------
// Fan-out fixture
// ---------------------------------------------------------------------------

interface Fixture {
  partner: { id: string };
  orgA: { id: string };
  orgB: { id: string };
  orgQuickSupport: { id: string };
  orgOffboarding: { id: string };
  orgDeleted: { id: string };
  siteA: { id: string };
  agent: { id: string; name: string };
  baseline: { id: string; cron: string; timezone: string };
  device: typeof devices.$inferSelect;
}

async function seedFixture(): Promise<Fixture> {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  // The partner's hidden holder for ephemeral support enrolments — the org a
  // scheduled hygiene sweep must never reach. Inserted directly: db-utils'
  // `CreateOrganizationOptions.type` only admits 'customer' | 'internal'.
  const orgQuickSupport = await insertOrg(partner.id, { type: 'quick_support' });
  // Two dead-tenant negative controls: a lifecycle status outside
  // ['active','trial'] and a soft-deleted org. Neither may be swept, and
  // neither may be COUNTED — they must be absent from `orgsTotal`, not merely
  // skipped inside it.
  const orgOffboarding = await insertOrg(partner.id, { status: 'offboarding' });
  const orgDeleted = await insertOrg(partner.id, { deletedAt: new Date() });
  const siteA = await createSite({ orgId: orgA.id });
  const user = await createUser({
    partnerId: partner.id,
    orgId: orgA.id,
    email: `sweep-${randomUUID()}@sweepfanout.test`,
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
        name: 'Nightly Sweeper',
        ...agentPolicyFields(),
        createdBy: user.id,
      })
      .returning(),
  );

  const [baseline] = await withSystemDbAccessContext(() =>
    db
      .insert(aiAgentSchedules)
      .values({
        orgId: null,
        partnerId: partner.id,
        agentId: agent!.id,
        baselineScheduleId: null,
        cron: '0 * * * *',
        timezone: 'UTC',
        sweepKinds: BASELINE_KINDS,
        enabled: true,
        createdBy: user.id,
        updatedAt: new Date(),
      })
      .returning(),
  );

  // Org B tightens itself out entirely (enabled: false) — the fan-out must
  // count it and skip it, never admit for it.
  await withSystemDbAccessContext(() =>
    db.insert(aiAgentSchedules).values({
      orgId: orgB.id,
      partnerId: null,
      agentId: agent!.id,
      baselineScheduleId: baseline!.id,
      cron: baseline!.cron,
      timezone: baseline!.timezone,
      sweepKinds: ['disk_pressure'] as AiSweepKind[],
      enabled: false,
      createdBy: user.id,
      updatedAt: new Date(),
    }),
  );

  const device = await insertDevice(orgA.id, siteA.id);

  return {
    partner,
    orgA,
    orgB,
    orgQuickSupport,
    orgOffboarding,
    orgDeleted,
    siteA,
    agent: { id: agent!.id, name: agent!.name },
    baseline: { id: baseline!.id, cron: baseline!.cron, timezone: baseline!.timezone },
    device,
  };
}

async function runsForOrg(orgId: string) {
  return withSystemDbAccessContext(() =>
    db.select().from(aiAgentRuns).where(eq(aiAgentRuns.orgId, orgId)),
  );
}

async function readSchedule(scheduleId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(aiAgentSchedules).where(eq(aiAgentSchedules.id, scheduleId)).limit(1),
  );
  return row!;
}

async function readIntent(intentId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(actionIntents).where(eq(actionIntents.id, intentId)).limit(1),
  );
  return row!;
}

const OCCURRENCE_KEY = '2026-08-29T06:00@UTC';

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

afterAll(async () => {
  // The tick test writes real BullMQ jobs to the shared test Redis.
  try {
    await getAiAgentSweepQueue().obliterate({ force: true });
  } catch {
    // The queue may never have been created (only the tick test builds it).
  }
  await shutdownAiAgentSweepScheduler();
});

describe('sweep fan-out (real Postgres)', () => {
  it('admits exactly one sweep run for org A, none for org B (override disabled), none for quick_support', async () => {
    const f = await seedFixture();

    const summary = await processSweepOccurrence({
      scheduleId: f.baseline.id,
      occurrenceKey: OCCURRENCE_KEY,
    });

    expect(summary).toMatchObject({
      occurrenceKey: OCCURRENCE_KEY,
      // The quick_support org is not counted at all — it is excluded by the
      // enumeration predicate, not skipped after the fact.
      orgsTotal: 2,
      runsAdmitted: 1,
      runsSkipped: 1,
      skipReasons: { override_disabled: 1 },
    });

    const aRuns = await runsForOrg(f.orgA.id);
    expect(aRuns).toHaveLength(1);
    expect(aRuns[0]).toMatchObject({
      orgId: f.orgA.id,
      agentId: f.agent.id,
      deviceId: null,
      profile: 'sweep',
      triggerKind: 'schedule',
      scheduleId: f.baseline.id,
      status: 'queued',
    });
    expect(aRuns[0]!.dedupeKey).toBe(`sweep-${f.baseline.id}-${f.orgA.id}-${OCCURRENCE_KEY}`);
    expect(aRuns[0]!.triggerRef).toEqual({
      scheduleId: f.baseline.id,
      occurrenceKey: OCCURRENCE_KEY,
      sweepKinds: BASELINE_KINDS,
    });
    expect(enqueued).toEqual([aRuns[0]!.id]);

    expect(await runsForOrg(f.orgB.id)).toHaveLength(0);
    expect(await runsForOrg(f.orgQuickSupport.id)).toHaveLength(0);
    expect(await runsForOrg(f.orgOffboarding.id)).toHaveLength(0);
    expect(await runsForOrg(f.orgDeleted.id)).toHaveLength(0);

    // The summary really landed on the row, and carries no org identifier.
    const stored = await readSchedule(f.baseline.id);
    expect(stored.lastRunSummary).toMatchObject({ orgsTotal: 2, runsAdmitted: 1 });
    const serialized = JSON.stringify(stored.lastRunSummary);
    expect(serialized).not.toContain(f.orgA.id);
    expect(serialized).not.toContain(f.orgB.id);
  });

  it('a non-live org (offboarding, or soft-deleted) gets no run and is not even counted', async () => {
    const f = await seedFixture();

    const summary = await processSweepOccurrence({
      scheduleId: f.baseline.id,
      occurrenceKey: OCCURRENCE_KEY,
    });

    // Five orgs exist under this partner (A, B, quick_support, offboarding,
    // soft-deleted); exactly two are live customers. Excluded by the
    // ENUMERATION predicate, so they never reach the skip tally either.
    expect(summary.orgsTotal).toBe(2);
    expect(summary.runsAdmitted + summary.runsSkipped).toBe(2);
    expect(await runsForOrg(f.orgOffboarding.id)).toHaveLength(0);
    expect(await runsForOrg(f.orgDeleted.id)).toHaveLength(0);

    // Control: the two dead orgs really are under this partner and really do
    // hold the states under test, so the zero above is the predicate's doing
    // and not a seeding miss.
    const partnerOrgs = await withSystemDbAccessContext(() =>
      db
        .select({ id: organizations.id, status: organizations.status, deletedAt: organizations.deletedAt })
        .from(organizations)
        .where(eq(organizations.partnerId, f.partner.id)),
    );
    expect(partnerOrgs).toHaveLength(5);
    expect(partnerOrgs.find((o) => o.id === f.orgOffboarding.id)!.status).toBe('offboarding');
    expect(partnerOrgs.find((o) => o.id === f.orgDeleted.id)!.deletedAt).not.toBeNull();
  });

  it('re-running the same occurrence is a no-op (dedupe)', async () => {
    const f = await seedFixture();

    await processSweepOccurrence({ scheduleId: f.baseline.id, occurrenceKey: OCCURRENCE_KEY });
    const second = await processSweepOccurrence({ scheduleId: f.baseline.id, occurrenceKey: OCCURRENCE_KEY });

    // The skip is the REAL (org_id, dedupe_key) unique constraint, not a
    // hand-rolled pre-check — see agentRunAdmission.integration.test.ts.
    expect(second).toMatchObject({
      orgsTotal: 2,
      runsAdmitted: 0,
      runsSkipped: 2,
      skipReasons: { duplicate: 1, override_disabled: 1 },
    });
    expect(await runsForOrg(f.orgA.id)).toHaveLength(1);
  });

  it('circuit-open org is skipped and counted in last_run_summary.skipReasons.circuit_open', async () => {
    const f = await seedFixture();

    await withSystemDbAccessContext(() =>
      db.insert(aiAgentCircuitState).values({
        orgId: f.orgA.id,
        agentId: f.agent.id,
        partnerId: f.partner.id,
        consecutiveFailures: 5,
        state: 'open',
        openedAt: new Date(),
        openedReason: 'test fixture',
      }),
    );

    const summary = await processSweepOccurrence({
      scheduleId: f.baseline.id,
      occurrenceKey: OCCURRENCE_KEY,
    });

    expect(summary.skipReasons).toEqual({ circuit_open: 1, override_disabled: 1 });
    expect(summary.runsAdmitted).toBe(0);
    expect(await runsForOrg(f.orgA.id)).toHaveLength(0);

    const stored = await readSchedule(f.baseline.id);
    expect((stored.lastRunSummary as { skipReasons: Record<string, number> }).skipReasons.circuit_open).toBe(1);
  });

  it('the tick claims the occurrence with a compare-and-set and never re-claims it', async () => {
    const f = await seedFixture();
    // Guard against a vacuous pass: the tick short-circuits with the kill
    // switch off, and this const is frozen at import time.
    expect(AI_AGENTS_ENABLED).toBe(true);

    const expected = latestCronOccurrence(f.baseline.cron, f.baseline.timezone, new Date());
    expect(expected).not.toBeNull();

    const first = await processSweepTick();
    expect(first).toMatchObject({ scanned: 1, enqueued: 1 });

    const afterFirst = await readSchedule(f.baseline.id);
    // The CAS matched on `last_occurrence_key IS NOT DISTINCT FROM NULL` —
    // the first-firing case an `=` comparison could never satisfy.
    expect(afterFirst.lastOccurrenceKey).toBe(expected!.key);
    expect(afterFirst.lastEnqueuedAt).not.toBeNull();

    const second = await processSweepTick();
    expect(second).toMatchObject({ scanned: 1, enqueued: 0 });
    const afterSecond = await readSchedule(f.baseline.id);
    expect(afterSecond.lastOccurrenceKey).toBe(expected!.key);
    expect(afterSecond.lastEnqueuedAt?.getTime()).toBe(afterFirst.lastEnqueuedAt?.getTime());

    // And the job that was added carries the deterministic, colon-free id.
    const job = await getAiAgentSweepQueue().getJob(getSweepOccurrenceJobId(f.baseline.id, expected!.key));
    expect(job).toBeDefined();
    expect(job!.data).toMatchObject({ scheduleId: f.baseline.id, occurrenceKey: expected!.key });
  });

  it('a scoped intent created from the device-less run releases with allowedDeviceIds pinned to the scope device', async () => {
    const f = await seedFixture();
    await processSweepOccurrence({ scheduleId: f.baseline.id, occurrenceKey: OCCURRENCE_KEY });
    const [run] = await runsForOrg(f.orgA.id);
    expect(run!.deviceId).toBeNull();

    // The auth context a sweep-profile run holds: device-LESS, so it carries
    // no allowedDeviceIds of its own.
    const agentAuth = buildAgentAuthContext(
      { id: f.agent.id, orgId: null, partnerId: f.partner.id, name: f.agent.name, kind: 'triage' },
      { id: run!.id, orgId: f.orgA.id, deviceId: null, deviceSiteId: null },
      { id: f.orgA.id, partnerId: f.partner.id },
    );
    expect(agentAuth.allowedDeviceIds).toBeUndefined();

    const snapshot = await createActionIntent(agentAuth, {
      toolName: TOOL_NAME,
      input: { deviceId: f.device.id, action: 'restart', serviceName: SERVICE_NAME },
      source: 'ai_agent',
      scope: { deviceId: f.device.id },
    });

    const intent = await readIntent(snapshot.id);
    expect(intent.scopeKind).toBe('device');
    expect(intent.scopeDeviceId).toBe(f.device.id);

    const rebuilt = await buildAuthContextForIntent(intent);
    expect(rebuilt).not.toBeNull();
    // The rebuild follows the SCOPE, not the run — a device-less run would
    // otherwise produce an unscoped, org-wide agent context.
    expect(rebuilt!.allowedDeviceIds).toEqual([f.device.id]);
    expect(rebuilt!.allowedSiteIds).toEqual([f.siteA.id]);
    expect(rebuilt!.orgId).toBe(f.orgA.id);
  });

  it('deleting the scoped device tombstones the intent and release fails closed with agent_scope_lost', async () => {
    const f = await seedFixture();
    await processSweepOccurrence({ scheduleId: f.baseline.id, occurrenceKey: OCCURRENCE_KEY });
    const [run] = await runsForOrg(f.orgA.id);

    const agentAuth = buildAgentAuthContext(
      { id: f.agent.id, orgId: null, partnerId: f.partner.id, name: f.agent.name, kind: 'triage' },
      { id: run!.id, orgId: f.orgA.id, deviceId: null, deviceSiteId: null },
      { id: f.orgA.id, partnerId: f.partner.id },
    );
    const snapshot = await createActionIntent(agentAuth, {
      toolName: TOOL_NAME,
      input: { deviceId: f.device.id, action: 'restart', serviceName: SERVICE_NAME },
      source: 'ai_agent',
      scope: { deviceId: f.device.id },
    });

    // The FK is ON DELETE SET NULL, and non-null -> NULL is the ONE transition
    // the action_intents immutability trigger permits.
    await withSystemDbAccessContext(() => db.delete(devices).where(eq(devices.id, f.device.id)));

    const tombstoned = await readIntent(snapshot.id);
    expect(tombstoned.scopeKind).toBe('device');
    expect(tombstoned.scopeDeviceId).toBeNull();

    await expect(buildAuthContextForIntent(tombstoned)).rejects.toBeInstanceOf(IntentScopeLostError);

    // The release path must return the terminal code, not let the throw
    // escape — BullMQ would redeliver forever for a device that is gone.
    const result = await revalidateApprovedIntentForRelease(tombstoned, {
      boundArgumentDigest: tombstoned.argumentDigest,
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'agent_scope_lost' });
  });
});

// ---------------------------------------------------------------------------
// Task 5's six evidence statements, executed for real
// ---------------------------------------------------------------------------

/** One stale-matching device more than the loader's `MAX + 1` fetch window,
 *  so `truncated` has something to be true about. */
const STALE_WITH_LAST_SEEN = 27;

describe('loadSweepEvidence against real Postgres (all six statements)', () => {
  async function seedEvidence(): Promise<{ orgId: string; neverSeenDeviceId: string }> {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });

    // stale_agents — a device that has NEVER checked in (last_seen_at NULL,
    // enrolled 8 days ago) plus enough long-silent ones to blow the cap.
    const neverSeen = await insertDevice(org.id, site.id, {
      lastSeenAt: null,
      createdAt: new Date(Date.now() - 8 * 24 * 3_600_000),
      status: 'offline',
    });
    for (let i = 0; i < STALE_WITH_LAST_SEEN; i++) {
      await insertDevice(org.id, site.id, {
        lastSeenAt: new Date(Date.now() - (10 + i) * 24 * 3_600_000),
        status: 'offline',
      });
    }

    // Every other fixture device is freshly seen, so it matches ONLY its own
    // kind and the stale counts above stay exact.
    const diskDevice = await insertDevice(org.id, site.id);
    await withSystemDbAccessContext(() =>
      db.insert(deviceDisks).values({
        deviceId: diskDevice.id,
        orgId: org.id,
        mountPoint: '/',
        totalGb: 100,
        usedGb: 93,
        freeGb: 7,
        usedPercent: 93,
      }),
    );

    const rebootDevice = await insertDevice(org.id, site.id, { pendingReboot: true });
    void rebootDevice;

    const backupDevice = await insertDevice(org.id, site.id);
    const [config] = await withSystemDbAccessContext(() =>
      db
        .insert(backupConfigs)
        .values({
          orgId: org.id,
          name: 'Nightly files',
          type: 'file',
          provider: 'local',
          providerConfig: { path: '/var/backups' },
        })
        .returning(),
    );
    await withSystemDbAccessContext(() =>
      db.insert(backupJobs).values({
        orgId: org.id,
        configId: config!.id,
        deviceId: backupDevice.id,
        status: 'failed',
        startedAt: new Date(Date.now() - 2 * 24 * 3_600_000),
        errorCount: 3,
      }),
    );

    const serviceDevice = await insertDevice(org.id, site.id);
    await withSystemDbAccessContext(() =>
      db.insert(serviceProcessCheckResults).values({
        orgId: org.id,
        deviceId: serviceDevice.id,
        watchType: 'service',
        name: SERVICE_NAME,
        status: 'stopped',
        autoRestartAttempted: true,
        autoRestartSucceeded: false,
        timestamp: new Date(Date.now() - 3_600_000),
      }),
    );

    const vulnDevice = await insertDevice(org.id, site.id);
    const [vuln] = await withSystemDbAccessContext(() =>
      db
        .insert(vulnerabilities)
        .values({
          cveId: `CVE-2026-${randomUUID().slice(0, 6)}`,
          source: 'nvd',
          description: 'Fixture critical',
          // Mixed casing on purpose: the loader lower()s it, because upstream
          // feeds disagree.
          severity: 'CRITICAL',
          cvssScore: '9.8',
          knownExploited: true,
          rawPayload: {},
        })
        .returning(),
    );
    await withSystemDbAccessContext(() =>
      db.insert(deviceVulnerabilities).values({
        orgId: org.id,
        deviceId: vulnDevice.id,
        vulnerabilityId: vuln!.id,
        status: 'open',
        detectedAt: new Date(),
      }),
    );

    return { orgId: org.id, neverSeenDeviceId: neverSeen.id };
  }

  it('runs every kind, reports REAL totals, and surfaces the never-seen device first', async () => {
    const { orgId, neverSeenDeviceId } = await seedEvidence();

    const evidence = await withSystemDbAccessContext(() =>
      loadSweepEvidence(orgId, [...AI_SWEEP_KINDS]),
    );

    // Every requested kind ran — an absent key would read to the model as
    // "this check did not run".
    expect(Object.keys(evidence.kinds).sort()).toEqual([...AI_SWEEP_KINDS].sort());

    for (const kind of AI_SWEEP_KINDS) {
      expect(evidence.kinds[kind]!.rows.length, `${kind} returned no rows`).toBeGreaterThan(0);
    }

    expect(evidence.kinds.disk_pressure).toMatchObject({ total: 1, truncated: false });
    expect(evidence.kinds.disk_pressure!.rows[0]!.fields).toMatchObject({
      mountPoint: '/', usedPercent: 93, freeGb: 7, totalGb: 100,
    });

    expect(evidence.kinds.pending_reboots).toMatchObject({ total: 1, truncated: false });
    expect(evidence.kinds.failed_backups).toMatchObject({ total: 1, truncated: false });
    expect(evidence.kinds.failed_backups!.rows[0]!.fields).toMatchObject({
      configName: 'Nightly files', errorCount: 3,
    });
    expect(evidence.kinds.service_down).toMatchObject({ total: 1, truncated: false });
    expect(evidence.kinds.service_down!.rows[0]!.fields).toMatchObject({
      name: SERVICE_NAME, status: 'stopped', autoRestartAttempted: true, autoRestartSucceeded: false,
    });
    expect(evidence.kinds.unpatched_critical).toMatchObject({ total: 1, truncated: false });
    expect(evidence.kinds.unpatched_critical!.rows[0]!.fields).toMatchObject({
      openCriticalCount: 1, knownExploited: true,
    });
    expect(
      (evidence.kinds.unpatched_critical!.rows[0]!.fields.deviceVulnerabilityIds as string).length,
    ).toBeGreaterThan(0);

    // stale_agents: the REAL count (never-seen + every long-silent device),
    // not the capped sample — the model may quote `total` and name `rows`.
    const stale = evidence.kinds.stale_agents!;
    expect(stale.total).toBe(STALE_WITH_LAST_SEEN + 1);
    expect(stale.total).toBeGreaterThan(26);
    expect(stale.rows).toHaveLength(SWEEP_EVIDENCE_MAX_ROWS_PER_KIND);
    expect(stale.truncated).toBe(true);
    expect(evidence.truncated).toBe(true);
    // NULLS FIRST: the device that has never checked in is the stalest of all
    // and must not be dropped by a `last_seen_at < …` predicate over NULL.
    expect(stale.rows[0]!.deviceId).toBe(neverSeenDeviceId);
    expect(stale.rows[0]!.fields.lastSeenAt).toBeNull();
  });

  it('an org with nothing to report gets every kind back, empty — never a missing key', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    const evidence = await withSystemDbAccessContext(() =>
      loadSweepEvidence(org.id, [...AI_SWEEP_KINDS]),
    );

    for (const kind of AI_SWEEP_KINDS) {
      expect(evidence.kinds[kind]).toEqual({ rows: [], total: 0, truncated: false });
    }
    expect(evidence.truncated).toBe(false);
  });

  it('evidence is pinned to the org — a sibling tenant\'s rows never appear', async () => {
    const { orgId } = await seedEvidence();
    const otherPartner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: otherPartner.id });

    const mine = await withSystemDbAccessContext(() => loadSweepEvidence(orgId, ['disk_pressure']));
    const theirs = await withSystemDbAccessContext(() => loadSweepEvidence(otherOrg.id, ['disk_pressure']));

    expect(mine.kinds.disk_pressure!.total).toBe(1);
    expect(theirs.kinds.disk_pressure!.total).toBe(0);
  });
});
