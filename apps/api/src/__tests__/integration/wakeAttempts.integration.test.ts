import './setup';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { devices, deviceCommands, deviceIpHistory, deviceNetwork } from '../../db/schema';
import { deviceWakeAttempts, WAKE_ATTEMPT_OUTCOMES } from '../../db/schema/deviceWake';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { insertDevice, seedHoldingOrg, seedParkedDevice } from './unassignedPoolFixtures';

vi.mock('../../routes/agentWs', () => ({ isAgentConnected: vi.fn(() => true), sendCommandToAgent: vi.fn(() => true) }));
vi.mock('../../services/commandDispatch', () => ({
  claimPendingCommandForDelivery: vi.fn(async () => ({ status: 'claimed', agentId: 'relay-agent' })),
  releaseClaimedCommandDelivery: vi.fn(),
}));
import { sendCommandToAgent } from '../../routes/agentWs';
import { claimPendingCommandForDelivery } from '../../services/commandDispatch';
import { runBulkIsolated } from '../../lib/bulkOps';
import { commandResultHandlers } from '../../services/commandResultHandlers';
import { dispatchWake } from '../../services/wakeOnLan';
import { applyWakeRelayResult, openOrJoinWakeAttempt, WAKE_OUTCOME_WINDOW_MS } from '../../services/wakeAttempts';

const macs = ['02:00:00:00:00:01'];

