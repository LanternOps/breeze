import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  findAlert: vi.fn(), flag: vi.fn(async () => true), sig: vi.fn(), partner: vi.fn(async () => 'p-1'), lookup: vi.fn(),
  episodeRows: [] as unknown[],
}));
const dev = vi.hoisted(() => ({ verify: vi.fn(), os: vi.fn(async () => 'windows') }));
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
vi.mock('./aiTools', () => ({ verifyDeviceAccess: dev.verify }));
vi.mock('./fixMemory/catalog', () => ({ resolveOrgPartnerId: h.partner, resolveDeviceOs: dev.os }));
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

  it('keeps the reviewed-steps id but never the human-authored title in model context (W2 Task 16)', async () => {
    h.lookup.mockResolvedValueOnce({ signature: { version: 1 }, proven: [{ memoryId: 'm', fixKind: 'manual_steps', instructionsRef: 'fi-1', instructionsTitle: 'Clear print queue' }], similar: [{ memoryId: 'm2', instructionsTitle: 'Other' }] });
    const raw = await tools.get('find_proven_fixes')!.handler({ alertId: ALERT }, auth);
    expect(raw).toContain('fi-1');
    expect(raw).not.toContain('Clear print queue');
    expect(raw).not.toContain('instructionsTitle');
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

describe('find_proven_fixes deviceId + problem (W2 Task 17)', () => {
  const DEVICE = '33333333-3333-4333-8333-333333333333';
  beforeEach(() => {
    vi.clearAllMocks();
    h.flag.mockResolvedValue(true);
    h.partner.mockResolvedValue('p-1');
    dev.os.mockResolvedValue('windows');
    dev.verify.mockResolvedValue({ device: { id: DEVICE, orgId: 'org-1' } });
    h.lookup.mockResolvedValue({ signature: { version: 1 }, proven: [{ memoryId: 'm', scope: 'all_clients' }], similar: [] });
  });

  it('computes the signature from the structured problem and the device OS', async () => {
    const out = await run({ deviceId: DEVICE, problem: { type: 'service_stopped', serviceName: 'Spooler' } });
    expect(h.sig).not.toHaveBeenCalled();
    expect(h.lookup).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-1', partnerId: 'p-1', signature: expect.objectContaining({ broad: false }) }));
    expect(out.proven).toHaveLength(1);
  });

  it('deviceId and problem come together, and never alongside alertId', async () => {
    expect((await run({ deviceId: DEVICE })).error).toMatch(/exactly one/);
    expect((await run({ alertId: ALERT, deviceId: DEVICE, problem: { type: 'reboot_pending' } })).error).toMatch(/exactly one|Invalid/);
    expect((await run({ alertId: ALERT, deviceId: DEVICE, problem: { type: 'offline' } })).error).toMatch(/exactly one/);
  });

  it('denies a device the caller cannot see', async () => {
    dev.verify.mockResolvedValueOnce({ error: 'Device not found or access denied' });
    expect((await run({ deviceId: DEVICE, problem: { type: 'service_stopped', serviceName: 'x' } })).error).toBe('Device not found or access denied');
    expect(h.lookup).not.toHaveBeenCalled();
  });

  it('free text is refused', async () => {
    expect((await run({ deviceId: DEVICE, problem: 'spooler keeps dying' })).error).toBeTruthy();
    expect(h.lookup).not.toHaveBeenCalled();
  });

  it('an incomplete problem skips the lookup instead of guessing', async () => {
    const out = await run({ deviceId: DEVICE, problem: { type: 'metric' } });
    expect(out.signature).toBeNull();
    expect(h.lookup).not.toHaveBeenCalled();
  });
});
