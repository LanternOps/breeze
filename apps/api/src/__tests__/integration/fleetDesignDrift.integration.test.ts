/**
 * Fleet Design drift against live Postgres (Fleet Designer W05, #5655).
 *
 * Module under test: `services/fleetDesign/drift.ts` (`loadApprovedDesign`,
 * `loadDriftLiveState`, `computeDrift`), wired into `loadDesignEvidence`
 * (`services/aiAgents/designEvidence.ts`, `evidence.approvedDesign` /
 * `.driftLive`) and into what a scheduled design run persists
 * (`services/aiAgents/fleetDesignReport.ts`'s `persistFleetDesignReport`,
 * `summary.fleetDesign.drift`). `drift.test.ts` proves `computeDrift` and
 * `buildApprovedDesign` as pure functions against a fake Drizzle executor;
 * this file proves the two real loaders against a genuinely applied design —
 * RLS-forced Postgres as the unprivileged `breeze_app` role — which the
 * mocked-db unit suite cannot show: that an applied Fleet Design's ledger and
 * stored outcome really do reassemble into the approved design, that hand
 * edits to the live policy really do surface as drift, and that a scheduled
 * run's persisted report really does carry that drift without writing
 * anything else.
 *
 * Fixture/helper pattern copied from `fleetDesignApply.integration.test.ts`
 * (auth/db-context builders, `seedFixture`, report-run seeding) and
 * `aiAgentFleetDesign.integration.test.ts` (the designer-agent + `design`
 * schedule + scheduled `ai_agent_runs` row shape for case 4).
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type {
  FleetDesignApproval,
  FleetDesignDrift,
  FleetDesignOutcome,
  FleetDesignOutcomeRefs,
  FleetDesignRule,
  FleetDesignSubmission,
} from '@breeze/shared';
import { fleetDesignOutcomeFromSubmission } from '@breeze/shared';
import { getTestDb } from './setup';
import { setupTestEnvironment } from './db-utils';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import {
  aiAgentRuns,
  aiAgents,
  aiAgentSchedules,
  configurationPolicies,
  deviceGroupMemberships,
  deviceGroups,
  devices,
  fleetDesignAppliedItems,
  orgDocuments,
  reportRuns,
  reports,
  serviceDeliverableEvidence,
  serviceDeliverableOccurrences,
  serviceDeliverables,
} from '../../db/schema';
import { buildDbAccessContext, buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { applyFleetDesign } from '../../services/fleetDesign/apply';
import { rollbackFleetDesign } from '../../services/fleetDesign/rollback';
import { computeDrift, loadApprovedDesign, loadDriftLiveState } from '../../services/fleetDesign/drift';
import { fileFleetDesignDocument, fleetDesignDocumentFilename } from '../../services/fleetDesign/documents';
import { loadDesignEvidence } from '../../services/aiAgents/designEvidence';
import { persistFleetDesignReport } from '../../services/aiAgents/fleetDesignReport';

const runDb = it.runIf(!!process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// Auth / RLS context helpers — copied verbatim from fleetDesignApply's
// PartnerEnv / buildAuth / buildDbCtx.
// ---------------------------------------------------------------------------

interface PartnerEnv {
  partnerId: string;
  orgId: string;
  siteId: string;
  userId: string;
  userEmail: string;
}

function buildAuth(env: PartnerEnv): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([env.orgId]);
  return {
    principal: { kind: 'user_session' },
    user: { id: env.userId, email: env.userEmail, name: 'Tech', isPlatformAdmin: false },
    token: null,
    partnerId: env.partnerId,
    orgId: null,
    scope: 'partner',
    accessibleOrgIds: [env.orgId],
    partnerOrgAccess: 'all',
    orgCondition,
    canAccessOrg,
  } as unknown as AuthContext;
}

function buildDbCtx(env: PartnerEnv): DbAccessContext {
  return buildDbAccessContext({
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [env.orgId],
    partnerId: env.partnerId,
    userId: env.userId,
  });
}

// ---------------------------------------------------------------------------
// Fixture: org A (2 devices, no pre-existing policy — nothing to displace)
// plus sibling org B for the tenant-isolation case.
// ---------------------------------------------------------------------------

let deviceSeq = 0;
async function createDevice(orgId: string, siteId: string, hostname: string): Promise<string> {
  deviceSeq += 1;
  const [device] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId: `agent-fdd-${Date.now()}-${deviceSeq}`,
    hostname,
    osType: 'windows',
    osVersion: '11',
    architecture: 'x64',
    agentVersion: '1.0.0',
  }).returning({ id: devices.id });
  return device!.id;
}

interface Fixture {
  envA: PartnerEnv;
  envB: PartnerEnv;
  authA: AuthContext;
  dbCtxA: DbAccessContext;
  deviceIds: [string, string];
}

async function seedFixture(): Promise<Fixture> {
  const envAFull = await setupTestEnvironment({ scope: 'partner' });
  const envBFull = await setupTestEnvironment({ scope: 'partner' });
  const envA: PartnerEnv = {
    partnerId: envAFull.partner.id, orgId: envAFull.organization.id, siteId: envAFull.site.id,
    userId: envAFull.user.id, userEmail: envAFull.user.email,
  };
  const envB: PartnerEnv = {
    partnerId: envBFull.partner.id, orgId: envBFull.organization.id, siteId: envBFull.site.id,
    userId: envBFull.user.id, userEmail: envBFull.user.email,
  };
  const authA = buildAuth(envA);
  const dbCtxA = buildDbCtx(envA);

  const d1 = await createDevice(envA.orgId, envA.siteId, 'fdd-1');
  const d2 = await createDevice(envA.orgId, envA.siteId, 'fdd-2');

  return { envA, envB, authA, dbCtxA, deviceIds: [d1, d2] };
}

// ---------------------------------------------------------------------------
// Submission / outcome / approval — one function ("file_server"), 2 devices,
// 2 watches (LanmanServer, Spooler) and 1 rule. No retired items and no
// pre-existing policy, so applying needs no displacement acceptance.
// ---------------------------------------------------------------------------

const DRIFT_RULE: FleetDesignRule = {
  name: 'File server disk full',
  severity: 'high',
  conditions: [{ type: 'metric', metric: 'disk', operator: 'gt', value: 90 }],
  cooldownMinutes: 30,
  rationale: 'Disk exhaustion breaks file shares',
  action: 'none',
  paging: 'none',
};

function buildDriftSubmission(deviceIds: [string, string]): FleetDesignSubmission {
  return {
    found: { summary: ['2 devices act as a file server'], findings: [] },
    functions: [{ functionKey: 'file_server', deviceIds: [...deviceIds], confidence: 0.9, evidence: ['SMB shares active'] }],
    monitoring: [{
      functionKey: 'file_server',
      watches: [
        { watchType: 'service', name: 'LanmanServer', alertOnStop: true, autoRestart: true, rationale: 'Core file-sharing service' },
        { watchType: 'service', name: 'Spooler', alertOnStop: true, autoRestart: false, rationale: 'Print spooler' },
      ],
      alertRules: [DRIFT_RULE],
    }],
    retired: [],
    automation: [],
    legacy: [],
    baseline: { notes: [] },
    unsure: { lowConfidenceFunctions: [], unreachableDevices: [], needsHuman: [], roleCorrections: [] },
  };
}

function buildDriftOutcome(deviceIds: [string, string]): FleetDesignOutcome {
  const submission = buildDriftSubmission(deviceIds);
  const refs: FleetDesignOutcomeRefs = {
    deviceIds: new Set(deviceIds),
    baseline: { alertsPer100EndpointsPerMonth: null, ticketsPerMonth: null, precursors: [] },
    generatedAt: new Date().toISOString(),
  };
  return fleetDesignOutcomeFromSubmission(submission, refs);
}

/** Approves both watches + the rule; no retirements, no role corrections, no
 *  displacements — the fixture has no pre-existing policy to conflict with. */
