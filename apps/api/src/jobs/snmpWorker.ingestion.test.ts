/**
 * Protocol-2 SNMP metric ingestion (spec §7.2/§7.3, W01).
 *
 * Ingestion ships BEFORE any agent emits the new shape (W02 owns the agent), so
 * every payload here is one W01 cannot yet receive in production. That is the
 * point: the server must already be correct when W02's agents roll.
 *
 * The db/bullmq/redis/agentWs mock harness is the one snmpWorkerScheduler.test.ts
 * uses, copied so the two suites cannot drift into disagreeing about the same
 * worker's dependencies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { addMock, getJobMock, closeMock, sendCommandToAgentMock, isAgentConnectedMock } = vi.hoisted(() => ({
  addMock: vi.fn(),
  getJobMock: vi.fn(),
  closeMock: vi.fn(),
  sendCommandToAgentMock: vi.fn(),
  isAgentConnectedMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = getJobMock;
    add = addMock;
    close = closeMock;
  },
  Worker: class {},
  Job: class {},
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../routes/agentWs', () => ({
  sendCommandToAgent: sendCommandToAgentMock,
  isAgentConnected: isAgentConnectedMock,
}));

/** Captured calls against the mocked drizzle `db`. */
interface Captured {
  selectWheres: unknown[];
  updateSets: Record<string, unknown>[];
  insertValues: unknown[];
  order: string[];
}
const captured: Captured = { selectWheres: [], updateSets: [], insertValues: [], order: [] };

/** Results handed back, in order, to successive `db.select()` chains. */
let selectResults: unknown[][] = [];
/** When set, the next `db.update(...).set(...).where(...)` rejects with this. */
let updateError: Error | null = null;
/** When set, `db.insert(...).values(...)` rejects with this. */
let insertError: Error | null = null;

