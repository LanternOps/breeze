/**
 * #7279 — a real agent result that arrives after a server sweep already
 * terminalised the execution reconciles the fix attempt riding on it.
 *
 * Before: the reaper stamps the execution failed (no response, or never
 * delivered on its delivery clock), the inline hook counts the attempt as
 * failed (or inconclusive), and the agent's late result — recovered onto the
 * execution by the #3607 path — never reached the attempt, because the hook's
 * CAS only matches `state = 'pending'`. A fix that worked stayed a failure in
 * partner-wide fix memory.
 *
 * Real handlers (agent WS ingest, the reaper's propagation, the sweeper's
 * recount) against real Postgres, asserting what lands in fix_outcomes and
 * fix_memory, plus the race between the reconcile and a concurrent recount
 * holding the outcome row.
 */
import './setup';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { getTestDb } from './setup';
import { setupTestEnvironment } from './db-utils';
import { alerts, deviceCommands, devices, fixMemory, fixOutcomes, scriptExecutions, scripts, scriptVersions } from '../../db/schema';
import { createAgentWsHandlers } from '../../routes/agentWs';
import { commandsRoutes } from '../../routes/agents/commands';
import { propagateTimedOutDeviceCommand } from '../../jobs/staleCommandReaper';
import { advanceOutcome } from '../../services/fixMemory/outcomeWatcher';
import { recomputeForOutcome, recountRequestedOutcomeIds } from '../../services/fixMemory/store';

const H = 3_600_000;
const sys = <T>(fn: () => Promise<T>) => withSystemDbAccessContext(fn);

const fakeWs = { send: () => {} } as unknown as Parameters<ReturnType<typeof createAgentWsHandlers>['onMessage']>[1];

interface Run {
  orgId: string; partnerId: string; siteId: string; deviceId: string; agentId: string;
  alertId: string; executionId: string; commandId: string; outcomeId: string; fixIdentity: string;
}

/** A fix attempt in flight: exit-code alert, a delivered script run, a pending outcome. */
async function seedRun(): Promise<Run> {
  const env = await setupTestEnvironment();
  const tdb = getTestDb();
  const agentId = `agent-7279-${randomUUID().slice(0, 8)}`;
  const [device] = await tdb.insert(devices).values({
    orgId: env.organization.id, siteId: env.site.id, agentId, hostname: `late-fix-${agentId}`,
    osType: 'windows', osVersion: '11', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online', enrolledAt: new Date(),
  }).returning({ id: devices.id });
  const content = 'Restart-Service Spooler';
  const [script] = await tdb.insert(scripts).values({
    orgId: env.organization.id, name: `late-fix-${agentId}`, osTypes: ['windows'], language: 'powershell', content,
  }).returning({ id: scripts.id });
  const [version] = await tdb.insert(scriptVersions).values({
    scriptId: script!.id, version: 1, content, language: 'powershell', timeoutSeconds: 300, runAs: 'system',
    contentDigest: createHash('sha256').update(content).digest('hex'),
  }).returning({ id: scriptVersions.id });
  const [alert] = await tdb.insert(alerts).values({
    orgId: env.organization.id, deviceId: device!.id, severity: 'high', title: 'exit 3',
    triggeredAt: new Date(Date.now() - H), context: { source: 'script_exit_code', scriptId: script!.id, exitCode: 3 },
  }).returning({ id: alerts.id });
  const [execution] = await tdb.insert(scriptExecutions).values({
    scriptId: script!.id, scriptVersionId: version!.id, deviceId: device!.id, orgId: env.organization.id,
    triggerType: 'manual', status: 'running', startedAt: new Date(Date.now() - 10 * 60_000),
  }).returning({ id: scriptExecutions.id });
  const [command] = await tdb.insert(deviceCommands).values({
    deviceId: device!.id, type: 'script', targetRole: 'agent', status: 'sent', executedAt: new Date(Date.now() - 10 * 60_000),
    payload: { executionId: execution!.id, scriptId: script!.id },
  }).returning({ id: deviceCommands.id });
  const fixIdentity = `script_version:${version!.id}`;
  const [outcome] = await tdb.insert(fixOutcomes).values({
    orgId: env.organization.id, partnerId: env.partner.id, deviceId: device!.id, sourceType: 'alert',
    sourceId: alert!.id, alertId: alert!.id, fixKind: 'org_script', fixIdentity, scriptId: script!.id,
    scriptVersionId: version!.id, scriptExecutionId: execution!.id, state: 'pending', deadlineAt: new Date(Date.now() + 24 * H),
    createdAt: new Date(Date.now() - 11 * 60_000),
  }).returning({ id: fixOutcomes.id });
  return {
    orgId: env.organization.id, partnerId: env.partner.id, siteId: env.site.id, deviceId: device!.id, agentId,
    alertId: alert!.id, executionId: execution!.id, commandId: command!.id, outcomeId: outcome!.id, fixIdentity,
  };
}

