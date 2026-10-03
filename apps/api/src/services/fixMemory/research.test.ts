// apps/api/src/services/fixMemory/research.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as unknown[][],
  flag: vi.fn(async () => true), partner: vi.fn(async (): Promise<string | null> => 'p-1'), ensure: vi.fn(async () => ({ agentId: 'ag', created: false })),
  budget: vi.fn(async (): Promise<unknown> => null), resolve: vi.fn(async (): Promise<Record<string, unknown>> => ({ ok: true, funding: 'platform' })), create: vi.fn(),
}));
vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit', 'orderBy', 'innerJoin']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (r: (v: unknown) => unknown) => Promise.resolve(h.rows.shift() ?? []).then(r);
  return { db: chain };
});
vi.mock('../mlFeatureFlags', () => ({ shouldProduceMlOutput: h.flag }));
vi.mock('./catalog', () => ({ resolveOrgPartnerId: h.partner }));
vi.mock('../aiAgents/researchProvisioning', () => {
  class ResearchBaselineConflictError extends Error { readonly code = 'research_baseline_not_system_provisioned' as const; }
  return { ensureResearchAgent: h.ensure, ResearchBaselineConflictError };
});
vi.mock('../aiCostTracker', () => ({ checkBudgetDetailed: h.budget }));
vi.mock('../aiModels/resolveModel', () => ({ resolveModel: h.resolve }));
vi.mock('../aiAgents/runService', () => ({ createAndEnqueueAgentRun: h.create }));

import { requestResearch, researchDedupeBase } from './research';

const req = (over = {}) => ({ orgId: 'org-1', sourceType: 'alert' as const, sourceId: 'a-1', depth: 'quick' as const, trigger: 'manual' as const, actorUserId: 'u-1', ...over });
const alertDevice = [{ deviceId: 'd-1' }];

describe('requestResearch (Review Focus 3)', () => {
  beforeEach(() => {
    h.rows.length = 0;
    vi.clearAllMocks();
    h.flag.mockResolvedValue(true);
    h.budget.mockResolvedValue(null);
    h.resolve.mockResolvedValue({ ok: true, funding: 'platform' });
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
    }));
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
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ dedupeKey: `${researchDedupeBase('alert', 'a-1', 'quick')}:retry-1` }));
    h.create.mockClear();
    h.rows.push(alertDevice, [{ id: 'run-0', status: 'failed' }]);
    await expect(requestResearch(req({ trigger: 'auto', actorUserId: null }))).resolves.toMatchObject({ status: 'already_done' });
    expect(h.create).not.toHaveBeenCalled();
  });

  it("auto cap per org per hour: admission's research_auto_cap skip surfaces as auto_cap", async () => {
    h.rows.push(alertDevice, []);
    h.create.mockResolvedValueOnce({ created: false, skipped: 'research_auto_cap' });
    await expect(requestResearch(req({ trigger: 'auto', actorUserId: null }))).resolves.toMatchObject({ status: 'denied', code: 'auto_cap' });
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ triggerKind: 'alert' }));
  });

  it('provisions the research agent BEFORE admission, and resolves no policy itself (Codex finding 5)', async () => {
    h.rows.push(alertDevice, []);
    await requestResearch(req({ trigger: 'auto', actorUserId: null }));
    expect(h.ensure.mock.invocationCallOrder[0]!).toBeLessThan(h.create.mock.invocationCallOrder[0]!);
  });

  it('credits exhausted surfaces the denial code, no run', async () => {
    h.budget.mockResolvedValueOnce({ reason: 'credits_exhausted', message: 'You are out of AI credits.', permanent: false });
    h.rows.push(alertDevice, []);
    await expect(requestResearch(req())).resolves.toEqual({ status: 'denied', code: 'credits_exhausted', message: 'You are out of AI credits.' });
    expect(h.create).not.toHaveBeenCalled();
  });

  it('credits are checked against the funding of the resolved ai_agents offering; an unresolvable model is model_unavailable, no run', async () => {
    h.resolve.mockResolvedValueOnce({ ok: true, funding: 'partner_key' });
    h.rows.push(alertDevice, []);
    await requestResearch(req());
    expect(h.budget).toHaveBeenCalledWith('org-1', 'partner_key');
    h.create.mockClear();
    h.resolve.mockResolvedValueOnce({ ok: false, reason: 'no_model', message: 'No AI model is available.' });
    h.rows.push(alertDevice, []);
    await expect(requestResearch(req())).resolves.toEqual({ status: 'denied', code: 'model_unavailable', message: 'No AI model is available.' });
    expect(h.create).not.toHaveBeenCalled();
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
});
