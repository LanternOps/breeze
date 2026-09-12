import { describe, expect, it, vi, beforeEach } from 'vitest';

const promoteProposalToLibrary = vi.fn();
const loadScriptProposalDetail = vi.fn();
const loadProposalRow = vi.fn();
const loadLatestReview = vi.fn();
const writeAuditEventAsync = vi.fn();
vi.mock('../../services/scriptProposals/promote', () => ({
  promoteProposalToLibrary: (...a: unknown[]) => promoteProposalToLibrary(...a),
}));
vi.mock('../../services/scriptProposals/detail', () => ({
  loadScriptProposalDetail: (...a: unknown[]) => loadScriptProposalDetail(...a),
}));
vi.mock('../../services/scriptProposals/queries', () => ({
  loadProposalRow: (...a: unknown[]) => loadProposalRow(...a),
  loadLatestReview: (...a: unknown[]) => loadLatestReview(...a),
  loadProposalRequesterUserId: vi.fn(async () => null),
}));
vi.mock('../../services/scriptProposals', () => ({ transitionProposal: vi.fn(), denyIntentForProposal: vi.fn() }));
vi.mock('../../services/scriptProposals/authorNotify', () => ({ postProposalOutcomeToAuthor: vi.fn() }));
vi.mock('../../services/auditEvents', () => ({
  writeAuditEventAsync: (...a: unknown[]) => writeAuditEventAsync(...a),
}));
vi.mock('../../config/env', async (o) => ({ ...(await o<Record<string, unknown>>()), aiScriptAuthoringEnabled: () => true }));

// requirePermission and requireMfa are left REAL so the permission/MFA matrix
// is genuinely exercised; only the permission lookup and the auth stub vary.
const perms = { grants: [] as Array<{ resource: string; action: string }> };
vi.mock('../../services/permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/permissions')>();
  return {
    ...actual,
    getUserPermissions: vi.fn(async () => ({
      scope: 'organization', orgId: '11111111-1111-4111-8111-111111111111', permissions: perms.grants,
    })),
  };
});
const session = { mfa: true };
vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('auth', {
        user: { id: '22222222-2222-4222-8222-222222222222' }, scope: 'organization',
        orgId: '11111111-1111-4111-8111-111111111111', partnerId: null,
        accessibleOrgIds: ['11111111-1111-4111-8111-111111111111'], token: { mfa: session.mfa },
      });
      await next();
    },
  };
});

import { aiScriptProposalRoutes } from './scriptProposals';
import { PERMISSIONS } from '../../services/permissions';

const ID = '44444444-4444-4444-8444-444444444444';
const ORG = '11111111-1111-4111-8111-111111111111';
const post = (body: unknown) =>
  aiScriptProposalRoutes.request(`/${ID}/promote`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  session.mfa = true;
  perms.grants = [{ resource: PERMISSIONS.SCRIPTS_WRITE.resource, action: PERMISSIONS.SCRIPTS_WRITE.action }];
  loadScriptProposalDetail.mockResolvedValue({ ok: true, dto: { proposal: { id: ID }, viewer: { canPromote: true } } });
  loadProposalRow.mockResolvedValue({ id: ID, orgId: ORG, status: 'verified' });
  loadLatestReview.mockResolvedValue({ id: 'r1' });
  promoteProposalToLibrary.mockResolvedValue({ ok: true, scriptId: 's1', versionId: 'v1' });
});

describe('POST /:id/promote', () => {
  it('201s with the new script and version ids and audits the promotion', async () => {
    const res = await post({ name: 'Restart spooler', ownerScope: 'organization' });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ scriptId: 's1', versionId: 'v1' });
    expect(promoteProposalToLibrary).toHaveBeenCalledWith(expect.objectContaining({
      proposal: expect.objectContaining({ id: ID }), review: { id: 'r1' },
      input: { name: 'Restart spooler', ownerScope: 'organization' },
    }));
    expect(writeAuditEventAsync).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'script.proposal.promoted', orgId: ORG, resourceId: ID }),
    );
  });

  it('409s when the proposal is not verified', async () => {
    promoteProposalToLibrary.mockResolvedValue({ ok: false, status: 409, error: 'proposal_not_verified' });
    const res = await post({ name: 'X', ownerScope: 'organization' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'proposal_not_verified' });
  });

  it('403s without MFA', async () => {
    session.mfa = false;
    const res = await post({ name: 'X', ownerScope: 'organization' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
    expect(promoteProposalToLibrary).not.toHaveBeenCalled();
  });

  it('403s without scripts:write', async () => {
    perms.grants = [];
    expect((await post({ name: 'X', ownerScope: 'organization' })).status).toBe(403);
    expect(promoteProposalToLibrary).not.toHaveBeenCalled();
  });

  it('400s an unknown ownerScope', async () => {
    expect((await post({ name: 'X', ownerScope: 'site' })).status).toBe(400);
    expect(promoteProposalToLibrary).not.toHaveBeenCalled();
  });

  it('403s a reader who cannot promote', async () => {
    loadScriptProposalDetail.mockResolvedValue({ ok: true, dto: { proposal: { id: ID }, viewer: { canPromote: false } } });
    expect((await post({ name: 'X', ownerScope: 'organization' })).status).toBe(403);
    expect(promoteProposalToLibrary).not.toHaveBeenCalled();
  });

  it('403s a caller who may not read the proposal even with scripts:write elsewhere', async () => {
    loadScriptProposalDetail.mockResolvedValue({ ok: false, reason: 'forbidden' });
    expect((await post({ name: 'X', ownerScope: 'organization' })).status).toBe(403);
    expect(promoteProposalToLibrary).not.toHaveBeenCalled();
  });
});
