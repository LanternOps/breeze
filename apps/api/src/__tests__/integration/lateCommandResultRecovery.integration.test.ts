/**
 * Integration test — #3607: a result arriving after the 60s wait deadline must
 * NOT lose the agent's real output.
 *
 * The defect this pins is a lookup, not a race:
 *
 *   1. `waitForCommandResult(commandId, 60000)` gives up and terminalizes the
 *      `device_commands` row to `status:'failed'`, `result:{status:'timeout'}`.
 *   2. The agent's REAL result lands over the WS (or the HTTP fallback). The
 *      ingest lookup filtered on `status IN ('pending','sent')`, so it matched
 *      NO ROW — the handler never reached its compare-and-set, it branched into
 *      `processOrphanedCommandResult`, which handles only SNMP/discovery/tunnel.
 *   3. `handleScriptResult` — the only writer of stdout/stderr/exitCode onto
 *      `script_executions` — therefore never ran, and nothing ever re-read it.
 *
 * A mocked-db unit test cannot pin this: it would assert on a where-clause
 * shape and stay green with the fix deleted. These cases run the real handlers
 * against real Postgres and assert on what is actually IN the two tables.
 *
 * Covered:
 *   1. WS path — timed-out command + late success → stdout/exitCode land.
 *   2. WS path — a second copy of the same frame is still ignored (the CAS
 *      protection the widened predicate must not break).
 *   3. WS path — a genuinely cancelled command is NOT reopened.
 *   4. HTTP fallback path — same recovery (the duplicated constant in
 *      routes/agents/commands.ts).
 *   5. A `script_executions` row already stamped `timeout` by the stale reaper
 *      still receives the real output.
 */
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import './setup';
import { getTestDb } from './setup';
import { setupTestEnvironment } from './db-utils';
import { withDbAccessContext } from '../../db';
import { createAgentWsHandlers } from '../../routes/agentWs';
import { commandsRoutes } from '../../routes/agents/commands';
import { updateRestoreJobFromResult } from '../../services/restoreResultPersistence';
import {
  devices,
  deviceCommands,
  scripts,
  scriptExecutions,
  backupConfigs,
  backupJobs,
  backupSnapshots,
  restoreJobs,
} from '../../db/schema';

const runDb = it.runIf(!!process.env.DATABASE_URL);

/** Minimal WSContext stand-in — the command-result path only ever calls send(). */
const fakeWs = { send: () => {} } as unknown as Parameters<
  ReturnType<typeof createAgentWsHandlers>['onMessage']
>[1];

interface Fixture {
  orgId: string;
  partnerId: string;
  siteId: string;
  deviceId: string;
  agentId: string;
  userId: string;
  scriptId: string;
}

async function makeFixture(): Promise<Fixture> {
  const env = await setupTestEnvironment();
  const tdb = getTestDb();
  const agentId = `agent-3607-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const [device] = await tdb
    .insert(devices)
    .values({
      orgId: env.organization.id,
      siteId: env.site.id,
      agentId,
      hostname: `late-result-${agentId}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });
  if (!device) throw new Error('makeFixture: no device');

  const [script] = await tdb
    .insert(scripts)
    .values({
      orgId: env.organization.id,
      name: `late-result-script-${agentId}`,
      osTypes: ['windows'],
      language: 'powershell',
      content: 'Start-Sleep -Seconds 120; Write-Output "slow but fine"',
    })
    .returning({ id: scripts.id });
  if (!script) throw new Error('makeFixture: no script');

  return {
    orgId: env.organization.id,
    partnerId: env.partner.id,
    siteId: env.site.id,
    deviceId: device.id,
    agentId,
    userId: env.user.id,
    scriptId: script.id,
  };
}

/**
 * Seed the exact post-deadline state: a `script_executions` row still waiting
 * for output, and a `device_commands` row already terminalized the way
 * `waitForCommandResult` terminalizes it at 60s.
 */
