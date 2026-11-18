/**
 * #11225 round 3, worker rows. Workers run inside a held system context (a job
 * wraps its whole body in one transaction), so a catch around a query only
 * survives if the query ran in a savepoint. Each case forces a real statement
 * failure, reaches the module through its exported entry, and asserts the
 * catch's promised answer and that a write made beside it in the same held
 * transaction committed.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stubPurge = vi.hoisted(() => ({ fail: false }));
const generatorFault = vi.hoisted(() => ({ fail: false }));
const sentEmails = vi.hoisted(() => ({ calls: [] as Array<{ to: unknown; purpose?: string }> }));

vi.mock('../../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db')>();
  const { faultingDb } = await import('./caughtQuerySelectFault');
  return { ...actual, db: faultingDb(actual.db) };
});

vi.mock('../../services/topology/unboundNodeRetention', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/topology/unboundNodeRetention')>();
  const { db } = await import('../../db');
  const { sql: rawSql } = await import('drizzle-orm');
  return {
    ...actual,
    // The purge's own SQL fails on the current transaction when armed.
    purgeAgedUnboundStubNodes: async (...args: Parameters<typeof actual.purgeAgedUnboundStubNodes>) => {
      if (stubPurge.fail) await db.execute(rawSql`SELECT 1/0`);
      return actual.purgeAgedUnboundStubNodes(...args);
    },
  };
});

vi.mock('../../services/reportGenerationService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/reportGenerationService')>();
  const { db } = await import('../../db');
  const { sql: rawSql } = await import('drizzle-orm');
  return {
    ...actual,
    // The managed-evidence generator's own SQL fails on the current transaction when armed.
    generateManagedEvidenceReport: async (...args: Parameters<typeof actual.generateManagedEvidenceReport>) => {
      if (generatorFault.fail) await db.execute(rawSql`SELECT 1/0`);
      return actual.generateManagedEvidenceReport(...args);
    },
  };
});

vi.mock('../../services/c2cM365', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/c2cM365')>();
  // Only the two Microsoft calls are stubbed; the platform config, tenant guard and URLs are real.
  return {
    ...actual,
    acquireClientCredentialsToken: async () => ({ accessToken: 'token', expiresIn: 3600 }),
    testGraphAccess: async () => ({ ok: false }),
  };
});

vi.mock('../../services/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/email')>();
  // The SMTP round trip is the stub; templates are real.
  return {
    ...actual,
    getEmailService: () => ({
      sendEmail: async (message: { to: unknown; purpose?: string }) => { sentEmails.calls.push(message); },
    }),
  };
});

import { createHash, createHmac } from 'node:crypto';
import { generateAutoEvidenceForOccurrence } from '../../services/deliverableAutoEvidence';
import { reportRuns, reports, serviceDeliverableOccurrences, serviceDeliverables } from '../../db/schema';
import { db } from '../../db';
import { executeBuiltInPlaybookForRun } from '../../services/aiAgents/playbookActExecutor';
import { handleTicketCreatedEvent } from '../../services/aiAgents/ticketHelpdeskSubscriber';
import { applySyncData } from '../../services/unifi/unifiSyncService';
import { createSite, createUser } from './db-utils';
import { deliverRunEvent, watchRunForSession } from '../../services/workspace/chatRunBridge';
import { streamingSessionManager } from '../../services/streamingSessionManager';
import {
  alerts, c2cConnections, c2cConsentSessions, contractRenewalNotices, contracts, deviceCommands, devices,
  fleetFindings, fleetRemediationRunTargets, fleetRemediationRuns, quotes,
  aiAgentRuns, aiAgents, monitorDefinitions, monitorDeviceState, monitorEpisodes, playbookDefinitions, playbookExecutions, unifiDevices, unifiIntegrations, unifiSiteMappings, unifiSyncRuns,
} from '../../db/schema';
import { m365CallbackRoute } from '../../routes/c2c/m365Auth';
import { dispatchRunChunk } from '../../services/fleetFindings/dispatch';
import { createNetworkChangeAlert } from '../../services/networkBaseline';
import { notifyQuoteOutcome } from '../../services/quoteOutcomeNotify';
import { evaluateTicketAutonomy } from '../../services/actionIntents/ticketAutonomy';
import { resolveDeviceSiteId } from '../../services/deviceSiteResolver';
import { previousOccurrenceBaselineFor } from '../../services/evidenceBaseline';
import { runContractRenewalSweep } from '../../services/contractRenewal';
import { maybeSendAutoresponse } from '../../services/inboundEmail/autoresponder';
import { fireEscalationLatch } from '../../services/monitors/escalationLatch';
import { sendInAppNotification } from '../../services/notificationSenders/inAppSender';
import { expireTopologyEvidence } from '../../services/topology/collectionRetention';
import { resolveUserAuditOrgId } from '../../routes/auth/helpers';
import { clearStatementFaults, failStatementsOn, failWritesOn } from './caughtQueryFaults';
import { inHeldSystemContext, tenant } from './caughtQueryFixtures';
import { resetSelectFault, selectFault } from './caughtQuerySelectFault';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

/** A bound value that must never come back out in a stored or displayed error message. */
const SECRET_PARAM = 'secret-param-value-7f3a';

