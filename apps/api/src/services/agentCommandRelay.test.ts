import { beforeEach, describe, expect, it, vi } from 'vitest';

const redisMock = { set: vi.fn(), get: vi.fn(), eval: vi.fn() };
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
  awaitRelayAck,
  claimRelaySend,
  dispatchCommandToAgent,
  getAgentCommandRelayQueue,
  isAgentConnectedAnywhere,
  markRelaySendComplete,
  openRelayCommand,
  RELAY_DELIVERY_DEADLINE_MS,
  sealRelayCommand,
  shutdownAgentCommandRelayQueue,
  writeRelayAck,
} from './agentCommandRelay';
import { isAgentConnected, sendCommandToAgent } from '../routes/agentWs';
import { readAgentPresence } from './agentPresence';
import { createInstrumentedQueue } from './bullmqQueue';
import { breezeRole } from '../config/env';

const BINDING = {
  agentId: 'agent-1',
  commandId: 'cmd-1',
  targetInstanceId: 'inst-1',
  expiresAt: 1_700_000_000_000,
};

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
    // Singleton lives at module scope — force a fresh queue per test so
    // fakeQueue is actually the one exercised.
    await shutdownAgentCommandRelayQueue();
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

  it('queue.add throws → infrastructure_error (not offline)', async () => {
    vi.mocked(isAgentConnected).mockReturnValue(false);
    vi.mocked(readAgentPresence).mockResolvedValue({ instanceId: 'inst-9', connectionToken: 'tok-9' });
    fakeQueue.add.mockRejectedValueOnce(new Error('redis down'));

    const result = await dispatchCommandToAgent('agent-1', command);
    expect(result.status).toBe('infrastructure_error');
    expect((result as { message: string }).message).toContain('redis down');
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
