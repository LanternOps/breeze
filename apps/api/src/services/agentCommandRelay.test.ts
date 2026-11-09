import { beforeEach, describe, expect, it, vi } from 'vitest';

const redisMock = { set: vi.fn(), get: vi.fn(), eval: vi.fn(), exists: vi.fn() };
vi.mock('./redis', () => ({
  getRedis: vi.fn(() => redisMock),
  getRedisConnection: vi.fn(() => redisMock),
  getBullMQConnection: vi.fn(() => redisMock),
}));

vi.mock('../routes/agentWs', () => ({
  isAgentConnected: vi.fn(),
  sendCommandToAgent: vi.fn(),
}));
vi.mock('./agentPresence', () => ({
  readAgentPresence: vi.fn(),
  probeAgentPresence: vi.fn(),
}));
vi.mock('../db', () => ({
  hasDbAccessContext: vi.fn(() => false),
}));
vi.mock('./bullmqQueue', () => ({
  createInstrumentedQueue: vi.fn(),
}));
vi.mock('../config/env', () => ({
  breezeRole: vi.fn(() => 'all'),
}));

// Key setup so secretCrypto can do real AES roundtrips in unit tests. AAD
// binding requires v3 (AAD-bound) ciphertext, which only happens when a key
// id is configured — encryptSecret otherwise silently drops to the v1 fallback
// and IGNORES aad entirely (see scriptSecretEnvelope.ts's identical guard).
// Mirrors sensitiveCommandPayload.test.ts:4-8.
process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY || 'test-only-app-encryption-key-32chars!';
process.env.APP_ENCRYPTION_KEY_ID = 'current';
process.env.APP_ENCRYPTION_KEYRING = JSON.stringify({ current: 'current-key-material' });

import {
  __resetRelayRedisFailureLogForTests,
  agentCommandRelayQueueName,
  awaitRelayAck,
  claimRelaySend,
  agentReachability,
  dispatchCommandToAgent,
  dispatchDisposition,
  getAgentCommandRelayQueue,
  isAgentConnectedAnywhere,
  isRelayShardLive,
  LEGACY_AGENT_COMMAND_RELAY_QUEUE,
  logRelayRedisFailure,
  markRelaySendComplete,
  openRelayCommand,
  RELAY_DELIVERY_DEADLINE_MS,
  RELAY_QUEUE_EVENTS_MAX_LEN,
  RELAY_TRANSPORT_DEADLINE_MS,
  relayQueueOwner,
  releaseRelaySendClaim,
  relayShardOwnerKey,
  sealRelayCommand,
  shutdownAgentCommandRelayQueue,
  writeRelayAck,
} from './agentCommandRelay';
import { isAgentConnected, sendCommandToAgent } from '../routes/agentWs';
import { probeAgentPresence, readAgentPresence } from './agentPresence';
import { hasDbAccessContext } from '../db';
import { createInstrumentedQueue } from './bullmqQueue';
import { breezeRole } from '../config/env';

const BINDING = {
  agentId: 'agent-1',
  commandId: 'cmd-1',
  targetInstanceId: 'inst-1',
  expiresAt: 1_700_000_000_000,
};

describe('relay shard queue names (#4134)', () => {
  it('names one queue per instance; BullMQ forbids ":" so the separator is "-"', () => {
    expect(agentCommandRelayQueueName('0f8b2c1e-7d4a-4a3b-9c2d-1e2f3a4b5c6d'))
      .toBe('agent-command-relay-0f8b2c1e-7d4a-4a3b-9c2d-1e2f3a4b5c6d');
    expect(LEGACY_AGENT_COMMAND_RELAY_QUEUE).toBe('agent-command-relay');
  });

  it.each(['', 'a:b', 'a b', 'x'.repeat(65), '../x', 'a*'])('rejects an instance id that cannot name a shard: %j', (id) => {
    expect(() => agentCommandRelayQueueName(id)).toThrow(/instance id/);
  });

  it('parses a shard name back to its instance and the legacy queue to legacy; anything else is not a relay queue', () => {
    expect(relayQueueOwner('agent-command-relay-inst-1')).toEqual({ kind: 'shard', instanceId: 'inst-1' });
    expect(relayQueueOwner('agent-command-relay')).toEqual({ kind: 'legacy' });
    expect(relayQueueOwner('agent-command-relay-')).toBeNull();
    expect(relayQueueOwner('agent-command-relay-a:b')).toBeNull();
    expect(relayQueueOwner('agent-command-relayx')).toBeNull();
    expect(relayQueueOwner('event-dispatch')).toBeNull();
  });
});

