/**
 * Real-Redis integration coverage for the wave-3.5b (#4084) socket-affinity
 * command relay: fenced presence leases (`agentPresence.ts`), the sealed
 * relay envelope + at-most-once send claim + ack channel
 * (`agentCommandRelay.ts`), the api-role consumer (`agentCommandRelayWorker.ts`),
 * and the `dispatchCommandToAgent` facade's local-vs-relay branching.
 *
 * The mocked unit suites (`agentPresence.test.ts`, `agentCommandRelay.test.ts`,
 * `agentCommandRelayWorker.test.ts`) stub `./redis` and `../routes/agentWs`
 * wholesale, so they can assert shape and control flow but cannot prove:
 *   1. The Lua fencing scripts (refresh/delete-if-token-matches) actually
 *      behave correctly against a real Redis (not a hand-rolled mock of
 *      `redis.eval`), including real PTTL/PEXPIRE semantics.
 *   2. A real BullMQ Worker draining a real `agent-command-relay` queue can
 *      deliver a byte-identical `{id,type,payload}` frame to a real
 *      "socket" — the actual cross-process proof this wave exists to give
 *      (a same-process `forceRelay: true` dispatch + real consumer stands in
 *      for the true two-process split, which arrives with 3.5d's compose
 *      topology — see the plan's Self-Review Notes).
 *   3. The AAD-bound (v3) envelope really carries no plaintext into the
 *      Redis-persisted job payload, and really fails closed on a stale
 *      binding.
 *   4. The claim CAS is genuinely at-most-once against real Redis EVAL, and
 *      owner-mismatch/expiry fail the way the design demands — not just
 *      what a mocked `getRedis()` was told to return.
 *
 * No Postgres fixtures are used (presence/relay state is pure Redis), but
 * this suite still needs the full rig up because the shared `setup.ts`
 * unconditionally requires both Postgres and Redis to be reachable before
 * any file in this config runs (see `mfaStepUpGrant.integration.test.ts`'s
 * header for the identical note). `setup.ts`'s global `beforeEach` also
 * `flushdb()`s Redis before every test in this file, so each test starts
 * from an empty keyspace — this suite still closes every Worker it creates
 * per test (open BullMQ/ioredis handles don't die on a flushdb) and
 * namespaces every agentId with a per-run UUID so a shard sharing this
 * Redis with another run can't collide (#3066).
 *
 * Run:
 *   pnpm test-stack up --force   # or: docker compose -f docker-compose.test.yml up -d
 *   cd apps/api && npx vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/agentCommandRelay.integration.test.ts
 */
import './setup';

import { randomUUID } from 'crypto';
import type { Worker } from 'bullmq';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { closeRedis, getRedis } from '../../services/redis';
import { INSTANCE_ID } from '../../services/instanceIdentity';
import {
  AGENT_PRESENCE_TTL_MS,
  clearAgentPresence,
  readAgentPresence,
  refreshAgentPresence,
  setAgentPresence,
} from '../../services/agentPresence';
import {
  awaitRelayAck,
  dispatchCommandToAgent,
  getAgentCommandRelayQueue,
  markRelaySendComplete,
  openRelayCommand,
  sealRelayCommand,
  shutdownAgentCommandRelayQueue,
  type RelayEnvelopeBinding,
  type RelayJobData,
} from '../../services/agentCommandRelay';
import { createAgentCommandRelayWorker } from '../../jobs/agentCommandRelayWorker';
import { __installAgentSocketForTest } from '../../routes/agentWs';
import type { AgentCommand } from '../../routes/agentWs';

// Namespaced per invocation so a shard sharing this Redis with another
// concurrent run can never collide on the same agentId (#3066 cleanup
// discipline — see the header above and the plan's Task 9 note).
const RUN = randomUUID().slice(0, 8);
function agentId(label: string): string {
  return `agent-int-${RUN}-${label}`;
}

function installFakeSocket(id: string): string[] {
  const frames: string[] = [];
  __installAgentSocketForTest(id, { send: (data: string) => frames.push(data) });
  return frames;
}

const activeWorkers: Worker<RelayJobData>[] = [];
function startConsumer(): Worker<RelayJobData> {
  const worker = createAgentCommandRelayWorker();
  activeWorkers.push(worker);
  return worker;
}