const errorLog = () => vi.spyOn(console, 'error').mockImplementation(() => {});
const expectLogged = (spy: ReturnType<typeof errorLog>, text: string) =>
  expect(spy.mock.calls.some((call) => typeof call[0] === 'string' && call[0].includes(text))).toBe(true);

beforeEach(() => {
  resetSelectFault();
  stubPurge.fail = false;
  generatorFault.fail = false;
  sentEmails.calls.length = 0;
});
afterEach(async () => {
  vi.restoreAllMocks();
  resetSelectFault();
  stubPurge.fail = false;
  generatorFault.fail = false;
  await clearStatementFaults();
});

describe('read-only gates and lookups degrade inside a held system context', () => {
  runDb('ticketAutonomy.evaluateTicketAutonomy: a failed run read denies with gate_evaluation_failed', async () => {
    const t = await tenant();
    const args = {
      requestedAutonomyKind: 'ticket_autonomy' as const, principalKind: 'ai_agent', agentRunId: randomUUID(),
      orgId: t.orgId, scope: { ticketId: randomUUID() },
    };
    // CONTROL: the same call reaches the run read and denies for the missing run.
    expect(await inHeldSystemContext(t, () => evaluateTicketAutonomy(args))).toEqual({ granted: false, reason: 'not_agent_run' });

    await failStatementsOn('ai_agent_runs');
    const logged = errorLog();
    expect(await inHeldSystemContext(t, () => evaluateTicketAutonomy(args))).toEqual({ granted: false, reason: 'gate_evaluation_failed' });
    expectLogged(logged, '[ticketAutonomy] gate evaluation threw');
  });

  runDb('deviceSiteResolver.resolveDeviceSiteId: a failed lookup answers undefined', async () => {
    const t = await tenant();
    const other = await tenant();
    // CONTROL on a different device: the lookup works and resolves the site.
    expect(await inHeldSystemContext(t, () => resolveDeviceSiteId(other.deviceId))).toBe(other.siteId);

    selectFault.key = 'siteId';
    selectFault.caller = 'resolveDeviceSiteId';
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await inHeldSystemContext(t, () => resolveDeviceSiteId(t.deviceId))).toBeUndefined();
    expect(selectFault.hits).toBe(1);
    expect(warned.mock.calls.some((call) => String(call[0]).includes('[deviceSiteResolver] failed to resolve siteId'))).toBe(true);
  });

  runDb('evidenceBaseline.previousOccurrenceBaselineFor: a failed lookup answers undefined', async () => {
    const t = await tenant();
    await failStatementsOn('service_deliverable_occurrences');
    const logged = errorLog();
    const baseline = await inHeldSystemContext(t, () => previousOccurrenceBaselineFor({ deliverableId: randomUUID(), currentPeriodStart: '2026-01-01' }));
    expect(baseline).toBeUndefined();
    expectLogged(logged, 'prior-occurrence baseline lookup failed');
  });

  runDb('routes/auth/helpers.resolveUserAuditOrgId: a failed lookup answers null', async () => {
    const t = await tenant();
    const user = await createUser({ partnerId: t.partnerId, orgId: t.orgId });
    selectFault.key = 'orgId';
    selectFault.caller = 'auth/helpers';
    const logged = errorLog();
    expect(await inHeldSystemContext(t, () => resolveUserAuditOrgId(user.id))).toBeNull();
    expect(selectFault.hits).toBe(1);
    expectLogged(logged, 'Failed to resolve orgId for user');
  });

  runDb('inboundEmail autoresponder: a failed settings read suppresses the reply and does not throw', async () => {
    const t = await tenant();
    selectFault.key = 'settings';
    selectFault.caller = 'autoresponderEnabled';
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await inHeldSystemContext(t, () => maybeSendAutoresponse(
      { provider: 'gmail', providerMessageId: 'm1', to: 'help@example.test', from: 'person@example.org', subject: 'hi', text: 'hi' } as never,
      t.partnerId,
      { id: randomUUID(), partnerId: t.partnerId, orgId: t.orgId, internalNumber: 'T-1', subject: 'hi' } as never,
    ));
    expect(selectFault.hits).toBe(1);
    expect(info).toHaveBeenCalledWith('[InboundEmail] autoresponse suppressed', expect.objectContaining({ reason: 'disabled' }));
  });

  runDb('monitors/escalationLatch.fireEscalationLatch: a failed device read raises no alert and returns null', async () => {
    const t = await tenant();
    selectFault.key = 'displayName';
    selectFault.caller = 'fireEscalationLatch';
    const logged = errorLog();
    const out = await inHeldSystemContext(t, () => fireEscalationLatch({
      monitor: { id: randomUUID(), name: 'CPU', severity: 'medium', recurrenceThreshold: 3, recurrenceWindowHours: 24, recurrenceActions: [{ type: 'noop' }] },
      deviceId: t.deviceId, orgId: t.orgId, episodeId: randomUUID(), episodesInWindow: 3,
    } as never));
    expect(out).toEqual({ escalationAlertId: null, recurrenceActionsPending: 1 });
    expect(selectFault.hits).toBe(1);
    expectLogged(logged, '[EscalationLatch] Failed to raise the requires-human alert');
  });
});

