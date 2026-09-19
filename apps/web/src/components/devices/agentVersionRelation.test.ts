import { describe, it, expect } from 'vitest';
import { getAgentVersionRelation } from './agentVersionRelation';

// Issue #5285: colour the Devices "Agent Version" column by relation to the
// org's effective pin/promoted version. This is the pure classification the
// render layer keys its tint/tooltip off of.
describe('getAgentVersionRelation', () => {
  it('returns "equal" when the device matches the effective version exactly', () => {
    expect(getAgentVersionRelation('0.110.0', '0.110.0')).toBe('equal');
  });

  it('returns "equal" ignoring a prerelease suffix (semver-aware, not string equality)', () => {
    expect(getAgentVersionRelation('0.110.0-dev', '0.110.0')).toBe('equal');
  });

  it('returns "ahead" when the device is newer than the effective version', () => {
    expect(getAgentVersionRelation('0.111.0', '0.110.0')).toBe('ahead');
  });

  it('returns "behind" when the device is older than the effective version', () => {
    expect(getAgentVersionRelation('0.108.0', '0.110.0')).toBe('behind');
  });

  it('returns "unknown" when the device version is missing', () => {
    expect(getAgentVersionRelation(null, '0.110.0')).toBe('unknown');
    expect(getAgentVersionRelation(undefined, '0.110.0')).toBe('unknown');
    expect(getAgentVersionRelation('', '0.110.0')).toBe('unknown');
  });

  it('returns "unknown" when the effective version is missing (no pin, never synced)', () => {
    expect(getAgentVersionRelation('0.110.0', null)).toBe('unknown');
    expect(getAgentVersionRelation('0.110.0', undefined)).toBe('unknown');
  });

  it('returns "unknown" when either side is not a valid semver string', () => {
    expect(getAgentVersionRelation('not-a-version', '0.110.0')).toBe('unknown');
    expect(getAgentVersionRelation('0.110.0', 'not-a-version')).toBe('unknown');
  });
});
