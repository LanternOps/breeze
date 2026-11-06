/**
 * #11225 round 3, service rows. Each case forces a real statement failure where
 * a catch inside a service means to survive it, runs the service's exported
 * entry point on real Postgres in a held context, and asserts both halves: the
 * catch's promised answer, and that the work the same transaction did beside it
 * committed. Unfixed, the held transaction rethrows the swallowed failure at
 * commit (or fails the next statement with 25P02).
 *
 * `select` failures that cannot be made by hiding a table (organizations is read
 * by RLS functions) come from caughtQuerySelectFault.ts.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queueStub = vi.hoisted(() => ({ noRow: false }));

// The queue answers "no row" when armed; everything else in commandQueue stays real.
vi.mock('../../services/commandQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/commandQueue')>();
  return { ...actual, queueCommand: (...args: Parameters<typeof actual.queueCommand>) => (queueStub.noRow ? Promise.resolve(undefined) : actual.queueCommand(...args)) };
});

// Two gates that are not the row under test: snapshot attestation and the cross-site restore permission.
vi.mock('../../services/backupRestoreActorGate', () => ({ restoreIntegrityRefusalForActor: async () => null }));
vi.mock('../../services/aiToolsRestoreAuthorization', () => ({ authorizeAiRestore: async () => ({ ok: true }) }));

vi.mock('../../jobs/s1Sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../jobs/s1Sync')>();
  // The provider call is the only stub: a dispatch with no activity id, so nothing is scheduled.
  const dispatched = async () => ({ providerActionId: null, raw: {} });
  return { ...actual, dispatchS1Isolation: dispatched, dispatchS1ThreatAction: dispatched };
});

vi.mock('../../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db')>();
  const { faultingDb } = await import('./caughtQuerySelectFault');
  return { ...actual, db: faultingDb(actual.db) };
});

import { withDbAccessContext } from '../../db';
import {
  automationRunDeviceResults, automationRuns, automations,
  backupConfigs, backupJobs, backupSnapshots, clientAiUsage, deploymentResults, devices, reportRuns, reports,
  restoreJobs, scriptExecutions, scripts, s1Actions, s1Agents, s1Integrations, s1Threats, softwareCatalog, softwareDeployments, softwareVersions, deviceChangeLog, deviceCommands,
  monitorDefinitions, monitorEpisodes, portalUsers, serviceProcessCheckResults, timeEntries,
} from '../../db/schema';
import type { AiTool } from '../../services/aiTools';
import { registerBackupTools } from '../../services/aiToolsBackup';
import { registerMonitoringTools } from '../../services/aiToolsMonitoring';
import {
  applyAutomationActionTerminal, recordAutomationActionDispatch, seedAutomationActionResults,
} from '../../services/automationActionResults';
import { applyBackupCommandResultToJob } from '../../services/backupResultPersistence';
import { generatePortalReport } from '../../services/portal/reportsSelfService';
import { executeS1IsolationForOrg, executeS1ThreatActionForOrg } from '../../services/sentinelOne/actions';
import { dispatchScriptToDevice } from '../../services/scriptDispatch';
import { buildAndDispatchSoftwareInstalls } from '../../services/softwareDeployment';
import { persistedSiteScopeValues, siteScopeFingerprint, type UserReportExecutionAuthority } from '../../services/siteScope';
import type { AuthContext } from '../../middleware/auth';
import { resolveAuditOrgIdForPartner } from '../../services/auditOrgResolver';
import { getUsageSummary } from '../../services/aiCostTracker';
import { resolveAiOriginSummary } from '../../services/aiOriginSummary';
import { recordClientUsage } from '../../services/clientAiUsage';
import { commandCasPriorStatusTags, PRIOR_STATUS_LOOKUP_FAILED } from '../../services/commandCasDiagnostics';
import { getPromotedAgentVersionForDisplay } from '../../services/promotedAgentVersion';
import { previousBaselineFor } from '../../services/reportGenerationService';
import { createTimeEntry, type TimeEntryActor } from '../../services/timeEntryService';
import { clearStatementFaults, failStatementsOn, failWritesOn } from './caughtQueryFaults';
import { inHeldContext, inHeldSystemContext, tenant, toolAuth, type Tenant } from './caughtQueryFixtures';
import { resetSelectFault, selectFault } from './caughtQuerySelectFault';
import { createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

/** Silence console.error and let a case prove its catch ran (the fault fired and was swallowed). */
const errorLog = () => vi.spyOn(console, 'error').mockImplementation(() => {});
const expectLogged = (spy: ReturnType<typeof errorLog>, text: string) =>
  expect(spy.mock.calls.some((call) => typeof call[0] === 'string' && call[0].includes(text))).toBe(true);

