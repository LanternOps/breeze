/**
 * Poll-command wire contract (spec §7.1).
 *
 * Two things are being locked down, and they pull in opposite directions:
 *   1. `oids: string[]` must not move a single byte — agents in the field read
 *      only that field, and they will keep doing so indefinitely.
 *   2. `oidSpecs` + `limits` must appear alongside it, cadence-gated on
 *      snmp_devices.poll_seq, which must advance exactly once per dispatch.
 *
 * Uses the REAL drizzle schema (only `../db` is mocked) so the poll_seq
 * increment can be rendered through a real Postgres dialect and asserted on,
 * the same approach snmpWorkerScheduler.test.ts takes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { DispatchOutcome } from '../services/agentCommandRelay';

const { addMock, getJobMock, closeMock, agentRelayMock, decryptMock } = vi.hoisted(() => ({
  addMock: vi.fn(),
  getJobMock: vi.fn(),
  closeMock: vi.fn(),
  agentRelayMock: {
    isAgentConnectedAnywhere: vi.fn(async () => true),
    dispatchCommandToAgent: vi.fn<typeof import('../services/agentCommandRelay').dispatchCommandToAgent>(
      async (): Promise<DispatchOutcome> => ({ status: 'sent', via: 'local' }),
    ),
  },
  decryptMock: vi.fn((v: string | null) => v),
}));

vi.mock('bullmq', () => ({
  Queue: class { getJob = getJobMock; add = addMock; close = closeMock; },
  Worker: class { close = vi.fn(); on = vi.fn(); },
  Job: class {},
}));

vi.mock('../services/redis', () => ({
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
}));

vi.mock('../services/agentCommandRelay', () => ({
  isAgentConnectedAnywhere: agentRelayMock.isAgentConnectedAnywhere,
  dispatchCommandToAgent: agentRelayMock.dispatchCommandToAgent,
}));

vi.mock('../services/snmpSecrets', () => ({ decryptSnmpSecret: decryptMock }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

/** Rows handed back, in order, to successive `db.select()` chains. */
let selectResults: unknown[][] = [];
/** Every `.set()` payload, in order. */
const updateSets: Record<string, unknown>[] = [];

vi.mock('../db', () => {
  const selectChain = () => {
    const rows = selectResults.shift() ?? [];
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.limit = () => Promise.resolve(rows);
    chain.for = () => Promise.resolve(rows);
    chain.then = (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(ok, fail);
    return chain;
  };
  return {
    db: {
      select: () => selectChain(),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updateSets.push(values);
          return { where: () => Promise.resolve() };
        },
      }),
      insert: () => ({ values: () => Promise.resolve() }),
    },
    withSystemDbAccessContext: undefined,
    assertOutsideHeldDbContext: vi.fn(),
  };
});

import { __testables, buildSnmpPollCommand } from './snmpWorker';
import { POLL_LIMITS } from '../services/snmpOidSpecs';

const { processPollDevice } = __testables;
const dialect = new PgDialect();

const DEVICE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ORG_ID = '11111111-1111-1111-1111-111111111111';

