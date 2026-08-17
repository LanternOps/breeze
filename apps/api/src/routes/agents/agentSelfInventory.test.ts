import { describe, expect, it } from 'vitest';
import { isBreezeAgentProductName, resolveInventoryVersion } from './agentSelfInventory';

describe('isBreezeAgentProductName', () => {
  it('matches both MSI product names, case- and whitespace-insensitively', () => {
    expect(isBreezeAgentProductName('Breeze Agent')).toBe(true);
    expect(isBreezeAgentProductName('  breeze agent  ')).toBe(true);
    expect(isBreezeAgentProductName('Breeze Agent (Self-Hosted)')).toBe(true);
    expect(isBreezeAgentProductName('BREEZE AGENT (SELF-HOSTED)')).toBe(true);
  });

  it('does not match on substrings or neighbouring Breeze products', () => {
    // A substring match would relabel these with the agent's version.
    expect(isBreezeAgentProductName('Breeze Agent Helper')).toBe(false);
    expect(isBreezeAgentProductName('Breeze RMM Watchdog')).toBe(false);
    expect(isBreezeAgentProductName('Breeze Installer')).toBe(false);
    expect(isBreezeAgentProductName('Breeze Backup')).toBe(false);
    expect(isBreezeAgentProductName('Google Chrome')).toBe(false);
  });
});

describe('resolveInventoryVersion (#3591)', () => {
  it('replaces the frozen MSI version of the agent entry with the live agent version', () => {
    // The registry DisplayVersion is whatever the MSI installed originally;
    // self-updates replace the binary without touching it.
    expect(resolveInventoryVersion('Breeze Agent', '0.100.0', '0.105.1')).toBe('0.105.1');
    expect(resolveInventoryVersion('Breeze Agent (Self-Hosted)', '0.101.0', '0.105.1')).toBe('0.105.1');
  });

  it('leaves every other product untouched', () => {
    expect(resolveInventoryVersion('Google Chrome', '127.0', '0.105.1')).toBe('127.0');
    // Not even the version-shaped coincidence of matching the agent version.
    expect(resolveInventoryVersion('7-Zip', '24.06', '0.105.1')).toBe('24.06');
  });

  it('falls back to the reported version when the device has no agent version yet', () => {
    // A device mid-enrollment can report software before its first heartbeat —
    // normalizing must never blank out a version we do have.
    expect(resolveInventoryVersion('Breeze Agent', '0.100.0', null)).toBe('0.100.0');
    expect(resolveInventoryVersion('Breeze Agent', '0.100.0', undefined)).toBe('0.100.0');
    expect(resolveInventoryVersion('Breeze Agent', '0.100.0', '   ')).toBe('0.100.0');
  });

  it('normalizes empty/whitespace reported versions to null', () => {
    expect(resolveInventoryVersion('Google Chrome', '', '0.105.1')).toBeNull();
    expect(resolveInventoryVersion('Google Chrome', '  ', '0.105.1')).toBeNull();
    expect(resolveInventoryVersion('Google Chrome', undefined, '0.105.1')).toBeNull();
    expect(resolveInventoryVersion('Breeze Agent', undefined, null)).toBeNull();
  });

  it('still fills the agent entry when the collector reported no version at all', () => {
    expect(resolveInventoryVersion('Breeze Agent', undefined, '0.105.1')).toBe('0.105.1');
  });
});
