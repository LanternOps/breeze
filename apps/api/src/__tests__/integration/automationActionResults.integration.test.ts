import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  automationRunDeviceResults,
  automationRuns,
  automations,
  devices,
} from '../../db/schema';
import {
  applyAutomationActionTerminal,
  recordAutomationActionDispatch,
  reconcileAutomationRun,
  seedAutomationActionResults,
} from '../../services/automationActionResults';
import { getDeviceCascadeDeleteTables, getDeviceOrgDenormalizedTables } from '../../routes/devices/core';
import { cascadeDeleteOrg, getOrgCascadeDeleteOrder } from '../../services/tenantCascade';
import { getTenantExportPolicyRegistry } from '../../services/tenantExportPolicyRegistry';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const { publishEventMock } = vi.hoisted(() => ({ publishEventMock: vi.fn().mockResolvedValue('event-id') }));
vi.mock('../../services/eventBus', () => ({ publishEvent: publishEventMock }));

const runDb = it.runIf(!!process.env.DATABASE_URL);

function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

async function causeOf(work: () => Promise<unknown>): Promise<{ code?: string; message?: string } | undefined> {
  try { await work(); return undefined; } catch (error) {
    return (error as { cause?: { code?: string; message?: string } }).cause
      ?? (error as { code?: string; message?: string });
  }
}

async function fixture(actionCount = 2) {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const orgB = await createOrganization({ partnerId: partnerB.id });
  const siteA = await createSite({ orgId: orgA.id });
  const siteB = await createSite({ orgId: orgB.id });
  const [deviceA, deviceB] = await getTestDb().insert(devices).values([
    { orgId: orgA.id, siteId: siteA.id, agentId: `aar-a-${randomUUID()}`, hostname: 'aar-a', osType: 'windows', osVersion: '11', architecture: 'amd64', agentVersion: '1.0.0' },
    { orgId: orgB.id, siteId: siteB.id, agentId: `aar-b-${randomUUID()}`, hostname: 'aar-b', osType: 'linux', osVersion: '1', architecture: 'amd64', agentVersion: '1.0.0' },
  ]).returning({ id: devices.id, orgId: devices.orgId });
  const [automation] = await getTestDb().insert(automations).values({
    orgId: orgA.id,
    name: `action-results-${randomUUID()}`,
    trigger: { type: 'manual' },
    actions: [],
  }).returning({ id: automations.id });
  const [run] = await getTestDb().insert(automationRuns).values({
    automationId: automation!.id,
    triggeredBy: 'integration-test',
    devicesTargeted: 1,
  }).returning({ id: automationRuns.id });
  await getTestDb().insert(automationRunDeviceResults).values({
    runId: run!.id,
    deviceId: deviceA!.id,
    orgId: orgA.id,
    status: 'pending',
  });
  const actions = Array.from({ length: actionCount }, (_, actionIndex) => ({ actionIndex, actionType: 'run_script' }));
  return { partnerA, partnerB, orgA, orgB, siteA, siteB, deviceA: deviceA!, deviceB: deviceB!, automation: automation!, run: run!, actions };
}

