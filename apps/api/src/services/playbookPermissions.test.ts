import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./permissions', () => ({
  getUserPermissions: vi.fn(),
  hasPermission: vi.fn(),
}));

import { getUserPermissions, hasPermission } from './permissions';
import {
  checkPlaybookRequiredPermissions,
  parsePlaybookRequiredPermissions,
} from './playbookPermissions';

const AUTH = {
  user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
  partnerId: null,
  orgId: 'org-1',
  scope: 'organization',
} as any;

const AUTH_SYSTEM = {
  user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
  partnerId: null,
  orgId: null,
  scope: 'system',
} as any;

describe('playbookPermissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('parsePlaybookRequiredPermissions', () => {
    it('parses string permissions and deduplicates', () => {
      const parsed = parsePlaybookRequiredPermissions([
        'devices:execute',
        'devices:execute',
        'scripts:execute',
      ]);

      expect(parsed).toEqual([
        { resource: 'devices', action: 'execute' },
        { resource: 'scripts', action: 'execute' },
      ]);
    });

    it('parses object permissions and ignores invalid items', () => {
      const parsed = parsePlaybookRequiredPermissions([
        { resource: 'devices', action: 'read' },
        { resource: 'devices', action: '' },
        'malformed',
        null,
      ]);

      expect(parsed).toEqual([{ resource: 'devices', action: 'read' }]);
    });
  });

  describe('checkPlaybookRequiredPermissions', () => {
    it('allows when no required permissions are configured', async () => {
      const result = await checkPlaybookRequiredPermissions(undefined, AUTH);
      expect(result).toEqual({ allowed: true, missingPermissions: [] });
      expect(getUserPermissions).not.toHaveBeenCalled();
    });

    it('denies when user permission context cannot be resolved', async () => {
      vi.mocked(getUserPermissions).mockResolvedValueOnce(null as any);

      const result = await checkPlaybookRequiredPermissions(['devices:execute'], AUTH);
      expect(result.allowed).toBe(false);
      expect(result.error).toBe('No permissions found');
      expect(result.missingPermissions).toEqual(['devices:execute']);
    });

    it('returns missing permissions when user lacks required access', async () => {
      vi.mocked(getUserPermissions).mockResolvedValueOnce({
        permissions: [],
      } as any);
      vi.mocked(hasPermission).mockImplementation((_userPerms, resource, action) => {
        return resource === 'devices' && action === 'read';
      });

      const result = await checkPlaybookRequiredPermissions(
        ['devices:read', 'scripts:execute'],
        AUTH
      );

      expect(result.allowed).toBe(false);
      expect(result.missingPermissions).toEqual(['scripts:execute']);
    });

    it('allows when user has all required permissions', async () => {
      vi.mocked(getUserPermissions).mockResolvedValueOnce({
        permissions: [{ resource: '*', action: '*' }],
      } as any);
      vi.mocked(hasPermission).mockReturnValue(true);

      const result = await checkPlaybookRequiredPermissions(
        ['devices:execute', 'scripts:execute'],
        AUTH
      );

      expect(result).toEqual({ allowed: true, missingPermissions: [] });
    });

    it('allows system-scope callers for required playbook permissions', async () => {
      const result = await checkPlaybookRequiredPermissions(['devices:execute'], AUTH_SYSTEM);

      expect(result).toEqual({ allowed: true, missingPermissions: [] });
      expect(getUserPermissions).not.toHaveBeenCalled();
    });
  });
});
