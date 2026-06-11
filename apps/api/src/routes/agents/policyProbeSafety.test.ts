import { describe, expect, it } from 'vitest';
import {
  isAllowedPolicyConfigProbe,
  sanitizePolicyConfigStateEntries,
} from './policyProbeSafety';

describe('policy config probe safety', () => {
  it('allows known compliance config paths and keys', () => {
    expect(isAllowedPolicyConfigProbe('/etc/ssh/sshd_config', 'PermitRootLogin')).toBe(true);
    expect(isAllowedPolicyConfigProbe('/etc/sysctl.d/99-hardening.conf', 'net.ipv4.ip_forward')).toBe(true);
  });

  it('rejects arbitrary config paths and sensitive key names', () => {
    expect(isAllowedPolicyConfigProbe('/etc/breeze/agent.yaml', 'auth_token')).toBe(false);
    expect(isAllowedPolicyConfigProbe('/root/.ssh/config', 'IdentityFile')).toBe(false);
    expect(isAllowedPolicyConfigProbe('/etc/ssh/sshd_config', 'ApiToken')).toBe(false);
    expect(isAllowedPolicyConfigProbe('/etc/../etc/shadow', 'root')).toBe(false);
  });

  it('drops unsafe state entries before persistence', () => {
    const entries = sanitizePolicyConfigStateEntries([
      { filePath: '/etc/ssh/sshd_config', configKey: 'PermitRootLogin', configValue: 'no' },
      { filePath: '/etc/breeze/agent.yaml', configKey: 'auth_token', configValue: 'secret' },
    ]);

    expect(entries).toEqual([
      { filePath: '/etc/ssh/sshd_config', configKey: 'PermitRootLogin', configValue: 'no' },
    ]);
  });
});