beforeEach(() => {
  resetSelectFault();
  queueStub.noRow = false;
});
afterEach(async () => {
  vi.restoreAllMocks();
  resetSelectFault();
  queueStub.noRow = false;
  await clearStatementFaults();
});

describe('read-only catches degrade inside a held context', () => {
  runDb('aiCostTracker.getUsageSummary: a failed partner-credits read answers null credits', async () => {
    const t = await tenant();
    selectFault.key = 'partnerId';
    selectFault.caller = 'readPartnerCreditsForUsage';
    const logged = errorLog();
    const summary = await inHeldContext(t, () => getUsageSummary(t.orgId, { includeCredits: true }));
    expect(selectFault.hits).toBe(1);
    expectLogged(logged, '[aiCostTracker] partner credits read failed');
    expect(summary.credits).toBeNull();
    expect(summary.billedTo).toBe('platform');
  });

  runDb('aiOriginSummary.resolveAiOriginSummary: a failed audit lookup answers toolName null', async () => {
    const t = await tenant();
    const [command] = await getTestDb().insert(deviceCommands).values({
      deviceId: t.deviceId, type: 'script', status: 'completed', aiInitiatorKind: 'flow',
    }).returning({ id: deviceCommands.id });
    await getTestDb().execute(sql`INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, resource_id, details, result)
      VALUES (${t.orgId}::uuid, 'system', ${randomUUID()}::uuid, 'ai.command.executed', 'device', ${t.deviceId}::uuid,
        ${JSON.stringify({ commandId: command!.id, toolName: 'run_script' })}::jsonb, 'success')`);
    const source = { kind: 'command' as const, id: command!.id, deviceId: t.deviceId };
    const auth = {} as AuthContext;

    const control = await inHeldContext(t, () => resolveAiOriginSummary(auth, source));
    expect(control).toMatchObject({ kind: 'flow', toolName: 'run_script' });

    await failStatementsOn('audit_logs');
    const logged = errorLog();
    const degraded = await inHeldContext(t, () => resolveAiOriginSummary(auth, source));
    expectLogged(logged, 'audit toolName lookup failed');
    expect(degraded).toMatchObject({ kind: 'flow', toolName: null });
  });

  runDb('auditOrgResolver.resolveAuditOrgIdForPartner: a failed lookup answers null', async () => {
    const t = await tenant();
    expect(await inHeldContext(t, () => resolveAuditOrgIdForPartner(t.partnerId))).toBe(t.orgId);

    selectFault.key = 'id';
    selectFault.caller = 'auditOrgResolver';
    const logged = errorLog();
    expect(await inHeldContext(t, () => resolveAuditOrgIdForPartner(t.partnerId))).toBeNull();
    expect(selectFault.hits).toBe(1);
    expectLogged(logged, 'Failed to resolve orgId for partner');
  });

  runDb('commandCasDiagnostics.commandCasPriorStatusTags: a failed lookup answers the lookup-failed tag', async () => {
    const t = await tenant();
    const [command] = await getTestDb().insert(deviceCommands).values({
      deviceId: t.deviceId, type: 'script', status: 'completed',
    }).returning({ id: deviceCommands.id });
    await failStatementsOn('device_commands');
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tags = await inHeldContext(t, () => commandCasPriorStatusTags(command!.id));
    expect(tags).toEqual({ prior_status: PRIOR_STATUS_LOOKUP_FAILED });
    expect(warned.mock.calls.some((call) => String(call[0]).includes('[commandCas] prior-status lookup failed'))).toBe(true);
  });

  runDb('promotedAgentVersion.getPromotedAgentVersionForDisplay: a failed lookup answers null', async () => {
    const t = await tenant();
    await failStatementsOn('agent_versions');
    const logged = errorLog();
    expect(await inHeldContext(t, () => getPromotedAgentVersionForDisplay())).toBeNull();
    expectLogged(logged, 'display-only promoted-version lookup failed');
  });

  runDb('reportGenerationService.previousBaselineFor: a failed lookup answers undefined', async () => {
    const t = await tenant();
    await failStatementsOn('report_runs');
    const logged = errorLog();
    expect(await inHeldContext(t, () => previousBaselineFor(randomUUID(), 'fingerprint'))).toBeUndefined();
    expectLogged(logged, 'previous-baseline lookup failed');
  });
});