describe('automation action results', () => {
  runDb('forces four-operation direct-org RLS and registers lifecycle/export coverage', async () => {
    const rows = await getTestDb().execute(sql`
      SELECT c.relrowsecurity AS rls_on, c.relforcerowsecurity AS rls_forced,
             ARRAY_AGG(DISTINCT p.cmd ORDER BY p.cmd) AS commands
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_policies p ON p.schemaname = n.nspname AND p.tablename = c.relname
      WHERE n.nspname = 'public' AND c.relname = 'automation_action_results'
      GROUP BY c.relrowsecurity, c.relforcerowsecurity
    `) as unknown as Array<{ rls_on: boolean; rls_forced: boolean; commands: string[] }>;
    expect(rows[0]).toEqual({ rls_on: true, rls_forced: true, commands: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'] });
    expect(getOrgCascadeDeleteOrder()).toContain('automation_action_results');
    expect(getDeviceCascadeDeleteTables()).toContain('automation_action_results');
    expect(getDeviceOrgDenormalizedTables()).toContain('automation_action_results');
    expect(Object.keys(getTenantExportPolicyRegistry().automation_action_results!.columns).sort()).toEqual([
      'action_index', 'action_type', 'command_id', 'completed_at', 'created_at', 'deployment_result_id',
      'device_id', 'error', 'id', 'message', 'org_id', 'output', 'run_id', 'script_execution_id',
      'status', 'terminal_source', 'updated_at',
    ].sort());
  });

  runDb('locks the authoritative device, derives org ownership, and rejects stale or forged ownership', async () => {
    const f = await fixture();
    await seedAutomationActionResults({ runId: f.run.id, device: f.deviceA, actions: f.actions });
    await seedAutomationActionResults({ runId: f.run.id, device: f.deviceA, actions: f.actions });
    const rows = await getTestDb().execute(sql`
      SELECT org_id, action_index FROM automation_action_results
      WHERE run_id = ${f.run.id}::uuid ORDER BY action_index
    `) as unknown as Array<{ org_id: string; action_index: number }>;
    expect(rows).toEqual([{ org_id: f.orgA.id, action_index: 0 }, { org_id: f.orgA.id, action_index: 1 }]);
    await expect(seedAutomationActionResults({
      runId: f.run.id,
      device: { id: f.deviceA.id, orgId: f.orgB.id },
      actions: f.actions,
    })).rejects.toThrow(/organization mismatch/i);
  });

  runDb('hides foreign rows and denies forged INSERT, UPDATE, and DELETE under forced RLS', async () => {
    const f = await fixture(1);
    await seedAutomationActionResults({ runId: f.run.id, device: f.deviceA, actions: f.actions });
    const hidden = await withDbAccessContext(orgContext(f.orgB.id), () => db.execute(sql`
      SELECT id FROM automation_action_results WHERE run_id = ${f.run.id}::uuid
    `));
    expect(hidden).toHaveLength(0);
    const insertError = await causeOf(() => withDbAccessContext(orgContext(f.orgB.id), () => db.execute(sql`
      INSERT INTO automation_action_results (run_id, device_id, org_id, action_index, action_type)
      VALUES (${f.run.id}::uuid, ${f.deviceA.id}::uuid, ${f.orgA.id}::uuid, 99, 'forged')
    `)));
    expect(insertError?.code).toBe('42501');
    const updated = await withDbAccessContext(orgContext(f.orgB.id), () => db.execute(sql`
      UPDATE automation_action_results SET message = 'forged'
      WHERE run_id = ${f.run.id}::uuid RETURNING id
    `));
    const deleted = await withDbAccessContext(orgContext(f.orgB.id), () => db.execute(sql`
      DELETE FROM automation_action_results WHERE run_id = ${f.run.id}::uuid RETURNING id
    `));
    expect(updated).toHaveLength(0);
    expect(deleted).toHaveLength(0);
  });

  runDb('enforces action identity and every non-null correlation uniqueness constraint', async () => {
    const f = await fixture(1);
    await seedAutomationActionResults({ runId: f.run.id, device: f.deviceA, actions: f.actions });
    const ids = { command: randomUUID(), script: randomUUID(), deployment: randomUUID() };
    await getTestDb().execute(sql`
      UPDATE automation_action_results SET command_id = ${ids.command}::uuid,
        script_execution_id = ${ids.script}::uuid, deployment_result_id = ${ids.deployment}::uuid
      WHERE run_id = ${f.run.id}::uuid
    `);
    const duplicateIdentity = await causeOf(() => getTestDb().execute(sql`
      INSERT INTO automation_action_results (run_id, device_id, org_id, action_index, action_type)
      VALUES (${f.run.id}::uuid, ${f.deviceA.id}::uuid, ${f.orgA.id}::uuid, 0, 'duplicate')
    `));
    expect(duplicateIdentity?.code).toBe('23505');
    for (const [column, value] of Object.entries(ids)) {
      const dbColumn = column === 'command' ? sql.raw('command_id') : column === 'script' ? sql.raw('script_execution_id') : sql.raw('deployment_result_id');
      const error = await causeOf(() => getTestDb().execute(sql`
        INSERT INTO automation_action_results (run_id, device_id, org_id, action_index, action_type, ${dbColumn})
        VALUES (${f.run.id}::uuid, ${f.deviceA.id}::uuid, ${f.orgA.id}::uuid, ${10 + Object.keys(ids).indexOf(column)}, 'duplicate-correlation', ${value}::uuid)
      `));
      expect(error?.code).toBe('23505');
    }
  });

  runDb('keeps dispatch monotonic, correlation immutable, and permits only real evidence over a reaper timeout', async () => {
    const f = await fixture(1);
    const commandId = randomUUID();
    const scriptExecutionId = randomUUID();
    await seedAutomationActionResults({ runId: f.run.id, device: f.deviceA, actions: f.actions });
    expect(await recordAutomationActionDispatch({ runId: f.run.id, deviceId: f.deviceA.id, actionIndex: 0, status: 'queued', commandId, scriptExecutionId })).toBe(true);
    expect(await recordAutomationActionDispatch({ runId: f.run.id, deviceId: f.deviceA.id, actionIndex: 0, status: 'running' })).toBe(true);
    expect(await recordAutomationActionDispatch({ runId: f.run.id, deviceId: f.deviceA.id, actionIndex: 0, status: 'queued' })).toBe(false);
    expect(await recordAutomationActionDispatch({ runId: f.run.id, deviceId: f.deviceA.id, actionIndex: 0, status: 'running', commandId: randomUUID() })).toBe(false);
    expect(await applyAutomationActionTerminal({ source: 'reaper', commandId, terminalStatus: 'timed_out', error: 'expired', completedAt: new Date() })).toBe(true);
    expect(await applyAutomationActionTerminal({ source: 'timeout', commandId, terminalStatus: 'failed', completedAt: new Date() })).toBe(false);
    expect(await applyAutomationActionTerminal({ source: 'script_execution', scriptExecutionId, terminalStatus: 'succeeded', output: 'already redacted', completedAt: new Date() })).toBe(true);
    expect(await applyAutomationActionTerminal({ source: 'command', commandId, terminalStatus: 'failed', completedAt: new Date() })).toBe(false);
  });

  runDb('repairs the terminal parent from a provisional reaper timeout when late real evidence succeeds', async () => {
    publishEventMock.mockClear();
    const f = await fixture(1);
    const commandId = randomUUID();
    const scriptExecutionId = randomUUID();
    await seedAutomationActionResults({ runId: f.run.id, device: f.deviceA, actions: f.actions });
    await recordAutomationActionDispatch({
      runId: f.run.id,
      deviceId: f.deviceA.id,
      actionIndex: 0,
      status: 'running',
      commandId,
      scriptExecutionId,
    });
    await applyAutomationActionTerminal({
      source: 'reaper',
      commandId,
      terminalStatus: 'timed_out',
      completedAt: new Date(),
    });
    expect(await getTestDb().select().from(automationRuns).where(eq(automationRuns.id, f.run.id)))
      .toEqual([expect.objectContaining({ status: 'failed', devicesSucceeded: 0, devicesFailed: 1 })]);
    expect(await getTestDb().select().from(automationRunDeviceResults).where(eq(automationRunDeviceResults.runId, f.run.id)))
      .toEqual([expect.objectContaining({ status: 'failed' })]);

    publishEventMock.mockClear();
    expect(await applyAutomationActionTerminal({
      source: 'script_execution',
      scriptExecutionId,
      terminalStatus: 'succeeded',
      completedAt: new Date(),
    })).toBe(true);
    expect(await getTestDb().select().from(automationRuns).where(eq(automationRuns.id, f.run.id)))
      .toEqual([expect.objectContaining({ status: 'completed', devicesSucceeded: 1, devicesFailed: 0 })]);
    expect(await getTestDb().select().from(automationRunDeviceResults).where(eq(automationRunDeviceResults.runId, f.run.id)))
      .toEqual([expect.objectContaining({ status: 'success' })]);
    expect(publishEventMock).toHaveBeenCalledTimes(1);
    expect(await applyAutomationActionTerminal({
      source: 'script_execution',
      scriptExecutionId,
      terminalStatus: 'succeeded',
      completedAt: new Date(),
    })).toBe(false);
    expect(publishEventMock).toHaveBeenCalledTimes(1);
  });

  runDb('serializes concurrent last-action reconciliation and publishes one terminal event', async () => {
    publishEventMock.mockClear();
    const f = await fixture(2);
    const commandA = randomUUID();
    const commandB = randomUUID();
    await seedAutomationActionResults({ runId: f.run.id, device: f.deviceA, actions: f.actions });
    await recordAutomationActionDispatch({ runId: f.run.id, deviceId: f.deviceA.id, actionIndex: 0, status: 'running', commandId: commandA });
    await recordAutomationActionDispatch({ runId: f.run.id, deviceId: f.deviceA.id, actionIndex: 1, status: 'running', commandId: commandB });
    const applied = await Promise.all([
      applyAutomationActionTerminal({ source: 'command', commandId: commandA, terminalStatus: 'succeeded', completedAt: new Date() }),
      applyAutomationActionTerminal({ source: 'command', commandId: commandB, terminalStatus: 'succeeded', completedAt: new Date() }),
    ]);
    expect(applied).toEqual([true, true]);
    const [run] = await getTestDb().select().from(automationRuns).where(eq(automationRuns.id, f.run.id));
    const [device] = await getTestDb().select().from(automationRunDeviceResults).where(eq(automationRunDeviceResults.runId, f.run.id));
    expect(run).toMatchObject({ status: 'completed', devicesSucceeded: 1, devicesFailed: 0 });
    expect(run?.completedAt).not.toBeNull();
    expect(device).toMatchObject({ status: 'success' });
    expect(publishEventMock).toHaveBeenCalledTimes(1);
    await reconcileAutomationRun(f.run.id);
    expect(publishEventMock).toHaveBeenCalledTimes(1);
  });

  runDb('makes duplicate terminal races idempotent and publishes once', async () => {
    publishEventMock.mockClear();
    const f = await fixture(1);
    const commandId = randomUUID();
    await seedAutomationActionResults({ runId: f.run.id, device: f.deviceA, actions: f.actions });
    await recordAutomationActionDispatch({ runId: f.run.id, deviceId: f.deviceA.id, actionIndex: 0, status: 'running', commandId });
    const event = { source: 'command' as const, commandId, terminalStatus: 'succeeded' as const, completedAt: new Date() };
    const outcomes = await Promise.all([
      applyAutomationActionTerminal(event),
      applyAutomationActionTerminal(event),
    ]);
    expect(outcomes.sort()).toEqual([false, true]);
    expect(publishEventMock).toHaveBeenCalledTimes(1);
  });

  runDb('serializes seeding against a concurrent device move and rejects the stale org stamp', async () => {
    const f = await fixture(1);
    let moved!: () => void;
    const moveStarted = new Promise<void>((resolve) => { moved = resolve; });
    let release!: () => void;
    const allowCommit = new Promise<void>((resolve) => { release = resolve; });
    const move = getTestDb().transaction(async (tx) => {
      await tx.update(devices).set({ orgId: f.orgB.id, siteId: f.siteB.id }).where(eq(devices.id, f.deviceA.id));
      moved();
      await allowCommit;
    });
    await moveStarted;
    const seed = seedAutomationActionResults({ runId: f.run.id, device: f.deviceA, actions: f.actions });
    release();
    await move;
    await expect(seed).rejects.toThrow(/organization mismatch/i);
    const rows = await getTestDb().execute(sql`
      SELECT id FROM automation_action_results WHERE device_id = ${f.deviceA.id}::uuid
    `);
    expect(rows).toHaveLength(0);
  });

  runDb('leaves legacy no-action runs untouched and treats all-skipped as completed with zero counters', async () => {
    publishEventMock.mockClear();
    const legacy = await fixture(0);
    await reconcileAutomationRun(legacy.run.id);
    let [run] = await getTestDb().select().from(automationRuns).where(eq(automationRuns.id, legacy.run.id));
    expect(run).toMatchObject({ status: 'running', devicesSucceeded: 0, devicesFailed: 0 });
    expect(publishEventMock).not.toHaveBeenCalled();

    const skipped = await fixture(2);
    await seedAutomationActionResults({ runId: skipped.run.id, device: skipped.deviceA, actions: skipped.actions });
    expect(await recordAutomationActionDispatch({ runId: skipped.run.id, deviceId: skipped.deviceA.id, actionIndex: 0, status: 'skipped', message: 'not reached' })).toBe(true);
    expect(await recordAutomationActionDispatch({ runId: skipped.run.id, deviceId: skipped.deviceA.id, actionIndex: 1, status: 'skipped', message: 'not reached' })).toBe(true);
    [run] = await getTestDb().select().from(automationRuns).where(eq(automationRuns.id, skipped.run.id));
    expect(run).toMatchObject({ status: 'completed', devicesSucceeded: 0, devicesFailed: 0 });
  });

  runDb('cascades device deletion and restamps the action row when a device moves org', async () => {
    const moved = await fixture(1);
    await seedAutomationActionResults({ runId: moved.run.id, device: moved.deviceA, actions: moved.actions });
    await withSystemDbAccessContext(() => db.execute(sql`
      UPDATE devices SET org_id = ${moved.orgB.id}::uuid, site_id = ${moved.siteB.id}::uuid
      WHERE id = ${moved.deviceA.id}::uuid
    `));
    let rows = await getTestDb().execute(sql`SELECT org_id FROM automation_action_results WHERE device_id = ${moved.deviceA.id}::uuid`) as unknown as Array<{ org_id: string }>;
    expect(rows[0]?.org_id).toBe(moved.orgB.id);
    await getTestDb().delete(devices).where(eq(devices.id, moved.deviceA.id));
    rows = await getTestDb().execute(sql`SELECT org_id FROM automation_action_results WHERE device_id = ${moved.deviceA.id}::uuid`) as unknown as Array<{ org_id: string }>;
    expect(rows).toHaveLength(0);
  });

  runDb('participates in real org erasure', async () => {
    const f = await fixture(1);
    await seedAutomationActionResults({ runId: f.run.id, device: f.deviceA, actions: f.actions });
    // Model the partner-wide run this direct-org child is specifically built
    // to support. The run survives one member-org erasure; its org-stamped
    // action row must not.
    await getTestDb().update(automations).set({ orgId: null, partnerId: f.partnerA.id })
      .where(eq(automations.id, f.automation.id));
    const stats = await cascadeDeleteOrg(f.orgA.id, randomUUID(), 'automation-action-results@test.invalid');
    expect(stats.tablesDeleted.automation_action_results).toBe(1);
    const rows = await getTestDb().execute(sql`
      SELECT id FROM automation_action_results WHERE org_id = ${f.orgA.id}::uuid
    `);
    expect(rows).toHaveLength(0);
  });
});
