import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Two production defects on the US instance drive this suite:
//
//  1. A UniFi USW-24-PoE answers the bridge/FDB OIDs with raw binary
//     octet-strings. The agent stringifies those bytes, so a NUL (0x00) reached
//     `snmp_metrics.value` (a Postgres `text` column) and every insert failed
//     with `invalid byte sequence for encoding "UTF8": 0x00` (SQLSTATE 22021) —
//     deterministically, forever, every ~60-80s.
//  2. The worker wrapped its ENTIRE job body in one system DB access context,
//     i.e. one real pg transaction, so the scheduler's Redis enqueue loop ran
//     inside it and pinned a pooled connection for 40s (#1105).

const h = vi.hoisted(() => ({
  state: {
    /** Depth of the currently open withSystemDbAccessContext stack. */
    contextDepth: 0,
    /** contextDepth observed at each BullMQ (Redis) call. */
    redisDepths: [] as number[],
    /** contextDepth observed at each DB read/write. */
    dbDepths: [] as number[],
    /** contextDepth observed at each sendCommandToAgent call. */
    sendDepths: [] as number[],
    rowsByTable: {} as Record<string, Record<string, unknown>[]>,
    insertedRows: [] as Record<string, unknown>[],
    capturedProcessor: null as null | ((job: { data: unknown }) => Promise<unknown>),
    /** Every queue.add(name, data, opts) call, arguments retained. */
    addCalls: [] as Array<{ name: string; data: unknown; opts: Record<string, unknown> }>,
  },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    getJob = async () => {
      h.state.redisDepths.push(h.state.contextDepth);
      return null;
    };
    add = async (name: string, data: unknown, opts?: Record<string, unknown>) => {
      h.state.redisDepths.push(h.state.contextDepth);
      h.state.addCalls.push({ name, data, opts: opts ?? {} });
      return { id: 'job-1' };
    };
    getRepeatableJobs = async () => [];
    removeRepeatableByKey = async () => undefined;
    close = async () => undefined;
  },
  UnrecoverableError: class UnrecoverableError extends Error {
    constructor(message?: string) {
      super(message);
      this.name = 'UnrecoverableError';
    }
  },
  Worker: class {
    constructor(_name: string, processor: (job: { data: unknown }) => Promise<unknown>) {
      h.state.capturedProcessor = processor;
    }
    on() {
      return this;
    }
    close = async () => undefined;
  },
  Job: class {},
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
  and: (...args: unknown[]) => ({ op: 'and', args }),
  or: (...args: unknown[]) => ({ op: 'or', args }),
  sql: (strings: TemplateStringsArray, ...vals: unknown[]) => ({ op: 'sql', strings: [...strings], vals }),
}));

vi.mock('../db/schema', () => ({
  snmpDevices: {
    __name: 'snmpDevices',
    id: 'snmpDevices.id',
    orgId: 'snmpDevices.orgId',
    pollingInterval: 'snmpDevices.pollingInterval',
    lastPolled: 'snmpDevices.lastPolled',
    isActive: 'snmpDevices.isActive',
  },
  snmpMetrics: { __name: 'snmpMetrics', deviceId: 'snmpMetrics.deviceId' },
  snmpTemplates: {
    __name: 'snmpTemplates',
    id: 'snmpTemplates.id',
    orgId: 'snmpTemplates.orgId',
    isBuiltIn: 'snmpTemplates.isBuiltIn',
    oids: 'snmpTemplates.oids',
  },
  devices: {
    __name: 'devices',
    agentId: 'devices.agentId',
    orgId: 'devices.orgId',
    status: 'devices.status',
    isEphemeral: 'devices.isEphemeral',
  },
}));

