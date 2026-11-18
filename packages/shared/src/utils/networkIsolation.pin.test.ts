import { describe, expect, it } from 'vitest';
import { NETWORK_ISOLATION_MIN_AGENT_VERSION } from './networkIsolation';
import { semverCompare } from './semverCompare';

describe('network isolation activation gate', () => {
  it('is valid semver and no higher than the fail-closed sentinel', () => {
    expect(NETWORK_ISOLATION_MIN_AGENT_VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
    expect(semverCompare(NETWORK_ISOLATION_MIN_AGENT_VERSION, '999.0.0')).not.toBeNull();
    expect(semverCompare(NETWORK_ISOLATION_MIN_AGENT_VERSION, '999.0.0')).toBeLessThanOrEqual(0);
  });

  it('ships the fail-closed default that the activation PR updates', () => {
    expect(NETWORK_ISOLATION_MIN_AGENT_VERSION).toBe('999.0.0');
  });
});
