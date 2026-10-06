// apps/api/src/services/fixMemory/research.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as unknown[][],
  flag: vi.fn(async () => true), partner: vi.fn(async (): Promise<string | null> => 'p-1'), ensure: vi.fn(async () => ({ agentId: 'ag', created: false })),
  budget: vi.fn(async (): Promise<unknown> => null), create: vi.fn(),
  // A1: `ambient` models a DB context held by the CALLER (must throw); `depth`
  // counts runReads calls in flight, so each mock can record where it ran.
  ambient: false, depth: 0, seen: [] as Array<{ what: string; depth: number }>,
}));
vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit', 'orderBy', 'innerJoin']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (r: (v: unknown) => unknown) => {
    h.seen.push({ what: 'db', depth: h.depth });
    return Promise.resolve(h.rows.shift() ?? []).then(r);
  };
  return { db: chain, hasDbAccessContext: () => h.ambient };
});
vi.mock('../mlFeatureFlags', () => ({ shouldProduceMlOutput: h.flag }));
vi.mock('./catalog', () => ({ resolveOrgPartnerId: h.partner }));
vi.mock('../aiAgents/researchProvisioning', () => {
  class ResearchBaselineConflictError extends Error { readonly code = 'research_baseline_not_system_provisioned' as const; }
  return { ensureResearchAgent: h.ensure, ResearchBaselineConflictError };
});
vi.mock('../aiCostTracker', () => ({ checkBudgetDetailed: h.budget }));
vi.mock('../aiAgents/runService', () => ({ createAndEnqueueAgentRun: h.create }));

import { requestResearch, researchDedupeBase, type ResearchReadRunner } from './research';

const runReads = vi.fn(async <T,>(fn: () => Promise<T>): Promise<T> => {
  h.depth += 1;
  try { return await fn(); } finally { h.depth -= 1; }
});
const req = (over = {}) => ({ orgId: 'org-1', sourceType: 'alert' as const, sourceId: 'a-1', depth: 'quick' as const, trigger: 'manual' as const, actorUserId: 'u-1', runReads: runReads as unknown as ResearchReadRunner, ...over });
const alertDevice = [{ deviceId: 'd-1' }];

