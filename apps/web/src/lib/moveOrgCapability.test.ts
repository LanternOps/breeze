import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const { claimsMock, canMock } = vi.hoisted(() => ({ claimsMock: vi.fn(), canMock: vi.fn() }));
vi.mock('./authScope', () => ({ useJwtClaims: claimsMock }));
vi.mock('./permissions', () => ({ usePermissions: () => ({ permissions: [], can: canMock }) }));

import { useCanMoveDeviceOrg } from './moveOrgCapability';

const grantAll = (r: string, a: string) =>
  (r === 'devices' && a === 'write') || (r === 'organizations' && a === 'write');

describe('useCanMoveDeviceOrg', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('is true for a partner-scope caller holding devices:write and organizations:write', () => {
    claimsMock.mockReturnValue({ status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p1' } });
    canMock.mockImplementation(grantAll);
    expect(renderHook(() => useCanMoveDeviceOrg()).result.current).toBe(true);
  });

  it('is true for system scope with both permissions', () => {
    claimsMock.mockReturnValue({ status: 'resolved', claims: { scope: 'system', orgId: null, partnerId: null } });
    canMock.mockImplementation(grantAll);
    expect(renderHook(() => useCanMoveDeviceOrg()).result.current).toBe(true);
  });

  it('is false for an organization-scope caller even with both permissions (the route is partner/system only)', () => {
    claimsMock.mockReturnValue({ status: 'resolved', claims: { scope: 'organization', orgId: 'o1', partnerId: 'p1' } });
    canMock.mockImplementation(grantAll);
    expect(renderHook(() => useCanMoveDeviceOrg()).result.current).toBe(false);
  });

  it('is false while claims are unresolved (no flash of an action that may 403)', () => {
    claimsMock.mockReturnValue({ status: 'unresolved' });
    canMock.mockImplementation(grantAll);
    expect(renderHook(() => useCanMoveDeviceOrg()).result.current).toBe(false);
  });

  it('is false when either permission is missing', () => {
    claimsMock.mockReturnValue({ status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p1' } });
    canMock.mockImplementation((r: string, a: string) => r === 'devices' && a === 'write');
    expect(renderHook(() => useCanMoveDeviceOrg()).result.current).toBe(false);
  });
});
