import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
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
  allowedSiteIds?: string[];
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
    id: 'backup_profiles.id', orgId: 'backup_profiles.org_id', partnerId: 'backup_profiles.partner_id',
    name: 'backup_profiles.name', description: 'backup_profiles.description', selections: 'backup_profiles.selections',
    isActive: 'backup_profiles.is_active', createdBy: 'backup_profiles.created_by', updatedAt: 'backup_profiles.updated_at',
  },
  configPolicyBackupSettings: { featureLinkId: 'config_policy_backup_settings.feature_link_id', backupProfileId: 'config_policy_backup_settings.backup_profile_id' },
  configPolicyFeatureLinks: { id: 'config_policy_feature_links.id', configPolicyId: 'config_policy_feature_links.config_policy_id' },
  configurationPolicies: { id: 'configuration_policies.id', name: 'configuration_policies.name' },
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

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

import { authMiddleware } from '../../middleware/auth';
import { profilesRoutes } from './profiles';

const VALID_SELECTIONS = { file: { enabled: true, paths: ['C:\\Users'] } };

const ORG_PROFILE = { id: PROFILE_ID, orgId: ORG_ID, partnerId: null, name: 'Workstation', selections: VALID_SELECTIONS, isActive: true };

function orgAuth(allowedSiteIds: string[] | undefined): AuthState {
  return {
    user: { id: 'user-123', email: 'admin@customer.example', name: 'Org Admin' },
    scope: 'organization',
    partnerId: null,
    partnerOrgAccess: null,
    orgId: ORG_ID,
    allowedSiteIds,
    token: { sub: 'user-123' },
    orgCondition: () => 'ORG_COND',
  };
}

describe('backup profiles routes — site-ceiling gate', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    selectMock.mockReset();
    insertMock.mockReset();
    updateMock.mockReset();
    deleteMock.mockReset();
    authState = orgAuth(undefined);
    app = new Hono();
    app.use('*', authMiddleware as any);
    app.route('/backup', profilesRoutes);
  });

  it.each([
    ['restricted to one site', ['s1']],
    ['restricted to zero sites', []],
  ])('%s: POST /profiles denied 403, no insert', async (_label, allowedSiteIds) => {
    authState = orgAuth(allowedSiteIds);
    const res = await app.request('/backup/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Workstation', selections: VALID_SELECTIONS }),
    });
    expect(res.status).toBe(403);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('restricted caller: PATCH /profiles/:id denied 403, no service call', async () => {
    authState = orgAuth(['s1']);
    const res = await app.request(`/backup/profiles/${PROFILE_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' }),
    });
    expect(res.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('restricted caller: DELETE /profiles/:id denied 403, no service call', async () => {
    authState = orgAuth(['s1']);
    const res = await app.request(`/backup/profiles/${PROFILE_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(selectMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('unrestricted caller (allowedSiteIds undefined) is unaffected: POST proceeds to insert', async () => {
    authState = orgAuth(undefined);
    insertMock.mockReturnValue(chainMock([ORG_PROFILE]));
    const res = await app.request('/backup/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Workstation', selections: VALID_SELECTIONS }),
    });
    expect(res.status).toBe(201);
    expect(insertMock).toHaveBeenCalledTimes(1);
  });
});
