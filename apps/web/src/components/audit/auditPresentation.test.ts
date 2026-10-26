import { describe, expect, it } from 'vitest';
import { actionBadgeClass } from './auditPresentation';

describe('actionBadgeClass (#9672)', () => {
  it('keys the badge on the first segment of the dotted code', () => {
    expect(actionBadgeClass('user.login')).toBe(actionBadgeClass('user.logout'));
    expect(actionBadgeClass('script.execute')).toBe(actionBadgeClass('script.run'));
    expect(actionBadgeClass('agent.command.script')).toBe(actionBadgeClass('agent.sessions.submit'));
  });

  it('gives different families different colours', () => {
    const families = ['user.login', 'device.update', 'script.execute', 'agent.enroll', 'backup.restore.create'];
    expect(new Set(families.map(actionBadgeClass)).size).toBe(families.length);
  });

  it('falls back to the neutral style for an unknown or bare code', () => {
    expect(actionBadgeClass('zzz.unknown')).toBe(actionBadgeClass('session_initiated'));
    expect(actionBadgeClass('zzz.unknown')).toContain('slate');
  });
});
