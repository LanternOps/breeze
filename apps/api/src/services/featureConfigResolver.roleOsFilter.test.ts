import { describe, it, expect } from 'vitest';
import {
  matchesRoleOsFilter,
  buildRoleOsFilterConditions,
} from './featureConfigResolver';

describe('matchesRoleOsFilter', () => {
  const workstationWindows = { deviceRole: 'workstation', osType: 'windows' };
  const serverLinux = { deviceRole: 'server', osType: 'linux' };

  it('matches when both filters are null or undefined (backward compatible match-all)', () => {
    expect(matchesRoleOsFilter({}, workstationWindows)).toBe(true);
    expect(matchesRoleOsFilter({ roleFilter: null, osFilter: null }, workstationWindows)).toBe(true);
    expect(matchesRoleOsFilter({ roleFilter: undefined, osFilter: undefined }, workstationWindows)).toBe(true);
  });

  it('matches when device role is included in roleFilter', () => {
    expect(matchesRoleOsFilter({ roleFilter: ['workstation', 'laptop'] }, workstationWindows)).toBe(true);
    expect(matchesRoleOsFilter({ roleFilter: ['server'] }, workstationWindows)).toBe(false);
  });

  it('matches when device os is included in osFilter', () => {
    expect(matchesRoleOsFilter({ osFilter: ['windows'] }, workstationWindows)).toBe(true);
    expect(matchesRoleOsFilter({ osFilter: ['linux', 'darwin'] }, workstationWindows)).toBe(false);
  });

  it('treats empty array roleFilter as match-none (canonical Postgres ANY semantics)', () => {
    expect(matchesRoleOsFilter({ roleFilter: [] }, workstationWindows)).toBe(false);
    expect(matchesRoleOsFilter({ roleFilter: [] }, serverLinux)).toBe(false);
  });

  it('treats empty array osFilter as match-none (canonical Postgres ANY semantics)', () => {
    expect(matchesRoleOsFilter({ osFilter: [] }, workstationWindows)).toBe(false);
    expect(matchesRoleOsFilter({ osFilter: [] }, serverLinux)).toBe(false);
  });

  it('requires both role and os to match when both are specified', () => {
    const filter = { roleFilter: ['workstation'], osFilter: ['linux'] };
    expect(matchesRoleOsFilter(filter, workstationWindows)).toBe(false); // wrong os
    expect(matchesRoleOsFilter(filter, serverLinux)).toBe(false); // wrong role
    expect(matchesRoleOsFilter(filter, { deviceRole: 'workstation', osType: 'linux' })).toBe(true);
  });

  it('fails match when device has null/missing attributes but filter is specified', () => {
    expect(matchesRoleOsFilter({ roleFilter: ['workstation'] }, { deviceRole: null, osType: 'windows' })).toBe(false);
    expect(matchesRoleOsFilter({ osFilter: ['windows'] }, { deviceRole: 'workstation', osType: null })).toBe(false);
  });
});

describe('buildRoleOsFilterConditions', () => {
  it('generates two SQL conditions for role and os filters', () => {
    const conditions = buildRoleOsFilterConditions({ deviceRole: 'workstation', osType: 'windows' });
    expect(conditions).toHaveLength(2);
  });
});
