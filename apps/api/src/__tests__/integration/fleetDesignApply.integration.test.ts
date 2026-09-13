/**
 * Fleet Design apply / rollback / ledger — Fleet Designer W03 (#5653).
 *
 * Migration under test: `2026-10-16-170800-fleet-design-apply.sql` (rationale
 * columns + the `fleet_design_applied_items` ledger). Services under test:
 * `services/fleetDesign/{preview,apply,rollback,ledger}.ts`, run against a
 * real, RLS-forced Postgres as the unprivileged `breeze_app` role — the
 * mocked route/service unit suites can assert call shapes but cannot prove
 * the actual writes (assessments, groups, policies, assignments, device
 * roles) land correctly, that RLS blocks a cross-tenant forge, or that the
 * org-erasure cascade actually clears the ledger.
 *
 * Scenario: org A has 3 devices and one pre-existing org-level "baseline"
 * monitoring policy carrying a `Spooler` watch. A Fleet Design proposes
 * `file_server` for all 3 devices (one already carries a MANUAL function —
 * manual wins), one watch + one alert rule for that function, retiring the
 * baseline policy's `Spooler` watch, and a role correction for device 2.
 *
 * Plan doc: docs/superpowers/plans/ai-mcp/2026-09-12-fleet-designer-w03-apply-and-rollback.md
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type {
  FleetDesignApproval,
  FleetDesignOutcome,
  FleetDesignOutcomeRefs,
  FleetDesignReportSummary,
  FleetDesignRule,
  FleetDesignSubmission,
} from '@breeze/shared';
import { DEVICE_FUNCTION_LABELS, fleetDesignOutcomeFromSubmission } from '@breeze/shared';
import { getTestDb } from './setup';
import { setupTestEnvironment } from './db-utils';
import {
  db,
  withDbAccessContext,
  type DbAccessContext,
} from '../../db';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  deviceFunctionAssessments,
  deviceGroupMemberships,
  deviceGroups,
  devices,
  fleetDesignAppliedItems,
  reportRuns,
  reports,
} from '../../db/schema';
import { buildDbAccessContext, buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { pgErrorCode } from '../../utils/pgErrors';
import {
  addFeatureLink,
  assignPolicy,
  createConfigPolicy,
  listFeatureLinks,
  updateConfigPolicy,
  updateFeatureLink,
} from '../../services/configurationPolicy';
import { upsertDeviceFunction } from '../../services/deviceFunction';
import { applyFleetDesign } from '../../services/fleetDesign/apply';
import { loadLedger } from '../../services/fleetDesign/ledger';
import { FleetDesignApplyError, previewFleetDesignApply } from '../../services/fleetDesign/preview';
import { rollbackFleetDesign } from '../../services/fleetDesign/rollback';
import { cascadeDeleteOrg } from '../../services/tenantCascade';

const runDb = it.runIf(!!process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// Auth / RLS context helpers
// ---------------------------------------------------------------------------

interface PartnerEnv {
  partnerId: string;
  orgId: string;
  siteId: string;
  userId: string;
  userEmail: string;
}

/** Real `buildOrgAccessClosures` (the same closures `authMiddleware` builds
 *  for a request), so cross-org denial is the genuine app-layer behavior,
 *  not a stubbed-true shortcut. */
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
// Fixture: org A (3 devices, one pre-existing org-level monitoring policy),
// org B (a sibling tenant for cross-org isolation).
// ---------------------------------------------------------------------------

