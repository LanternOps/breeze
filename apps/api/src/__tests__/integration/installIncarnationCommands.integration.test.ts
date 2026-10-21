/**
 * #8318 wave 1a — install incarnations on commands, against real Postgres
 * (spec docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md
 * §4.1, §4.2, §5.2).
 *
 *   - the BEFORE INSERT trigger stamps every row from devices.install_incarnation,
 *     past RLS, overwriting the caller's value, and refuses a missing device;
 *   - the stamp is immutable, and the device's incarnation only advances by one
 *     (the null rule is a CHECK);
 *   - the stamping race with a confirm that holds the device row FOR UPDATE:
 *     an insert that waits behind it stamps the NEW incarnation;
 *   - claim (heartbeat batch and WS push) refuses an earlier incarnation's row and
 *     terminalises it with `superseded_by_reattach`; a NULL stamp counts as 1;
 *   - result acceptance refuses an earlier incarnation's row on both transports,
 *     the #3607 timeout reopen path included.
 *
 * The device's incarnation is advanced here by a direct UPDATE (as the boundary
 * would), WITHOUT running the boundary, so the open rows it would have cancelled
 * are still there: exactly the rows these refusals exist for.
 */
import './setup';

import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { deviceCommands, devices, scriptExecutions, scripts } from '../../db/schema';
import { createAgentWsHandlers } from '../../routes/agentWs';
import { commandsRoutes } from '../../routes/agents/commands';
import { claimPendingCommandForDelivery, claimPendingCommandsForDevice } from '../../services/commandDispatch';
import { commandAcceptsAgentResultCondition } from '../../services/commandResultAcceptance';
import { setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const AGENT_CAPS = {
  peripheralPolicyProtocolVersion: 2,
  rollbackProtocolVersion: 1,
  pamLifetimeProtocolVersion: 2,
} as const;

interface Fixture {
  orgId: string;
  partnerId: string;
  siteId: string;
  deviceId: string;
  agentId: string;
  userId: string;
}

async function makeFixture(): Promise<Fixture> {
  const env = await setupTestEnvironment();
  const agentId = `incarnation-${randomUUID()}`;
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: env.organization.id,
      siteId: env.site.id,
      agentId,
      hostname: `incarnation-${agentId.slice(-8)}`,
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
    })
    .returning({ id: devices.id });
  if (!device) throw new Error('fixture: no device');
  return {
    orgId: env.organization.id,
    partnerId: env.partner.id,
    siteId: env.site.id,
    deviceId: device.id,
    agentId,
    userId: env.user.id,
  };
}

/** Advance the device to the next incarnation the way the boundary does (superuser, no boundary). */
async function advanceIncarnation(deviceId: string): Promise<number> {
  const [row] = await getTestDb().execute<{ install_incarnation: number }>(sql`
    UPDATE devices
       SET install_incarnation = install_incarnation + 1,
           incarnation_started_at = now(),
           last_reattached_at = now()
     WHERE id = ${deviceId}::uuid
    RETURNING install_incarnation`);
  return Number(row!.install_incarnation);
}

async function insertCommand(
  deviceId: string,
  values: Partial<typeof deviceCommands.$inferInsert> = {},
): Promise<string> {
  const [row] = await getTestDb()
    .insert(deviceCommands)
    .values({ deviceId, type: 'refresh_inventory', status: 'pending', targetRole: 'agent', ...values })
    .returning({ id: deviceCommands.id });
  return row!.id;
}

/** A pre-trigger (legacy) row: NULL stamp. Triggers are skipped for this one insert only. */
async function insertLegacyCommand(deviceId: string, values: Partial<typeof deviceCommands.$inferInsert> = {}) {
  const id = randomUUID();
  await getTestDb().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await tx.insert(deviceCommands).values({
      id,
      deviceId,
      type: 'refresh_inventory',
      status: 'pending',
      targetRole: 'agent',
      ...values,
    });
  });
  return id;
}

async function commandRow(id: string) {
  const [row] = await getTestDb().select().from(deviceCommands).where(eq(deviceCommands.id, id)).limit(1);
  return row!;
}

function claim(deviceId: string) {
  return withSystemDbAccessContext(() =>
    claimPendingCommandsForDevice(deviceId, 10, 'agent', undefined, { ...AGENT_CAPS }),
  );
}

function pgCode(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code ?? e?.cause?.code;
}

