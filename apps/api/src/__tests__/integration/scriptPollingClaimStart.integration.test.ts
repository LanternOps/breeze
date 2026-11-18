/**
 * #7279 — the HTTP polling claim records when a script execution started.
 *
 * The WebSocket push (scriptDispatch.ts) has always flipped an execution to
 * `running` with `started_at` = the claim timestamp once the frame is sent. A
 * command delivered in a heartbeat response (every queued run, whatever the
 * agent's transport) never did, so the fix-outcome watcher's "cleared before
 * the fix started" check fell back to dispatch time for it.
 *
 * Real Postgres, because the properties are about the CAS: the stamp lands
 * only on a row still waiting for delivery, never resurrects a row another
 * writer already drove terminal (including one that commits while the stamp
 * is blocked on its row lock), and a second delivery pass leaves the first
 * start time alone.
 */
import './setup';
import { randomUUID } from 'crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../../db';
import { getTestDb } from './setup';
import { deviceCommands, devices, scriptExecutions, scripts } from '../../db/schema';
import { createOrganization, createPartner, createSite, deviceAgentId } from './db-utils';
import { dispatchScriptToDevice } from '../../services/scriptDispatch';
import { claimPendingCommandsForDevice } from '../../services/commandDispatch';
import { prepareClaimedCommandsForDelivery } from '../../services/commandDelivery';

interface Scenario { orgId: string; deviceId: string; executionId: string; commandId: string }

async function seed(): Promise<Scenario> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const [device] = await getTestDb().insert(devices).values({
    orgId: org.id, siteId: site!.id, agentId: randomUUID(), hostname: `poll-start-${randomUUID().slice(0, 8)}`,
    osType: 'linux', osVersion: '24.04', architecture: 'x86_64', agentVersion: '0.0.0-test', status: 'online',
    enrolledAt: new Date(),
  }).returning();
  const [script] = await getTestDb().insert(scripts).values({
    orgId: org.id, name: `poll-start-${randomUUID().slice(0, 8)}`, osTypes: ['linux'], language: 'bash',
    content: '#!/bin/bash\necho ok', runAs: 'system', timeoutSeconds: 300,
  }).returning();
  const result = await withSystemDbAccessContext(() => dispatchScriptToDevice({
    // No agentId on the snapshot: the dispatch queues the command instead of
    // pushing it, so the heartbeat claim below is the delivery.
    device: {
      id: device!.id, orgId: device!.orgId, osType: device!.osType, status: device!.status,
      agentId: null as unknown as string, hostname: device!.hostname, siteId: device!.siteId,
      customFields: device!.customFields,
    },
    source: { kind: 'saved', script: script! },
    triggerType: 'manual',
  }));
  if (!result.ok || !result.executionId) throw new Error(`dispatch failed: ${JSON.stringify(result)}`);
  return { orgId: org.id, deviceId: device!.id, executionId: result.executionId, commandId: result.commandId };
}

const execution = async (id: string) =>
  (await getTestDb().select().from(scriptExecutions).where(eq(scriptExecutions.id, id)))[0]!;
const command = async (id: string) =>
  (await getTestDb().select().from(deviceCommands).where(eq(deviceCommands.id, id)))[0]!;

/** The heartbeat's claim + delivery pass, as routes/agents/commands.ts runs it. */
async function pollOnce(scn: Scenario) {
  const agentId = await deviceAgentId(scn.deviceId);
  return withSystemDbAccessContext(async () => {
    const claimed = await claimPendingCommandsForDevice({ deviceId: scn.deviceId, agentId, installIncarnation: 1 });
    return prepareClaimedCommandsForDelivery(claimed);
  });
}

function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait: () => wait, open: () => open() };
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

describe('polling claim records script start (#7279)', () => {
  let scn: Scenario;
  beforeEach(async () => { scn = await seed(); });

  it('marks a delivered execution running, started at the claim timestamp', async () => {
    expect((await execution(scn.executionId)).startedAt).toBeNull();

    const delivered = await pollOnce(scn);

    expect(delivered.map((c) => c.id)).toEqual([scn.commandId]);
    const cmd = await command(scn.commandId);
    expect(cmd.status).toBe('sent');
    const exec = await execution(scn.executionId);
    expect(exec.status).toBe('running');
    expect(exec.startedAt?.getTime()).toBe(cmd.executedAt!.getTime());
  });

  it('starts a run that sat queued for an offline device', async () => {
    await getTestDb().update(scriptExecutions).set({ status: 'queued' }).where(eq(scriptExecutions.id, scn.executionId));

    await pollOnce(scn);

    const exec = await execution(scn.executionId);
    expect(exec.status).toBe('running');
    expect(exec.startedAt).toBeInstanceOf(Date);
  });

  it('never resurrects an execution another writer already drove terminal', async () => {
    // A fast agent result (or a cancel) landed between the claim and the stamp.
    const agentId = await deviceAgentId(scn.deviceId);
    const delivered = await withSystemDbAccessContext(async () => {
      const claimed = await claimPendingCommandsForDevice({ deviceId: scn.deviceId, agentId, installIncarnation: 1 });
      await db.update(scriptExecutions).set({ status: 'completed', exitCode: 0, completedAt: new Date() })
        .where(eq(scriptExecutions.id, scn.executionId));
      return prepareClaimedCommandsForDelivery(claimed);
    });

    expect(delivered).toHaveLength(1);
    const exec = await execution(scn.executionId);
    expect(exec.status).toBe('completed');
    expect(exec.startedAt).toBeNull();
  });

  it('re-checks the CAS after waiting on a concurrent terminal write (no resurrection)', async () => {
    const held = gate();
    const reached = gate();
    let holderPid = 0;
    // Holds the execution row lock with an uncommitted terminal write.
    const terminal = withSystemDbAccessContext(() => db.transaction(async (tx) => {
      await tx.update(scriptExecutions).set({ status: 'failed', completedAt: new Date(), errorMessage: 'cancelled elsewhere' })
        .where(eq(scriptExecutions.id, scn.executionId));
      const [row] = [...await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)];
      holderPid = Number(row!.pid);
      reached.open();
      await held.wait();
    }));
    await Promise.race([reached.wait(), terminal.then(() => { throw new Error('terminal tx ended before its gate'); })]);

    const poll = pollOnce(scn);
    let blocked = false;
    try {
      blocked = await blockedBy(holderPid, poll);
    } finally {
      // Always release the lock holder and let both settle, so a failure never strands a transaction.
      held.open();
      await Promise.allSettled([terminal, poll]);
    }
    await terminal;
    const delivered = await poll;
    // The stamp must actually have waited on THE TERMINAL WRITER's row lock, or this test proves nothing.
    expect(blocked).toBe(true);

    expect(delivered).toHaveLength(1);
    const exec = await execution(scn.executionId);
    expect(exec.status).toBe('failed');
    expect(exec.startedAt).toBeNull();
  });

  it('is idempotent: a later delivery pass keeps the first start time', async () => {
    await pollOnce(scn);
    const first = (await execution(scn.executionId)).startedAt!;

    // Re-arm the command for a second claim (as a release would) with the
    // execution still running.
    await getTestDb().update(deviceCommands).set({ status: 'pending', executedAt: null })
      .where(eq(deviceCommands.id, scn.commandId));
    await new Promise((r) => setTimeout(r, 5));
    await pollOnce(scn);

    const exec = await execution(scn.executionId);
    expect(exec.status).toBe('running');
    expect(exec.startedAt?.getTime()).toBe(first.getTime());
    expect((await command(scn.commandId)).executedAt!.getTime()).not.toBe(first.getTime());
  });
});