vi.mock('../db', () => {
  const selectChain = () => {
    const rows = selectResults.shift() ?? [];
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = (condition: unknown) => {
      captured.selectWheres.push(condition);
      return chain;
    };
    chain.limit = () => Promise.resolve(rows);
    // Thenable so a chain awaited without `.limit()` (the scheduler) resolves.
    chain.then = (onFulfilled: (v: unknown) => unknown, onRejected: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(onFulfilled, onRejected);
    return chain;
  };

  return {
    db: {
      select: () => {
        captured.order.push('select');
        return selectChain();
      },
      update: () => {
        captured.order.push('update');
        return {
          set: (values: Record<string, unknown>) => {
            captured.updateSets.push(values);
            return {
              where: () => (updateError ? Promise.reject(updateError) : Promise.resolve()),
            };
          },
        };
      },
      insert: () => {
        captured.order.push('insert');
        return {
          values: (rows: unknown) => {
            captured.insertValues.push(rows);
            return insertError ? Promise.reject(insertError) : Promise.resolve();
          },
        };
      },
    },
    withSystemDbAccessContext: undefined,
    // Required by createInstrumentedQueue, which getSnmpQueue() now builds
    // through (#3215). Without it the import resolves to undefined and every
    // enqueue throws inside processScheduler's per-device try/catch — the
    // scheduler then reports `enqueued: 0` instead of failing loudly. Same
    // one-line addition snmpQueue.test.ts / securityPostureWorker.test.ts carry.
    assertOutsideHeldDbContext: vi.fn(),
  };
});

import { __testables, enqueueSnmpPollResults } from './snmpWorker';

const { processPollResults } = __testables;


const DEVICE = 'dev-1';
const deviceRow = () => [[{ orgId: 'org-1' }]];

beforeEach(() => {
  captured.selectWheres = [];
  captured.updateSets = [];
  captured.insertValues = [];
  captured.order = [];
  selectResults = [];
  updateError = null;
  insertError = null;
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('processPollResults — protocol 2 ingestion (spec §7.3)', () => {
  it('stores baseOid and instance for a walked table column', async () => {
    selectResults = deviceRow() as unknown[][];

    await processPollResults({
      type: 'process-poll-results',
      deviceId: DEVICE,
      metrics: [{
        oid: '1.3.6.1.2.1.43.11.1.1.9.1.1',
        baseOid: '1.3.6.1.2.1.43.11.1.1.9',
        instance: '1.1',
        name: 'prtMarkerSuppliesLevel',
        value: 37,
        timestamp: '2026-09-16T12:00:00.000Z',
      }],
    });

    const rows = captured.insertValues[0] as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({
      oid: '1.3.6.1.2.1.43.11.1.1.9.1.1',
      baseOid: '1.3.6.1.2.1.43.11.1.1.9',
      instance: '1.1',
      value: '37',
      valueType: 'number',
      error: null,
    });
  });

  it('treats a legacy row as baseOid = oid, instance = empty', async () => {
    selectResults = deviceRow() as unknown[][];

    await processPollResults({
      type: 'process-poll-results',
      deviceId: DEVICE,
      metrics: [{ oid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime', value: 123, timestamp: '2026-09-16T12:00:00.000Z' }],
    });

    const rows = captured.insertValues[0] as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ oid: '1.3.6.1.2.1.1.3.0', baseOid: '1.3.6.1.2.1.1.3.0', instance: '', error: null });
  });

  it('stores an error row with a null value and value_type error', async () => {
    selectResults = deviceRow() as unknown[][];

    await processPollResults({
      type: 'process-poll-results',
      deviceId: DEVICE,
      metrics: [{
        oid: '1.3.6.1.2.1.25.3.5.1.1', baseOid: '1.3.6.1.2.1.25.3.5.1.1', instance: '',
        name: 'hrPrinterStatus', value: null, error: 'noSuchObject', timestamp: '2026-09-16T12:00:00.000Z',
      }],
    });

    const rows = captured.insertValues[0] as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ value: null, valueType: 'error', error: 'noSuchObject' });
  });

  it('rejects an unknown error code rather than storing agent free text', async () => {
    selectResults = deviceRow() as unknown[][];

    await processPollResults({
      type: 'process-poll-results',
      deviceId: DEVICE,
      metrics: [{ oid: '1.2.3', name: 'x', value: null, error: 'Segmentation fault at 0xdeadbeef', timestamp: '2026-09-16T12:00:00.000Z' }],
    });

    const rows = captured.insertValues[0] as Record<string, unknown>[];
    expect(rows[0]!.error).toBe('unknown');
  });

  it('counts the poll as a success when at least one non-error row arrived', async () => {
    selectResults = deviceRow() as unknown[][];

    await processPollResults({
      type: 'process-poll-results',
      deviceId: DEVICE,
      metrics: [
        { oid: '1.1', name: 'a', value: 1, timestamp: '2026-09-16T12:00:00.000Z' },
        { oid: '1.2', name: 'b', value: null, error: 'noSuchObject', timestamp: '2026-09-16T12:00:00.000Z' },
      ],
    });

    expect(captured.updateSets[0]).toMatchObject({ lastStatus: 'online', consecutiveFailures: 0 });
    expect(captured.updateSets[0]!.lastPolled).toBeInstanceOf(Date);
  });

  it('an all-error poll sets warning and does NOT reset consecutive_failures', async () => {
    selectResults = deviceRow() as unknown[][];

    await processPollResults({
      type: 'process-poll-results',
      deviceId: DEVICE,
      metrics: [
        { oid: '1.1', name: 'a', value: null, error: 'noSuchObject', timestamp: '2026-09-16T12:00:00.000Z' },
        { oid: '1.2', name: 'b', value: null, error: 'timeout', timestamp: '2026-09-16T12:00:00.000Z' },
      ],
    });

    // The device ANSWERED (we got rows), so it is not 'offline'. But nothing was
    // collected, so the backoff must not be cleared either.
    expect(captured.updateSets[0]).toMatchObject({ lastStatus: 'warning' });
    expect(captured.updateSets[0]).not.toHaveProperty('consecutiveFailures');
    expect(captured.updateSets[0]).not.toHaveProperty('lastPolled');
    expect(captured.updateSets[0]!.lastPollAttemptedAt).toBeInstanceOf(Date);
  });

  /**
   * #6108 — a poll's metrics go in as ONE multi-row INSERT, so a single value
   * that overflows its column aborted the statement with 22001 and lost EVERY
   * metric from that poll, silently. The agent reported success, so #6066's
   * last_error never fired either.
   */
  describe('over-long values must not cost the whole poll (#6108)', () => {
    const LONG_INSTANCE = '1.4.' + '255.'.repeat(60) + '1'; // > 200 chars

    it('drops only the unstorable row and still persists the good ones', async () => {
      selectResults = deviceRow() as unknown[][];

      await processPollResults({
        type: 'process-poll-results',
        deviceId: DEVICE,
        metrics: [
          { oid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime', value: 1, timestamp: '2026-09-16T12:00:00.000Z' },
          {
            oid: '1.3.6.1.2.1.4.24.7.1.7',
            baseOid: '1.3.6.1.2.1.4.24.7.1.7',
            instance: LONG_INSTANCE,
            name: 'inetCidrRouteIfIndex',
            value: 2,
            timestamp: '2026-09-16T12:00:00.000Z',
          },
          { oid: '1.3.6.1.2.1.2.2.1.10.1', name: 'ifInOctets', value: 3, timestamp: '2026-09-16T12:00:00.000Z' },
        ],
      });

      const rows = captured.insertValues[0] as Record<string, unknown>[];
      expect(rows.map((r) => r.oid)).toEqual(['1.3.6.1.2.1.1.3.0', '1.3.6.1.2.1.2.2.1.10.1']);
    });

    it('reports the drop through last_error so the device page stops showing a clean poll', async () => {
      selectResults = deviceRow() as unknown[][];

      await processPollResults({
        type: 'process-poll-results',
        deviceId: DEVICE,
        metrics: [
          { oid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime', value: 1, timestamp: '2026-09-16T12:00:00.000Z' },
          { oid: '1.3.6.1.2.1.4.24.7.1.7', instance: LONG_INSTANCE, name: 'route', value: 2, timestamp: '2026-09-16T12:00:00.000Z' },
        ],
      });

      // A real value did arrive, so the poll still counts as a success...
      expect(captured.updateSets[0]).toMatchObject({ lastStatus: 'online', consecutiveFailures: 0 });
      // ...but the loss is recorded rather than silent.
      expect(String(captured.updateSets[0]!.lastError)).toContain('instance');
      expect(String(captured.updateSets[0]!.lastError)).toContain('1');
      expect(captured.updateSets[0]!.lastErrorAt).toBeInstanceOf(Date);
      expect(String(captured.updateSets[0]!.lastError).length).toBeLessThanOrEqual(500);
    });

    it('a poll whose every row is unstorable inserts nothing and does not clear the backoff', async () => {
      selectResults = deviceRow() as unknown[][];

      await processPollResults({
        type: 'process-poll-results',
        deviceId: DEVICE,
        metrics: [{ oid: '1.3.6.1.2.1.4.24.7.1.7', instance: LONG_INSTANCE, name: 'route', value: 2, timestamp: '2026-09-16T12:00:00.000Z' }],
      });

      expect(captured.insertValues).toHaveLength(0);
      expect(captured.updateSets[0]).toMatchObject({ lastStatus: 'warning' });
      expect(captured.updateSets[0]).not.toHaveProperty('consecutiveFailures');
      expect(String(captured.updateSets[0]!.lastError)).toContain('instance');
    });

    it('an over-long oid drops that row too', async () => {
      selectResults = deviceRow() as unknown[][];

      await processPollResults({
        type: 'process-poll-results',
        deviceId: DEVICE,
        metrics: [
          { oid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime', value: 1, timestamp: '2026-09-16T12:00:00.000Z' },
          { oid: '1.3.6.1.' + '255.'.repeat(60) + '1', name: 'huge', value: 2, timestamp: '2026-09-16T12:00:00.000Z' },
        ],
      });

      const rows = captured.insertValues[0] as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(String(captured.updateSets[0]!.lastError)).toContain('oid');
    });

    it('clips an over-long name instead of dropping the row — the name is display text, not identity', async () => {
      selectResults = deviceRow() as unknown[][];

      await processPollResults({
        type: 'process-poll-results',
        deviceId: DEVICE,
        metrics: [{ oid: '1.3.6.1.2.1.1.3.0', name: 'n'.repeat(140), value: 1, timestamp: '2026-09-16T12:00:00.000Z' }],
      });

      const rows = captured.insertValues[0] as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.name).toBe('n'.repeat(100));
      expect(captured.updateSets[0]).not.toHaveProperty('lastError');
    });

    it('a 110-char IPv6 route instance — the shape found on the lab rig — is stored, not dropped', async () => {
      selectResults = deviceRow() as unknown[][];
      const realWorldInstance = '2.16.32.1.13.184.0.0.0.0.0.0.0.0.0.0.0.1.64.2.16.32.1.13.184.0.0.0.0.0.0.0.0.0.0.0.2.0.2.16.32.1.13.184.0.0';
      expect(realWorldInstance.length).toBeGreaterThan(64);

      await processPollResults({
        type: 'process-poll-results',
        deviceId: DEVICE,
        metrics: [{
          oid: '1.3.6.1.2.1.4.24.7.1.7', baseOid: '1.3.6.1.2.1.4.24.7.1.7',
          instance: realWorldInstance, name: 'inetCidrRouteIfIndex', value: 2,
          timestamp: '2026-09-16T12:00:00.000Z',
        }],
      });

      const rows = captured.insertValues[0] as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.instance).toBe(realWorldInstance);
      expect(captured.updateSets[0]).not.toHaveProperty('lastError');
    });
  });

  it('an empty metrics array leaves the device status alone', async () => {
    selectResults = deviceRow() as unknown[][];
    await processPollResults({ type: 'process-poll-results', deviceId: DEVICE, metrics: [] });
    // No rows to insert and nothing observed — the dispatch-time failure count
    // stands and the scheduler retries on its own cadence.
    expect(captured.insertValues).toHaveLength(0);
    expect(captured.updateSets[0]).toMatchObject({ lastStatus: 'warning' });
  });
});


describe('walk errors and legacy envelope warnings', () => {
  const walkTemplate = [{ oid: '1.3.6.1.2.1.2.2.1.10', name: 'ifInOctets', type: 'counter' }];
  function wireResult(templateOids = walkTemplate) {
    selectResults = [[{ orgId: 'org-1', templateId: 'tpl-1' }], [{ oids: templateOids }]];
  }

  it.each(['snmpError', 'walkFailed'])('persists %s verbatim', async (error) => {
    selectResults = deviceRow();
    await processPollResults({
      type: 'process-poll-results', deviceId: DEVICE,
      metrics: [{ oid: '1.2.3', name: 'x', value: null, error, timestamp: '2026-09-16T12:00:00.000Z' }],
    });
    expect((captured.insertValues[0] as Record<string, unknown>[])[0]).toMatchObject({ error, value: null, valueType: 'error' });
  });

  it.each([undefined, 1])('warns for legacy protocol %s at most once per device per hour', async (protocol) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-16T12:00:00Z'));
    const deviceId = `legacy-${protocol}`;
    const job = { type: 'process-poll-results' as const, deviceId, protocol, metrics: [] };
    wireResult();
    await processPollResults(job);
    expect(console.warn).toHaveBeenCalledWith('[SnmpWorker] legacy agent result for a walk template', { deviceId, orgId: 'org-1' });
    wireResult();
    await processPollResults(job);
    expect(console.warn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60 * 60 * 1000);
    wireResult();
    await processPollResults(job);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it('does not warn for protocol 2 or scalar-only templates', async () => {
    wireResult();
    await processPollResults({ type: 'process-poll-results', deviceId: 'modern', protocol: 2, metrics: [] });
    wireResult([{ oid: '1.3.6.1.2.1.1.3.0', name: 'uptime', type: 'timeticks' }]);
    await processPollResults({ type: 'process-poll-results', deviceId: 'scalar', metrics: [] });
    expect(console.warn).not.toHaveBeenCalled();
  });
});


it('preserves the protocol envelope through the results queue', async () => {
  addMock.mockResolvedValue({ id: 'job-1' });
  getJobMock.mockResolvedValue(null);
  await enqueueSnmpPollResults(DEVICE, [], undefined, 2);
  expect(addMock).toHaveBeenCalledWith('process-poll-results', expect.objectContaining({ protocol: 2 }), expect.anything());
});
