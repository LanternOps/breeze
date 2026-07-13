import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Backup profiles are dual-axis (org_id XOR partner_id) and partner-wide rows
// fan out to EVERY org under the partner. RLS is the backstop, but the gates
// exercised here are app-layer only — a partner tech with limited org access
// PASSES the RLS policy for a partner-wide row (breeze_has_partner_access is
// flat), so the canManagePartnerWidePolicies check in the route is the one and
// only thing stopping them from rewriting or deleting a profile that governs
// every customer. These tests pin that, plus the RLS 0-row write contract.

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PARTNER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const PROFILE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

vi.mock('../../services', () => ({}));

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'returning', 'values', 'set', 'orderBy', 'innerJoin']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

const selectMock = vi.fn(() => chainMock([]));
const insertMock = vi.fn(() => chainMock([]));
const updateMock = vi.fn(() => chainMock([]));
const deleteMock = vi.fn(() => chainMock([]));

type AuthState = {
  user: { id: string; email: string; name: string };
  scope: 'organization' | 'partner' | 'system';
  partnerId: string | null;
  partnerOrgAccess?: 'all' | 'selected' | null;
  orgId: string | null;
  token: { sub: string };
  orgCondition: (col: unknown) => unknown;
};

let authState: AuthState;

vi.mock('../../db', () => ({
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
    delete: (...args: unknown[]) => deleteMock(...(args as [])),
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
}));

vi.mock('../../db/schema', () => ({
  backupProfiles: {
    id: 'backup_profiles.id',
    orgId: 'backup_profiles.org_id',
    partnerId: 'backup_profiles.partner_id',
    name: 'backup_profiles.name',
    description: 'backup_profiles.description',
    selections: 'backup_profiles.selections',
    isActive: 'backup_profiles.is_active',
    createdBy: 'backup_profiles.created_by',
    updatedAt: 'backup_profiles.updated_at',
  },
  configPolicyBackupSettings: {
    featureLinkId: 'config_policy_backup_settings.feature_link_id',
    backupProfileId: 'config_policy_backup_settings.backup_profile_id',
  },
  configPolicyFeatureLinks: {
    id: 'config_policy_feature_links.id',
    configPolicyId: 'config_policy_feature_links.config_policy_id',
  },
  configurationPolicies: {
    id: 'configuration_policies.id',
    name: 'configuration_policies.name',
  },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authState);
    return next();
  }),
  requirePermission: vi.fn(() => (c: any, next: any) => next()),
  requireMfa: vi.fn(() => (c: any, next: any) => next()),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
}));

