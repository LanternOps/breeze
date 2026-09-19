/**
 * Fleet Designer W01 (#5651), Task 13 — `persistFleetDesignReport`,
 * `loadDesignEvidence` and the `design` schedule kind against live
 * PostgreSQL, as the unprivileged `breeze_app` role with forced RLS on.
 *
 * Direct sibling of `aiAgentNarrativeReport.integration.test.ts` — read that
 * file's header for the shared rationale (partial-unique upsert, the
 * system-principal shape CHECK, the run-link CAS, GDPR erasure). Two things
 * are specific to the Fleet Design lane and cannot be shown by the mocked-db
 * unit suites:
 *
 *  1. **The definition is keyed on the ORG, not the schedule**
 *     (`reports_ai_fleet_design_org_uniq`, `org_id) WHERE type =
 *     'ai_fleet_design'`) — a manual run has no schedule to key on, so a
 *     second persist for the same org (manual or scheduled) must reuse the
 *     SAME definition row. Getting the partial-index predicate wrong raises
 *     42P10 instead of doing nothing, exactly like the narrative's
 *     schedule-keyed index.
 *  2. **`loadDesignEvidence` is a dozen hand-written, org-pinned statements**
 *     that have never been asked to plan against real Postgres before (each
 *     loader's own unit suite only verifies `assembleDesignEvidence`, the
 *     pure post-processing step) — a sibling tenant's device must never
 *     appear in the bundle.
 *  3. **The schedule fan-out's THIRD arm.** `aiAgentSweepFanout.integration.test.ts`
 *     proves the `sweep`/`narrative` arms; this file proves `design` picks
 *     the right agent KIND (`designer`, not `triage`) and that
 *     `createSchedule` refuses a design baseline pointed at a triage agent
 *     before a single row is written.
 *
 * Lives under `src/__tests__/integration/` so both vitest configs' wholesale
 * globs pick it up — anywhere else runs in ZERO CI jobs.
 */
import './setup';

// `AI_AGENTS_ENABLED` is a module-scope const in config/env, frozen at import
// time — `vi.stubEnv` alone cannot move it (see aiAgentSweepFanout's header).
// `vi.hoisted` runs before every import in this file, including `./setup`'s
// transitive `config/env` load.
import { vi } from 'vitest';
vi.hoisted(() => {
  process.env.BREEZE_AI_AGENTS_ENABLED = 'true';
});

// publishEvent writes to a Redis stream; spy on it instead of exercising real
// Redis (same precedent as aiAgentSweepFanout.integration.test.ts).
const { publishEventMock } = vi.hoisted(() => ({
  publishEventMock: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'test-event-id'),
}));
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: publishEventMock };
});

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  fleetDesignOutcomeFromSubmission,
  type FleetDesignOutcome,
  type FleetDesignOutcomeRefs,
  type FleetDesignSubmission,
} from '@breeze/shared';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import {
  db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext,
} from '../../db';
import { aiAgentRuns, aiAgents, aiAgentSchedules, devices, reportRuns, reports, scripts, scriptTags, scriptToTags } from '../../db/schema';
import { persistedSystemSiteScopeValues, systemReportAuthority } from '../../services/siteScope';
import {
  FleetDesignPersistConflictError,
  loadFleetDesignReport,
  persistFleetDesignReport,
  type FleetDesignPersistInput,
} from '../../services/aiAgents/fleetDesignReport';
import { designBaselineNumbers, loadDesignEvidence, type DesignEvidence } from '../../services/aiAgents/designEvidence';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
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

/** A monthly-or-rarer literal cron — the floor `isMonthlyOrRarerLiteralCron`
 *  requires for a `design` schedule (mirrors scheduleService.test.ts's own
 *  DESIGN_CRON constant). */
const DESIGN_CRON = '0 6 1 * *';

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
      agentId: `design-agent-${unique}`,
      hostname: `design-host-${unique}`,
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

// ---------------------------------------------------------------------------
// Fixture: one org with one device, a `designer` agent, and a manual
// (schedule-less) design run — the shape `persistFleetDesignReport` and
// `loadDesignEvidence` are exercised against in cases 1-5.
// ---------------------------------------------------------------------------