function driftApproval(): FleetDesignApproval {
  return {
    functions: ['file_server'],
    monitoring: ['monitoring:file_server:watch:0', 'monitoring:file_server:watch:1', 'monitoring:file_server:rule:0'],
    retired: [],
    automation: [],
    legacy: [],
    roleCorrections: [],
    displacementsAccepted: [],
  };
}

// ---------------------------------------------------------------------------
// Report-run seeding — copied verbatim from fleetDesignApply.integration.test.ts.
// ---------------------------------------------------------------------------

const reportDefinitionByOrg = new Map<string, string>();

async function ensureReportDefinition(orgId: string): Promise<string> {
  const cached = reportDefinitionByOrg.get(orgId);
  if (cached) return cached;
  const [existing] = await getTestDb()
    .select({ id: reports.id })
    .from(reports)
    .where(and(eq(reports.orgId, orgId), eq(reports.type, 'ai_fleet_design')))
    .limit(1);
  if (existing) {
    reportDefinitionByOrg.set(orgId, existing.id);
    return existing.id;
  }
  const [created] = await getTestDb().insert(reports).values({
    orgId,
    name: 'Fleet Design',
    type: 'ai_fleet_design',
    config: {},
    schedule: 'one_time',
    format: 'pdf',
    createdBy: null,
  }).returning({ id: reports.id });
  reportDefinitionByOrg.set(orgId, created!.id);
  return created!.id;
}

