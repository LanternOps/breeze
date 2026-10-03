import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ values: vi.fn(), returning: [] as unknown[][] }));
vi.mock('../../db', () => ({
  db: { insert: vi.fn(() => ({ values: (v: unknown) => { h.values(v); return { onConflictDoNothing: () => ({ returning: async () => h.returning.shift() ?? [{ id: 'x' }] }) }; } })) },
}));

import { persistResearchSuggestions, suggestionValuesFor } from './researchPersist';

const research = {
  depth: 'quick', source: { sourceType: 'alert', sourceId: 'a-1', title: 't', severity: 'high', message: null },
  device: { id: 'd-1', hostname: 'WS', osType: 'windows' }, signature: null, memory: null,
  catalog: { scripts: [{ id: 's-1', name: 'Restart spooler', description: null }], playbooks: [], cleanupActionIds: [] },
  refs: { deviceOs: 'windows', scriptIds: new Set(['s-1']), scriptIdsAnyOs: new Set(['s-1']), playbookIds: new Set() },
} as never;
const base = { title: 'Fix it', reasoning: 'Because the service is stopped.', riskTier: 'medium' as const };
const input = (items: unknown[]) => ({ runId: 'run-1', orgId: 'org-1', research, outcome: { summary: 's', items, rejected: [], noSafeFix: items.length === 0 } as never });

describe('research persistence', () => {
  it('a catalog script becomes an ai_research suggestion with the run link, reasoning as rationale, no confidence', () => {
    expect(suggestionValuesFor(input([]), { kind: 'catalog', ref: { type: 'script', id: 's-1' }, ...base }, 0)).toMatchObject({
      orgId: 'org-1', sourceType: 'alert', sourceId: 'a-1', alertId: 'a-1', deviceId: 'd-1', targetDeviceIds: ['d-1'],
      targetType: 'script', scriptId: 's-1', origin: 'ai_research', agentRunId: 'run-1', researchOrdinal: 0,
      rationale: 'Because the service is stopped.', confidence: null, status: 'suggested',
      expectedAction: 'Run script "Restart spooler" through the existing script execution flow.',
    });
  });

  it.each([
    [{ kind: 'builtin_action', action: 'restart_service', params: { serviceName: 'Spooler' }, ...base }, { targetType: 'builtin_action', builtinAction: 'restart_service', parameters: { serviceName: 'Spooler' } }],
    [{ kind: 'manual_steps', steps: ['a', 'b'], ...base }, { targetType: 'manual_steps', parameters: { steps: ['a', 'b'] }, evidence: expect.objectContaining({ aiWritten: true }) }],
    [{ kind: 'draft_request', brief: 'Clear queue', language: 'powershell', ...base }, { targetType: 'script_draft', parameters: { brief: 'Clear queue', language: 'powershell' } }],
  ])('maps %o', (item, expected) => {
    expect(suggestionValuesFor(input([]), item as never, 1)).toMatchObject(expected);
  });

  it('inserts one row per accepted item, idempotently (conflicts are no-ops)', async () => {
    h.returning.push([{ id: 'r1' }], []);
    const out = await persistResearchSuggestions(input([
      { kind: 'catalog', ref: { type: 'script', id: 's-1' }, ...base },
      { kind: 'manual_steps', steps: ['a'], ...base },
    ]));
    expect(out).toEqual({ inserted: 1 });
    expect(h.values).toHaveBeenCalledTimes(2);
  });

  it('no safe fix → nothing inserted', async () => {
    h.values.mockClear();
    await expect(persistResearchSuggestions(input([]))).resolves.toEqual({ inserted: 0 });
    expect(h.values).not.toHaveBeenCalled();
  });
});