interface Fixture {
  partnerId: string;
  userId: string;
  orgId: string;
  otherOrgId: string;
  agentId: string;
  deviceId: string;
  runId: string;
}

async function seedRun(f: Omit<Fixture, 'runId'>): Promise<string> {
  const [row] = await withDbAccessContext(SYSTEM_CTX, () => db
    .insert(aiAgentRuns)
    .values({
      agentId: f.agentId,
      orgId: f.orgId,
      deviceId: null,
      profile: 'design',
      scheduleId: null,
      triggerKind: 'manual',
      triggerRef: { requestedByUserId: f.userId, agentId: f.agentId, siteId: null },
      dedupeKey: `design-manual-${randomUUID()}`,
      modeAtStart: 'act',
      policySnapshot: {} as never,
      status: 'running',
    })
    .returning({ id: aiAgentRuns.id }));
  return row!.id;
}

async function seed(): Promise<Fixture> {
  const partner = await createPartner();
  const user = await createUser({ partnerId: partner.id });
  const org = await createOrganization({ partnerId: partner.id });
  const otherOrg = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const otherSite = await createSite({ orgId: otherOrg.id });

  const device = await insertDevice(org.id, site.id);
  // Sibling-tenant device: never reachable from org A's evidence bundle.
  await insertDevice(otherOrg.id, otherSite.id);

  const [agent] = await withDbAccessContext(SYSTEM_CTX, () => db
    .insert(aiAgents)
    .values({ kind: 'designer', name: 'Fleet Designer', orgId: null, partnerId: partner.id, createdBy: user.id })
    .returning({ id: aiAgents.id }));

  const withoutRun = {
    partnerId: partner.id,
    userId: user.id,
    orgId: org.id,
    otherOrgId: otherOrg.id,
    agentId: agent!.id,
    deviceId: device.id,
  };
  return { ...withoutRun, runId: await seedRun(withoutRun) };
}

/** A minimal, schema-valid `FleetDesignSubmission` whose only device
 *  reference is the fixture's own seeded device — see
 *  `fleetDesign.test.ts`'s `validSubmission()` for the source shape. */
function submission(deviceId: string): FleetDesignSubmission {
  return {
    found: {
      summary: ['12 devices across 2 sites.'],
      findings: [{ title: 'Shared local admin on 4 workstations', deviceCount: 4, evidence: ['posture:localAdmin'] }],
    },
    functions: [
      { functionKey: 'file_server', deviceIds: [deviceId], confidence: 0.9, evidence: ['SMB listener; 2 TB data volume'] },
    ],
    monitoring: [
      {
        functionKey: 'file_server',
        watches: [{
          watchType: 'service', name: 'LanmanServer', alertOnStop: true, autoRestart: true,
          rationale: 'SMB is the function.',
        }],
        alertRules: [{
          name: 'File server disk over 85%', severity: 'high',
          conditions: [{ type: 'metric', metric: 'disk', operator: 'gt', value: 85, durationMinutes: 15 }],
          cooldownMinutes: 60, rationale: 'Data volume growth is the failure mode.', action: 'none', paging: 'business_hours',
        }],
      },
    ],
    retired: [],
    automation: [{ functionKey: 'file_server', playbooks: [{ builtInName: 'Restart stopped service' }], scripts: [] }],
    legacy: [],
    baseline: { notes: ['Alert rate is dominated by disk warnings.'] },
    unsure: {
      lowConfidenceFunctions: [], unreachableDevices: [], needsHuman: [], roleCorrections: [],
    },
  };
}

function buildOutcome(evidence: DesignEvidence, deviceId: string): FleetDesignOutcome {
  const refs: FleetDesignOutcomeRefs = {
    deviceIds: evidence.deviceIds,
    baseline: designBaselineNumbers(evidence),
    generatedAt: new Date().toISOString(),
  };
  return fleetDesignOutcomeFromSubmission(submission(deviceId), refs);
}

