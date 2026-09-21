import { describe, it, expect } from 'vitest';
import { touchesProtectedNames } from './aiGuardrails';

const PROTECTED = {
  services: ['Spooler'],
  paths: ['C:\\Windows'],
  registryKeys: ['HKLM\\SOFTWARE\\Breeze'],
  deviceTags: ['production'],
};

describe('touchesProtectedNames', () => {
  it('matches a service case-insensitively', () => {
    expect(touchesProtectedNames({ services: ['spooler'] }, PROTECTED)).toBe('service "spooler" is protected');
  });
  it('matches a descendant path, not just an exact one', () => {
    expect(touchesProtectedNames({ paths: ['C:\\Windows\\System32\\drivers'] }, PROTECTED)).toContain('is protected');
  });
  it('matches a descendant registry key', () => {
    expect(touchesProtectedNames({ registryKeys: ['HKLM\\SOFTWARE\\Breeze\\Agent'] }, PROTECTED)).toContain(
      'is protected',
    );
  });
  it('matches a device tag case-insensitively', () => {
    expect(touchesProtectedNames({ deviceTags: ['Production'] }, PROTECTED)).toBe('device tag "Production" is protected');
  });
  it('returns null when nothing matches', () => {
    expect(touchesProtectedNames({ services: ['Themes'], paths: ['D:\\temp'] }, PROTECTED)).toBeNull();
  });
  it('an empty name set never matches', () => {
    expect(touchesProtectedNames({}, PROTECTED)).toBeNull();
  });
});
