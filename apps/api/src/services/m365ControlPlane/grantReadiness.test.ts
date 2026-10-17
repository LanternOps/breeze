import { describe, expect, it } from 'vitest';
import { getM365PermissionProfile } from '@breeze/shared/m365';
import { m365RoleReadiness, missingRolesForAction } from './grantReadiness';
import { m365RoleReadiness as reExported } from './connectionService';

const GRAPH = '00000003-0000-0000-c000-000000000000';
const USER_RW = { resourceApplicationId: GRAPH, appRoleId: '741f803b-c850-494e-b5df-cde7c675a1ca', value: 'User.ReadWrite.All' };
const PWD = { resourceApplicationId: GRAPH, appRoleId: 'cc117bb9-00cf-4eb8-b580-ea2a878fe8f7', value: 'User-PasswordProfile.ReadWrite.All' };
const VERIFIED = new Date('2026-10-01T00:00:00.000Z');

describe('m365RoleReadiness', () => {
  const manifest = getM365PermissionProfile('customer-graph-actions');

  it('is re-exported from connectionService (the plan’s public surface)', () => {
    expect(reExported).toBe(m365RoleReadiness);
  });

  it('reports true only for roles present in observed_grants', () => {
    const readiness = m365RoleReadiness({
      permissionManifestVersion: 2, grantsVerifiedAt: VERIFIED, observedGrants: [USER_RW],
    }, manifest);
    expect(readiness['User.ReadWrite.All']).toBe(true);
    expect(readiness['User-PasswordProfile.ReadWrite.All']).toBe(false);
    expect(readiness['GroupMember.ReadWrite.All']).toBe(false);
  });

  it('is keyed by role VALUE and covers every role in the manifest', () => {
    const readiness = m365RoleReadiness({ permissionManifestVersion: 3, grantsVerifiedAt: VERIFIED, observedGrants: [] }, manifest);
    expect(Object.keys(readiness).sort()).toEqual([...manifest.applicationPermissions].sort());
  });

  it('matches on the canonical (resource, appRoleId) key, so a null value still counts', () => {
    const readiness = m365RoleReadiness({
      permissionManifestVersion: 2, grantsVerifiedAt: VERIFIED, observedGrants: [{ ...USER_RW, value: null }],
    }, manifest);
    expect(readiness['User.ReadWrite.All']).toBe(true);
  });

  it('never matches on the value alone: a same-named role from another resource is not the Graph role', () => {
    const readiness = m365RoleReadiness({
      permissionManifestVersion: 2,
      grantsVerifiedAt: VERIFIED,
      observedGrants: [{ resourceApplicationId: '11111111-1111-4111-8111-111111111111', appRoleId: USER_RW.appRoleId, value: 'User.ReadWrite.All' }],
    }, manifest);
    expect(readiness['User.ReadWrite.All']).toBe(false);
  });

  it('reports every role false when there is no authoritative observation', () => {
    const readiness = m365RoleReadiness({
      permissionManifestVersion: 3, grantsVerifiedAt: null, observedGrants: [USER_RW, PWD],
    }, manifest);
    expect(Object.values(readiness).every((ready) => ready === false)).toBe(true);
  });
});

describe('missingRolesForAction', () => {
  const manifest = getM365PermissionProfile('customer-graph-actions');
  const v2Row = { permissionManifestVersion: 2, grantsVerifiedAt: VERIFIED, observedGrants: [USER_RW, PWD] };

  it('returns nothing for the two pre-M1 actions on a pre-M1 grant set', () => {
    expect(missingRolesForAction(v2Row, manifest, 'm365.user.disable')).toEqual([]);
    expect(missingRolesForAction(v2Row, manifest, 'm365.user.reset_password')).toEqual([]);
  });

  it('names the missing role for an M1 action', () => {
    expect(missingRolesForAction(v2Row, manifest, 'm365.group.membership.remove')).toEqual(['GroupMember.ReadWrite.All']);
    expect(missingRolesForAction(v2Row, manifest, 'm365.user.revoke_sessions')).toEqual(['User.RevokeSessions.All']);
  });

  it('returns null (no authoritative observation, do not refuse) when grantsVerifiedAt is null', () => {
    expect(missingRolesForAction({ ...v2Row, grantsVerifiedAt: null, observedGrants: [] }, manifest, 'm365.group.membership.add'))
      .toBeNull();
  });
});