describe('shard liveness and failure logging (#4134)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRelayRedisFailureLogForTests();
  });

  it('a shard is live while its owner key exists; a read error counts as live', async () => {
    redisMock.exists.mockResolvedValueOnce(1).mockResolvedValueOnce(0).mockRejectedValueOnce(new Error('down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(isRelayShardLive('inst-1')).resolves.toBe(true);
    await expect(isRelayShardLive('inst-1')).resolves.toBe(false);
    await expect(isRelayShardLive('inst-1')).resolves.toBe(true);

    expect(redisMock.exists).toHaveBeenCalledWith('agent-relay-shard:inst-1');
    expect(relayShardOwnerKey('inst-1')).toBe('agent-relay-shard:inst-1');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('relay shard liveness read failed'), 'down');
    warn.mockRestore();
  });

  it('logs a failing operation at most once a minute, then reports how many were suppressed', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      logRelayRedisFailure('op', new Error('e1'));
      logRelayRedisFailure('op', new Error('e2'));
      logRelayRedisFailure('op', new Error('e3'));
      logRelayRedisFailure('other op', new Error('x'));
      expect(warn).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(60_000);
      logRelayRedisFailure('op', new Error('e4'));
      expect(warn).toHaveBeenCalledTimes(3);
      expect(warn.mock.calls[2]?.[0]).toContain('2 more since the last report');
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('relay envelope', () => {
  const command = {
    id: 'cmd-1',
    type: 'snmp_poll',
    payload: { community: 'sup3r-s3cret', oids: ['1.3.6.1'] },
  };

  it('roundtrips a command and produces NO plaintext payload in the sealed string', () => {
    const sealed = sealRelayCommand(command, BINDING);
    expect(sealed).not.toContain('sup3r-s3cret');
    expect(sealed).not.toContain('snmp_poll');
    expect(openRelayCommand(sealed, BINDING)).toEqual(command);
  });

  it('fails closed when any bound field is tampered', () => {
    const sealed = sealRelayCommand(command, BINDING);
    expect(() => openRelayCommand(sealed, { ...BINDING, agentId: 'agent-2' })).toThrow();
    expect(() => openRelayCommand(sealed, { ...BINDING, expiresAt: BINDING.expiresAt + 1 })).toThrow();
    expect(() => openRelayCommand(`${sealed}x`, BINDING)).toThrow();
  });
});

describe('send claims (at-most-once)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps Lua results: fresh claim → claimed, sent marker → already-sent, live claim → in-flight', async () => {
    redisMock.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(2).mockResolvedValueOnce(0);
    expect(await claimRelaySend('agent-1', 'cmd-1')).toBe('claimed');
    expect(await claimRelaySend('agent-1', 'cmd-1')).toBe('already-sent');
    expect(await claimRelaySend('agent-1', 'cmd-1')).toBe('in-flight');
    expect(redisMock.eval.mock.calls[0]?.[2]).toBe('agent-relay-claim:agent-1:cmd-1');
  });

  it('claim helpers throw on Redis failure (the consumer must NOT treat unknown claim state as claimable)', async () => {
    redisMock.eval.mockRejectedValueOnce(new Error('down'));
    await expect(claimRelaySend('agent-1', 'cmd-1')).rejects.toThrow();
  });

  it('markRelaySendComplete promotes the claim to sent with a long TTL', async () => {
    await markRelaySendComplete('agent-1', 'cmd-1');
    expect(redisMock.set).toHaveBeenCalledWith('agent-relay-claim:agent-1:cmd-1', 'sent', 'PX', 600_000);
  });
});

