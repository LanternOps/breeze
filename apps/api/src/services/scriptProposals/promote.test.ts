import { describe, expect, it, vi, beforeEach } from 'vitest';

const insertScriptRow = vi.fn();
const transitionProposal = vi.fn();
vi.mock('../scriptWrite', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../scriptWrite')>()),
  insertScriptRow: (...a: unknown[]) => insertScriptRow(...a),
}));
vi.mock('./proposals', () => ({ transitionProposal: (...a: unknown[]) => transitionProposal(...a) }));
const TX = { __tx: true };
vi.mock('../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db')>()),
  db: { transaction: (fn: (tx: unknown) => unknown) => fn(TX) },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

import { promoteProposalToLibrary } from './promote';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const APPROVER = '33333333-3333-4333-8333-333333333333';
const baseProposal = {
  id: '44444444-4444-4444-8444-444444444444', orgId: ORG, status: 'verified',
  content: 'Restart-Service spooler', contentDigest: 'a'.repeat(64), language: 'powershell',
  timeoutSeconds: 300, runAs: 'system', goal: 'Restart the spooler',
  acknowledgedPatterns: ['PowerShell HKLM write'], decidedBy: APPROVER, decidedAt: new Date('2026-09-11T10:00:00Z'),
};
const review = { id: 'r1', riskTier: 'medium', summary: 'Targets one service', createdAt: new Date('2026-09-11T09:00:00Z') };
const auth = (scope: 'organization' | 'partner') => ({
  user: { id: USER }, scope, orgId: scope === 'organization' ? ORG : null, partnerId: 'p1',
  accessibleOrgIds: [ORG], partnerOrgAccess: 'all', token: { mfa: true },
  canAccessOrg: () => true,
}) as never;

beforeEach(() => {
  vi.clearAllMocks();
  insertScriptRow.mockResolvedValue({ id: 'script-1', version: 1, headVersionId: 'ver-1' });
  transitionProposal.mockResolvedValue(true);
});

describe('promoteProposalToLibrary', () => {
  it('refuses a proposal that is not verified (D5/D12)', async () => {
    const r = await promoteProposalToLibrary({
      auth: auth('organization'), proposal: { ...baseProposal, status: 'executed' } as never, review,
      input: { name: 'Restart spooler', ownerScope: 'organization' },
    });
    expect(r).toMatchObject({ ok: false, status: 409, error: 'proposal_not_verified' });
    expect(insertScriptRow).not.toHaveBeenCalled();
  });

  it('carries the acknowledged STRICT set and the approver onto the script row, inside the caller tx', async () => {
    await promoteProposalToLibrary({
      auth: auth('organization'), proposal: baseProposal as never, review,
      input: { name: 'Restart spooler', description: 'From proposal', ownerScope: 'organization' },
    });
    expect(insertScriptRow).toHaveBeenCalledWith(
      expect.anything(), { orgId: ORG, partnerId: 'p1' },
      expect.objectContaining({
        name: 'Restart spooler',
        description: 'From proposal',
        content: baseProposal.content,
        language: 'powershell',
        runAs: 'system',
        timeoutSeconds: 300,
        acknowledgedSecurityPatterns: ['PowerShell HKLM write'],
      }),
      expect.objectContaining({
        tx: TX,
        securityAcknowledgedBy: APPROVER,
        provenance: expect.objectContaining({
          origin: 'ai_proposal', proposalId: baseProposal.id, reviewId: 'r1', reviewedAt: review.createdAt,
          approvedBy: APPROVER, approvedAt: baseProposal.decidedAt, approvalMethod: expect.any(String), createdBy: USER,
        }),
      }),
    );
  });

  it('CASes verified → promoted BEFORE inserting, then records the new ids', async () => {
    const order: string[] = [];
    transitionProposal.mockImplementation(async (_tx: unknown, _id: string, _from: string[], to: string) => { order.push(`transition:${to}`); return true; });
    insertScriptRow.mockImplementation(async () => { order.push('insert'); return { id: 'script-1', version: 1, headVersionId: 'ver-1' }; });
    const r = await promoteProposalToLibrary({
      auth: auth('organization'), proposal: baseProposal as never, review,
      input: { name: 'Restart spooler', ownerScope: 'organization' },
    });
    expect(r).toEqual({ ok: true, scriptId: 'script-1', versionId: 'ver-1' });
    expect(order[0]).toBe('transition:promoted');
    expect(order).toContain('insert');
    expect(transitionProposal).toHaveBeenCalledWith(TX, baseProposal.id, ['verified'], 'promoted', expect.anything());
    expect(transitionProposal).toHaveBeenLastCalledWith(
      TX, baseProposal.id, ['promoted'], 'promoted',
      expect.objectContaining({ promotedScriptId: 'script-1', promotedVersionId: 'ver-1' }),
    );
  });

  it('returns 409 and inserts nothing when the CAS loses (already promoted)', async () => {
    transitionProposal.mockResolvedValue(false);
    const r = await promoteProposalToLibrary({
      auth: auth('organization'), proposal: baseProposal as never, review,
      input: { name: 'Restart spooler', ownerScope: 'organization' },
    });
    expect(r).toMatchObject({ ok: false, status: 409, error: 'proposal_not_verified' });
    expect(insertScriptRow).not.toHaveBeenCalled();
  });

  it('surfaces the partner-wide capability denial from resolveScriptCreateScope', async () => {
    const r = await promoteProposalToLibrary({
      auth: { ...(auth('partner') as never as Record<string, unknown>), partnerOrgAccess: 'selected' } as never,
      proposal: baseProposal as never, review,
      input: { name: 'Restart spooler', ownerScope: 'partner' },
    });
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(insertScriptRow).not.toHaveBeenCalled();
  });

  it('pins an org-owned promotion to the PROPOSAL org for a partner caller', async () => {
    await promoteProposalToLibrary({
      auth: auth('partner'), proposal: baseProposal as never, review,
      input: { name: 'Restart spooler', ownerScope: 'organization' },
    });
    expect(insertScriptRow).toHaveBeenCalledWith(
      expect.anything(), { orgId: ORG, partnerId: 'p1' }, expect.anything(), expect.anything(),
    );
  });
});
