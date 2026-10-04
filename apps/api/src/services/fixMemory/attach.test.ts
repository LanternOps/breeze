import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  flag: vi.fn(async () => true), sig: vi.fn(), partner: vi.fn(async () => 'p-1'), lookup: vi.fn(),
  values: vi.fn(), onConflict: vi.fn(async () => undefined), onConflictNothing: vi.fn(async () => undefined), instructions: vi.fn(),
  // Models inSystemDbContext as a tx that commits when the callback settles; `depth` > 0 = inside one.
  depth: 0,
  systemCtx: vi.fn(async (fn: () => unknown) => { h.depth += 1; try { return await fn(); } finally { h.depth -= 1; } }),
}));
vi.mock('../../db', () => ({
  db: { insert: vi.fn(() => ({ values: (v: unknown) => { h.values(v); return { onConflictDoUpdate: h.onConflict, onConflictDoNothing: h.onConflictNothing }; } })) },
}));
vi.mock('../mlFeatureFlags', () => ({ shouldProduceMlOutput: h.flag }));
vi.mock('./signatureLoader', () => ({
  sourceRefFor: (r: { sourceType: string; sourceId: string }) => (r.sourceType === 'rca' ? null : { kind: r.sourceType, alertId: r.sourceId }),
  signatureForSource: h.sig,
}));
vi.mock('./catalog', () => ({ resolveOrgPartnerId: h.partner }));
vi.mock('./lookup', () => ({ lookupFixes: h.lookup }));
vi.mock('./instructions', async (orig) => ({ ...(await orig<typeof import('./instructions')>()), loadActiveInstructions: h.instructions }));
vi.mock('../outcomeProbes', () => ({ inSystemDbContext: h.systemCtx }));
const capture = vi.hoisted(() => vi.fn());
const research = vi.hoisted(() => vi.fn(async (_input: unknown) => ({ status: 'started', runId: 'r', depth: 'quick' }) as unknown));
vi.mock('../sentry', () => ({ captureException: capture }));
vi.mock('./research', () => ({ requestResearch: research }));

import { attachProvenFixes, handleAlertTriggeredForFixMemory, memoryRationale } from './attach';

const proven = { memoryId: 'm-1', scope: 'all_clients', fixKind: 'partner_script', scriptId: 's-1', scriptName: 'Restart spooler', attempts: 8, verified: 7, successRate: 0.88, lastVerifiedAt: '2026-11-01T00:00:00.000Z' };
const signature = { version: 1, key: 'k', broadKey: 'b', broad: false, facets: { osFamily: 'windows' } };

