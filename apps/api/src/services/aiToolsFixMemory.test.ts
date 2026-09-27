import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findAlert: vi.fn(), flag: vi.fn(async () => true), sig: vi.fn(), partner: vi.fn(async () => 'p-1'), lookup: vi.fn(),
  episodeRows: [] as unknown[],
}));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where']) chain[m] = vi.fn(() => chain);
  (chain as { limit: unknown }).limit = vi.fn(async () => h.episodeRows);
  return { db: chain };
});
vi.mock('./aiToolsAlerts', () => ({ findAlertWithAccess: h.findAlert }));
vi.mock('./aiToolsSiteScope', () => ({ deviceIdSiteDenied: vi.fn(async () => false) }));
vi.mock('./mlFeatureFlags', () => ({ shouldProduceMlOutput: h.flag }));
vi.mock('./fixMemory/signatureLoader', () => ({ signatureForSource: h.sig }));
vi.mock('./fixMemory/catalog', () => ({ resolveOrgPartnerId: h.partner }));
vi.mock('./fixMemory/lookup', () => ({ lookupFixes: h.lookup }));

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerFixMemoryTools } from './aiToolsFixMemory';

const tools = new Map<string, AiTool>();
registerFixMemoryTools(tools);
const auth = { scope: 'organization', orgId: 'org-1', canAccessOrg: () => true, orgCondition: () => undefined } as unknown as AuthContext;
const run = async (input: Record<string, unknown>) => JSON.parse(await tools.get('find_proven_fixes')!.handler(input, auth));
const ALERT = '11111111-1111-4111-8111-111111111111';
const EPISODE = '22222222-2222-4222-8222-222222222222';

describe('find_proven_fixes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.findAlert.mockResolvedValue({ id: ALERT, orgId: 'org-1', deviceId: 'd-1', title: 'host-17 spooler down' });
    h.sig.mockResolvedValue({ signature: { version: 1 }, deviceId: 'd-1', alertId: ALERT, anomalyEpisodeId: null });
    h.lookup.mockResolvedValue({ signature: { version: 1, broad: false, family: 'alert', condition: 'rule:service_stopped', osFamily: 'windows', discriminatorKind: 'service' }, proven: [{ memoryId: 'm', scope: 'all_clients' }], similar: [] });
  });

  it('is registered as a tier-1 monitoring read', () => {
    const t = tools.get('find_proven_fixes')!;
    expect(t.tier).toBe(1);
    expect(t.domain).toBe('monitoring');
  });

  it('requires exactly one source', async () => {
    expect((await run({})).error).toMatch(/exactly one/);
    expect((await run({ alertId: ALERT, anomalyEpisodeId: EPISODE })).error).toMatch(/exactly one/);
  });

  it('looks memory up for the ALERT’s org and partner, never echoing alert text (Review Focus 4)', async () => {
    const out = await run({ alertId: ALERT });
    expect(h.lookup).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-1', partnerId: 'p-1', limit: 5 }));
    expect(JSON.stringify(out)).not.toContain('host-17');
    expect(out.proven).toHaveLength(1);
  });

  it('denies an alert the caller cannot see (cross-org)', async () => {
    h.findAlert.mockResolvedValueOnce(null);
    expect((await run({ alertId: ALERT })).error).toBe('Alert not found or access denied');
    expect(h.lookup).not.toHaveBeenCalled();
  });

  it('reports disabled when the org has suggestions off', async () => {
    h.flag.mockResolvedValueOnce(false);
    expect(await run({ alertId: ALERT })).toEqual({ disabled: true, proven: [], similar: [] });
  });

  it('resolves an anomaly episode through the caller org condition', async () => {
    h.episodeRows = [{ id: EPISODE, orgId: 'org-1', deviceId: 'd-1' }];
    await run({ anomalyEpisodeId: EPISODE });
    expect(h.sig).toHaveBeenCalledWith({ kind: 'anomaly', anomalyEpisodeId: EPISODE });
  });
});