/** What reapStaleDeviceCommands writes, then its propagation (the inline fix-outcome hook included). */
async function reap(run: Run, clock: 'timeout' | 'delivery'): Promise<void> {
  const completedAt = new Date();
  const result = clock === 'delivery'
    ? { status: 'timeout', reason: 'not_delivered_before_deadline', clock: 'delivery', error: 'never delivered', timedOutBy: 'server' }
    : { status: 'timeout', error: 'Server-side timeout: no response from agent', timedOutBy: 'server' };
  await sys(() => db.update(deviceCommands).set({ status: 'failed', completedAt, result }).where(eq(deviceCommands.id, run.commandId)));
  await sys(() => propagateTimedOutDeviceCommand({
    commandId: run.commandId, payload: { executionId: run.executionId }, errorMsg: result.error, completedAt,
    kind: clock === 'delivery' ? 'expired' : 'timeout', commandType: 'script', deviceId: run.deviceId,
  }));
}

/** The agent's real result frame, through the real WS ingest. */
async function lateResult(run: Run, body: Record<string, unknown>): Promise<void> {
  const handlers = createAgentWsHandlers(run.agentId, {
    agentId: run.agentId, siteId: run.siteId, installIncarnation: 1, deviceId: run.deviceId, orgId: run.orgId, partnerId: run.partnerId,
  });
  await handlers.onOpen({}, fakeWs);
  await handlers.onMessage({ data: JSON.stringify({ type: 'command_result', commandId: run.commandId, ...body }) } as MessageEvent, fakeWs);
  await handlers.onClose({}, fakeWs);
}

/**
 * The same result through the HTTP fallback route. Only the credential half of
 * agentAuthMiddleware is stubbed; its request-long org DB context is
 * reproduced, because the shared result handler writes under it.
 */
async function lateHttpResult(run: Run, body: Record<string, unknown>): Promise<void> {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('agent', {
      installIncarnation: 1, deviceId: run.deviceId, agentId: run.agentId, orgId: run.orgId,
      partnerId: run.partnerId, siteId: run.siteId, role: 'agent',
    });
    await withDbAccessContext({
      scope: 'organization', orgId: run.orgId, accessibleOrgIds: [run.orgId], accessiblePartnerIds: [], currentPartnerId: null,
    }, async () => { await next(); });
  });
  app.route('/agents', commandsRoutes);
  const res = await app.request(`/agents/${run.agentId}/commands/${run.commandId}/result`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}

/** The sweeper's recount pass, for this run's outcome only. */
async function recount(run: Run): Promise<void> {
  const ids = await sys(() => recountRequestedOutcomeIds(10_000));
  if (ids.includes(run.outcomeId)) await sys(() => recomputeForOutcome(run.outcomeId));
}

const outcome = async (run: Run) => (await sys(() => db.select().from(fixOutcomes).where(eq(fixOutcomes.id, run.outcomeId))))[0]!;
const memory = async (run: Run) => sys(() => db.select().from(fixMemory).where(eq(fixMemory.orgId, run.orgId)));

function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait: () => wait, open: () => open() };
}

/** The backend pid of the transaction this runs in. */
async function backendPid(): Promise<number> {
  const [row] = [...await db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)];
  return Number(row!.pid);
}

