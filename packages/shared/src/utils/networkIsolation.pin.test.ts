import { describe, expect, it } from 'vitest';
import { NETWORK_ISOLATION_MIN_AGENT_VERSION } from './networkIsolation';
import { semverCompare } from './semverCompare';

describe('network isolation activation gate', () => {
  it('is valid semver and no higher than the fail-closed sentinel', () => {
    expect(NETWORK_ISOLATION_MIN_AGENT_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
    expect(semverCompare(NETWORK_ISOLATION_MIN_AGENT_VERSION, '999.0.0')).not.toBeNull();
    expect(semverCompare(NETWORK_ISOLATION_MIN_AGENT_VERSION, '999.0.0')).toBeLessThanOrEqual(0);
  });

  // Activation (#10095): the first agent release that carries the activated Windows build and the
  // isolation-recovery release asset. Agents below it report capability 0 anyway (they ship
  // windowsIsolationActivated = false); the gate is the server-side second key. If that release
  // number changes before merge, update both lines together.
  it('is pinned to the release that carries the activated Windows agent', () => {
    expect(NETWORK_ISOLATION_MIN_AGENT_VERSION).toBe('0.130.0');
    expect(semverCompare(NETWORK_ISOLATION_MIN_AGENT_VERSION, '0.129.0')).toBe(1);
  });
});