describe('monitors/escalationLatch: a failed alert-link write keeps the alert', () => {
  runDb('the alert is raised and returned even though stamping it on monitor_device_state fails', async () => {
    const t = await tenant();
    const [monitor] = await getTestDb().insert(monitorDefinitions).values({
      orgId: t.orgId, name: `rows-${randomUUID()}`, kind: 'cpu', severity: 'medium', condition: {},
    }).returning();
    const [episode] = await getTestDb().insert(monitorEpisodes).values({ monitorId: monitor!.id, deviceId: t.deviceId, orgId: t.orgId })
      .returning({ id: monitorEpisodes.id });
    await getTestDb().insert(monitorDeviceState).values({ monitorId: monitor!.id, deviceId: t.deviceId, orgId: t.orgId });
    await failWritesOn('monitor_device_state', { ops: 'UPDATE' });
    const logged = errorLog();
    const out = await inHeldSystemContext(t, () => fireEscalationLatch({
      monitor: monitor!, deviceId: t.deviceId, orgId: t.orgId, episodeId: episode!.id, episodesInWindow: 3,
    }));
    expectLogged(logged, 'could not stamp it on monitor_device_state');
    expect(out.escalationAlertId).toBeTruthy();
    const raised = await getTestDb().select({ id: alerts.id }).from(alerts).where(eq(alerts.id, out.escalationAlertId!));
    expect(raised).toHaveLength(1);
    const [state] = await getTestDb().select({ alertId: monitorDeviceState.escalationAlertId }).from(monitorDeviceState)
      .where(eq(monitorDeviceState.monitorId, monitor!.id));
    expect(state?.alertId).toBeNull();
  });
});

describe('notification senders answer a failure and the caller transaction survives', () => {
  runDb('inAppSender.sendInAppNotification: a failed recipient read answers success false', async () => {
    const t = await tenant();
    const payload = { alertId: randomUUID(), alertName: 'Rows', severity: 'info' as const, message: 'm', orgId: t.orgId };
    expect(await inHeldSystemContext(t, () => sendInAppNotification(payload))).toMatchObject({ success: true });

    selectFault.key = 'partnerId';
    selectFault.caller = 'sendInAppNotification';
    const logged = errorLog();
    expect(await inHeldSystemContext(t, () => sendInAppNotification(payload))).toMatchObject({ success: false });
    expect(selectFault.hits).toBe(1);
    expectLogged(logged, '[InAppSender] Failed to send in-app notification');
  });
});