vi.mock('../db', () => {
  const rowsFor = (table: { __name: string }) => h.state.rowsByTable[table.__name] ?? [];
  return {
    db: {
      select: () => ({
        from: (table: { __name: string }) => ({
          where: () => {
            h.state.dbDepths.push(h.state.contextDepth);
            // Some call sites await `.where(...)` directly (processScheduler),
            // others chain `.limit(1)` — support both off one object.
            const pending = Promise.resolve(rowsFor(table)) as Promise<unknown[]> & {
              limit?: (n: number) => Promise<unknown[]>;
            };
            pending.limit = async () => rowsFor(table);
            return pending;
          },
        }),
      }),
      insert: () => ({
        values: async (rows: Record<string, unknown>[]) => {
          h.state.dbDepths.push(h.state.contextDepth);
          h.state.insertedRows.push(...rows);
        },
      }),
      update: () => ({
        set: () => ({
          where: async () => {
            h.state.dbDepths.push(h.state.contextDepth);
          },
        }),
      }),
    },
    withSystemDbAccessContext: async <T>(fn: () => Promise<T>): Promise<T> => {
      h.state.contextDepth++;
      try {
        return await fn();
      } finally {
        h.state.contextDepth--;
      }
    },
  };
});

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));

vi.mock('../routes/agentWs', () => ({
  sendCommandToAgent: vi.fn(() => {
    h.state.sendDepths.push(h.state.contextDepth);
    return true;
  }),
  isAgentConnected: vi.fn(() => true),
}));

vi.mock('./workerObservability', () => ({
  attachWorkerObservability: vi.fn(),
}));

import { UnrecoverableError } from 'bullmq';
import {
  clampToLength,
  encodeUtf8Hex,
  enqueueSnmpPollResults,
  initializeSnmpWorker,
  isDeterministicDataError,
  isPostgresTextSafe,
  resolveDeclaredValueType,
  sanitizeSnmpIdentifier,
  sanitizeSnmpMetricValue,
  shutdownSnmpWorker,
  SNMP_POLL_RESULTS_ATTEMPTS,
} from './snmpWorker';

/** dot1dBaseBridgeAddress as it actually arrives from the agent: the high bytes
 *  were already replaced upstream by Go's JSON encoder, but the NUL survives. */
const BRIDGE_ADDRESS_VALUE = '\ufffd\ufffd\ufffd\u0000\u0011"';

async function runJob(data: unknown): Promise<unknown> {
  if (!h.state.capturedProcessor) throw new Error('worker processor was never captured');
  return h.state.capturedProcessor({ data });
}