describe('device_commands incarnation stamp (#8318 §4.2)', () => {
  it('stamps the device incarnation on every insert and overwrites a caller value', async () => {
    const fx = await makeFixture();
    const first = await insertCommand(fx.deviceId, { deviceIncarnation: 7 });
    expect((await commandRow(first)).deviceIncarnation).toBe(1);

    await advanceIncarnation(fx.deviceId);
    const second = await insertCommand(fx.deviceId);
    expect((await commandRow(second)).deviceIncarnation).toBe(2);
    // The earlier row keeps the incarnation it was enqueued for.
    expect((await commandRow(first)).deviceIncarnation).toBe(1);
  });

  it('stamps past RLS: an org context that cannot see the device still stamps the right value', async () => {
    const fx = await makeFixture();
    await advanceIncarnation(fx.deviceId);
    const other = await setupTestEnvironment();
    const id = randomUUID();
    await withDbAccessContext(
      {
        scope: 'organization',
        orgId: other.organization.id,
        accessibleOrgIds: [other.organization.id],
        accessiblePartnerIds: [],
        currentPartnerId: null,
      },
      async () => {
        // The device row is invisible here...
        const visible = await db.select({ id: devices.id }).from(devices).where(eq(devices.id, fx.deviceId));
        expect(visible).toHaveLength(0);
        // ...yet the command is stamped with its current incarnation.
        await db.insert(deviceCommands).values({ id, deviceId: fx.deviceId, type: 'refresh_inventory' });
      },
    );
    expect((await commandRow(id)).deviceIncarnation).toBe(2);
  });

  it('refuses a row for a device that does not exist with 23503, not a NULL stamp', async () => {
    let caught: unknown;
    try {
      await insertCommand(randomUUID());
    } catch (err) {
      caught = err;
    }
    expect(pgCode(caught)).toBe('23503');
  });

  it('keeps the stamp immutable', async () => {
    const fx = await makeFixture();
    const id = await insertCommand(fx.deviceId);
    let caught: unknown;
    try {
      await getTestDb().update(deviceCommands).set({ deviceIncarnation: 2 }).where(eq(deviceCommands.id, id));
    } catch (err) {
      caught = err;
    }
    expect(pgCode(caught)).toBe('42501');
    expect((await commandRow(id)).deviceIncarnation).toBe(1);
  });
});

describe('devices.install_incarnation integrity (#8318 §4.1)', () => {
  async function tryUpdate(deviceId: string, set: Partial<typeof devices.$inferInsert>) {
    try {
      await getTestDb().update(devices).set(set).where(eq(devices.id, deviceId));
      return undefined;
    } catch (err) {
      return pgCode(err);
    }
  }

  it('starts every device at incarnation 1 with a NULL incarnation_started_at', async () => {
    const fx = await makeFixture();
    const [row] = await getTestDb().select().from(devices).where(eq(devices.id, fx.deviceId));
    expect(row!.installIncarnation).toBe(1);
    expect(row!.incarnationStartedAt).toBeNull();
    expect(row!.lastReattachedAt).toBeNull();
  });

  it('only advances by one, never back, and pins the null rule', async () => {
    const fx = await makeFixture();
    const at = new Date();
    expect(await tryUpdate(fx.deviceId, { installIncarnation: 3, incarnationStartedAt: at })).toBe('42501');
    // The CHECK: incarnation 2 needs incarnation_started_at.
    expect(await tryUpdate(fx.deviceId, { installIncarnation: 2 })).toBe('23514');
    // incarnation_started_at moves only with the incarnation.
    expect(await tryUpdate(fx.deviceId, { incarnationStartedAt: at })).toBe('42501');
    expect(await tryUpdate(fx.deviceId, { installIncarnation: 2, incarnationStartedAt: at })).toBeUndefined();
    expect(await tryUpdate(fx.deviceId, { installIncarnation: 1, incarnationStartedAt: null })).toBe('42501');
    // The CHECK the other way round: incarnation 2 cannot drop its timestamp.
    expect(await tryUpdate(fx.deviceId, { incarnationStartedAt: null })).toBe('42501');
    const [row] = await getTestDb().select().from(devices).where(eq(devices.id, fx.deviceId));
    expect(row!.installIncarnation).toBe(2);
  });
});