let deviceSeq = 0;
async function createDevice(orgId: string, siteId: string, hostname: string): Promise<string> {
  deviceSeq += 1;
  const [device] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId: `agent-fda-${Date.now()}-${deviceSeq}`,
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
  authB: AuthContext;
  dbCtxA: DbAccessContext;
  dbCtxB: DbAccessContext;
  deviceIds: [string, string, string];
  /** The pre-existing org-level "baseline" monitoring policy carrying `Spooler`. */
  baselinePolicyId: string;
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
  const authB = buildAuth(envB);
  const dbCtxA = buildDbCtx(envA);
  const dbCtxB = buildDbCtx(envB);

  const d1 = await createDevice(envA.orgId, envA.siteId, 'fda-1');
  const d2 = await createDevice(envA.orgId, envA.siteId, 'fda-2');
  const d3 = await createDevice(envA.orgId, envA.siteId, 'fda-3');
  // Device 3 already has a MANUAL function — manual wins over the design's ai proposal.
  await withDbAccessContext(dbCtxA, () => upsertDeviceFunction({
    deviceId: d3, orgId: envA.orgId, functionKey: 'kiosk', source: 'manual',
  }));

  const baselinePolicyId = await withDbAccessContext(dbCtxA, async () => {
    const policy = await createConfigPolicy({ orgId: envA.orgId }, { name: 'Server Baseline Monitoring', status: 'inactive' }, envA.userId);
    await addFeatureLink(policy.id, 'monitoring', null, {
      checkIntervalSeconds: 60,
      watches: [{ watchType: 'service', name: 'Spooler', enabled: true, alertOnStop: true, autoRestart: false }],
    });
    await assignPolicy(policy.id, 'organization', envA.orgId, 0, envA.userId);
    const activated = await updateConfigPolicy(policy.id, { status: 'active' }, authA);
    return activated!.id as string;
  });

  return { envA, envB, authA, authB, dbCtxA, dbCtxB, deviceIds: [d1, d2, d3], baselinePolicyId };
}

// ---------------------------------------------------------------------------
// Submission / outcome / approval builders
// ---------------------------------------------------------------------------

const GOOD_RULE: FleetDesignRule = {
  name: 'File server disk full',
  severity: 'high',
  conditions: [{ type: 'metric', metric: 'disk', operator: 'gt', value: 90 }],
  cooldownMinutes: 30,
  rationale: 'Disk exhaustion breaks file shares',
  action: 'none',
  paging: 'business_hours',
};

/** Deliberately bypasses fleetDesignSubmissionSchema (name > alertRuleItemSchema's
 *  max(200)) — case 8 models a stored outcome whose rule content the apply-time
 *  decompose step (alertRuleInlineSettingsSchema, config_policy_alert_rules) is
 *  the one to reject, not the HTTP submission validator. */
const BAD_RULE: FleetDesignRule = {
  name: 'x'.repeat(250),
  severity: 'high',
  conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 1 }],
  cooldownMinutes: 5,
  rationale: 'bad',
  action: 'none',
  paging: 'none',
};

function buildSubmission(opts: {
  functionKey: string;
  deviceIds: [string, string, string];
  roleCorrectionDeviceId: string;
  retiredPolicyId: string;
  rule: FleetDesignRule;
}): FleetDesignSubmission {
  return {
    found: { summary: ['3 devices act as a file server'], findings: [] },
    functions: [{ functionKey: opts.functionKey as FleetDesignSubmission['functions'][number]['functionKey'], deviceIds: [...opts.deviceIds], confidence: 0.9, evidence: ['SMB shares active'] }],
    monitoring: [{
      functionKey: opts.functionKey,
      watches: [{ watchType: 'service', name: 'LanmanServer', alertOnStop: true, autoRestart: true, rationale: 'Core file-sharing service' }],
      alertRules: [opts.rule],
    }],
    retired: [{ kind: 'watch', policyId: opts.retiredPolicyId, policyName: 'Server Baseline Monitoring', itemName: 'Spooler', reason: 'Superseded by the function-specific policy' }],
    automation: [],
    legacy: [],
    baseline: { notes: [] },
    unsure: {
      lowConfidenceFunctions: [],
      unreachableDevices: [],
      needsHuman: [],
      roleCorrections: [{ deviceId: opts.roleCorrectionDeviceId, currentRole: 'unknown', proposedRole: 'server', evidence: ['SMB shares active'], billingRelevant: true }],
    },
  };
}

function buildOutcome(opts: Parameters<typeof buildSubmission>[0]): FleetDesignOutcome {
  const submission = buildSubmission(opts);
  const refs: FleetDesignOutcomeRefs = {
    deviceIds: new Set(opts.deviceIds),
    baseline: { alertsPer100EndpointsPerMonth: null, ticketsPerMonth: null, precursors: [] },
    generatedAt: new Date().toISOString(),
  };
  return fleetDesignOutcomeFromSubmission(submission, refs);
}

