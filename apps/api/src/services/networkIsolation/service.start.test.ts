import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  device: {} as any, incident: {} as any, row: null as any, active: null as any, tombstone: null as any,
  writes: [] as any[], order: [] as string[], dispatch: vi.fn(), trust: vi.fn(), audit: vi.fn(),
  txDepth: 0, seal: vi.fn(), decrypt: vi.fn(),
}));
vi.mock('../../db', () => {
  const chain = (rows: () => unknown[]) => { const promise = Promise.resolve().then(rows); return { limit: () => Object.assign(promise, { for: () => promise }) }; };
  return {
    db: {
      select: () => ({ from: (table: any) => ({ where: () => chain(() => {
        const name = table[Symbol.for('drizzle:Name')];
        if (name === 'devices') return h.device ? [h.device] : [];
        if (name === 'organizations') return [{ partnerId: '44444444-4444-4444-8444-444444444444' }];
        if (name === 'incidents') return h.incident ? [h.incident] : [];
        return [];
      }) }) }),
      insert: (table: any) => ({ values: async (v: any) => { h.order.push(table[Symbol.for('drizzle:Name')]); h.writes.push(v); } }),
      update: () => ({ set: (v: any) => ({ where: async () => { h.writes.push(v); } }) }),
    },
    withDbAccessContext: async (_ctx: unknown, fn: () => unknown) => fn(),
    withDbTransaction: async (fn: () => unknown) => { h.txDepth++; try { return await fn(); } finally { h.txDepth--; } },
    runAfterDbContextCommit: vi.fn(),
  };
});
vi.mock('../../middleware/auth', () => ({ dbAccessContextFromAuth: () => ({ scope: 'organization' }) }));
vi.mock('../partnerTrust.commands', () => ({
  assertDeviceExecuteAllowed: (...args: unknown[]) => h.trust(...args),
  deviceExecuteAllowedForOrg: async () => true,
  TrustDeniedError: class extends Error {},
}));
vi.mock('../dispatchDeviceCommand', () => ({ dispatchDeviceCommand: (...args: unknown[]) => h.dispatch(...args) }));
vi.mock('../sensitiveCommandPayload', () => ({ encryptSensitivePayloadFields: (_type: string, payload: any) => ({ ...payload, ...(payload.breakGlassSecret ? { breakGlassSecret: `enc:${payload.breakGlassSecret}` } : {}) }) }));
vi.mock('../secretCrypto', () => ({ encryptSecret: (...args: unknown[]) => h.seal(...args), decryptSecret: (...args: unknown[]) => h.decrypt(...args) }));
vi.mock('../auditEvents', () => ({ writeRouteAudit: (...args: unknown[]) => h.audit(...args), requestLikeFromSnapshot: () => ({ req: { header: () => undefined } }) }));
vi.mock('./reconcile', () => ({ ISOLATION_SECRET_COLUMN: { table: 'device_network_isolations', column: 'break_glass_secret_enc', kind: 'text', aadBinding: 'row', description: 'Test' } }));
vi.mock('./episodeStore', async original => ({
  ...(await original<typeof import('./episodeStore')>()),
  findUnresolvedEpisode: async () => h.active,
  findUnconfirmedTombstone: async () => h.tombstone,
  listEpisodes: async () => h.row ? [h.row] : [],
  createEpisode: async (_tx: unknown, v: any) => {
    expect(h.txDepth).toBe(1); h.order.push('episode'); h.writes.push(v);
    h.row = { ...v, state: 'requested', desiredState: 'isolated', generation: 1, lastJournalSeq: 0,
      failureCode: null, releaseKind: null, releaseConfirmedAt: null, breakGlassAckSeq: null, lastAgentReport: null };
    return { ok: true, episode: h.row };
  },
  withEpisodeLock: async (_tx: unknown, id: string, fn: (row: any) => Promise<unknown>) => h.row?.id === id ? { found: true, value: await fn(h.row) } : { found: false },
  writeEpisodeSnapshot: async (_tx: unknown, _id: string, _prev: unknown, next: any) => { h.row = { ...h.row, ...next }; return true; },
}));
import { startNetworkIsolation, releaseNetworkIsolation, extendNetworkIsolation, acknowledgeNetworkIsolation, getBreakGlassCodes, listDeviceIsolations } from './service';
import { TrustDeniedError } from '../partnerTrust.commands';
import type { AuthContext } from '../../middleware/auth';
const deviceId = '11111111-1111-4111-8111-111111111111';
const orgId = '22222222-2222-4222-8222-222222222222';
const isolationId = '33333333-3333-4333-8333-333333333333';
const auth = { user: { id: '55555555-5555-4555-8555-555555555555' }, canAccessOrg: (id: string) => id === orgId, canAccessSite: () => true } as unknown as AuthContext;
const input = { createIncident: { title: 'Containment investigation', severity: 'p2' as const }, reason: 'Investigation' };
function episode(extra: Record<string, unknown> = {}) {
  return { id: isolationId, deviceId, orgId, state: 'verified', desiredState: 'isolated', generation: 3, lastJournalSeq: 5,
    expiresAt: new Date(Date.now() + 3_600_000), breakGlassSecretEnc: 'enc:stored', breakGlassAckSeq: 2,
    lastAgentReport: { generation: 2 }, releaseConfirmedAt: null, failureCode: null, releaseKind: null, ...extra };
}
beforeEach(() => {
  vi.clearAllMocks(); vi.unstubAllEnvs();
  vi.stubEnv('NETWORK_ISOLATION_ENABLED', 'true'); vi.stubEnv('NETWORK_ISOLATION_ENABLED_PARTNER_IDS', undefined);
  vi.stubEnv('TURN_HOST', undefined); vi.stubEnv('TURN_TLS_HOST', undefined);
  h.device = { id: deviceId, orgId, siteId: 'site-1', osType: 'windows', agentVersion: '999.0.0', networkIsolationVersion: 1, networkIsolationReady: true, status: 'online', agentServerUrl: 'https://control.example.test' };
  h.incident = { id: '66666666-6666-4666-8666-666666666666', orgId, affectedDevices: [deviceId], status: 'detected' };
  h.row = null; h.active = null; h.tombstone = null; h.writes = []; h.order = [];
  h.trust.mockResolvedValue(undefined); h.seal.mockReturnValue('enc:episode'); h.decrypt.mockReturnValue(Buffer.alloc(32, 8).toString('base64'));
  h.dispatch.mockImplementation(async (args) => { expect(h.txDepth).toBe(1); h.order.push('dispatch'); return { ok: true, command: { id: args.commandId }, delivery: 'queued_offline' }; });
});
describe('startNetworkIsolation', () => {
  it('creates incident, reversible action and row before dispatch in the same transaction', async () => {
    const before = Date.now(); const result = await startNetworkIsolation(auth, deviceId, input, { requestedByKind: 'user' });
    expect(result).not.toHaveProperty('error');
    expect(h.order).toEqual(['incidents', 'incident_actions', 'episode', 'dispatch']);
    expect(h.writes[0]).toMatchObject({ classification: 'manual_containment', affectedDevices: [deviceId] });
    expect(h.writes[1]).toMatchObject({ actionType: 'network_isolation', reversible: true });
    expect(h.row.expiresAt.getTime() - before).toBeGreaterThanOrEqual(72 * 3_600_000);
    expect(h.row.expiresAt.getTime() - before).toBeLessThan(72 * 3_600_000 + 1000);
    expect(h.seal).toHaveBeenCalledWith(expect.any(String), { aad: `device_network_isolations.break_glass_secret_enc:${h.row.id}` });
    expect(h.dispatch.mock.calls[0]![0]).toMatchObject({ expectedOrgId: orgId, deferDelivery: true, type: 'execute_containment', payload: { breakGlassSecret: expect.stringMatching(/^enc:/), parameters: { deadManSeconds: 0, generation: 1 } } });
    expect(result).toHaveProperty('episode.state', 'dispatched');
    expect(result).not.toHaveProperty('episode.breakGlassSecretEnc');
  });
  it.each([
    ['feature_disabled', () => vi.stubEnv('NETWORK_ISOLATION_ENABLED', 'false')],
    ['feature_disabled', () => vi.stubEnv('NETWORK_ISOLATION_ENABLED_PARTNER_IDS', '77777777-7777-4777-8777-777777777777')],
    ['agent_unsupported', () => { h.device.agentVersion = '1.0.0'; }],
    ['agent_unsupported', () => { h.device.networkIsolationVersion = 0; }],
    ['agent_unsupported', () => { h.device.networkIsolationReady = false; }],
    ['unsupported_platform', () => { h.device.osType = 'unknown'; }],
    ['trust_restricted', () => h.trust.mockRejectedValue(new TrustDeniedError('TRUST_RESTRICTED', 'Restricted', deviceId, 'execute_containment'))],
    ['isolation_already_active', () => { h.active = episode(); }],
    ['isolation_unacknowledged', () => { h.active = episode({ state: 'released_locally' }); }],
    ['site_forbidden', () => { h.device.siteId = 'denied'; }],
    ['incident_mismatch', () => { h.incident.orgId = 'other'; }],
  ] as const)('refuses %s before dispatch', async (error, setup) => {
    setup();
    const caller = { ...auth, canAccessSite: (id: string | null) => id !== 'denied' } as AuthContext;
    const result = await startNetworkIsolation(caller, deviceId, { incidentId: h.incident.id, reason: 'Investigation' }, { requestedByKind: 'user' });
    expect(result).toEqual({ error }); expect(h.dispatch).not.toHaveBeenCalled();
  });
  it('refuses a closed incident and an incident not affecting this device', async () => {
    for (const patch of [{ status: 'closed' }, { status: 'detected', affectedDevices: [] }]) {
      Object.assign(h.incident, patch);
      expect(await startNetworkIsolation(auth, deviceId, { incidentId: h.incident.id, reason: 'Investigation' }, { requestedByKind: 'user' })).toEqual({ error: 'incident_mismatch' });
    }
  });
  it('queues offline, bounds command delivery by expiry and caps TTL at 720 hours', async () => {
    h.device.status = 'offline';
    expect(await startNetworkIsolation(auth, deviceId, { ...input, ttlHours: 1 }, { requestedByKind: 'user' })).not.toHaveProperty('error');
    expect(h.dispatch.mock.calls[0]![0].offlinePolicy.deliverWithinMs).toBeLessThanOrEqual(3_600_000);
    await expect(startNetworkIsolation(auth, deviceId, { ...input, ttlHours: 721 }, { requestedByKind: 'user' })).rejects.toThrow();
  });
  it('refuses invalid control-plane and unavailable relay configuration', async () => {
    expect(await startNetworkIsolation(auth, deviceId, { ...input, remoteRelay: true }, { requestedByKind: 'user' })).toEqual({ error: 'relay_unavailable' });
    h.device.agentServerUrl = 'bad';
    expect(await startNetworkIsolation(auth, deviceId, input, { requestedByKind: 'user' })).toEqual({ error: 'invalid_allowlist' });
  });
  it('conceals another organization device', async () => {
    h.device.orgId = 'other';
    expect(await startNetworkIsolation(auth, deviceId, input, { requestedByKind: 'user' })).toEqual({ error: 'device_not_found' });
  });
  it('shows break-glass codes for the agent generation and audits the view without the code', async () => {
    h.row = episode();
    const result = await getBreakGlassCodes(auth, deviceId, isolationId);
    expect(result).toHaveProperty('generation', 2);
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'device.isolation.break_glass_code_view', details: { isolationId, generation: 2 } }));
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain(Buffer.alloc(32, 8).toString('base64'));
  });
  it('does not leak ciphertext in listing and exposes the last agent generation', async () => {
    h.row = episode();
    const result = await listDeviceIsolations(auth, deviceId);
    expect(result).toHaveProperty('episodes.0.lastReportedGeneration', 2);
    expect(result).not.toHaveProperty('episodes.0.breakGlassSecretEnc');
  });
});
