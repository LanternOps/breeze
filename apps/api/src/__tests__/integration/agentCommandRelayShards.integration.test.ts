/**
 * Real-Redis coverage for #4134: the agent command relay has one BullMQ queue
 * per API instance, `agent-command-relay-<INSTANCE_ID>`, consumed only by that
 * instance, with an owner key that refuses a second consumer on one shard, a
 * drain on shutdown, and a sweep that removes the shards of instances that are
 * gone.
 *
 * Two logical API instances run in this one process. Instance A is the module
 * graph this file imports statically. A fresh module graph (vi.resetModules)
 * stands in for instance B: its own INSTANCE_ID, its own agent socket map and
 * its own Redis clients, against the same Redis. With the old single shared
 * queue, both consumers competed for every job, and a job taken by the
 * instance that does not hold the agent's socket was acked `offline` (the
 * first test below is red on that code).
 *
 * The readiness registry allows one attach per consumer name per module graph,
 * and these tests start and stop each instance's consumer per test (setup.ts
 * flushes Redis, owner keys included, before every test), so worker
 * observability is stubbed. It is not what this suite proves.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/agentCommandRelayShards.integration.test.ts
 */
import './setup';

import { randomUUID } from 'crypto';
import { Queue } from 'bullmq';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../jobs/workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

import * as redisA from '../../services/redis';
import * as presenceA from '../../services/agentPresence';
import * as relayA from '../../services/agentCommandRelay';
import * as wsA from '../../routes/agentWs';
import * as workerA from '../../jobs/agentCommandRelayWorker';
import { INSTANCE_ID } from '../../services/instanceIdentity';
import {
  RELAY_SHARD_OWNER_TTL_MS,
  relayShardOwnerKey,
  sweepDeadRelayShards,
} from '../../services/agentCommandRelayShard';
import type { AgentCommand } from '../../routes/agentWs';
import type { DispatchOutcome, RelayJobData } from '../../services/agentCommandRelay';

interface Instance {
  id: string;
  redis: typeof import('../../services/redis');
  presence: typeof import('../../services/agentPresence');
  relay: typeof import('../../services/agentCommandRelay');
  ws: typeof import('../../routes/agentWs');
  worker: typeof import('../../jobs/agentCommandRelayWorker');
}

const A: Instance = {
  id: INSTANCE_ID, redis: redisA, presence: presenceA, relay: relayA, ws: wsA, worker: workerA,
};

/** A fresh module graph: a second API process as far as the relay can tell. */
async function loadInstance(): Promise<Instance> {
  vi.resetModules();
  const [identity, redis, presence, relay, ws, worker] = await Promise.all([
    import('../../services/instanceIdentity'),
    import('../../services/redis'),
    import('../../services/agentPresence'),
    import('../../services/agentCommandRelay'),
    import('../../routes/agentWs'),
    import('../../jobs/agentCommandRelayWorker'),
  ]);
  return { id: identity.INSTANCE_ID, redis, presence, relay, ws, worker };
}

