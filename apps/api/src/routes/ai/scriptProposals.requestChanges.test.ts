import { describe, expect, it, vi, beforeEach } from 'vitest';

const loadScriptProposalDetail = vi.fn();
const transitionProposal = vi.fn();
const denyIntentForProposal = vi.fn();
const postProposalOutcomeToAuthor = vi.fn();
const loadProposalRow = vi.fn();
const loadProposalRequesterUserId = vi.fn();
const writeAuditEventAsync = vi.fn();

vi.mock('../../services/scriptProposals/detail', () => ({
  loadScriptProposalDetail: (...a: unknown[]) => loadScriptProposalDetail(...a),
}));
vi.mock('../../services/scriptProposals', () => ({
  transitionProposal: (...a: unknown[]) => transitionProposal(...a),
  denyIntentForProposal: (...a: unknown[]) => denyIntentForProposal(...a),
}));
vi.mock('../../services/scriptProposals/authorNotify', () => ({
  postProposalOutcomeToAuthor: (...a: unknown[]) => postProposalOutcomeToAuthor(...a),
}));
vi.mock('../../services/scriptProposals/queries', () => ({
  loadProposalRow: (...a: unknown[]) => loadProposalRow(...a),
  loadProposalRequesterUserId: (...a: unknown[]) => loadProposalRequesterUserId(...a),
  loadLatestReview: vi.fn(async () => null),
}));
vi.mock('../../services/scriptProposals/promote', () => ({ promoteProposalToLibrary: vi.fn() }));
vi.mock('../../services/auditEvents', () => ({
  writeAuditEventAsync: (...a: unknown[]) => writeAuditEventAsync(...a),
}));
const TX = { tx: true };
vi.mock('../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db')>()),
  db: { transaction: (fn: (tx: unknown) => unknown) => fn(TX) },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../../config/env', async (o) => ({ ...(await o<Record<string, unknown>>()), aiScriptAuthoringEnabled: () => true }));
vi.mock('../../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../middleware/auth')>();
  return {
    ...actual,
    authMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
      c.set('auth', {
        user: { id: '22222222-2222-4222-8222-222222222222' }, scope: 'organization',
        orgId: '11111111-1111-4111-8111-111111111111', partnerId: null,
        accessibleOrgIds: ['11111111-1111-4111-8111-111111111111'], token: { mfa: true },
      });
      await next();
    },
  };
});

import { aiScriptProposalRoutes } from './scriptProposals';

const ID = '44444444-4444-4444-8444-444444444444';
const ORG = '11111111-1111-4111-8111-111111111111';
const post = (body: unknown) =>
  aiScriptProposalRoutes.request(`/${ID}/request-changes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

const row = { id: ID, orgId: ORG, intentId: 'intent-1', authorKind: 'chat_session', sessionId: 's1', agentRunId: null };

beforeEach(() => {
  vi.clearAllMocks();
  transitionProposal.mockResolvedValue(true);
  denyIntentForProposal.mockResolvedValue(true);
  loadProposalRow.mockResolvedValue(row);
  loadProposalRequesterUserId.mockResolvedValue('99999999-9999-4999-8999-999999999999');
  loadScriptProposalDetail.mockResolvedValue({
    ok: true,
    dto: {
      proposal: { id: ID, status: 'reviewed', intentId: 'intent-1' },
      review: { findings: [{ severity: 'warning', text: 'Broad service match' }] },
      viewer: { canDecide: true },
    },
  });
});

describe('POST /:id/request-changes', () => {
  it('transitions, denies the intent and notifies the author', async () => {
    const res = await post({ note: 'Narrow the service filter.' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'changes_requested' });
    expect(transitionProposal).toHaveBeenCalledWith(
      TX, ID, ['reviewed', 'approved'], 'changes_requested',
      expect.objectContaining({ decidedBy: '22222222-2222-4222-8222-222222222222', decisionNote: 'Narrow the service filter.' }),
    );
    expect(denyIntentForProposal).toHaveBeenCalledWith(TX, row, 'changes_requested', '22222222-2222-4222-8222-222222222222');
    expect(postProposalOutcomeToAuthor).toHaveBeenCalledWith(
      expect.objectContaining({ id: ID, sessionId: 's1', requestedByUserId: '99999999-9999-4999-8999-999999999999' }),
      expect.objectContaining({
        kind: 'changes_requested', note: 'Narrow the service filter.',
        findings: [{ severity: 'warning', text: 'Broad service match' }],
      }),
    );
    expect(writeAuditEventAsync).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'script.proposal.decided', orgId: ORG, resourceId: ID, details: expect.objectContaining({ decision: 'changes_requested' }) }),
    );
  });

  it('400s an empty note', async () => {
    expect((await post({ note: '  ' })).status).toBe(400);
    expect(transitionProposal).not.toHaveBeenCalled();
  });

  it('403s a caller who cannot decide', async () => {
    loadScriptProposalDetail.mockResolvedValue({ ok: true, dto: { proposal: { id: ID }, viewer: { canDecide: false } } });
    expect((await post({ note: 'x' })).status).toBe(403);
    expect(transitionProposal).not.toHaveBeenCalled();
  });

  it('404s a proposal the caller cannot see', async () => {
    loadScriptProposalDetail.mockResolvedValue({ ok: false, reason: 'not_found' });
    expect((await post({ note: 'x' })).status).toBe(404);
  });

  it('409s when the proposal already left a requestable state', async () => {
    transitionProposal.mockResolvedValue(false);
    const res = await post({ note: 'x' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'proposal_not_requestable' });
    expect(denyIntentForProposal).not.toHaveBeenCalled();
    expect(postProposalOutcomeToAuthor).not.toHaveBeenCalled();
  });
});
