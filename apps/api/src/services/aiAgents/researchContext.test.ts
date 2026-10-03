// apps/api/src/services/aiAgents/researchContext.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as unknown[][], sig: vi.fn(), lookup: vi.fn(), scripts: vi.fn(), playbooks: vi.fn(),
}));
vi.mock('../../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit', 'orderBy']) chain[m] = vi.fn(() => chain);
  (chain as { then: unknown }).then = (r: (v: unknown) => unknown) => Promise.resolve(h.rows.shift() ?? []).then(r);
  return { db: chain };
});
vi.mock('../fixMemory/signatureLoader', () => ({
  signatureForSource: h.sig,
  sourceRefFor: (r: { sourceType: string; sourceId: string }) => ({ kind: r.sourceType, alertId: r.sourceId }),
}));
vi.mock('../fixMemory/lookup', () => ({ lookupFixes: h.lookup }));
vi.mock('../fixMemory/catalog', () => ({
  listCatalogScripts: h.scripts,
  listCatalogPlaybooks: h.playbooks,
  scriptVisibilityCondition: vi.fn(() => ({})),
}));

import { loadResearchContext, ResearchContextUnavailableError } from './researchContext';

const input = { orgId: 'org-1', partnerId: 'p-1', deviceId: 'd-1', triggerRef: { depth: 'deep', sourceType: 'alert', sourceId: 'a-1' } };

describe('loadResearchContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.rows.length = 0;
    h.sig.mockResolvedValue({ signature: { version: 1, key: 'k', broadKey: 'b', broad: false, facets: { family: 'alert', condition: 'rule:service_stopped', osFamily: 'windows', discriminator: { kind: 'service', value: 'spooler' } } }, deviceId: 'd-1', alertId: 'a-1', anomalyEpisodeId: null });
    h.lookup.mockResolvedValue({ proven: [{ memoryId: 'm' }], similar: [] });
    h.scripts.mockResolvedValue([{ id: 's-win', name: 'Restart spooler', description: 'x', osTypes: ['windows'] }]);
    h.playbooks.mockResolvedValue([{ id: 'pb-1', name: 'Service Restart', description: null }]);
  });

  it('assembles depth, source, device, memory, catalog and refs from server data only', async () => {
    h.rows.push(
      [{ id: 'd-1', hostname: 'WS-01', osType: 'windows' }], // device
      [{ title: 'Spooler stopped', severity: 'high', message: 'Print Spooler is not running' }], // alert
      [{ id: 's-win' }, { id: 's-partner' }], // visible + OS ids
      [{ id: 's-win' }, { id: 's-partner' }, { id: 's-linux' }], // visible any-OS ids
    );
    const ctx = await loadResearchContext(input);
    expect(ctx.depth).toBe('deep');
    expect(ctx.device).toEqual({ id: 'd-1', hostname: 'WS-01', osType: 'windows' });
    expect(ctx.signature).toEqual({ family: 'alert', condition: 'rule:service_stopped', discriminatorKind: 'service', broad: false });
    expect([...ctx.refs.scriptIds]).toEqual(['s-win', 's-partner']);
    expect([...ctx.refs.scriptIdsAnyOs]).toContain('s-linux');
    expect([...ctx.refs.playbookIds]).toEqual(['pb-1']);
    expect(ctx.catalog.cleanupActionIds.every((id) => id.startsWith('win_'))).toBe(true);
    expect(h.scripts).toHaveBeenCalledWith({ orgId: 'org-1', partnerId: 'p-1', deviceOs: 'windows' }, 60);
  });

  it('research still runs without a computable signature (no memory, spec "Error handling")', async () => {
    h.sig.mockResolvedValueOnce(null);
    h.rows.push([{ id: 'd-1', hostname: 'WS-01', osType: 'linux' }], [{ title: 't', severity: 'low', message: null }], [], []);
    const ctx = await loadResearchContext(input);
    expect(ctx.signature).toBeNull();
    expect(ctx.memory).toBeNull();
    expect(h.lookup).not.toHaveBeenCalled();
  });

  it('a missing device or unknown OS is a typed, non-retryable context error', async () => {
    h.rows.push([]);
    await expect(loadResearchContext(input)).rejects.toBeInstanceOf(ResearchContextUnavailableError);
    h.rows.push([{ id: 'd-1', hostname: 'X', osType: 'solaris' }]);
    await expect(loadResearchContext(input)).rejects.toMatchObject({ code: 'research_device_unavailable' });
  });
});
