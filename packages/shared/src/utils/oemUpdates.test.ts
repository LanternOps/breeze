import { describe, expect, it } from 'vitest';
import {
  OEM_CATEGORIES,
  OEM_LANES,
  OEM_OUTCOMES,
  OEM_UPDATE_MIN_AGENT_VERSION,
  agentSupportsOemUpdates,
} from './oemUpdates';

describe('OEM vocab', () => {
  it('OEM_OUTCOMES has exactly the 12 listed', () => {
    expect([...OEM_OUTCOMES]).toEqual([
      'success', 'success_reboot_required', 'no_updates', 'partial', 'failed', 'not_supported',
      'tool_unavailable', 'blocked_on_battery', 'blocked_reboot_pending', 'blocked_no_recovery_key',
      'retry_later', 'interrupted',
    ]);
  });
  it('lanes and categories', () => {
    expect([...OEM_LANES]).toEqual(['dell', 'surface', 'hp', 'lenovo']);
    expect([...OEM_CATEGORIES]).toEqual(['bios', 'firmware', 'driver', 'application']);
  });
});

describe('agentSupportsOemUpdates', () => {
  it('accepts the minimum, its prerelease and newer versions', () => {
    expect(agentSupportsOemUpdates(OEM_UPDATE_MIN_AGENT_VERSION)).toBe(true);
    expect(agentSupportsOemUpdates(`${OEM_UPDATE_MIN_AGENT_VERSION}-rc.1`)).toBe(true);
    expect(agentSupportsOemUpdates(' 0.128.3 ')).toBe(true);
  });
  it('refuses older and unparseable versions (fails closed)', () => {
    for (const v of ['0.126.0', '', 'garbage', 'dev', 'v0.127.0', null, undefined]) {
      expect(agentSupportsOemUpdates(v as string | null | undefined)).toBe(false);
    }
  });
});
