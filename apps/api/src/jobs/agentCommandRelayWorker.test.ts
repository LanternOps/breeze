import { beforeEach, describe, expect, it, vi } from 'vitest';

// Wave 3.5b (#4084) — api-role relay consumer. Presence admitted the job onto
// this queue; this process's in-memory socket map (agentWs) is the actual
// authority for whether the send can happen at all. These tests drive the
// exported processor function directly with a fake BullMQ Job — Worker
// construction / concurrency wiring is not under test here.

vi.mock('../services/instanceIdentity', () => ({ INSTANCE_ID: 'inst-1' }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

vi.mock('../services/agentPresence', () => ({
  readAgentPresence: vi.fn(),
}));

vi.mock('../services/agentCommandRelay', () => ({
  agentCommandRelayQueueName: (id: string) => `agent-command-relay-${id}`,
  RELAY_SEND_JOB_NAME: 'relay-send',
  claimRelaySend: vi.fn(),
  markRelaySendComplete: vi.fn(),
  openRelayCommand: vi.fn(),
  releaseRelaySendClaim: vi.fn(),
  writeRelayAck: vi.fn(),
}));

vi.mock('../services/agentCommandRelayEvict', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/agentCommandRelayEvict')>()),
  writeRelayEvictAck: vi.fn(),
}));

vi.mock('../routes/agentWs', () => ({
  isAgentConnected: vi.fn(),
  sendCommandToAgent: vi.fn(),
  disconnectAgentConnection: vi.fn(),
}));

import { readAgentPresence } from '../services/agentPresence';
import {
  claimRelaySend,
  markRelaySendComplete,
  openRelayCommand,
  releaseRelaySendClaim,
  writeRelayAck,
} from '../services/agentCommandRelay';
import { disconnectAgentConnection, isAgentConnected, sendCommandToAgent } from '../routes/agentWs';
import { writeRelayEvictAck } from '../services/agentCommandRelayEvict';
import { captureException } from '../services/sentry';
import { processAgentCommandRelayJob } from './agentCommandRelayWorker';

const BASE_DATA = {
  relayId: 'relay-1',
  agentId: 'agent-1',
  commandId: 'cmd-1',
  targetInstanceId: 'inst-1',
  connectionToken: 'token-1',
  expiresAt: Date.now() + 5_000,
  sealedCommand: 'sealed-blob',
};

function fakeJob(overrides: Partial<typeof BASE_DATA> = {}) {
  return { name: 'relay-send', data: { ...BASE_DATA, ...overrides } } as any;
}

const LEASE = { instanceId: 'inst-1', connectionToken: 'token-1' };
const COMMAND = { id: 'cmd-1', type: 'snmp_poll', payload: { oids: ['1.3.6.1'] } };