describe('best-effort writes keep the caller commit', () => {
  runDb('clientAiUsage.recordClientUsage: the daily bucket fails, the monthly bucket is written', async () => {
    const t = await tenant();
    const [portalUser] = await getTestDb().insert(portalUsers)
      .values({ orgId: t.orgId, email: `rows-${randomUUID()}@example.test`, authMethod: 'password' })
      .returning({ id: portalUsers.id });
    await failWritesOn('client_ai_usage', { ops: 'INSERT', when: "NEW.period = 'daily'" });
    const logged = errorLog();
    await inHeldContext(t, () => recordClientUsage(t.orgId, portalUser!.id, { inputTokens: 10, messageCount: 1 }));
    expectLogged(logged, 'Failed to update daily usage bucket');
    const rows = await getTestDb().select({ period: clientAiUsage.period, messageCount: clientAiUsage.messageCount })
      .from(clientAiUsage).where(eq(clientAiUsage.orgId, t.orgId));
    expect(rows).toEqual([{ period: 'monthly', messageCount: 1 }]);
  });

  runDb('timeEntryService.createTimeEntry: a failed feed comment leaves the time entry committed', async () => {
    const t = await tenant();
    const user = await createUser({ partnerId: t.partnerId, email: `rows-${randomUUID()}@example.test` });
    const ticketId = randomUUID();
    await getTestDb().execute(sql`INSERT INTO tickets (id, partner_id, org_id, ticket_number, subject, source)
      VALUES (${ticketId}::uuid, ${t.partnerId}::uuid, ${t.orgId}::uuid, ${`ROWS-${ticketId}`}, 'Feed comment', 'manual')`);
    const actor: TimeEntryActor = {
      userId: user.id, partnerId: t.partnerId, manageAll: false, manageBilling: false, accessibleOrgIds: [t.orgId],
    };
    await failWritesOn('ticket_comments');
    const logged = errorLog();
    const startedAt = new Date(Date.now() - 3_600_000);
    const entry = await withDbAccessContext({
      scope: 'partner', orgId: null, accessibleOrgIds: [t.orgId],
      accessiblePartnerIds: [t.partnerId], currentPartnerId: t.partnerId, userId: user.id,
    }, () => createTimeEntry({ ticketId, startedAt, endedAt: new Date(), description: 'work' } as never, actor));
    expectLogged(logged, 'feed comment insert failed');
    const [row] = await getTestDb().select({ id: timeEntries.id, ticketId: timeEntries.ticketId })
      .from(timeEntries).where(eq(timeEntries.id, entry.id));
    expect(row).toEqual({ id: entry.id, ticketId });
  });
});

