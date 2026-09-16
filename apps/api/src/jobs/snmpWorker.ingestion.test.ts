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
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { __testables } from './snmpWorker';

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

  it('an empty metrics array leaves the device status alone', async () => {
    selectResults = deviceRow() as unknown[][];
    await processPollResults({ type: 'process-poll-results', deviceId: DEVICE, metrics: [] });
    // No rows to insert and nothing observed — the dispatch-time failure count
    // stands and the scheduler retries on its own cadence.
    expect(captured.insertValues).toHaveLength(0);
    expect(captured.updateSets[0]).toMatchObject({ lastStatus: 'warning' });
  });
});