describe('processAgentCommandRelayJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAgentConnected).mockReturnValue(true);
    vi.mocked(readAgentPresence).mockResolvedValue(LEASE);
    vi.mocked(claimRelaySend).mockResolvedValue('claimed');
    vi.mocked(openRelayCommand).mockReturnValue(COMMAND as any);
    vi.mocked(sendCommandToAgent).mockReturnValue(true);
  });

  it('acks expired without taking a claim or sending', async () => {
    await processAgentCommandRelayJob(fakeJob({ expiresAt: Date.now() - 1_000 }));

    expect(writeRelayAck).toHaveBeenCalledWith('relay-1', { status: 'expired' });
    expect(claimRelaySend).not.toHaveBeenCalled();
    expect(sendCommandToAgent).not.toHaveBeenCalled();
  });

  it('acks offline when there is no local socket, without taking a claim', async () => {
    vi.mocked(isAgentConnected).mockReturnValue(false);

    await processAgentCommandRelayJob(fakeJob());

    expect(writeRelayAck).toHaveBeenCalledWith('relay-1', { status: 'offline' });
    expect(claimRelaySend).not.toHaveBeenCalled();
    expect(sendCommandToAgent).not.toHaveBeenCalled();
  });

  it('acks owner_mismatch when the presence lease is missing', async () => {
    vi.mocked(readAgentPresence).mockResolvedValue(null);

    await processAgentCommandRelayJob(fakeJob());

    expect(writeRelayAck).toHaveBeenCalledWith('relay-1', { status: 'owner_mismatch' });
    expect(sendCommandToAgent).not.toHaveBeenCalled();
  });

  it('acks owner_mismatch when the lease instanceId does not match the job target', async () => {
    vi.mocked(readAgentPresence).mockResolvedValue({ ...LEASE, instanceId: 'inst-2' });

    await processAgentCommandRelayJob(fakeJob());

    expect(writeRelayAck).toHaveBeenCalledWith('relay-1', { status: 'owner_mismatch' });
    expect(sendCommandToAgent).not.toHaveBeenCalled();
  });

  it('acks owner_mismatch when the lease connectionToken does not match the job', async () => {
    vi.mocked(readAgentPresence).mockResolvedValue({ ...LEASE, connectionToken: 'other-token' });

    await processAgentCommandRelayJob(fakeJob());

    expect(writeRelayAck).toHaveBeenCalledWith('relay-1', { status: 'owner_mismatch' });
    expect(sendCommandToAgent).not.toHaveBeenCalled();
  });

  it('acks owner_mismatch when the job target is not THIS instance', async () => {
    vi.mocked(readAgentPresence).mockResolvedValue({ ...LEASE, instanceId: 'inst-2' });

    await processAgentCommandRelayJob(fakeJob({ targetInstanceId: 'inst-2' }));

    expect(writeRelayAck).toHaveBeenCalledWith('relay-1', { status: 'owner_mismatch' });
    expect(sendCommandToAgent).not.toHaveBeenCalled();
  });

  it('acks sent/relay without a second send when the claim says already-sent', async () => {
    vi.mocked(claimRelaySend).mockResolvedValue('already-sent');

    await processAgentCommandRelayJob(fakeJob());

    expect(writeRelayAck).toHaveBeenCalledWith('relay-1', { status: 'sent', via: 'relay' });
    expect(sendCommandToAgent).not.toHaveBeenCalled();
  });

  it('acks indeterminate without sending when the claim is in-flight', async () => {
    vi.mocked(claimRelaySend).mockResolvedValue('in-flight');

    await processAgentCommandRelayJob(fakeJob());

    expect(writeRelayAck).toHaveBeenCalledWith('relay-1', { status: 'indeterminate' });
    expect(sendCommandToAgent).not.toHaveBeenCalled();
  });

  it('acks infrastructure_error without sending when the envelope fails to open', async () => {
    vi.mocked(openRelayCommand).mockImplementation(() => {
      throw new Error('tamper');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await processAgentCommandRelayJob(fakeJob());

    // #4142: nothing was sent, so the claim it took goes back.
    expect(releaseRelaySendClaim).toHaveBeenCalledWith('agent-1', 'cmd-1');
    expect(error).toHaveBeenCalledWith('[AgentCommandRelayWorker] relay envelope failed to open', expect.objectContaining({ error: 'tamper' }));
    error.mockRestore();

    expect(writeRelayAck).toHaveBeenCalledWith('relay-1', {
      status: 'infrastructure_error',
      message: expect.stringContaining('tamper or key mismatch'),
    });
    expect(sendCommandToAgent).not.toHaveBeenCalled();
  });

  it('sends the decrypted command, marks the claim complete, and acks sent/relay', async () => {
    await processAgentCommandRelayJob(fakeJob());

    expect(openRelayCommand).toHaveBeenCalledWith('sealed-blob', {
      agentId: 'agent-1',
      commandId: 'cmd-1',
      targetInstanceId: 'inst-1',
      expiresAt: BASE_DATA.expiresAt,
    });
    expect(sendCommandToAgent).toHaveBeenCalledWith('agent-1', COMMAND);
    expect(markRelaySendComplete).toHaveBeenCalledWith('agent-1', 'cmd-1');
    expect(writeRelayAck).toHaveBeenCalledWith('relay-1', { status: 'sent', via: 'relay' });
  });

  it('acks offline and does NOT mark the claim complete when the send itself fails', async () => {
    vi.mocked(sendCommandToAgent).mockReturnValue(false);

    await processAgentCommandRelayJob(fakeJob());

    expect(markRelaySendComplete).not.toHaveBeenCalled();
    expect(writeRelayAck).toHaveBeenCalledWith('relay-1', { status: 'offline' });
  });

  // #4142 W1.T2: the claim was taken for a send that did not happen. Holding it
  // until its TTL lapses would answer a retry of the same command `indeterminate`.
  it('clears its send claim when the local send returns false, so a retry can claim', async () => {
    vi.mocked(sendCommandToAgent).mockReturnValue(false);

    await processAgentCommandRelayJob(fakeJob());

    expect(releaseRelaySendClaim).toHaveBeenCalledWith('agent-1', 'cmd-1');
    expect(writeRelayAck).toHaveBeenCalledWith('relay-1', { status: 'offline' });
  });

  // #4142 W1.T2: the claim await is a Redis round trip; a job that expires
  // during it must not be sent, because the producer may already have answered.
  it('re-checks expiry immediately before sendCommandToAgent', async () => {
    const realNow = Date.now.bind(Date);
    const expiresAt = realNow() + 50;
    let claimed = false;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => (claimed ? expiresAt + 1 : realNow()));
    vi.mocked(claimRelaySend).mockImplementation(async () => {
      claimed = true; // the clock passes expiresAt while the claim round trip is in flight
      return 'claimed';
    });
    try {
      await processAgentCommandRelayJob(fakeJob({ expiresAt }));
    } finally {
      nowSpy.mockRestore();
    }

    expect(sendCommandToAgent).not.toHaveBeenCalled();
    expect(markRelaySendComplete).not.toHaveBeenCalled();
    expect(releaseRelaySendClaim).toHaveBeenCalledWith('agent-1', 'cmd-1');
    expect(writeRelayAck).toHaveBeenCalledWith('relay-1', { status: 'expired' });
  });
});