describe('aiToolsMonitoring known_services: either name source may be missing (42P01 only)', () => {
  async function seedSources(t: Tenant) {
    await getTestDb().insert(deviceChangeLog).values({
      deviceId: t.deviceId, orgId: t.orgId, fingerprint: randomUUID().replace(/-/g, ''), timestamp: new Date(),
      changeType: 'service', changeAction: 'added', subject: 'ChangeLogSvc',
    });
    await getTestDb().insert(serviceProcessCheckResults).values({
      orgId: t.orgId, deviceId: t.deviceId, watchType: 'service', name: 'CheckResultSvc', status: 'running',
    });
  }
  async function knownServices(t: Tenant): Promise<string[]> {
    const reg = new Map<string, AiTool>();
    registerMonitoringTools(reg);
    const auth = await toolAuth(t);
    const raw = await inHeldContext(t, () => reg.get('get_service_monitoring_status')!.handler({ action: 'known_services' }, auth));
    return (JSON.parse(raw as string) as { data: Array<{ name: string }> }).data.map((r) => r.name).sort();
  }

  runDb('a missing device_change_log answers from the check results', async () => {
    const t = await tenant();
    await seedSources(t);
    expect(await knownServices(t)).toEqual(['ChangeLogSvc', 'CheckResultSvc']);
    await failStatementsOn('device_change_log');
    expect(await knownServices(t)).toEqual(['CheckResultSvc']);
  });

  runDb('a missing service_process_check_results answers from the change log', async () => {
    const t = await tenant();
    await seedSources(t);
    await failStatementsOn('service_process_check_results');
    expect(await knownServices(t)).toEqual(['ChangeLogSvc']);
  });
});

describe('automationActionResults: monitor episode bookkeeping never aborts reconciliation', () => {
  /** A one-device run with one dispatched action; applying its terminal reconciles the run to completed. */
  async function runFixture(t: Tenant, monitorId: string | null = null) {
    const [automation] = await getTestDb().insert(automations).values({
      orgId: t.orgId, name: `rows-${randomUUID()}`, trigger: { type: 'manual' }, actions: [], managedByMonitorId: monitorId,
    }).returning({ id: automations.id });
    const [run] = await getTestDb().insert(automationRuns).values({
      automationId: automation!.id, triggeredBy: 'rows', devicesTargeted: 1,
    }).returning({ id: automationRuns.id });
    await getTestDb().insert(automationRunDeviceResults).values({
      runId: run!.id, deviceId: t.deviceId, orgId: t.orgId, status: 'pending',
    });
    await seedAutomationActionResults({
      runId: run!.id, device: { id: t.deviceId, orgId: t.orgId }, actions: [{ actionIndex: 0, actionType: 'async' }],
    });
    const scriptExecutionId = randomUUID();
    await recordAutomationActionDispatch({ runId: run!.id, deviceId: t.deviceId, actionIndex: 0, status: 'running', scriptExecutionId, commandId: randomUUID() });
    return { runId: run!.id, scriptExecutionId };
  }
  const finish = (t: Tenant, scriptExecutionId: string) => inHeldSystemContext(t, () =>
    applyAutomationActionTerminal({ source: 'script_execution', scriptExecutionId, terminalStatus: 'succeeded', completedAt: new Date() }));
  const runStatus = async (runId: string) =>
    (await getTestDb().select({ status: automationRuns.status }).from(automationRuns).where(eq(automationRuns.id, runId)))[0]?.status;

  async function episodeFixture(t: Tenant) {
    const [monitor] = await getTestDb().insert(monitorDefinitions).values({
      orgId: t.orgId, name: `rows-${randomUUID()}`, kind: 'cpu', severity: 'high', condition: {},
    }).returning({ id: monitorDefinitions.id });
    await getTestDb().insert(monitorEpisodes).values({ monitorId: monitor!.id, deviceId: t.deviceId, orgId: t.orgId });
    return monitor!.id;
  }
  const episodeOutcome = async (monitorId: string) =>
    (await getTestDb().select({ outcome: monitorEpisodes.responseOutcome }).from(monitorEpisodes).where(eq(monitorEpisodes.monitorId, monitorId)))[0]?.outcome;

  runDb('CONTROL: with nothing failing the run completes and the episode records the outcome', async () => {
    const t = await tenant();
    const monitorId = await episodeFixture(t);
    const f = await runFixture(t, monitorId);
    expect(await finish(t, f.scriptExecutionId)).toBe(true);
    expect(await runStatus(f.runId)).toBe('completed');
    expect(await episodeOutcome(monitorId)).toBe('completed');
  });

  runDb('a failed automations read for the monitor leaves the run completed', async () => {
    const t = await tenant();
    const f = await runFixture(t);
    selectFault.key = 'monitorId';
    selectFault.caller = 'recordMonitorEpisodeOutcomes';
    const logged = errorLog();
    expect(await finish(t, f.scriptExecutionId)).toBe(true);
    expect(selectFault.hits).toBe(1);
    expectLogged(logged, 'Failed to resolve the monitor');
    expect(await runStatus(f.runId)).toBe('completed');
  });

  runDb('a failed episode write leaves the run completed and the episode unchanged', async () => {
    const t = await tenant();
    const monitorId = await episodeFixture(t);
    const f = await runFixture(t, monitorId);
    await failWritesOn('monitor_episodes', { ops: 'UPDATE' });
    const logged = errorLog();
    expect(await finish(t, f.scriptExecutionId)).toBe(true);
    expectLogged(logged, 'Failed to record monitor episode outcome');
    expect(await runStatus(f.runId)).toBe('completed');
    expect(await episodeOutcome(monitorId)).toBeNull();
  });
});

