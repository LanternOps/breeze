import { describe, expect, it, vi } from 'vitest';

const { checkGuardrailsMock, loadContextMock } = vi.hoisted(() => ({
  checkGuardrailsMock: vi.fn(() => ({ tier: 3, allowed: true, requiresApproval: true, approvalScope: 'supervised' })),
  loadContextMock: vi.fn(async () => ({ proposal: { riskTier: 'medium', strictHits: [] } })),
}));

vi.mock('../aiGuardrails', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../aiGuardrails')>()),
  checkGuardrails: checkGuardrailsMock,
}));
vi.mock('../scriptProposals', () => ({ loadProposalGuardrailContext: loadContextMock }));

import { resolveGuardrailForIntent } from './intentService';

describe('createActionIntent guardrail resolution', () => {
  it('loads the proposal context before checking guardrails for a proposal-backed run_script', async () => {
    const { check, context } = await resolveGuardrailForIntent('run_script', { proposalId: 'p1' }, 'org-1');
    expect(loadContextMock).toHaveBeenCalledWith({ proposalId: 'p1' }, 'org-1');
    expect(checkGuardrailsMock).toHaveBeenCalledWith(
      'run_script', { proposalId: 'p1' }, { proposal: { riskTier: 'medium', strictHits: [] } });
    expect(check.tier).toBe(3);
    expect(context).toEqual({ proposal: { riskTier: 'medium', strictHits: [] } });
  });

  it('does not touch the DB for any other tool', async () => {
    loadContextMock.mockClear();
    await resolveGuardrailForIntent('manage_alerts', { action: 'list' }, 'org-1');
    expect(loadContextMock).not.toHaveBeenCalled();
    expect(checkGuardrailsMock).toHaveBeenLastCalledWith('manage_alerts', { action: 'list' }, undefined);
  });

  it('uses a caller-supplied guardrailContext (the W04 contract) instead of loading one', async () => {
    loadContextMock.mockClear();
    const supplied = { proposal: { riskTier: 'low' as const, strictHits: [] } };
    await resolveGuardrailForIntent('run_script', { proposalId: 'p1' }, 'org-1', supplied);
    expect(loadContextMock).not.toHaveBeenCalled();
    expect(checkGuardrailsMock).toHaveBeenLastCalledWith('run_script', { proposalId: 'p1' }, supplied);
  });
});