describe('contractRenewal.runContractRenewalSweep: a failed notice read does not abort the sweep', () => {
  runDb('both contracts are noticed and both notice claims commit', async () => {
    const t = await tenant();
    const endDate = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const ids: string[] = [];
    for (const name of ['Renewal A', 'Renewal B']) {
      const [row] = await getTestDb().insert(contracts).values({
        orgId: t.orgId, partnerId: t.partnerId, name, status: 'active', billingTiming: 'advance', intervalMonths: 1,
        startDate: '2026-01-01', currencyCode: 'USD', autoRenew: true, endDate, renewalTermMonths: 12, renewalNoticeDays: 30,
      }).returning({ id: contracts.id });
      ids.push(row!.id);
    }
    // The first dispatch's organization read fails; the second contract is still processed.
    selectFault.key = 'name';
    selectFault.caller = 'dispatchNotice';
    selectFault.maxHits = 1;
    const logged = errorLog();
    const out = await inHeldSystemContext(t, () => runContractRenewalSweep());
    expect(selectFault.hits).toBe(1);
    expectLogged(logged, '[ContractRenewal] notice dispatch failed');
    expect(out).toEqual({ noticed: 2, renewed: 0 });
    const claims = await getTestDb().select({ contractId: contractRenewalNotices.contractId }).from(contractRenewalNotices)
      .where(eq(contractRenewalNotices.orgId, t.orgId));
    expect(claims.map((c) => c.contractId).sort()).toEqual([...ids].sort());
  });
});

describe('topology collectionRetention.expireTopologyEvidence: a failed stub purge keeps the retention', () => {
  runDb('the purge failure is logged, the count stays 0 and the site bump commits', async () => {
    const t = await tenant();
    await getTestDb().execute(sql`INSERT INTO topology_site_state (org_id, site_id) VALUES (${t.orgId}::uuid, ${t.siteId}::uuid) ON CONFLICT DO NOTHING`);
    stubPurge.fail = true;
    const logged = errorLog();
    const out = await inHeldSystemContext(t, () => expireTopologyEvidence({ orgId: t.orgId, siteId: t.siteId } as never));
    expectLogged(logged, '[topology-retention] unbound stub purge failed');
    expect(out.purgedStubNodes).toBe(0);
  });
});

describe('networkBaseline.createNetworkChangeAlert: one failing strategy falls through to the next', () => {
  runDb('a failed exact-IP asset read still resolves the site anchor device and raises the alert', async () => {
    const t = await tenant();
    const changeEvent = {
      id: randomUUID(), orgId: t.orgId, siteId: t.siteId, baselineId: randomUUID(), alertId: null, linkedDeviceId: null,
      ipAddress: '192.0.2.10', macAddress: '00:00:5e:00:53:01', hostname: 'rows-host', assetType: 'unknown',
      previousState: null, currentState: {}, detectedAt: new Date(),
    };
    selectFault.key = 'linkedDeviceId';
    selectFault.caller = 'resolveAlertDeviceForChangeEvent';
    selectFault.maxHits = 1;
    const logged = errorLog();
    await inHeldSystemContext(t, () => createNetworkChangeAlert('new_device', changeEvent as never, { alertSettings: {} }));
    expect(selectFault.hits).toBe(1);
    expectLogged(logged, "strategy 'discovered_asset_exact_ip' failed");
    const raised = await getTestDb().select({ context: alerts.context }).from(alerts).where(eq(alerts.deviceId, t.deviceId));
    expect(raised).toHaveLength(1);
    expect(raised[0]!.context).toMatchObject({ alertDeviceResolution: 'site_anchor_device' });
  });
});

describe('quoteOutcomeNotify.notifyQuoteOutcome: a failed draft-contract count still sends the notification', () => {
  runDb('the accept email goes to the quote creator', async () => {
    const t = await tenant();
    const creator = await createUser({ partnerId: t.partnerId, orgId: t.orgId, email: `creator-${randomUUID()}@example.test` });
    const [quote] = await getTestDb().insert(quotes).values({
      partnerId: t.partnerId, orgId: t.orgId, siteId: t.siteId, title: 'Rows quote', status: 'sent', currencyCode: 'USD',
      quoteNumber: `Q-${randomUUID().slice(0, 8)}`, sentAt: new Date(), createdBy: creator.id,
    } as never).returning({ id: quotes.id });
    await failStatementsOn('contracts');
    const logged = errorLog();
    await notifyQuoteOutcome({ quoteId: quote!.id, outcome: 'accepted', source: 'customer' });
    expectLogged(logged, '[quoteOutcomeNotify] draft-contract count failed');
    expect(sentEmails.calls).toHaveLength(1);
    expect(sentEmails.calls[0]).toMatchObject({ to: creator.email, purpose: 'staff.quote_outcome' });
  });
});