describe('acks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writeRelayAck stores the outcome JSON with a TTL', async () => {
    await writeRelayAck('r-1', { status: 'sent', via: 'relay' });
    expect(redisMock.set).toHaveBeenCalledWith(
      'agent-relay-ack:r-1', JSON.stringify({ status: 'sent', via: 'relay' }), 'PX', 30_000,
    );
  });

  it('awaitRelayAck polls GET until the ack appears', async () => {
    redisMock.get.mockResolvedValueOnce(null).mockResolvedValueOnce(JSON.stringify({ status: 'offline' }));
    await expect(awaitRelayAck('r-1', 1_000)).resolves.toEqual({ status: 'offline' });
  });

  // #4142: an ack this build cannot read says nothing it can trust about the
  // send. Callers that branch on `status` directly must see `indeterminate`.
  it('awaitRelayAck maps an unknown ack status to indeterminate', async () => {
    redisMock.get.mockResolvedValueOnce(JSON.stringify({ status: 'evicted' }));
    await expect(awaitRelayAck('r-1', 1_000)).resolves.toEqual({ status: 'indeterminate' });
  });

  it('awaitRelayAck treats a null ack body as unknown (indeterminate)', async () => {
    redisMock.get.mockResolvedValueOnce('null');
    await expect(awaitRelayAck('r-1', 1_000)).resolves.toEqual({ status: 'indeterminate' });
  });

  it('awaitRelayAck returns indeterminate at the deadline', async () => {
    redisMock.get.mockResolvedValue(null);
    await expect(awaitRelayAck('r-1', 250)).resolves.toEqual({ status: 'indeterminate' });
  });
});

