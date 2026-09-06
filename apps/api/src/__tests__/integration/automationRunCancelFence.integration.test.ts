import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  automationActionResults,
  automationRunDeviceResults,
  automationRuns,
  automations,
  deviceCommands,
  devices,
  scriptExecutions,
  scripts,
} from '../../db/schema';
import {
  assertRunNotCancelled,
  cancelAutomationRun,
  RunCancelledError,
} from '../../services/automationRunCancellation';
import { seedAutomationActionResults } from '../../services/automationActionResults';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

/**
 * #3525 W05 (#4766) — the dispatch fence, against real PostgreSQL.
 *
 * A Drizzle mock cannot prove any of this: the whole contract is what two
 * CONCURRENT transactions do to each other. `cancelAutomationRun` takes
 * `FOR UPDATE` on the run row; every dispatcher takes `FOR SHARE` on it first.
 * The guarantee that buys is:
 *
 *   an execution belonging to a cancelled run is either already visible to the
 *   cancel's fan-out, or the dispatcher is refused before it creates one.
 *
 * Test 1 proves the first half by construction: the execution is created
 * inside a transaction that is still open when the cancel starts, so the
 * fan-out can only see it if the cancel genuinely waited on the row lock.
 */

const runDb = it.runIf(!!process.env.DATABASE_URL);
const delay = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function fixture(options: { runStatus?: 'running' | 'cancelled' } = {}) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const [device] = await getTestDb().insert(devices).values({
    orgId: org.id,
    siteId: site.id,
    agentId: `cancel-fence-${randomUUID()}`,
    hostname: 'cancel-fence-device',
    osType: 'linux',
    osVersion: '24.04',
    architecture: 'amd64',
    agentVersion: '1.0.0',
  }).returning({ id: devices.id, orgId: devices.orgId });
  const [script] = await getTestDb().insert(scripts).values({
    orgId: org.id,
    name: `cancel-fence-${randomUUID()}`,
    osTypes: ['linux'],
    language: 'bash',
    content: 'sleep 120',
    timeoutSeconds: 300,
  }).returning({ id: scripts.id });
  const [automation] = await getTestDb().insert(automations).values({
    orgId: org.id,
    name: `cancel-fence-${randomUUID()}`,
    trigger: { type: 'manual' },
    actions: [{ type: 'run_script', scriptId: script!.id }],
  }).returning({ id: automations.id });
  const [run] = await getTestDb().insert(automationRuns).values({
    automationId: automation!.id,
    triggeredBy: 'cancel-fence-integration',
    devicesTargeted: 1,
    status: options.runStatus ?? 'running',
  }).returning({ id: automationRuns.id });
  return { org, device: device!, script: script!, automation: automation!, run: run! };
}

/**
 * A `script_executions` row plus the paired PENDING `script` command that
 * `cancelScriptExecution` retracts. Retraction is the one cancellation outcome
 * that needs no agent, so the sweep resolves deterministically here.
 */
async function insertDispatchedExecution(
  db: ReturnType<typeof getTestDb>,
  f: Awaited<ReturnType<typeof fixture>>,
) {
  const [execution] = await db.insert(scriptExecutions).values({
    scriptId: f.script.id,
    deviceId: f.device.id,
    orgId: f.org.id,
    automationRunId: f.run.id,
    status: 'pending',
  }).returning({ id: scriptExecutions.id });
  await db.insert(deviceCommands).values({
    deviceId: f.device.id,
    type: 'script',
    payload: { executionId: execution!.id },
    status: 'pending',
  });
  return execution!.id;
}

