import { beforeEach, describe, expect, it, vi } from 'vitest';

// NOTE (2026-09-17 ROLE audit §2.6): these tools used to require `m365:read` /
// `m365:execute`, neither of which exists in the canonical permission catalog
// (packages/shared/src/constants/permissions.ts) — only an `*:*` grant ever
// satisfied them. The whole M365 surface is owned by organizations:read /
// organizations:write at its routes (m365.ts:29-30,
// m365CustomerGraphRead.ts:47-51, m365CustomerGraphActions.ts:44-48), which is
// what the sibling m365_query_* tools already used.
//
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

import { checkGuardrails, checkToolPermission } from './aiGuardrails';
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

  it('blocks reset_password for a user lacking organizations:write', async () => {
    vi.mocked(hasPermission).mockReturnValue(false);
    const err = await checkToolPermission(
      'm365_reset_password',
      { userIdentifier: 'x', reason: 'y' },
      auth,
    );
    expect(err).toBeTruthy();
    expect(err).toContain('requires organizations.write');
    expect(hasPermission).toHaveBeenCalledWith(expect.anything(), 'organizations', 'write');
  });

  it('blocks disable_user for a user lacking organizations:write', async () => {
    vi.mocked(hasPermission).mockReturnValue(false);
    const err = await checkToolPermission(
      'm365_disable_user',
      { userIdentifier: 'x', reason: 'y' },
      auth,
    );
    expect(err).toBeTruthy();
    expect(hasPermission).toHaveBeenCalledWith(expect.anything(), 'organizations', 'write');
  });

  it('allows lookup_user for a user with organizations:read', async () => {
    vi.mocked(hasPermission).mockReturnValue(true);
    const err = await checkToolPermission(
      'm365_lookup_user',
      { userIdentifier: 'x' },
      auth,
    );
    expect(err).toBeFalsy();
    expect(hasPermission).toHaveBeenCalledWith(expect.anything(), 'organizations', 'read');
  });

  it('allows recent_signins and list_group_memberships with organizations:read', async () => {
    vi.mocked(hasPermission).mockReturnValue(true);
    expect(await checkToolPermission('m365_recent_signins', { userIdentifier: 'x' }, auth)).toBeFalsy();
    expect(await checkToolPermission('m365_list_group_memberships', { userIdentifier: 'x' }, auth)).toBeFalsy();
    expect(hasPermission).toHaveBeenCalledWith(expect.anything(), 'organizations', 'read');
  });

  it('allows reset_password when organizations:write is granted', async () => {
    vi.mocked(hasPermission).mockReturnValue(true);
    const err = await checkToolPermission(
      'm365_reset_password',
      { userIdentifier: 'x', reason: 'y' },
      auth,
    );
    expect(err).toBeFalsy();
    expect(hasPermission).toHaveBeenCalledWith(expect.anything(), 'organizations', 'write');
  });
});

// Regression guard for the tier-resolution gap: M365 tools are registered for
// the SDK runtime (TOOL_TIERS) but live OUTSIDE the `aiTools` registry that
// getToolTier reads, so checkGuardrails used to fail-close every M365 call as
// tier-4 "Unknown tool" — blocking the feature entirely. These assert the real
// guardrail tiers so the registry/SDK tier sources can't silently drift apart.
describe('m365 guardrail tiers', () => {
  it('treats read-only M365 tools as tier 1 (no approval)', () => {
    for (const name of ['m365_lookup_user', 'm365_recent_signins', 'm365_list_group_memberships']) {
      const check = checkGuardrails(name, {});
      expect(check.allowed).toBe(true);
      expect(check.tier).toBe(1);
      expect(check.requiresApproval).toBe(false);
    }
  });

  it('treats mutating M365 tools as tier 3 (per-step approval)', () => {
    for (const name of ['m365_disable_user', 'm365_reset_password']) {
      const check = checkGuardrails(name, { userIdentifier: 'x', reason: 'y' });
      expect(check.allowed).toBe(true);
      expect(check.tier).toBe(3);
      expect(check.requiresApproval).toBe(true);
    }
  });

  it('still fail-closes a genuinely unknown tool as tier 4', () => {
    const check = checkGuardrails('m365_not_a_real_tool', {});
    expect(check.allowed).toBe(false);
    expect(check.tier).toBe(4);
  });
});