function input(f: Fixture, evidence: DesignEvidence, outcome: FleetDesignOutcome, runId = f.runId): FleetDesignPersistInput {
  return {
    run: { id: runId, orgId: f.orgId, agentId: f.agentId, scheduleId: null },
    agent: { id: f.agentId, name: 'Fleet Designer' },
    evidence,
    outcome,
  };
}

describe('persistFleetDesignReport / loadDesignEvidence against live Postgres (Fleet Designer W01, Task 13)', () => {
  runDb('persists a system-authored definition + artifact, links the run', async () => {
    const f = await seed();
    const evidence = await withSystemDbAccessContext(() => loadDesignEvidence(f.orgId, {}));
    const outcome = await buildOutcome(evidence, f.deviceId);

    const result = await persistFleetDesignReport(input(f, evidence, outcome));

    const [definition] = (await getTestDb().execute(sql`
      SELECT id, org_id, type, execution_scope_principal_kind, source_ai_agent_schedule_id, schedule, format
        FROM reports WHERE id = ${result.reportId}::uuid
    `)) as unknown as Array<Record<string, unknown>>;
    expect(definition).toBeDefined();
    expect(definition!.org_id).toBe(f.orgId);
    expect(definition!.type).toBe('ai_fleet_design');
    expect(definition!.execution_scope_principal_kind).toBe('system');
    expect(definition!.source_ai_agent_schedule_id).toBeNull();
    expect(definition!.schedule).toBe('one_time');
    expect(definition!.format).toBe('pdf');

    const [artifact] = (await getTestDb().execute(sql`
      SELECT id, report_id, requested_by_kind,
             result->'summary'->'fleetDesign'->'outcome'->>'schemaVersion' AS schema_version
        FROM report_runs WHERE id = ${result.reportRunId}::uuid
    `)) as unknown as Array<Record<string, unknown>>;
    expect(artifact).toBeDefined();
    expect(artifact!.report_id).toBe(result.reportId);
    expect(artifact!.requested_by_kind).toBe('system');
    expect(artifact!.schema_version).toBe('1');

    expect(await countWhere(sql`
      SELECT count(*)::int FROM ai_agent_runs
       WHERE id = ${f.runId}::uuid AND report_run_id = ${result.reportRunId}::uuid
    `)).toBe(1);
  });

  runDb('W04: the automation loader lists legacy-import scripts first and matches the tag case-insensitively', async () => {
    const f = await seed();
    const db0 = getTestDb();
    const [plain] = await db0.insert(scripts).values({
      orgId: f.orgId, partnerId: f.partnerId, name: 'Aaa ordinary script', osTypes: ['windows'], language: 'powershell', content: 'Write-Output 1', createdBy: f.userId,
    }).returning({ id: scripts.id });
    const [legacy] = await db0.insert(scripts).values({
      orgId: f.orgId, partnerId: f.partnerId, name: 'Zzz imported script', osTypes: ['windows'], language: 'powershell', content: 'Write-Output 2', createdBy: f.userId,
    }).returning({ id: scripts.id });
    const [tag] = await db0.insert(scriptTags).values({ orgId: f.orgId, partnerId: f.partnerId, name: 'Legacy-Import' }).returning({ id: scriptTags.id });
    await db0.insert(scriptToTags).values({ scriptId: legacy!.id, tagId: tag!.id });

    const evidence = await withSystemDbAccessContext(() => loadDesignEvidence(f.orgId, {}));

    // A loader that throws only costs its own section — prove this one ran.
    expect(evidence.unavailable).not.toContain('automation');
    const ids = evidence.automation.scripts.map((s) => s.id);
    expect(ids.indexOf(legacy!.id)).toBe(0);
    expect(ids).toContain(plain!.id);
    expect(evidence.automation.scripts[0]).toMatchObject({ legacyImport: true, tags: ['Legacy-Import'] });
    expect(evidence.automation.scripts.find((s) => s.id === plain!.id)!.legacyImport).toBe(false);
  });

  runDb('a second persist for the same org reuses the definition (one reports row, two report_runs)', async () => {
    const f = await seed();
    const evidence = await withSystemDbAccessContext(() => loadDesignEvidence(f.orgId, {}));
    const outcome = await buildOutcome(evidence, f.deviceId);
    const first = await persistFleetDesignReport(input(f, evidence, outcome));

    const secondRunId = await seedRun(f);
    const second = await persistFleetDesignReport(input(f, evidence, outcome, secondRunId));

    expect(second.reportId).toBe(first.reportId);
    expect(second.reportRunId).not.toBe(first.reportRunId);
    expect(await countWhere(sql`
      SELECT count(*)::int FROM reports WHERE org_id = ${f.orgId}::uuid AND type = 'ai_fleet_design'
    `)).toBe(1);
    expect(await countWhere(sql`
      SELECT count(*)::int FROM report_runs WHERE report_id = ${first.reportId}::uuid
    `)).toBe(2);
  });

  runDb('a second persist for the SAME run throws FleetDesignPersistConflictError', async () => {
    const f = await seed();
    const evidence = await withSystemDbAccessContext(() => loadDesignEvidence(f.orgId, {}));
    const outcome = await buildOutcome(evidence, f.deviceId);
    const first = await persistFleetDesignReport(input(f, evidence, outcome));

    await expect(persistFleetDesignReport(input(f, evidence, outcome)))
      .rejects.toBeInstanceOf(FleetDesignPersistConflictError);

    expect(await countWhere(sql`
      SELECT count(*)::int FROM report_runs WHERE report_id = ${first.reportId}::uuid
    `)).toBe(1);
  });

  runDb('org erasure succeeds after a design was persisted', async () => {
    const f = await seed();
    const evidence = await withSystemDbAccessContext(() => loadDesignEvidence(f.orgId, {}));
    const outcome = await buildOutcome(evidence, f.deviceId);
    const artifact = await persistFleetDesignReport(input(f, evidence, outcome));

    const stats = await cascadeDeleteOrg(f.orgId, f.userId);

    expect(stats.tablesDeleted.organizations).toBe(1);
    expect(await countWhere(sql`
      SELECT count(*)::int FROM reports WHERE id = ${artifact.reportId}::uuid
    `)).toBe(0);
    expect(await countWhere(sql`
      SELECT count(*)::int FROM report_runs WHERE id = ${artifact.reportRunId}::uuid
    `)).toBe(0);
    expect(await countWhere(sql`
      SELECT count(*)::int FROM ai_agent_runs WHERE org_id = ${f.orgId}::uuid
    `)).toBe(0);
    // The sibling org under the same partner (and its device) is untouched.
    expect(await countWhere(sql`
      SELECT count(*)::int FROM organizations WHERE id = ${f.otherOrgId}::uuid
    `)).toBe(1);
  });

  runDb("loadDesignEvidence(orgA) under system context never returns org B's device", async () => {
    const f = await seed();

    const evidence = await withSystemDbAccessContext(() => loadDesignEvidence(f.orgId, {}));

    expect(evidence.deviceIds.has(f.deviceId)).toBe(true);
    for (const id of evidence.deviceIds) {
      expect(evidence.devices.some((d) => d.id === id)).toBe(true);
    }
    // Every id in the bundle belongs to org A — none is org B's device.
    const orgADeviceRows = (await getTestDb().execute(sql`
      SELECT id FROM devices WHERE org_id = ${f.orgId}::uuid
    `)) as unknown as Array<{ id: string }>;
    const orgAIds = new Set(orgADeviceRows.map((r) => r.id));
    for (const id of evidence.deviceIds) {
      expect(orgAIds.has(id)).toBe(true);
    }
    const otherOrgDeviceRows = (await getTestDb().execute(sql`
      SELECT id FROM devices WHERE org_id = ${f.otherOrgId}::uuid
    `)) as unknown as Array<{ id: string }>;
    expect(otherOrgDeviceRows).toHaveLength(1);
    expect(evidence.deviceIds.has(otherOrgDeviceRows[0]!.id)).toBe(false);
  });

  /**
   * PR-review gap (Important) — the "never present an unmeasured evidence
   * section as a zero" fix (`assembleDesignEvidence`) is proven at the pure
   * layer by `designEvidence.test.ts`'s own fixtures, and at the mocked-DB
   * layer by that file's `loadDesignEvidence (loader failure isolation)`
   * suite (a loader that genuinely REJECTS lands in `unavailable`). What
   * neither proves is the other half of the same contract against REAL
   * Postgres: a loader that runs and legitimately finds NOTHING must NOT be
   * confused with one that failed — a brand new org with zero rows anywhere
   * must come back with `unavailable: []` and real, measured zeros.
   */
  runDb('a fresh, empty org yields unavailable: [] and MEASURED zeros, never an invented "unavailable"', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    const evidence = await withSystemDbAccessContext(() => loadDesignEvidence(org.id, {}));

    expect(evidence.unavailable).toEqual([]);
    expect(evidence.devicesTotal).toBe(0);
    expect(evidence.devices).toEqual([]);
    expect(evidence.counts).toEqual({ alerts90d: 0, tickets90d: 0, endpoints: 0 });

    const baseline = designBaselineNumbers(evidence);
    // `ticketsPerMonth` divides a genuinely MEASURED zero count — unlike
    // `alertsPer100EndpointsPerMonth`, which is legitimately null here for a
    // DIFFERENT, unrelated reason (division by zero endpoints), not
    // asserted either way to avoid conflating the two nulls.
    expect(baseline.ticketsPerMonth).toBe(0);
    expect(baseline.precursors.find((p) => p.condition === 'disk_used_over_threshold')?.deviceCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PR-review gap (Critical) — `loadFleetDesignReport` (the run-detail route's
// and the W03 Fleet Design page's read path) was never invoked by any test:
// `routes/fleetDesign.test.ts` mocks the module entirely. These four cases
// prove the three ways it returns `null` (wrong org, wrong report type,
// nonexistent id) are genuinely indistinguishable from one another — and
// from each other — while a real hit still resolves.
// ---------------------------------------------------------------------------
describe('loadFleetDesignReport against live Postgres (Fleet Designer W01, Task 13 gap)', () => {
  /** Seeds a `reports` + `report_runs` row of a DIFFERENT type (the weekly
   *  narrative), using the SAME system-principal scope shape
   *  `persistFleetDesignReport` writes — so `loadFleetDesignReport`'s
   *  `eq(reports.type, FLEET_DESIGN_REPORT_TYPE)` predicate is the ONLY
   *  thing standing between this row and a false hit. */
  async function seedNonDesignReportRun(orgId: string): Promise<string> {
    const scopeValues = persistedSystemSiteScopeValues(systemReportAuthority(orgId));
    return withSystemDbAccessContext(async () => {
      const [definition] = await db
        .insert(reports)
        .values({
          orgId,
          name: 'Weekly Narrative',
          type: 'ai_org_narrative',
          config: {},
          schedule: 'one_time',
          format: 'pdf',
          createdBy: null,
          sourceAiAgentScheduleId: null,
          ...scopeValues,
        })
        .returning({ id: reports.id });
      const [run] = await db
        .insert(reportRuns)
        .values({
          reportId: definition!.id,
          status: 'completed',
          startedAt: new Date(),
          completedAt: new Date(),
          rowCount: 0,
          result: { rows: [], rowCount: 0, summary: {} },
          requestedByKind: 'system',
          requestedByUserId: null,
          requestedByPortalUserId: null,
          ...scopeValues,
        })
        .returning({ id: reportRuns.id });
      return run!.id;
    });
  }

  runDb('returns the row for an org-A condition', async () => {
    const f = await seed();
    const evidence = await withSystemDbAccessContext(() => loadDesignEvidence(f.orgId, {}));
    const outcome = await buildOutcome(evidence, f.deviceId);
    const { reportRunId, reportId } = await persistFleetDesignReport(input(f, evidence, outcome));

    const row = await withSystemDbAccessContext(() => loadFleetDesignReport(reportRunId, (orgId) => eq(orgId, f.orgId)));

    expect(row).not.toBeNull();
    expect(row!.reportRunId).toBe(reportRunId);
    expect(row!.reportId).toBe(reportId);
    expect(row!.orgId).toBe(f.orgId);
    expect(row!.summary.fleetDesign!.runId).toBe(f.runId);
  });

  runDb('returns null for an org-B condition — the SAME reportRunId, a foreign org filter', async () => {
    const f = await seed();
    const evidence = await withSystemDbAccessContext(() => loadDesignEvidence(f.orgId, {}));
    const outcome = await buildOutcome(evidence, f.deviceId);
    const { reportRunId } = await persistFleetDesignReport(input(f, evidence, outcome));

    const row = await withSystemDbAccessContext(() => loadFleetDesignReport(reportRunId, (orgId) => eq(orgId, f.otherOrgId)));

    expect(row).toBeNull();
  });

  runDb('returns null when the report_run exists but reports.type is not ai_fleet_design', async () => {
    const f = await seed();
    const narrativeRunId = await seedNonDesignReportRun(f.orgId);

    const row = await withSystemDbAccessContext(() => loadFleetDesignReport(narrativeRunId, (orgId) => eq(orgId, f.orgId)));

    expect(row).toBeNull();
  });

  runDb('returns null for a random uuid — indistinguishable from the other two misses', async () => {
    const f = await seed();

    const row = await withSystemDbAccessContext(() => loadFleetDesignReport(randomUUID(), (orgId) => eq(orgId, f.orgId)));

    expect(row).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Case 6/7: the `design` schedule kind — fan-out picks the `designer` agent,
// `createSchedule` refuses a triage target, and the CHECK forbids non-empty
// sweepKinds on a design baseline.
// ---------------------------------------------------------------------------

describe('design schedule kind — fan-out and DB contracts', () => {
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

  async function seedDesignerAgent(partnerId: string, createdBy: string) {
    const [agent] = await withSystemDbAccessContext(() => db
      .insert(aiAgents)
      .values({
        partnerId,
        orgId: null,
        kind: 'designer',
        name: 'Fleet Designer',
        enabled: true,
        mode: 'act',
        toolAllowlist: ['submit_fleet_design'],
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

  runDb('fans out one design run per live org, targeting the designer agent', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const agent = await seedDesignerAgent(partner.id, user.id);

    const [baseline] = await withSystemDbAccessContext(() => db
      .insert(aiAgentSchedules)
      .values({
        orgId: null,
        partnerId: partner.id,
        agentId: agent.id,
        baselineScheduleId: null,
        kind: 'design',
        cron: DESIGN_CRON,
        timezone: 'UTC',
        sweepKinds: [],
        enabled: true,
        createdBy: user.id,
        updatedAt: new Date(),
      })
      .returning());

    const occurrenceKey = '2026-10-01T06:00@UTC';
    const summary = await processSweepOccurrence({ scheduleId: baseline!.id, occurrenceKey });

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
        orgId, agentId: agent.id, deviceId: null, profile: 'design', triggerKind: 'schedule', scheduleId: baseline!.id,
      });
    }
    expect(enqueued).toHaveLength(2);
  });

  runDb('createSchedule rejects a design baseline targeting a triage agent with agent_kind_not_designer', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    const triageAgent = await seedTriageAgent(partner.id, user.id);

    const auth = partnerAuth({ partnerId: partner.id, userId: user.id });
    const scheduleInput: CreateAiAgentScheduleInput = {
      ownerScope: 'partner',
      kind: 'design',
      agentId: triageAgent.id,
      cron: DESIGN_CRON,
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
    expect((caught as ScheduleValidationError).code).toBe('agent_kind_not_designer');

    expect(await countWhere(sql`
      SELECT count(*)::int FROM ai_agent_schedules WHERE partner_id = ${partner.id}::uuid
    `)).toBe(0);
  });

  runDb('ai_agent_schedules CHECK rejects kind=design with non-empty sweep_kinds (23514)', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    const agent = await seedDesignerAgent(partner.id, user.id);

    let caught: unknown;
    try {
      await withSystemDbAccessContext(() => db
        .insert(aiAgentSchedules)
        .values({
          orgId: null,
          partnerId: partner.id,
          agentId: agent.id,
          baselineScheduleId: null,
          kind: 'design',
          cron: DESIGN_CRON,
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
});
