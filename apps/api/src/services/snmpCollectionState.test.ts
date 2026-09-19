import { describe, expect, it } from 'vitest';
import { deriveCollection, defaultOidMode, type CollectionInput } from './snmpCollectionState';

const NOW = new Date('2026-09-16T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;

const device = (over: Partial<NonNullable<CollectionInput['snmpDevice']>> = {}) => ({
  isActive: true, lastStatus: 'online', lastPolled: ago(MIN), pollingInterval: 300, consecutiveFailures: 0, ...over,
});

const base = (over: Partial<CollectionInput> = {}): CollectionInput => ({
  templateId: 'tpl-1',
  templateOids: [{ oid: '1.3.6.1.2.1.1.3.0', name: 'sysUpTime' }],
  snmpDevice: device(),
  metrics: [],
  now: NOW,
  ...over,
});

describe('defaultOidMode', () => {
  it('a scalar ends in .0 and is fetched with GET', () => {
    expect(defaultOidMode('1.3.6.1.2.1.1.3.0')).toBe('get');
  });
  it('a column does not and must be walked', () => {
    // F3: a GET on a column OID returns noSuchObject and stored value_type
    // 'null' — 145 of the ~407 built-in OIDs have never collected because of it.
    expect(defaultOidMode('1.3.6.1.2.1.43.11.1.1.9')).toBe('walk');
    expect(defaultOidMode('1.3.6.1.2.1.2.2.1.2')).toBe('walk');
  });
  it('an explicit template mode always wins (asserted through deriveCollection)', () => {
    const c = deriveCollection(base({ templateOids: [{ oid: '1.3.6.1.2.1.1.3.0', name: 's', mode: 'walk' }] }));
    expect(c.oids[0]!.mode).toBe('walk');
  });
});

describe('deriveCollection — per-OID state', () => {
  it('a fresh non-null value is collecting', () => {
    const c = deriveCollection(base({
      metrics: [{ oid: '1.3.6.1.2.1.1.3.0', baseOid: '1.3.6.1.2.1.1.3.0', instance: '', name: 'sysUpTime', value: '400', valueType: 'number', error: null, timestamp: ago(MIN) }],
    }));
    expect(c.oids[0]).toMatchObject({ state: 'collecting', observedAt: ago(MIN).toISOString(), error: null });
    expect(c.oids[0]!.instances).toEqual([
      { oid: '1.3.6.1.2.1.1.3.0', instance: '', value: '400', valueType: 'number', observedAt: ago(MIN).toISOString() },
    ]);
  });

  it('an error row is unsupported and carries the code', () => {
    const c = deriveCollection(base({
      metrics: [{ oid: '1.3.6.1.2.1.1.3.0', baseOid: '1.3.6.1.2.1.1.3.0', instance: '', name: 'sysUpTime', value: null, valueType: 'error', error: 'noSuchObject', timestamp: ago(MIN) }],
    }));
    expect(c.oids[0]).toMatchObject({ state: 'unsupported', error: 'noSuchObject' });
  });

  it('a legacy null with no error is unknown, not unsupported', () => {
    // A pre-W02 agent GETs a column OID and stores value_type 'null'. That
    // proves nothing about the DEVICE — only that the agent cannot walk. Calling
    // it 'unsupported' would tell an operator to stop asking for data the
    // printer is perfectly willing to give.
    const c = deriveCollection(base({
      templateOids: [{ oid: '1.3.6.1.2.1.43.11.1.1.9', name: 'prtMarkerSuppliesLevel' }],
      metrics: [{ oid: '1.3.6.1.2.1.43.11.1.1.9', baseOid: null, instance: null, name: 'prtMarkerSuppliesLevel', value: null, valueType: 'null', error: null, timestamp: ago(MIN) }],
    }));
    expect(c.oids[0]).toMatchObject({ state: 'unknown', mode: 'walk', error: null });
  });

  it('matches a legacy row by oid when base_oid is null', () => {
    const c = deriveCollection(base({
      metrics: [{ oid: '1.3.6.1.2.1.1.3.0', baseOid: null, instance: null, name: 'sysUpTime', value: '7', valueType: 'number', error: null, timestamp: ago(MIN) }],
    }));
    expect(c.oids[0]!.state).toBe('collecting');
  });

  it('a good value older than 2x the polling interval is stale', () => {
    const c = deriveCollection(base({
      metrics: [{ oid: '1.3.6.1.2.1.1.3.0', baseOid: '1.3.6.1.2.1.1.3.0', instance: '', name: 'sysUpTime', value: '400', valueType: 'number', error: null, timestamp: ago(11 * MIN) }],
    }));
    expect(c.oids[0]!.state).toBe('stale');
  });

  it('no rows on a never-successful device is never_polled', () => {
    const c = deriveCollection(base({ snmpDevice: device({ lastPolled: null, lastStatus: null }) }));
    expect(c.oids[0]!.state).toBe('never_polled');
  });

  it('no rows on a device that HAS succeeded is stale, not never_polled', () => {
    // The device polls fine; this particular OID stopped coming back. Saying
    // "never polled" would send the operator to check credentials.
    const c = deriveCollection(base({ metrics: [] }));
    expect(c.oids[0]!.state).toBe('stale');
  });

  it('groups instances under their base OID and caps them', () => {
    const metrics = Array.from({ length: 100 }, (_, i) => ({
      oid: `1.3.6.1.2.1.2.2.1.2.${i}`, baseOid: '1.3.6.1.2.1.2.2.1.2', instance: String(i),
      name: 'ifDescr', value: `eth${i}`, valueType: 'string', error: null, timestamp: ago(MIN),
    }));
    const c = deriveCollection(base({ templateOids: [{ oid: '1.3.6.1.2.1.2.2.1.2', name: 'ifDescr' }], metrics }));
    expect(c.oids).toHaveLength(1);
    expect(c.oids[0]!.instances).toHaveLength(64);
    expect(c.oids[0]!.state).toBe('collecting');
  });
});

describe('deriveCollection — device-level status', () => {
  it.each([
    [{ isActive: false }, 'paused'],
    [{ lastStatus: 'no_template' }, 'no_template'],
    [{ lastStatus: 'no_agent_in_site' }, 'no_agent'],
    [{ lastStatus: 'asset_missing' }, 'asset_moved'],
    [{ lastStatus: 'asset_no_site' }, 'asset_moved'],
    [{ lastStatus: 'offline' }, 'failing'],
    [{ lastStatus: 'warning' }, 'failing'],
    [{ lastStatus: null, lastPolled: null }, 'never_polled'],
    [{ lastStatus: 'online' }, 'ok'],
  ] as const)('%o maps to %s', (over, expected) => {
    expect(deriveCollection(base({ snmpDevice: device(over) })).status).toBe(expected);
  });

  it('no SNMP device at all is never_polled with no template and no OIDs', () => {
    const c = deriveCollection(base({ snmpDevice: null, templateId: null, templateOids: [] }));
    expect(c).toMatchObject({ status: 'never_polled', templateId: null, lastPolledAt: null, pollingInterval: null, consecutiveFailures: 0, oids: [] });
  });

  it('a device with no template reports no_template and an empty OID list', () => {
    const c = deriveCollection(base({ templateId: null, templateOids: [], snmpDevice: device({ lastStatus: 'no_template' }) }));
    expect(c.status).toBe('no_template');
    expect(c.oids).toEqual([]);
  });
});
