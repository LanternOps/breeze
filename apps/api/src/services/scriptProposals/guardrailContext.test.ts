import { describe, expect, it, vi } from 'vitest';

let stored: Record<string, unknown> | null = null;
vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => (stored ? [stored] : []) }) }) }) },
  withSystemDbAccessContext: <T,>(fn: () => Promise<T>) => fn(),
  runOutsideDbContext: <T,>(fn: () => T) => fn(),
}));
import { loadProposalGuardrailContext } from './guardrailContext';

describe('loadProposalGuardrailContext', () => {
  it('returns undefined when the input names no proposal — every other tool is unaffected', async () => {
    await expect(loadProposalGuardrailContext({ scriptId: 's1' }, 'org-1')).resolves.toBeUndefined();
  });

  it('returns the persisted risk tier and strict hits for a same-org proposal', async () => {
    stored = { id: 'p1', orgId: 'org-1', riskTier: 'medium', strictHits: ['PowerShell HKLM modification'] };
    await expect(loadProposalGuardrailContext({ proposalId: 'p1' }, 'org-1')).resolves.toEqual({
      proposal: { riskTier: 'medium', strictHits: ['PowerShell HKLM modification'] },
    });
  });

  it('returns undefined for a cross-org proposal so the guardrail denies rather than borrows a tier', async () => {
    stored = { id: 'p1', orgId: 'org-2', riskTier: 'low', strictHits: [] };
    await expect(loadProposalGuardrailContext({ proposalId: 'p1' }, 'org-1')).resolves.toBeUndefined();
  });

  it('returns undefined when no review has set a risk tier yet', async () => {
    stored = { id: 'p1', orgId: 'org-1', riskTier: null, strictHits: [] };
    await expect(loadProposalGuardrailContext({ proposalId: 'p1' }, 'org-1')).resolves.toBeUndefined();
  });
});