function makeCommand(overrides: Partial<AgentCommand> = {}): AgentCommand {
  return { id: randomUUID(), type: 'network_ping', payload: { probe: true }, ...overrides };
}

afterEach(async () => {
  await Promise.all(activeWorkers.splice(0).map((w) => w.close()));
  await getAgentCommandRelayQueue().obliterate({ force: true }).catch(() => {});
});

afterAll(async () => {
  await shutdownAgentCommandRelayQueue();
  // Quit the shared BullMQ/ioredis singleton so vitest can exit.
  await closeRedis();
});

describe('agent command relay — real Redis (wave 3.5b, #4084)', () => {
  it('presence lifecycle: set/read roundtrip, token-fenced refresh/clear, PTTL bounds', async () => {
    const id = agentId('presence-1');

    await setAgentPresence(id, { instanceId: 'inst-a', connectionToken: 'tok-a' });
    expect(await readAgentPresence(id)).toEqual({ instanceId: 'inst-a', connectionToken: 'tok-a' });

    // Wrong token never refreshes or clears (fencing).
    expect(await refreshAgentPresence(id, 'wrong-token')).toBe(false);
    expect(await clearAgentPresence(id, 'wrong-token')).toBe(false);
    expect(await readAgentPresence(id)).not.toBeNull();

    // Shrink the TTL first so a refresh has something to measure — otherwise
    // the initial setAgentPresence's own PX 90000 would satisfy the same
    // bounds regardless of whether the refresh's PEXPIRE actually ran.
    const key = 'agent-presence:' + id;
    const redis = getRedis();
    expect(redis).not.toBeNull();
    await redis!.pexpire(key, 3_000);

    // Wrong token must NOT extend the shrunk TTL (fencing survives refresh too).
    expect(await refreshAgentPresence(id, 'wrong-token')).toBe(false);
    expect(await redis!.pttl(key)).toBeLessThanOrEqual(3_000);

    // Right token refreshes — and actually extends the lease back out.
    expect(await refreshAgentPresence(id, 'tok-a')).toBe(true);
    const pttl = await redis!.pttl(key);
    expect(pttl).toBeGreaterThan(AGENT_PRESENCE_TTL_MS - 5_000);
    expect(pttl).toBeLessThanOrEqual(AGENT_PRESENCE_TTL_MS);

    // Right token clears.
    expect(await clearAgentPresence(id, 'tok-a')).toBe(true);
    expect(await readAgentPresence(id)).toBeNull();
  });

  it('forced-relay E2E: exactly one frame reaches the agent, byte-identical to the command', async () => {
    const id = agentId('e2e-1');
    const frames = installFakeSocket(id);
    await setAgentPresence(id, { instanceId: INSTANCE_ID, connectionToken: 't-int' });
    startConsumer();

    const command = makeCommand();
    const outcome = await dispatchCommandToAgent(id, command, { forceRelay: true });

    expect(outcome).toEqual({ status: 'sent', via: 'relay' });
    expect(frames).toHaveLength(1);
    expect(JSON.parse(frames[0]!)).toEqual(command);
  }, 10_000);

  it('no plaintext in the queue: the raw job never contains the secret, but openRelayCommand recovers it', async () => {
    const id = agentId('plaintext-1');
    const command = makeCommand({ payload: { credential: 'sup3r-s3cret' } });
    const relayId = randomUUID();
    const binding: RelayEnvelopeBinding = {
      agentId: id, commandId: command.id, targetInstanceId: INSTANCE_ID, expiresAt: Date.now() + 5_000,
    };
    const sealedCommand = sealRelayCommand(command, binding);
    const data: RelayJobData = {
      relayId, agentId: id, commandId: command.id, targetInstanceId: binding.targetInstanceId,
      connectionToken: 'tok-plain', expiresAt: binding.expiresAt, sealedCommand,
    };
    // No consumer running — this asserts the job's AT-REST shape.
    await getAgentCommandRelayQueue().add('relay-send', data, { jobId: `relay-${relayId}` });

    const job = await getAgentCommandRelayQueue().getJob(`relay-${relayId}`);
    expect(job).toBeTruthy();
    expect(JSON.stringify(job!.data)).not.toContain('sup3r-s3cret');

    const opened = openRelayCommand(job!.data.sealedCommand, binding);
    expect(opened).toEqual(command);
  });

  it('stale presence (no socket installed) → offline, no frame', async () => {
    const id = agentId('stale-1');
    // Presence exists (an admission hint) but no socket was ever installed —
    // the consumer's own activeConnections map is authoritative.
    await setAgentPresence(id, { instanceId: INSTANCE_ID, connectionToken: 't-stale' });
    startConsumer();

    const outcome = await dispatchCommandToAgent(id, makeCommand(), { forceRelay: true });
    expect(outcome).toEqual({ status: 'offline' });
  }, 10_000);

  it('owner fencing: presence re-set to a new token between enqueue and consumer start → owner_mismatch, no frame', async () => {
    const id = agentId('fence-1');
    const frames = installFakeSocket(id);
    const command = makeCommand();
    const relayId = randomUUID();
    const expiresAt = Date.now() + 5_000;

    // The lease used to build the enqueued job's binding/connectionToken.
    await setAgentPresence(id, { instanceId: INSTANCE_ID, connectionToken: 'orig-token' });
    const binding: RelayEnvelopeBinding = { agentId: id, commandId: command.id, targetInstanceId: INSTANCE_ID, expiresAt };
    const sealedCommand = sealRelayCommand(command, binding);
    const data: RelayJobData = {
      relayId, agentId: id, commandId: command.id, targetInstanceId: INSTANCE_ID,
      connectionToken: 'orig-token', expiresAt, sealedCommand,
    };
    await getAgentCommandRelayQueue().add('relay-send', data, { jobId: `relay-${relayId}` });

    // A newer connection takes over the lease AFTER the job was built.
    await setAgentPresence(id, { instanceId: INSTANCE_ID, connectionToken: 'other-token' });

    startConsumer();
    const outcome = await awaitRelayAck(relayId, 5_000);

    expect(outcome).toEqual({ status: 'owner_mismatch' });
    expect(frames).toHaveLength(0);
  }, 10_000);

  it('expired job: consumer acks expired without sending', async () => {
    const id = agentId('expired-1');
    const frames = installFakeSocket(id);
    const command = makeCommand();
    const relayId = randomUUID();
    const binding: RelayEnvelopeBinding = {
      agentId: id, commandId: command.id, targetInstanceId: INSTANCE_ID, expiresAt: Date.now() - 1_000,
    };
    const sealedCommand = sealRelayCommand(command, binding);
    const data: RelayJobData = {
      relayId, agentId: id, commandId: command.id, targetInstanceId: INSTANCE_ID,
      connectionToken: 't-expired', expiresAt: binding.expiresAt, sealedCommand,
    };
    await getAgentCommandRelayQueue().add('relay-send', data, { jobId: `relay-${relayId}` });

    startConsumer();
    const outcome = await awaitRelayAck(relayId, 5_000);

    expect(outcome).toEqual({ status: 'expired' });
    expect(frames).toHaveLength(0);
  }, 10_000);

  it('at-most-once: a pre-marked send claim short-circuits — ack sent, ZERO new frames', async () => {
    const id = agentId('once-1');
    const frames = installFakeSocket(id);
    await setAgentPresence(id, { instanceId: INSTANCE_ID, connectionToken: 't-once' });
    const command = makeCommand();
    await markRelaySendComplete(id, command.id);
    startConsumer();

    const outcome = await dispatchCommandToAgent(id, command, { forceRelay: true });

    expect(outcome).toEqual({ status: 'sent', via: 'relay' });
    expect(frames).toHaveLength(0);
  }, 10_000);

  it('local-first: a locally-connected agent without forceRelay never touches the queue', async () => {
    const id = agentId('local-1');
    const frames = installFakeSocket(id);
    await setAgentPresence(id, { instanceId: INSTANCE_ID, connectionToken: 't-local' });

    const outcome = await dispatchCommandToAgent(id, makeCommand());

    expect(outcome).toEqual({ status: 'sent', via: 'local' });
    expect(frames).toHaveLength(1);
    expect(await getAgentCommandRelayQueue().count()).toBe(0);
  });

  it('no presence → no enqueue: forced relay on a fresh agentId is offline, queue stays empty', async () => {
    const id = agentId('nopresence-1');

    const outcome = await dispatchCommandToAgent(id, makeCommand(), { forceRelay: true });

    expect(outcome).toEqual({ status: 'offline' });
    expect(await getAgentCommandRelayQueue().count()).toBe(0);
  });
});