describe('wake attempts (real Postgres)', () => {
  let orgId: string;
  let partnerId: string;
  let target: string;
  let relay: string;
  let requestedBy: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(sendCommandToAgent).mockReturnValue(true);
    vi.mocked(claimPendingCommandForDelivery).mockResolvedValue({ status: 'claimed', id: randomUUID(), agentId: 'relay-agent', executedAt: new Date() });
    partnerId = (await createPartner()).id;
    orgId = (await createOrganization({ partnerId })).id;
    const site = await createSite({ orgId });
    target = (await insertDevice(orgId, site.id)).id;
    relay = (await insertDevice(orgId, site.id)).id;
    await getTestDb().update(devices).set({ status: 'offline' }).where(eq(devices.id, target));
    await getTestDb().update(devices).set({ status: 'online' }).where(eq(devices.id, relay));
    requestedBy = (await createUser({ partnerId })).id;
  });

  const input = () => ({ deviceId: target, orgId, relayDeviceId: relay, relayHostname: 'test-relay', requestedBy, macs, broadcast: '192.0.2.255' });
  const open = () => withSystemDbAccessContext(() => openOrJoinWakeAttempt(input()));
  const rows = () => getTestDb().select().from(deviceWakeAttempts).where(eq(deviceWakeAttempts.deviceId, target));
  const wake = async (override = relay) => {
    const prepared = await withSystemDbAccessContext(() => dispatchWake(target, requestedBy, override ? { relayDeviceIdOverride: override } : {}));
    return prepared.ok ? prepared.deliver() : prepared;
  };
  async function seedNetwork(withHistory = true) {
    await getTestDb().insert(deviceNetwork).values({ deviceId: target, orgId, interfaceName: 'eth0', macAddress: macs[0] });
    if (withHistory) await getTestDb().insert(deviceIpHistory).values({
      deviceId: target, orgId, interfaceName: 'eth0', ipAddress: '192.0.2.20', ipType: 'ipv4', isActive: true,
      subnetMask: '255.255.255.0', macAddress: macs[0],
    });
  }

  it('new attempt is pending with deadline_at = now + 10 min', async () => {
    const before = Date.now();
    const opened = await open();
    const [row] = await rows();
    expect(opened).toEqual({ attemptId: row!.id, joined: false });
    expect(row).toMatchObject({ outcome: 'pending', sendCount: 1, resolvedAt: null, relayDeviceId: relay, requestedBy, macs });
    expect(WAKE_OUTCOME_WINDOW_MS).toBe(600_000);
    expect(row!.deadlineAt!.getTime()).toBeGreaterThanOrEqual(before + 600_000);
    expect(row!.deadlineAt!.getTime()).toBeLessThanOrEqual(Date.now() + 600_000);
  });

  it('a repeat click joins: same id, send_count 2, deadline unchanged', async () => {
    const first = await open();
    const [before] = await rows();
    const second = await withSystemDbAccessContext(() => openOrJoinWakeAttempt({ ...input(), relayDeviceId: target, relayHostname: 'different-relay', macs: ['02:00:00:00:00:02'], broadcast: '198.51.100.255' }));
    expect(second).toEqual({ attemptId: first.attemptId, joined: true });
    expect(await rows()).toEqual([{ ...before, sendCount: 2 }]);
  });

  it('two concurrent opens for one device both succeed with one row', async () => {
    const opened = await Promise.all([open(), open()]);
    expect(opened[0]!.attemptId).toBe(opened[1]!.attemptId);
    expect(opened.map(row => row.joined).sort()).toEqual([false, true]);
    expect(await rows()).toMatchObject([{ id: opened[0]!.attemptId, outcome: 'pending', sendCount: 2 }]);
    expect(await rows()).toHaveLength(1);
  });

  it('concurrent opens in one context join a rival uncommitted attempt', async () => {
    let releaseRival!: () => void;
    let rivalReady!: () => void;
    const ready = new Promise<void>(resolve => { rivalReady = resolve; });
    const release = new Promise<void>(resolve => { releaseRival = resolve; });
    const rival = getTestDb().transaction(async tx => {
      const [row] = await tx.insert(deviceWakeAttempts).values({
        ...input(), outcome: 'pending', deadlineAt: new Date(Date.now() + WAKE_OUTCOME_WINDOW_MS),
      }).returning();
      rivalReady();
      await release;
      return row!;
    });
    await ready;
    let pid: number | undefined;
    const contenders = withSystemDbAccessContext(async () => {
      const [backend] = await db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      pid = backend!.pid;
      return Promise.all([openOrJoinWakeAttempt(input()), openOrJoinWakeAttempt(input())]);
    });
    // Observe an actual lock wait instead of relying on a fixed sleep to race.
    try {
      await vi.waitFor(async () => {
        expect(pid).toBeDefined();
        const [state] = await getTestDb().execute<{ waiting: boolean }>(sql`
          SELECT cardinality(pg_blocking_pids(${pid!})) > 0 AS waiting
        `);
        expect(state!.waiting).toBe(true);
      }, { timeout: 5000, interval: 20 });
    } finally {
      releaseRival();
    }
    const winner = await rival;
    expect(await contenders).toEqual([
      { attemptId: winner.id, joined: true }, { attemptId: winner.id, joined: true },
    ]);
    expect(await rows()).toEqual([{ ...winner, sendCount: 3 }]);
  });

  it.each([true, false])('relay result sent=%s moves only pending', async sent => {
    const { attemptId } = await open();
    await withSystemDbAccessContext(() => applyWakeRelayResult(attemptId, sent));
    const [row] = await rows();
    expect(row!.outcome).toBe(sent ? 'sent' : 'send_failed');
    if (sent) expect(row!.resolvedAt).toBeNull();
    else expect(row!.resolvedAt).toBeInstanceOf(Date);
  });

  it.each(WAKE_ATTEMPT_OUTCOMES.filter(outcome => outcome !== 'pending'))('a relay result on %s changes nothing', async outcome => {
    const { attemptId } = await open();
    await getTestDb().update(deviceWakeAttempts).set({ outcome, resolvedAt: outcome === 'sent' ? null : new Date() }).where(eq(deviceWakeAttempts.id, attemptId));
    const before = await rows();
    await withSystemDbAccessContext(async () => {
      await applyWakeRelayResult(attemptId, true);
      await applyWakeRelayResult(attemptId, false);
      await applyWakeRelayResult(randomUUID(), true);
    });
    expect(await rows()).toEqual(before);
  });

  it('dispatchWake payload and response carry the joined attempt id', async () => {
    await seedNetwork();
    const first = await wake();
    const second = await wake();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('wake dispatch failed');
    expect(second.wakeAttemptId).toBe(first.wakeAttemptId);
    expect(second.commandId).not.toBe(first.commandId);
    for (const result of [first, second]) {
      const [command] = await getTestDb().select().from(deviceCommands).where(eq(deviceCommands.id, result.commandId));
      expect(command!.payload).toMatchObject({ wakeAttemptId: first.wakeAttemptId });
    }
    expect(await rows()).toMatchObject([{ id: first.wakeAttemptId, deviceCommandId: first.commandId, sendCount: 2, outcome: 'pending' }]);
    expect(sendCommandToAgent).toHaveBeenCalledTimes(2);
  });

  it('commits each bulk attempt and command before delivery and the next dispatch', async () => {
    await seedNetwork();
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
    let enterSecond!: () => void;
    const secondEntered = new Promise<void>(resolve => { enterSecond = resolve; });
    const observations: Promise<void>[] = [];
    vi.mocked(sendCommandToAgent).mockImplementation((_agentId, command) => {
      observations.push((async () => {
        const [persistedCommand] = await getTestDb().select().from(deviceCommands).where(eq(deviceCommands.id, command.id));
        expect(persistedCommand).toBeDefined();
        expect(await rows()).toMatchObject([{ deviceCommandId: command.id }]);
      })());
      return true;
    });
    const context = { scope: 'organization' as const, orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: requestedBy, currentPartnerId: partnerId };
    const bulk = runBulkIsolated(context, [target, 'later-device'], async deviceId => {
      if (deviceId === 'later-device') {
        enterSecond();
        await secondGate;
        return undefined;
      }
      const result = await dispatchWake(deviceId, requestedBy, { relayDeviceIdOverride: relay });
      // Settle any synchronous-send observations before this transaction commits.
      // A premature send must not pass just because the observer's query is slower.
      await Promise.all(observations);
      return result;
    }, async (_deviceId, value) => {
      if (value?.ok) await value.deliver();
    });
    try {
      await secondEntered;
      expect(sendCommandToAgent).toHaveBeenCalledTimes(1);
      await Promise.all(observations);
      const [attempt] = await rows();
      expect(attempt!.deviceCommandId).not.toBeNull();
      const commands = await getTestDb().select().from(deviceCommands).where(eq(deviceCommands.id, attempt!.deviceCommandId!));
      expect(commands).toHaveLength(1);
    } finally {
      releaseSecond();
      await bulk;
    }
  });

  it.each(['NO_MACS', 'NO_SUBNET', 'NO_RELAY', 'IPV6_ONLY', 'RELAY_OVERRIDE_INVALID'] as const)('%s writes a refused row with refusal_code and null relay', async code => {
    if (code !== 'NO_MACS') await seedNetwork(code === 'NO_RELAY' || code === 'RELAY_OVERRIDE_INVALID');
    if (code === 'IPV6_ONLY') await getTestDb().insert(deviceIpHistory).values({ deviceId: target, orgId, interfaceName: 'eth0', ipAddress: '2001:db8::1', ipType: 'ipv6' });
    const result = await wake(code === 'NO_RELAY' ? '' : code === 'RELAY_OVERRIDE_INVALID' ? randomUUID() : relay);
    expect(result).toMatchObject({ ok: false, code });
    const attempts = await rows();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ outcome: 'refused', refusalCode: code, relayDeviceId: null, relayHostname: null, deadlineAt: null, resolvedAt: expect.any(Date) });
  });

  it.each(['TARGET_NOT_FOUND', 'TARGET_ONLINE', 'DEVICE_PENDING_ASSIGNMENT'] as const)('%s writes no row', async code => {
    if (code === 'TARGET_NOT_FOUND') target = randomUUID();
    if (code === 'TARGET_ONLINE') await getTestDb().update(devices).set({ status: 'online', lastSeenAt: new Date() }).where(eq(devices.id, target));
    if (code === 'DEVICE_PENDING_ASSIGNMENT') {
      const holding = await seedHoldingOrg(partnerId);
      target = (await seedParkedDevice(holding.orgId, holding.siteId)).id;
    }
    expect(await wake()).toMatchObject({ ok: false, code });
    expect(await rows()).toEqual([]);
  });

  it('a failed refusal insert preserves the original failure and the caller transaction', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await withSystemDbAccessContext(async () => {
        expect(await dispatchWake(target, 'invalid-uuid')).toMatchObject({ ok: false, code: 'NO_MACS' });
        expect(await db.select().from(deviceWakeAttempts).where(eq(deviceWakeAttempts.deviceId, target))).toEqual([]);
      });
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('a foreign organization cannot update or join the target attempt', async () => {
    const { attemptId } = await open();
    const before = await rows();
    const foreignOrg = (await createOrganization({ partnerId })).id;
    const context = { scope: 'organization' as const, orgId: foreignOrg, accessibleOrgIds: [foreignOrg], accessiblePartnerIds: [], userId: null, currentPartnerId: partnerId };
    await withDbAccessContext(context, () => applyWakeRelayResult(attemptId, false));
    const denied = await withDbAccessContext(context, () => openOrJoinWakeAttempt(input())).catch(error => error);
    expect((denied as { cause?: { code?: string } }).cause?.code).toBe('42501');
    expect(await rows()).toEqual(before);
  });

  it('the owning organization can apply a relay result', async () => {
    const { attemptId } = await open();
    const context = { scope: 'organization' as const, orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
    await withDbAccessContext(context, () => applyWakeRelayResult(attemptId, true));
    expect(await rows()).toMatchObject([{ outcome: 'sent', resolvedAt: null }]);
  });

  it('a relay result through the registered handler moves the attempt', async () => {
    const { attemptId } = await open();
    const handler = commandResultHandlers.wake_on_lan!;
    const call = (stdout: string, status: string) => withSystemDbAccessContext(() => handler({
      agentId: 'relay-agent', commandId: randomUUID(),
      command: { id: randomUUID(), type: 'wake_on_lan', payload: { wakeAttemptId: attemptId } },
      result: { status }, stdout,
    } as never));
    await call(JSON.stringify({ packetsSent: 3 }), 'completed');
    expect(await rows()).toMatchObject([{ outcome: 'sent' }]);
    await getTestDb().update(deviceWakeAttempts).set({ outcome: 'pending' }).where(eq(deviceWakeAttempts.id, attemptId));
    await call(JSON.stringify({ packetsSent: 0 }), 'completed');
    expect(await rows()).toMatchObject([{ outcome: 'send_failed' }]);
  });

  it('stores the bulk id on opened and refused attempts', async () => {
    const bulkId = randomUUID();
    await withSystemDbAccessContext(() => openOrJoinWakeAttempt({ ...input(), bulkId }));
    expect(await rows()).toMatchObject([{ bulkId, outcome: 'pending' }]);
    await getTestDb().delete(deviceWakeAttempts).where(eq(deviceWakeAttempts.deviceId, target));
    expect(await withSystemDbAccessContext(() => dispatchWake(target, requestedBy, { bulkId }))).toMatchObject({ ok: false, code: 'NO_MACS' });
    expect(await rows()).toMatchObject([{ bulkId, outcome: 'refused', refusalCode: 'NO_MACS' }]);
  });

  it.each(['WS_SEND_FAILED', 'COMMAND_CANCELLED'] as const)('%s closes pending but preserves a joined sent attempt', async code => {
    await seedNetwork();
    if (code === 'WS_SEND_FAILED') vi.mocked(sendCommandToAgent).mockReturnValue(false);
    else vi.mocked(claimPendingCommandForDelivery).mockResolvedValue({ status: 'cancelled', id: randomUUID(), reason: 'device_pending_assignment' });
    expect(await wake()).toMatchObject({ ok: false, code });
    expect(await rows()).toMatchObject([{ outcome: 'send_failed', resolvedAt: expect.any(Date) }]);
    const { attemptId } = await open();
    await withSystemDbAccessContext(() => applyWakeRelayResult(attemptId, true));
    expect(await wake()).toMatchObject({ ok: false, code });
    const [joined] = (await rows()).filter(row => row.id === attemptId);
    expect(joined).toMatchObject({ outcome: 'sent', sendCount: 2, resolvedAt: null });
  });
});