async function seedTimedOutRun(
  fx: Fixture,
  opts: {
    executionStatus?: 'running' | 'timeout' | 'failed' | 'completed' | 'cancelled';
    executionExitCode?: number;
    executionStdout?: string;
    commandStatus?: 'failed' | 'cancelled';
    commandResult?: Record<string, unknown>;
  } = {},
): Promise<{ commandId: string; executionId: string }> {
  const tdb = getTestDb();

  const [execution] = await tdb
    .insert(scriptExecutions)
    .values({
      scriptId: fx.scriptId,
      deviceId: fx.deviceId,
      orgId: fx.orgId,
      triggeredBy: fx.userId,
      triggerType: 'manual',
      status: opts.executionStatus ?? 'running',
      startedAt: new Date(Date.now() - 90_000),
      exitCode: opts.executionExitCode ?? null,
      stdout: opts.executionStdout ?? null,
    })
    .returning({ id: scriptExecutions.id });
  if (!execution) throw new Error('seedTimedOutRun: no execution');

  const [command] = await tdb
    .insert(deviceCommands)
    .values({
      deviceId: fx.deviceId,
      type: 'script',
      targetRole: 'agent',
      payload: { executionId: execution.id, scriptId: fx.scriptId },
      // What commandQueue.waitForCommandResult writes at its deadline.
      status: opts.commandStatus ?? 'failed',
      completedAt: new Date(),
      result: opts.commandResult ?? {
        status: 'timeout',
        error: 'Command timed out after 60000ms',
      },
    })
    .returning({ id: deviceCommands.id });
  if (!command) throw new Error('seedTimedOutRun: no command');

  return { commandId: command.id, executionId: execution.id };
}

/** Drive the real agent-WS onMessage handler with a command_result frame. */
async function sendWsResult(
  fx: Fixture,
  commandId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const handlers = createAgentWsHandlers(fx.agentId, {
    deviceId: fx.deviceId,
    orgId: fx.orgId,
    partnerId: fx.partnerId,
  });
  const event = {
    data: JSON.stringify({ type: 'command_result', commandId, ...body }),
  } as MessageEvent;
  await handlers.onOpen({}, fakeWs);
  await handlers.onMessage(event, fakeWs);
  await handlers.onClose({}, fakeWs);
}

/**
 * Drive the real HTTP fallback route. Only the token/cert half of
 * `agentAuthMiddleware` is stubbed — the request-long org DB access context it
 * opens is reproduced verbatim, because `handleScriptResult` writes
 * `script_executions` (RLS, direct `org_id`) through the plain `db` proxy and
 * relies on that ambient context. Skipping it makes every write a contextless
 * 0-row no-op and the test would fail for a reason the product doesn't have.
 */