function fullApproval(deviceIds: [string, string, string], displacementsAccepted: string[] = []): FleetDesignApproval {
  return {
    functions: ['file_server'],
    monitoring: ['monitoring:file_server:watch:0', 'monitoring:file_server:rule:0'],
    retired: ['retired:0'],
    automation: [],
    legacy: [],
    roleCorrections: [deviceIds[1]],
    displacementsAccepted,
  };
}

// ---------------------------------------------------------------------------
// Report-run seeding — a direct insert of `reports` (type `ai_fleet_design`)
// + `report_runs` (status completed, result.summary.fleetDesign.outcome), as
// an alternative to running the full designer agent pipeline. There is at
// most one `ai_fleet_design` definition per org (partial unique index), so
// every seeded run for the same org reuses the same definition row.
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
  const summary: FleetDesignReportSummary = {
    fleetDesign: {
      schemaVersion: outcome.schemaVersion,
      outcome,
      generatedAt: outcome.generatedAt,
      runId: undefined,
      evidenceTruncated: false,
    },
  };
  const [run] = await getTestDb().insert(reportRuns).values({
    reportId,
    status: 'completed',
    startedAt: new Date(),
    completedAt: new Date(),
    rowCount: 0,
    result: { rows: [], rowCount: 0, summary },
  }).returning({ id: reportRuns.id });
  return run!.id;
}

/** A report_runs row with no fleetDesign outcome at all — used only to
 *  satisfy the FK for the RLS forgery probe in the cross-org test. */
async function seedBareReportRun(orgId: string): Promise<string> {
  const reportId = await ensureReportDefinition(orgId);
  const [run] = await getTestDb().insert(reportRuns).values({
    reportId, status: 'completed', startedAt: new Date(), completedAt: new Date(), rowCount: 0,
    result: { rows: [], rowCount: 0, summary: {} },
  }).returning({ id: reportRuns.id });
  return run!.id;
}

// ---------------------------------------------------------------------------
// Read helpers (raw, superuser test connection — bypasses RLS)
// ---------------------------------------------------------------------------

async function readLedger(reportRunId: string) {
  return getTestDb().select().from(fleetDesignAppliedItems).where(eq(fleetDesignAppliedItems.reportRunId, reportRunId));
}

async function readPolicy(policyId: string) {
  const [row] = await getTestDb().select().from(configurationPolicies).where(eq(configurationPolicies.id, policyId));
  return row;
}

async function readAssignments(policyId: string) {
  return getTestDb().select().from(configPolicyAssignments).where(eq(configPolicyAssignments.configPolicyId, policyId));
}

async function readMonitoringLink(policyId: string) {
  const [row] = await getTestDb()
    .select()
    .from(configPolicyFeatureLinks)
    .where(and(eq(configPolicyFeatureLinks.configPolicyId, policyId), eq(configPolicyFeatureLinks.featureType, 'monitoring')));
  return row;
}

async function readAlertRuleLink(policyId: string) {
  const [row] = await getTestDb()
    .select()
    .from(configPolicyFeatureLinks)
    .where(and(eq(configPolicyFeatureLinks.configPolicyId, policyId), eq(configPolicyFeatureLinks.featureType, 'alert_rule')));
  return row;
}

async function readGroupByName(orgId: string, name: string) {
  const [row] = await getTestDb().select().from(deviceGroups).where(and(eq(deviceGroups.orgId, orgId), eq(deviceGroups.name, name)));
  return row;
}

async function readGroupMembers(groupId: string): Promise<string[]> {
  const rows = await getTestDb().select({ deviceId: deviceGroupMemberships.deviceId }).from(deviceGroupMemberships).where(eq(deviceGroupMemberships.groupId, groupId));
  return rows.map((r) => r.deviceId);
}

async function readDevice(deviceId: string) {
  const [row] = await getTestDb().select().from(devices).where(eq(devices.id, deviceId));
  return row;
}

