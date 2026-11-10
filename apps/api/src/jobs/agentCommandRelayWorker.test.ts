import { beforeEach, describe, expect, it, vi } from 'vitest';

// Wave 3.5b (#4084) — api-role relay consumer. Presence admitted the job onto
// this queue; this process's in-memory socket map (agentWs) is the actual
// authority for whether the send can happen at all. These tests drive the
// exported processor function directly with a fake BullMQ Job — Worker
// construction / concurrency wiring is not under test here.

vi.mock('../services/instanceIdentity', () => ({ INSTANCE_ID: 'inst-1' }));

vi.mock('../services/agentPresence', () => ({
  readAgentPresence: vi.fn(),
}));

vi.mock('../services/agentCommandRelay', () => ({
  agentCommandRelayQueueName: (id: string) => `agent-command-relay-${id}`,
  claimRelaySend: vi.fn(),
  markRelaySendComplete: vi.fn(),
  openRelayCommand: vi.fn(),
  releaseRelaySendClaim: vi.fn(),
  writeRelayAck: vi.fn(),
}));

vi.mock('../routes/agentWs', () => ({
  isAgentConnected: vi.fn(),
  sendCommandToAgent: vi.fn(),
}));

import { readAgentPresence } from '../services/agentPresence';
import {
  claimRelaySend,
  markRelaySendComplete,
  openRelayCommand,
  releaseRelaySendClaim,
  writeRelayAck,
} from '../services/agentCommandRelay';
import { isAgentConnected, sendCommandToAgent } from '../routes/agentWs';
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
  return { data: { ...BASE_DATA, ...overrides } } as any;
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