describe('routes/c2c/m365Auth consent callback: a failed connection insert answers an error redirect', () => {
  const originalEnv = { id: process.env.C2C_M365_CLIENT_ID, secret: process.env.C2C_M365_CLIENT_SECRET };
  afterEach(() => {
    if (originalEnv.id === undefined) delete process.env.C2C_M365_CLIENT_ID; else process.env.C2C_M365_CLIENT_ID = originalEnv.id;
    if (originalEnv.secret === undefined) delete process.env.C2C_M365_CLIENT_SECRET; else process.env.C2C_M365_CLIENT_SECRET = originalEnv.secret;
  });

  runDb('a 302 to c2c_error, no connection stored, the consent session consumed', async () => {
    const t = await tenant();
    process.env.C2C_M365_CLIENT_ID = '77777777-7777-4777-8777-777777777777';
    process.env.C2C_M365_CLIENT_SECRET = 'rows-platform-secret';
    const state = randomUUID().replace(/-/g, '');
    await getTestDb().insert(c2cConsentSessions).values({
      orgId: t.orgId, state, provider: 'microsoft_365', displayName: 'Rows', expiresAt: new Date(Date.now() + 600_000),
    });
    const cookie = createHmac('sha256', 'rows-platform-secret').update(`c2c-m365-consent:${state}`).digest('hex');
    await failWritesOn('c2c_connections', { ops: 'INSERT' });
    const logged = errorLog();
    const tenantGuid = '88888888-8888-4888-8888-888888888888';
    const res = await m365CallbackRoute.request(`/c2c/m365/callback?state=${state}&tenant=${tenantGuid}&admin_consent=True`, {
      headers: { cookie: `breeze_c2c_m365_consent=${encodeURIComponent(cookie)}` },
    });
    expectLogged(logged, '[c2c/m365/callback] Consent callback failed');
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain(`c2c_error=${encodeURIComponent('Could not save the connection')}`);
    expect(location).not.toContain('Failed query');
    expect(location).not.toContain(tenantGuid);
    expect(await getTestDb().select().from(c2cConnections).where(eq(c2cConnections.orgId, t.orgId))).toHaveLength(0);
    expect(await getTestDb().select().from(c2cConsentSessions).where(eq(c2cConsentSessions.state, state))).toHaveLength(0);
  });
});

describe('fleetFindings.dispatchRunChunk: one failing target does not stop the chunk', () => {
  runDb('the failing target is marked failed and the next target is queued', async () => {
    const t = await tenant();
    const [second] = await getTestDb().insert(devices).values({
      orgId: t.orgId, siteId: t.siteId, agentId: `rows-${randomUUID()}`, hostname: `rows-${randomUUID()}`, osType: 'linux',
      osVersion: 'test', architecture: 'amd64', agentVersion: '1.0.0-test', status: 'online',
    }).returning({ id: devices.id });
    // Targets dispatch in uuid order, so the first one sorted is the one made to fail.
    const [failing, healthy] = [t.deviceId, second!.id].sort();
    const [finding] = await getTestDb().insert(fleetFindings).values({
      orgId: t.orgId, kind: 'reliability_offenders', semanticKey: `rows-${randomUUID()}`, title: 'Rows finding',
      firstSeenAt: new Date(), lastSeenAt: new Date(),
    }).returning({ id: fleetFindings.id });
    const [run] = await getTestDb().insert(fleetRemediationRuns).values({
      orgId: t.orgId, findingId: finding!.id, findingRevision: 1, actionKind: 'command', commandType: 'restart_service',
      parameterSnapshot: { serviceName: SECRET_PARAM }, targetCount: 2,
    }).returning({ id: fleetRemediationRuns.id });
    await getTestDb().insert(fleetRemediationRunTargets).values([failing!, healthy!].map((id) => ({
      runId: run!.id, orgId: t.orgId, targetDeviceUuid: id,
    })));
    await failWritesOn('device_commands', { ops: 'INSERT', when: `NEW.device_id = '${failing}'` });
    const logged = errorLog();
    await inHeldSystemContext(t, () => dispatchRunChunk(run!.id, 0));
    expectLogged(logged, '[fleetFindings] Unexpected error dispatching run');
    const targets = await getTestDb().select().from(fleetRemediationRunTargets).where(eq(fleetRemediationRunTargets.runId, run!.id));
    const byDevice = new Map(targets.map((row) => [row.targetDeviceUuid, row]));
    // Stored and tenant-readable: no failed query, no bound value.
    const summary = byDevice.get(failing!)?.resultSummary ?? '';
    expect(summary).not.toBe('');
    expect(summary).not.toContain('Failed query');
    expect(summary).not.toContain(SECRET_PARAM);
    expect(byDevice.get(failing!)?.status).toBe('failed');
    expect(byDevice.get(healthy!)?.status).toBe('queued');
    expect(byDevice.get(healthy!)?.deviceCommandId).toBeTruthy();
    const commands = await getTestDb().select({ deviceId: deviceCommands.deviceId }).from(deviceCommands)
      .where(eq(deviceCommands.type, 'restart_service'));
    expect(commands.map((c) => c.deviceId)).toEqual([healthy]);
  });
});

