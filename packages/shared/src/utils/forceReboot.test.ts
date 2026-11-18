import { describe, expect, it } from 'vitest';
import {
  FORCE_REBOOT_MIN_AGENT_VERSION,
  agentSupportsForceReboot,
  forceRebootArgv,
  forceRebootChangesBehavior,
} from './forceReboot';

describe('agentSupportsForceReboot (#8729)', () => {
  it('accepts the minimum, its prerelease and newer versions', () => {
    expect(agentSupportsForceReboot(FORCE_REBOOT_MIN_AGENT_VERSION)).toBe(true);
    expect(agentSupportsForceReboot(`${FORCE_REBOOT_MIN_AGENT_VERSION}-rc.1`)).toBe(true);
    expect(agentSupportsForceReboot(' 0.126.3 ')).toBe(true);
  });

  it('refuses older and unparseable versions (fails closed)', () => {
    for (const v of ['0.124.0', '0.99.9', '', 'dev', 'v0.125.0', null, undefined]) {
      expect(agentSupportsForceReboot(v as string | null | undefined)).toBe(false);
    }
  });
});

describe('forceRebootArgv (#8729)', () => {
  it('adds /f on Windows only', () => {
    expect(forceRebootArgv('windows')).toEqual(['shutdown', '/r', '/f', '/t', '0']);
    expect(forceRebootArgv('macos')).toEqual(['shutdown', '-r', '+0']);
    expect(forceRebootArgv('linux')).toEqual(['shutdown', '-r', '+0']);
    expect(forceRebootArgv('ios')).toBeNull();
    expect(forceRebootChangesBehavior('windows')).toBe(true);
    expect(forceRebootChangesBehavior('macos')).toBe(false);
  });
});