async function seedReportRun(orgId: string, outcome: FleetDesignOutcome): Promise<string> {
  const reportId = await ensureReportDefinition(orgId);
  const [run] = await getTestDb().insert(reportRuns).values({
    reportId,
    status: 'completed',
    startedAt: new Date(),
    completedAt: new Date(),
    rowCount: 0,
    result: { rows: [], rowCount: 0, summary: { fleetDesign: { schemaVersion: outcome.schemaVersion, outcome, generatedAt: outcome.generatedAt, runId: undefined, evidenceTruncated: false } } },
  }).returning({ id: reportRuns.id });
  return run!.id;
}

// ---------------------------------------------------------------------------
// Read helpers (raw, superuser test connection — bypasses RLS)
// ---------------------------------------------------------------------------

async function readLedger(reportRunId: string) {
  return getTestDb().select().from(fleetDesignAppliedItems).where(eq(fleetDesignAppliedItems.reportRunId, reportRunId));
}

/** Hand-disables the named watch on the given policy's monitoring feature
 *  link, mimicking a technician editing the applied policy directly. Run
 *  under system DB context (bypasses RLS, exactly like `loadDesignEvidence`
 *  itself is invoked in these tests). */
async function disableWatchByHand(policyId: string, watchName: string): Promise<void> {
  await withSystemDbAccessContext(() => db.execute(sql`
    UPDATE config_policy_monitoring_watches w
    SET enabled = false
    FROM config_policy_monitoring_settings ms, config_policy_feature_links fl
    WHERE w.settings_id = ms.id
      AND ms.feature_link_id = fl.id
      AND fl.config_policy_id = ${policyId}::uuid
      AND fl.feature_type = 'monitoring'
      AND w.name = ${watchName}
  `));
}

/** Inserts a watch or rule row directly onto the policy's own feature link,
 *  mimicking a technician adding one by hand after the design was applied. */
async function addItemByHand(policyId: string, kind: 'watch' | 'rule', name: string): Promise<void> {
  await withSystemDbAccessContext(() => (kind === 'watch'
    ? db.execute(sql`
        INSERT INTO config_policy_monitoring_watches (settings_id, watch_type, name, enabled)
        SELECT ms.id, 'service', ${name}, true
        FROM config_policy_monitoring_settings ms
        JOIN config_policy_feature_links fl ON fl.id = ms.feature_link_id
        WHERE fl.config_policy_id = ${policyId}::uuid AND fl.feature_type = 'monitoring'
      `)
    : db.execute(sql`
        INSERT INTO config_policy_alert_rules (feature_link_id, name, severity, conditions, cooldown_minutes)
        SELECT fl.id, ${name}, 'low', '[]'::jsonb, 5
        FROM config_policy_feature_links fl
        WHERE fl.config_policy_id = ${policyId}::uuid AND fl.feature_type = 'alert_rule'
      `)));
}

async function countFleetDesignLedger(orgId: string): Promise<number> {
  return (await getTestDb().select({ id: fleetDesignAppliedItems.id }).from(fleetDesignAppliedItems).where(eq(fleetDesignAppliedItems.orgId, orgId))).length;
}
async function countPolicies(orgId: string): Promise<number> {
  return (await getTestDb().select({ id: configurationPolicies.id }).from(configurationPolicies).where(eq(configurationPolicies.orgId, orgId))).length;
}
async function countGroups(orgId: string): Promise<number> {
  return (await getTestDb().select({ id: deviceGroups.id }).from(deviceGroups).where(eq(deviceGroups.orgId, orgId))).length;
}

// ---------------------------------------------------------------------------