describe('backupResultPersistence: each post-result step is its own savepoint', () => {
  async function jobFixture(t: Tenant) {
    const [config] = await getTestDb().insert(backupConfigs)
      .values({ orgId: t.orgId, name: `rows-${randomUUID()}`, type: 'file', provider: 'local', providerConfig: {} })
      .returning({ id: backupConfigs.id });
    const [job] = await getTestDb().insert(backupJobs).values({
      orgId: t.orgId, configId: config!.id, deviceId: t.deviceId, status: 'running', startedAt: new Date(), lastProgressAt: new Date(),
    }).returning({ id: backupJobs.id });
    return job!.id;
  }
  const apply = (t: Tenant, jobId: string, metadata?: Record<string, unknown>) => inHeldSystemContext(t, () =>
    applyBackupCommandResultToJob({
      jobId, orgId: t.orgId, deviceId: t.deviceId, resultStatus: 'completed',
      result: { snapshotId: `snap-${jobId}`, filesBackedUp: 3, bytesBackedUp: 30, ...(metadata ? { metadata } : {}) },
    }));
  const state = async (jobId: string) => {
    const [job] = await getTestDb().select({ status: backupJobs.status }).from(backupJobs).where(eq(backupJobs.id, jobId));
    const [snap] = await getTestDb().select({ gfsTags: backupSnapshots.gfsTags }).from(backupSnapshots).where(eq(backupSnapshots.jobId, jobId));
    return { status: job!.status, snapshot: snap };
  };

  runDb('CONTROL: with nothing failing the GFS tags are written', async () => {
    const t = await tenant();
    const jobId = await jobFixture(t);
    expect((await apply(t, jobId)).applied).toBe(true);
    const out = await state(jobId);
    expect(out.status).toBe('completed');
    expect(out.snapshot?.gfsTags).toBeTruthy();
  });

  runDb('a failed MSSQL chain read still applies the result', async () => {
    const t = await tenant();
    const jobId = await jobFixture(t);
    await failStatementsOn('backup_chains');
    const logged = errorLog();
    const out = await apply(t, jobId, { backupKind: 'mssql_database', instance: 'MSSQLSERVER', database: 'rows_db' });
    expect(out.applied).toBe(true);
    expectLogged(logged, 'Failed to reconcile MSSQL chain');
    expect((await state(jobId)).status).toBe('completed');
  });

  runDb('a failed GFS tag write still applies the result', async () => {
    const t = await tenant();
    const jobId = await jobFixture(t);
    await failWritesOn('backup_snapshots', { ops: 'UPDATE', when: 'NEW.gfs_tags IS DISTINCT FROM OLD.gfs_tags' });
    const logged = errorLog();
    expect((await apply(t, jobId)).applied).toBe(true);
    expectLogged(logged, 'Failed to apply GFS tags');
    const out = await state(jobId);
    expect(out.status).toBe('completed');
    expect(out.snapshot).toBeDefined();
  });
});

