import { describe, expect, it } from 'vitest';
import {
  __compareVersions,
  __evaluateRulesForDevice,
  __matchesVersionRequirement,
} from './policyEvaluationService';

describe('policyEvaluationService internals', () => {
  describe('__compareVersions', () => {
    it('compares semantic-ish versions', () => {
      expect(__compareVersions('10.0.19045', '10.0.19044')).toBe(1);
      expect(__compareVersions('22.04', '22.4')).toBe(0);
      expect(__compareVersions('1.2.0', '1.2.0')).toBe(0);
      expect(__compareVersions('1.2.0', '1.2.1')).toBe(-1);
    });
  });

  describe('__matchesVersionRequirement', () => {
    it('supports any/exact/minimum/maximum operators', () => {
      expect(__matchesVersionRequirement('120.1', '999.0', 'any')).toBe(true);
      expect(__matchesVersionRequirement('120.1', '120.1', 'exact')).toBe(true);
      expect(__matchesVersionRequirement('120.1', '120.2', 'exact')).toBe(false);
      expect(__matchesVersionRequirement('120.2', '120.1', 'minimum')).toBe(true);
      expect(__matchesVersionRequirement('120.1', '120.2', 'minimum')).toBe(false);
      expect(__matchesVersionRequirement('120.1', '120.2', 'maximum')).toBe(true);
      expect(__matchesVersionRequirement('120.2', '120.1', 'maximum')).toBe(false);
    });
  });

  describe('__evaluateRulesForDevice', () => {
    it('passes required software when installed version satisfies minimum', () => {
      const result = __evaluateRulesForDevice(
        [{ type: 'required_software', softwareName: 'Google Chrome', versionOperator: 'minimum', softwareVersion: '120.0' }],
        {
          device: { osType: 'windows', osVersion: '10.0.19045' },
          software: [{ name: 'Google Chrome', version: '121.0.1' }],
        }
      );

      expect(result.passed).toBe(true);
      expect(result.details[0]?.passed).toBe(true);
    });

    it('fails prohibited software when installed', () => {
      const result = __evaluateRulesForDevice(
        [{ type: 'prohibited_software', softwareName: 'BitTorrent' }],
        {
          device: { osType: 'windows', osVersion: '10.0.19045' },
          software: [{ name: 'BitTorrent', version: '7.11' }],
        }
      );

      expect(result.passed).toBe(false);
      expect(result.details[0]?.passed).toBe(false);
      expect(result.details[0]?.message).toContain('is installed');
    });

    it('fails disk rule when free space is below threshold', () => {
      const result = __evaluateRulesForDevice(
        [{ type: 'disk_space_minimum', diskSpaceGB: 20, diskPath: 'C:' }],
        {
          device: { osType: 'windows', osVersion: '10.0.19045' },
          disks: [{ mountPoint: 'C:', device: 'C:', freeGb: 10 }],
        }
      );

      expect(result.passed).toBe(false);
      expect(result.details[0]?.passed).toBe(false);
      expect(result.details[0]?.message).toContain('below minimum');
    });

    it('fails os version rule when device os type does not match', () => {
      const result = __evaluateRulesForDevice(
        [{ type: 'os_version', osType: 'linux', osMinVersion: '22.04' }],
        {
          device: { osType: 'windows', osVersion: '10.0.19045' },
        }
      );

      expect(result.passed).toBe(false);
      expect(result.details[0]?.passed).toBe(false);
      expect(result.details[0]?.message).toContain('does not match required');
    });

    it('fails registry/config checks when state is missing', () => {
      const result = __evaluateRulesForDevice(
        [
          { type: 'registry_check', registryPath: 'HKLM\\SOFTWARE\\Policies\\Example', registryValueName: 'Enabled', registryExpectedValue: '1' },
          { type: 'config_check', configFilePath: '/etc/ssh/sshd_config', configKey: 'PermitRootLogin', configExpectedValue: 'no' }
        ],
        {
          device: { osType: 'windows', osVersion: '10.0.19045' },
        }
      );

      expect(result.passed).toBe(false);
      expect(result.details).toHaveLength(2);
      expect(result.details[0]?.message).toContain('not found');
      expect(result.details[1]?.message).toContain('not found');
    });

    it('passes registry/config checks when expected state exists', () => {
      const result = __evaluateRulesForDevice(
        [
          { type: 'registry_check', registryPath: 'HKLM\\SOFTWARE\\Policies\\Example', registryValueName: 'Enabled', registryExpectedValue: '1' },
          { type: 'config_check', configFilePath: '/etc/ssh/sshd_config', configKey: 'PermitRootLogin', configExpectedValue: 'no' }
        ],
        {
          device: { osType: 'windows', osVersion: '10.0.19045' },
          registryState: [
            { registryPath: 'HKLM\\SOFTWARE\\Policies\\Example', valueName: 'Enabled', valueData: '1', valueType: 'REG_DWORD' }
          ],
          configState: [
            { filePath: '/etc/ssh/sshd_config', configKey: 'PermitRootLogin', configValue: 'no' }
          ]
        }
      );

      expect(result.passed).toBe(true);
      expect(result.details).toHaveLength(2);
      expect(result.details[0]?.passed).toBe(true);
      expect(result.details[1]?.passed).toBe(true);
    });
  });
});
