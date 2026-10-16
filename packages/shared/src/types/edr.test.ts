import { describe, expect, it } from 'vitest';
import {
  EDR_ACTIONS,
  EDR_ACTION_REQUESTED_VIA,
  EDR_ACTION_STATUSES,
  EDR_CONNECTION_STATUSES,
  EDR_DETECTION_STATUSES,
  EDR_DEVICE_MATCH_SOURCES,
  EDR_ENDPOINT_HEALTH,
  EDR_ENDPOINT_TYPES,
  EDR_ISOLATION_STATES,
  EDR_MAPPING_SOURCES,
  EDR_OPEN_DETECTION_STATUSES,
  EDR_OS_PLATFORMS,
  EDR_SEVERITIES,
  EDR_SYNC_STATUSES,
  EDR_VENDOR_KINDS,
} from './edr';

const ALL_TUPLES = {
  EDR_ACTIONS,
  EDR_ACTION_REQUESTED_VIA,
  EDR_ACTION_STATUSES,
  EDR_CONNECTION_STATUSES,
  EDR_DETECTION_STATUSES,
  EDR_DEVICE_MATCH_SOURCES,
  EDR_ENDPOINT_HEALTH,
  EDR_ENDPOINT_TYPES,
  EDR_ISOLATION_STATES,
  EDR_MAPPING_SOURCES,
  EDR_OPEN_DETECTION_STATUSES,
  EDR_OS_PLATFORMS,
  EDR_SEVERITIES,
  EDR_SYNC_STATUSES,
  EDR_VENDOR_KINDS,
};

describe('EDR normalized tuples', () => {
  it('every set that buckets vendor values carries an unknown bucket', () => {
    for (const set of [EDR_SEVERITIES, EDR_DETECTION_STATUSES, EDR_ENDPOINT_HEALTH, EDR_ISOLATION_STATES, EDR_ENDPOINT_TYPES]) {
      expect(set).toContain('unknown');
    }
  });

  it('mapping sources never include an automatic name match (spec §4.5)', () => {
    expect(EDR_MAPPING_SOURCES).toEqual(['manual', 'auto_external_code', 'manual_unmapped']);
  });

  it('action keys are the spec §4.3 set, in order', () => {
    expect(EDR_ACTIONS).toEqual([
      'isolate', 'unisolate', 'scan', 'update_agent', 'kill_process', 'rollback',
      'resolve_detection', 'mark_false_positive', 'quarantine_restore', 'quarantine_delete',
    ]);
  });

  it('open detection statuses are a subset of the detection statuses', () => {
    for (const s of EDR_OPEN_DETECTION_STATUSES) {
      expect(EDR_DETECTION_STATUSES).toContain(s);
    }
  });

  it.each(Object.entries(ALL_TUPLES))('%s has no duplicates and no empty values', (_name, set) => {
    expect(set.length).toBeGreaterThan(0);
    expect(new Set(set).size).toBe(set.length);
    for (const v of set) expect(v).toMatch(/^[a-z_]+$/);
  });
});

describe('EDR action partition (W03)', () => {
  it('endpoint + detection action sets partition EDR_ACTIONS exactly', async () => {
    const { EDR_ENDPOINT_ACTIONS, EDR_DETECTION_ACTIONS } = await import('./edr');
    const union = [...EDR_ENDPOINT_ACTIONS, ...EDR_DETECTION_ACTIONS];
    expect(new Set(union).size).toBe(union.length);
    expect([...union].sort()).toEqual([...EDR_ACTIONS].sort());
  });

  it('is exported from the shared barrel', async () => {
    const barrel = await import('../index');
    expect(barrel.EDR_ENDPOINT_ACTIONS).toBeDefined();
    expect(barrel.EDR_DETECTION_ACTIONS).toBeDefined();
  });
});
