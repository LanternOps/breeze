import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  automationActionResults,
  automationRunDeviceResults,
  automationRuns,
  automations,
  deploymentResults,
  deviceCommands,
  devices,
  scriptExecutions,
  scripts,
  softwareCatalog,
  softwareDeployments,
  softwareVersions,
} from '../../db/schema';
import {
  applyAutomationActionTerminal,
  recordAutomationActionDispatch,
  seedAutomationActionResults,
} from '../../services/automationActionResults';
import { applyCommandAutomationTerminal } from '../../services/automationTerminalEvidence';
import { applySoftwareInstallResult } from '../../services/softwareDeploymentResult';
import {
  reapStaleDeviceCommands,
  reapStaleScriptExecutions,
  reapStaleSoftwareDeploymentResults,
} from '../../jobs/staleCommandReaper';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

async function fixture(actionCount: number) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const [device] = await getTestDb().insert(devices).values({
    orgId: org.id,
    siteId: site.id,
    agentId: `terminal-${randomUUID()}`,
    hostname: 'terminal-device',
    osType: 'windows',
    osVersion: '11',
    architecture: 'amd64',
    agentVersion: '1.0.0',
  }).returning({ id: devices.id, orgId: devices.orgId });
  const [automation] = await getTestDb().insert(automations).values({
    orgId: org.id,
    name: `terminal-${randomUUID()}`,
    trigger: { type: 'manual' },
    actions: [],
  }).returning({ id: automations.id });
  const [run] = await getTestDb().insert(automationRuns).values({
    automationId: automation!.id,
    triggeredBy: 'terminal-integration',
    devicesTargeted: 1,
  }).returning({ id: automationRuns.id });
  await getTestDb().insert(automationRunDeviceResults).values({
    runId: run!.id,
    deviceId: device!.id,
    orgId: org.id,
    status: 'pending',
  });
  await seedAutomationActionResults({
    runId: run!.id,
    device: device!,
    actions: Array.from({ length: actionCount }, (_, actionIndex) => ({ actionIndex, actionType: 'async' })),
  });
  return { org, site, device: device!, run: run! };
}