async function sendHttpResult(
  fx: Fixture,
  commandId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('agent', {
      deviceId: fx.deviceId,
      agentId: fx.agentId,
      orgId: fx.orgId,
      partnerId: fx.partnerId,
      siteId: fx.siteId,
      role: 'agent',
    });
    await withDbAccessContext(
      {
        scope: 'organization',
        orgId: fx.orgId,
        accessibleOrgIds: [fx.orgId],
        accessiblePartnerIds: [],
        currentPartnerId: null,
      },
      async () => {
        await next();
      },
    );
  });
  app.route('/agents', commandsRoutes);
  return app.request(`/agents/${fx.agentId}/commands/${commandId}/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Seed a restore job already failed by a server-side sweep, with the full
 * backup_configs → backup_jobs → backup_snapshots chain its FKs require.
 */
async function seedTimedOutRestore(
  fx: Fixture,
  opts: { result: Record<string, unknown> },
): Promise<{ restoreJobId: string }> {
  const tdb = getTestDb();

  const [config] = await tdb
    .insert(backupConfigs)
    .values({
      orgId: fx.orgId,
      name: `late-restore-config-${fx.agentId}`,
      type: 'file',
      provider: 'local',
      providerConfig: {},
    })
    .returning({ id: backupConfigs.id });
  if (!config) throw new Error('seedTimedOutRestore: no config');

  const [job] = await tdb
    .insert(backupJobs)
    .values({ orgId: fx.orgId, configId: config.id, deviceId: fx.deviceId, status: 'completed' })
    .returning({ id: backupJobs.id });
  if (!job) throw new Error('seedTimedOutRestore: no backup job');

  const [snapshot] = await tdb
    .insert(backupSnapshots)
    .values({
      orgId: fx.orgId,
      jobId: job.id,
      deviceId: fx.deviceId,
      snapshotId: `snap-${fx.agentId}`,
    })
    .returning({ id: backupSnapshots.id });
  if (!snapshot) throw new Error('seedTimedOutRestore: no snapshot');

  const [restore] = await tdb
    .insert(restoreJobs)
    .values({
      orgId: fx.orgId,
      snapshotId: snapshot.id,
      deviceId: fx.deviceId,
      restoreType: 'selective',
      // Exactly what propagateTimedOutDeviceCommand leaves behind.
      status: 'failed',
      completedAt: new Date(),
      targetConfig: { result: opts.result },
    })
    .returning({ id: restoreJobs.id });
  if (!restore) throw new Error('seedTimedOutRestore: no restore job');

  return { restoreJobId: restore.id };
}

async function readRestoreJob(restoreJobId: string) {
  const tdb = getTestDb();
  const [row] = await tdb
    .select({
      status: restoreJobs.status,
      restoredFiles: restoreJobs.restoredFiles,
      restoredSize: restoreJobs.restoredSize,
    })
    .from(restoreJobs)
    .where(eq(restoreJobs.id, restoreJobId))
    .limit(1);
  if (!row) throw new Error('restore job not found');
  return row;
}

/**
 * Run a service call under the same org DB access context the agent request
 * path establishes. `restore_jobs` is RLS-guarded on `org_id`, so a contextless
 * call is a 0-row no-op that would fail the test for a reason the product does
 * not have.
 */
function asOrg<T>(fx: Fixture, fn: () => Promise<T>): Promise<T> {
  return withDbAccessContext(
    {
      scope: 'organization',
      orgId: fx.orgId,
      accessibleOrgIds: [fx.orgId],
      accessiblePartnerIds: [],
      currentPartnerId: null,
    },
    fn,
  );
}

async function readExecution(executionId: string) {
  const tdb = getTestDb();
  const [row] = await tdb
    .select({
      status: scriptExecutions.status,
      exitCode: scriptExecutions.exitCode,
      stdout: scriptExecutions.stdout,
      stderr: scriptExecutions.stderr,
    })
    .from(scriptExecutions)
    .where(eq(scriptExecutions.id, executionId))
    .limit(1);
  if (!row) throw new Error('execution not found');
  return row;
}

async function readCommand(commandId: string) {
  const tdb = getTestDb();
  const [row] = await tdb
    .select({ status: deviceCommands.status, result: deviceCommands.result })
    .from(deviceCommands)
    .where(eq(deviceCommands.id, commandId))
    .limit(1);
  if (!row) throw new Error('command not found');
  return row as { status: string; result: Record<string, unknown> | null };
}

describe('#3607 late command result recovery', () => {
  runDb(
    'WS: a success arriving after the wait deadline lands stdout and exitCode',
    async () => {
      const fx = await makeFixture();
      const { commandId, executionId } = await seedTimedOutRun(fx);

      await sendWsResult(fx, commandId, {
        status: 'completed',
        exitCode: 0,
        stdout: 'slow but fine',
        durationMs: 91_000,
      });

      // The whole point: the output is IN the table, not merely "late".
      const execution = await readExecution(executionId);
      expect(execution.stdout).toBe('slow but fine');
      expect(execution.exitCode).toBe(0);
      expect(execution.status).toBe('completed');

      // And the command row now reflects the agent's real outcome, so the
      // provisional server-side timeout is gone.
      const command = await readCommand(commandId);
      expect(command.status).toBe('completed');
      expect(command.result?.status).toBe('completed');
      expect(command.result?.stdout).toBe('slow but fine');
    },
    30_000,
  );

  runDb(
    'WS: a non-zero exit after the deadline is recorded as a real failure, not a timeout',
    async () => {
      const fx = await makeFixture();
      const { commandId, executionId } = await seedTimedOutRun(fx);

      await sendWsResult(fx, commandId, {
        status: 'completed',
        exitCode: 3,
        stdout: 'partial',
        stderr: 'it broke',
      });

      const execution = await readExecution(executionId);
      expect(execution.status).toBe('failed');
      expect(execution.exitCode).toBe(3);
      expect(execution.stdout).toBe('partial');
      expect(execution.stderr).toBe('it broke');
    },
    30_000,
  );

  runDb(
    'WS: a duplicate of the recovered frame is still ignored',
    async () => {
      const fx = await makeFixture();
      const { commandId, executionId } = await seedTimedOutRun(fx);

      await sendWsResult(fx, commandId, {
        status: 'completed',
        exitCode: 0,
        stdout: 'first delivery',
      });
      // Same frame again — the row is no longer `result.status === 'timeout'`,
      // so the widened predicate must NOT match it a second time.
      await sendWsResult(fx, commandId, {
        status: 'failed',
        exitCode: 9,
        stdout: 'second delivery',
        stderr: 'should not win',
      });

      const execution = await readExecution(executionId);
      expect(execution.stdout).toBe('first delivery');
      expect(execution.exitCode).toBe(0);
      expect(execution.status).toBe('completed');

      const command = await readCommand(commandId);
      expect(command.status).toBe('completed');
      expect(command.result?.stdout).toBe('first delivery');
    },
    30_000,
  );

  runDb(
    'WS: a cancelled command is NOT reopened by a late result',
    async () => {
      const fx = await makeFixture();
      const { commandId, executionId } = await seedTimedOutRun(fx, {
        commandStatus: 'cancelled',
        commandResult: { status: 'cancelled', error: 'operator cancelled' },
      });

      await sendWsResult(fx, commandId, {
        status: 'completed',
        exitCode: 0,
        stdout: 'ran anyway',
      });

      const command = await readCommand(commandId);
      expect(command.status).toBe('cancelled');
      expect(command.result?.status).toBe('cancelled');

      const execution = await readExecution(executionId);
      expect(execution.stdout).toBeNull();
      expect(execution.status).toBe('running');
    },
    30_000,
  );

  runDb(
    'HTTP fallback: the same recovery applies (duplicated constant in routes/agents/commands.ts)',
    async () => {
      const fx = await makeFixture();
      const { commandId, executionId } = await seedTimedOutRun(fx);

      const res = await sendHttpResult(fx, commandId, {
        status: 'completed',
        exitCode: 0,
        stdout: 'http late result',
      });
      expect(res.status).toBe(200);

      const command = await readCommand(commandId);
      expect(command.status).toBe('completed');
      expect(command.result?.stdout).toBe('http late result');

      const execution = await readExecution(executionId);
      expect(execution.stdout).toBe('http late result');
      expect(execution.exitCode).toBe(0);
      expect(execution.status).toBe('completed');
    },
    30_000,
  );

  runDb(
    'an execution already stamped `timeout` by a sweep still receives the real output',
    async () => {
      const fx = await makeFixture();
      const { commandId, executionId } = await seedTimedOutRun(fx, {
        executionStatus: 'timeout',
      });

      await sendWsResult(fx, commandId, {
        status: 'completed',
        exitCode: 0,
        stdout: 'recovered after reaping',
      });

      const execution = await readExecution(executionId);
      expect(execution.stdout).toBe('recovered after reaping');
      expect(execution.exitCode).toBe(0);
      expect(execution.status).toBe('completed');
    },
    30_000,
  );

  runDb(
    'an execution stamped `failed` by the reaper — the status it ACTUALLY writes here — still receives the real output',
    async () => {
      const fx = await makeFixture();
      // reapStaleScriptExecutions derives the execution status from the command
      // row. In the #3607 scenario that row is `failed` + `result.status =
      // 'timeout'`, so `cmdIsTerminal` is true and `reapedStatus` resolves to
      // 'failed' — NOT 'timeout'. A recovery predicate keyed on 'timeout'
      // alone would leave this, the dominant post-reaper path, still losing
      // the output. Exit code and stdout stay NULL, which is the real
      // discriminator.
      const { commandId, executionId } = await seedTimedOutRun(fx, {
        executionStatus: 'failed',
      });

      await sendWsResult(fx, commandId, {
        status: 'completed',
        exitCode: 0,
        stdout: 'recovered from a reaper-failed stamp',
      });

      const execution = await readExecution(executionId);
      expect(execution.stdout).toBe('recovered from a reaper-failed stamp');
      expect(execution.exitCode).toBe(0);
      expect(execution.status).toBe('completed');
    },
    30_000,
  );

  runDb(
    'a restore job failed ONLY by the reaper\'s server-timeout stamp accepts the real result',
    async () => {
      const fx = await makeFixture();
      // Widening device_commands acceptance means a late restore result now
      // reaches handleVmRestoreResult. `propagateTimedOutDeviceCommand` had
      // already failed the restore job in lockstep with the command timeout,
      // and restore_jobs is what the UI reads — so without the matching
      // carve-out the two rows would disagree: device_commands 'completed',
      // restore_jobs 'failed'.
      const { restoreJobId } = await seedTimedOutRestore(fx, {
        result: { status: 'failed', error: 'timed out', timedOutBy: 'server' },
      });

      const applied = await asOrg(fx, () =>
        updateRestoreJobFromResult(
          { id: restoreJobId, status: 'failed', targetConfig: { result: { status: 'failed', error: 'timed out', timedOutBy: 'server' } } },
          'backup_restore',
          { status: 'completed', exitCode: 0, result: { status: 'completed', filesRestored: 42, bytesRestored: 4242 } },
        ),
      );
      expect(applied).toBe(true);

      const job = await readRestoreJob(restoreJobId);
      expect(job.status).toBe('completed');
      expect(job.restoredFiles).toBe(42);
      expect(job.restoredSize).toBe(4242);
    },
    30_000,
  );

  runDb(
    'a restore job the AGENT reported failed is NOT reopened',
    async () => {
      const fx = await makeFixture();
      // No `timedOutBy` marker — this failure came from the device, so it is
      // final. This is the bound on the carve-out above.
      const agentReported = { status: 'failed', error: 'restore aborted on device' };
      const { restoreJobId } = await seedTimedOutRestore(fx, { result: agentReported });

      const applied = await asOrg(fx, () =>
        updateRestoreJobFromResult(
          { id: restoreJobId, status: 'failed', targetConfig: { result: agentReported } },
          'backup_restore',
          { status: 'completed', exitCode: 0, result: { status: 'completed', filesRestored: 42 } },
        ),
      );
      expect(applied).toBe(false);

      const job = await readRestoreJob(restoreJobId);
      expect(job.status).toBe('failed');
      expect(job.restoredFiles).toBeNull();
    },
    30_000,
  );

  runDb(
    'a CANCELLED execution is left alone — the operator abandoned the run',
    async () => {
      const fx = await makeFixture();
      // routes/scripts.ts's cancel handler stamps the execution 'cancelled'
      // but only cancels the paired command `WHERE status = 'pending'`. A
      // command already 'sent' survives, later picks up the reaper's
      // provisional timeout marker, and its real result now reaches
      // handleScriptResult. Discarding the output is CORRECT here — and this
      // is a routine race, so it must not be treated as a defect.
      const { commandId, executionId } = await seedTimedOutRun(fx, {
        executionStatus: 'cancelled',
      });

      await sendWsResult(fx, commandId, {
        status: 'completed',
        exitCode: 0,
        stdout: 'output for an abandoned run',
      });

      const execution = await readExecution(executionId);
      expect(execution.status).toBe('cancelled');
      expect(execution.stdout).toBeNull();
      expect(execution.exitCode).toBeNull();
    },
    30_000,
  );

  runDb(
    'an execution that already carries real output is NOT overwritten',
    async () => {
      const fx = await makeFixture();
      // A terminal execution with a recorded exit code and stdout came from a
      // genuine agent result, not a server-side sweep. The recovery branch must
      // leave it alone — this is the bound on how far "provisional" reaches.
      const { commandId, executionId } = await seedTimedOutRun(fx, {
        executionStatus: 'failed',
        executionExitCode: 1,
        executionStdout: 'the genuine earlier output',
      });

      await sendWsResult(fx, commandId, {
        status: 'completed',
        exitCode: 0,
        stdout: 'must not win',
      });

      const execution = await readExecution(executionId);
      expect(execution.stdout).toBe('the genuine earlier output');
      expect(execution.exitCode).toBe(1);
      expect(execution.status).toBe('failed');
    },
    30_000,
  );
});