describe('requestResearch (Review Focus 3)', () => {
  beforeEach(() => {
    h.rows.length = 0;
    h.ambient = false;
    h.depth = 0;
    h.seen.length = 0;
    vi.clearAllMocks();
    h.flag.mockResolvedValue(true);
    h.budget.mockResolvedValue(null);
    h.create.mockResolvedValue({ created: true, run: { id: 'run-1', status: 'queued' } });
  });

  it('starts a quick run with the research kind/profile, device, server-written trigger ref', async () => {
    h.rows.push(alertDevice, []); // source device, existing runs
    await expect(requestResearch(req())).resolves.toEqual({ status: 'started', runId: 'run-1', depth: 'quick' });
    expect(h.ensure).toHaveBeenCalledWith('p-1');
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'org-1', kind: 'research', profile: 'remediation_research', triggerKind: 'manual', deviceId: 'd-1', alertId: 'a-1',
      dedupeKey: researchDedupeBase('alert', 'a-1', 'quick'),
      triggerRef: { depth: 'quick', sourceType: 'alert', sourceId: 'a-1', requestedByUserId: 'u-1' },
    }), expect.any(Object));
  });

  it('dedupe per (source, depth): a running or completed run is returned, not re-run', async () => {
    h.rows.push(alertDevice, [{ id: 'run-0', status: 'running' }]);
    await expect(requestResearch(req())).resolves.toEqual({ status: 'already_running', runId: 'run-0', depth: 'quick' });
    h.rows.push(alertDevice, [{ id: 'run-0', status: 'completed' }]);
    await expect(requestResearch(req())).resolves.toEqual({ status: 'already_done', runId: 'run-0', depth: 'quick' });
    expect(h.create).not.toHaveBeenCalled();
  });

  it('a failed run can be retried once per click (manual only)', async () => {
    h.rows.push(alertDevice, [{ id: 'run-0', status: 'failed' }], [{ value: 1 }]);
    await requestResearch(req());
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: `${researchDedupeBase('alert', 'a-1', 'quick')}:retry-1` }), expect.any(Object));
    h.create.mockClear();
    h.rows.push(alertDevice, [{ id: 'run-0', status: 'failed' }]);
    await expect(requestResearch(req({ trigger: 'auto', actorUserId: null }))).resolves.toMatchObject({ status: 'already_done' });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("auto cap per org per hour: admission's research_auto_cap skip surfaces as auto_cap", async () => {
    h.rows.push(alertDevice, []);
    h.create.mockResolvedValueOnce({ created: false, skipped: 'research_auto_cap' });
    await expect(requestResearch(req({ trigger: 'auto', actorUserId: null }))).resolves.toMatchObject({ status: 'denied', code: 'auto_cap' });
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ triggerKind: 'alert' }), expect.any(Object));
  });

  it('provisions the research agent BEFORE admission, and resolves no policy itself (Codex finding 5)', async () => {
    h.rows.push(alertDevice, []);
    await requestResearch(req({ trigger: 'auto', actorUserId: null }));
    expect(h.ensure.mock.invocationCallOrder[0]!).toBeLessThan(h.create.mock.invocationCallOrder[0]!);
  });

  it('credits exhausted: admission skips org_budget_exceeded, the denial detail uses the funding ADMISSION resolved (pinned offering), no run', async () => {
    h.budget.mockResolvedValueOnce({ reason: 'credits_exhausted', message: 'You are out of AI credits.', permanent: false });
    h.rows.push(alertDevice, []);
    // Admission resolves the agent's pinned offering (partner key) and reports it through the callback.
    h.create.mockImplementationOnce(async (_input: unknown, options?: { onFundingResolved?: (f: string) => void }) => {
      options?.onFundingResolved?.('partner_key');
      return { created: false, skipped: 'org_budget_exceeded' };
    });
    await expect(requestResearch(req())).resolves.toEqual({ status: 'denied', code: 'credits_exhausted', message: 'You are out of AI credits.' });
    expect(h.budget).toHaveBeenCalledWith('org-1', 'partner_key');
  });

  it('a budget skip with no extra detail falls back to the admission skip code', async () => {
    h.rows.push(alertDevice, []);
    h.create.mockImplementationOnce(async (_input: unknown, options?: { onFundingResolved?: (f: string) => void }) => {
      options?.onFundingResolved?.('platform');
      return { created: false, skipped: 'org_budget_exceeded' };
    });
    await expect(requestResearch(req())).resolves.toMatchObject({ status: 'denied', code: 'org_budget_exceeded' });
    expect(h.budget).toHaveBeenCalledWith('org-1', 'platform');
  });

  it('a duplicate admission re-read maps the existing run status (completed -> already_done)', async () => {
    h.rows.push(alertDevice, [], [{ id: 'run-9', status: 'completed' }]);
    h.create.mockResolvedValueOnce({ created: false, skipped: 'duplicate' });
    await expect(requestResearch(req())).resolves.toEqual({ status: 'already_done', runId: 'run-9', depth: 'quick' });
    h.rows.push(alertDevice, [], [{ id: 'run-9', status: 'queued' }]);
    h.create.mockResolvedValueOnce({ created: false, skipped: 'duplicate' });
    await expect(requestResearch(req())).resolves.toEqual({ status: 'already_running', runId: 'run-9', depth: 'quick' });
  });

  it('flag off, missing source, and admission skips are explicit denials', async () => {
    h.flag.mockResolvedValueOnce(false);
    await expect(requestResearch(req())).resolves.toMatchObject({ status: 'denied', code: 'flag_off' });
    h.rows.push([]);
    await expect(requestResearch(req())).resolves.toMatchObject({ status: 'denied', code: 'source_not_found' });
    h.rows.push(alertDevice, []);
    h.create.mockResolvedValueOnce({ created: false, skipped: 'kill_switch_off' });
    await expect(requestResearch(req())).resolves.toMatchObject({ status: 'denied', code: 'kill_switch_off' });
  });

  it('a squatted (non-system) partner baseline is an explicit denial with its code, not a throw, and no run', async () => {
    const { ResearchBaselineConflictError } = await import('../aiAgents/researchProvisioning');
    h.rows.push(alertDevice, []);
    h.ensure.mockRejectedValueOnce(new ResearchBaselineConflictError('conflict'));
    await expect(requestResearch(req())).resolves.toMatchObject({ status: 'denied', code: 'research_baseline_not_system_provisioned' });
    expect(h.create).not.toHaveBeenCalled();
  });

  it('no partner for the org is source_not_found and provisions nothing', async () => {
    h.rows.push(alertDevice, []);
    h.partner.mockResolvedValueOnce(null);
    await expect(requestResearch(req())).resolves.toMatchObject({ status: 'denied', code: 'source_not_found' });
    expect(h.ensure).not.toHaveBeenCalled();
  });

  describe('A1: context-sequential (no request transaction is ever held across system work)', () => {
    it('refuses to run when the caller holds a DB context (programming error, nothing read or started)', async () => {
      h.ambient = true;
      await expect(requestResearch(req())).rejects.toThrow(/no DB context/);
      expect(runReads).not.toHaveBeenCalled();
      expect(h.ensure).not.toHaveBeenCalled();
      expect(h.create).not.toHaveBeenCalled();
    });

    it('runs every read (flag, source, dedupe, partner) inside ONE runReads call; provisioning + admission run after it returns', async () => {
      h.flag.mockImplementationOnce(async () => { h.seen.push({ what: 'flag', depth: h.depth }); return true; });
      h.partner.mockImplementationOnce(async () => { h.seen.push({ what: 'partner', depth: h.depth }); return 'p-1'; });
      h.ensure.mockImplementationOnce(async () => { h.seen.push({ what: 'ensure', depth: h.depth }); return { agentId: 'ag', created: false }; });
      h.create.mockImplementationOnce(async () => { h.seen.push({ what: 'admit', depth: h.depth }); return { created: true, run: { id: 'run-1', status: 'queued' } }; });
      h.rows.push(alertDevice, []);
      await expect(requestResearch(req())).resolves.toMatchObject({ status: 'started' });
      expect(runReads).toHaveBeenCalledTimes(1);
      expect(h.seen).toEqual([
        { what: 'flag', depth: 1 }, { what: 'db', depth: 1 }, { what: 'db', depth: 1 }, { what: 'partner', depth: 1 },
        { what: 'ensure', depth: 0 }, { what: 'admit', depth: 0 },
      ]);
    });

    it('admission is called with NO deferEnqueue: with no ambient context its own system tx commits before the enqueue', async () => {
      h.rows.push(alertDevice, []);
      await requestResearch(req());
      const options = h.create.mock.calls[0]![1] as Record<string, unknown>;
      expect(options.deferEnqueue).toBeUndefined();
    });

    it('the duplicate re-read also goes through runReads (a second, separate call)', async () => {
      h.rows.push(alertDevice, [], [{ id: 'run-9', status: 'queued' }]);
      h.create.mockResolvedValueOnce({ created: false, skipped: 'duplicate' });
      await expect(requestResearch(req())).resolves.toMatchObject({ status: 'already_running', runId: 'run-9' });
      expect(runReads).toHaveBeenCalledTimes(2);
      expect(h.seen.filter((e) => e.what === 'db').every((e) => e.depth === 1)).toBe(true);
    });

    it('a denial found by the reads returns without provisioning or admitting', async () => {
      h.rows.push(alertDevice, [{ id: 'run-0', status: 'running' }]);
      await expect(requestResearch(req())).resolves.toMatchObject({ status: 'already_running' });
      expect(h.ensure).not.toHaveBeenCalled();
      expect(h.partner).not.toHaveBeenCalled();
    });
  });
});
