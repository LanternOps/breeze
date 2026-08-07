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
    /** Every db.update(...).set(payload) the worker issued. */
    updatedRows: [] as Record<string, unknown>[],
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

// The query builders are stubbed, but DrizzleQueryError is deliberately the
// REAL class: it is the exact wrapper production throws, and its `.code` is
// undefined while the driver's SQLSTATE hides on `.cause`. A hand-rolled stub
// would let the classifier regress to reading the top-level `.code` again.
vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    DrizzleQueryError: actual.DrizzleQueryError,
    eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
    and: (...args: unknown[]) => ({ op: 'and', args }),
    or: (...args: unknown[]) => ({ op: 'or', args }),
    sql: (strings: TemplateStringsArray, ...vals: unknown[]) => ({ op: 'sql', strings: [...strings], vals }),
  };
});

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
        set: (payload: Record<string, unknown>) => ({
          where: async () => {
            h.state.dbDepths.push(h.state.contextDepth);
            h.state.updatedRows.push(payload);
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
import { DrizzleQueryError } from 'drizzle-orm';
import {
  clampToLength,
  encodeUtf8Hex,
  enqueueSnmpPollResults,
  initializeSnmpWorker,
  isAgentHexPayload,
  isDeterministicDataError,
  isPostgresTextSafe,
  resetSnmpDegradationThrottle,
  resolveDeclaredValueType,
  resolveMetricTimestamp,
  sanitizeSnmpIdentifier,
  sanitizeSnmpMetricValue,
  shutdownSnmpWorker,
  SNMP_POLL_RESULTS_ATTEMPTS,
} from './snmpWorker';

/** dot1dBaseBridgeAddress as it actually arrives from the agent: the high bytes
 *  were already replaced upstream by Go's JSON encoder, but the NUL survives. */
const BRIDGE_ADDRESS_VALUE = '\ufffd\ufffd\ufffd\u0000\u0011"';

/** BullMQ attempt bookkeeping the classifier reads off the job. */
interface JobAttemptState {
  attemptsMade?: number;
  attemptsStarted?: number;
  opts?: { attempts?: number };
}

async function runJob(data: unknown, attempt: JobAttemptState = {}): Promise<unknown> {
  if (!h.state.capturedProcessor) throw new Error('worker processor was never captured');
  return h.state.capturedProcessor({ data, ...attempt } as { data: unknown });
}

/** Rows the worker wrote to snmp_devices via db.update(...).set(...). */
function deviceUpdates(): Record<string, unknown>[] {
  return h.state.updatedRows;
}

/**
 * A BARE postgres.js error. Production almost never produces this shape off a
 * Drizzle query — every insert/update is wrapped — so a suite built only on it
 * is false-green. Use it as the `.cause` of a DrizzleQueryError.
 */
function pgFailure(code: string): Error & { code: string } {
  return Object.assign(new Error(`pg failure ${code}`), { code });
}

describe('snmpWorker', () => {
  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.state.contextDepth = 0;
    h.state.rowsByTable = {};
    h.state.insertedRows = [];
    h.state.updatedRows = [];
    h.state.capturedProcessor = null;
    resetSnmpDegradationThrottle();

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
      expect(sanitizeSnmpIdentifier('x'.repeat(250), 200)).toEqual({
        value: 'x'.repeat(200),
        clamped: true,
      });
      expect(sanitizeSnmpIdentifier('1.3.6.1.2.1.1.5.0', 200)).toEqual({
        value: '1.3.6.1.2.1.1.5.0',
        clamped: false,
      });
    });

    it('reports the clamp flag against the ENCODED length, not the input length', () => {
      // A NUL-bearing identifier hex-expands 3x. Comparing to the raw input
      // would call this a clamp when the column width was never reached.
      const encodedShort = sanitizeSnmpIdentifier('a\u0000b', 200);
      expect(encodedShort).toEqual({ value: '610062', clamped: false });

      // ...and a genuine width overflow still reports true.
      expect(sanitizeSnmpIdentifier('\u0000'.repeat(200), 200).clamped).toBe(true);
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
      expect(resolveDeclaredValueType('hex', '788a2000d4e1', 'string')).toBe('hex');
      expect(resolveDeclaredValueType(undefined, 'abc', 'string')).toBe('string');
      expect(resolveDeclaredValueType('Hex', '788a', 'string')).toBe('string');
      expect(resolveDeclaredValueType('hexadecimal', '788a', 'string')).toBe('string');
      // The API's own verdict is never downgraded by a missing declaration.
      expect(resolveDeclaredValueType(undefined, '00', 'hex')).toBe('hex');
      expect(resolveDeclaredValueType('hex', null, 'null')).toBe('null');
    });

    // A declared encoding that the value contradicts is worse than useless: a
    // buggy or hostile agent stamping valueEncoding:'hex' on ordinary readings
    // silently removes the device from numeric rollups AND from top-interfaces
    // ranking (both key off value_type === 'hex'). Monitoring goes quiet with
    // no error raised anywhere, which is why the declaration is checked against
    // the value rather than trusted.
    it('refuses a hex declaration the value does not match', () => {
      expect(resolveDeclaredValueType('hex', 'hello world', 'string')).toBe('string');
      expect(resolveDeclaredValueType('hex', '788A2000D4E1', 'string')).toBe('string'); // uppercase
      expect(resolveDeclaredValueType('hex', '788a2', 'string')).toBe('string'); // odd length
      expect(resolveDeclaredValueType('hex', '78 8a', 'string')).toBe('string'); // separated
      expect(resolveDeclaredValueType('hex', '', 'string')).toBe('string'); // no octets
      expect(resolveDeclaredValueType('hex', '0x788a', 'string')).toBe('string'); // prefixed
      expect(resolveDeclaredValueType('hex', '42', 'number')).toBe('hex'); // real 1-byte hex

      expect(isAgentHexPayload('001122304050')).toBe(true);
      expect(isAgentHexPayload('zz')).toBe(false);
    });

    it('stores value_type=string when the agent lies about hex on every metric', async () => {
      await runJob({
        type: 'process-poll-results',
        deviceId: 'snmp-device-1',
        metrics: [
          { oid: '1.3.6.1.2.1.2.2.1.10.1', name: 'ifInOctets', value: '918273645', valueEncoding: 'hex', timestamp: '' },
          { oid: '1.3.6.1.2.1.1.5.0', name: 'sysName', value: 'switch-01', valueEncoding: 'hex', timestamp: '' },
        ],
      });

      // Both stay numerically interpretable rather than vanishing from rollups.
      expect(h.state.insertedRows.map((r) => r.valueType)).toEqual(['string', 'string']);
      // ...and the refusal is not silent.
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("Ignoring valueEncoding:'hex'"),
        expect.objectContaining({ deviceId: 'snmp-device-1' })
      );
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

  // Nothing between the agent socket and this INSERT validated the payload:
  // agentWs types a command result as z.any() and both SNMP call sites reach
  // the worker through a bare `as { metrics?: SnmpMetricResult[] }` cast. A
  // malformed metric therefore crashed the row builder with a TypeError or the
  // driver with a RangeError — neither of which carries a SQLSTATE, so both
  // were classified TRANSIENT and burned the full ~155s budget before the batch
  // was dropped anyway.
  describe('wire payload validation', () => {
    beforeEach(() => {
      h.state.rowsByTable.snmpDevices = [{ orgId: 'org-1' }];
    });

    it('drops the malformed metric and keeps the rest of the batch', async () => {
      const result = await runJob({
        type: 'process-poll-results',
        deviceId: 'snmp-device-1',
        metrics: [
          { oid: '1.3.6.1.2.1.1.5.0', name: 'sysName', value: 'switch-01', timestamp: '' },
          // `oid` non-string: passes isPostgresTextSafe vacuously, then throws
          // `TypeError: value.slice is not a function` inside clampToLength.
          { oid: 123, name: 'numeric oid', value: 'x', timestamp: '' },
          { oid: null, name: 'null oid', value: 'x', timestamp: '' },
          { oid: '', name: 'empty oid', value: 'x', timestamp: '' },
          { oid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime', value: 123456, timestamp: '' },
        ],
      });

      expect(result).toEqual({ metricsWritten: 2 });
      expect(h.state.insertedRows.map((r) => r.oid)).toEqual([
        '1.3.6.1.2.1.1.5.0',
        '1.3.6.1.2.1.1.3.0',
      ]);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Dropped 3/5 malformed SNMP metrics'),
        expect.objectContaining({ dropped: 3, received: 5 })
      );
    });

    it('never burns a retry on a batch whose every metric is malformed', async () => {
      await expect(
        runJob({
          type: 'process-poll-results',
          deviceId: 'snmp-device-1',
          metrics: [{ oid: 123 }, { name: 'no oid at all' }],
        })
      ).rejects.toBeInstanceOf(UnrecoverableError);

      expect(h.state.insertedRows).toEqual([]);
    });

    it('rejects a non-array metrics payload without touching the database', async () => {
      await expect(
        runJob({ type: 'process-poll-results', deviceId: 'snmp-device-1', metrics: 'oops' })
      ).rejects.toBeInstanceOf(UnrecoverableError);

      // The device lookup never even ran: validation precedes the DB context.
      expect(h.state.dbDepths).toEqual(
        // only the abandon-path status write
        [1]
      );
    });

    it('keeps a reading whose timestamp is garbage, stamped with ingest time', async () => {
      await runJob({
        type: 'process-poll-results',
        deviceId: 'snmp-device-1',
        metrics: [
          { oid: '1.3.6.1.2.1.1.5.0', name: 'sysName', value: 'switch-01', timestamp: 'not-a-date' },
          { oid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime', value: 1, timestamp: { nested: true } },
        ],
      });

      // Previously an Invalid Date bind parameter made the driver throw a
      // RangeError with no SQLSTATE — classified transient, six attempts, batch
      // lost. Both readings survive instead.
      expect(h.state.insertedRows).toHaveLength(2);
      for (const row of h.state.insertedRows) {
        expect(row.timestamp).toBeInstanceOf(Date);
        expect(Number.isNaN((row.timestamp as Date).getTime())).toBe(false);
      }
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Unparseable metric timestamp'),
        expect.objectContaining({ deviceId: 'snmp-device-1' })
      );
    });

    it('resolveMetricTimestamp distinguishes absent from unparseable', () => {
      const fallback = new Date('2026-08-06T00:00:00.000Z');
      const good = resolveMetricTimestamp('2026-08-06T12:00:00.000Z', fallback);
      expect(good.invalid).toBe(false);
      expect(good.timestamp.toISOString()).toBe('2026-08-06T12:00:00.000Z');

      // '' has always meant "no timestamp" on this path; it is not a defect.
      for (const absent of ['', null, undefined]) {
        expect(resolveMetricTimestamp(absent, fallback)).toEqual({ timestamp: fallback, invalid: false });
      }
      for (const bad of ['not-a-date', {}, [], true, Number.NaN]) {
        expect(resolveMetricTimestamp(bad, fallback)).toEqual({ timestamp: fallback, invalid: true });
      }
    });
  });

  // Before this, nothing was logged when the worker altered or discarded data,
  // and lastPolled/lastStatus were written ONLY on the success path — so a
  // device whose batches kept failing went on reading lastStatus='online' with
  // a frozen lastPolled while the graph quietly flatlined.
  describe('observable degradation', () => {
    beforeEach(() => {
      h.state.rowsByTable.snmpDevices = [{ orgId: 'org-1' }];
    });

    it('warns when an identifier clamp actually fires, with the original length', async () => {
      await runJob({
        type: 'process-poll-results',
        deviceId: 'snmp-device-1',
        metrics: [{ oid: `1.3.6.1.${'9'.repeat(400)}`, name: 'ok', value: 'v', timestamp: '' }],
      });

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Clamped snmp_metrics.oid to 200 chars'),
        expect.objectContaining({ deviceId: 'snmp-device-1', field: 'oid', originalLength: 408 })
      );
    });

    it('stays silent when nothing was clamped', async () => {
      await runJob({
        type: 'process-poll-results',
        deviceId: 'snmp-device-1',
        metrics: [{ oid: '1.3.6.1.2.1.1.5.0', name: 'sysName', value: 'switch-01', timestamp: '' }],
      });

      expect(console.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('Clamped'),
        expect.anything()
      );
    });

    it('throttles the clamp warning instead of emitting one per metric', async () => {
      const metrics = Array.from({ length: 25 }, (_unused, i) => ({
        oid: `1.3.6.1.4.1.${i}.${'9'.repeat(400)}`,
        name: 'ok',
        value: 'v',
        timestamp: '',
      }));

      await runJob({ type: 'process-poll-results', deviceId: 'snmp-device-1', metrics });

      const clampWarnings = vi
        .mocked(console.warn)
        .mock.calls.filter((c) => String(c[0]).includes('Clamped snmp_metrics.oid'));
      expect(clampWarnings).toHaveLength(1);
      // All 25 rows were still written — throttling suppresses the log, not the data.
      expect(h.state.insertedRows).toHaveLength(25);
    });

    it('flags the device when a batch is abandoned deterministically', async () => {
      const dbModule = await import('../db');
      const insertSpy = vi.spyOn(dbModule.db, 'insert').mockImplementation((() => ({
        values: async () => {
          throw new DrizzleQueryError('insert into "snmp_metrics" ...', [], pgFailure('22021'));
        },
      })) as never);

      try {
        await expect(
          runJob({
            type: 'process-poll-results',
            deviceId: 'snmp-device-1',
            metrics: [{ oid: '1.3.6.1.2.1.1.5.0', name: 'sysName', value: 'x', timestamp: '' }],
          })
        ).rejects.toBeInstanceOf(UnrecoverableError);
      } finally {
        insertSpy.mockRestore();
      }

      expect(deviceUpdates()).toEqual([
        { lastPolled: expect.any(Date), lastStatus: 'warning' },
      ]);
    });

    it('leaves the device alone while retries remain, flags it on the last attempt', async () => {
      const dbModule = await import('../db');
      const transient = () => {
        throw new DrizzleQueryError('insert into "snmp_metrics" ...', [], pgFailure('08006'));
      };
      const insertSpy = vi
        .spyOn(dbModule.db, 'insert')
        .mockImplementation((() => ({ values: async () => transient() })) as never);

      const batch = {
        type: 'process-poll-results',
        deviceId: 'snmp-device-1',
        metrics: [{ oid: '1.3.6.1.2.1.1.5.0', name: 'sysName', value: 'x', timestamp: '' }],
      };

      try {
        // Attempt 1 of 6: BullMQ will retry, so claiming the batch is gone
        // would be a lie and would flap the status every backoff.
        await expect(runJob(batch, { attemptsStarted: 1, attemptsMade: 0 })).rejects.toThrow();
        expect(deviceUpdates()).toEqual([]);

        // Attempt 6 of 6: nothing further will run, the batch really is lost.
        await expect(runJob(batch, { attemptsStarted: 6, attemptsMade: 5 })).rejects.toThrow();
        expect(deviceUpdates()).toEqual([
          { lastPolled: expect.any(Date), lastStatus: 'warning' },
        ]);
      } finally {
        insertSpy.mockRestore();
      }
    });

    it('caps the UnrecoverableError message and carries structured context', async () => {
      const dbModule = await import('../db');
      // What a DrizzleQueryError message really looks like: the SQL plus every
      // bound parameter. Sentry truncates from the END, i.e. exactly where the
      // poisoned row sits, so this must never be pasted in whole.
      const huge = new DrizzleQueryError(
        `insert into "snmp_metrics" values ${'($1, $2, $3), '.repeat(20_000)}`,
        [],
        pgFailure('22021')
      );
      const insertSpy = vi
        .spyOn(dbModule.db, 'insert')
        .mockImplementation((() => ({ values: async () => { throw huge; } })) as never);

      let thrown: unknown;
      try {
        await runJob({
          type: 'process-poll-results',
          deviceId: 'snmp-device-1',
          metrics: [
            { oid: '.1.3.6.1.2.1.17.1.1.0', name: 'bridge', value: 'x', timestamp: '' },
            { oid: '1.3.6.1.2.1.1.5.0', name: 'sysName', value: 'y', timestamp: '' },
          ],
        });
      } catch (err) {
        thrown = err;
      } finally {
        insertSpy.mockRestore();
      }

      expect(huge.message.length).toBeGreaterThan(100_000);
      const message = (thrown as Error).message;
      expect(message.length).toBeLessThan(1_000);
      // The identifying facts survive the cap because they precede it.
      expect(message).toContain('SQLSTATE 22021');
      expect(message).toContain('device=snmp-device-1');
      expect(message).toContain('metrics=2');
      expect(message).toContain('firstOid=.1.3.6.1.2.1.17.1.1.0');
    });

    it('never lets the drop-path status write replace the real failure', async () => {
      const dbModule = await import('../db');
      const insertSpy = vi.spyOn(dbModule.db, 'insert').mockImplementation((() => ({
        values: async () => {
          throw new DrizzleQueryError('insert ...', [], pgFailure('22021'));
        },
      })) as never);
      const updateSpy = vi.spyOn(dbModule.db, 'update').mockImplementation((() => {
        throw new Error('database is gone too');
      }) as never);

      try {
        await expect(
          runJob({
            type: 'process-poll-results',
            deviceId: 'snmp-device-1',
            metrics: [{ oid: '1.3.6.1.2.1.1.5.0', name: 'sysName', value: 'x', timestamp: '' }],
          })
        ).rejects.toBeInstanceOf(UnrecoverableError);
      } finally {
        updateSpy.mockRestore();
        insertSpy.mockRestore();
      }
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

    const pgError = pgFailure;

    /**
     * What `db.insert(...).values(...)` ACTUALLY throws: a DrizzleQueryError
     * whose own `.code` is undefined, wrapping the real PostgresError on
     * `.cause`. A classifier reading only the top-level `.code` sees nothing
     * here and calls a permanent poison pill "transient".
     */
    function drizzleError(code: string): Error {
      return new DrizzleQueryError(
        'insert into "snmp_metrics" ("device_id", "org_id", "oid", ...) values ($1, $2, $3, ...)',
        ['snmp-device-1', 'org-1', '.1.3.6.1.2.1.17.1.1.0'],
        pgError(code)
      );
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

    // THE regression this suite previously missed entirely. Drizzle wraps every
    // driver error, so on the real code path the SQLSTATE is one `.cause` hop
    // down. Reading only `err.code` made isDeterministicDataError return false
    // for 100% of production failures: UnrecoverableError never fired and a
    // poisoned batch burned all 6 attempts over ~155s instead of failing once.
    it('unwraps the DrizzleQueryError .cause chain to find the SQLSTATE', async () => {
      const wrapped = drizzleError('22021');
      expect((wrapped as { code?: unknown }).code).toBeUndefined(); // the trap
      expect(isDeterministicDataError(wrapped)).toBe(true);

      await expect(runResultsFailingWith(drizzleError('22021'))).rejects.toBeInstanceOf(
        UnrecoverableError
      );
      await expect(runResultsFailingWith(drizzleError('22001'))).rejects.toBeInstanceOf(
        UnrecoverableError
      );
    });

    it('still lets a WRAPPED transient failure retry', async () => {
      for (const code of ['08006', '57P01']) {
        const err = drizzleError(code);
        expect(isDeterministicDataError(err)).toBe(false);
        await expect(runResultsFailingWith(err)).rejects.toBe(err);
      }
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