describe('portalReports generatePortalReport: a failed generation stamps the run failed', () => {
  runDb('a failing completion write is caught, and the run row is committed as failed', async () => {
    const t = await tenant();
    const [portalUser] = await getTestDb().insert(portalUsers)
      .values({ orgId: t.orgId, email: `rows-${randomUUID()}@example.test`, authMethod: 'password' })
      .returning({ id: portalUsers.id });
    const scope = { version: 1, kind: 'unrestricted', orgId: t.orgId } as const;
    const authority: UserReportExecutionAuthority = {
      principalKind: 'user', principalUserId: randomUUID(), scope, capturedAt: new Date(), fingerprint: siteScopeFingerprint(scope),
    };
    await getTestDb().insert(reports).values({
      orgId: t.orgId, name: 'Portal executive summary', type: 'executive_summary', schedule: 'one_time', format: 'pdf',
      config: { dateRange: { preset: 'last_30_days' } }, portalSelfService: true, ...persistedSiteScopeValues(authority),
    });
    await failWritesOn('report_runs', { ops: 'UPDATE', when: "NEW.status = 'completed'" });
    const logged = errorLog();
    const run = await inHeldContext(t, () => generatePortalReport({ orgId: t.orgId, portalUserId: portalUser!.id, type: 'executive_summary' }));
    expectLogged(logged, '[portal-reports] Report generation failed');
    expect(run.status).toBe('failed');
    const [stored] = await getTestDb().select({ status: reportRuns.status, errorMessage: reportRuns.errorMessage })
      .from(reportRuns).where(eq(reportRuns.orgId, t.orgId));
    expect(stored?.status).toBe('failed');
    // Stored on the run: the failure class, never the failed query or its bound values.
    expect(stored?.errorMessage).toBeTruthy();
    expect(stored?.errorMessage).not.toContain('Failed query');
    expect(stored?.errorMessage).not.toContain(run.id);
  });
});

describe('sentinelOne actions: a failed s1_actions insert after dispatch answers ok with a warning', () => {
  async function s1Fixture(t: Tenant) {
    const user = await createUser({ partnerId: t.partnerId, orgId: t.orgId });
    const [integration] = await getTestDb().insert(s1Integrations).values({
      partnerId: t.partnerId, name: 'rows', apiTokenEncrypted: 'enc', managementUrl: 'https://s1.example.invalid',
    }).returning({ id: s1Integrations.id });
    await getTestDb().insert(s1Agents).values({ orgId: t.orgId, integrationId: integration!.id, s1AgentId: 'agent-1', deviceId: t.deviceId });
    await getTestDb().insert(s1Threats).values({
      orgId: t.orgId, integrationId: integration!.id, deviceId: t.deviceId, s1ThreatId: 'threat-1', status: 'active',
    });
    return { integrationId: integration!.id, requestedBy: user.id };
  }
  const recorded = async (t: Tenant) => getTestDb().select().from(s1Actions).where(eq(s1Actions.orgId, t.orgId));

  runDb('executeS1IsolationForOrg', async () => {
    const t = await tenant();
    const f = await s1Fixture(t);
    await failWritesOn('s1_actions');
    const logged = errorLog();
    const out = await inHeldContext(t, () => executeS1IsolationForOrg({ orgId: t.orgId, ...f, deviceIds: [t.deviceId], isolate: true }));
    expectLogged(logged, 'Failed to persist action records');
    expect(out).toMatchObject({ ok: true, data: { actions: [], mappedAgents: 1 } });
    expect((out as { data: { warning?: string } }).data.warning).toContain('Failed to persist action records');
    expect(await recorded(t)).toHaveLength(0);
  });

  runDb('executeS1ThreatActionForOrg', async () => {
    const t = await tenant();
    const f = await s1Fixture(t);
    await failWritesOn('s1_actions');
    const logged = errorLog();
    const out = await inHeldContext(t, () => executeS1ThreatActionForOrg({ orgId: t.orgId, ...f, action: 'quarantine', threatIds: ['threat-1'] }));
    expectLogged(logged, 'Failed to persist action records');
    expect(out).toMatchObject({ ok: true, data: { actions: [] } });
    expect((out as { data: { warning?: string } }).data.warning).toContain('Failed to persist action records');
    expect(await recorded(t)).toHaveLength(0);
  });
});