describe('automation run cancel fence — real PostgreSQL', () => {
  runDb('a dispatch holding FOR SHARE blocks the cancel, and its execution is caught by the fan-out', async () => {
    const f = await fixture();

    let dispatchCommittedAt = 0;
    let cancelReturnedAt = 0;

    // The dispatcher: fence first, then create the execution, then linger.
    // Nothing it wrote is visible to any other connection until it commits.
    const dispatch = getTestDb().transaction(async (tx) => {
      await assertRunNotCancelled(tx, f.run.id);
      await insertDispatchedExecution(tx as unknown as ReturnType<typeof getTestDb>, f);
      await delay(600);
      dispatchCommittedAt = Date.now();
    });

    // Start the cancel while the dispatcher still holds the lock.
    await delay(120);
    const cancel = (async () => {
      const outcome = await cancelAutomationRun({
        runId: f.run.id,
        actorId: null,
        actorLabel: 'fence-integration',
      });
      cancelReturnedAt = Date.now();
      return outcome;
    })();

    const [, outcome] = await Promise.all([dispatch, cancel]);

    expect(outcome).toMatchObject({ kind: 'cancelled' });
    // The cancel could not have returned before the dispatcher committed:
    // its FOR UPDATE queued behind the dispatcher's FOR SHARE.
    expect(cancelReturnedAt).toBeGreaterThanOrEqual(dispatchCommittedAt);

    // The substantive proof. Had the cancel NOT waited, its fan-out would have
    // read the executions table while this row was still invisible, and the
    // script would be running on the device with the run labelled cancelled.
    const [execution] = await getTestDb()
      .select({ status: scriptExecutions.status, cancelState: scriptExecutions.cancelState })
      .from(scriptExecutions)
      .where(eq(scriptExecutions.automationRunId, f.run.id));
    expect(execution).toMatchObject({ status: 'cancelled', cancelState: 'confirmed' });
  }, 30_000);

  runDb('a dispatch that starts after the cancel commits is refused', async () => {
    const f = await fixture();
    await cancelAutomationRun({ runId: f.run.id, actorId: null, actorLabel: 'fence-integration' });

    await expect(
      getTestDb().transaction((tx) => assertRunNotCancelled(tx, f.run.id)),
    ).rejects.toBeInstanceOf(RunCancelledError);

    // And a run that is merely finished, or gone, is not a fence trip.
    const other = await fixture();
    await expect(
      getTestDb().transaction((tx) => assertRunNotCancelled(tx, other.run.id)),
    ).resolves.toBeUndefined();
    await expect(
      getTestDb().transaction((tx) => assertRunNotCancelled(tx, randomUUID())),
    ).resolves.toBeUndefined();
  }, 30_000);

  runDb('creates ZERO new child rows after the fence commits', async () => {
    const f = await fixture();
    await seedAutomationActionResults({
      runId: f.run.id,
      device: { id: f.device.id, orgId: f.org.id },
      actions: [{ actionIndex: 0, actionType: 'run_script' }],
    });
    await getTestDb().insert(automationRunDeviceResults).values({
      runId: f.run.id,
      deviceId: f.device.id,
      orgId: f.org.id,
      status: 'pending',
    });

    const countChildren = async () => {
      const [row] = await getTestDb().execute(sql`
        SELECT
          (SELECT count(*) FROM automation_action_results WHERE run_id = ${f.run.id}::uuid) AS actions,
          (SELECT count(*) FROM automation_run_device_results WHERE run_id = ${f.run.id}::uuid) AS device_results,
          (SELECT count(*) FROM script_executions WHERE automation_run_id = ${f.run.id}::uuid) AS executions
      `) as unknown as Array<{ actions: string; device_results: string; executions: string }>;
      return row!;
    };
    const before = await countChildren();

    await cancelAutomationRun({ runId: f.run.id, actorId: null, actorLabel: 'fence-integration' });

    // Every dispatch entry point now refuses. Seeding a further device, or
    // dispatching another action, is exactly what the fence forbids.
    await expect(
      getTestDb().transaction((tx) => assertRunNotCancelled(tx, f.run.id)),
    ).rejects.toBeInstanceOf(RunCancelledError);

    const after = await countChildren();
    expect(after).toEqual(before);
  }, 30_000);

  runDb('terminalises never-dispatched actions, counts only proven stops, and never re-opens the run', async () => {
    const f = await fixture();
    await seedAutomationActionResults({
      runId: f.run.id,
      device: { id: f.device.id, orgId: f.org.id },
      actions: [{ actionIndex: 0, actionType: 'run_script' }],
    });
    await getTestDb().insert(automationRunDeviceResults).values({
      runId: f.run.id,
      deviceId: f.device.id,
      orgId: f.org.id,
      status: 'pending',
    });

    const outcome = await cancelAutomationRun({
      runId: f.run.id,
      actorId: null,
      actorLabel: 'tech@example.com',
    });
    expect(outcome).toMatchObject({ kind: 'cancelled', actionsCancelled: 1 });

    const [action] = await getTestDb()
      .select({ status: automationActionResults.status, terminalSource: automationActionResults.terminalSource })
      .from(automationActionResults)
      .where(eq(automationActionResults.runId, f.run.id));
    expect(action).toMatchObject({ status: 'cancelled', terminalSource: 'cancellation' });

    const [deviceResult] = await getTestDb()
      .select({ status: automationRunDeviceResults.status })
      .from(automationRunDeviceResults)
      .where(eq(automationRunDeviceResults.runId, f.run.id));
    expect(deviceResult).toMatchObject({ status: 'cancelled' });

    const [run] = await getTestDb()
      .select({
        status: automationRuns.status,
        devicesCancelled: automationRuns.devicesCancelled,
        devicesFailed: automationRuns.devicesFailed,
        completedAt: automationRuns.completedAt,
        logs: automationRuns.logs,
      })
      .from(automationRuns)
      .where(eq(automationRuns.id, f.run.id));
    expect(run).toMatchObject({ status: 'cancelled', devicesCancelled: 1, devicesFailed: 0 });
    expect(run!.completedAt).not.toBeNull();
    // The log entry is appended with jsonb ||, naming who stopped it.
    expect(JSON.stringify(run!.logs)).toContain('tech@example.com');

    // Idempotent: a second cancel neither throws nor relabels.
    const again = await cancelAutomationRun({
      runId: f.run.id,
      actorId: null,
      actorLabel: 'tech@example.com',
    });
    expect(again).toMatchObject({ kind: 'cancelled', alreadyCancelling: true, actionsCancelled: 0 });
  }, 30_000);

  runDb('reports an in-flight deployment as uncancellable instead of claiming the run stopped', async () => {
    const f = await fixture();
    await seedAutomationActionResults({
      runId: f.run.id,
      device: { id: f.device.id, orgId: f.org.id },
      actions: [
        { actionIndex: 0, actionType: 'deploy_software' },
        { actionIndex: 1, actionType: 'run_script' },
      ],
    });
    await getTestDb().insert(automationRunDeviceResults).values({
      runId: f.run.id,
      deviceId: f.device.id,
      orgId: f.org.id,
      status: 'pending',
    });
    // Action 0 already reached the device; action 1 never did.
    await getTestDb().update(automationActionResults)
      .set({ status: 'running' })
      .where(and(
        eq(automationActionResults.runId, f.run.id),
        eq(automationActionResults.actionIndex, 0),
      ));

    const outcome = await cancelAutomationRun({
      runId: f.run.id,
      actorId: null,
      actorLabel: 'fence-integration',
    }) as Extract<Awaited<ReturnType<typeof cancelAutomationRun>>, { kind: 'cancelled' }>;

    expect(outcome.actionsCancelled).toBe(1);
    expect(outcome.uncancellableActions).toEqual([
      { actionIndex: 0, actionType: 'deploy_software', reason: expect.any(String) },
    ]);
  }, 30_000);

  runDb('finishes a run cancelled before any action row was ever seeded', async () => {
    // The shape of a cancel between enqueue and worker pickup. Reconciliation
    // derives everything from action rows and returns early when there are
    // none, so without the explicit stamp the run would read as permanently
    // in progress.
    const f = await fixture();

    const outcome = await cancelAutomationRun({
      runId: f.run.id,
      actorId: null,
      actorLabel: 'fence-integration',
    });
    expect(outcome).toMatchObject({ kind: 'cancelled', actionsCancelled: 0 });

    const [run] = await getTestDb()
      .select({ status: automationRuns.status, completedAt: automationRuns.completedAt })
      .from(automationRuns)
      .where(eq(automationRuns.id, f.run.id));
    expect(run).toMatchObject({ status: 'cancelled' });
    expect(run!.completedAt).not.toBeNull();
  }, 30_000);

  runDb('refuses to relabel a run that already finished on its own', async () => {
    const f = await fixture();
    await getTestDb().update(automationRuns)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(automationRuns.id, f.run.id));

    await expect(cancelAutomationRun({
      runId: f.run.id,
      actorId: null,
      actorLabel: 'fence-integration',
    })).resolves.toMatchObject({ kind: 'already_terminal', status: 'completed' });

    const [run] = await getTestDb()
      .select({ status: automationRuns.status })
      .from(automationRuns)
      .where(eq(automationRuns.id, f.run.id));
    expect(run).toMatchObject({ status: 'completed' });
  }, 30_000);
});
