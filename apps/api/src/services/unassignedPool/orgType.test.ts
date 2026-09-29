import { describe, expect, it } from 'vitest';
import {
  UNASSIGNED_POOL_ORG_TYPE,
  PARKED_DEVICE_ADMISSION_GUC,
  PARKED_DEVICE_ADMISSION_ENROLLMENT,
  PROTECTED_ORG_ERROR,
  checkPoolMembershipTransition,
  isUnassignedPoolOrgType,
} from './orgType';
import { orgTypeEnum } from '../../db/schema/orgs';

describe('unassigned pool vocabulary', () => {
  it('names the org type and the admission GUC exactly as the migrations do', () => {
    expect(UNASSIGNED_POOL_ORG_TYPE).toBe('unassigned_pool');
    expect(PARKED_DEVICE_ADMISSION_GUC).toBe('breeze.parked_device_admission');
    expect(PARKED_DEVICE_ADMISSION_ENROLLMENT).toBe('enrollment');
    expect(PROTECTED_ORG_ERROR.code).toBe('ORG_PROTECTED');
  });

  it.each([
    ['unassigned_pool', true],
    ['quick_support', false],
    ['customer', false],
    ['internal', false],
    [null, false],
    [undefined, false],
  ] as const)('isUnassignedPoolOrgType(%s) is %s', (type, expected) => {
    expect(isUnassignedPoolOrgType(type)).toBe(expected);
  });
});

describe('checkPoolMembershipTransition (one-way membership)', () => {
  it.each(['generic_move', 'org_merge', 'pool_assignment'] as const)(
    'refuses entry into a holding org via %s',
    (via) => {
      expect(checkPoolMembershipTransition({ sourceOrgType: 'customer', targetOrgType: 'unassigned_pool', via }))
        .toMatchObject({ code: 'POOL_ENTRY_FORBIDDEN' });
    },
  );

  it('refuses pool-to-pool even through assignment', () => {
    expect(checkPoolMembershipTransition({ sourceOrgType: 'unassigned_pool', targetOrgType: 'unassigned_pool', via: 'pool_assignment' }))
      .toMatchObject({ code: 'POOL_ENTRY_FORBIDDEN' });
  });

  it.each(['generic_move', 'org_merge'] as const)('refuses leaving a holding org via %s', (via) => {
    expect(checkPoolMembershipTransition({ sourceOrgType: 'unassigned_pool', targetOrgType: 'customer', via }))
      .toMatchObject({ code: 'POOL_EXIT_REQUIRES_ASSIGNMENT' });
  });

  it('allows leaving a holding org only via pool_assignment', () => {
    expect(checkPoolMembershipTransition({ sourceOrgType: 'unassigned_pool', targetOrgType: 'customer', via: 'pool_assignment' }))
      .toBeNull();
  });

  it('leaves ordinary moves (including quick_support) untouched', () => {
    expect(checkPoolMembershipTransition({ sourceOrgType: 'customer', targetOrgType: 'internal', via: 'generic_move' })).toBeNull();
    expect(checkPoolMembershipTransition({ sourceOrgType: 'quick_support', targetOrgType: 'customer', via: 'generic_move' })).toBeNull();
  });
});

describe('org_type enum', () => {
  it('carries unassigned_pool after the existing labels (database order)', () => {
    expect(orgTypeEnum.enumValues).toEqual(['customer', 'internal', 'quick_support', 'unassigned_pool']);
  });
});
