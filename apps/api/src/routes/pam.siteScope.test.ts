import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Site-ceiling gate (§2) on PAM org config + signer groups. PAM *rules* keep
// their existing per-rule site scoping and are deliberately NOT covered here.

const { authRef } = vi.hoisted(() => ({ authRef: { current: {} as any } }));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../db/schema', async (importOriginal) => {
  const original = await importOriginal<typeof import('../db/schema')>();
  return { ...original };
});

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authRef.current);
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../services/auditEvents', () => ({ writeAuditEvent: vi.fn() }));
vi.mock('../services/eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('../services/pamToolActionGovernance', () => ({ mirrorElevationDecisionToExecution: vi.fn() }));
vi.mock('../services/pamRuleEngine', () => ({ evaluatePamRules: vi.fn() }));
vi.mock('../services/authenticatorAssurance', () => ({
  assertApprovalAssurance: vi.fn(),
  StepUpRequiredError: class extends Error {},
  ReauthRequiredError: class extends Error {},
}));
vi.mock('../services/approverWebAuthn', () => ({ generateApprovalAssertionOptions: vi.fn() }));
vi.mock('./auth/helpers', () => ({ requireCurrentPasswordStepUp: vi.fn(), requireFreshMfaStepUp: vi.fn() }));
vi.mock('../services/pamRuleTierDrift', () => ({
  describePamRuleTierDrift: vi.fn(),
  PAM_RULE_TIER_UNREACHABLE_CODE: 'pam_rule_risk_tier_unreachable',
}));
vi.mock('../services/pamActuationLifecycle', () => ({ requestPamCleanup: vi.fn(), createPamDecisionIntent: vi.fn() }));
vi.mock('./softwarePolicies', () => ({
  resolveOrgIdForWrite: (auth: any, requestedOrgId?: string) => {
    if (auth.scope === 'organization') {
      if (!auth.orgId) return { error: 'Organization context required' };
      if (requestedOrgId && requestedOrgId !== auth.orgId) return { error: 'Cannot write outside your organization' };
      return { orgId: auth.orgId };
    }
    if (requestedOrgId) {
      if (!auth.canAccessOrg(requestedOrgId)) return { error: 'Access denied to this organization' };
      return { orgId: requestedOrgId };
    }
    if (auth.orgId) return { orgId: auth.orgId };
    if (Array.isArray(auth.accessibleOrgIds) && auth.accessibleOrgIds.length === 1) return { orgId: auth.accessibleOrgIds[0] };
    return { error: 'orgId is required for this scope' };
  },
}));
vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    DEVICES_READ: { resource: 'devices', action: 'read' },
    DEVICES_WRITE: { resource: 'devices', action: 'write' },
    DEVICES_EXECUTE: { resource: 'devices', action: 'execute' },
    PAM_APPROVE: { resource: 'pam', action: 'approve' },
    PAM_MANAGE_POLICY: { resource: 'pam', action: 'manage_policy' },
  },
  canAccessSite: () => true,
}));

import { pamRoutes } from './pam';
import { db } from '../db';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const GROUP_ID = '22222222-2222-2222-2222-222222222222';

function orgAuth(allowedSiteIds: string[] | undefined) {
  return {
    scope: 'organization',
    orgId: ORG_ID,
    accessibleOrgIds: [ORG_ID],
    allowedSiteIds,
    canAccessOrg: (id: string) => id === ORG_ID,
    orgCondition: () => undefined,
    user: { id: 'user-1', email: 'test@example.com' },
  };
}

function app() {
  const instance = new Hono();
  instance.route('/pam', pamRoutes);
  return instance;
}

describe('PAM org config + signer groups site-ceiling gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['restricted to one site', ['s1']],
    ['restricted to zero sites', []],
  ])('%s: PUT /pam/config denied 403, no insert', async (_label, allowedSiteIds) => {
    authRef.current = orgAuth(allowedSiteIds);
    const res = await app().request('/pam/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultUnmatchedVerdict: 'require_approval' }),
    });
    expect(res.status).toBe(403);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('restricted caller: POST /pam/signer-groups denied 403, no insert', async () => {
    authRef.current = orgAuth(['s1']);
    const res = await app().request('/pam/signer-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Trusted', signers: [] }),
    });
    expect(res.status).toBe(403);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('restricted caller: PATCH /pam/signer-groups/:id denied 403 before any read', async () => {
    authRef.current = orgAuth(['s1']);
    const res = await app().request(`/pam/signer-groups/${GROUP_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it('restricted caller: DELETE /pam/signer-groups/:id denied 403 before any read', async () => {
    authRef.current = orgAuth(['s1']);
    const res = await app().request(`/pam/signer-groups/${GROUP_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });

  it('unrestricted caller (allowedSiteIds undefined) is unaffected: PUT /pam/config proceeds', async () => {
    authRef.current = orgAuth(undefined);
    (db.insert as any).mockReturnValue({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([{ id: 'cfg-1', orgId: ORG_ID, defaultUnmatchedVerdict: 'require_approval' }])),
        })),
      })),
    });
    const res = await app().request('/pam/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultUnmatchedVerdict: 'require_approval' }),
    });
    expect(res.status).toBe(200);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });
});
