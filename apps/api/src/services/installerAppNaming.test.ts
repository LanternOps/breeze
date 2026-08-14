import { describe, it, expect } from 'vitest';
import {
  INSTALLER_DMG_NAME,
  stampedInstallerAppName,
  stampedInstallerDmgName,
} from './installerAppNaming';

describe('stampedInstallerDmgName', () => {
  // CONTRACT with agent/installer/macos-app — the shipped Swift installer
  // parses its enrollment token out of this exact filename shape. Any drift
  // here yields a DMG that downloads fine and then never enrolls.
  it('produces `Nodes Unlimited Agent [TOKEN@host].dmg`', () => {
    expect(stampedInstallerDmgName('ABCDE12345', 'api.example.com')).toBe(
      'Nodes Unlimited Agent [ABCDE12345@api.example.com].dmg',
    );
  });

  it('uses SQUARE BRACKETS with exactly one space before the bracket', () => {
    const name = stampedInstallerDmgName('Z9Y8X7W6V5', 'nu.example.org');
    expect(name).toMatch(
      /^Nodes Unlimited Agent \[[A-Z0-9]{10}@[A-Za-z0-9.-]+\]\.dmg$/,
    );
    expect(name).toContain(' [');
    expect(name).not.toContain('(');
    expect(name.endsWith('.dmg')).toBe(true);
  });

  it('is distinct from the app-bundle stamp (different product, different suffix)', () => {
    expect(stampedInstallerDmgName('ABCDE12345', 'h.example.com')).not.toBe(
      stampedInstallerAppName('ABCDE12345', 'h.example.com'),
    );
  });

  it('names the unstamped release asset without a token', () => {
    expect(INSTALLER_DMG_NAME).toBe('Nodes Unlimited Agent.dmg');
  });
});