describe('the stamping race with a confirm holding the device row (#8318 §4.2)', () => {
  it('an insert that waits behind the FOR UPDATE stamps the new incarnation', async () => {
    const fx = await makeFixture();
    const holder = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    const inserter = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    try {
      let releaseConfirm!: () => void;
      const confirmMayCommit = new Promise<void>((resolve) => { releaseConfirm = resolve; });
      let lockHeld!: () => void;
      const lockTaken = new Promise<void>((resolve) => { lockHeld = resolve; });

      const confirm = holder.begin(async (tx) => {
        await tx`SELECT id FROM devices WHERE id = ${fx.deviceId} FOR UPDATE`;
        lockHeld();
        await confirmMayCommit;
        await tx`UPDATE devices SET install_incarnation = 2, incarnation_started_at = now() WHERE id = ${fx.deviceId}`;
      });

      await lockTaken;
      const [backend] = await inserter<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      const pid = backend!.pid;
      // postgres.js queries are lazy: execute() sends it now, while the lock is held.
      const insert = inserter<{ device_incarnation: number }[]>`
        INSERT INTO device_commands (device_id, type) VALUES (${fx.deviceId}, 'refresh_inventory')
        RETURNING device_incarnation`.execute();
      // Awaited below; a rejection while this test is still polling must not surface as unhandled.
      insert.catch(() => {});

      try {
        // Wait until the insert is actually blocked on the device row lock.
        const deadline = Date.now() + 10_000;
        const observer = getTestDb();
        for (;;) {
          const [state] = await observer.execute<{ wait_event_type: string | null }>(
            sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`,
          );
          if (state?.wait_event_type === 'Lock') break;
          if (Date.now() > deadline) throw new Error('the insert never blocked on the device row');
          await new Promise((r) => setTimeout(r, 25));
        }
      } finally {
        releaseConfirm();
        await confirm;
      }
      const [stamped] = await insert;
      expect(stamped!.device_incarnation).toBe(2);
    } finally {
      await holder.end({ timeout: 5 });
      await inserter.end({ timeout: 5 });
    }
  });
});

describe('claim refuses an earlier incarnation (#8318 §4.2, §5.2)', () => {
  it('the heartbeat claim terminalises a stale row and delivers the current one', async () => {
    const fx = await makeFixture();
    const stale = await insertCommand(fx.deviceId);
    const staleUninstall = await insertCommand(fx.deviceId, { type: 'self_uninstall' });
    await advanceIncarnation(fx.deviceId);
    const current = await insertCommand(fx.deviceId);

    const claimed = await claim(fx.deviceId);
    expect(claimed.map((c) => c.id)).toEqual([current]);

    for (const id of [stale, staleUninstall]) {
      const row = await commandRow(id);
      expect(row.status).toBe('cancelled');
      expect(row.result).toMatchObject({ status: 'cancelled', reason: 'superseded_by_reattach' });
    }
    expect((await commandRow(current)).status).toBe('sent');
  });

  it('a NULL (pre-trigger) stamp counts as incarnation 1', async () => {
    const fx = await makeFixture();
    const legacy = await insertLegacyCommand(fx.deviceId);
    expect((await commandRow(legacy)).deviceIncarnation).toBeNull();
    // Never reattached: today's behaviour, delivered.
    expect((await claim(fx.deviceId)).map((c) => c.id)).toEqual([legacy]);

    const fx2 = await makeFixture();
    const legacy2 = await insertLegacyCommand(fx2.deviceId);
    await advanceIncarnation(fx2.deviceId);
    expect(await claim(fx2.deviceId)).toEqual([]);
    expect((await commandRow(legacy2)).result).toMatchObject({ reason: 'superseded_by_reattach' });
  });

  it('the WS push claim cancels a stale row instead of delivering it', async () => {
    const fx = await makeFixture();
    const stale = await insertCommand(fx.deviceId);
    await advanceIncarnation(fx.deviceId);
    const outcome = await claimPendingCommandForDelivery(stale);
    expect(outcome).toEqual({ status: 'cancelled', id: stale, reason: 'superseded_by_reattach' });
    expect((await commandRow(stale)).status).toBe('cancelled');

    const current = await insertCommand(fx.deviceId);
    expect((await claimPendingCommandForDelivery(current)).status).toBe('claimed');
  });
});

describe('result acceptance refuses an earlier incarnation (#8318 §4.2, §5.2)', () => {
  /** What `waitForCommandResult` leaves at its deadline: the #3607 reopen path. */
  async function seedTimedOutScript(fx: Fixture) {
    const tdb = getTestDb();
    const [script] = await tdb
      .insert(scripts)
      .values({
        orgId: fx.orgId,
        name: `incarnation-script-${randomUUID()}`,
        osTypes: ['windows'],
        language: 'powershell',
        content: 'Write-Output "old install"',
      })
      .returning({ id: scripts.id });
    const [execution] = await tdb
      .insert(scriptExecutions)
      .values({
        scriptId: script!.id,
        deviceId: fx.deviceId,
        orgId: fx.orgId,
        triggeredBy: fx.userId,
        triggerType: 'manual',
        status: 'running',
        startedAt: new Date(Date.now() - 90_000),
      })
      .returning({ id: scriptExecutions.id });
    const commandId = await insertCommand(fx.deviceId, {
      type: 'script',
      payload: { executionId: execution!.id, scriptId: script!.id },
      status: 'failed',
      completedAt: new Date(),
      result: { status: 'timeout', error: 'Command timed out after 60000ms', timedOutBy: 'server' },
    });
    return { commandId, executionId: execution!.id };
  }

  async function execution(executionId: string) {
    const [row] = await getTestDb()
      .select({ status: scriptExecutions.status, stdout: scriptExecutions.stdout })
      .from(scriptExecutions)
      .where(eq(scriptExecutions.id, executionId));
    return row!;
  }

  const fakeWs = { send: () => {} } as unknown as Parameters<
    ReturnType<typeof createAgentWsHandlers>['onMessage']
  >[1];

  async function sendWsResult(fx: Fixture, commandId: string) {
    const handlers = createAgentWsHandlers(fx.agentId, {
      deviceId: fx.deviceId,
      orgId: fx.orgId,
      partnerId: fx.partnerId,
    });
    await handlers.onOpen({}, fakeWs);
    await handlers.onMessage(
      {
        data: JSON.stringify({
          type: 'command_result',
          commandId,
          status: 'completed',
          exitCode: 0,
          stdout: 'from the old install',
        }),
      } as MessageEvent,
      fakeWs,
    );
    await handlers.onClose({}, fakeWs);
  }

  async function sendHttpResult(fx: Fixture, commandId: string) {
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
      body: JSON.stringify({ status: 'completed', exitCode: 0, stdout: 'from the old install' }),
    });
  }

  it('the shared predicate refuses a stale row, reopen paths included, and accepts a current one', async () => {
    const fx = await makeFixture();
    const sentStale = await insertCommand(fx.deviceId, { status: 'sent' });
    const timedOutStale = await insertCommand(fx.deviceId, {
      type: 'script',
      status: 'failed',
      result: { status: 'timeout', timedOutBy: 'server' },
    });
    const legacyStale = await insertLegacyCommand(fx.deviceId, { status: 'sent' });
    await advanceIncarnation(fx.deviceId);
    const sentCurrent = await insertCommand(fx.deviceId, { status: 'sent' });

    const accepted = await getTestDb()
      .select({ id: deviceCommands.id })
      .from(deviceCommands)
      .where(sql`${deviceCommands.deviceId} = ${fx.deviceId} AND ${commandAcceptsAgentResultCondition()}`);
    expect(accepted.map((r) => r.id)).toEqual([sentCurrent]);
    expect([sentStale, timedOutStale, legacyStale]).not.toContain(accepted[0]?.id);
  });

  it('a late result over the WS for an earlier incarnation is not recorded', async () => {
    const fx = await makeFixture();
    const { commandId, executionId } = await seedTimedOutScript(fx);
    await advanceIncarnation(fx.deviceId);

    await sendWsResult(fx, commandId);

    const row = await commandRow(commandId);
    expect(row.status).toBe('failed');
    expect(row.result).toMatchObject({ status: 'timeout' });
    expect((await execution(executionId)).stdout).toBeNull();
  });

  it('a late result over HTTP for an earlier incarnation is not recorded', async () => {
    const fx = await makeFixture();
    const { commandId, executionId } = await seedTimedOutScript(fx);
    await advanceIncarnation(fx.deviceId);

    const res = await sendHttpResult(fx, commandId);
    expect(res.status).toBe(200);

    const row = await commandRow(commandId);
    expect(row.status).toBe('failed');
    expect(row.result).toMatchObject({ status: 'timeout' });
    expect((await execution(executionId)).stdout).toBeNull();
  });

  it('control: the same late result on a never-reattached device is recorded', async () => {
    const fx = await makeFixture();
    const { commandId, executionId } = await seedTimedOutScript(fx);

    const res = await sendHttpResult(fx, commandId);
    expect(res.status).toBe(200);
    expect((await commandRow(commandId)).status).toBe('completed');
    expect((await execution(executionId)).stdout).toContain('from the old install');
  });
});
