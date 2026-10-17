import { describe, expect, it } from 'vitest';
import { CA_MAX_EXCLUDED_GROUPS, CA_MAX_EXCLUDED_USERS, caPolicyEnforcesMfaForAllUsers } from './m365CaMfaEnforcement';

// Field names follow the Microsoft Graph conditionalAccessPolicy resource, which the m365 sync stores verbatim.
const conditions = (over: Record<string, unknown> = {}, users: Record<string, unknown> = {}) => ({
  users: { includeUsers: ['All'], excludeUsers: [], excludeGroups: [], excludeRoles: [], ...users },
  applications: { includeApplications: ['All'] },
  clientAppTypes: ['all'],
  ...over,
});
const grant = (over: Record<string, unknown> = {}) => ({ operator: 'OR', builtInControls: ['mfa'], authenticationStrength: null, ...over });
const policy = (over: Partial<Parameters<typeof caPolicyEnforcesMfaForAllUsers>[0]> = {}) => ({
  state: 'enabled', isStale: false, conditions: conditions(), grantControls: grant(), ...over,
});

describe('caPolicyEnforcesMfaForAllUsers', () => {
  it('exposes the break-glass limits', () => {
    expect(CA_MAX_EXCLUDED_USERS).toBe(5);
    expect(CA_MAX_EXCLUDED_GROUPS).toBe(1);
  });

  it('true for an enabled all-users all-apps policy requiring mfa as the only control', () => {
    expect(caPolicyEnforcesMfaForAllUsers(policy())).toBe(true);
  });

  it('true at the exclusion limits (5 emergency users, 1 group)', () => {
    const c = conditions({}, { excludeUsers: ['a', 'b', 'c', 'd', 'e'], excludeGroups: ['g'] });
    expect(caPolicyEnforcesMfaForAllUsers(policy({ conditions: c }))).toBe(true);
  });

  it('true via an authentication strength', () => {
    expect(caPolicyEnforcesMfaForAllUsers(policy({ grantControls: { operator: 'OR', builtInControls: [], authenticationStrength: { id: 's', displayName: 'MFA' } } }))).toBe(true);
  });

  it('true for operator AND of mfa + compliantDevice', () => {
    expect(caPolicyEnforcesMfaForAllUsers(policy({ grantControls: grant({ operator: 'AND', builtInControls: ['mfa', 'compliantDevice'] }) }))).toBe(true);
  });

  it('true when clientAppTypes is absent or empty or includes all', () => {
    expect(caPolicyEnforcesMfaForAllUsers(policy({ conditions: conditions({ clientAppTypes: undefined }) }))).toBe(true);
    expect(caPolicyEnforcesMfaForAllUsers(policy({ conditions: conditions({ clientAppTypes: [] }) }))).toBe(true);
    expect(caPolicyEnforcesMfaForAllUsers(policy({ conditions: conditions({ clientAppTypes: ['browser', 'all'] }) }))).toBe(true);
  });

  it.each([
    ['report-only state', policy({ state: 'enabledForReportingButNotEnforced' })],
    ['disabled state', policy({ state: 'disabled' })],
    ['null state', policy({ state: null })],
    ['stale row', policy({ isStale: true })],
    ['group-only include', policy({ conditions: conditions({}, { includeUsers: [], includeGroups: ['g'] }) })],
    ['6 excluded users', policy({ conditions: conditions({}, { excludeUsers: ['a', 'b', 'c', 'd', 'e', 'f'] }) })],
    ['2 excluded groups', policy({ conditions: conditions({}, { excludeGroups: ['g1', 'g2'] }) })],
    ['excluded roles', policy({ conditions: conditions({}, { excludeRoles: ['r'] }) })],
    ['specific apps', policy({ conditions: conditions({ applications: { includeApplications: ['app-1'] } }) })],
    ['browser-only client types', policy({ conditions: conditions({ clientAppTypes: ['browser'] }) })],
    ['OR with compliantDevice', policy({ grantControls: grant({ operator: 'OR', builtInControls: ['mfa', 'compliantDevice'] }) })],
    ['no mfa control', policy({ grantControls: grant({ builtInControls: ['compliantDevice'] }) })],
    ['block only', policy({ grantControls: grant({ builtInControls: ['block'] }) })],
    ['null grantControls', policy({ grantControls: null })],
  ])('false: %s', (_name, p) => {
    expect(caPolicyEnforcesMfaForAllUsers(p)).toBe(false);
  });

  it.each([['x'], [null], [[]], [42], [{ users: 'x' }], [{ users: null }]])('never throws on malformed conditions %j', (c) => {
    expect(caPolicyEnforcesMfaForAllUsers(policy({ conditions: c }))).toBe(false);
  });

  it.each([['x'], [[]], [7], [{ builtInControls: 'mfa' }], [{ builtInControls: [1, null] }]])('never throws on malformed grantControls %j', (g) => {
    expect(caPolicyEnforcesMfaForAllUsers(policy({ grantControls: g }))).toBe(false);
  });
});
