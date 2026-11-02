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
      update: () => ({ set: (v: any) => ({ where: () => { h.writes.push(v); return { returning: async () => [{ id: h.row?.id }], then: (resolve: (value: unknown) => unknown) => Promise.resolve().then(resolve) }; } }) }),
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
vi.mock('./episodeStore', async original => {
  const actual = await original<typeof import('./episodeStore')>();
  return {
  ...actual,
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
  writeEpisodeSnapshot: async (tx: any, id: string, prev: any, next: any) => { const written = await actual.writeEpisodeSnapshot(tx, id, prev, next); if (written) h.row = { ...h.row, ...next }; return written; },
}; });
import { startNetworkIsolation, releaseNetworkIsolation, extendNetworkIsolation, acknowledgeNetworkIsolation, getBreakGlassCodes, listDeviceIsolations } from './service';
import { TrustDeniedError } from '../partnerTrust.commands';
import { isolationStartGate } from './gates';
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
describe('release stays live when start gates fail', () => {
  it.each(['flag_off', 'partner_missing', 'old_agent', 'capability_zero', 'trust_restricted', 'quarantined'])('%s', async condition => {
    h.row = episode();
    if (condition === 'flag_off') vi.stubEnv('NETWORK_ISOLATION_ENABLED', 'false');
    if (condition === 'partner_missing') vi.stubEnv('NETWORK_ISOLATION_ENABLED_PARTNER_IDS', '77777777-7777-4777-8777-777777777777');
    if (condition === 'old_agent') h.device.agentVersion = '1.0.0';
    if (condition === 'capability_zero') { h.device.networkIsolationVersion = 0; h.device.networkIsolationReady = false; }
    if (condition === 'trust_restricted') h.trust.mockRejectedValue(new TrustDeniedError('TRUST_RESTRICTED', 'Restricted', deviceId, 'execute_containment'));
    if (condition === 'quarantined') h.device.status = 'quarantined';
    if (condition === 'partner_missing') expect(isolationStartGate(h.device, '44444444-4444-4444-8444-444444444444')).toBe('partner_not_enabled');
    const result = await releaseNetworkIsolation(auth, deviceId, isolationId, { reason: 'Release' }, { kind: 'console' });
    expect(result).not.toHaveProperty('error');
    expect(h.row).toMatchObject({ desiredState: 'released', state: 'release_requested', generation: 4, releaseConfirmedAt: null });
    expect(h.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'release_containment', payload: { isolationId, generation: 4, reason: 'Release' } }));
    expect(h.trust).not.toHaveBeenCalled();
  });
  it('rechecks approval bindings under the episode lock before any mutation', async () => {
    h.row = episode({ generation: 4 });
    expect(await releaseNetworkIsolation(auth, deviceId, isolationId, { reason: 'Release' }, { kind: 'ai', approvalBinding: { orgId, deviceId, isolationId, generation: 3 } })).toEqual({ error: 'approval_mismatch' });
    expect(h.row.state).toBe('verified'); expect(h.dispatch).not.toHaveBeenCalled();
  });
  it('extends and acknowledges with the flag off', async () => {
    vi.stubEnv('NETWORK_ISOLATION_ENABLED', 'false'); h.row = episode();
    expect(await extendNetworkIsolation(auth, deviceId, isolationId, 72)).not.toHaveProperty('error');
    expect(h.row.generation).toBe(4);
    h.row = episode({ desiredState: 'released', state: 'released_locally' });
    expect(await acknowledgeNetworkIsolation(auth, deviceId, isolationId)).not.toHaveProperty('error');
    expect(h.row.state).toBe('released');
    expect(h.writes).toContainEqual(expect.objectContaining({ state: 'released', breakGlassSecretEnc: '' }));
  });
  it('refuses a mismatched device episode without delivery', async () => {
    h.row = episode({ deviceId: 'other' });
    expect(await releaseNetworkIsolation(auth, deviceId, isolationId, { reason: 'Release' }, { kind: 'console' })).toEqual({ error: 'isolation_not_found' });
    expect(h.dispatch).not.toHaveBeenCalled();
  });
  it('redelivers an unconfirmed tombstone without changing its generation', async () => {
    h.row = episode({ state: 'failed', desiredState: 'released', generation: 4 });
    expect(await releaseNetworkIsolation(auth, deviceId, isolationId, { reason: 'Retry' }, { kind: 'console' })).not.toHaveProperty('error');
    expect(h.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'release_containment', payload: { isolationId, generation: 4, reason: 'Retry' } }));
    expect(h.row.generation).toBe(4);
  });
  it('returns an already-confirmed episode without another delivery', async () => {
    h.row = episode({ state: 'released', desiredState: 'released', releaseConfirmedAt: new Date() });
    expect(await releaseNetworkIsolation(auth, deviceId, isolationId, { reason: 'Retry' }, { kind: 'console' })).not.toHaveProperty('error');
    expect(h.dispatch).not.toHaveBeenCalled();
  });

});
