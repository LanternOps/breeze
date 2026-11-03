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
vi.mock('../aiTools', () => ({
  verifyDeviceAccess: async () => ({ device: h.device }),
  resolveWritableToolOrgId: () => ({ orgId: h.device.orgId }),
}));
vi.mock('../aiToolsSiteScope', () => ({
  scopeDeviceIdsToCaller: async () => null,
  deviceScopeCondition: vi.fn(), siteScopeCondition: vi.fn(),
}));
vi.mock('../aiDispatch', () => ({ aiQueueCommandForExecution: vi.fn() }));
vi.mock('../eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('../../routes/remote/screenAccessConsentGate', () => ({ checkScreenAccessConsentGate: vi.fn() }));
import { registerIncidentTools } from '../aiToolsIncident';
import { aiQueueCommandForExecution } from '../aiDispatch';
import { buildIsolationAllowlist } from './allowlist';
import type { AiTool } from '../aiTools';
import type { AuthContext } from '../../middleware/auth';
const deviceId = '11111111-1111-4111-8111-111111111111';
const orgId = '22222222-2222-4222-8222-222222222222';
const incidentId = '66666666-6666-4666-8666-666666666666';
const auth = {
  user: { id: '55555555-5555-4555-8555-555555555555' }, orgId,
  canAccessOrg: (id: string) => id === orgId, canAccessSite: () => true,
  orgCondition: () => undefined,
} as unknown as AuthContext;
beforeEach(() => {
  vi.clearAllMocks(); vi.unstubAllEnvs();
  vi.stubEnv('NETWORK_ISOLATION_ENABLED', 'true');
  vi.stubEnv('NETWORK_ISOLATION_ENABLED_PARTNER_IDS', undefined);
  vi.stubEnv('TURN_HOST', 'relay.example.test'); vi.stubEnv('TURN_TLS_HOST', undefined);
  vi.stubEnv('AGENT_BACKUP_SERVER_URL', undefined);
  h.device = { id: deviceId, orgId, siteId: 'site-1', osType: 'windows', agentVersion: '999.0.0',
    networkIsolationVersion: 1, networkIsolationReady: true, status: 'online', agentServerUrl: 'https://control.example.test' };
  h.incident = { id: incidentId, orgId, affectedDevices: [deviceId], status: 'detected' };
  h.row = null; h.active = null; h.tombstone = null; h.writes = []; h.order = [];
  h.trust.mockResolvedValue(undefined); h.seal.mockReturnValue('enc:episode');
  h.dispatch.mockImplementation(async args => ({ ok: true, command: { id: args.commandId }, delivery: 'queued_offline' }));
});
describe('AI isolation payload authority', () => {
  it('queues the real service-built allowlist despite caller scope:any parameters', async () => {
    const tools = new Map<string, AiTool>(); registerIncidentTools(tools);
    const out = JSON.parse(await tools.get('execute_containment')!.handler({
      incidentId, deviceId, actionType: 'network_isolation', approvalRef: 'approval-1', reason: 'Contain incident', ttlHours: 24,
      parameters: { allow: [{ kind: 'cidr', cidr: '192.0.2.0/24', scope: 'any', proto: 'tcp', ports: [443] }],
        generation: 999, isolationId: 'forged', deadManSeconds: 1, remoteRelay: true },
    }, auth));
    expect(out.success).toBe(true);
    expect(aiQueueCommandForExecution).not.toHaveBeenCalled();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    const payload = h.dispatch.mock.calls[0]![0].payload;
    expect(payload.parameters.allow).toEqual(buildIsolationAllowlist({ serverUrl: 'https://control.example.test', remoteRelay: false }));
    expect(payload.parameters).toMatchObject({ isolationId: h.row.id, generation: 1, deadManSeconds: 0, remoteRelay: false });
    expect(payload.parameters.allow.every((entry: { scope: string }) => entry.scope === 'breeze')).toBe(true);
    expect(h.writes.find(write => write.actionType === 'network_isolation')).toMatchObject({ executedBy: 'brain', approvalRef: 'approval-1' });
  });
});