describe('softwareDeployment failDevice: one failed gate write does not stop the fan-out', () => {
  runDb('both devices are reported failed although their deployment_results writes raise', async () => {
    const t = await tenant();
    const [second] = await getTestDb().insert(devices).values({
      orgId: t.orgId, siteId: t.siteId, agentId: `rows-${randomUUID()}`, hostname: `rows-${randomUUID()}`, osType: 'windows',
      osVersion: 'test', architecture: 'amd64', agentVersion: '1.0.0-test', status: 'online',
    }).returning({ id: devices.id });
    const [catalog] = await getTestDb().insert(softwareCatalog).values({ orgId: t.orgId, name: `rows-${randomUUID()}` }).returning({ id: softwareCatalog.id });
    const [version] = await getTestDb().insert(softwareVersions).values({
      catalogId: catalog!.id, version: '1.0.0', downloadUrl: 'https://example.invalid/test.msi',
    }).returning({ id: softwareVersions.id });
    await getTestDb().update(devices).set({ osType: 'windows' }).where(eq(devices.id, t.deviceId));
    const deviceIds = [t.deviceId, second!.id];
    const [deployment] = await getTestDb().insert(softwareDeployments).values({
      orgId: t.orgId, name: 'rows', softwareVersionId: version!.id, deploymentType: 'install', targetType: 'devices',
      targetIds: deviceIds, scheduleType: 'immediate',
    }).returning({ id: softwareDeployments.id });
    const resultRows = await getTestDb().insert(deploymentResults)
      .values(deviceIds.map((deviceId) => ({ deploymentId: deployment!.id, deviceId })))
      .returning({ id: deploymentResults.id, deviceId: deploymentResults.deviceId });
    await failWritesOn('deployment_results', { ops: 'UPDATE' });
    const logged = errorLog();
    const out = await inHeldContext(t, () => buildAndDispatchSoftwareInstalls({
      deploymentId: deployment!.id,
      orgId: t.orgId,
      // A script-enabled version for linux only: a windows device fails the gate before anything is queued.
      versionRecord: {
        downloadUrl: 'https://example.invalid/test.msi', s3Key: null, checksum: null, originalFileName: null, fileType: 'msi',
        silentInstallArgs: null, version: '1.0.0', installScriptsEnabled: true, preInstallScript: 'true', supportedOs: ['linux'],
      },
      catalogItem: { name: 'rows', integrationProvider: null },
      deviceIds,
      createdBy: null,
      markDispatched: false,
      deploymentResultIdsByDevice: new Map(resultRows.map((r) => [r.deviceId, r.id])),
    }));
    expectLogged(logged, 'could not record a gate failure');
    expect(out.dispatchedDeviceIds).toEqual([]);
    expect(out.deviceResults.map((r) => [r.deviceId, r.status]).sort()).toEqual(deviceIds.map((id) => [id, 'failed']).sort());
  });
});

