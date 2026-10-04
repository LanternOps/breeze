import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ flag: vi.fn(async () => true), sig: vi.fn(), lookup: vi.fn() }));
vi.mock('../mlFeatureFlags', () => ({ shouldProduceMlOutput: h.flag }));
vi.mock('./signatureLoader', () => ({ signatureForSource: h.sig }));
vi.mock('./lookup', () => ({ lookupFixes: h.lookup }));

import { loadProvenFixesForRun } from './runMemory';

const signature = { version: 1, key: 'k', broadKey: 'b', broad: false, facets: { osFamily: 'windows' } };
const track = (over = {}) => ({
  memoryId: 'm-1', scope: 'all_clients', fixKind: 'partner_script', scriptId: 's-1', scriptVersionId: 'v-1',
  scriptName: 'Restart spooler', builtinAction: null, playbookId: null, attempts: 8, verified: 7, failed: 1,
  recurred: 0, instructionsRef: null, instructionsTitle: 'Org-authored steps', upVotes: 0, downVotes: 0, successRate: 0.88, lastVerifiedAt: '2026-11-01T00:00:00.000Z', status: 'active', ...over,
});
const input = { orgId: 'org-1', partnerId: 'p-1', alertId: 'a-1', correlationGroupId: null };

describe('loadProvenFixesForRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.flag.mockResolvedValue(true);
    h.sig.mockResolvedValue({ signature, deviceId: 'd-1', alertId: 'a-1', anomalyEpisodeId: null });
    h.lookup.mockResolvedValue({ signature: {}, proven: [track()], similar: [track({ memoryId: 'm-2' })] });
  });

  it('returns a compact, privacy-safe projection for the run’s alert', async () => {
    await expect(loadProvenFixesForRun(input)).resolves.toEqual({
      broad: false,
      proven: [{ scriptName: 'Restart spooler', builtinAction: null, fixKind: 'partner_script', scope: 'all_clients', verified: 7, attempts: 8, lastVerifiedAt: '2026-11-01T00:00:00.000Z' }],
      similarCount: 1,
    });
    expect(h.sig).toHaveBeenCalledWith({ kind: 'alert', alertId: 'a-1' });
    expect(h.lookup).toHaveBeenCalledWith({ orgId: 'org-1', partnerId: 'p-1', signature, limit: 3 });
  });

  it('prefers the correlation group when the run is group-bound', async () => {
    await loadProvenFixesForRun({ ...input, correlationGroupId: 'g-1' });
    expect(h.sig).toHaveBeenCalledWith({ kind: 'correlation', correlationGroupId: 'g-1' });
  });

  it('flag off → null without a lookup (Review Focus 2)', async () => {
    h.flag.mockResolvedValueOnce(false);
    await expect(loadProvenFixesForRun(input)).resolves.toBeNull();
    expect(h.sig).not.toHaveBeenCalled();
  });

  it('no alert/group, or no computable signature → null', async () => {
    await expect(loadProvenFixesForRun({ ...input, alertId: null })).resolves.toBeNull();
    h.sig.mockResolvedValueOnce(null);
    await expect(loadProvenFixesForRun(input)).resolves.toBeNull();
  });

  it('a throwing lookup → null, never an exception (Review Focus 2)', async () => {
    h.lookup.mockRejectedValueOnce(new Error('db down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(loadProvenFixesForRun(input)).resolves.toBeNull();
    err.mockRestore();
  });

  it('nothing proven and nothing similar → null (no empty prompt section)', async () => {
    h.lookup.mockResolvedValueOnce({ signature: {}, proven: [], similar: [] });
    await expect(loadProvenFixesForRun(input)).resolves.toBeNull();
  });
});
