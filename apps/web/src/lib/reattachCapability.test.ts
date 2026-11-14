import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const { claimsMock, canMock } = vi.hoisted(() => ({ claimsMock: vi.fn(), canMock: vi.fn() }));
vi.mock('./authScope', () => ({ useJwtClaims: claimsMock }));
vi.mock('./permissions', () => ({ usePermissions: () => ({ permissions: [], can: canMock }) }));

import { useCanReattachDevice } from './reattachCapability';

const resolved = (scope: string) => ({ status: 'resolved', claims: { scope } });

beforeEach(() => {
  vi.clearAllMocks();
  canMock.mockReturnValue(true);
});

describe('useCanReattachDevice (#8318)', () => {
  it('a partner user with devices:write and devices:delete may reattach', () => {
    claimsMock.mockReturnValue(resolved('partner'));
    expect(renderHook(() => useCanReattachDevice()).result.current).toBe(true);
    expect(canMock).toHaveBeenCalledWith('devices', 'write');
    expect(canMock).toHaveBeenCalledWith('devices', 'delete');
  });

  it('without devices:delete it may not', () => {
    claimsMock.mockReturnValue(resolved('partner'));
    canMock.mockImplementation((_r: string, action: string) => action !== 'delete');
    expect(renderHook(() => useCanReattachDevice()).result.current).toBe(false);
  });

  it.each(['organization', 'system'])('a %s-scoped user may not (the route is partner scope only)', (scope) => {
    claimsMock.mockReturnValue(resolved(scope));
    expect(renderHook(() => useCanReattachDevice()).result.current).toBe(false);
  });

  it('unresolved claims read as false', () => {
    claimsMock.mockReturnValue({ status: 'unresolved' });
    expect(renderHook(() => useCanReattachDevice()).result.current).toBe(false);
  });
});