describe('Fleet Design drift against live Postgres (Fleet Designer W05, #5655)', () => {
  runDb('1. no applied design → no drift, and approvedDesign is not reported unavailable', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });

    const evidence = await withSystemDbAccessContext(() => loadDesignEvidence(env.organization.id, {}));

    expect(evidence.approvedDesign).toBeNull();
    expect(evidence.driftLive).toBeNull();
    expect(evidence.unavailable).not.toContain('approvedDesign');
  });

  runDb('2. applied design + a watch disabled by hand → one changed row; removing a device → one missing row', async () => {
    const f = await seedFixture();
    const runId = await seedReportRun(f.envA.orgId, buildDriftOutcome(f.deviceIds));

    const applied = await withDbAccessContext(f.dbCtxA, () => applyFleetDesign(f.authA, runId, driftApproval()));
    expect(applied.partial).toBeNull();

    const ledger = await readLedger(runId);
    const policyId = ledger.find((r) => r.itemRef === 'policy:file_server')!.createdRefs!.policyId as string;
    const groupId = ledger.find((r) => r.itemRef === 'functions:file_server')!.createdRefs!.groupId as string;

    await disableWatchByHand(policyId, 'Spooler');

    const evidence = await withSystemDbAccessContext(() => loadDesignEvidence(f.envA.orgId, {}));
    expect(evidence.approvedDesign?.reportRunId).toBe(runId);
    expect(evidence.approvedDesign?.functions[0]?.policyId).toBe(policyId);
    // Regression (found in W05): `ANY(${jsArray})` inside drizzle's sql tag
    // spreads the array into chunks, so the W01 configuration loader failed
    // with "malformed array literal" for ANY org that had a policy — and
    // `configuration` silently went `unavailable`. With a real policy in
    // place the section must load and carry it.
    expect(evidence.unavailable).not.toContain('configuration');
    expect(evidence.configuration.policies.some((p) => p.id === policyId)).toBe(true);
    expect(evidence.unavailable).not.toContain('approvedDesign');

    const drift = computeDrift(evidence.approvedDesign!, evidence.driftLive!);
    expect(drift.changed).toEqual([
      { functionKey: 'file_server', kind: 'watch', name: 'Spooler', field: 'enabled', approved: 'true', live: 'false' },
    ]);
    expect(drift.missing).toEqual([]);
    expect(drift.extra).toEqual([]);

    // Now remove the second device from the function's group and recompute
    // against a fresh live-state read.
    await getTestDb().delete(deviceGroupMemberships).where(and(
      eq(deviceGroupMemberships.groupId, groupId),
      eq(deviceGroupMemberships.deviceId, f.deviceIds[1]),
    ));

    const liveAfterRemoval = await withSystemDbAccessContext(() => loadDriftLiveState(f.envA.orgId, evidence.approvedDesign!));
    const driftAfterRemoval = computeDrift(evidence.approvedDesign!, liveAfterRemoval);
    expect(driftAfterRemoval.missing).toEqual([
      { functionKey: 'file_server', kind: 'group_member', name: f.deviceIds[1] },
    ]);
    // The hand-disabled watch is still drift too — removing the device did
    // not clear the earlier finding.
    expect(driftAfterRemoval.changed).toEqual([
      { functionKey: 'file_server', kind: 'watch', name: 'Spooler', field: 'enabled', approved: 'true', live: 'false' },
    ]);
  });

  runDb('2b. a watch and a rule added by hand to the design\'s own policy surface as extra through the real JOINs', async () => {
    const f = await seedFixture();
    const runId = await seedReportRun(f.envA.orgId, buildDriftOutcome(f.deviceIds));
    const applied = await withDbAccessContext(f.dbCtxA, () => applyFleetDesign(f.authA, runId, driftApproval()));
    expect(applied.partial).toBeNull();

    const ledger = await readLedger(runId);
    const policyId = ledger.find((r) => r.itemRef === 'policy:file_server')!.createdRefs!.policyId as string;

    await addItemByHand(policyId, 'watch', 'HandAddedWatch');
    await addItemByHand(policyId, 'rule', 'Hand-added rule');

    const evidence = await withSystemDbAccessContext(() => loadDesignEvidence(f.envA.orgId, {}));
    const drift = computeDrift(evidence.approvedDesign!, evidence.driftLive!);

    // Both arrive through loadDriftLiveState's own watch/rule JOINs — the
    // part of the loader the fixture-driven unit tests cannot exercise.
    expect(drift.extra.map((e) => `${e.kind}:${e.name}`).sort()).toEqual(['rule:Hand-added rule', 'watch:HandAddedWatch']);
    // Both devices are still in the function group, so the count is real.
    expect(drift.extra.every((e) => e.deviceCount === 2)).toBe(true);
    expect(drift.missing).toEqual([]);
    expect(drift.changed).toEqual([]);
  });

  runDb("2c. a design-owned policy promoted to partner-wide is still found — its items are not reported missing", async () => {
    const f = await seedFixture();
    const runId = await seedReportRun(f.envA.orgId, buildDriftOutcome(f.deviceIds));
    const applied = await withDbAccessContext(f.dbCtxA, () => applyFleetDesign(f.authA, runId, driftApproval()));
    expect(applied.partial).toBeNull();

    const approved = await withSystemDbAccessContext(() => loadApprovedDesign(f.envA.orgId));
    const policyId = approved!.functions[0]!.policyId!;

    // A technician promotes the design's policy to partner-wide: org_id NULL,
    // partner_id set (the org-XOR-partner CHECK). The pinned-id branch of
    // loadDriftLiveState exists exactly for this.
    // The ownership guard (`breeze_config_policy_parent_guard`) only admits
    // this in system context — the same context a real promotion runs in.
    await withSystemDbAccessContext(() => db.execute(sql`
      UPDATE configuration_policies SET org_id = NULL, partner_id = ${f.envA.partnerId}::uuid WHERE id = ${policyId}::uuid
    `));

    const live = await withSystemDbAccessContext(() => loadDriftLiveState(f.envA.orgId, approved!));
    expect(live.policies.some((p) => p.id === policyId && p.ownerScope === 'partner')).toBe(true);

    const drift = computeDrift(approved!, live);
    // The watches and rules still exist on the (now partner-wide) policy, so
    // nothing is "missing"; and a partner-wide policy is never "extra".
    expect(drift.missing).toEqual([]);
    expect(drift.extra).toEqual([]);
    expect(drift.changed).toEqual([]);
  });

  runDb('3. a rolled-back design is not the approved design', async () => {
    const f = await seedFixture();
    const runId = await seedReportRun(f.envA.orgId, buildDriftOutcome(f.deviceIds));

    const applied = await withDbAccessContext(f.dbCtxA, () => applyFleetDesign(f.authA, runId, driftApproval()));
    expect(applied.partial).toBeNull();

    const rollback = await withDbAccessContext(f.dbCtxA, () => rollbackFleetDesign(f.authA, runId));
    expect(rollback.refused).toEqual([]);

    const approved = await withSystemDbAccessContext(() => loadApprovedDesign(f.envA.orgId));
    expect(approved).toBeNull();
  });

  runDb('4. a scheduled design run persists drift and writes nothing else', async () => {
    const f = await seedFixture();
    const runId = await seedReportRun(f.envA.orgId, buildDriftOutcome(f.deviceIds));

    const applied = await withDbAccessContext(f.dbCtxA, () => applyFleetDesign(f.authA, runId, driftApproval()));
    expect(applied.partial).toBeNull();

    const ledger = await readLedger(runId);
    const policyId = ledger.find((r) => r.itemRef === 'policy:file_server')!.createdRefs!.policyId as string;
    await disableWatchByHand(policyId, 'Spooler');

    const evidence = await withSystemDbAccessContext(() => loadDesignEvidence(f.envA.orgId, {}));
    const drift = computeDrift(evidence.approvedDesign!, evidence.driftLive!);
    expect(drift.changed).toHaveLength(1);
    expect(drift.approvedReportRunId).toBe(runId);

    const ledgerCountBefore = await countFleetDesignLedger(f.envA.orgId);
    const policyCountBefore = await countPolicies(f.envA.orgId);
    const groupCountBefore = await countGroups(f.envA.orgId);

    // A `design` schedule + designer agent + a scheduled `ai_agent_runs` row
    // (pattern: aiAgentFleetDesign.integration.test.ts's fan-out case).
    const [agent] = await withSystemDbAccessContext(() => db.insert(aiAgents).values({
      partnerId: f.envA.partnerId,
      orgId: null,
      kind: 'designer',
      name: 'Fleet Designer',
      enabled: true,
      mode: 'act',
      toolAllowlist: ['submit_fleet_design'],
      limits: {},
      createdBy: f.envA.userId,
    }).returning());

    const [schedule] = await withSystemDbAccessContext(() => db.insert(aiAgentSchedules).values({
      orgId: null,
      partnerId: f.envA.partnerId,
      agentId: agent!.id,
      baselineScheduleId: null,
      kind: 'design',
      cron: '0 6 1 * *',
      timezone: 'UTC',
      sweepKinds: [],
      enabled: true,
      createdBy: f.envA.userId,
      updatedAt: new Date(),
    }).returning());

    const [scheduledRun] = await withSystemDbAccessContext(() => db.insert(aiAgentRuns).values({
      agentId: agent!.id,
      orgId: f.envA.orgId,
      deviceId: null,
      profile: 'design',
      scheduleId: schedule!.id,
      triggerKind: 'schedule',
      triggerRef: {},
      dedupeKey: `design-scheduled-${randomUUID()}`,
      modeAtStart: 'act',
      policySnapshot: {} as never,
      status: 'running',
    }).returning());

    const result = await persistFleetDesignReport({
      run: { id: scheduledRun!.id, orgId: f.envA.orgId, agentId: agent!.id, scheduleId: schedule!.id },
      agent: { id: agent!.id, name: 'Fleet Designer' },
      evidence,
      outcome: buildDriftOutcome(f.deviceIds),
      drift,
    });

    const [row] = (await getTestDb().execute(sql`
      SELECT result->'summary'->'fleetDesign'->'drift' AS drift FROM report_runs WHERE id = ${result.reportRunId}::uuid
    `)) as unknown as Array<{ drift: FleetDesignDrift }>;
    expect(row).toBeDefined();
    expect(row!.drift.changed).toHaveLength(1);
    expect(row!.drift.approvedReportRunId).toBe(runId);

    expect(await countFleetDesignLedger(f.envA.orgId)).toBe(ledgerCountBefore);
    expect(await countPolicies(f.envA.orgId)).toBe(policyCountBefore);
    expect(await countGroups(f.envA.orgId)).toBe(groupCountBefore);
  });

  runDb("5. tenant isolation: org B has no approved design of its own, despite org A's applied one", async () => {
    const f = await seedFixture();
    const runId = await seedReportRun(f.envA.orgId, buildDriftOutcome(f.deviceIds));

    const applied = await withDbAccessContext(f.dbCtxA, () => applyFleetDesign(f.authA, runId, driftApproval()));
    expect(applied.partial).toBeNull();

    const approvedB = await withSystemDbAccessContext(() => loadApprovedDesign(f.envB.orgId));
    expect(approvedB).toBeNull();

    const approvedA = await withSystemDbAccessContext(() => loadApprovedDesign(f.envA.orgId));
    expect(approvedA).not.toBeNull();

    const ledger = await readLedger(runId);
    const policyId = ledger.find((r) => r.itemRef === 'policy:file_server')!.createdRefs!.policyId as string;
    const groupId = ledger.find((r) => r.itemRef === 'functions:file_server')!.createdRefs!.groupId as string;

    // Calling loadDriftLiveState with org B's id but org A's approved design
    // is an adversarial combination no real caller makes (loadDesignEvidence
    // always pairs an org with its OWN loadApprovedDesign result) — but it is
    // worth recording what actually happens.
    const liveB = await withSystemDbAccessContext(() => loadDriftLiveState(f.envB.orgId, approvedA!));

    // Group membership IS isolated: loadDriftLiveState's membership query
    // carries an explicit `eq(deviceGroupMemberships.orgId, orgId)` predicate,
    // so org A's group members never appear under org B's call.
    expect(liveB.groupMembers[groupId] ?? []).toEqual([]);

    // The pinned-id arm of the policies query is org-guarded too: a pinned id
    // only matches when the row is partner-wide (`org_id IS NULL`), never a
    // foreign org's row. So org A's policy must NOT appear under org B's call.
    expect(liveB.policies.some((p) => p.id === policyId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// W05 Task 3: org_documents hand-off
// ---------------------------------------------------------------------------

describe('Fleet Design → org documents hand-off against live Postgres (W05, #5655)', () => {
  runDb('files the PDF under category baseline, attaches it to the linked deliverable, and is idempotent per run', async () => {
    const f = await seedFixture();
    const orgId = f.envA.orgId;
    const runId = await seedReportRun(orgId, buildDriftOutcome(f.deviceIds));
    const reportId = await ensureReportDefinition(orgId);

    // A deliverable whose auto-evidence report IS the org's Fleet Design
    // definition, with one open occurrence — the "quarterly configuration
    // audit" the deliverables spec describes.
    const [deliverable] = await getTestDb().insert(serviceDeliverables).values({
      orgId, name: 'Quarterly configuration audit', cadence: 'quarterly',
      anchorDueDate: '2026-09-30', effectiveFrom: '2026-01-01', autoEvidenceReportId: reportId,
    }).returning({ id: serviceDeliverables.id });
    const [occurrence] = await getTestDb().insert(serviceDeliverableOccurrences).values({
      orgId, deliverableId: deliverable!.id, nameSnapshot: 'Quarterly configuration audit',
      periodStart: '2026-07-01', periodEnd: '2026-09-30', dueAt: '2026-09-30', originalDueAt: '2026-09-30', status: 'open',
    }).returning({ id: serviceDeliverableOccurrences.id });

    // 1. The technician's path: under the caller's own RLS context.
    const first = await withDbAccessContext(f.dbCtxA, () => fileFleetDesignDocument({
      orgId, reportRunId: runId,
      actor: { userId: f.envA.userId, partnerId: f.envA.partnerId, accessibleOrgIds: [orgId] },
    }));
    expect(first.alreadyFiled).toBe(false);
    expect(first.evidence).toEqual({ deliverableId: deliverable!.id, occurrenceId: occurrence!.id });

    const [doc] = await getTestDb().select().from(orgDocuments).where(eq(orgDocuments.id, first.documentId));
    expect(doc).toBeDefined();
    expect(doc!.orgId).toBe(orgId);
    expect(doc!.category).toBe('baseline');
    expect(doc!.contentType).toBe('application/pdf');
    expect(doc!.originalFilename).toBe(fleetDesignDocumentFilename(runId));
    expect(doc!.title.startsWith('Fleet Design')).toBe(true);
    expect(doc!.byteSize).toBeGreaterThan(1000);

    const evidence = await getTestDb().select().from(serviceDeliverableEvidence)
      .where(and(eq(serviceDeliverableEvidence.occurrenceId, occurrence!.id), eq(serviceDeliverableEvidence.orgId, orgId)));
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.kind).toBe('document');
    expect(evidence[0]!.documentId).toBe(first.documentId);

    // 2. The scheduled run's path: the system actor, a second time — no twin.
    const second = await withSystemDbAccessContext(() => fileFleetDesignDocument({
      orgId, reportRunId: runId, actor: { userId: null, partnerId: f.envA.partnerId, accessibleOrgIds: null },
    }));
    // No twin document, and no twin evidence row: the re-file re-checks the
    // linkage (so a failure between the two writes is recoverable) but the
    // document is already evidence on that occurrence, so nothing is added.
    expect(second).toEqual({
      documentId: first.documentId,
      alreadyFiled: true,
      evidence: { deliverableId: deliverable!.id, occurrenceId: occurrence!.id },
    });
    const docs = await getTestDb().select({ id: orgDocuments.id }).from(orgDocuments).where(eq(orgDocuments.orgId, orgId));
    expect(docs).toHaveLength(1);
    const evidenceAfter = await getTestDb().select({ id: serviceDeliverableEvidence.id }).from(serviceDeliverableEvidence)
      .where(eq(serviceDeliverableEvidence.occurrenceId, occurrence!.id));
    expect(evidenceAfter).toHaveLength(1);
  });

  runDb("refuses another org's report run (404) and files nothing", async () => {
    const f = await seedFixture();
    const runId = await seedReportRun(f.envA.orgId, buildDriftOutcome(f.deviceIds));
    await expect(withSystemDbAccessContext(() => fileFleetDesignDocument({
      orgId: f.envB.orgId, reportRunId: runId, actor: { userId: null, partnerId: f.envB.partnerId, accessibleOrgIds: null },
    }))).rejects.toMatchObject({ status: 404 });
    const docs = await getTestDb().select({ id: orgDocuments.id }).from(orgDocuments).where(eq(orgDocuments.orgId, f.envB.orgId));
    expect(docs).toHaveLength(0);
  });
});