describe('attach built-in and reviewed-steps fixes (W2 Task 16)', () => {
  const nonScript = { ...proven, scriptId: null, scriptName: null, builtinAction: null, instructionsRef: null, instructionsTitle: null };
  const sigWith = (discriminator: unknown) => ({ signature: { ...signature, facets: { osFamily: 'windows', discriminator } }, deviceId: 'd-1', alertId: 'a-1', anomalyEpisodeId: null });
  beforeEach(() => {
    vi.clearAllMocks();
    h.flag.mockResolvedValue(true);
    h.partner.mockResolvedValue('p-1');
  });

  it('a proven restart_service on a service signature attaches with derived params and a clamped risk floor', async () => {
    h.sig.mockResolvedValue(sigWith({ kind: 'service', value: 'spooler' }));
    h.lookup.mockResolvedValue({ proven: [{ ...nonScript, fixKind: 'builtin_action', builtinAction: 'restart_service' }], similar: [] });
    await expect(attachProvenFixes({ sourceType: 'alert', sourceId: 'a-1', orgId: 'org-1' })).resolves.toEqual({ proven: 1, attached: 1 });
    expect(h.values).toHaveBeenCalledWith(expect.objectContaining({ targetType: 'builtin_action', builtinAction: 'restart_service', parameters: { serviceName: 'spooler' }, riskTier: 'medium', origin: 'memory' }));
    expect(h.onConflictNothing).toHaveBeenCalled();
  });

  it('a proven disk_cleanup is counted as proven but never attached (no stored cleaner ids)', async () => {
    h.sig.mockResolvedValue(sigWith(null));
    h.lookup.mockResolvedValue({ proven: [{ ...nonScript, fixKind: 'builtin_action', builtinAction: 'disk_cleanup' }], similar: [] });
    await expect(attachProvenFixes({ sourceType: 'alert', sourceId: 'a-1', orgId: 'org-1' })).resolves.toEqual({ proven: 1, attached: 0 });
    expect(h.values).not.toHaveBeenCalled();
  });

  it('reviewed steps attach as manual_steps rows linked to the reviewed row', async () => {
    h.sig.mockResolvedValue(sigWith(null));
    h.lookup.mockResolvedValue({ proven: [{ ...nonScript, fixKind: 'manual_steps', instructionsRef: 'fi-1', instructionsTitle: 'Clear print queue' }], similar: [] });
    h.instructions.mockResolvedValueOnce({ id: 'fi-1', title: 'Clear print queue', steps: ['a', 'b'], retiredAt: null });
    await expect(attachProvenFixes({ sourceType: 'alert', sourceId: 'a-1', orgId: 'org-1' })).resolves.toEqual({ proven: 1, attached: 1 });
    expect(h.values).toHaveBeenCalledWith(expect.objectContaining({ targetType: 'manual_steps', instructionsId: 'fi-1', parameters: { steps: ['a', 'b'] }, origin: 'memory' }));
  });

  it('reviewed steps that were retired or are invisible are not attached', async () => {
    h.sig.mockResolvedValue(sigWith(null));
    h.lookup.mockResolvedValue({ proven: [{ ...nonScript, fixKind: 'manual_steps', instructionsRef: 'fi-1', instructionsTitle: 'x' }], similar: [] });
    h.instructions.mockResolvedValueOnce(null);
    await expect(attachProvenFixes({ sourceType: 'alert', sourceId: 'a-1', orgId: 'org-1' })).resolves.toEqual({ proven: 1, attached: 0 });
    expect(h.values).not.toHaveBeenCalled();
  });
});