// Namespaced per run so a shard sharing this Redis cannot collide (#3066).
const RUN = randomUUID().slice(0, 8);
const agentId = (label: string) => `agent-shard-${RUN}-${label}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function installSocket(instance: Instance, id: string): string[] {
  const frames: string[] = [];
  instance.ws.__installAgentSocketForTest(id, { send: (data: string) => frames.push(data) });
  return frames;
}

function makeCommand(): AgentCommand {
  return { id: randomUUID(), type: 'network_ping', payload: { probe: true } };
}

function relayJob(relayId: string, targetInstanceId: string): RelayJobData {
  return {
    relayId,
    agentId: agentId('orphan'),
    commandId: randomUUID(),
    targetInstanceId,
    connectionToken: 'tok-orphan',
    expiresAt: Date.now() + 5_000,
    // Never opened: a drained job is acked before any consumer processes it.
    sealedCommand: 'enc:v3:never-opened',
  };
}

async function keysOf(queueName: string): Promise<string[]> {
  const redis = redisA.getRedis()!;
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', `bull:${queueName}:*`, 'COUNT', 500);
    keys.push(...batch);
    cursor = next;
  } while (cursor !== '0');
  return keys;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

let B: Instance;
const extraInstances: Instance[] = [];

beforeAll(async () => {
  B = await loadInstance();
  expect(B.id).not.toBe(A.id);
  expect(B.redis.getRedis()).not.toBe(redisA.getRedis());
});

afterEach(async () => {
  for (const instance of [A, B, ...extraInstances]) {
    await instance.worker.shutdownAgentCommandRelayWorker();
  }
});

afterAll(async () => {
  for (const instance of [...extraInstances, B, A]) {
    await instance.relay.shutdownAgentCommandRelayQueue();
    await instance.redis.closeRedis();
  }
});

describe('agent command relay shards — two API instances, real Redis (#4134)', () => {
  it('each instance consumes only its own shard: 40 relayed sends from both producers all reach the owning socket once', async () => {
    await A.worker.initializeAgentCommandRelayWorker();
    await B.worker.initializeAgentCommandRelayWorker();
    const onA = agentId('on-a');
    const onB = agentId('on-b');
    const framesA = installSocket(A, onA);
    const framesB = installSocket(B, onB);
    await A.presence.setAgentPresence(onA, { instanceId: A.id, connectionToken: 'tok-a' });
    await A.presence.setAgentPresence(onB, { instanceId: B.id, connectionToken: 'tok-b' });

    const sends: Array<{ producer: Instance; target: string; command: AgentCommand }> = [];
    for (let i = 0; i < 10; i += 1) {
      for (const producer of [A, B]) {
        for (const target of [onA, onB]) sends.push({ producer, target, command: makeCommand() });
      }
    }
    // forceRelay: even an agent local to the producer goes through the relay.
    const outcomes = await Promise.all(sends.map(({ producer, target, command }) =>
      producer.relay.dispatchCommandToAgent(target, command, { forceRelay: true })));

    expect(outcomes).toEqual(sends.map((): DispatchOutcome => ({ status: 'sent', via: 'relay' })));
    const idsFor = (target: string) => sends.filter((s) => s.target === target).map((s) => s.command.id).sort();
    expect(framesA.map((f) => (JSON.parse(f) as AgentCommand).id).sort()).toEqual(idsFor(onA));
    expect(framesB.map((f) => (JSON.parse(f) as AgentCommand).id).sort()).toEqual(idsFor(onB));

    // One queue per instance; nothing on the old shared queue.
    expect((await keysOf(relayA.agentCommandRelayQueueName(A.id))).length).toBeGreaterThan(0);
    expect((await keysOf(relayA.agentCommandRelayQueueName(B.id))).length).toBeGreaterThan(0);
    expect(await keysOf(relayA.LEGACY_AGENT_COMMAND_RELAY_QUEUE)).toEqual([]);
  }, 20_000);

  it('a second consumer for a shard another consumer holds refuses to start; the owner keeps its key and keeps delivering', async () => {
    await A.worker.initializeAgentCommandRelayWorker();
    const redis = redisA.getRedis()!;
    const ownerKey = relayShardOwnerKey(A.id);
    const token = await redis.get(ownerKey);
    expect(token).toMatch(UUID);
    const pttl = await redis.pttl(ownerKey);
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(RELAY_SHARD_OWNER_TTL_MS);

    // Another process that boots with the same instance id.
    vi.doMock('../../services/instanceIdentity', () => ({ INSTANCE_ID: A.id }));
    const C = await loadInstance();
    vi.doUnmock('../../services/instanceIdentity');
    extraInstances.push(C);
    expect(C.id).toBe(A.id);

    await expect(C.worker.initializeAgentCommandRelayWorker()).rejects.toBeInstanceOf(C.worker.RelayShardConflictError);
    expect(await redis.get(ownerKey)).toBe(token);

    const target = agentId('owner');
    const frames = installSocket(A, target);
    await A.presence.setAgentPresence(target, { instanceId: A.id, connectionToken: 'tok-owner' });
    await expect(A.relay.dispatchCommandToAgent(target, makeCommand(), { forceRelay: true }))
      .resolves.toEqual({ status: 'sent', via: 'relay' });
    expect(frames).toHaveLength(1);
  }, 20_000);

  it('shutdown drains its shard: a waiting send is answered owner_mismatch at once, and no key of the shard is left', async () => {
    const D = await loadInstance();
    extraInstances.push(D);
    await D.worker.initializeAgentCommandRelayWorker();
    const shard = relayA.agentCommandRelayQueueName(D.id);
    // Hold the job in the queue: the consumer is up but takes nothing.
    await D.relay.getAgentCommandRelayQueue(D.id).pause();

    const target = agentId('drain');
    await A.presence.setAgentPresence(target, { instanceId: D.id, connectionToken: 'tok-drain' });
    const started = Date.now();
    const pending = A.relay.dispatchCommandToAgent(target, makeCommand(), { forceRelay: true });
    await waitFor(async () => (await D.relay.getAgentCommandRelayQueue(D.id).count()) === 1);

    await D.worker.shutdownAgentCommandRelayWorker();

    await expect(pending).resolves.toEqual({ status: 'owner_mismatch' });
    expect(Date.now() - started).toBeLessThan(relayA.RELAY_DELIVERY_DEADLINE_MS);
    expect(await keysOf(shard)).toEqual([]);
    expect(await redisA.getRedis()!.get(relayShardOwnerKey(D.id))).toBeNull();
  }, 20_000);

  it('the sweep removes a gone instance\'s shard and the legacy shared queue after two ownerless passes; a live shard survives', async () => {
    await A.worker.initializeAgentCommandRelayWorker();
    await B.worker.initializeAgentCommandRelayWorker();
    // B's shard exists in Redis and has an owner.
    const onB = agentId('live-b');
    const framesB = installSocket(B, onB);
    await A.presence.setAgentPresence(onB, { instanceId: B.id, connectionToken: 'tok-live' });
    await expect(A.relay.dispatchCommandToAgent(onB, makeCommand(), { forceRelay: true }))
      .resolves.toEqual({ status: 'sent', via: 'relay' });

    // An instance that crashed: its queue holds a job and its owner key is gone.
    const deadId = `dead-${RUN}`;
    const deadShard = relayA.agentCommandRelayQueueName(deadId);
    const deadRelayId = randomUUID();
    await A.relay.getAgentCommandRelayQueue(deadId)
      .add('relay-send', relayJob(deadRelayId, deadId), { jobId: `relay-${deadRelayId}` });
    // A job an older build left on the old shared queue.
    const legacyRelayId = randomUUID();
    const legacy = new Queue<RelayJobData>(relayA.LEGACY_AGENT_COMMAND_RELAY_QUEUE, {
      connection: redisA.getBullMQConnection(),
    });
    await legacy.add('relay-send', relayJob(legacyRelayId, 'old-instance'), { jobId: `relay-${legacyRelayId}` });
    await legacy.close();
    const expected = [relayA.LEGACY_AGENT_COMMAND_RELAY_QUEUE, deadShard].sort();

    const first = await sweepDeadRelayShards(A.id, new Set());
    expect(first.reaped).toEqual([]);
    expect([...first.suspects].sort()).toEqual(expected);
    expect((await keysOf(deadShard)).length).toBeGreaterThan(0);

    const second = await sweepDeadRelayShards(A.id, first.suspects);
    expect(second.reaped.sort()).toEqual(expected);
    expect(second.suspects.size).toBe(0);

    await expect(relayA.awaitRelayAck(deadRelayId, 1_000)).resolves.toEqual({ status: 'owner_mismatch' });
    await expect(relayA.awaitRelayAck(legacyRelayId, 1_000)).resolves.toEqual({ status: 'owner_mismatch' });
    expect(await keysOf(deadShard)).toEqual([]);
    expect(await keysOf(relayA.LEGACY_AGENT_COMMAND_RELAY_QUEUE)).toEqual([]);

    // The live shard is untouched and still delivers.
    expect((await keysOf(relayA.agentCommandRelayQueueName(B.id))).length).toBeGreaterThan(0);
    await expect(A.relay.dispatchCommandToAgent(onB, makeCommand(), { forceRelay: true }))
      .resolves.toEqual({ status: 'sent', via: 'relay' });
    expect(framesB).toHaveLength(2);
  }, 20_000);
});