describe('playbookActExecutor: the execution ledger insert fails closed, the finalize is best-effort', () => {
  async function playbookFixture() {
    const t = await tenant();
    const executeToolFn = vi.fn(async () => JSON.stringify({ ok: true }));
    const steps = [{ name: 'read', description: '', type: 'diagnose' as const, tool: 'analyze_disk_usage', toolInput: {} }];
    const [definition] = await getTestDb().insert(playbookDefinitions).values({
      name: `Rows playbook ${randomUUID()}`, description: 'rows', steps, isBuiltIn: true, isActive: true,
    }).returning({ id: playbookDefinitions.id, steps: playbookDefinitions.steps });
    // jsonb reorders object keys, so pin the digest of the stored shape, as pinPlaybook does.
    const args = {
      run: { id: randomUUID(), orgId: t.orgId, agentId: randomUUID(), agentKind: 'helpdesk', deviceId: t.deviceId, deviceSiteId: t.siteId },
      agentAuth: { user: { id: randomUUID() } },
      playbookId: definition!.id,
      expectedDigest: createHash('sha256').update(JSON.stringify(definition!.steps)).digest('hex'),
      variables: {},
      reserved: {},
      deadlineMs: Date.now() + 60_000,
      deps: { executeToolFn },
    };
    return { t, args: args as never, executeToolFn, definitionId: definition!.id };
  }
  const executions = (orgId: string) => getTestDb().select({ status: playbookExecutions.status }).from(playbookExecutions)
    .where(eq(playbookExecutions.orgId, orgId));

  runDb('a failed ledger insert propagates and no step is dispatched', async () => {
    const { t, args, executeToolFn } = await playbookFixture();
    await failWritesOn('playbook_executions', { ops: 'INSERT' });
    await expect(inHeldSystemContext(t, () => executeBuiltInPlaybookForRun(args)))
      .rejects.toSatisfy((err: unknown) => {
        const e = err as { message?: unknown; cause?: { message?: unknown } };
        return String(e.cause?.message ?? e.message).includes('forced statement failure on playbook_executions');
      });
    expect(executeToolFn).not.toHaveBeenCalled();
    expect(await executions(t.orgId)).toHaveLength(0);
  });

  runDb('a failed ledger finalize is logged and the inserted row stays as written', async () => {
    const { t, args } = await playbookFixture();
    await failWritesOn('playbook_executions', { ops: 'UPDATE' });
    const logged = errorLog();
    const out = await inHeldSystemContext(t, () => executeBuiltInPlaybookForRun(args));
    expectLogged(logged, 'failed to finalize the playbook_executions row');
    expect(out).toMatchObject({ execution: 'unknown' });
    expect(out.playbookExecutionId).toBeTruthy();
    expect(await executions(t.orgId)).toEqual([{ status: 'running' }]);
  });
});

