/**
 * AI Operator P3-0 (#5205, W02 #5207) baseline §2.6, "the three clocks":
 * `manage_services:restart` (aiToolsScripts.ts:649-662) waits only 30 s
 * (`waitForCommandResult`, commandQueue.ts:619) before terminalizing the
 * `device_commands` row to `status:'failed'`, `result:{status:'timeout'}` —
 * while the device-command reap clock for `restart_service` (a
 * `SHORT_TIMEOUT_TYPES` entry, commandTimeouts.ts:25-33) is 5 MINUTES. A
 * Windows service manager that itself waits up to 30 s for `Running` makes
 * the 30s-to-5min window where the tool has already given up but the command
 * is still live and may yet succeed on the device THE RECIPE'S NORMAL CASE,
 * not an edge case (baseline §2.6). The P3-1 thin-slice execution adapter and
 * W06's coordinator both depend on this exact behaviour: a late genuine
 * result must still land, or "unknown effect" silently becomes "lost effect".
 *
 * `commandAcceptsAgentResultCondition` (commandResultAcceptance.ts) is the
 * mechanism, and `lateCommandResultRecovery.integration.test.ts` already
 * proves it end to end for `type: 'script'` (WS + HTTP, dedupe, cancellation,
 * reaper interaction) — the predicate is TYPE-AGNOSTIC, so that coverage
 * generalizes in principle. This file pins the ONE thing that suite cannot:
 * that the same acceptance holds for `restart_service` specifically, the
 * actual execution adapter baseline §2.1-§2.6 describe, with no
 * `script_executions` side table in the way.
 */
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';

import './setup';
import { getTestDb } from './setup';
import { setupTestEnvironment } from './db-utils';
import { createAgentWsHandlers } from '../../routes/agentWs';
import { devices, deviceCommands } from '../../db/schema';

/** Minimal WSContext stand-in — the command-result path only ever calls send(). */
const fakeWs = { send: () => {} } as unknown as Parameters<
  ReturnType<typeof createAgentWsHandlers>['onMessage']
>[1];

interface Fixture {
  orgId: string;
  partnerId: string;
  deviceId: string;
  agentId: string;
}

async function makeFixture(): Promise<Fixture> {
  const env = await setupTestEnvironment();
  const tdb = getTestDb();
  const agentId = `agent-restart-svc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const [device] = await tdb
    .insert(devices)
    .values({
      orgId: env.organization.id,
      siteId: env.site.id,
      agentId,
      hostname: `restart-svc-${agentId}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });
  if (!device) throw new Error('makeFixture: no device');

  return {
    orgId: env.organization.id,
    partnerId: env.partner.id,
    deviceId: device.id,
    agentId,
  };
}

/**
 * Seed the exact post-deadline state `waitForCommandResult` leaves behind
 * (commandQueue.ts:651-662) for a `restart_service` command: `status:
 * 'failed'`, `result: {status: 'timeout', error: 'Command timed out after
 * 30000ms'}`. `payload.name` mirrors `manage_services`'s restart action
 * (aiToolsScripts.ts:660-662).
 */
async function seedTimedOutRestartService(
  fx: Fixture,
  opts: { serviceName?: string } = {},
): Promise<{ commandId: string }> {
  const tdb = getTestDb();
  const [command] = await tdb
    .insert(deviceCommands)
    .values({
      deviceId: fx.deviceId,
      type: 'restart_service',
      targetRole: 'agent',
      payload: { name: opts.serviceName ?? 'spooler' },
      status: 'failed',
      completedAt: new Date(),
      result: { status: 'timeout', error: 'Command timed out after 30000ms' },
    })
    .returning({ id: deviceCommands.id });
  if (!command) throw new Error('seedTimedOutRestartService: no command');
  return { commandId: command.id };
}

/** Seed a restart_service row the AGENT itself reported as failed (no
 *  `timedOutBy`/server-timeout marker) — the bound `commandAcceptsAgentResult
 *  Condition` must NOT reopen. */
async function seedAgentFailedRestartService(fx: Fixture): Promise<{ commandId: string }> {
  const tdb = getTestDb();
  const [command] = await tdb
    .insert(deviceCommands)
    .values({
      deviceId: fx.deviceId,
      type: 'restart_service',
      targetRole: 'agent',
      payload: { name: 'spooler' },
      status: 'failed',
      completedAt: new Date(),
      result: { status: 'failed', error: 'service not found' },
    })
    .returning({ id: deviceCommands.id });
  if (!command) throw new Error('seedAgentFailedRestartService: no command');
  return { commandId: command.id };
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

async function readCommand(commandId: string) {
  const tdb = getTestDb();
  const [row] = await tdb
    .select({ status: deviceCommands.status, result: deviceCommands.result, completedAt: deviceCommands.completedAt })
    .from(deviceCommands)
    .where(eq(deviceCommands.id, commandId))
    .limit(1);
  if (!row) throw new Error('command not found');
  return row as { status: string; result: Record<string, unknown> | null; completedAt: Date | null };
}

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('AI Operator P3-0 baseline §2.6: restart_service late-result acceptance', () => {
  runDb(
    'a genuine agent result arriving after the 30s tool-wait deadline is accepted and completes the row',
    async () => {
      const fx = await makeFixture();
      const { commandId } = await seedTimedOutRestartService(fx);
      const before = await readCommand(commandId);
      expect(before.status).toBe('failed');
      expect(before.result?.status).toBe('timeout');

      await sendWsResult(fx, commandId, {
        status: 'completed',
        exitCode: 0,
        stdout: 'service restarted',
        durationMs: 45_000, // past the 30s tool wait, well inside the 5-minute reap clock
      });

      const after = await readCommand(commandId);
      expect(after.status).toBe('completed');
      expect(after.result?.status).toBe('completed');
      expect(after.result?.stdout).toBe('service restarted');
    },
    30_000,
  );

  runDb(
    'a duplicate frame after the recovered result is still ignored',
    async () => {
      const fx = await makeFixture();
      const { commandId } = await seedTimedOutRestartService(fx);

      await sendWsResult(fx, commandId, {
        status: 'completed',
        exitCode: 0,
        stdout: 'first delivery',
      });
      // Same command again — the row no longer carries `result.status ===
      // 'timeout'`, so the widened predicate must not match it a second time.
      await sendWsResult(fx, commandId, {
        status: 'failed',
        exitCode: 9,
        stdout: 'second delivery',
        error: 'should not win',
      });

      const after = await readCommand(commandId);
      expect(after.status).toBe('completed');
      expect(after.result?.stdout).toBe('first delivery');
    },
    30_000,
  );

  runDb(
    'a restart_service row the AGENT reported failed (no server-timeout marker) is NOT reopened',
    async () => {
      // The bound on the carve-out: only `status: 'failed'` PLUS
      // `result.status === 'timeout'` may accept a late result. A genuine
      // agent-reported failure (e.g. "service not found") is final.
      const fx = await makeFixture();
      const { commandId } = await seedAgentFailedRestartService(fx);

      await sendWsResult(fx, commandId, {
        status: 'completed',
        exitCode: 0,
        stdout: 'ran anyway',
      });

      const after = await readCommand(commandId);
      expect(after.status).toBe('failed');
      expect(after.result?.status).toBe('failed');
      expect(after.result?.error).toBe('service not found');
    },
    30_000,
  );
});
