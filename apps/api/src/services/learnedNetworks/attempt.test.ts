import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ db: {}, assertInTransaction: vi.fn() }));

import { parseNetworkDispatchRecord, type NetworkDispatchRecord } from './attempt';

const record: NetworkDispatchRecord = {
  version: 1, mode: 'guarded', agentId: 'agent-1', deviceId: '0d7a3b1c-2e4f-4a5b-8c6d-7e8f90a1b2c3',
  allowedNetworkIds: ['6c1d2e3f-4a5b-4c6d-8e7f-001122334455'],
  allowedGatewayIds: ['7c1d2e3f-4a5b-4c6d-8e7f-001122334455'],
  decidedAt: '2026-11-22T01:00:00.000Z',
};

describe('parseNetworkDispatchRecord (E9)', () => {
  it('reads SQL null as no record', () => {
    expect(parseNetworkDispatchRecord(null)).toBeNull();
    expect(parseNetworkDispatchRecord(undefined)).toBeNull();
  });

  it('round-trips a valid record', () => {
    expect(parseNetworkDispatchRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
    const unrestricted = { ...record, mode: 'unrestricted', allowedNetworkIds: [], allowedGatewayIds: [] };
    expect(parseNetworkDispatchRecord(unrestricted)).toEqual(unrestricted);
  });

  it('marks any other shape invalid', () => {
    const { mode: _mode, ...noMode } = record;
    for (const bad of [{ ...record, version: 2 }, noMode, { ...record, allowedGatewayIds: 'g-1' },
      { ...record, allowedNetworkIds: [1] }, { ...record, mode: 'open' }, 'x', 7, []]) {
      expect(parseNetworkDispatchRecord(bad)).toBe('invalid');
    }
  });
});
