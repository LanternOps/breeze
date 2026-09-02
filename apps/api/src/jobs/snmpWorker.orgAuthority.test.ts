/**
 * snmpWorker org authority (issue #3226).
 *
 * The regression these tests lock down is a cross-tenant credential
 * disclosure. `processPollDevice` used to resolve the org from TWO sources for a
 * single dispatch: the template was scoped on the live `snmp_devices` row while
 * the online-agent pick was scoped on the BullMQ job payload, captured whenever
 * the job was enqueued. The command built at the end of that function carries
 * DECRYPTED SNMP credentials (v1/v2c community string, v3 auth/priv passwords),
 * and the agent receiving them was chosen by the payload — so a device moved
 * between orgs while a poll sat queued had its secrets handed to an online agent
 * in the OLD org.
 *
 * The stable jobId (`snmp-poll-<deviceId>`) made that durable rather than a
 * narrow race: `enqueueSnmpPoll` returns early when it finds the job in a
 * reusable state, so a later enqueue carrying the correct org never supersedes
 * the stale payload.
 *
 * Two fences, tested here:
 *   1. worker-side  — the live row is the sole org authority, and a payload that
 *                     disagrees fails the job loudly before any decrypt.
 *   2. enqueue-side — a queued job whose payload org has drifted is replaced
 *                     instead of reused.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchOutcome } from '../services/agentCommandRelay';

const { mockDb, queueMock, agentRelayMock, decryptMock, eqCalls } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
  queueMock: {
    getJob: vi.fn(async () => null),
    add: vi.fn(async () => ({ id: 'job-1' })),
    addBulk: vi.fn(async () => []),
    getRepeatableJobs: vi.fn(async () => []),
    removeRepeatableByKey: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  },
  agentRelayMock: {
    isAgentConnectedAnywhere: vi.fn(async () => true),
    dispatchCommandToAgent: vi.fn(async (): Promise<DispatchOutcome> => ({ status: 'sent', via: 'local' })),
  },
  decryptMock: vi.fn((v: string | null) => v),
  // Records every drizzle `eq(column, value)` so a test can prove WHICH org
  // value the online-agent predicate was built from.
  eqCalls: [] as Array<[unknown, unknown]>,
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = queueMock.getJob;
    add = queueMock.add;
    addBulk = queueMock.addBulk;
    getRepeatableJobs = queueMock.getRepeatableJobs;
    removeRepeatableByKey = queueMock.removeRepeatableByKey;
    close = queueMock.close;
  },
  Worker: class {
    close = vi.fn();
    on = vi.fn();
  },
  Job: class {},
}));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: (column: unknown, value: unknown) => {
      eqCalls.push([column, value]);
      return actual.eq(column as never, value as never);
    },
  };
});

vi.mock('../db', () => ({
  db: mockDb,
  withSystemDbAccessContext: async (fn: () => unknown) => fn(),
  assertOutsideHeldDbContext: vi.fn(),
}));

vi.mock('../db/schema', () => ({
  snmpDevices: {
    id: 'snmpDevices.id',
    orgId: 'snmpDevices.orgId',
    isActive: 'snmpDevices.isActive',
    lastPolled: 'snmpDevices.lastPolled',
    lastPollAttemptedAt: 'snmpDevices.lastPollAttemptedAt',
    consecutiveFailures: 'snmpDevices.consecutiveFailures',
    lastStatus: 'snmpDevices.lastStatus',
    pollingInterval: 'snmpDevices.pollingInterval',
  },
  snmpMetrics: { deviceId: 'snmpMetrics.deviceId' },
  snmpTemplates: {
    id: 'snmpTemplates.id',
    oids: 'snmpTemplates.oids',
    isBuiltIn: 'snmpTemplates.isBuiltIn',
    orgId: 'snmpTemplates.orgId',
  },
  devices: {
    agentId: 'devices.agentId',
    orgId: 'devices.orgId',
    isEphemeral: 'devices.isEphemeral',
    status: 'devices.status',
  },
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

vi.mock('../services/agentCommandRelay', () => ({
  isAgentConnectedAnywhere: agentRelayMock.isAgentConnectedAnywhere,
  dispatchCommandToAgent: agentRelayMock.dispatchCommandToAgent,
}));

vi.mock('../services/snmpSecrets', () => ({
  decryptSnmpSecret: decryptMock,
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: vi.fn(),
}));

import { __testables, enqueueSnmpPoll, shutdownSnmpWorker } from './snmpWorker';

const { processPollDevice } = __testables;

const LIVE_ORG = '11111111-1111-1111-1111-111111111111';
const STALE_ORG = '22222222-2222-2222-2222-222222222222';
const DEVICE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

/** The `snmp_devices` row as the dispatch path sees it, with v2c + v3 secrets. */
function deviceRow(orgId: string) {
  return {
    id: DEVICE_ID,
    orgId,
    templateId: 'template-1',
    ipAddress: '10.0.0.1',
    port: 161,
    snmpVersion: 'v3',
    community: 'enc:community',
    username: 'poller',
    authProtocol: 'sha',
    authPassword: 'enc:auth',
    privProtocol: 'aes',
    privPassword: 'enc:priv',
  };
}

