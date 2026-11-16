import { describe, expect, it } from 'vitest';
import {
  isAllowedPolicyConfigProbe,
  isAllowedPolicyRegistryProbe,
  sanitizePolicyConfigStateEntries,
  sanitizePolicyRegistryStateEntries,
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

describe('policy registry probe safety (#11976)', () => {
  it('allows ordinary policy registry paths in either hive spelling and separator', () => {
    expect(isAllowedPolicyRegistryProbe('HKLM\\SOFTWARE\\Policies\\Microsoft\\Power\\PowerSettings\\{GUID}')).toBe(true);
    expect(isAllowedPolicyRegistryProbe('HKEY_LOCAL_MACHINE/SOFTWARE/Contoso')).toBe(true);
    expect(isAllowedPolicyRegistryProbe('HKCU\\SAM\\NotTheCredentialStore')).toBe(true);
  });

  it('rejects the credential stores (SAM, SECURITY / LSA secrets) however they are spelled', () => {
    expect(isAllowedPolicyRegistryProbe('HKLM\\SAM\\SAM\\Domains\\Account')).toBe(false);
    expect(isAllowedPolicyRegistryProbe('HKEY_LOCAL_MACHINE\\SECURITY\\Policy\\Secrets')).toBe(false);
    expect(isAllowedPolicyRegistryProbe(' hklm/security ')).toBe(false);
    expect(isAllowedPolicyRegistryProbe('HKLM\\SOFTWARE\\..\\SAM')).toBe(false);
    expect(isAllowedPolicyRegistryProbe('HKLM\\\\SAM')).toBe(false);
    // Windows compares key names upper-cased: U+017F (long s) and U+0131
    // (dotless i) upper-case to ASCII S / I, so these open SAM / SECURITY.
    expect(isAllowedPolicyRegistryProbe('HKLM\\ſam\\SAM')).toBe(false);
    expect(isAllowedPolicyRegistryProbe('HKLM\\SECURıTY\\Policy')).toBe(false);
    // The agent trims the sub-path, so leading whitespace still opens SAM.
    expect(isAllowedPolicyRegistryProbe('HKLM \\ SAM\\SAM')).toBe(false);
  });

  it('drops credential-store registry state entries before persistence', () => {
    const entries = sanitizePolicyRegistryStateEntries([
      { registryPath: 'HKLM\\SOFTWARE\\Contoso', valueName: 'Enabled', valueData: 1 },
      { registryPath: 'HKLM\\SECURITY\\Policy\\Secrets\\X', valueName: 'CurrVal', valueData: 'secret' },
    ]);

    expect(entries).toEqual([
      { registryPath: 'HKLM\\SOFTWARE\\Contoso', valueName: 'Enabled', valueData: 1 },
    ]);
  });
});