describe('ticketHelpdeskSubscriber: the admission guards deny when their read fails', () => {
  const created = (orgId: string) => ({ id: randomUUID(), type: 'ticket.created', orgId, payload: { ticketId: randomUUID() } }) as never;
  const runsFor = (orgId: string) => getTestDb().select({ id: aiAgentRuns.id }).from(aiAgentRuns).where(eq(aiAgentRuns.orgId, orgId));

  runDb('a failed loop-guard read denies admission without throwing', async () => {
    const t = await tenant();
    await failStatementsOn('ticket_comments');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const logged = errorLog();
    await inHeldSystemContext(t, () => handleTicketCreatedEvent(created(t.orgId)));
    expectLogged(logged, '[ticketHelpdesk] loop-guard read failed');
    expect(info.mock.calls.some((call) => String(call[0]).includes('loop guard'))).toBe(true);
    expect(await runsFor(t.orgId)).toHaveLength(0);
  });

  runDb('a failed triage-ceiling read denies admission without throwing', async () => {
    const t = await tenant();
    await failStatementsOn('ai_agent_runs');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const logged = errorLog();
    await inHeldSystemContext(t, () => handleTicketCreatedEvent(created(t.orgId)));
    expectLogged(logged, '[ticketHelpdesk] triage-run ceiling read failed');
    expect(info.mock.calls.some((call) => String(call[0]).includes('per-ticket triage-run ceiling'))).toBe(true);
  });
});

describe('unifiSyncService.applySyncData: one site failing keeps the other site', () => {
  runDb('the failed site is rolled back with its counts, the other site is written, the run is partial', async () => {
    const t = await tenant();
    const secondSite = await createSite({ orgId: t.orgId });
    const [integration] = await getTestDb().insert(unifiIntegrations).values({ partnerId: t.partnerId, apiKeyEncrypted: 'k' }).returning({ id: unifiIntegrations.id });
    const mappings = await getTestDb().insert(unifiSiteMappings).values([t.siteId, secondSite.id].map((siteId, index) => ({
      integrationId: integration!.id, orgId: t.orgId, siteId, unifiHostId: `host-${index}`, unifiSiteId: `site-${index}`,
    }))).returning();
    const deviceFor = (n: number) => ({
      unifiDeviceId: `dev-${n}`, mac: `00:00:5e:00:53:0${n}`, name: `${SECRET_PARAM}-${n}`, model: 'USW', deviceType: 'usw', ip: `192.0.2.${n}`,
      firmwareVersion: '1.0.0', firmwareUpdatable: false, adoptionState: 'adopted', uptimeSeconds: 10, raw: { n },
    });
    const [failing, healthy] = mappings;
    const collected = {
      hostsSeen: 2,
      byMapping: new Map([
        [failing!.id, { mappingId: failing!.id, devices: [deviceFor(1)] }],
        [healthy!.id, { mappingId: healthy!.id, devices: [deviceFor(2)] }],
      ]),
    };
    await failWritesOn('unifi_devices', { ops: 'INSERT', when: `NEW.mapping_id = '${failing!.id}'` });
    const result = await inHeldSystemContext(t, () => applySyncData(db as never, { id: integration!.id, partnerId: t.partnerId }, 'manual', mappings, collected as never));

    expect(result).toMatchObject({ status: 'partial', devicesCreated: 1, devicesUpdated: 0 });
    expect(result.error).toContain(`site ${failing!.unifiSiteId}`);
    expect(result.error).not.toContain('Failed query');
    expect(result.error).not.toContain(SECRET_PARAM);
    const rows = await getTestDb().select({ unifiDeviceId: unifiDevices.unifiDeviceId, mappingId: unifiDevices.mappingId }).from(unifiDevices)
      .where(eq(unifiDevices.integrationId, integration!.id));
    expect(rows).toEqual([{ unifiDeviceId: 'dev-2', mappingId: healthy!.id }]);
    const [run] = await getTestDb().select({ status: unifiSyncRuns.status, created: unifiSyncRuns.devicesCreated, error: unifiSyncRuns.error })
      .from(unifiSyncRuns).where(eq(unifiSyncRuns.integrationId, integration!.id));
    expect(run).toMatchObject({ status: 'partial', created: 1 });
    expect(run?.error).toContain(`site ${failing!.unifiSiteId}`);
    expect(run?.error).not.toContain('Failed query');
    expect(run?.error).not.toContain(SECRET_PARAM);
  });
});