/** A `.select().from().where().limit()` chain resolving to `rows`. */
function selectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

/** Records every `snmp_devices` UPDATE by which write it is. */
const updateLog: string[] = [];
function updateChain() {
  return {
    set: (payload: Record<string, unknown>) => ({
      where: async () => {
        updateLog.push(
          !('consecutiveFailures' in payload) ? 'attemptStamp' : 'dispatchCount'
        );
      },
    }),
  };
}

/**
 * Wire the three selects a dispatch makes, in order:
 * device row → template OIDs → online agent.
 *
 * ALL THREE are wired even on the mismatch tests, deliberately. Wiring only the
 * device select would make those tests pass for the wrong reason — the run would
 * die on an unstubbed `db.select()` a step later, so `rejects.toThrow()` and
 * "no credentials shipped" would hold even with the bug present. With the full
 * chain stubbed, the pre-fix code reaches `sendCommandToAgent` and hands the
 * decrypted community/auth/priv secrets to `agentId`; the assertions below only
 * pass because the org guard stops it.
 */
function wireDispatchSelects(deviceOrgId: string, agentId: string) {
  mockDb.select
    .mockReturnValueOnce(selectChain([deviceRow(deviceOrgId)]) as never)
    .mockReturnValueOnce(selectChain([{ oids: [{ oid: '1.3.6.1.2.1.1.3.0' }] }]) as never)
    .mockReturnValueOnce(selectChain([{ agentId }]) as never);
}

