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
import { describe, expect, it, vi } from 'vitest';
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
  configPolicyAlertRules,
  configPolicyMonitoringSettings,
  configPolicyMonitoringWatches,
  configPolicyFeatureLinks,
  configPolicyMonitors,
  configurationPolicies,
  deviceFunctionAssessments,
  deviceGroupMemberships,
  deviceGroups,
  devices,
  fleetDesignAppliedItems,
  monitorDefinitions,
  reportRuns,
  reports,
  scripts,
  scriptTags,
  scriptToTags,
  scriptVersions,
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
import { attachFleetMonitors } from '../../services/fleetDesign/monitorAttachments';
import { updateMonitorDefinition } from '../../services/monitors/monitorService';
import { loadLedger } from '../../services/fleetDesign/ledger';
import { FleetDesignApplyError, previewFleetDesignApply } from '../../services/fleetDesign/preview';
import { rollbackFleetDesign } from '../../services/fleetDesign/rollback';
import * as scriptBundle from '../../services/scriptBundle';
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
    // Persist the retained legacy link and retired child exactly as after upgrading.
    const legacySettings = {
      checkIntervalSeconds: 60,
      watches: [{ watchType: 'service', name: 'Spooler', enabled: true, alertOnStop: true, autoRestart: false }],
    };
    await db.insert(configPolicyFeatureLinks).values({ configPolicyId: policy.id, featureType: 'monitoring', inlineSettings: legacySettings });
    const monitorsLink = await addFeatureLink(policy.id, 'monitors', null, { inheritance: 'cumulative', items: [], checkIntervalSeconds: 60 });
    // The upgrade re-keys monitoring settings to the monitors link.
    const [settings] = await db.insert(configPolicyMonitoringSettings).values({ featureLinkId: monitorsLink!.id, checkIntervalSeconds: 60 }).onConflictDoUpdate({
      target: configPolicyMonitoringSettings.featureLinkId, set: { checkIntervalSeconds: 60 },
    }).returning();
    await db.insert(configPolicyMonitoringWatches).values({ settingsId: settings!.id, watchType: 'service', name: 'Spooler', retiredAt: new Date(), retiredReason: 'unconvertible:equivalence_delta' });
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
  kind: 'disk',
  condition: { operator: 'gt', value: 90, durationMinutes: 15 },
  responses: [],
  deliveryMode: 'inherit',
  deliveryChannelIds: [],
  cooldownMinutes: 30,
  rationale: 'Disk exhaustion breaks file shares',
  action: 'none',
  paging: 'business_hours',
};

/** Deliberately bypasses fleetDesignSubmissionSchema (name > the monitor
 *  definition's max(200)) — case 8 models a stored outcome whose rule content the
 *  apply-time monitor writer (createMonitorDefinitionSchema, W05c2) is the one to
 *  reject, not the HTTP submission validator. */