describe('workspace/chatRunBridge: a failed pending-intent count still delivers the run result', () => {
  runDb('the result reaches the session without pendingIntentCount', async () => {
    const t = await tenant();
    const user = await createUser({ partnerId: t.partnerId, orgId: t.orgId });
    const [agent] = await getTestDb().insert(aiAgents).values({ orgId: t.orgId, partnerId: null, kind: 'triage', name: 'Rows', createdBy: user.id } as never)
      .returning({ id: aiAgents.id });
    const [run] = await getTestDb().insert(aiAgentRuns).values({
      agentId: agent!.id, orgId: t.orgId, triggerKind: 'alert', dedupeKey: `rows-${randomUUID()}`, modeAtStart: 'shadow',
      policySnapshot: { schemaVersion: 1 } as never, status: 'awaiting_approval', summary: 'Two steps are waiting',
    } as never).returning({ id: aiAgentRuns.id });

    const sessionId = randomUUID();
    const published: Array<Record<string, unknown>> = [];
    const session = { orgId: t.orgId, breezeSessionId: sessionId, eventBus: { publish: (frame: Record<string, unknown>) => { published.push(frame); } }, pendingRunResults: [] as unknown[] };
    vi.spyOn(streamingSessionManager, 'get').mockReturnValue(session as never);
    watchRunForSession({ runId: run!.id, sessionId, orgId: t.orgId });
    await failStatementsOn('action_intents');
    const logged = errorLog();

    await deliverRunEvent({ type: 'ai.agent.run.awaiting_approval', payload: { runId: run!.id } });

    expectLogged(logged, '[ChatRunBridge] pending intent count failed');
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ type: 'run_result', runId: run!.id, status: 'awaiting_approval', summary: 'Two steps are waiting' });
    expect('pendingIntentCount' in published[0]!).toBe(false);
    expect(session.pendingRunResults).toHaveLength(1);
  });
});

describe('deliverableAutoEvidence: a generator SQL failure leaves the run stamped failed', () => {
  runDb('the run is failed, the refusal is recorded on the occurrence, the sweep write commits', async () => {
    const t = await tenant();
    const owner = await createUser({ partnerId: t.partnerId, orgId: t.orgId });
    const [report] = await getTestDb().insert(reports).values({
      orgId: t.orgId, name: 'Managed evidence', type: 'endpoint_management_review', config: {}, schedule: 'one_time',
      format: 'pdf', portalSelfService: true,
    }).returning({ id: reports.id });
    const [deliverable] = await getTestDb().insert(serviceDeliverables).values({
      orgId: t.orgId, name: 'Endpoint review', cadence: 'monthly', anchorDueDate: '2026-10-31', effectiveFrom: '2026-10-01',
      leadDays: 7, graceDays: 14, artifactRequired: true, completionMode: 'on_ticket_resolve', ownerUserId: owner.id,
    }).returning({ id: serviceDeliverables.id });
    const due = '2026-10-31';
    const [occurrence] = await getTestDb().insert(serviceDeliverableOccurrences).values({
      orgId: t.orgId, deliverableId: deliverable!.id, nameSnapshot: 'Endpoint review', periodStart: due, periodEnd: due,
      dueAt: due, originalDueAt: due, status: 'open',
    }).returning({ id: serviceDeliverableOccurrences.id });
    generatorFault.fail = true;
    const logged = errorLog();

    const outcome = await inHeldSystemContext(t, () => generateAutoEvidenceForOccurrence({
      orgId: t.orgId, occurrenceId: occurrence!.id, ticketId: null, reportId: report!.id, dueAt: due, today: '2026-11-01',
      deliverableId: deliverable!.id, periodStart: due, periodEnd: due, lastRefusal: null,
    }));

    expectLogged(logged, '[deliverables] auto-evidence generation failed');
    expect(outcome).toEqual({ ok: false, reason: 'generation_failed' });
    const runs = await getTestDb().select({ status: reportRuns.status, errorMessage: reportRuns.errorMessage }).from(reportRuns)
      .where(eq(reportRuns.reportId, report!.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('failed');
    expect(runs[0]!.errorMessage).toBeTruthy();
    expect(runs[0]!.errorMessage).not.toContain('Failed query');
    const [occ] = await getTestDb().select({ refusal: serviceDeliverableOccurrences.autoEvidenceRefusal, at: serviceDeliverableOccurrences.autoEvidenceAttemptedAt })
      .from(serviceDeliverableOccurrences).where(eq(serviceDeliverableOccurrences.id, occurrence!.id));
    expect(occ?.refusal).toBe('generation_failed');
    expect(occ?.at).not.toBeNull();
  });
});