describe('automation terminal reconciliation — real PostgreSQL', () => {
  runDb('makes HTTP/WS-equivalent command evidence idempotent and honors nonzero exits and reversed arrival', async () => {
    const f = await fixture(4);
    const correlations = Array.from({ length: 4 }, () => ({ commandId: randomUUID(), scriptExecutionId: randomUUID() }));
    for (const [actionIndex, ids] of correlations.entries()) {
      await recordAutomationActionDispatch({
        runId: f.run.id,
        deviceId: f.device.id,
        actionIndex,
        status: 'running',
        ...ids,
      });
    }

    // The same helper is called by HTTP and WS. The first effective transport
    // wins; a duplicate transport frame becomes a correlation no-op.
    expect(await applyCommandAutomationTerminal({ commandId: correlations[0]!.commandId, result: { status: 'completed', exitCode: 0 } })).toBe(true);
    expect(await applyCommandAutomationTerminal({ commandId: correlations[0]!.commandId, result: { status: 'completed', exitCode: 0 } })).toBe(false);
    expect(await applyCommandAutomationTerminal({ commandId: correlations[1]!.commandId, result: { status: 'completed', exitCode: 17 } })).toBe(true);

    // Script evidence may arrive before or after command evidence. Terminal
    // rows never regress, except real script evidence may replace a provisional
    // no-evidence reaper timeout.
    expect(await applyAutomationActionTerminal({ source: 'script_execution', scriptExecutionId: correlations[2]!.scriptExecutionId, terminalStatus: 'succeeded', completedAt: new Date() })).toBe(true);
    expect(await applyCommandAutomationTerminal({ commandId: correlations[2]!.commandId, result: { status: 'failed' } })).toBe(false);
    expect(await applyAutomationActionTerminal({ source: 'reaper', commandId: correlations[3]!.commandId, terminalStatus: 'timed_out', completedAt: new Date() })).toBe(true);
    expect(await applyAutomationActionTerminal({ source: 'script_execution', scriptExecutionId: correlations[3]!.scriptExecutionId, terminalStatus: 'succeeded', completedAt: new Date() })).toBe(true);

    const rows = await getTestDb().select({ status: automationActionResults.status })
      .from(automationActionResults)
      .where(eq(automationActionResults.runId, f.run.id));
    expect(rows.map((row) => row.status).sort()).toEqual(['failed', 'succeeded', 'succeeded', 'succeeded']);
    const [run] = await getTestDb().select().from(automationRuns).where(eq(automationRuns.id, f.run.id));
    expect(run).toMatchObject({ status: 'failed', devicesSucceeded: 0, devicesFailed: 1 });
  });

  runDb('uses the effective deployment-result CAS for direct and queued software correlations', async () => {
    const f = await fixture(1);
    const [catalog] = await getTestDb().insert(softwareCatalog).values({ orgId: f.org.id, name: `terminal-package-${randomUUID()}` }).returning({ id: softwareCatalog.id });
    const [version] = await getTestDb().insert(softwareVersions).values({ catalogId: catalog!.id, version: '1.0.0', downloadUrl: 'https://example.invalid/test.msi' }).returning({ id: softwareVersions.id });
    const [deployment] = await getTestDb().insert(softwareDeployments).values({
      orgId: f.org.id,
      name: 'terminal deployment',
      softwareVersionId: version!.id,
      deploymentType: 'install',
      targetType: 'devices',
      targetIds: [f.device.id],
      scheduleType: 'immediate',
      dispatchedAt: new Date(),
    }).returning({ id: softwareDeployments.id });
    const [result] = await getTestDb().insert(deploymentResults).values({ deploymentId: deployment!.id, deviceId: f.device.id }).returning({ id: deploymentResults.id });
    await recordAutomationActionDispatch({ runId: f.run.id, deviceId: f.device.id, actionIndex: 0, status: 'running', deploymentResultId: result!.id });

    const apply = () => withDbAccessContext(orgContext(f.org.id), () => applySoftwareInstallResult({
      deploymentId: deployment!.id,
      deviceId: f.device.id,
      status: 'completed',
      exitCode: 0,
      stdout: 'installed',
    }));
    expect(await apply()).toBe(result!.id);
    expect(await apply()).toBeNull();

    const [action] = await getTestDb().select().from(automationActionResults).where(eq(automationActionResults.runId, f.run.id));
    expect(action).toMatchObject({ status: 'succeeded', deploymentResultId: result!.id });
  });

  runDb('wires command, script, and deployment reapers only after effective source transitions', async () => {
    const f = await fixture(3);
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

    const [command] = await getTestDb().insert(deviceCommands).values({
      deviceId: f.device.id,
      type: 'script',
      payload: {},
      status: 'pending',
      createdAt: old,
    }).returning({ id: deviceCommands.id });
    const [script] = await getTestDb().insert(scripts).values({
      orgId: f.org.id,
      name: `reaper-script-${randomUUID()}`,
      osTypes: ['windows'],
      language: 'powershell',
      content: 'exit 0',
      timeoutSeconds: 1,
    }).returning({ id: scripts.id });
    const [execution] = await getTestDb().insert(scriptExecutions).values({
      scriptId: script!.id,
      deviceId: f.device.id,
      orgId: f.org.id,
      status: 'pending',
      createdAt: old,
    }).returning({ id: scriptExecutions.id });
    const [catalog] = await getTestDb().insert(softwareCatalog).values({ orgId: f.org.id, name: `reaper-package-${randomUUID()}` }).returning({ id: softwareCatalog.id });
    const [version] = await getTestDb().insert(softwareVersions).values({ catalogId: catalog!.id, version: '1.0.0', downloadUrl: 'https://example.invalid/reaper.msi' }).returning({ id: softwareVersions.id });
    const [deployment] = await getTestDb().insert(softwareDeployments).values({
      orgId: f.org.id,
      name: 'reaper deployment',
      softwareVersionId: version!.id,
      deploymentType: 'install',
      targetType: 'devices',
      targetIds: [f.device.id],
      scheduleType: 'immediate',
      dispatchedAt: old,
    }).returning({ id: softwareDeployments.id });
    const [deploymentResult] = await getTestDb().insert(deploymentResults).values({ deploymentId: deployment!.id, deviceId: f.device.id }).returning({ id: deploymentResults.id });

    await recordAutomationActionDispatch({ runId: f.run.id, deviceId: f.device.id, actionIndex: 0, status: 'running', commandId: command!.id });
    await recordAutomationActionDispatch({ runId: f.run.id, deviceId: f.device.id, actionIndex: 1, status: 'running', scriptExecutionId: execution!.id });
    await recordAutomationActionDispatch({ runId: f.run.id, deviceId: f.device.id, actionIndex: 2, status: 'running', deploymentResultId: deploymentResult!.id });

    expect(await withSystemDbAccessContext(() => reapStaleDeviceCommands())).toBeGreaterThanOrEqual(1);
    expect(await withSystemDbAccessContext(() => reapStaleScriptExecutions())).toBeGreaterThanOrEqual(1);
    expect(await withSystemDbAccessContext(() => reapStaleSoftwareDeploymentResults())).toBeGreaterThanOrEqual(1);

    const rows = await getTestDb().select().from(automationActionResults).where(eq(automationActionResults.runId, f.run.id));
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.status === 'timed_out' && row.terminalSource === 'reaper')).toBe(true);
  });
});