describe('snmpWorker org authority (#3226)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    eqCalls.length = 0;
    updateLog.length = 0;
    // mockReset, not clearAllMocks: several tests deliberately leave part of the
    // `mockReturnValueOnce` chain unconsumed (the org guard short-circuits before
    // the template and agent selects). `clearAllMocks` clears recorded calls but
    // NOT the queued once-implementations, so those leftovers would be served to
    // the next test and silently mis-wire it.
    mockDb.select.mockReset();
    mockDb.update.mockReset();
    mockDb.update.mockImplementation(updateChain as never);
    agentRelayMock.isAgentConnectedAnywhere.mockResolvedValue(true);
    agentRelayMock.dispatchCommandToAgent.mockResolvedValue({ status: 'sent', via: 'local' });
    queueMock.getJob.mockResolvedValue(null);
    queueMock.add.mockResolvedValue({ id: 'job-1' });
    await shutdownSnmpWorker();
  });

  describe('worker-side fence: the live device row is the only org authority', () => {
    it('refuses the dispatch and fails loudly when the payload org is stale', async () => {
      wireDispatchSelects(LIVE_ORG, 'agent-in-stale-org');

      await expect(
        processPollDevice({ type: 'poll-device', deviceId: DEVICE_ID, orgId: STALE_ORG })
      ).rejects.toThrow(/stale job payload org/);
    });

    it('decrypts no SNMP secrets and sends no command on an org mismatch', async () => {
      // Everything a successful dispatch needs is available, so the ONLY thing
      // standing between the stale payload and `agent-in-stale-org` receiving
      // this device's decrypted community/auth/priv secrets is the org guard.
      wireDispatchSelects(LIVE_ORG, 'agent-in-stale-org');

      await expect(
        processPollDevice({ type: 'poll-device', deviceId: DEVICE_ID, orgId: STALE_ORG })
      ).rejects.toThrow();

      // The whole point of the issue: credentials must never reach the wire.
      expect(decryptMock).not.toHaveBeenCalled();
      expect(agentRelayMock.dispatchCommandToAgent).not.toHaveBeenCalled();
    });

    it('stops before the agent lookup, so no agent in either org is even selected', async () => {
      wireDispatchSelects(LIVE_ORG, 'agent-in-stale-org');

      await expect(
        processPollDevice({ type: 'poll-device', deviceId: DEVICE_ID, orgId: STALE_ORG })
      ).rejects.toThrow();

      // Device row only — the template and online-agent selects never ran.
      expect(mockDb.select).toHaveBeenCalledTimes(1);
      expect(eqCalls.some(([column]) => column === 'devices.orgId')).toBe(false);
    });

    it('still stamps lastPollAttemptedAt on a mismatch, so the scheduler does not hot-loop', async () => {
      wireDispatchSelects(LIVE_ORG, 'agent-in-stale-org');

      await expect(
        processPollDevice({ type: 'poll-device', deviceId: DEVICE_ID, orgId: STALE_ORG })
      ).rejects.toThrow();

      // The throw is raised AFTER the phase-1 context commits. Raised inside it,
      // the rollback would drop this stamp and leave lastPollAttemptedAt NULL —
      // re-selecting the device on every 60s tick (the #3217 hot loop).
      expect(updateLog).toContain('attemptStamp');
      // It never counted as a dispatched poll, because nothing was dispatched.
      expect(updateLog).not.toContain('dispatchCount');
    });

    it('treats a payload with no orgId as stale rather than as a wildcard', async () => {
      wireDispatchSelects(LIVE_ORG, 'agent-in-stale-org');

      await expect(
        processPollDevice({ deviceId: DEVICE_ID } as never)
      ).rejects.toThrow(/stale job payload org/);
      expect(decryptMock).not.toHaveBeenCalled();
    });

    it('builds the online-agent predicate from the live row org', async () => {
      wireDispatchSelects(LIVE_ORG, 'agent-live');

      const result = await processPollDevice({
        type: 'poll-device',
        deviceId: DEVICE_ID,
        orgId: LIVE_ORG,
      });

      expect(result).toEqual({ dispatched: true, agentId: 'agent-live' });
      // Past the mismatch guard the payload and the row are provably equal, so
      // this asserts the contract rather than a divergence: the predicate is
      // built from an org that came out of the device row.
      expect(eqCalls).toContainEqual(['devices.orgId', LIVE_ORG]);
    });

    // The two log lines below were also switched off the payload org by this
    // fix. Neither is a credential path — nothing dispatches on either — but a
    // regression to `data.orgId` would silently reintroduce a stale-payload read
    // into the very function being hardened, and nothing else would catch it.
    it('reports the live row org, not the payload org, when the org has no online agent', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockDb.select
        .mockReturnValueOnce(selectChain([deviceRow(LIVE_ORG)]) as never)
        .mockReturnValueOnce(selectChain([{ oids: [{ oid: '1.3.6.1.2.1.1.3.0' }] }]) as never)
        .mockReturnValueOnce(selectChain([]) as never);

      const result = await processPollDevice({
        type: 'poll-device',
        deviceId: DEVICE_ID,
        orgId: LIVE_ORG,
      });

      expect(result).toEqual({ dispatched: false, agentId: null });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(LIVE_ORG));
      warn.mockRestore();
    });

    it('does not dispatch when the selected agent is no longer connected', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      wireDispatchSelects(LIVE_ORG, 'agent-live');
      agentRelayMock.isAgentConnectedAnywhere.mockResolvedValue(false);

      const result = await processPollDevice({
        type: 'poll-device',
        deviceId: DEVICE_ID,
        orgId: LIVE_ORG,
      });

      expect(result).toEqual({ dispatched: false, agentId: null });
      expect(agentRelayMock.dispatchCommandToAgent).not.toHaveBeenCalled();
      expect(decryptMock).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(LIVE_ORG));
      // A poll that never left the building must not count against the device.
      expect(updateLog).not.toContain('dispatchCount');
      warn.mockRestore();
    });

    it('dispatches normally when the payload org matches', async () => {
      wireDispatchSelects(LIVE_ORG, 'agent-live');

      await processPollDevice({ type: 'poll-device', deviceId: DEVICE_ID, orgId: LIVE_ORG });

      expect(agentRelayMock.dispatchCommandToAgent).toHaveBeenCalledTimes(1);
      const [agentId, command] = agentRelayMock.dispatchCommandToAgent.mock.calls[0] as unknown as [
        string,
        { type: string },
      ];
      expect(agentId).toBe('agent-live');
      expect(command.type).toBe('snmp_poll');
    });
  });

  describe('dispatch outcomes via the cross-process facade (wave 3.5b #4084)', () => {
    it('returns dispatched:false and logs the outcome status when offline', async () => {
      wireDispatchSelects(LIVE_ORG, 'agent-live');
      agentRelayMock.dispatchCommandToAgent.mockResolvedValue({ status: 'offline' });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await processPollDevice({ type: 'poll-device', deviceId: DEVICE_ID, orgId: LIVE_ORG });

      expect(result).toEqual({ dispatched: false, agentId: 'agent-live' });
      expect(error).toHaveBeenCalledWith(expect.stringContaining('offline'));
      error.mockRestore();
    });

    it('returns dispatched:false and names "indeterminate" so ops can tell "maybe sent" from "definitely not"', async () => {
      wireDispatchSelects(LIVE_ORG, 'agent-live');
      agentRelayMock.dispatchCommandToAgent.mockResolvedValue({ status: 'indeterminate' });
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await processPollDevice({ type: 'poll-device', deviceId: DEVICE_ID, orgId: LIVE_ORG });

      expect(result).toEqual({ dispatched: false, agentId: 'agent-live' });
      expect(error).toHaveBeenCalledWith(expect.stringContaining('indeterminate'));
      error.mockRestore();
    });

    it('dispatches with priority "probe"', async () => {
      wireDispatchSelects(LIVE_ORG, 'agent-live');

      await processPollDevice({ type: 'poll-device', deviceId: DEVICE_ID, orgId: LIVE_ORG });

      expect(agentRelayMock.dispatchCommandToAgent).toHaveBeenCalledWith(
        'agent-live',
        expect.anything(),
        { priority: 'probe' }
      );
    });

    it('calls markPollDispatched (2nd db.update: attemptStamp is the 1st) BEFORE dispatchCommandToAgent, so an indeterminate dispatch still counts against the device', async () => {
      wireDispatchSelects(LIVE_ORG, 'agent-live');
      agentRelayMock.dispatchCommandToAgent.mockResolvedValue({ status: 'indeterminate' });

      await processPollDevice({ type: 'poll-device', deviceId: DEVICE_ID, orgId: LIVE_ORG });

      // updateLog confirms WHICH write is which (attemptStamp then dispatchCount);
      // invocationCallOrder proves the relative order against the dispatch call —
      // an indeterminate outcome (may have been sent) still leaves the poll
      // counted, mirroring today's send-false-after-mark semantics.
      expect(updateLog).toEqual(['attemptStamp', 'dispatchCount']);
      const dispatchCountOrder = mockDb.update.mock.invocationCallOrder[1];
      const dispatchCallOrder = agentRelayMock.dispatchCommandToAgent.mock.invocationCallOrder[0];
      expect(dispatchCountOrder).toBeLessThan(dispatchCallOrder as number);
    });
  });

  describe('enqueue-side fence: a drifted payload is replaced, not reused', () => {
    it('replaces a waiting job whose payload org no longer matches the device', async () => {
      const remove = vi.fn(async () => undefined);
      queueMock.getJob.mockResolvedValue({
        id: `snmp-poll-${DEVICE_ID}`,
        data: { type: 'poll-device', deviceId: DEVICE_ID, orgId: STALE_ORG },
        getState: vi.fn().mockResolvedValue('waiting'),
        remove,
      } as never);

      await enqueueSnmpPoll(DEVICE_ID, LIVE_ORG);

      expect(remove).toHaveBeenCalledTimes(1);
      expect(queueMock.add).toHaveBeenCalledWith(
        'poll-device',
        expect.objectContaining({ deviceId: DEVICE_ID, orgId: LIVE_ORG }),
        expect.objectContaining({ jobId: `snmp-poll-${DEVICE_ID}` })
      );
    });

    it('reuses a waiting job whose payload org still matches', async () => {
      const remove = vi.fn(async () => undefined);
      queueMock.getJob.mockResolvedValue({
        id: 'existing-job',
        data: { type: 'poll-device', deviceId: DEVICE_ID, orgId: LIVE_ORG },
        getState: vi.fn().mockResolvedValue('waiting'),
        remove,
      } as never);

      const jobId = await enqueueSnmpPoll(DEVICE_ID, LIVE_ORG);

      expect(jobId).toBe('existing-job');
      expect(remove).not.toHaveBeenCalled();
      expect(queueMock.add).not.toHaveBeenCalled();
    });

    it('leaves an ACTIVE drifted job to the worker-side guard instead of racing its lock', async () => {
      const remove = vi.fn(async () => undefined);
      queueMock.getJob.mockResolvedValue({
        id: 'existing-job',
        data: { type: 'poll-device', deviceId: DEVICE_ID, orgId: STALE_ORG },
        getState: vi.fn().mockResolvedValue('active'),
        remove,
      } as never);

      const jobId = await enqueueSnmpPoll(DEVICE_ID, LIVE_ORG);

      // BullMQ rejects removing a locked job; the in-flight run is refused by
      // `loadPollDispatchInputs` on the same mismatch.
      expect(jobId).toBe('existing-job');
      expect(remove).not.toHaveBeenCalled();
    });

    it('replaces a queued job that carries no org at all', async () => {
      const remove = vi.fn(async () => undefined);
      queueMock.getJob.mockResolvedValue({
        id: 'legacy-job',
        data: { type: 'poll-device', deviceId: DEVICE_ID },
        getState: vi.fn().mockResolvedValue('delayed'),
        remove,
      } as never);

      await enqueueSnmpPoll(DEVICE_ID, LIVE_ORG);

      expect(remove).toHaveBeenCalledTimes(1);
      expect(queueMock.add).toHaveBeenCalledWith(
        'poll-device',
        expect.objectContaining({ orgId: LIVE_ORG }),
        expect.anything()
      );
    });

    it('falls back to the worker-side guard when the drifted job locks mid-replacement', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      // The classic TOCTOU: 'waiting' at getState(), locked by a worker by the
      // time remove() runs. BullMQ rejects the removal.
      const remove = vi.fn(async () => {
        throw new Error('Job snmp-poll-x could not be removed because it is locked by another worker');
      });
      queueMock.getJob.mockResolvedValue({
        id: 'raced-job',
        data: { type: 'poll-device', deviceId: DEVICE_ID, orgId: STALE_ORG },
        getState: vi.fn().mockResolvedValue('waiting'),
        remove,
      } as never);

      // Must not reject: the scheduler's per-device catch would only log this
      // without Sentry, and the in-flight job is already covered by the
      // worker-side org guard.
      const jobId = await enqueueSnmpPoll(DEVICE_ID, LIVE_ORG);

      expect(jobId).toBe('raced-job');
      // No duplicate add — BullMQ would return the existing job anyway.
      expect(queueMock.add).not.toHaveBeenCalled();
      // Handled, not silent.
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('became active mid-replacement'),
        expect.any(Error)
      );
      warn.mockRestore();
    });

    it('still removes a completed job before re-adding, and does not double-remove', async () => {
      const remove = vi.fn(async () => undefined);
      queueMock.getJob.mockResolvedValue({
        id: 'done-job',
        data: { type: 'poll-device', deviceId: DEVICE_ID, orgId: STALE_ORG },
        getState: vi.fn().mockResolvedValue('completed'),
        remove,
      } as never);

      await enqueueSnmpPoll(DEVICE_ID, LIVE_ORG);

      expect(remove).toHaveBeenCalledTimes(1);
      expect(queueMock.add).toHaveBeenCalledTimes(1);
    });
  });
});