const BAD_RULE: FleetDesignRule = {
  name: 'x'.repeat(250),
  severity: 'high',
  kind: 'cpu',
  condition: { operator: 'gt', value: 1 },
  responses: [],
  deliveryMode: 'inherit',
  deliveryChannelIds: [],
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
    retired: [],
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

async function readLegacyWatches(policyId: string) {
  return getTestDb().select({ watch: configPolicyMonitoringWatches })
    .from(configPolicyMonitoringWatches)
    .innerJoin(configPolicyMonitoringSettings, eq(configPolicyMonitoringWatches.settingsId, configPolicyMonitoringSettings.id))
    .innerJoin(configPolicyFeatureLinks, eq(configPolicyMonitoringSettings.featureLinkId, configPolicyFeatureLinks.id))
    .where(eq(configPolicyFeatureLinks.configPolicyId, policyId));
}

async function readAlertRuleLink(policyId: string) {
  const [row] = await getTestDb()
    .select()
    .from(configPolicyFeatureLinks)
    .where(and(eq(configPolicyFeatureLinks.configPolicyId, policyId), eq(configPolicyFeatureLinks.featureType, 'alert_rule')));
  return row;
}

/** The monitor definitions attached through a policy's inline `monitors` link (W05c2). */
async function readPolicyMonitors(policyId: string) {
  const rows = await getTestDb()
    .select({ definition: monitorDefinitions, attachment: configPolicyMonitors })
    .from(configPolicyMonitors)
    .innerJoin(configPolicyFeatureLinks, eq(configPolicyFeatureLinks.id, configPolicyMonitors.featureLinkId))
    .innerJoin(monitorDefinitions, eq(monitorDefinitions.id, configPolicyMonitors.monitorId))
    .where(and(eq(configPolicyFeatureLinks.configPolicyId, policyId), eq(configPolicyFeatureLinks.featureType, 'monitors')));
  return rows;
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
  runDb('1. preview: keptManual, cumulative monitors without displacement, no retirement selection, role correction', async () => {
    const f = await seedFixture();
    const runId = await seedReportRun(f.envA.orgId, buildOutcome({
      functionKey: 'file_server', deviceIds: f.deviceIds, roleCorrectionDeviceId: f.deviceIds[1], retiredPolicyId: f.baselinePolicyId, rule: GOOD_RULE,
    }));

    // Historical outcomes can carry retirement proposals, but they are no
    // longer selectable. Case 11 covers explicitly submitting a stale ref.
    const preview = await withDbAccessContext(f.dbCtxA, () => previewFleetDesignApply(f.authA, runId, fullApproval(f.deviceIds)));

    expect(preview.functions[0]?.keptManual).toBe(1);
    // The existing organization-level cumulative monitors link keeps
    // contributing alongside the proposed device-group policy.
    expect(preview.policies).toHaveLength(1);
    expect(preview.policies[0]).toMatchObject({ functionKey: 'file_server', watchCount: 1, ruleCount: 1, displaces: [] });
    expect(preview.retired).toEqual([]);
    expect(preview.blockers).toEqual([]);
    expect(preview.roleCorrections[0]?.to).toBe('server');
  });

  runDb('2. apply without displacementsAccepted succeeds for cumulative monitors', async () => {
    const f = await seedFixture();
    const runId = await seedReportRun(f.envA.orgId, buildOutcome({
      functionKey: 'file_server', deviceIds: f.deviceIds, roleCorrectionDeviceId: f.deviceIds[1], retiredPolicyId: f.baselinePolicyId, rule: GOOD_RULE,
    }));

    const approval = fullApproval(f.deviceIds);
    expect(approval.displacementsAccepted).toEqual([]);
    const baselineAssignments = await readAssignments(f.baselinePolicyId);
    const result = await withDbAccessContext(f.dbCtxA, () => applyFleetDesign(f.authA, runId, approval));

    expect(result.partial).toBeNull();
    const expectedRefs = [
      'functions:file_server', 'monitoring:file_server:rule:0', 'monitoring:file_server:watch:0', 'policy:file_server', `roleCorrections:${f.deviceIds[1]}`,
    ].sort();
    expect(result.applied.sort()).toEqual(expectedRefs);
    const ledger = await readLedger(runId);
    expect(ledger.map((row) => row.itemRef).sort()).toEqual(expectedRefs);
    expect(ledger.every((row) => row.status === 'applied')).toBe(true);
    const group = await readGroupByName(f.envA.orgId, 'Fleet Design: File server');
    expect(group).toBeDefined();
    expect((await readGroupMembers(group!.id)).sort()).toEqual([...f.deviceIds].sort());
    const policyId = ledger.find((row) => row.itemRef === 'policy:file_server')!.createdRefs!.policyId as string;
    expect((await readPolicyMonitors(policyId)).map((row) => row.definition.kind).sort()).toEqual(['disk', 'service']);
    expect(await readAssignments(f.baselinePolicyId)).toEqual(baselineAssignments);
    expect(await readPolicy(f.baselinePolicyId)).toMatchObject({ status: 'active' });
  });

  runDb('3. apply with displacementsAccepted: writes function/group, policy, monitors and role correction; legacy sources stay untouched', async () => {
    const f = await seedFixture();
    const runId = await seedReportRun(f.envA.orgId, buildOutcome({
      functionKey: 'file_server', deviceIds: f.deviceIds, roleCorrectionDeviceId: f.deviceIds[1], retiredPolicyId: f.baselinePolicyId, rule: GOOD_RULE,
    }));

    const result = await withDbAccessContext(f.dbCtxA, () => applyFleetDesign(f.authA, runId, fullApproval(f.deviceIds, [f.baselinePolicyId])));
    expect(result.partial).toBeNull();
    expect(result.applied.sort()).toEqual([
      'functions:file_server', 'monitoring:file_server:rule:0', 'monitoring:file_server:watch:0', 'policy:file_server', `roleCorrections:${f.deviceIds[1]}`,
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

    // W05c2: the policy carries ONE `monitors` link — no legacy watch/rule links.
    const links = await withDbAccessContext(f.dbCtxA, () => listFeatureLinks(policyId));
    expect(links.map((link) => link.featureType)).toEqual(['monitors']);
    expect(await readMonitoringLink(policyId)).toBeUndefined();
    expect(await readAlertRuleLink(policyId)).toBeUndefined();
    const made = await readPolicyMonitors(policyId);
    expect(made.map((row) => row.definition.kind).sort()).toEqual(['disk', 'service']);
    expect(made.every((row) => row.definition.orgId === f.envA.orgId && row.definition.partnerId === null)).toBe(true);
    expect(made.every((row) => row.definition.compiledAlertRuleId !== null)).toBe(true);
    const watchMonitor = made.find((row) => row.definition.kind === 'service')!.definition;
    expect(watchMonitor).toMatchObject({ name: 'LanmanServer', description: 'Core file-sharing service', condition: { serviceName: 'LanmanServer' } });
    expect(watchMonitor.responses).toEqual([expect.objectContaining({ type: 'execute_command', kind: 'restart_service' })]);
    const ruleMonitor = made.find((row) => row.definition.kind === 'disk')!.definition;
    expect(ruleMonitor.description).toBe('Disk exhaustion breaks file shares [Action: none; Paging: business_hours]');
    // Every watch/rule ledger row names the monitor it created.
    const ruleLedger = (await readLedger(runId)).find((r) => r.itemRef === 'monitoring:file_server:rule:0');
    expect(ruleLedger?.createdRefs?.monitorId).toBe(ruleMonitor.id);

    const baselineMonitoringLink = await readMonitoringLink(f.baselinePolicyId);
    const baselineWatches = (baselineMonitoringLink?.inlineSettings as { watches: Array<{ name: string; enabled?: boolean }> }).watches;
    expect(baselineWatches.find((w) => w.name === 'Spooler')?.enabled).toBe(true);

    const device2 = await readDevice(f.deviceIds[1]);
    expect(device2).toMatchObject({ deviceRole: 'server', deviceRoleSource: 'ai' });

    expect(ledger.every((r) => r.status === 'applied')).toBe(true);
    expect(ledger.map((r) => r.itemRef).sort()).toEqual([
      'functions:file_server', 'monitoring:file_server:rule:0', 'monitoring:file_server:watch:0', 'policy:file_server', `roleCorrections:${f.deviceIds[1]}`,
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
    const monitorsBefore = await getTestDb().select({ id: monitorDefinitions.id }).from(monitorDefinitions).where(eq(monitorDefinitions.orgId, f.envA.orgId));

    const second = await withDbAccessContext(f.dbCtxA, () => applyFleetDesign(f.authA, runId, fullApproval(f.deviceIds, [f.baselinePolicyId])));

    expect(second.applied).toEqual([]);
    expect(second.skipped.sort()).toEqual([
      'functions:file_server', 'monitoring:file_server:rule:0', 'monitoring:file_server:watch:0', `roleCorrections:${f.deviceIds[1]}`,
    ].sort());

    const ledgerAfter = await readLedger(runId);
    const policiesAfter = await getTestDb().select().from(configurationPolicies).where(eq(configurationPolicies.orgId, f.envA.orgId));
    const groupsAfter = await getTestDb().select().from(deviceGroups).where(eq(deviceGroups.orgId, f.envA.orgId));
    expect(ledgerAfter).toHaveLength(ledgerBefore.length);
    expect(policiesAfter).toHaveLength(policiesBefore.length);
    expect(groupsAfter).toHaveLength(groupsBefore.length);
    const monitorsAfter = await getTestDb().select({ id: monitorDefinitions.id }).from(monitorDefinitions).where(eq(monitorDefinitions.orgId, f.envA.orgId));
    expect(monitorsAfter).toHaveLength(monitorsBefore.length);
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

  runDb('6. rollback: policy archived, assignment gone, legacy Spooler unchanged, group deleted, role restored, assessments cleared', async () => {
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

    // Edit the created policy's monitors link by hand (disable every attachment).
    await withDbAccessContext(f.dbCtxA, async () => {
      const links = await listFeatureLinks(policyId);
      const monitorsLink = links.find((l) => l.featureType === 'monitors')!;
      const settings = monitorsLink.inlineSettings as { inheritance: string; items: Array<Record<string, unknown>> };
      await updateFeatureLink(monitorsLink.id, {
        inlineSettings: { ...settings, items: settings.items.map((item) => ({ ...item, enabled: false })) },
      }, policyId);
    });

    const result = await withDbAccessContext(f.dbCtxA, () => rollbackFleetDesign(f.authA, runId));

    expect(result.refused).toEqual(expect.arrayContaining([
      { itemRef: 'policy:file_server', reason: 'modified_since_apply' },
      { itemRef: 'functions:file_server', reason: 'modified_since_apply' },
    ]));
    expect(result.refused).toHaveLength(2);
    expect(result.rolledBack).toEqual(expect.arrayContaining([`roleCorrections:${f.deviceIds[1]}`]));
    expect(result.rolledBack).toHaveLength(1);

    const policy = await readPolicy(policyId);
    expect(policy?.status).toBe('active'); // untouched — refused, not rolled back
  });

  runDb('8. partial apply: an invalid rule shape fails step 3; function changes stay applied and rollback restores them', async () => {
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
      retired: [],
      automation: [], legacy: [],
      roleCorrections: [printDeviceIds[1]],
      displacementsAccepted: [f.baselinePolicyId],
    };

    const result = await withDbAccessContext(f.dbCtxA, () => applyFleetDesign(f.authA, runId, approval));
    expect(result.partial).toMatchObject({ failedStep: 3 });
    expect(result.applied.sort()).toEqual(['functions:print_server'].sort());

    const group = await readGroupByName(f.envA.orgId, 'Fleet Design: Print server');
    expect(group).toBeDefined();
    expect((await readGroupMembers(group!.id)).sort()).toEqual([...printDeviceIds].sort());

    const baselineMonitoringLink = await readMonitoringLink(f.baselinePolicyId);
    const baselineWatches = (baselineMonitoringLink?.inlineSettings as { watches: Array<{ name: string; enabled?: boolean }> }).watches;
    expect(baselineWatches.find((w) => w.name === 'Spooler')?.enabled).toBe(true);

    const ledger = await readLedger(runId);
    const failedRow = ledger.find((r) => r.itemRef === 'step:3');
    expect(failedRow).toMatchObject({ status: 'failed', itemKind: 'policy' });
    expect(ledger.filter((r) => r.status === 'applied').map((r) => r.itemRef).sort()).toEqual(['functions:print_server'].sort());

    const rollback = await withDbAccessContext(f.dbCtxA, () => rollbackFleetDesign(f.authA, runId));
    expect(rollback.refused).toEqual([]);
    expect(rollback.rolledBack.sort()).toEqual(['functions:print_server'].sort());
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

  runDb('10. second apply of the same run unions monitoring onto the SAME policy, not a new one; rollback of the whole run succeeds', async () => {
    const f = await seedFixture();
    const runId = await seedReportRun(f.envA.orgId, buildOutcome({
      functionKey: 'file_server', deviceIds: f.deviceIds, roleCorrectionDeviceId: f.deviceIds[1], retiredPolicyId: f.baselinePolicyId, rule: GOOD_RULE,
    }));

    // First apply: approve only the watch. Creates the group + policy.
    const firstApproval: FleetDesignApproval = {
      functions: ['file_server'], monitoring: ['monitoring:file_server:watch:0'], retired: [], automation: [], legacy: [],
      roleCorrections: [], displacementsAccepted: [f.baselinePolicyId],
    };
    const first = await withDbAccessContext(f.dbCtxA, () => applyFleetDesign(f.authA, runId, firstApproval));
    expect(first.partial).toBeNull();
    expect(first.applied.sort()).toEqual(['functions:file_server', 'monitoring:file_server:watch:0', 'policy:file_server'].sort());

    const ledgerAfterFirst = await readLedger(runId);
    const policyId = ledgerAfterFirst.find((r) => r.itemRef === 'policy:file_server')!.createdRefs!.policyId as string;

    // Second apply of the SAME run: approve the alert rule this time.
    const secondApproval: FleetDesignApproval = {
      functions: ['file_server'], monitoring: ['monitoring:file_server:rule:0'], retired: [], automation: [], legacy: [],
      roleCorrections: [], displacementsAccepted: [f.baselinePolicyId],
    };
    const second = await withDbAccessContext(f.dbCtxA, () => applyFleetDesign(f.authA, runId, secondApproval));
    expect(second.partial).toBeNull();
    expect(second.applied).toEqual(['monitoring:file_server:rule:0']);
    expect(second.skipped).toEqual(expect.arrayContaining(['functions:file_server']));

    // Exactly one Fleet Design policy exists (no duplicate created on the second apply).
    const namedPolicies = await getTestDb()
      .select()
      .from(configurationPolicies)
      .where(and(eq(configurationPolicies.orgId, f.envA.orgId), eq(configurationPolicies.name, 'Fleet Design: File server')));
    expect(namedPolicies).toHaveLength(1);
    expect(namedPolicies[0]!.id).toBe(policyId);

    // One monitors link carries both items (watch from apply 1, rule from apply 2).
    expect((await readPolicyMonitors(policyId)).map((row) => row.definition.name).sort())
      .toEqual(['File server disk full', 'LanmanServer'].sort());
    expect(await readMonitoringLink(policyId)).toBeUndefined();
    expect(await readAlertRuleLink(policyId)).toBeUndefined();

    // Ledger has exactly ONE policy:<key> row, refreshed to cover both.
    const ledgerAfterSecond = await readLedger(runId);
    const policyRows = ledgerAfterSecond.filter((r) => r.itemRef === 'policy:file_server');
    expect(policyRows).toHaveLength(1);
    const createdRefs = policyRows[0]!.createdRefs!;
    const linksSnapshot = createdRefs.linksSnapshot as { monitoring: unknown; alertRule: unknown; monitors?: unknown };
    expect(linksSnapshot.monitors).toBeDefined();
    expect(linksSnapshot.monitoring).toBeNull();
    expect(linksSnapshot.alertRule).toBeNull();
    expect(Object.keys(createdRefs.monitorIdsByItemRef ?? {}).sort())
      .toEqual(['monitoring:file_server:rule:0', 'monitoring:file_server:watch:0']);

    // Rollback of the run succeeds — must NOT refuse with modified_since_apply
    // (the failure this case exists to catch: an unrefreshed linksSnapshot
    // from the first apply would no longer equal the current, unioned links).
    const rollback = await withDbAccessContext(f.dbCtxA, () => rollbackFleetDesign(f.authA, runId));
    expect(rollback.refused).toEqual([]);
    expect(rollback.rolledBack).toEqual(expect.arrayContaining([
      'functions:file_server', 'policy:file_server', 'monitoring:file_server:watch:0', 'monitoring:file_server:rule:0',
    ]));

    const policyAfterRollback = await readPolicy(policyId);
    expect(policyAfterRollback?.status).toBe('archived');
  });

  for (const kind of ['watch', 'rule'] as const) {
    runDb(`11. legacy ${kind} retirement blocks the whole approval and preserves historical rows`, async () => {
      const f = await seedFixture();
      const legacyItems = [
        { name: 'LegacyDiskRule', severity: 'high' as const, conditions: [{ type: 'metric', metric: 'disk', operator: 'gt', value: 90 }], cooldownMinutes: 30, rationale: 'stale' },
        { name: 'KeepRule', severity: 'low' as const, conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 90 }], cooldownMinutes: 15, rationale: 'keep me' },
      ];
      await withDbAccessContext(f.dbCtxA, async () => {
        const [link] = await db.insert(configPolicyFeatureLinks).values({
          configPolicyId: f.baselinePolicyId, featureType: 'alert_rule', inlineSettings: { items: legacyItems },
        }).returning();
        await db.insert(configPolicyAlertRules).values(legacyItems.map((item, sortOrder) => ({
          ...item, featureLinkId: link!.id, sortOrder, retiredAt: new Date(), retiredReason: 'unconvertible:equivalence_delta',
        })));
      });
      const submission: FleetDesignSubmission = {
        ...buildSubmission({ functionKey: 'file_server', deviceIds: f.deviceIds, roleCorrectionDeviceId: f.deviceIds[1], retiredPolicyId: f.baselinePolicyId, rule: GOOD_RULE }),
        retired: [{ kind, policyId: f.baselinePolicyId, policyName: 'Server Baseline Monitoring', itemName: kind === 'rule' ? 'LegacyDiskRule' : 'Spooler', reason: 'Superseded' }],
      };
      const outcome = fleetDesignOutcomeFromSubmission(submission, {
        deviceIds: new Set(f.deviceIds),
        baseline: { alertsPer100EndpointsPerMonth: null, ticketsPerMonth: null, precursors: [] },
        generatedAt: new Date().toISOString(),
      });
      const runId = await seedReportRun(f.envA.orgId, outcome);
      const approval = { ...fullApproval(f.deviceIds, [f.baselinePolicyId]), retired: ['retired:0'] };
      const linkBefore = await readAlertRuleLink(f.baselinePolicyId);
      const watchLinkBefore = await readMonitoringLink(f.baselinePolicyId);
      const rulesBefore = await getTestDb().select().from(configPolicyAlertRules).where(eq(configPolicyAlertRules.featureLinkId, linkBefore!.id));
      const watchesBefore = await readLegacyWatches(f.baselinePolicyId);
      const roleBefore = await readDevice(f.deviceIds[1]);
      await expect(withDbAccessContext(f.dbCtxA, () => applyFleetDesign(f.authA, runId, approval)))
        .rejects.toMatchObject({ code: 'blocked', payload: { blockers: [{ itemRef: 'retired:0', reason: 'legacy_source_retired' }] } });
      expect(await readLedger(runId)).toEqual([]);
      expect(await readGroupByName(f.envA.orgId, 'Fleet Design: File server')).toBeUndefined();
      expect(await readDevice(f.deviceIds[1])).toEqual(roleBefore);
      expect(await readAlertRuleLink(f.baselinePolicyId)).toEqual(linkBefore);
      expect(await readMonitoringLink(f.baselinePolicyId)).toEqual(watchLinkBefore);
      expect(await getTestDb().select().from(configPolicyAlertRules).where(eq(configPolicyAlertRules.featureLinkId, linkBefore!.id))).toEqual(rulesBefore);
      expect(await readLegacyWatches(f.baselinePolicyId)).toEqual(watchesBefore);

      // A pre-upgrade ledger can still be inspected, but rollback must not
      // recreate or edit a retired source even though its historical link exists.
      const targetLink = kind === 'rule' ? linkBefore! : watchLinkBefore!;
      await withDbAccessContext(f.dbCtxA, () => db.insert(fleetDesignAppliedItems).values({
        reportRunId: runId, orgId: f.envA.orgId, itemRef: 'retired:0', itemKind: 'retired',
        step: 2, status: 'applied', appliedByUserId: f.envA.userId,
        createdRefs: { policyId: f.baselinePolicyId, linkId: targetLink.id },
        beforeImage: { inlineSettings: targetLink.inlineSettings },
      }));
      const ledgerBefore = await readLedger(runId);
      const rollback = await withDbAccessContext(f.dbCtxA, () => rollbackFleetDesign(f.authA, runId));
      expect(rollback.rolledBack).toEqual([]);
      expect(rollback.refused).toEqual([{ itemRef: 'retired:0', reason: 'legacy_source_retired' }]);
      expect(await readLedger(runId)).toEqual(ledgerBefore);
      expect(await readAlertRuleLink(f.baselinePolicyId)).toEqual(linkBefore);
      expect(await readMonitoringLink(f.baselinePolicyId)).toEqual(watchLinkBefore);
      expect(await getTestDb().select().from(configPolicyAlertRules).where(eq(configPolicyAlertRules.featureLinkId, linkBefore!.id))).toEqual(rulesBefore);
      expect(await readLegacyWatches(f.baselinePolicyId)).toEqual(watchesBefore);

    });
  }

  // -------------------------------------------------------------------------
  // W04 (#5654): step 4 — approved scripts through the bundle importer
  // -------------------------------------------------------------------------
  async function scriptTagNames(scriptId: string): Promise<string[]> {
    const rows = await getTestDb()
      .select({ name: scriptTags.name })
      .from(scriptToTags)
      .innerJoin(scriptTags, eq(scriptTags.id, scriptToTags.tagId))
      .where(eq(scriptToTags.scriptId, scriptId));
    return rows.map((r) => r.name);
  }

  runDb('12. step 4: an approved script is created org-owned, tagged fleet-design, versioned as ai_proposal; the rule naming it carries its id; re-apply is a no-op; rollback untags and keeps it', async () => {
    const f = await seedFixture();
    const spoolerRule: FleetDesignRule = { ...GOOD_RULE, name: 'Spooler stuck', action: { kind: 'script', ref: 'Restart print spooler' } };
    // A same-named script already in the org → the created one is renamed, never versioned over it.
    const [existing] = await getTestDb().insert(scripts).values({
      orgId: f.envA.orgId, partnerId: f.envA.partnerId, name: 'Restart print spooler', osTypes: ['windows'], language: 'powershell',
      content: 'Write-Output "hand-written"', createdBy: f.envA.userId,
    }).returning({ id: scripts.id });
    const submission: FleetDesignSubmission = {
      ...buildSubmission({ functionKey: 'file_server', deviceIds: f.deviceIds, roleCorrectionDeviceId: f.deviceIds[1], retiredPolicyId: f.baselinePolicyId, rule: spoolerRule }),
      automation: [{ functionKey: 'file_server', playbooks: [], scripts: [{ name: 'Restart print spooler', purpose: 'Restart the spooler when jobs pile up', osTypes: ['windows'], language: 'powershell', content: 'Restart-Service Spooler' }] }],
    };
    const outcome = fleetDesignOutcomeFromSubmission(submission, {
      deviceIds: new Set(f.deviceIds), baseline: { alertsPer100EndpointsPerMonth: null, ticketsPerMonth: null, precursors: [] }, generatedAt: new Date().toISOString(),
    });
    const runId = await seedReportRun(f.envA.orgId, outcome);
    const approval: FleetDesignApproval = {
      functions: ['file_server'], monitoring: ['monitoring:file_server:rule:0'], retired: [], automation: ['automation:file_server:script:0'], legacy: [],
      roleCorrections: [], displacementsAccepted: [f.baselinePolicyId],
    };

    const preview = await withDbAccessContext(f.dbCtxA, () => previewFleetDesignApply(f.authA, runId, approval));
    expect(preview.blockers).toEqual([]);
    expect(preview.scripts).toEqual([expect.objectContaining({ itemRef: 'automation:file_server:script:0', alreadyExists: true })]);

    const result = await withDbAccessContext(f.dbCtxA, () => applyFleetDesign(f.authA, runId, approval));
    expect(result.partial).toBeNull();
    expect(result.applied).toContain('automation:file_server:script:0');

    const ledger = await readLedger(runId);
    const scriptRow = ledger.find((r) => r.itemRef === 'automation:file_server:script:0')!;
    expect(scriptRow).toMatchObject({ itemKind: 'script', step: 4, status: 'applied' });
    const scriptId = scriptRow.createdRefs!.scriptId as string;
    expect(scriptId).not.toBe(existing!.id);

    const [created] = await getTestDb().select().from(scripts).where(eq(scripts.id, scriptId));
    expect(created).toMatchObject({
      orgId: f.envA.orgId, name: 'Restart print spooler (2)', category: 'Fleet Design', origin: 'ai_proposal', originProposalId: null,
      isSystem: false, acknowledgedSecurityPatterns: [], securityAcknowledgedBy: null, version: 1,
    });
    expect(await scriptTagNames(scriptId)).toEqual(['fleet-design']);
    const versions = await getTestDb().select().from(scriptVersions).where(eq(scriptVersions.scriptId, scriptId));
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, origin: 'ai_proposal', proposalId: null, reviewId: null, approvedBy: f.envA.userId, approvalMethod: null, content: 'Restart-Service Spooler' });
    expect(versions[0]!.approvedAt).toBeInstanceOf(Date);
    // The pre-existing script is untouched.
    const [untouched] = await getTestDb().select().from(scripts).where(eq(scripts.id, existing!.id));
    expect(untouched!.content).toBe('Write-Output "hand-written"');

    // The monitor created from the rule that named the proposal now names the created script.
    const policyId = ledger.find((r) => r.itemRef === 'policy:file_server')!.createdRefs!.policyId as string;
    const ruleMonitor = (await readPolicyMonitors(policyId)).find((row) => row.definition.name === 'Spooler stuck');
    expect(ruleMonitor?.definition.description).toContain(`[script created: ${scriptId}]`);

    // Re-apply: no second script.
    const again = await withDbAccessContext(f.dbCtxA, () => applyFleetDesign(f.authA, runId, approval));
    expect(again.applied).toEqual([]);
    expect(again.skipped).toContain('automation:file_server:script:0');
    const named = await getTestDb().select({ id: scripts.id }).from(scripts).where(and(eq(scripts.orgId, f.envA.orgId), eq(scripts.category, 'Fleet Design')));
    expect(named).toHaveLength(1);

    // Rollback: script stays, fleet-design tag gone, policy rollback not refused
    // (step 4 refreshed its linksSnapshot after appending the script id).
    const rollback = await withDbAccessContext(f.dbCtxA, () => rollbackFleetDesign(f.authA, runId, undefined, { canWriteScripts: true }));
    expect(rollback.refused).toEqual([]);
    expect(rollback.rolledBack).toEqual(expect.arrayContaining(['automation:file_server:script:0', 'policy:file_server']));
    const [afterRollback] = await getTestDb().select().from(scripts).where(eq(scripts.id, scriptId));
    expect(afterRollback).toBeDefined();
    expect(afterRollback!.deletedAt).toBeNull();
    expect(await scriptTagNames(scriptId)).toEqual([]);
  });

  runDb('13. rollback without scripts:write refuses only the script row; everything else rolls back', async () => {
    const f = await seedFixture();
    const submission: FleetDesignSubmission = {
      ...buildSubmission({ functionKey: 'file_server', deviceIds: f.deviceIds, roleCorrectionDeviceId: f.deviceIds[1], retiredPolicyId: f.baselinePolicyId, rule: GOOD_RULE }),
      automation: [{ functionKey: 'file_server', playbooks: [], scripts: [{ name: 'Clear temp', purpose: 'Free disk', osTypes: ['windows'], language: 'powershell', content: 'Remove-Item $env:TEMP -Recurse -WhatIf' }] }],
    };
    const outcome = fleetDesignOutcomeFromSubmission(submission, {
      deviceIds: new Set(f.deviceIds), baseline: { alertsPer100EndpointsPerMonth: null, ticketsPerMonth: null, precursors: [] }, generatedAt: new Date().toISOString(),
    });
    const runId = await seedReportRun(f.envA.orgId, outcome);
    const approval: FleetDesignApproval = {
      functions: ['file_server'], monitoring: [], retired: [], automation: ['automation:file_server:script:0'], legacy: [],
      roleCorrections: [], displacementsAccepted: [],
    };
    const result = await withDbAccessContext(f.dbCtxA, () => applyFleetDesign(f.authA, runId, approval));
    expect(result.partial).toBeNull();
    const scriptId = (await readLedger(runId)).find((r) => r.itemKind === 'script')!.createdRefs!.scriptId as string;

    const rollback = await withDbAccessContext(f.dbCtxA, () => rollbackFleetDesign(f.authA, runId));
    expect(rollback.refused).toEqual([{ itemRef: 'automation:file_server:script:0', reason: 'scripts_write_required' }]);
    expect(rollback.rolledBack).toContain('functions:file_server');
    expect(await scriptTagNames(scriptId)).toEqual(['fleet-design']);
  });

  runDb('14. a failure after script import rolls back every step-4 write and preserves completed steps', async () => {
    const f = await seedFixture();
    const submission: FleetDesignSubmission = {
      ...buildSubmission({ functionKey: 'file_server', deviceIds: f.deviceIds, roleCorrectionDeviceId: f.deviceIds[1], retiredPolicyId: f.baselinePolicyId, rule: GOOD_RULE }),
      automation: [{ functionKey: 'file_server', playbooks: [], scripts: [{ name: 'Rollback probe', purpose: 'Exercise the apply savepoint', osTypes: ['windows'], language: 'powershell', content: 'Write-Output "savepoint probe"' }] }],
    };
    const outcome = fleetDesignOutcomeFromSubmission(submission, {
      deviceIds: new Set(f.deviceIds), baseline: { alertsPer100EndpointsPerMonth: null, ticketsPerMonth: null, precursors: [] }, generatedAt: new Date().toISOString(),
    });
    const runId = await seedReportRun(f.envA.orgId, outcome);
    const approval: FleetDesignApproval = {
      ...fullApproval(f.deviceIds, [f.baselinePolicyId]),
      automation: ['automation:file_server:script:0'],
    };
    const importBundle = scriptBundle.importBundle;
    let importedScriptId: string | undefined;
    // Invalid entries are rejected by preview. Fail only AFTER the real
    // importer has written the script, v1 version, tag, and tag association.
    const importer = vi.spyOn(scriptBundle, 'importBundle').mockImplementation(async (...args) => {
      const imported = await importBundle(...args);
      if ('error' in imported) throw new Error(imported.error);
      expect(imported.errors).toEqual([]);
      importedScriptId = imported.scripts[0]?.scriptId;
      expect(importedScriptId).toBeDefined();
      throw new Error('injected failure after script import');
    });
    try {
      const result = await withDbAccessContext(f.dbCtxA, () => applyFleetDesign(f.authA, runId, approval));
      expect(result.partial).toEqual({ failedStep: 4, reason: 'injected failure after script import' });
      expect(result.applied.sort()).toEqual([
        'functions:file_server', 'policy:file_server', 'monitoring:file_server:watch:0', 'monitoring:file_server:rule:0',
      ].sort());
      expect(result.rollbackAvailable).toBe(true);
    } finally {
      importer.mockRestore();
    }

    // Check the real ids, including child tables, after the outer request
    // commits. No statement issued by the failed step may escape its savepoint.
    expect(importedScriptId).toBeDefined();
    expect(await getTestDb().select().from(scripts).where(eq(scripts.id, importedScriptId!))).toEqual([]);
    expect(await getTestDb().select().from(scriptVersions).where(eq(scriptVersions.scriptId, importedScriptId!))).toEqual([]);
    expect(await getTestDb().select().from(scriptToTags).where(eq(scriptToTags.scriptId, importedScriptId!))).toEqual([]);
    expect(await getTestDb().select().from(scriptTags).where(and(eq(scriptTags.orgId, f.envA.orgId), eq(scriptTags.name, 'fleet-design')))).toEqual([]);

    const ledger = await readLedger(runId);
    expect(ledger.find((r) => r.itemRef === 'step:4')).toMatchObject({ status: 'failed', itemKind: 'script', error: 'injected failure after script import' });
    expect(ledger.some((r) => r.itemKind === 'script' && r.status === 'applied')).toBe(false);
    const group = await readGroupByName(f.envA.orgId, 'Fleet Design: File server');
    expect(group).toBeDefined();
    expect((await readGroupMembers(group!.id)).sort()).toEqual([...f.deviceIds].sort());
    expect(await readActiveAssessment(f.deviceIds[0])).toMatchObject({ reportRunId: runId, functionKey: 'file_server' });
    const policyId = ledger.find((r) => r.itemRef === 'policy:file_server')!.createdRefs!.policyId as string;
    expect(await readPolicy(policyId)).toMatchObject({ status: 'active' });
    const retiredLink = await readMonitoringLink(f.baselinePolicyId);
    expect((retiredLink?.inlineSettings as { watches: Array<{ name: string; enabled: boolean }> }).watches)
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Spooler', enabled: true })]));
    // Step 5 was never entered after the failure.
    expect(await readDevice(f.deviceIds[1])).toMatchObject({ deviceRole: 'unknown', deviceRoleSource: 'auto' });
  });

  // -------------------------------------------------------------------------
  // W05c2 (#6371): monitor attachments are atomic with the step savepoint
  // -------------------------------------------------------------------------
  runDb('15. Fleet monitor creation rolls back with its step: no orphan definition, no link', async () => {
    const f = await seedFixture();
    const policy = await withDbAccessContext(f.dbCtxA, () => createConfigPolicy(
      { orgId: f.envA.orgId }, { name: 'Atomic monitor apply', status: 'inactive' }, f.envA.userId));
    const name = `Atomic ${randomUUID()}`;
    await expect(withDbAccessContext(f.dbCtxA, () => db.transaction(async (tx) => {
      await attachFleetMonitors(policy.id, [{ itemRef: 'x', definition: {
        name, kind: 'cpu', condition: { operator: 'gt', value: 80 }, severity: 'high',
      } }], f.authA, tx);
      throw new Error('force_step_failure');
    }))).rejects.toThrow('force_step_failure');
    expect(await getTestDb().select().from(monitorDefinitions).where(eq(monitorDefinitions.name, name))).toEqual([]);
    expect(await withDbAccessContext(f.dbCtxA, () => listFeatureLinks(policy.id))).toEqual([]);
  });

  runDb('16. rollback preserves a monitor edited after Fleet apply', async () => {
    const f = await seedFixture();
    const runId = await seedReportRun(f.envA.orgId, buildOutcome({
      functionKey: 'file_server', deviceIds: f.deviceIds, roleCorrectionDeviceId: f.deviceIds[1], retiredPolicyId: f.baselinePolicyId, rule: GOOD_RULE,
    }));
    await withDbAccessContext(f.dbCtxA, () => applyFleetDesign(f.authA, runId, fullApproval(f.deviceIds, [f.baselinePolicyId])));
    const ledger = await readLedger(runId);
    const created = ledger.find((row) => row.itemRef === 'policy:file_server')!.createdRefs!;
    const monitorId = (created.monitorIdsByItemRef as Record<string, string>)['monitoring:file_server:rule:0']!;
    await withDbAccessContext(f.dbCtxA, () => updateMonitorDefinition(monitorId, {
      condition: { operator: 'gt', value: 92, durationMinutes: 15 },
    }, f.authA));

    const result = await withDbAccessContext(f.dbCtxA, () => rollbackFleetDesign(f.authA, runId));

    expect(result.refused).toContainEqual({ itemRef: 'policy:file_server', reason: 'modified_since_apply' });
    const [row] = await getTestDb().select().from(monitorDefinitions).where(eq(monitorDefinitions.id, monitorId));
    expect(row!.condition).toMatchObject({ value: 92 });
  });

  runDb('17. rollback of an unedited monitor apply archives the policy and keeps the definitions', async () => {
    const f = await seedFixture();
    const runId = await seedReportRun(f.envA.orgId, buildOutcome({
      functionKey: 'file_server', deviceIds: f.deviceIds, roleCorrectionDeviceId: f.deviceIds[1], retiredPolicyId: f.baselinePolicyId, rule: GOOD_RULE,
    }));
    await withDbAccessContext(f.dbCtxA, () => applyFleetDesign(f.authA, runId, fullApproval(f.deviceIds, [f.baselinePolicyId])));
    const created = (await readLedger(runId)).find((row) => row.itemRef === 'policy:file_server')!.createdRefs!;
    const ids = Object.values(created.monitorIdsByItemRef as Record<string, string>);

    const result = await withDbAccessContext(f.dbCtxA, () => rollbackFleetDesign(f.authA, runId));

    expect(result.refused).toEqual([]);
    expect((await readPolicy(created.policyId as string))?.status).toBe('archived');
    for (const id of ids) {
      expect(await getTestDb().select({ id: monitorDefinitions.id }).from(monitorDefinitions).where(eq(monitorDefinitions.id, id))).toHaveLength(1);
    }
  });
});
