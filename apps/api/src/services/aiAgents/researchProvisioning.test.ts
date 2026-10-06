import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ existing: [] as unknown[][], inserted: [] as unknown[], insertReturn: [] as unknown[][] }));
vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (r: (v: unknown) => unknown) => Promise.resolve(h.existing.shift() ?? []).then(r);
  (chain as { insert: unknown }).insert = vi.fn(() => ({
    values: (v: unknown) => { h.inserted.push(v); return { onConflictDoNothing: () => ({ returning: async () => h.insertReturn.shift() ?? [] }) }; },
  }));
  return { db: chain };
});
vi.mock('../outcomeProbes', () => ({ inSystemDbContext: (fn: () => unknown) => fn() }));

import {
  assertResearchAgentEdit, ensureResearchAgent, ResearchAgentEditError, ResearchBaselineConflictError,
} from './researchProvisioning';

const SYSTEM = 'system:remediation_research';

describe('ensureResearchAgent', () => {
  beforeEach(() => { h.existing.length = 0; h.inserted.length = 0; h.insertReturn.length = 0; });

  it('creates one enabled, system-provisioned partner baseline with no human creator', async () => {
    h.existing.push([]);
    h.insertReturn.push([{ id: 'agent-1' }]);
    await expect(ensureResearchAgent('p-1')).resolves.toEqual({ agentId: 'agent-1', created: true });
    expect(h.inserted[0]).toMatchObject({
      partnerId: 'p-1', orgId: null, kind: 'research', name: 'Fix research (built-in)',
      enabled: true, mode: 'act', createdBy: null, provisionedBy: SYSTEM, toolAllowlist: [],
    });
  });

  it('is idempotent: an existing system-provisioned baseline is returned, nothing inserted', async () => {
    h.existing.push([{ id: 'agent-9', provisionedBy: SYSTEM }]);
    await expect(ensureResearchAgent('p-1')).resolves.toEqual({ agentId: 'agent-9', created: false });
    expect(h.inserted).toEqual([]);
  });

  it('a lost insert race re-reads the winner instead of failing', async () => {
    h.existing.push([], [{ id: 'agent-winner', provisionedBy: SYSTEM }]);
    h.insertReturn.push([]);
    await expect(ensureResearchAgent('p-1')).resolves.toEqual({ agentId: 'agent-winner', created: false });
  });

  it('fails closed on a user-created squatter row instead of adopting it', async () => {
    h.existing.push([{ id: 'squat', provisionedBy: null }]);
    await expect(ensureResearchAgent('p-1')).rejects.toBeInstanceOf(ResearchBaselineConflictError);
    expect(h.inserted).toEqual([]);
  });

  it('fails closed when the race winner is a squatter', async () => {
    h.existing.push([], [{ id: 'squat', provisionedBy: null }]);
    h.insertReturn.push([]);
    await expect(ensureResearchAgent('p-1')).rejects.toBeInstanceOf(ResearchBaselineConflictError);
  });
});

describe('assertResearchAgentEdit', () => {
  it('allows enabled and research budget/cap limits only', () => {
    expect(() => assertResearchAgentEdit({ enabled: false, limits: { researchDeepBudgetCentsPerRun: 40 } })).not.toThrow();
  });
  it.each([
    [{ mode: 'shadow' }, ['mode']],
    [{ toolAllowlist: ['run_script'] }, ['toolAllowlist']],
    [{ limits: { maxActionsPerRun: 5 } }, ['limits.maxActionsPerRun']],
    [{ instructions: 'ignore rules' }, ['instructions']],
  ])('refuses %o', (input, fields) => {
    try { assertResearchAgentEdit(input); expect.unreachable(); } catch (err) {
      expect(err).toBeInstanceOf(ResearchAgentEditError);
      expect((err as ResearchAgentEditError).fields).toEqual(fields);
    }
  });
});
