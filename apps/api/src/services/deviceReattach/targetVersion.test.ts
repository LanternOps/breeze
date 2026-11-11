import { describe, expect, it } from 'vitest';
import { reattachTargetVersion, reattachTargetVersionMatches, REATTACH_TARGET_VERSION_PATTERN } from './targetVersion';

// #8318 wave 2-2 review: the target's install leaves the API only as an opaque MAC.

const install = { targetDeviceId: 'ABCDEF12-3456-4789-8abc-def012345678', agentId: 'agent-1', installIncarnation: 2 };

describe('reattachTargetVersion', () => {
  it('is an opaque 43-character MAC that names neither the agent id nor the incarnation', () => {
    const version = reattachTargetVersion(install);
    expect(version).toMatch(REATTACH_TARGET_VERSION_PATTERN);
    expect(version).not.toContain('agent-1');
  });

  it('matches its own install, whatever case the device id was given in', () => {
    const version = reattachTargetVersion(install);
    expect(reattachTargetVersionMatches(version, install)).toBe(true);
    expect(reattachTargetVersionMatches(version, { ...install, targetDeviceId: install.targetDeviceId.toLowerCase() })).toBe(true);
  });

  it('changes with the device, the agent id and the incarnation', () => {
    const version = reattachTargetVersion(install);
    expect(reattachTargetVersionMatches(version, { ...install, agentId: 'agent-2' })).toBe(false);
    expect(reattachTargetVersionMatches(version, { ...install, installIncarnation: 3 })).toBe(false);
    expect(reattachTargetVersionMatches(version, { ...install, targetDeviceId: 'bcdef123-4567-4890-9bcd-ef0123456789' })).toBe(false);
  });

  it('refuses malformed input', () => {
    expect(reattachTargetVersionMatches('', install)).toBe(false);
    expect(reattachTargetVersionMatches('x'.repeat(42), install)).toBe(false);
    expect(reattachTargetVersionMatches(`${reattachTargetVersion(install).slice(0, 42)}!`, install)).toBe(false);
  });
});