// #4142 W2: the same consumer serves `relay-evict` jobs, dispatched on the
// BullMQ job name. An eviction closes only the exact connection the
// producer's lease named, and never touches the send path.
describe('processAgentCommandRelayJob: relay-evict', () => {
  const entry = (agentId: string, overrides: Record<string, unknown> = {}) => ({
    agentId, connectionToken: `tok-${agentId}`, code: 4001, reason: 'Tenant suspended', ...overrides,
  });
  function evictJob(entries: unknown[], overrides: Record<string, unknown> = {}) {
    return {
      name: 'relay-evict',
      data: {
        relayId: 'relay-e', targetInstanceId: 'inst-1', expiresAt: Date.now() + 5_000, awaitAck: true,
        entries, ...overrides,
      },
    } as any;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.mocked(disconnectAgentConnection).mockReturnValue('closed');
  });

  it('closes each entry through the fenced close and acks one outcome per entry', async () => {
    vi.mocked(disconnectAgentConnection).mockImplementation((agentId) => ({
      a1: 'closed', a2: 'not-connected', a3: 'token_mismatch', a4: 'close-failed',
    } as const)[agentId as 'a1']);

    await processAgentCommandRelayJob(evictJob([entry('a1'), entry('a2'), entry('a3'), entry('a4')]));

    expect(disconnectAgentConnection).toHaveBeenCalledWith('a1', 'tok-a1', 4001, 'Tenant suspended');
    expect(writeRelayEvictAck).toHaveBeenCalledWith('relay-e', {
      a1: { status: 'closed', via: 'relay' },
      a2: { status: 'not_connected' },
      a3: { status: 'owner_mismatch' },
      a4: { status: 'close_failed', via: 'relay' },
    });
    expect(sendCommandToAgent).not.toHaveBeenCalled();
    expect(claimRelaySend).not.toHaveBeenCalled();
    expect(writeRelayAck).not.toHaveBeenCalled();
  });

  it('a job addressed to another instance is owner_mismatch for every entry, and nothing is closed', async () => {
    await processAgentCommandRelayJob(evictJob([entry('a1'), entry('a2')], { targetInstanceId: 'inst-2' }));

    expect(disconnectAgentConnection).not.toHaveBeenCalled();
    expect(writeRelayEvictAck).toHaveBeenCalledWith('relay-e', {
      a1: { status: 'owner_mismatch' }, a2: { status: 'owner_mismatch' },
    });
  });

  it('checks expiry immediately before each close', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    vi.mocked(disconnectAgentConnection).mockImplementation(() => {
      vi.setSystemTime(1_000_000 + 10_000); // the first close takes us past expiry
      return 'closed';
    });

    await processAgentCommandRelayJob(evictJob([entry('a1'), entry('a2')], { expiresAt: 1_000_000 + 5_000 }));

    expect(disconnectAgentConnection).toHaveBeenCalledTimes(1);
    expect(writeRelayEvictAck).toHaveBeenCalledWith('relay-e', {
      a1: { status: 'closed', via: 'relay' }, a2: { status: 'expired' },
    });
  });

  it('a disallowed close code or an over-long reason is invalid_request for that entry, with no close', async () => {
    await processAgentCommandRelayJob(evictJob([
      entry('bad-code', { code: 1000 }),
      entry('long', { reason: 'r'.repeat(121) }),
      entry('no-token', { connectionToken: '' }),
      entry('ok'),
    ]));

    expect(disconnectAgentConnection).toHaveBeenCalledTimes(1);
    expect(disconnectAgentConnection).toHaveBeenCalledWith('ok', 'tok-ok', 4001, 'Tenant suspended');
    expect(writeRelayEvictAck).toHaveBeenCalledWith('relay-e', {
      'bad-code': { status: 'unavailable', reason: 'invalid_request' },
      long: { status: 'unavailable', reason: 'invalid_request' },
      'no-token': { status: 'unavailable', reason: 'invalid_request' },
      ok: { status: 'closed', via: 'relay' },
    });
  });

  it('a job with more than RELAY_EVICT_MAX_ENTRIES entries or no entry list closes nothing', async () => {
    const many = Array.from({ length: 501 }, (_, i) => entry(`a-${i}`));
    await processAgentCommandRelayJob(evictJob(many));
    await processAgentCommandRelayJob(evictJob(undefined as never));

    expect(disconnectAgentConnection).not.toHaveBeenCalled();
    expect(writeRelayEvictAck).not.toHaveBeenCalled();
    expect(writeRelayAck).toHaveBeenCalledTimes(2);
    expect(writeRelayAck).toHaveBeenCalledWith('relay-e', {
      status: 'infrastructure_error', message: 'relay-evict job rejected: invalid job data',
    });
  });

  it.each([
    ['expiresAt is not a number', { expiresAt: '9999999999999' }],
    ['awaitAck is missing', { awaitAck: undefined }],
    ['targetInstanceId is not a string', { targetInstanceId: 7 }],
  ])('a job whose %s closes nothing (a never-expiring job is refused)', async (_label, overrides) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await processAgentCommandRelayJob(evictJob([entry('a1')], overrides));

    expect(disconnectAgentConnection).not.toHaveBeenCalled();
    expect(writeRelayAck).toHaveBeenCalledWith('relay-e', {
      status: 'infrastructure_error', message: 'relay-evict job rejected: invalid job data',
    });
    warn.mockRestore();
  });

  it('a job with no relayId closes nothing and writes no ack under a bogus key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await processAgentCommandRelayJob(evictJob([entry('a1')], { relayId: undefined }));

    expect(disconnectAgentConnection).not.toHaveBeenCalled();
    expect(writeRelayAck).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a queued eviction logs what it could not close, since nobody reads its ack', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(disconnectAgentConnection).mockImplementation((agentId) => (
      { a1: 'closed', a2: 'token_mismatch', a3: 'not-connected' } as const)[agentId as 'a1']);

    await processAgentCommandRelayJob(evictJob([entry('a1'), entry('a2'), entry('a3')], { awaitAck: false }));

    expect(writeRelayEvictAck).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/queued relay-evict relay-e: owner_mismatch=1 \(of 3\)/));
    warn.mockRestore();
  });

  it('close() failures are reported to Sentry once per job, with the count', async () => {
    vi.mocked(disconnectAgentConnection).mockReturnValue('close-failed');

    await processAgentCommandRelayJob(evictJob([entry('a1'), entry('a2'), entry('a3')]));

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureException).mock.calls[0]![0]).toMatchObject({
      message: expect.stringContaining('close() threw for 3 of 3 socket(s)'),
    });
  });

  it('an agent id of "__proto__" keeps its own outcome', async () => {
    await processAgentCommandRelayJob(evictJob([entry('__proto__')]));

    const outcomes = vi.mocked(writeRelayEvictAck).mock.calls[0]![1];
    expect(Object.keys(outcomes)).toEqual(['__proto__']);
    expect(JSON.stringify(outcomes)).toBe('{"__proto__":{"status":"closed","via":"relay"}}');
  });

  it('a queued eviction (awaitAck:false) closes but writes no ack', async () => {
    await processAgentCommandRelayJob(evictJob([entry('a1')], { awaitAck: false }));

    expect(disconnectAgentConnection).toHaveBeenCalledTimes(1);
    expect(writeRelayEvictAck).not.toHaveBeenCalled();
  });

  it('an unknown job name acks infrastructure_error and sends nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await processAgentCommandRelayJob({ name: 'relay-teleport', data: { ...BASE_DATA } } as any);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('relay-teleport'));
    warn.mockRestore();

    expect(writeRelayAck).toHaveBeenCalledWith('relay-1', {
      status: 'infrastructure_error', message: 'unknown relay job name relay-teleport: nothing was sent',
    });
    expect(sendCommandToAgent).not.toHaveBeenCalled();
    expect(disconnectAgentConnection).not.toHaveBeenCalled();
    expect(claimRelaySend).not.toHaveBeenCalled();
  });
});