describe('dispatchCommandToAgent facade', () => {
  const command = { id: 'cmd-9', type: 'snmp_poll', payload: { community: 'sup3r-s3cret' } };
  let fakeQueue: { add: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(breezeRole).mockReturnValue('all');
    fakeQueue = { add: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(createInstrumentedQueue).mockReturnValue(fakeQueue as never);
    // Every target shard has a consumer unless a test says otherwise.
    redisMock.exists.mockResolvedValue(1);
    // Handles live at module scope — force fresh ones per test so fakeQueue is
    // actually the one exercised.
    await shutdownAgentCommandRelayQueue();
  });

  it('a lease naming an instance whose shard has no owner key → offline at once: no queue built, no enqueue', async () => {
    vi.mocked(isAgentConnected).mockReturnValue(false);
    vi.mocked(readAgentPresence).mockResolvedValue({ instanceId: 'inst-gone', connectionToken: 'tok-9' });
    redisMock.exists.mockResolvedValue(0);

    await expect(dispatchCommandToAgent('agent-1', command)).resolves.toEqual({ status: 'offline' });

    expect(redisMock.exists).toHaveBeenCalledWith('agent-relay-shard:inst-gone');
    expect(createInstrumentedQueue).not.toHaveBeenCalled();
    expect(redisMock.get).not.toHaveBeenCalled();
  });

  it('a failed owner-key read does not block the relay: it enqueues as before', async () => {
    vi.mocked(isAgentConnected).mockReturnValue(false);
    vi.mocked(readAgentPresence).mockResolvedValue({ instanceId: 'inst-9', connectionToken: 'tok-9' });
    redisMock.exists.mockRejectedValue(new Error('timeout'));
    redisMock.get.mockResolvedValueOnce(JSON.stringify({ status: 'sent', via: 'relay' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(dispatchCommandToAgent('agent-1', command)).resolves.toEqual({ status: 'sent', via: 'relay' });
    expect(fakeQueue.add).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('keeps at most 32 producer handles, closing the least recently used one', async () => {
    const handles = new Map<string, Array<{ add: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>>();
    vi.mocked(createInstrumentedQueue).mockImplementation(((name: string) => {
      const q = { add: vi.fn(), close: vi.fn().mockResolvedValue(undefined) };
      handles.set(name, [...(handles.get(name) ?? []), q]);
      return q;
    }) as never);
    const name = (i: number) => `agent-command-relay-inst-${i}`;

    for (let i = 0; i < 32; i += 1) getAgentCommandRelayQueue(`inst-${i}`);
    getAgentCommandRelayQueue('inst-0'); // touched: now the most recently used
    getAgentCommandRelayQueue('inst-32'); // 33rd handle evicts inst-1, not inst-0

    expect(handles.get(name(1))?.[0]?.close).toHaveBeenCalledTimes(1);
    expect(handles.get(name(0))?.[0]?.close).not.toHaveBeenCalled();
    expect(createInstrumentedQueue).toHaveBeenCalledTimes(33);

    getAgentCommandRelayQueue('inst-1'); // rebuilt after eviction
    expect(handles.get(name(1))).toHaveLength(2);

    await shutdownAgentCommandRelayQueue();
    for (const [, built] of handles) expect(built[built.length - 1]?.close).toHaveBeenCalled();
    getAgentCommandRelayQueue('inst-0'); // the map was emptied: a fresh handle
    expect(handles.get(name(0))).toHaveLength(2);
  });

  it('local socket + send ok → sent/local, no presence read, no enqueue', async () => {
    vi.mocked(isAgentConnected).mockReturnValue(true);
    vi.mocked(sendCommandToAgent).mockReturnValue(true);

    await expect(dispatchCommandToAgent('agent-1', command)).resolves.toEqual({ status: 'sent', via: 'local' });
    expect(readAgentPresence).not.toHaveBeenCalled();
    expect(fakeQueue.add).not.toHaveBeenCalled();
  });

  it('local socket + sendCommandToAgent false → offline, no enqueue', async () => {
    vi.mocked(isAgentConnected).mockReturnValue(true);
    vi.mocked(sendCommandToAgent).mockReturnValue(false);

    await expect(dispatchCommandToAgent('agent-1', command)).resolves.toEqual({ status: 'offline' });
    expect(fakeQueue.add).not.toHaveBeenCalled();
  });

  it('no local socket + no presence → offline, no enqueue', async () => {
    vi.mocked(isAgentConnected).mockReturnValue(false);
    vi.mocked(readAgentPresence).mockResolvedValue(null);

    await expect(dispatchCommandToAgent('agent-1', command)).resolves.toEqual({ status: 'offline' });
    expect(fakeQueue.add).not.toHaveBeenCalled();
  });

  it('no local socket + presence exists → enqueues a sealed relay job and resolves via the ack', async () => {
    vi.mocked(isAgentConnected).mockReturnValue(false);
    vi.mocked(readAgentPresence).mockResolvedValue({ instanceId: 'inst-9', connectionToken: 'tok-9' });
    redisMock.get.mockResolvedValueOnce(JSON.stringify({ status: 'sent', via: 'relay' }));

    const before = Date.now();
    const result = await dispatchCommandToAgent('agent-1', command, { priority: 'probe' });
    expect(result).toEqual({ status: 'sent', via: 'relay' });

    expect(fakeQueue.add).toHaveBeenCalledTimes(1);
    const [jobName, data, jobOpts] = fakeQueue.add.mock.calls[0]!;
    expect(jobName).toBe('relay-send');
    expect(jobOpts.jobId).toMatch(/^relay-[0-9a-f-]{36}$/);
    expect(jobOpts.attempts).toBe(1);
    expect(jobOpts.priority).toBe(1);
    expect(data.agentId).toBe('agent-1');
    expect(data.commandId).toBe('cmd-9');
    expect(data.targetInstanceId).toBe('inst-9');
    expect(data.connectionToken).toBe('tok-9');
    expect(data.sealedCommand).not.toContain('sup3r-s3cret');
    expect(data.expiresAt).toBeGreaterThanOrEqual(before + RELAY_DELIVERY_DEADLINE_MS);
    expect(data.expiresAt).toBeLessThanOrEqual(Date.now() + RELAY_DELIVERY_DEADLINE_MS);
  });

  it('default priority (no opts) enqueues at priority 10', async () => {
    vi.mocked(isAgentConnected).mockReturnValue(false);
    vi.mocked(readAgentPresence).mockResolvedValue({ instanceId: 'inst-9', connectionToken: 'tok-9' });
    redisMock.get.mockResolvedValueOnce(JSON.stringify({ status: 'sent', via: 'relay' }));

    await dispatchCommandToAgent('agent-1', command);
    expect(fakeQueue.add.mock.calls[0]?.[2].priority).toBe(10);
  });

  it('queue.add throws synchronously (never issued) → infrastructure_error, no ack wait', async () => {
    vi.mocked(isAgentConnected).mockReturnValue(false);
    vi.mocked(readAgentPresence).mockResolvedValue({ instanceId: 'inst-9', connectionToken: 'tok-9' });
    fakeQueue.add.mockImplementationOnce(() => { throw new Error('redis down'); });

    const result = await dispatchCommandToAgent('agent-1', command);
    expect(result.status).toBe('infrastructure_error');
    expect((result as { message: string }).message).toContain('redis down');
    expect(redisMock.get).not.toHaveBeenCalled();
  });

  // #4142 W1.T2: Redis may have stored the job before the reply was lost, so a
  // consumer can still send it. Releasing the caller's claim then could deliver
  // the command twice.
  it('an enqueue that rejects after being issued is indeterminate, not infrastructure_error', async () => {
    vi.mocked(isAgentConnected).mockReturnValue(false);
    vi.mocked(readAgentPresence).mockResolvedValue({ instanceId: 'inst-9', connectionToken: 'tok-9' });
    fakeQueue.add.mockRejectedValueOnce(new Error('connection reset'));

    await expect(dispatchCommandToAgent('agent-1', command)).resolves.toEqual({ status: 'indeterminate' });
    expect(redisMock.get).not.toHaveBeenCalled();
  });

  it('an enqueue that never settles returns indeterminate within RELAY_TRANSPORT_DEADLINE_MS', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(isAgentConnected).mockReturnValue(false);
      vi.mocked(readAgentPresence).mockResolvedValue({ instanceId: 'inst-9', connectionToken: 'tok-9' });
      fakeQueue.add.mockReturnValueOnce(new Promise(() => {}));
      let settled: unknown;
      const pending = dispatchCommandToAgent('agent-1', command).then((r) => { settled = r; });

      await vi.advanceTimersByTimeAsync(RELAY_TRANSPORT_DEADLINE_MS - 1);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(settled).toEqual({ status: 'indeterminate' });
      expect(redisMock.get).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('an ack wait that outruns the budget answers indeterminate at the absolute deadline, not later', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(isAgentConnected).mockReturnValue(false);
      vi.mocked(readAgentPresence).mockResolvedValue({ instanceId: 'inst-9', connectionToken: 'tok-9' });
      // Every ack read hangs: only the absolute budget can end the wait.
      redisMock.get.mockReturnValue(new Promise(() => {}));
      let settled: unknown;
      const pending = dispatchCommandToAgent('agent-1', command).then((r) => { settled = r; });

      await vi.advanceTimersByTimeAsync(RELAY_TRANSPORT_DEADLINE_MS);
      await pending;
      expect(settled).toEqual({ status: 'indeterminate' });
    } finally {
      redisMock.get.mockReset();
      vi.useRealTimers();
    }
  });

  it('presence reads that hang past the budget answer infrastructure_error: nothing was enqueued', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(isAgentConnected).mockReturnValue(false);
      vi.mocked(readAgentPresence).mockReturnValueOnce(new Promise(() => {}));
      let settled: { status: string } | undefined;
      const pending = dispatchCommandToAgent('agent-1', command).then((r) => { settled = r; });

      await vi.advanceTimersByTimeAsync(RELAY_TRANSPORT_DEADLINE_MS);
      await pending;
      expect(settled?.status).toBe('infrastructure_error');
      expect(fakeQueue.add).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a shard check that hangs past the budget answers infrastructure_error: nothing was enqueued', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(isAgentConnected).mockReturnValue(false);
      vi.mocked(readAgentPresence).mockResolvedValue({ instanceId: 'inst-9', connectionToken: 'tok-9' });
      redisMock.exists.mockReturnValueOnce(new Promise(() => {}));
      let settled: { status: string; message?: string } | undefined;
      const pending = dispatchCommandToAgent('agent-1', command).then((r) => { settled = r as typeof settled; });

      await vi.advanceTimersByTimeAsync(RELAY_TRANSPORT_DEADLINE_MS);
      await pending;
      expect(settled?.status).toBe('infrastructure_error');
      expect(settled?.message).toMatch(/shard check/);
      expect(fakeQueue.add).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a held-DB-context refusal is logged (rate-limited), so a silent heartbeat fallback is visible', async () => {
    __resetRelayRedisFailureLogForTests();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(isAgentConnected).mockReturnValue(false);
    vi.mocked(hasDbAccessContext).mockReturnValue(true);
    try {
      await dispatchCommandToAgent('agent-1', command);
      await dispatchCommandToAgent('agent-1', command);
      const refusals = warn.mock.calls.filter((c) => String(c[0]).includes('held DB context'));
      expect(refusals).toHaveLength(1);
    } finally {
      vi.mocked(hasDbAccessContext).mockReturnValue(false);
      warn.mockRestore();
    }
  });

  it('refuses to relay inside a held DB context: infrastructure_error, no presence read, no enqueue, no ack wait', async () => {
    vi.mocked(isAgentConnected).mockReturnValue(false);
    vi.mocked(hasDbAccessContext).mockReturnValueOnce(true);
    vi.mocked(readAgentPresence).mockResolvedValue({ instanceId: 'inst-9', connectionToken: 'tok-9' });

    const result = await dispatchCommandToAgent('agent-1', command);

    expect(result.status).toBe('infrastructure_error');
    expect((result as { message: string }).message).toMatch(/held DB context/);
    expect(readAgentPresence).not.toHaveBeenCalled();
    expect(fakeQueue.add).not.toHaveBeenCalled();
    expect(redisMock.get).not.toHaveBeenCalled();
  });

  it('a held DB context does not block the local-first send (no Redis, no wait)', async () => {
    vi.mocked(hasDbAccessContext).mockReturnValue(true);
    try {
      vi.mocked(isAgentConnected).mockReturnValue(true);
      vi.mocked(sendCommandToAgent).mockReturnValue(true);
      await expect(dispatchCommandToAgent('agent-1', command)).resolves.toEqual({ status: 'sent', via: 'local' });
    } finally {
      vi.mocked(hasDbAccessContext).mockReturnValue(false);
    }
  });

  it('never rejects: an unexpected throw before enqueue is infrastructure_error', async () => {
    vi.mocked(isAgentConnected).mockImplementationOnce(() => { throw new Error('socket map exploded'); });

    const result = await dispatchCommandToAgent('agent-1', command);
    expect(result.status).toBe('infrastructure_error');
    expect((result as { message: string }).message).toContain('socket map exploded');
  });

  it('never rejects: an unexpected throw after the enqueue was issued is indeterminate', async () => {
    vi.mocked(isAgentConnected).mockReturnValue(false);
    vi.mocked(readAgentPresence).mockResolvedValue({ instanceId: 'inst-9', connectionToken: 'tok-9' });
    // The ack poll cannot even get a client: a throw its own catch cannot absorb.
    const realGetRedis = (await import('./redis')).getRedis;
    vi.mocked(realGetRedis).mockImplementationOnce(() => redisMock as never) // isRelayShardLive
      .mockImplementationOnce(() => { throw new Error('redis client gone'); }); // awaitRelayAck

    await expect(dispatchCommandToAgent('agent-1', command)).resolves.toEqual({ status: 'indeterminate' });
    expect(fakeQueue.add).toHaveBeenCalledTimes(1);
  });

  it('sealRelayCommand throws (no APP_ENCRYPTION_KEY_ID) → infrastructure_error, not offline, no enqueue', async () => {
    vi.mocked(isAgentConnected).mockReturnValue(false);
    vi.mocked(readAgentPresence).mockResolvedValue({ instanceId: 'inst-9', connectionToken: 'tok-9' });
    const priorKeyId = process.env.APP_ENCRYPTION_KEY_ID;
    delete process.env.APP_ENCRYPTION_KEY_ID;
    try {
      const result = await dispatchCommandToAgent('agent-1', command);
      expect(result.status).toBe('infrastructure_error');
      expect((result as { message: string }).message).toMatch(/seal/i);
    } finally {
      process.env.APP_ENCRYPTION_KEY_ID = priorKeyId;
    }
    expect(fakeQueue.add).not.toHaveBeenCalled();
  });

  // #4134: one queue per boot instance. A shared queue let any api consumer
  // take a job for a socket it does not own (acked owner_mismatch/offline).
  it('routes the relay job to the lease owner instance\'s own shard queue, with a capped event stream', async () => {
    vi.mocked(isAgentConnected).mockReturnValue(false);
    vi.mocked(readAgentPresence).mockResolvedValue({ instanceId: 'inst-9', connectionToken: 'tok-9' });
    redisMock.get.mockResolvedValueOnce(JSON.stringify({ status: 'sent', via: 'relay' }));

    await dispatchCommandToAgent('agent-1', command);

    expect(createInstrumentedQueue).toHaveBeenCalledTimes(1);
    expect(createInstrumentedQueue).toHaveBeenCalledWith('agent-command-relay-inst-9', {
      streams: { events: { maxLen: RELAY_QUEUE_EVENTS_MAX_LEN } },
    });
    expect(fakeQueue.add).toHaveBeenCalledTimes(1);
  });

  it('two agents owned by two instances → each job lands on its owner\'s shard; a repeat target reuses its queue', async () => {
    const queues = new Map<string, { add: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }>();
    vi.mocked(createInstrumentedQueue).mockImplementation(((name: string) => {
      const q = { add: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
      queues.set(name, q);
      return q;
    }) as never);
    vi.mocked(isAgentConnected).mockReturnValue(false);
    vi.mocked(readAgentPresence).mockImplementation(async (id: string) => (
      id === 'agent-a'
        ? { instanceId: 'inst-a', connectionToken: 'tok-a' }
        : { instanceId: 'inst-b', connectionToken: 'tok-b' }
    ));
    const sentAck = JSON.stringify({ status: 'sent', via: 'relay' });
    redisMock.get.mockResolvedValueOnce(sentAck).mockResolvedValueOnce(sentAck).mockResolvedValueOnce(sentAck);

    await dispatchCommandToAgent('agent-a', command);
    await dispatchCommandToAgent('agent-b', command);
    await dispatchCommandToAgent('agent-a', command);

    expect([...queues.keys()].sort()).toEqual(['agent-command-relay-inst-a', 'agent-command-relay-inst-b']);
    const a = queues.get('agent-command-relay-inst-a')!;
    const b = queues.get('agent-command-relay-inst-b')!;
    expect(a.add).toHaveBeenCalledTimes(2);
    expect(b.add).toHaveBeenCalledTimes(1);
    expect(a.add.mock.calls.map((c) => c[1].targetInstanceId)).toEqual(['inst-a', 'inst-a']);
    expect(b.add.mock.calls[0]?.[1].targetInstanceId).toBe('inst-b');
  });

  it('a lease instance id that cannot name a queue → infrastructure_error, no queue built, no enqueue', async () => {
    vi.mocked(isAgentConnected).mockReturnValue(false);
    vi.mocked(readAgentPresence).mockResolvedValue({ instanceId: 'bad:id', connectionToken: 'tok-9' });

    const result = await dispatchCommandToAgent('agent-1', command);

    expect(result.status).toBe('infrastructure_error');
    expect((result as { message: string }).message).toMatch(/enqueue/);
    expect(createInstrumentedQueue).not.toHaveBeenCalled();
    expect(fakeQueue.add).not.toHaveBeenCalled();
  });

  it('forceRelay:true skips the local-first branch even when a local socket exists', async () => {
    vi.mocked(isAgentConnected).mockReturnValue(true);
    vi.mocked(readAgentPresence).mockResolvedValue({ instanceId: 'inst-9', connectionToken: 'tok-9' });
    redisMock.get.mockResolvedValueOnce(JSON.stringify({ status: 'sent', via: 'relay' }));

    await dispatchCommandToAgent('agent-1', command, { forceRelay: true });
    expect(sendCommandToAgent).not.toHaveBeenCalled();
    expect(fakeQueue.add).toHaveBeenCalledTimes(1);
  });

  describe('isAgentConnectedAnywhere', () => {
    it('local hit → true, no presence read', async () => {
      vi.mocked(isAgentConnected).mockReturnValue(true);
      await expect(isAgentConnectedAnywhere('agent-1')).resolves.toBe(true);
      expect(readAgentPresence).not.toHaveBeenCalled();
    });

    it('local miss + presence → true', async () => {
      vi.mocked(isAgentConnected).mockReturnValue(false);
      vi.mocked(readAgentPresence).mockResolvedValue({ instanceId: 'i', connectionToken: 't' });
      await expect(isAgentConnectedAnywhere('agent-1')).resolves.toBe(true);
    });

    it('both miss → false', async () => {
      vi.mocked(isAgentConnected).mockReturnValue(false);
      vi.mocked(readAgentPresence).mockResolvedValue(null);
      await expect(isAgentConnectedAnywhere('agent-1')).resolves.toBe(false);
    });

    it('under BREEZE_ROLE=worker skips the socket-local check entirely', async () => {
      vi.mocked(breezeRole).mockReturnValue('worker');
      vi.mocked(readAgentPresence).mockResolvedValue({ instanceId: 'i', connectionToken: 't' });
      await expect(isAgentConnectedAnywhere('agent-1')).resolves.toBe(true);
      expect(isAgentConnected).not.toHaveBeenCalled();
    });
  });
});

describe('dispatchDisposition (#4142 W1.T2)', () => {
  it.each([
    [{ status: 'sent', via: 'local' } as const, 'delivered'],
    [{ status: 'sent', via: 'relay' } as const, 'delivered'],
    [{ status: 'indeterminate' } as const, 'uncertain'],
    [{ status: 'offline' } as const, 'not_delivered'],
    [{ status: 'expired' } as const, 'not_delivered'],
    [{ status: 'owner_mismatch' } as const, 'not_delivered'],
    [{ status: 'infrastructure_error', message: 'x' } as const, 'not_delivered'],
  ])('%j → %s', (outcome, expected) => {
    expect(dispatchDisposition(outcome)).toBe(expected);
  });

  it('a status this build does not know is uncertain: the frame may have gone out', () => {
    expect(dispatchDisposition({ status: 'evicted' } as never)).toBe('uncertain');
  });
});

describe('agentReachability (#4142 W1.T2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(breezeRole).mockReturnValue('all');
  });

  it('local socket → connected, no presence read', async () => {
    vi.mocked(isAgentConnected).mockReturnValue(true);
    await expect(agentReachability('agent-1')).resolves.toBe('connected');
    expect(probeAgentPresence).not.toHaveBeenCalled();
  });

  it('no local socket + a live lease (another instance) → connected', async () => {
    vi.mocked(isAgentConnected).mockReturnValue(false);
    vi.mocked(probeAgentPresence).mockResolvedValue({ present: true });
    await expect(agentReachability('agent-1')).resolves.toBe('connected');
  });

  it('no local socket + lease read OK and absent → absent', async () => {
    vi.mocked(isAgentConnected).mockReturnValue(false);
    vi.mocked(probeAgentPresence).mockResolvedValue({ present: false });
    await expect(agentReachability('agent-1')).resolves.toBe('absent');
  });

  it('no local socket + Redis could not answer → unknown (never collapsed into absent)', async () => {
    vi.mocked(isAgentConnected).mockReturnValue(false);
    vi.mocked(probeAgentPresence).mockResolvedValue({ unavailable: true });
    await expect(agentReachability('agent-1')).resolves.toBe('unknown');
  });

  it('worker role never touches the socket map', async () => {
    vi.mocked(breezeRole).mockReturnValue('worker');
    vi.mocked(probeAgentPresence).mockResolvedValue({ present: true });
    await expect(agentReachability('agent-1')).resolves.toBe('connected');
    expect(isAgentConnected).not.toHaveBeenCalled();
  });
});

describe('releaseRelaySendClaim (#4142 W1.T2)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes only a held claim, never a sent marker (compare-and-delete in Lua)', async () => {
    redisMock.eval.mockResolvedValueOnce(1);
    await releaseRelaySendClaim('agent-1', 'cmd-1');
    const [script, numKeys, key] = redisMock.eval.mock.calls[0]!;
    expect(numKeys).toBe(1);
    expect(key).toBe('agent-relay-claim:agent-1:cmd-1');
    expect(script).toContain("== 'claimed'");
    expect(script).toContain('DEL');
  });

  it('a Redis failure is swallowed: the claim expires on its own TTL', async () => {
    redisMock.eval.mockRejectedValueOnce(new Error('down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(releaseRelaySendClaim('agent-1', 'cmd-1')).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
