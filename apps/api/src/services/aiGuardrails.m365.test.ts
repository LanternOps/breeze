import { beforeEach, describe, expect, it, vi } from 'vitest';

// checkToolPermission resolves the caller's permissions via getUserPermissions
// (DB-backed) and tests them with hasPermission. Both are mocked here so the
// RBAC mapping for the M365 tools can be exercised without a DB.
vi.mock(import('./permissions'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getUserPermissions: vi.fn(),
    hasPermission: vi.fn(),
  };
});

import { checkToolPermission } from './aiGuardrails';
import { getUserPermissions, hasPermission } from './permissions';

const auth = {
  user: { id: 'user-1' },
  token: { roleId: 'helpdesk', scope: 'organization' },
  orgId: 'org-1',
  partnerId: null,
} as any;

describe('m365 RBAC', () => {
  beforeEach(() => {
    vi.mocked(getUserPermissions).mockReset();
    vi.mocked(hasPermission).mockReset();
    vi.mocked(getUserPermissions).mockResolvedValue({ roleId: 'helpdesk' } as any);
  });

  it('blocks reset_password for a user lacking m365.execute', async () => {
    vi.mocked(hasPermission).mockReturnValue(false);
    const err = await checkToolPermission(
      'm365_reset_password',
      { userIdentifier: 'x', reason: 'y' },
      auth,
    );
    expect(err).toBeTruthy();
    expect(err).toContain('requires m365.execute');
    expect(hasPermission).toHaveBeenCalledWith(expect.anything(), 'm365', 'execute');
  });

  it('blocks disable_user for a user lacking m365.execute', async () => {
    vi.mocked(hasPermission).mockReturnValue(false);
    const err = await checkToolPermission(
      'm365_disable_user',
      { userIdentifier: 'x', reason: 'y' },
      auth,
    );
    expect(err).toBeTruthy();
    expect(hasPermission).toHaveBeenCalledWith(expect.anything(), 'm365', 'execute');
  });

  it('allows lookup_user for a user with m365.read', async () => {
    vi.mocked(hasPermission).mockReturnValue(true);
    const err = await checkToolPermission(
      'm365_lookup_user',
      { userIdentifier: 'x' },
      auth,
    );
    expect(err).toBeFalsy();
    expect(hasPermission).toHaveBeenCalledWith(expect.anything(), 'm365', 'read');
  });

  it('allows recent_signins and list_group_memberships with m365.read', async () => {
    vi.mocked(hasPermission).mockReturnValue(true);
    expect(await checkToolPermission('m365_recent_signins', { userIdentifier: 'x' }, auth)).toBeFalsy();
    expect(await checkToolPermission('m365_list_group_memberships', { userIdentifier: 'x' }, auth)).toBeFalsy();
    expect(hasPermission).toHaveBeenCalledWith(expect.anything(), 'm365', 'read');
  });

  it('allows reset_password when m365.execute is granted', async () => {
    vi.mocked(hasPermission).mockReturnValue(true);
    const err = await checkToolPermission(
      'm365_reset_password',
      { userIdentifier: 'x', reason: 'y' },
      auth,
    );
    expect(err).toBeFalsy();
    expect(hasPermission).toHaveBeenCalledWith(expect.anything(), 'm365', 'execute');
  });
});