describe('snmpWorker', () => {
  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.state.contextDepth = 0;
    h.state.rowsByTable = {};
    h.state.insertedRows = [];
    h.state.capturedProcessor = null;

    await initializeSnmpWorker();

    // initializeSnmpWorker registers the repeatable scheduler job; ignore that
    // bookkeeping so each test only observes its own job.
    h.state.redisDepths = [];
    h.state.dbDepths = [];
    h.state.sendDepths = [];
    h.state.addCalls = [];
  });

  afterEach(async () => {
    await shutdownSnmpWorker();
    vi.restoreAllMocks();
  });

  describe('value sanitization', () => {
    it('hex-encodes a NUL-bearing octet-string and types it "hex"', () => {
      expect(sanitizeSnmpMetricValue(BRIDGE_ADDRESS_VALUE)).toEqual({
        value: 'efbfbdefbfbdefbfbd001122',
        valueType: 'hex',
      });
      // Plain ASCII around the NUL shows the encoding is byte-for-byte.
      expect(sanitizeSnmpMetricValue('\u0000\u0001AB')).toEqual({
        value: '00014142',
        valueType: 'hex',
      });
    });

    it('hex-encodes lone UTF-16 surrogates losslessly', () => {
      expect(isPostgresTextSafe('\ud800')).toBe(false);
      expect(isPostgresTextSafe('a\udc00b')).toBe(false);
      // A well-formed pair is valid text and must NOT be hex-encoded.
      expect(isPostgresTextSafe('😀')).toBe(true);

      expect(sanitizeSnmpMetricValue('\ud800')).toEqual({ value: 'eda080', valueType: 'hex' });
      expect(encodeUtf8Hex('😀')).toBe('f09f9880');
    });

    it('leaves text-safe values and their value_type exactly as before', () => {
      expect(sanitizeSnmpMetricValue('UniFi USW-24-PoE')).toEqual({
        value: 'UniFi USW-24-PoE',
        valueType: 'string',
      });
      expect(sanitizeSnmpMetricValue(42)).toEqual({ value: '42', valueType: 'number' });
      expect(sanitizeSnmpMetricValue(0)).toEqual({ value: '0', valueType: 'number' });
      expect(sanitizeSnmpMetricValue(null)).toEqual({ value: null, valueType: 'null' });
      expect(sanitizeSnmpMetricValue(undefined)).toEqual({ value: null, valueType: 'null' });
      expect(sanitizeSnmpMetricValue({ a: 1 })).toEqual({
        value: '[object Object]',
        valueType: 'object',
      });
      expect(sanitizeSnmpMetricValue('')).toEqual({ value: '', valueType: 'string' });
    });

    it('clamps deterministically and never cuts a surrogate pair in half', () => {
      expect(clampToLength('abcdef', 3)).toBe('abc');
      expect(clampToLength('abc', 10)).toBe('abc');
      // Slicing at 3 would strand the high surrogate of the emoji.
      expect(clampToLength('ab😀', 3)).toBe('ab');
      expect(sanitizeSnmpIdentifier('x'.repeat(250), 200)).toBe('x'.repeat(200));
      expect(sanitizeSnmpIdentifier('1.3.6.1.2.1.1.5.0', 200)).toBe('1.3.6.1.2.1.1.5.0');
    });
  });

  describe('process-poll-results', () => {
    beforeEach(() => {
      h.state.rowsByTable.snmpDevices = [{ orgId: 'org-1' }];
    });

    it('writes the poisoned bridge-address metric as hex instead of failing the insert', async () => {
      const result = await runJob({
        type: 'process-poll-results',
        deviceId: 'snmp-device-1',
        metrics: [
          {
            oid: '.1.3.6.1.2.1.17.1.1.0',
            name: 'dot1dBaseBridgeAddress',
            value: BRIDGE_ADDRESS_VALUE,
            timestamp: '2026-08-06T00:00:00.000Z',
          },
        ],
      });

      expect(result).toEqual({ metricsWritten: 1 });
      expect(h.state.insertedRows).toHaveLength(1);
      expect(h.state.insertedRows[0]).toMatchObject({
        deviceId: 'snmp-device-1',
        orgId: 'org-1',
        oid: '.1.3.6.1.2.1.17.1.1.0',
        name: 'dot1dBaseBridgeAddress',
        value: 'efbfbdefbfbdefbfbd001122',
        valueType: 'hex',
      });
      expect(String(h.state.insertedRows[0]!.value)).not.toContain('\u0000');
    });

    it('leaves ordinary metrics byte-identical', async () => {
      await runJob({
        type: 'process-poll-results',
        deviceId: 'snmp-device-1',
        metrics: [
          { oid: '1.3.6.1.2.1.1.5.0', name: 'sysName', value: 'switch-01', timestamp: '' },
          { oid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime', value: 123456, timestamp: '' },
          { oid: '1.3.6.1.2.1.1.6.0', name: 'sysLocation', value: null, timestamp: '' },
        ],
      });

      expect(h.state.insertedRows.map((r) => [r.value, r.valueType])).toEqual([
        ['switch-01', 'string'],
        ['123456', 'number'],
        [null, 'null'],
      ]);
    });

    it('clamps an over-length oid and name to their column widths', async () => {
      await runJob({
        type: 'process-poll-results',
        deviceId: 'snmp-device-1',
        metrics: [
          {
            oid: `1.3.6.1.${'9'.repeat(400)}`,
            name: 'n'.repeat(300),
            value: 'ok',
            timestamp: '',
          },
        ],
      });

      const row = h.state.insertedRows[0]!;
      expect(String(row.oid)).toHaveLength(200);
      expect(String(row.oid)).toBe(`1.3.6.1.${'9'.repeat(400)}`.slice(0, 200));
      expect(String(row.name)).toHaveLength(100);
      expect(String(row.name)).toBe('n'.repeat(100));
      // Unchanged fields prove clamping did not disturb the rest of the row.
      expect(row.value).toBe('ok');
      expect(row.valueType).toBe('string');
    });

    it('falls back to the oid when the metric has no name, still clamped', async () => {
      await runJob({
        type: 'process-poll-results',
        deviceId: 'snmp-device-1',
        metrics: [{ oid: '1.3.'.repeat(60), name: '', value: 'ok', timestamp: '' }],
      });

      expect(String(h.state.insertedRows[0]!.name)).toHaveLength(100);
    });

    // The agent hex-encodes binary octet-strings itself and declares
    // valueEncoding:'hex'. What arrives is then plain ASCII, so the API's own
    // safety check sees ordinary text — without honouring the declaration the
    // row would store value_type='string', indistinguishable from a device that
    // literally reported that text, and eligible for numeric rollup.
    it("stores value_type='hex' when the agent declares valueEncoding:'hex'", async () => {
      await runJob({
        type: 'process-poll-results',
        deviceId: 'snmp-device-1',
        metrics: [
          {
            oid: '.1.3.6.1.2.1.17.1.1.0',
            name: 'dot1dBaseBridgeAddress',
            value: '788a2000d4e1',
            valueEncoding: 'hex',
            timestamp: '',
          },
        ],
      });

      expect(h.state.insertedRows[0]).toMatchObject({
        // The declared payload is stored verbatim; only the type changes.
        value: '788a2000d4e1',
        valueType: 'hex',
      });
    });

    it('honours the declaration even when the hex is all digits', async () => {
      // '001122304050' is a MAC, not the reading 1.12e11 — this is the row that
      // corrupts metric_rollups if it is typed 'string'.
      await runJob({
        type: 'process-poll-results',
        deviceId: 'snmp-device-1',
        metrics: [
          { oid: '1.3.6.1.2.1.17.4.3.1.1.1', name: 'fdb', value: '001122304050', valueEncoding: 'hex', timestamp: '' },
        ],
      });

      expect(h.state.insertedRows[0]).toMatchObject({ value: '001122304050', valueType: 'hex' });
    });

    it('ignores an unknown or hostile valueEncoding rather than storing it', async () => {
      await runJob({
        type: 'process-poll-results',
        deviceId: 'snmp-device-1',
        metrics: [
          { oid: '1', name: 'a', value: 'abc', valueEncoding: 'HEX', timestamp: '' },
          { oid: '2', name: 'b', value: 'abc', valueEncoding: 'base64', timestamp: '' },
          { oid: '3', name: 'c', value: '42', valueEncoding: 'x'.repeat(500), timestamp: '' },
          { oid: '4', name: 'd', value: 'abc', valueEncoding: '', timestamp: '' },
          { oid: '5', name: 'e', value: 123, valueEncoding: 'number', timestamp: '' },
        ],
      });

      // value_type is varchar(20): nothing unvalidated may reach it.
      expect(h.state.insertedRows.map((r) => r.valueType)).toEqual([
        'string',
        'string',
        'string',
        'string',
        'number',
      ]);
    });

    it('still applies the API safety net when the field is absent (old agents)', async () => {
      await runJob({
        type: 'process-poll-results',
        deviceId: 'snmp-device-1',
        metrics: [
          // No valueEncoding at all, raw NUL-bearing octet-string.
          { oid: '.1.3.6.1.2.1.17.1.1.0', name: 'bridge', value: BRIDGE_ADDRESS_VALUE, timestamp: '' },
          { oid: '1.3.6.1.2.1.1.5.0', name: 'sysName', value: 'switch-01', timestamp: '' },
        ],
      });

      expect(h.state.insertedRows.map((r) => [r.value, r.valueType])).toEqual([
        ['efbfbdefbfbdefbfbd001122', 'hex'],
        ['switch-01', 'string'],
      ]);
    });

    it("keeps value_type='null' for a null value however it is declared", async () => {
      await runJob({
        type: 'process-poll-results',
        deviceId: 'snmp-device-1',
        metrics: [{ oid: '1', name: 'a', value: null, valueEncoding: 'hex', timestamp: '' }],
      });

      expect(h.state.insertedRows[0]).toMatchObject({ value: null, valueType: 'null' });
    });

    it('resolveDeclaredValueType only ever honours the exact literal', () => {
      expect(resolveDeclaredValueType('hex', 'abc', 'string')).toBe('hex');
      expect(resolveDeclaredValueType(undefined, 'abc', 'string')).toBe('string');
      expect(resolveDeclaredValueType('Hex', 'abc', 'string')).toBe('string');
      expect(resolveDeclaredValueType('hexadecimal', 'abc', 'string')).toBe('string');
      // The API's own verdict is never downgraded by a missing declaration.
      expect(resolveDeclaredValueType(undefined, '00', 'hex')).toBe('hex');
      expect(resolveDeclaredValueType('hex', null, 'null')).toBe('null');
    });

    it('keeps its DB work inside a system access context', async () => {
      await runJob({
        type: 'process-poll-results',
        deviceId: 'snmp-device-1',
        metrics: [{ oid: '1.3.6.1.2.1.1.5.0', name: 'sysName', value: 'switch-01', timestamp: '' }],
      });

      expect(h.state.dbDepths.length).toBeGreaterThan(0);
      expect(h.state.dbDepths.every((d) => d > 0)).toBe(true);
    });
  });

  describe('poll-scheduler (#1105 held connection)', () => {
    it('reads due devices inside a context but enqueues after it closes', async () => {
      h.state.rowsByTable.snmpDevices = [
        { id: 'snmp-device-1', orgId: 'org-1', pollingInterval: 60, lastPolled: null },
        { id: 'snmp-device-2', orgId: 'org-2', pollingInterval: 60, lastPolled: null },
      ];

      const result = await runJob({ type: 'poll-scheduler' });

      expect(result).toEqual({ enqueued: 2 });

      // The read still gets RLS/system context...
      expect(h.state.dbDepths).toEqual([1]);

      // ...but every Redis round-trip of the enqueue loop (getJob + add per
      // device) happens with NO open transaction. Under the old blanket
      // `runWithSystemDbAccess` wrapper these were all depth 1 — that is the
      // 40s idle-in-transaction hold.
      expect(h.state.redisDepths.length).toBeGreaterThanOrEqual(4);
      expect(h.state.redisDepths.every((d) => d === 0)).toBe(true);
      expect(h.state.contextDepth).toBe(0);
    });

    it('does no enqueue work at all when nothing is due', async () => {
      h.state.rowsByTable.snmpDevices = [];

      expect(await runJob({ type: 'poll-scheduler' })).toEqual({ enqueued: 0 });
      expect(h.state.redisDepths).toEqual([]);
    });
  });

  describe('poll-device', () => {
    it('dispatches to the agent only after the DB context has closed', async () => {
      h.state.rowsByTable.snmpDevices = [
        {
          id: 'snmp-device-1',
          orgId: 'org-1',
          templateId: 'template-1',
          ipAddress: '10.0.0.1',
          port: 161,
          snmpVersion: 'v2c',
          community: null,
          username: null,
          authProtocol: null,
          authPassword: null,
          privProtocol: null,
          privPassword: null,
        },
      ];
      h.state.rowsByTable.snmpTemplates = [{ oids: [{ oid: '1.3.6.1.2.1.1.5.0' }] }];
      h.state.rowsByTable.devices = [{ agentId: 'agent-1' }];

      const result = await runJob({ type: 'poll-device', deviceId: 'snmp-device-1', orgId: 'org-1' });

      expect(result).toEqual({ dispatched: true, agentId: 'agent-1' });
      expect(h.state.dbDepths).toEqual([1, 1, 1]);
      // decryptSnmpSecret x3 + the WebSocket send run outside the transaction.
      expect(h.state.sendDepths).toEqual([0]);
    });

    it('skips the agent lookup entirely when the device has no OIDs', async () => {
      h.state.rowsByTable.snmpDevices = [{ id: 'snmp-device-1', orgId: 'org-1', templateId: null }];

      const result = await runJob({ type: 'poll-device', deviceId: 'snmp-device-1', orgId: 'org-1' });

      expect(result).toEqual({ dispatched: false, agentId: null });
      expect(h.state.dbDepths).toEqual([1]);
      expect(h.state.sendDepths).toEqual([]);
    });

    it('reports a missing device without dispatching', async () => {
      h.state.rowsByTable.snmpDevices = [];

      const result = await runJob({ type: 'poll-device', deviceId: 'ghost', orgId: 'org-1' });

      expect(result).toEqual({ dispatched: false, agentId: null });
      expect(h.state.sendDepths).toEqual([]);
    });
  });

  describe('retry policy actually enqueued', () => {
    /** The options object the worker really handed BullMQ for a result batch. */
    async function enqueuedResultOptions(): Promise<Record<string, unknown>> {
      await enqueueSnmpPollResults(
        'snmp-device-1',
        [{ oid: '1.3.6.1.2.1.1.5.0', name: 'sysName', value: 'switch-01', timestamp: '' }],
        'poll-1'
      );
      const call = h.state.addCalls.find((c) => c.name === 'process-poll-results');
      if (!call) throw new Error('no process-poll-results job was enqueued');
      return call.opts;
    }

    // These assert the LITERAL values on the real queue.add call, not the
    // exported constant. Asserting the constant is vacuous: deleting
    // `attempts:` from the options would leave such a test green.
    it('passes a bounded attempts count to queue.add', async () => {
      const opts = await enqueuedResultOptions();

      expect(opts.attempts).toBe(6);
      expect(opts.attempts).toBe(SNMP_POLL_RESULTS_ATTEMPTS);
    });

    it('passes exponential backoff to queue.add', async () => {
      const opts = await enqueuedResultOptions();

      expect(opts.backoff).toEqual({ type: 'exponential', delay: 5_000 });
    });

    it('absorbs a DB blip of at least 60s, the old 15s window did not', async () => {
      const opts = await enqueuedResultOptions();
      const attempts = opts.attempts as number;
      const { delay } = opts.backoff as { type: string; delay: number };

      // BullMQ exponential: the nth retry waits delay * 2^(n-1).
      let windowMs = 0;
      for (let retry = 1; retry < attempts; retry++) {
        windowMs += delay * 2 ** (retry - 1);
      }

      expect(windowMs).toBe(155_000);
      expect(windowMs).toBeGreaterThanOrEqual(60_000);
    });

    it('keeps the stable jobId and failure retention alongside the retry options', async () => {
      const opts = await enqueuedResultOptions();

      expect(opts.jobId).toBe('snmp-result-poll-1');
      expect(opts.removeOnFail).toEqual({ count: 200 });
    });
  });

  describe('deterministic vs transient failure classification', () => {
    beforeEach(() => {
      h.state.rowsByTable.snmpDevices = [{ orgId: 'org-1' }];
    });

    function pgError(code: string): Error & { code: string } {
      return Object.assign(new Error(`pg failure ${code}`), { code });
    }

    async function runResultsFailingWith(err: unknown): Promise<unknown> {
      const dbModule = await import('../db');
      const insertSpy = vi.spyOn(dbModule.db, 'insert').mockImplementation((() => ({
        values: async () => {
          throw err;
        },
      })) as never);
      try {
        return await runJob({
          type: 'process-poll-results',
          deviceId: 'snmp-device-1',
          metrics: [{ oid: '1.3.6.1.2.1.1.5.0', name: 'sysName', value: 'x', timestamp: '' }],
        });
      } finally {
        insertSpy.mockRestore();
      }
    }

    it('burns no retries on a deterministic data error (SQLSTATE 22xxx)', async () => {
      // 22021 is the encoding failure that spun forever in production.
      await expect(runResultsFailingWith(pgError('22021'))).rejects.toBeInstanceOf(
        UnrecoverableError
      );
      await expect(runResultsFailingWith(pgError('22001'))).rejects.toBeInstanceOf(
        UnrecoverableError
      );
    });

    it('lets a transient failure retry: connection, resources, shutdown', async () => {
      for (const code of ['08006', '53300', '57P01', '40001']) {
        const err = pgError(code);
        await expect(runResultsFailingWith(err)).rejects.toBe(err);
      }
    });

    it('treats a non-SQLSTATE error (socket timeout) as transient', async () => {
      const err = new Error('write ETIMEDOUT');
      await expect(runResultsFailingWith(err)).rejects.toBe(err);

      expect(isDeterministicDataError(err)).toBe(false);
      expect(isDeterministicDataError(null)).toBe(false);
      expect(isDeterministicDataError({ code: 22021 })).toBe(false); // not a string
      expect(isDeterministicDataError({ code: '22something' })).toBe(false); // not 5 chars
      expect(isDeterministicDataError({ code: '22021' })).toBe(true);
    });
  });

  it('rejects an unknown job type', async () => {
    await expect(runJob({ type: 'nope' })).rejects.toThrow('Unknown job type: nope');
  });
});