describe('attachProvenFixes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.flag.mockResolvedValue(true);
    h.partner.mockResolvedValue('p-1');
    h.sig.mockResolvedValue({ signature, deviceId: 'd-1', alertId: 'a-1', anomalyEpisodeId: null });
    h.lookup.mockResolvedValue({ proven: [proven], similar: [] });
  });

  it('writes a memory-origin suggestion for each proven script fix and upgrades an untouched catalog row', async () => {
    await expect(attachProvenFixes({ sourceType: 'alert', sourceId: 'a-1', orgId: 'org-1' })).resolves.toEqual({ proven: 1, attached: 1 });
    expect(h.values).toHaveBeenCalledWith(expect.objectContaining({
      origin: 'memory', targetType: 'script', scriptId: 's-1', deviceId: 'd-1', targetDeviceIds: ['d-1'],
      alertId: 'a-1', status: 'suggested', confidence: null,
      evidence: expect.objectContaining({ origin: 'memory', memoryId: 'm-1', attempts: 8, verifiedCount: 7 }),
    }));
    expect(h.onConflict).toHaveBeenCalledWith(expect.objectContaining({ set: expect.objectContaining({ origin: 'memory' }) }));
  });

  it('does nothing when the flag is off, the signature is broad, or the source has none', async () => {
    h.flag.mockResolvedValueOnce(false);
    expect(await attachProvenFixes({ sourceType: 'alert', sourceId: 'a-1', orgId: 'org-1' })).toEqual({ proven: 0, attached: 0 });
    h.sig.mockResolvedValueOnce({ signature: { ...signature, broad: true }, deviceId: 'd-1', alertId: 'a-1', anomalyEpisodeId: null });
    expect(await attachProvenFixes({ sourceType: 'alert', sourceId: 'a-1', orgId: 'org-1' })).toEqual({ proven: 0, attached: 0 });
    expect(await attachProvenFixes({ sourceType: 'rca', sourceId: 'x', orgId: 'org-1' })).toEqual({ proven: 0, attached: 0 });
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

describe('auto research (W2 Task 14)', () => {
  const evt = (severity: string) => ({ id: 'e', type: 'alert.triggered', orgId: 'org-1', source: 's', priority: 'normal', payload: { alertId: 'a-1', severity }, metadata: { timestamp: '' } } as never);
  beforeEach(() => {
    vi.clearAllMocks();
    h.flag.mockResolvedValue(true);
    h.partner.mockResolvedValue('p-1');
    h.sig.mockResolvedValue({ signature, deviceId: 'd-1', alertId: 'a-1', anomalyEpisodeId: null });
    h.lookup.mockResolvedValue({ proven: [proven], similar: [] });
    research.mockResolvedValue({ status: 'started', runId: 'r', depth: 'quick' });
  });

  it('high/critical with no proven hit -> quick auto research', async () => {
    h.lookup.mockResolvedValueOnce({ proven: [], similar: [] });
    let depthAtCall = -1;
    let readsDepth = -1;
    research.mockImplementationOnce(async (input: unknown) => {
      depthAtCall = h.depth;
      readsDepth = await (input as { runReads: (fn: () => Promise<number>) => Promise<number> }).runReads(async () => h.depth);
      return { status: 'started', runId: 'r', depth: 'quick' };
    });
    await handleAlertTriggeredForFixMemory(evt('critical'));
    expect(research).toHaveBeenCalledWith({ orgId: 'org-1', sourceType: 'alert', sourceId: 'a-1', depth: 'quick', trigger: 'auto', actorUserId: null, runReads: expect.any(Function) });
    // A1/A3: called after the attach tx committed, with NO wrapping context; its reads use a system tx.
    expect(depthAtCall).toBe(0);
    expect(readsDepth).toBe(1);
  });

  it('a proven hit, or a low/medium alert, never auto-researches', async () => {
    await handleAlertTriggeredForFixMemory(evt('critical'));
    h.lookup.mockResolvedValueOnce({ proven: [], similar: [] });
    await handleAlertTriggeredForFixMemory(evt('medium'));
    expect(research).not.toHaveBeenCalled();
  });

  it('a denied research request is not an error (no retry storm)', async () => {
    h.lookup.mockResolvedValueOnce({ proven: [], similar: [] });
    research.mockResolvedValueOnce({ status: 'denied', code: 'auto_cap', message: 'cap' });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await expect(handleAlertTriggeredForFixMemory(evt('high'))).resolves.toBeUndefined();
    expect(info).toHaveBeenCalledWith('[fixMemory] auto research not started', expect.objectContaining({ code: 'auto_cap' }));
    info.mockRestore();
  });

  it('a thrown research failure never fails the subscriber (memory path is independent)', async () => {
    h.lookup.mockResolvedValueOnce({ proven: [], similar: [] });
    research.mockRejectedValueOnce(new Error('boom'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(handleAlertTriggeredForFixMemory(evt('high'))).resolves.toBeUndefined();
    expect(err).toHaveBeenCalled();
    expect(capture).toHaveBeenCalledWith(expect.any(Error), undefined, { component: 'fixMemory.autoResearch' });
    err.mockRestore();
  });

  it('a proven non-script fix (builtin/playbook) counts as proven: no auto research', async () => {
    h.lookup.mockResolvedValueOnce({ proven: [{ ...proven, scriptId: null, scriptName: null, fixKind: 'builtin_action' }], similar: [] });
    await handleAlertTriggeredForFixMemory(evt('critical'));
    expect(h.values).not.toHaveBeenCalled();
    expect(research).not.toHaveBeenCalled();
  });

  it('missing or non-string severity never auto-researches', async () => {
    for (const payload of [{ alertId: 'a-1' }, { alertId: 'a-1', severity: 3 }]) {
      h.lookup.mockResolvedValueOnce({ proven: [], similar: [] });
      await handleAlertTriggeredForFixMemory({ id: 'e', type: 'alert.triggered', orgId: 'org-1', source: 's', priority: 'normal', payload, metadata: { timestamp: '' } } as never);
    }
    expect(research).not.toHaveBeenCalled();
  });
});
