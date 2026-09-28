/**
 * Integration test — #3530: a command must never read "completed" while its
 * feature-specific record failed to persist, and a resubmitted result must be
 * recorded.
 *
 * Before the fix both transports committed the `device_commands` terminal
 * compare-and-set in its own transaction FIRST and then ran the per-type
 * persistence, whose failures were caught and swallowed: the history said
 * "completed", `script_executions` (or the backup verification, CIS findings,
 * …) was never written, and — the row being terminal — every resubmission was
 * dropped as a duplicate.
 *
 * The unit suites pin the wrapper composition with `db` mocked; only real
 * Postgres can prove the ROLLBACK. So these cases make the real script handler
 * write `script_executions` and THEN fail, and assert on what is actually in
 * both tables:
 *
 *   1. WS: CAS + the handler's partial write roll back together; the command is
 *      parked `failed` + `result_processing_failed`; a resubmission records.
 *   2. HTTP: same, through the savepoint on the request transaction, with a 500.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import './setup';
import { getTestDb } from './setup';
import { setupTestEnvironment } from './db-utils';
import { withDbAccessContext } from '../../db';
import { createAgentWsHandlers } from '../../routes/agentWs';
import { commandsRoutes } from '../../routes/agents/commands';
import { commandResultHandlers } from '../../services/commandResultHandlers';
import { RESULT_PROCESSING_FAILED_RESULT_STATUS } from '../../services/commandResultAcceptance';
import { devices, deviceCommands, scripts, scriptExecutions } from '../../db/schema';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const fakeWs = { send: vi.fn() } as unknown as Parameters<
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
  const agentId = `agent-3530-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const [device] = await tdb
    .insert(devices)
    .values({
      orgId: env.organization.id,
      siteId: env.site.id,
      agentId,
      hostname: `persist-order-${agentId}`,
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
      name: `persist-order-script-${agentId}`,
      osTypes: ['windows'],
      language: 'powershell',
      content: 'Write-Output "hello"',
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

/** An in-flight script run: execution `running`, command `sent`. */
async function seedInFlightRun(fx: Fixture): Promise<{ commandId: string; executionId: string }> {
  const tdb = getTestDb();
  const [execution] = await tdb
    .insert(scriptExecutions)
    .values({
      scriptId: fx.scriptId,
      deviceId: fx.deviceId,
      orgId: fx.orgId,
      triggeredBy: fx.userId,
      triggerType: 'manual',
      status: 'running',
      startedAt: new Date(Date.now() - 5_000),
    })
    .returning({ id: scriptExecutions.id });
  if (!execution) throw new Error('seedInFlightRun: no execution');

  const [command] = await tdb
    .insert(deviceCommands)
    .values({
      deviceId: fx.deviceId,
      type: 'script',
      targetRole: 'agent',
      payload: { executionId: execution.id, scriptId: fx.scriptId },
      status: 'sent',
    })
    .returning({ id: deviceCommands.id });
  if (!command) throw new Error('seedInFlightRun: no command');

  return { commandId: command.id, executionId: execution.id };
}

async function sendWsResult(fx: Fixture, commandId: string, body: Record<string, unknown>): Promise<void> {
  const handlers = createAgentWsHandlers(fx.agentId, {
    deviceId: fx.deviceId,
    orgId: fx.orgId,
    partnerId: fx.partnerId,
  });
  await handlers.onOpen({}, fakeWs);
  await handlers.onMessage({ data: JSON.stringify({ type: 'command_result', commandId, ...body }) } as MessageEvent, fakeWs);
  await handlers.onClose({}, fakeWs);
}