describe('aiToolsBackup restore_snapshot: a failed command link marks the job failed and queues nothing', () => {
  runDb('error JSON, job committed as failed, no device_commands row, proof write committed', async () => {
    const t = await tenant();
    const auth = await toolAuth(t, { kind: 'ai_assistant', sessionId: randomUUID() });
    const [config] = await getTestDb().insert(backupConfigs)
      .values({ orgId: t.orgId, name: `rows-${randomUUID()}`, type: 'file', provider: 'local', providerConfig: { path: '/backups' } })
      .returning({ id: backupConfigs.id });
    const [job] = await getTestDb().insert(backupJobs).values({
      orgId: t.orgId, configId: config!.id, deviceId: t.deviceId, type: 'scheduled', status: 'completed', completedAt: new Date(),
    }).returning({ id: backupJobs.id });
    const [snapshot] = await getTestDb().insert(backupSnapshots).values({
      orgId: t.orgId, jobId: job!.id, deviceId: t.deviceId, configId: config!.id, snapshotId: `snap-${randomUUID()}`,
    }).returning({ id: backupSnapshots.id });
    const reg = new Map<string, AiTool>();
    registerBackupTools(reg);

    // CONTROL: unfaulted, the dispatch links the command to the job.
    const ok = JSON.parse(await inHeldContext(t, () => reg.get('restore_snapshot')!.handler({ snapshotId: snapshot!.id, deviceId: t.deviceId }, auth)) as string);
    expect(ok).toMatchObject({ success: true });
    await getTestDb().delete(restoreJobs).where(eq(restoreJobs.orgId, t.orgId));
    await getTestDb().delete(deviceCommands).where(eq(deviceCommands.deviceId, t.deviceId));

    await failWritesOn('restore_jobs', { ops: 'UPDATE', when: 'NEW.command_id IS NOT NULL' });
    const out = JSON.parse(await inHeldContext(t, () => reg.get('restore_snapshot')!.handler({ snapshotId: snapshot!.id, deviceId: t.deviceId }, auth)) as string);
    expect(out).toEqual({ error: 'Failed to dispatch restore command to agent' });
    const jobs = await getTestDb().select({ status: restoreJobs.status, commandId: restoreJobs.commandId }).from(restoreJobs).where(eq(restoreJobs.orgId, t.orgId));
    expect(jobs).toEqual([{ status: 'failed', commandId: null }]);
    // Tenant- and model-readable: the fixed message, never the raw SQL error.
    const [stored] = await getTestDb().select({ targetConfig: restoreJobs.targetConfig }).from(restoreJobs).where(eq(restoreJobs.orgId, t.orgId));
    expect(stored!.targetConfig).toMatchObject({ error: 'Failed to dispatch restore command to agent' });
    expect(JSON.stringify(stored!.targetConfig)).not.toContain('forced statement failure');
    expect(await getTestDb().select().from(deviceCommands).where(eq(deviceCommands.deviceId, t.deviceId))).toHaveLength(0);
  });
});

describe('scriptDispatch.discardPendingExecution: a failed discard does not mask insert_failed', () => {
  runDb('insert_failed is returned, the undeleted execution stays pending, the proof write commits', async () => {
    const t = await tenant();
    const [inserted] = await getTestDb().insert(scripts).values({
      orgId: t.orgId, name: `rows-${randomUUID()}`, osTypes: ['linux'], language: 'bash', content: 'echo rows',
    }).returning();
    const [device] = await getTestDb().select().from(devices).where(eq(devices.id, t.deviceId));
    const dispatch = () => dispatchScriptToDevice({ device: device!, source: { kind: 'saved', script: inserted! }, bypassMaintenanceWindow: true });
    const executions = () => getTestDb().select({ status: scriptExecutions.status }).from(scriptExecutions).where(eq(scriptExecutions.deviceId, t.deviceId));
    queueStub.noRow = true;

    // CONTROL: the discard works, so no orphaned pending execution is left behind.
    expect(await inHeldContext(t, dispatch)).toMatchObject({ ok: false, code: 'insert_failed' });
    expect(await executions()).toHaveLength(0);

    await failWritesOn('script_executions', { ops: 'DELETE' });
    const logged = errorLog();
    expect(await inHeldContext(t, dispatch)).toMatchObject({ ok: false, code: 'insert_failed' });
    expectLogged(logged, '[scriptDispatch] failed to discard pending execution row');
    expect(await executions()).toEqual([{ status: 'pending' }]);
  });
});