/** A printer template: two scalars, two table columns, plus a repeated OID. */
const TEMPLATE_OIDS = [
  { oid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime', type: 'timeticks', description: 'Uptime' },
  { oid: '1.3.6.1.2.1.1.5.0', name: 'sysName', type: 'string', description: 'Name' },
  { oid: '1.3.6.1.2.1.43.11.1.1.9', name: 'prtMarkerSuppliesLevel', type: 'table', description: 'Level' },
  { oid: '1.3.6.1.2.1.43.11.1.1.6', name: 'prtMarkerSuppliesDescription', type: 'table', description: 'Supply', cadence: 'slow' },
];
TEMPLATE_OIDS.push({ ...TEMPLATE_OIDS[0]! });
const EXPECTED_OIDS = TEMPLATE_OIDS.map((o) => o.oid);

function deviceRow(pollSeq: number, consecutiveFailures = 0) {
  return {
    id: DEVICE_ID, orgId: ORG_ID, assetId: null, templateId: 'tpl-1',
    ipAddress: '10.0.0.1', port: 161, snmpVersion: 'v2c',
    community: 'public', username: null, authProtocol: null, authPassword: null,
    privProtocol: null, privPassword: null, pollSeq, consecutiveFailures,
  };
}

/** device row → template oids → online agent. */
function wireDispatch(pollSeq: number) {
  selectResults = [[deviceRow(pollSeq)], [{ oids: TEMPLATE_OIDS }], [{ agentId: 'agent-1' }]];
}

async function dispatchedPayload(pollSeq: number): Promise<Record<string, unknown>> {
  wireDispatch(pollSeq);
  await processPollDevice({ type: 'poll-device', deviceId: DEVICE_ID, orgId: ORG_ID });
  const call = agentRelayMock.dispatchCommandToAgent.mock.calls.at(-1);
  if (!call) throw new Error('no command was dispatched');
  return (call[1] as { payload: Record<string, unknown> }).payload;
}

beforeEach(() => {
  vi.clearAllMocks();
  selectResults = [];
  updateSets.length = 0;
  addMock.mockResolvedValue({ id: 'job-1' });
  getJobMock.mockResolvedValue(null);
  agentRelayMock.isAgentConnectedAnywhere.mockResolvedValue(true);
  agentRelayMock.dispatchCommandToAgent.mockResolvedValue({ status: 'sent', via: 'local' });
  decryptMock.mockImplementation((v: string | null) => v);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('legacy `oids` is frozen', () => {
  it('sends every template OID in template order on a slow poll', async () => {
    expect((await dispatchedPayload(0)).oids).toEqual(EXPECTED_OIDS);
  });

  it('sends the SAME list on a fast poll — cadence never gates `oids`', async () => {
    expect((await dispatchedPayload(5)).oids).toEqual(EXPECTED_OIDS);
  });

  it('keeps every pre-existing payload key', async () => {
    const payload = await dispatchedPayload(0);
    expect(Object.keys(payload)).toEqual(expect.arrayContaining([
      'deviceId', 'target', 'port', 'version', 'community', 'username',
      'authProtocol', 'authPassword', 'privProtocol', 'privPassword', 'oids',
    ]));
  });
});

describe('`oidSpecs` and `limits`', () => {
  it('carries each OID once on a slow poll, walking the columns', async () => {
    expect((await dispatchedPayload(0)).oidSpecs).toEqual([
      { oid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime', mode: 'get', cadence: 'fast' },
      { oid: '1.3.6.1.2.1.1.5.0', name: 'sysName', mode: 'get', cadence: 'fast' },
      { oid: '1.3.6.1.2.1.43.11.1.1.9', name: 'prtMarkerSuppliesLevel', mode: 'walk', cadence: 'fast' },
      { oid: '1.3.6.1.2.1.43.11.1.1.6', name: 'prtMarkerSuppliesDescription', mode: 'walk', cadence: 'slow' },
    ]);
  });

  it('drops the slow spec on a fast poll while `oids` keeps it', async () => {
    const payload = await dispatchedPayload(5);
    expect((payload.oidSpecs as Array<{ name: string }>).map((s) => s.name))
      .toEqual(['sysUpTime', 'sysName', 'prtMarkerSuppliesLevel']);
    expect(payload.oids).toEqual(EXPECTED_OIDS);
  });

  it('includes slow specs on a fast poll after a failed dispatch', async () => {
    selectResults = [[deviceRow(5, 1)], [{ oids: TEMPLATE_OIDS }], [{ agentId: 'agent-1' }]];
    await processPollDevice({ type: 'poll-device', deviceId: DEVICE_ID, orgId: ORG_ID });
    const payload = agentRelayMock.dispatchCommandToAgent.mock.calls.at(-1)![1].payload;
    expect(payload.oidSpecs).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'prtMarkerSuppliesDescription', cadence: 'slow' }),
    ]));
    expect(payload.oids).toEqual(EXPECTED_OIDS);
  });

  it('sends the fixed bounds alongside the specs', async () => {
    expect((await dispatchedPayload(0)).limits).toEqual(POLL_LIMITS);
  });
});

describe('poll_seq', () => {
  it('advances by one in the same UPDATE that counts the dispatch', async () => {
    await dispatchedPayload(0);
    const dispatchSet = updateSets.find((s) => 'consecutiveFailures' in s);
    expect(dispatchSet).toBeDefined();
    expect(dispatchSet).toHaveProperty('pollSeq');
    expect(dialect.sqlToQuery(dispatchSet!.pollSeq as SQL).sql).toMatch(/"poll_seq"\s*\+\s*1/i);
  });

  it('does not advance when nothing is dispatched', async () => {
    selectResults = [[deviceRow(0)], [{ oids: [] }]]; // no template OIDs → no dispatch
    await processPollDevice({ type: 'poll-device', deviceId: DEVICE_ID, orgId: ORG_ID });
    expect(updateSets.some((s) => 'pollSeq' in s)).toBe(false);
  });
});

describe('buildSnmpPollCommand without a template', () => {
  const device = {
    ipAddress: '10.0.0.1', port: 161, snmpVersion: 'v2c', community: 'public',
    username: null, authProtocol: null, authPassword: null, privProtocol: null, privPassword: null,
  };

  it('omits both new keys entirely, so the payload is byte-for-byte the legacy shape', () => {
    const { payload } = buildSnmpPollCommand(DEVICE_ID, device, ['1.3.6.1.2.1.1.3.0'], 'test');
    expect(payload).not.toHaveProperty('oidSpecs');
    expect(payload).not.toHaveProperty('limits');
  });

  it('omits them for an explicitly empty spec list too', () => {
    const { payload } = buildSnmpPollCommand(DEVICE_ID, device, ['1.3.6.1.2.1.1.3.0'], 'test', { oidSpecs: [], pollSeq: 3 });
    expect(payload).not.toHaveProperty('oidSpecs');
  });
});