async function readActiveAssessment(deviceId: string) {
  const [row] = await getTestDb()
    .select()
    .from(deviceFunctionAssessments)
    .where(and(eq(deviceFunctionAssessments.deviceId, deviceId), eq(deviceFunctionAssessments.active, true)));
  return row ?? null;
}

// ---------------------------------------------------------------------------

describe('Fleet Design apply / rollback / ledger against live Postgres (Fleet Designer W03, #5653)', () => {
  runDb('1. preview: keptManual, displacement, retired found, role correction', async () => {
    const f = await seedFixture();
    const runId = await seedReportRun(f.envA.orgId, buildOutcome({
      functionKey: 'file_server', deviceIds: f.deviceIds, roleCorrectionDeviceId: f.deviceIds[1], retiredPolicyId: f.baselinePolicyId, rule: GOOD_RULE,
    }));

    const preview = await withDbAccessContext(f.dbCtxA, () => previewFleetDesignApply(f.authA, runId, fullApproval(f.deviceIds)));

    expect(preview.functions[0]?.keptManual).toBe(1);
    expect(preview.policies[0]?.displaces).toEqual(
      expect.arrayContaining([expect.objectContaining({ policyId: f.baselinePolicyId, featureType: 'monitoring', deviceCount: 3 })]),
    );
    expect(preview.retired[0]?.found).toBe(true);
    expect(preview.roleCorrections[0]?.to).toBe('server');
  });

  runDb('2. apply without displacementsAccepted throws blocked; nothing is written', async () => {
    const f = await seedFixture();
    const runId = await seedReportRun(f.envA.orgId, buildOutcome({
      functionKey: 'file_server', deviceIds: f.deviceIds, roleCorrectionDeviceId: f.deviceIds[1], retiredPolicyId: f.baselinePolicyId, rule: GOOD_RULE,
    }));

    await expect(withDbAccessContext(f.dbCtxA, () => applyFleetDesign(f.authA, runId, fullApproval(f.deviceIds))))
      .rejects.toSatisfy((e: unknown) => e instanceof FleetDesignApplyError && e.code === 'blocked');

    expect(await readLedger(runId)).toEqual([]);
    expect(await readGroupByName(f.envA.orgId, 'Fleet Design: File server')).toBeUndefined();
  });

  runDb('3. apply with displacementsAccepted: writes function/group, policy, monitoring, retire, role correction', async () => {
    const f = await seedFixture();
    const runId = await seedReportRun(f.envA.orgId, buildOutcome({
      functionKey: 'file_server', deviceIds: f.deviceIds, roleCorrectionDeviceId: f.deviceIds[1], retiredPolicyId: f.baselinePolicyId, rule: GOOD_RULE,
    }));

    const result = await withDbAccessContext(f.dbCtxA, () => applyFleetDesign(f.authA, runId, fullApproval(f.deviceIds, [f.baselinePolicyId])));
    expect(result.partial).toBeNull();
    expect(result.applied.sort()).toEqual([
      'functions:file_server', 'monitoring:file_server:rule:0', 'monitoring:file_server:watch:0', 'policy:file_server', 'retired:0', `roleCorrections:${f.deviceIds[1]}`,
    ].sort());

    const group = await readGroupByName(f.envA.orgId, DEVICE_FUNCTION_LABELS.file_server ? 'Fleet Design: File server' : 'Fleet Design: file_server');
    expect(group).toBeDefined();
    expect((await readGroupMembers(group!.id)).sort()).toEqual([...f.deviceIds].sort());

    const a1 = await readActiveAssessment(f.deviceIds[0]);
    const a2 = await readActiveAssessment(f.deviceIds[1]);
    const a3 = await readActiveAssessment(f.deviceIds[2]);
    expect(a1).toMatchObject({ functionKey: 'file_server', source: 'ai', reportRunId: runId });
    expect(a2).toMatchObject({ functionKey: 'file_server', source: 'ai', reportRunId: runId });
    expect(a3).toMatchObject({ source: 'manual' });

    const ledger = await readLedger(runId);
    const policyRow = ledger.find((r) => r.itemRef === 'policy:file_server');
    expect(policyRow).toBeDefined();
    const policyId = policyRow!.createdRefs!.policyId as string;
    const policy = await readPolicy(policyId);
    expect(policy?.status).toBe('active');

    const assignments = await readAssignments(policyId);
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({ level: 'device_group', targetId: group!.id, priority: 100, roleFilter: null, osFilter: null });

    const monitoringLink = await readMonitoringLink(policyId);
    const monitoringSettings = monitoringLink?.inlineSettings as { watches: Array<{ name: string; rationale?: string }> };
    expect(monitoringSettings.watches[0]?.name).toBe('LanmanServer');
    expect(monitoringSettings.watches[0]?.rationale).toBe('Core file-sharing service');

    const alertRuleLink = await readAlertRuleLink(policyId);
    const alertRuleSettings = alertRuleLink?.inlineSettings as { items: Array<{ name: string; rationale?: string }> };
    expect(alertRuleSettings.items[0]?.rationale).toBe('Disk exhaustion breaks file shares [Action: none; Paging: business_hours]');

    const baselineMonitoringLink = await readMonitoringLink(f.baselinePolicyId);
    const baselineWatches = (baselineMonitoringLink?.inlineSettings as { watches: Array<{ name: string; enabled?: boolean }> }).watches;
    expect(baselineWatches.find((w) => w.name === 'Spooler')?.enabled).toBe(false);

    const device2 = await readDevice(f.deviceIds[1]);
    expect(device2).toMatchObject({ deviceRole: 'server', deviceRoleSource: 'ai' });

    expect(ledger.every((r) => r.status === 'applied')).toBe(true);
    expect(ledger.map((r) => r.itemRef).sort()).toEqual([
      'functions:file_server', 'monitoring:file_server:rule:0', 'monitoring:file_server:watch:0', 'policy:file_server', 'retired:0', `roleCorrections:${f.deviceIds[1]}`,
    ].sort());
  });

  runDb('4. re-apply the same approval is fully idempotent', async () => {
    const f = await seedFixture();
    const runId = await seedReportRun(f.envA.orgId, buildOutcome({
      functionKey: 'file_server', deviceIds: f.deviceIds, roleCorrectionDeviceId: f.deviceIds[1], retiredPolicyId: f.baselinePolicyId, rule: GOOD_RULE,
    }));
    await withDbAccessContext(f.dbCtxA, () => applyFleetDesign(f.authA, runId, fullApproval(f.deviceIds, [f.baselinePolicyId])));
    const ledgerBefore = await readLedger(runId);
    const policiesBefore = await getTestDb().select().from(configurationPolicies).where(eq(configurationPolicies.orgId, f.envA.orgId));
    const groupsBefore = await getTestDb().select().from(deviceGroups).where(eq(deviceGroups.orgId, f.envA.orgId));

    const second = await withDbAccessContext(f.dbCtxA, () => applyFleetDesign(f.authA, runId, fullApproval(f.deviceIds, [f.baselinePolicyId])));

    expect(second.applied).toEqual([]);
    expect(second.skipped.sort()).toEqual([
      'functions:file_server', 'monitoring:file_server:rule:0', 'monitoring:file_server:watch:0', 'retired:0', `roleCorrections:${f.deviceIds[1]}`,
    ].sort());

    const ledgerAfter = await readLedger(runId);
    const policiesAfter = await getTestDb().select().from(configurationPolicies).where(eq(configurationPolicies.orgId, f.envA.orgId));
    const groupsAfter = await getTestDb().select().from(deviceGroups).where(eq(deviceGroups.orgId, f.envA.orgId));
    expect(ledgerAfter).toHaveLength(ledgerBefore.length);
    expect(policiesAfter).toHaveLength(policiesBefore.length);
    expect(groupsAfter).toHaveLength(groupsBefore.length);
  });

  runDb("5. cross-org: preview throws not_found; RLS forges 42501, org A's own insert succeeds", async () => {
    const f = await seedFixture();
    const runId = await seedReportRun(f.envA.orgId, buildOutcome({
      functionKey: 'file_server', deviceIds: f.deviceIds, roleCorrectionDeviceId: f.deviceIds[1], retiredPolicyId: f.baselinePolicyId, rule: GOOD_RULE,
    }));

    await expect(withDbAccessContext(f.dbCtxB, () => previewFleetDesignApply(f.authB, runId, fullApproval(f.deviceIds))))
      .rejects.toSatisfy((e: unknown) => e instanceof FleetDesignApplyError && e.code === 'not_found');

    // A throwaway run under org A's OWN definition, unrelated to `runId`'s
    // ledger lifecycle, purely to satisfy the FK for the forgery probe below.
    const probeRunId = await seedBareReportRun(f.envA.orgId);
    const forged = {
      orgId: f.envA.orgId, reportRunId: probeRunId, itemRef: `test:forged-${randomUUID()}`,
      itemKind: 'function' as const, status: 'applied' as const, step: 1, createdRefs: {}, appliedByUserId: null,
    };

    await expect(withDbAccessContext(f.dbCtxB, () => db.insert(fleetDesignAppliedItems).values(forged)))
      .rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '42501');

    const [inserted] = await withDbAccessContext(f.dbCtxA, () => db.insert(fleetDesignAppliedItems).values({ ...forged, itemRef: `test:forged-ok-${randomUUID()}` }).returning());
    expect(inserted).toBeDefined();
  });

  runDb('6. rollback: policy archived, assignment gone, Spooler re-enabled, group deleted, role restored, assessments cleared', async () => {
    const f = await seedFixture();
    const runId = await seedReportRun(f.envA.orgId, buildOutcome({
      functionKey: 'file_server', deviceIds: f.deviceIds, roleCorrectionDeviceId: f.deviceIds[1], retiredPolicyId: f.baselinePolicyId, rule: GOOD_RULE,
    }));
    await withDbAccessContext(f.dbCtxA, () => applyFleetDesign(f.authA, runId, fullApproval(f.deviceIds, [f.baselinePolicyId])));
    const ledgerBefore = await readLedger(runId);
    const policyId = ledgerBefore.find((r) => r.itemRef === 'policy:file_server')!.createdRefs!.policyId as string;
    const groupId = ledgerBefore.find((r) => r.itemRef === 'functions:file_server')!.createdRefs!.groupId as string;

    const result = await withDbAccessContext(f.dbCtxA, () => rollbackFleetDesign(f.authA, runId));

    expect(result.refused).toEqual([]);
    expect(result.rolledBack.sort()).toEqual(ledgerBefore.map((r) => r.itemRef).sort());

    const policy = await readPolicy(policyId);
    expect(policy?.status).toBe('archived');
    expect(await readAssignments(policyId)).toEqual([]);

    const baselineMonitoringLink = await readMonitoringLink(f.baselinePolicyId);
    const baselineWatches = (baselineMonitoringLink?.inlineSettings as { watches: Array<{ name: string; enabled?: boolean }> }).watches;
    expect(baselineWatches.find((w) => w.name === 'Spooler')?.enabled).toBe(true);

    const group = await getTestDb().select().from(deviceGroups).where(eq(deviceGroups.id, groupId));
    expect(group).toEqual([]);

    const device2 = await readDevice(f.deviceIds[1]);
    expect(device2).toMatchObject({ deviceRole: 'unknown', deviceRoleSource: 'auto' });

    expect(await readActiveAssessment(f.deviceIds[0])).toBeNull();
    expect(await readActiveAssessment(f.deviceIds[1])).toBeNull();
    const device1 = await readDevice(f.deviceIds[0]);
    expect(device1).toMatchObject({ deviceFunction: null, deviceFunctionSource: null });
    const activeD3 = await readActiveAssessment(f.deviceIds[2]);
    expect(activeD3).toMatchObject({ source: 'manual' });

    const ledgerAfter = await readLedger(runId);
    expect(ledgerAfter.every((r) => r.status === 'rolled_back')).toBe(true);
  });

  runDb('7. rollback refusal: a corrupted policy link refuses policy + functions; the rest rolls back', async () => {
    const f = await seedFixture();
    // A fresh design run against the SAME devices — the org-level baseline
    // policy's Spooler watch is enabled again after test 6's rollback, so
    // this is a genuine independent apply, not a re-apply of a rolled-back ref.
    const runId = await seedReportRun(f.envA.orgId, buildOutcome({
      functionKey: 'file_server', deviceIds: f.deviceIds, roleCorrectionDeviceId: f.deviceIds[1], retiredPolicyId: f.baselinePolicyId, rule: GOOD_RULE,
    }));
    await withDbAccessContext(f.dbCtxA, () => applyFleetDesign(f.authA, runId, fullApproval(f.deviceIds, [f.baselinePolicyId])));
    const ledger = await readLedger(runId);
    const policyId = ledger.find((r) => r.itemRef === 'policy:file_server')!.createdRefs!.policyId as string;

    // Corrupt the created policy's monitoring link by hand.
    await withDbAccessContext(f.dbCtxA, async () => {
      const links = await listFeatureLinks(policyId);
      const monitoringLink = links.find((l) => l.featureType === 'monitoring')!;
      const settings = monitoringLink.inlineSettings as { checkIntervalSeconds: number; watches: Array<Record<string, unknown>> };
      await updateFeatureLink(monitoringLink.id, {
        inlineSettings: { ...settings, watches: settings.watches.map((w) => ({ ...w, name: 'CorruptedWatchName' })) },
      }, policyId);
    });

    const result = await withDbAccessContext(f.dbCtxA, () => rollbackFleetDesign(f.authA, runId));

    expect(result.refused).toEqual(expect.arrayContaining([
      { itemRef: 'policy:file_server', reason: 'modified_since_apply' },
      { itemRef: 'functions:file_server', reason: 'modified_since_apply' },
    ]));
    expect(result.refused).toHaveLength(2);
    expect(result.rolledBack).toEqual(expect.arrayContaining(['retired:0', `roleCorrections:${f.deviceIds[1]}`]));
    expect(result.rolledBack).toHaveLength(2);

    const policy = await readPolicy(policyId);
    expect(policy?.status).toBe('active'); // untouched — refused, not rolled back
  });

  runDb('8. partial apply: an invalid rule shape fails step 3; steps 1-2 stay applied; rollback restores them', async () => {
    const f = await seedFixture();
    // Independent devices + function key so this scenario cannot collide
    // with test 7's dangling (refused, still-`applied`) file_server group.
    const dPrint1 = await createDevice(f.envA.orgId, f.envA.siteId, 'fda-print-1');
    const dPrint2 = await createDevice(f.envA.orgId, f.envA.siteId, 'fda-print-2');
    const dPrint3 = await createDevice(f.envA.orgId, f.envA.siteId, 'fda-print-3');
    const printDeviceIds: [string, string, string] = [dPrint1, dPrint2, dPrint3];

    const submission = buildSubmission({
      functionKey: 'print_server', deviceIds: printDeviceIds, roleCorrectionDeviceId: printDeviceIds[1], retiredPolicyId: f.baselinePolicyId, rule: BAD_RULE,
    });
    const outcome = fleetDesignOutcomeFromSubmission(submission, {
      deviceIds: new Set(printDeviceIds),
      baseline: { alertsPer100EndpointsPerMonth: null, ticketsPerMonth: null, precursors: [] },
      generatedAt: new Date().toISOString(),
    });
    const runId = await seedReportRun(f.envA.orgId, outcome);
    const approval: FleetDesignApproval = {
      functions: ['print_server'],
      monitoring: ['monitoring:print_server:watch:0', 'monitoring:print_server:rule:0'],
      retired: ['retired:0'],
      automation: [], legacy: [],
      roleCorrections: [printDeviceIds[1]],
      displacementsAccepted: [f.baselinePolicyId],
    };

    const result = await withDbAccessContext(f.dbCtxA, () => applyFleetDesign(f.authA, runId, approval));
    expect(result.partial).toMatchObject({ failedStep: 3 });
    expect(result.applied.sort()).toEqual(['functions:print_server', 'retired:0'].sort());

    const group = await readGroupByName(f.envA.orgId, 'Fleet Design: Print server');
    expect(group).toBeDefined();
    expect((await readGroupMembers(group!.id)).sort()).toEqual([...printDeviceIds].sort());

    const baselineMonitoringLink = await readMonitoringLink(f.baselinePolicyId);
    const baselineWatches = (baselineMonitoringLink?.inlineSettings as { watches: Array<{ name: string; enabled?: boolean }> }).watches;
    expect(baselineWatches.find((w) => w.name === 'Spooler')?.enabled).toBe(false);

    const ledger = await readLedger(runId);
    const failedRow = ledger.find((r) => r.itemRef === 'step:3');
    expect(failedRow).toMatchObject({ status: 'failed', itemKind: 'policy' });
    expect(ledger.filter((r) => r.status === 'applied').map((r) => r.itemRef).sort()).toEqual(['functions:print_server', 'retired:0'].sort());

    const rollback = await withDbAccessContext(f.dbCtxA, () => rollbackFleetDesign(f.authA, runId));
    expect(rollback.refused).toEqual([]);
    expect(rollback.rolledBack.sort()).toEqual(['functions:print_server', 'retired:0'].sort());
    const groupAfterRollback = await getTestDb().select().from(deviceGroups).where(eq(deviceGroups.id, group!.id));
    expect(groupAfterRollback).toEqual([]);
    const baselineAfterRollback = await readMonitoringLink(f.baselinePolicyId);
    const watchesAfterRollback = (baselineAfterRollback?.inlineSettings as { watches: Array<{ name: string; enabled?: boolean }> }).watches;
    expect(watchesAfterRollback.find((w) => w.name === 'Spooler')?.enabled).toBe(true);
  });

  runDb('9. org erasure clears the ledger and leaves the sibling org intact', async () => {
    const f = await seedFixture();
    const runId = await seedReportRun(f.envA.orgId, buildOutcome({
      functionKey: 'file_server', deviceIds: f.deviceIds, roleCorrectionDeviceId: f.deviceIds[1], retiredPolicyId: f.baselinePolicyId, rule: GOOD_RULE,
    }));
    await withDbAccessContext(f.dbCtxA, () => applyFleetDesign(f.authA, runId, fullApproval(f.deviceIds, [f.baselinePolicyId])));
    expect((await readLedger(runId)).length).toBeGreaterThan(0);

    // A second org's ledger row (raw, unrelated to any real design), to
    // prove erasure does not touch a sibling tenant.
    const bareRunB = await seedBareReportRun(f.envB.orgId);
    await getTestDb().insert(fleetDesignAppliedItems).values({
      orgId: f.envB.orgId, reportRunId: bareRunB, itemRef: 'test:sibling-untouched', itemKind: 'function', status: 'applied', step: 1, createdRefs: {}, appliedByUserId: null,
    });

    // `fleet_design_applied_items.report_run_id` is ON DELETE CASCADE and
    // `report_runs` is pre-cleared earlier in the same erasure transaction
    // (tenantCascade.ts's clear-first list), so by the time the main
    // alphabetical cascade loop reaches this table its own rows are already
    // gone — its explicit DELETE legitimately reports 0 (see the
    // `fleet_design_applied_items` comment in CORE_ORG_CASCADE_DELETE_ORDER:
    // "either order is a no-op for the other"). The real proof is the row
    // count below, not `stats.tablesDeleted`.
    const stats = await cascadeDeleteOrg(f.envA.orgId, '00000000-0000-4000-8000-000000000001', 'erasure@test.local');
    void stats;

    const remainingA = await getTestDb().select({ id: fleetDesignAppliedItems.id }).from(fleetDesignAppliedItems).where(eq(fleetDesignAppliedItems.orgId, f.envA.orgId));
    expect(remainingA).toEqual([]);
    const remainingB = await getTestDb().select({ id: fleetDesignAppliedItems.id }).from(fleetDesignAppliedItems).where(eq(fleetDesignAppliedItems.orgId, f.envB.orgId));
    expect(remainingB).toHaveLength(1);
  });
});