/** Polls until some client backend is waiting on a lock HELD BY `holderPid` (or `p` settles). */
async function blockedBy(holderPid: number, p: Promise<unknown>, timeoutMs = 15_000): Promise<boolean> {
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  const deadline = Date.now() + timeoutMs;
  while (!settled && Date.now() < deadline) {
    const rows = await getTestDb().execute<{ pid: number }>(sql`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND backend_type = 'client backend'
        AND ${holderPid}::int = ANY(pg_blocking_pids(pid))`);
    if ([...rows].length > 0) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  if (!settled) throw new Error('blockedBy: the writer neither blocked nor settled');
  return false;
}

describe('late agent results reconcile the fix attempt (#7279)', () => {
  it('a real success after the reaper timed the run out re-opens the attempt and un-counts the failure', async () => {
    const run = await seedRun();
    await reap(run, 'timeout');
    expect(await outcome(run)).toMatchObject({ state: 'failed', stateReason: 'script_failed' });
    await recount(run);
    expect(await memory(run)).toEqual([expect.objectContaining({ attempts: 1, failedCount: 1 })]);

    await lateResult(run, { status: 'completed', exitCode: 0, stdout: 'Spooler restarted' });

    const [execution] = await getTestDb().select().from(scriptExecutions).where(eq(scriptExecutions.id, run.executionId));
    expect(execution).toMatchObject({ status: 'completed', exitCode: 0 });
    const reopened = await outcome(run);
    expect(reopened).toMatchObject({
      state: 'awaiting_recovery', stateReason: 'script_succeeded_late', countedAt: null, terminalAt: null,
    });
    expect(reopened.recountRequestedAt).toBeInstanceOf(Date);
    // The recovery window opens at the late completion, not at the reaper's verdict.
    expect(Math.abs(reopened.deadlineAt.getTime() - (execution!.completedAt!.getTime() + 24 * H))).toBeLessThan(1_000);

    // The sweeper's recount drops the failure it had counted, and clears the request.
    await recount(run);
    expect(await memory(run)).toEqual([]);
    expect((await outcome(run)).recountRequestedAt).toBeNull();

    // From here the attempt follows the ordinary lifecycle.
    await sys(() => db.update(alerts).set({ status: 'resolved', resolvedAt: new Date(), resolutionReason: 'condition_cleared' })
      .where(eq(alerts.id, run.alertId)));
    expect(await advanceOutcome(run.outcomeId)).toBe('holding');
  });

  it('a script that did run after a delivery-clock expiry is reconciled from inconclusive (item 2)', async () => {
    const run = await seedRun();
    await reap(run, 'delivery');
    expect(await outcome(run)).toMatchObject({ state: 'inconclusive', stateReason: 'script_never_delivered' });

    await lateResult(run, { status: 'completed', exitCode: 0, stdout: 'ran after all' });

    expect(await outcome(run)).toMatchObject({ state: 'awaiting_recovery', stateReason: 'script_succeeded_late', countedAt: null });
  });

  it('a real failure after a delivery-clock expiry becomes a counted failed attempt', async () => {
    const run = await seedRun();
    await reap(run, 'delivery');
    await recount(run);
    expect(await memory(run)).toEqual([]); // inconclusive never counts

    await lateResult(run, { status: 'completed', exitCode: 3, stdout: 'still broken' });

    const row = await outcome(run);
    expect(row).toMatchObject({ state: 'failed', stateReason: 'script_failed' });
    expect(row.countedAt).toBeInstanceOf(Date);
    await recount(run);
    expect(await memory(run)).toEqual([expect.objectContaining({ attempts: 1, failedCount: 1 })]);
  });

  it('a real failure after a timeout leaves the counted failure as it is', async () => {
    const run = await seedRun();
    await reap(run, 'timeout');
    const before = await outcome(run);

    await lateResult(run, { status: 'completed', exitCode: 3, stdout: 'still broken' });

    const after = await outcome(run);
    expect(after).toMatchObject({ state: 'failed', stateReason: 'script_failed' });
    expect(after.terminalAt?.getTime()).toBe(before.terminalAt!.getTime());
  });

  it('reconciles the same way when the late result arrives over the HTTP fallback', async () => {
    const run = await seedRun();
    await reap(run, 'timeout');

    await lateHttpResult(run, { status: 'completed', exitCode: 0, stdout: 'Spooler restarted' });

    expect(await outcome(run)).toMatchObject({ state: 'awaiting_recovery', stateReason: 'script_succeeded_late', countedAt: null });
  });

  it('never touches an attempt whose verdict was not the sweep\'s guess', async () => {
    const run = await seedRun();
    await reap(run, 'timeout');
    // Something else decided this attempt since (e.g. the condition persisted past its window).
    await sys(() => db.update(fixOutcomes).set({ stateReason: 'condition_persisted' }).where(eq(fixOutcomes.id, run.outcomeId)));
    const before = await outcome(run);

    await lateResult(run, { status: 'completed', exitCode: 0, stdout: 'Spooler restarted' });

    const after = await outcome(run);
    expect(after).toMatchObject({ state: 'failed', stateReason: 'condition_persisted' });
    expect(after.countedAt?.getTime()).toBe(before.countedAt!.getTime());
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it('a recount of an uncounted attempt with no resolvable signature clears its request instead of spinning', async () => {
    const run = await seedRun();
    // monitor_recurrence alerts have no v1 signature, so fillOutcomeSignature leaves the row unsigned.
    const [unsignable] = await getTestDb().insert(alerts).values({
      orgId: run.orgId, deviceId: run.deviceId, severity: 'high', title: 'unsignable', context: { source: 'monitor_recurrence' },
    }).returning({ id: alerts.id });
    await sys(() => db.update(fixOutcomes).set({
      sourceId: unsignable!.id, alertId: unsignable!.id, state: 'awaiting_recovery', recountRequestedAt: new Date(),
    }).where(eq(fixOutcomes.id, run.outcomeId)));
    expect(await sys(() => recountRequestedOutcomeIds(10_000))).toContain(run.outcomeId);

    await sys(() => recomputeForOutcome(run.outcomeId));

    expect(await outcome(run)).toMatchObject({ state: 'awaiting_recovery', signatureKey: null, recountRequestedAt: null });
    expect(await sys(() => recountRequestedOutcomeIds(10_000))).not.toContain(run.outcomeId);
  });

  it('a duplicate late frame changes nothing more', async () => {
    const run = await seedRun();
    await reap(run, 'timeout');
    await lateResult(run, { status: 'completed', exitCode: 0, stdout: 'Spooler restarted' });
    await recount(run);
    const once = await outcome(run);

    await lateResult(run, { status: 'completed', exitCode: 0, stdout: 'Spooler restarted' });

    const twice = await outcome(run);
    expect(twice).toMatchObject({ state: 'awaiting_recovery', countedAt: null, recountRequestedAt: null });
    expect(twice.updatedAt.getTime()).toBe(once.updatedAt.getTime());
  });

  it('a reconcile that waits on a concurrent recount of the same attempt still lands, and the next recount drops the count', async () => {
    const run = await seedRun();
    await reap(run, 'timeout');
    const reached = gate();
    const release = gate();
    let holderPid = 0;
    // The sweeper's recount holds the outcome row (FOR UPDATE) mid-recompute.
    const recountTx = sys(() => recomputeForOutcome(run.outcomeId, new Date(), {
      afterRecompute: async () => { holderPid = await backendPid(); reached.open(); await release.wait(); },
    }));
    await Promise.race([reached.wait(), recountTx.then(() => { throw new Error('recount ended before its gate'); })]);

    const ingest = lateResult(run, { status: 'completed', exitCode: 0, stdout: 'Spooler restarted' });
    let blocked = false;
    try {
      blocked = await blockedBy(holderPid, ingest);
    } finally {
      // Always release the holder and let both settle, so a failure here never strands a transaction.
      release.open();
      await Promise.allSettled([recountTx, ingest]);
    }
    await recountTx;
    await ingest;
    // The ingest really waited on THE RECOUNT's lock, or this test proves nothing.
    expect(blocked).toBe(true);

    // The recount committed a failed count; the reconcile re-evaluated against
    // that committed row and still re-opened it, leaving a request behind.
    expect(await memory(run)).toEqual([expect.objectContaining({ attempts: 1, failedCount: 1 })]);
    const reopened = await outcome(run);
    expect(reopened).toMatchObject({ state: 'awaiting_recovery', countedAt: null });
    expect(reopened.recountRequestedAt).toBeInstanceOf(Date);
    await recount(run);
    expect(await memory(run)).toEqual([]);
  });
});