/** The real HTTP route under the same request-long org context agentAuthMiddleware opens. */
async function sendHttpResult(fx: Fixture, commandId: string, body: Record<string, unknown>): Promise<Response> {
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
      { scope: 'organization', orgId: fx.orgId, accessibleOrgIds: [fx.orgId], accessiblePartnerIds: [], currentPartnerId: null },
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

async function readCommand(commandId: string) {
  const [row] = await getTestDb()
    .select({ status: deviceCommands.status, result: deviceCommands.result, completedAt: deviceCommands.completedAt })
    .from(deviceCommands)
    .where(eq(deviceCommands.id, commandId))
    .limit(1);
  if (!row) throw new Error('command not found');
  return row as { status: string; result: Record<string, unknown> | null; completedAt: Date | null };
}

async function readExecution(executionId: string) {
  const [row] = await getTestDb()
    .select({ status: scriptExecutions.status, exitCode: scriptExecutions.exitCode, stdout: scriptExecutions.stdout })
    .from(scriptExecutions)
    .where(eq(scriptExecutions.id, executionId))
    .limit(1);
  if (!row) throw new Error('execution not found');
  return row;
}

/**
 * Let the REAL script handler run — so it genuinely writes script_executions
 * inside the shared transaction — and then fail, the way a later write in the
 * same handler (batch counter, automation ledger) would.
 */
function failAfterRealScriptPersistence() {
  const realScriptHandler = commandResultHandlers.script!;
  return vi.spyOn(commandResultHandlers, 'script').mockImplementationOnce(async (input) => {
    await realScriptHandler(input);
    throw new Error('simulated failure after script_executions was written');
  });
}

const RESULT = { status: 'completed', exitCode: 0, stdout: 'hello from the agent' };

describe('#3530 — terminal CAS and per-type persistence commit together', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  runDb('WS: a persistence failure rolls back the CAS and the partial write, parks the command, and a resubmission records', async () => {
    const fx = await makeFixture();
    const { commandId, executionId } = await seedInFlightRun(fx);
    const spy = failAfterRealScriptPersistence();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await sendWsResult(fx, commandId, RESULT);
    expect(spy).toHaveBeenCalledTimes(1);

    // The real handler DID write script_executions — and it was rolled back.
    const execAfterFailure = await readExecution(executionId);
    expect(execAfterFailure.status).toBe('running');
    expect(execAfterFailure.stdout).toBeNull();

    // Never "completed": parked failed + reopenable, agent fields kept.
    const parked = await readCommand(commandId);
    expect(parked.status).toBe('failed');
    expect(parked.completedAt).not.toBeNull();
    expect(parked.result).toMatchObject({
      status: RESULT_PROCESSING_FAILED_RESULT_STATUS,
      agentStatus: 'completed',
      exitCode: 0,
      processingFailedAt: expect.any(String),
    });

    // The agent resubmits — accepted and recorded, not dropped as a duplicate.
    vi.mocked(console.error).mockRestore();
    await sendWsResult(fx, commandId, RESULT);

    const recorded = await readCommand(commandId);
    expect(recorded.status).toBe('completed');
    expect(recorded.result).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(recorded.result?.processingFailedAt).toBeUndefined();
    const exec = await readExecution(executionId);
    expect(exec.status).toBe('completed');
    expect(exec.exitCode).toBe(0);
    expect(exec.stdout).toContain('hello from the agent');

    // …and a third copy is a true duplicate again.
    await sendWsResult(fx, commandId, { ...RESULT, stdout: 'a stale duplicate' });
    expect((await readExecution(executionId)).stdout).toContain('hello from the agent');
  });

  runDb('HTTP: same rollback through the request-transaction savepoint, answered 500; a resubmission records', async () => {
    const fx = await makeFixture();
    const { commandId, executionId } = await seedInFlightRun(fx);
    failAfterRealScriptPersistence();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const failed = await sendHttpResult(fx, commandId, RESULT);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: 'result_processing_failed' });

    const execAfterFailure = await readExecution(executionId);
    expect(execAfterFailure.status).toBe('running');
    expect(execAfterFailure.stdout).toBeNull();

    const parked = await readCommand(commandId);
    expect(parked.status).toBe('failed');
    expect(parked.result).toMatchObject({
      status: RESULT_PROCESSING_FAILED_RESULT_STATUS,
      agentStatus: 'completed',
      processingFailedAt: expect.any(String),
    });

    vi.mocked(console.error).mockRestore();
    const retried = await sendHttpResult(fx, commandId, RESULT);
    expect(retried.status).toBe(200);

    expect((await readCommand(commandId)).status).toBe('completed');
    const exec = await readExecution(executionId);
    expect(exec.status).toBe('completed');
    expect(exec.stdout).toContain('hello from the agent');
  });
});