vi.mock('../../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

import { authMiddleware } from '../../middleware/auth';
import { profilesRoutes } from './profiles';

const VALID_SELECTIONS = { file: { enabled: true, paths: ['C:\\Users'] } };

/** An org-owned profile row as it comes back from the DB. */
const ORG_PROFILE = {
  id: PROFILE_ID,
  orgId: ORG_ID,
  partnerId: null,
  name: 'Workstation',
  selections: VALID_SELECTIONS,
  isActive: true,
};

/** A partner-wide profile row — org_id NULL, governs every org. */
const PARTNER_PROFILE = {
  id: PROFILE_ID,
  orgId: null,
  partnerId: PARTNER_ID,
  name: 'Server (all orgs)',
  selections: VALID_SELECTIONS,
  isActive: true,
};

function partnerAuth(orgAccess: 'all' | 'selected'): AuthState {
  return {
    user: { id: 'user-123', email: 'tech@msp.example', name: 'Partner Tech' },
    scope: 'partner',
    partnerId: PARTNER_ID,
    partnerOrgAccess: orgAccess,
    orgId: null,
    token: { sub: 'user-123' },
    orgCondition: () => 'ORG_COND',
  };
}

describe('backup profiles routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    insertMock.mockReset();
    updateMock.mockReset();
    deleteMock.mockReset();

    authState = {
      user: { id: 'user-123', email: 'admin@customer.example', name: 'Org Admin' },
      scope: 'organization',
      partnerId: null,
      partnerOrgAccess: null,
      orgId: ORG_ID,
      token: { sub: 'user-123' },
      orgCondition: () => 'ORG_COND',
    };

    app = new Hono();
    app.use('*', authMiddleware as any);
    app.route('/backup', profilesRoutes);
  });

  describe('POST /profiles — ownerScope', () => {
    it('creates an org-owned profile for an org-scoped caller', async () => {
      insertMock.mockReturnValue(chainMock([ORG_PROFILE]));

      const res = await app.request('/backup/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Workstation', selections: VALID_SELECTIONS }),
      });

      expect(res.status).toBe(201);
      const values = vi.mocked(insertMock.mock.results[0]!.value.values).mock.calls[0]![0];
      expect(values).toMatchObject({ orgId: ORG_ID, partnerId: null });
    });

    it('denies partner-wide creation to a partner tech without full org access', async () => {
      authState = partnerAuth('selected');

      const res = await app.request('/backup/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Server',
          ownerScope: 'partner',
          selections: VALID_SELECTIONS,
        }),
      });

      expect(res.status).toBe(403);
      expect(insertMock).not.toHaveBeenCalled();
    });

    it('creates a partner-wide profile for a full-access partner admin, taking the partner from the TOKEN', async () => {
      authState = partnerAuth('all');
      insertMock.mockReturnValue(chainMock([PARTNER_PROFILE]));

      const res = await app.request('/backup/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Server',
          ownerScope: 'partner',
          // A hostile client cannot smuggle in someone else's partner: the
          // route derives partnerId from the token, never the payload.
          partnerId: '00000000-0000-4000-8000-000000000000',
          selections: VALID_SELECTIONS,
        }),
      });

      expect(res.status).toBe(201);
      const values = vi.mocked(insertMock.mock.results[0]!.value.values).mock.calls[0]![0];
      expect(values).toMatchObject({ orgId: null, partnerId: PARTNER_ID });
    });
  });

  describe('PATCH /profiles/:id — partner-wide gate', () => {
    it('denies updating a partner-wide profile without full partner access', async () => {
      // The row IS visible to this caller (RLS partner access is flat) — the
      // app-layer gate is the only thing standing between a limited tech and
      // every org's backup selections.
      authState = partnerAuth('selected');
      selectMock.mockReturnValue(chainMock([PARTNER_PROFILE]));

      const res = await app.request(`/backup/profiles/${PROFILE_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Hijacked' }),
      });

      expect(res.status).toBe(403);
      expect(updateMock).not.toHaveBeenCalled();
    });

    it('allows a full-access partner admin to update a partner-wide profile', async () => {
      authState = partnerAuth('all');
      selectMock.mockReturnValue(chainMock([PARTNER_PROFILE]));
      updateMock.mockReturnValue(chainMock([{ ...PARTNER_PROFILE, name: 'Server v2' }]));

      const res = await app.request(`/backup/profiles/${PROFILE_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Server v2' }),
      });

      expect(res.status).toBe(200);
      expect(updateMock).toHaveBeenCalled();
    });

    it('404s when the update matches 0 rows (RLS hid the row from the write)', async () => {
      // A 0-row write under forced RLS is a silent no-op, not an error.
      // Reporting success here would tell the user their edit saved when it did not.
      selectMock.mockReturnValue(chainMock([ORG_PROFILE]));
      updateMock.mockReturnValue(chainMock([]));

      const res = await app.request(`/backup/profiles/${PROFILE_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      });

      expect(res.status).toBe(404);
    });

    it('404s when the profile is not visible to the caller', async () => {
      selectMock.mockReturnValue(chainMock([]));

      const res = await app.request(`/backup/profiles/${PROFILE_ID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      });

      expect(res.status).toBe(404);
      expect(updateMock).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /profiles/:id', () => {
    it('denies deleting a partner-wide profile without full partner access', async () => {
      authState = partnerAuth('selected');
      selectMock.mockReturnValue(chainMock([PARTNER_PROFILE]));

      const res = await app.request(`/backup/profiles/${PROFILE_ID}`, { method: 'DELETE' });

      expect(res.status).toBe(403);
      expect(deleteMock).not.toHaveBeenCalled();
    });

    it('409s with the referencing policies when the profile is still in use', async () => {
      selectMock
        .mockReturnValueOnce(chainMock([ORG_PROFILE])) // access lookup
        .mockReturnValueOnce(chainMock([{ policyId: 'p-1', policyName: 'Servers' }])); // referencing

      const res = await app.request(`/backup/profiles/${PROFILE_ID}`, { method: 'DELETE' });

      expect(res.status).toBe(409);
      const body = await res.json();
      // The UI names the blocking policies from this payload — losing it strands
      // the user on "can't delete" with no way to find out why.
      expect(body.referencingPolicies).toEqual([{ policyId: 'p-1', policyName: 'Servers' }]);
      expect(deleteMock).not.toHaveBeenCalled();
    });

    it('deletes an unreferenced profile', async () => {
      selectMock
        .mockReturnValueOnce(chainMock([ORG_PROFILE]))
        .mockReturnValueOnce(chainMock([]));
      deleteMock.mockReturnValue(chainMock([{ id: PROFILE_ID }]));

      const res = await app.request(`/backup/profiles/${PROFILE_ID}`, { method: 'DELETE' });

      expect(res.status).toBe(200);
      expect(deleteMock).toHaveBeenCalled();
    });

    it('404s instead of claiming success when the delete matches 0 rows', async () => {
      selectMock
        .mockReturnValueOnce(chainMock([ORG_PROFILE]))
        .mockReturnValueOnce(chainMock([]));
      deleteMock.mockReturnValue(chainMock([])); // RLS no-op

      const res = await app.request(`/backup/profiles/${PROFILE_ID}`, { method: 'DELETE' });

      expect(res.status).toBe(404);
    });

    it('returns the friendly 409 when the RESTRICT FK fires on a race', async () => {
      // A policy can link the profile between the in-use check and the DELETE.
      selectMock
        .mockReturnValueOnce(chainMock([ORG_PROFILE]))
        .mockReturnValueOnce(chainMock([])) // not in use at check time
        .mockReturnValueOnce(chainMock([{ policyId: 'p-9', policyName: 'Raced In' }]));
      const fkError = Object.assign(new Error('FK violation'), { code: '23503' });
      deleteMock.mockReturnValue(
        Object.assign(Promise.reject(fkError), {
          where: vi.fn(() => ({ returning: vi.fn(() => Promise.reject(fkError)) })),
        }) as any
      );

      const res = await app.request(`/backup/profiles/${PROFILE_ID}`, { method: 'DELETE' });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.referencingPolicies).toEqual([{ policyId: 'p-9', policyName: 'Raced In' }]);
    });
  });
});
