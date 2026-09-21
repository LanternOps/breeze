import { describe, expect, it, vi, beforeEach } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('@/stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const runAction = vi.fn(async (opts: { request: () => Promise<Response> }) => {
  const res = await opts.request();
  return res.json();
});
vi.mock('@/lib/runAction', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/runAction')>()),
  runAction: (opts: { request: () => Promise<Response> }) => runAction(opts),
}));

import { fetchScriptProposal, requestScriptProposalChanges, promoteScriptProposal } from './scriptProposals';

beforeEach(() => vi.clearAllMocks());

describe('scriptProposals api', () => {
  it('GETs the detail endpoint', async () => {
    fetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ proposal: { id: 'p1' } }) });
    await fetchScriptProposal('p1');
    expect(fetchWithAuth).toHaveBeenCalledWith('/ai/script-proposals/p1', expect.anything());
  });

  it('throws on a non-ok read rather than returning a half DTO', async () => {
    fetchWithAuth.mockResolvedValue({ ok: false, status: 403, json: async () => ({ error: 'forbidden' }) });
    await expect(fetchScriptProposal('p1')).rejects.toThrow();
  });

  it('routes request-changes through runAction', async () => {
    fetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ status: 'changes_requested' }) });
    await requestScriptProposalChanges('p1', 'narrow it');
    expect(runAction).toHaveBeenCalled();
    const [[opts]] = runAction.mock.calls as unknown as [[{ request: () => Promise<Response> }]];
    await opts.request();
    expect(fetchWithAuth).toHaveBeenCalledWith(
      '/ai/script-proposals/p1/request-changes',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ note: 'narrow it' }) }),
    );
  });

  it('routes promote through runAction with the owner scope', async () => {
    fetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ scriptId: 's1', versionId: 'v1' }) });
    await promoteScriptProposal('p1', { name: 'Restart spooler', ownerScope: 'partner' });
    const [[opts]] = runAction.mock.calls as unknown as [[{ request: () => Promise<Response> }]];
    await opts.request();
    expect(fetchWithAuth).toHaveBeenCalledWith(
      '/ai/script-proposals/p1/promote',
      expect.objectContaining({ body: JSON.stringify({ name: 'Restart spooler', ownerScope: 'partner' }) }),
    );
  });
});
