import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  flag: vi.fn(async () => true), sig: vi.fn(), partner: vi.fn(async () => 'p-1'), lookup: vi.fn(),
  values: vi.fn(), onConflict: vi.fn(async () => undefined),
  systemCtx: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock('../../db', () => ({
  db: { insert: vi.fn(() => ({ values: (v: unknown) => { h.values(v); return { onConflictDoUpdate: h.onConflict }; } })) },
}));
vi.mock('../mlFeatureFlags', () => ({ shouldProduceMlOutput: h.flag }));
vi.mock('./signatureLoader', () => ({
  sourceRefFor: (r: { sourceType: string; sourceId: string }) => (r.sourceType === 'rca' ? null : { kind: r.sourceType, alertId: r.sourceId }),
  signatureForSource: h.sig,
}));
vi.mock('./catalog', () => ({ resolveOrgPartnerId: h.partner }));
vi.mock('./lookup', () => ({ lookupFixes: h.lookup }));
vi.mock('../outcomeProbes', () => ({ inSystemDbContext: h.systemCtx }));

import { attachProvenFixes, handleAlertTriggeredForFixMemory, memoryRationale } from './attach';

const proven = { memoryId: 'm-1', scope: 'all_clients', fixKind: 'partner_script', scriptId: 's-1', scriptName: 'Restart spooler', attempts: 8, verified: 7, successRate: 0.88, lastVerifiedAt: '2026-11-01T00:00:00.000Z' };
const signature = { version: 1, key: 'k', broadKey: 'b', broad: false, facets: { osFamily: 'windows' } };

describe('attachProvenFixes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.flag.mockResolvedValue(true);
    h.partner.mockResolvedValue('p-1');
    h.sig.mockResolvedValue({ signature, deviceId: 'd-1', alertId: 'a-1', anomalyEpisodeId: null });
    h.lookup.mockResolvedValue({ proven: [proven], similar: [] });
  });

  it('writes a memory-origin suggestion for each proven script fix and upgrades an untouched catalog row', async () => {
    await expect(attachProvenFixes({ sourceType: 'alert', sourceId: 'a-1', orgId: 'org-1' })).resolves.toBe(1);
    expect(h.values).toHaveBeenCalledWith(expect.objectContaining({
      origin: 'memory', targetType: 'script', scriptId: 's-1', deviceId: 'd-1', targetDeviceIds: ['d-1'],
      alertId: 'a-1', status: 'suggested', confidence: null,
      evidence: expect.objectContaining({ origin: 'memory', memoryId: 'm-1', attempts: 8, verifiedCount: 7 }),
    }));
    expect(h.onConflict).toHaveBeenCalledWith(expect.objectContaining({ set: expect.objectContaining({ origin: 'memory' }) }));
  });

  it('does nothing when the flag is off, the signature is broad, or the source has none', async () => {
    h.flag.mockResolvedValueOnce(false);
    expect(await attachProvenFixes({ sourceType: 'alert', sourceId: 'a-1', orgId: 'org-1' })).toBe(0);
    h.sig.mockResolvedValueOnce({ signature: { ...signature, broad: true }, deviceId: 'd-1', alertId: 'a-1', anomalyEpisodeId: null });
    expect(await attachProvenFixes({ sourceType: 'alert', sourceId: 'a-1', orgId: 'org-1' })).toBe(0);
    expect(await attachProvenFixes({ sourceType: 'rca', sourceId: 'x', orgId: 'org-1' })).toBe(0);
    expect(h.values).not.toHaveBeenCalled();
  });

  it('never writes private text into the rationale', () => {
    expect(memoryRationale({ verified: 7, attempts: 8, scope: 'all_clients' })).toBe('Proven fix: worked 7 of 8 times across your clients.');
    expect(memoryRationale({ verified: 3, attempts: 3, scope: 'this_client' })).toBe('Proven fix: worked 3 of 3 times for this client.');
  });

  it('the subscriber attaches for the event org and drops malformed payloads', async () => {
    await handleAlertTriggeredForFixMemory({ id: 'e', type: 'alert.triggered', orgId: 'org-1', source: 's', priority: 'normal', payload: { alertId: 'a-1' }, metadata: { timestamp: '' } } as never);
    expect(h.lookup).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-1', partnerId: 'p-1', limit: 3 }));
    vi.clearAllMocks();
    await handleAlertTriggeredForFixMemory({ id: 'e', type: 'alert.triggered', orgId: 'org-1', source: 's', priority: 'normal', payload: {}, metadata: { timestamp: '' } } as never);
    expect(h.lookup).not.toHaveBeenCalled();
  });

  it('short-circuits cheapest-first: a malformed event opens no DB context at all (I5)', async () => {
    await handleAlertTriggeredForFixMemory({ id: 'e', type: 'alert.triggered', orgId: 'org-1', source: 's', priority: 'normal', payload: { alertId: 42 }, metadata: { timestamp: '' } } as never);
    await handleAlertTriggeredForFixMemory({ id: 'e', type: 'alert.triggered', orgId: '', source: 's', priority: 'normal', payload: { alertId: 'a-1' }, metadata: { timestamp: '' } } as never);
    expect(h.systemCtx).not.toHaveBeenCalled();
    expect(h.flag).not.toHaveBeenCalled();
  });

  it('checks the ML flag before any signature, partner or lookup query (I5)', async () => {
    h.flag.mockResolvedValueOnce(false);
    await handleAlertTriggeredForFixMemory({ id: 'e', type: 'alert.triggered', orgId: 'org-1', source: 's', priority: 'normal', payload: { alertId: 'a-1' }, metadata: { timestamp: '' } } as never);
    expect(h.flag).toHaveBeenCalledWith('org-1', 'ml.remediation_suggestions.enabled');
    expect(h.sig).not.toHaveBeenCalled();
    expect(h.partner).not.toHaveBeenCalled();
    expect(h.lookup).not.toHaveBeenCalled();
  });
});
