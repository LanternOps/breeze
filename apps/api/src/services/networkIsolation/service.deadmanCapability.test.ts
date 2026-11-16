import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  device: {} as any, incident: {} as any, row: null as any, active: null as any, tombstone: null as any,
  writes: [] as any[], order: [] as string[], dispatch: vi.fn(), trust: vi.fn(), audit: vi.fn(),
  txDepth: 0, seal: vi.fn(), decrypt: vi.fn(), resolvePolicy: vi.fn(), auditRefused: vi.fn(),
  acceptsToken: vi.fn(), acceptsDeadMan: vi.fn(), supportsIsolation: vi.fn(),
}));
// The real gates, observed: the version gates are the same sentinel, so a test cannot fail one alone.
vi.mock('@breeze/shared', async original => {
  const real = await original<typeof import('@breeze/shared')>();
  h.acceptsToken.mockImplementation(real.agentAcceptsReleaseToken);
  h.acceptsDeadMan.mockImplementation(real.agentAcceptsDeadMan);
  h.supportsIsolation.mockImplementation(real.agentSupportsNetworkIsolation);
  return {
    ...real,
    agentSupportsNetworkIsolation: (...args: Parameters<typeof real.agentSupportsNetworkIsolation>) => h.supportsIsolation(...args),
    agentAcceptsReleaseToken: (...args: Parameters<typeof real.agentAcceptsReleaseToken>) => h.acceptsToken(...args),
    agentAcceptsDeadMan: (...args: Parameters<typeof real.agentAcceptsDeadMan>) => h.acceptsDeadMan(...args),
  };
});
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
vi.mock('../featureConfigResolver', () => ({ resolveContainmentPolicy: (...args: unknown[]) => h.resolvePolicy(...args) }));
vi.mock('../executionTargetGating', () => ({ auditRefusedExecutionGroups: (...args: unknown[]) => h.auditRefused(...args) }));
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
import { startNetworkIsolation, listDeviceIsolations } from './service';
import type { AuthContext } from '../../middleware/auth';
import { NETWORK_ISOLATION_DEAD_MAN_MIN_AGENT_VERSION } from '@breeze/shared';
const realSupportsIsolation = (await vi.importActual<typeof import('@breeze/shared')>('@breeze/shared')).agentSupportsNetworkIsolation;
const deviceId = '11111111-1111-4111-8111-111111111111';
const orgId = '22222222-2222-4222-8222-222222222222';
const auth = { user: { id: '55555555-5555-4555-8555-555555555555' }, canAccessOrg: (id: string) => id === orgId, canAccessSite: () => true } as unknown as AuthContext;
const input = { createIncident: { title: 'Containment investigation', severity: 'p2' as const }, reason: 'Investigation' };
const NO_EXTRAS = { extraAllow: [], revision: 'c1:defaults', refusedGroups: [], requireSignedReleaseToken: false, deadManMinutes: 0 };
beforeEach(() => {
  vi.clearAllMocks(); vi.unstubAllEnvs();
  h.supportsIsolation.mockImplementation(realSupportsIsolation);
  vi.stubEnv('NETWORK_ISOLATION_ENABLED', 'true'); vi.stubEnv('NETWORK_ISOLATION_ENABLED_PARTNER_IDS', undefined);
  vi.stubEnv('TURN_HOST', undefined); vi.stubEnv('TURN_TLS_HOST', undefined);
  h.device = { id: deviceId, orgId, siteId: 'site-1', osType: 'windows', agentVersion: '999.0.0', networkIsolationVersion: 1, networkIsolationReady: true, status: 'online', agentServerUrl: 'https://control.example.test' };
  h.incident = { id: '66666666-6666-4666-8666-666666666666', orgId, affectedDevices: [deviceId], status: 'detected' };
  h.row = null; h.active = null; h.tombstone = null; h.writes = []; h.order = [];
  h.resolvePolicy.mockReset(); h.resolvePolicy.mockResolvedValue(NO_EXTRAS);
  h.trust.mockResolvedValue(undefined); h.seal.mockReturnValue('enc:episode'); h.decrypt.mockReturnValue(Buffer.alloc(32, 8).toString('base64'));
  h.dispatch.mockImplementation(async (args) => { expect(h.txDepth).toBe(1); h.order.push('dispatch'); return { ok: true, command: { id: args.commandId }, delivery: 'queued_offline' }; });
  vi.stubEnv('NETWORK_ISOLATION_TOKEN_SIGNING_KEY', undefined);
});

// Dead-man opt-in (#10103, plan W4d). The server sends a non-zero window only to an agent that reports
// the dead-man flag and passes the dead-man version gate; for any other agent the episode isolates
// with the dead-man off and the downgrade is on record.
const sentParams = () => h.dispatch.mock.calls[0]![0].payload.parameters as Record<string, unknown>;
const deadManAgent = () => { h.device.networkIsolationVersion = 4; h.device.networkIsolationDeadMan = true; h.device.agentVersion = NETWORK_ISOLATION_DEAD_MAN_MIN_AGENT_VERSION; };
const notEnforced = () => h.audit.mock.calls.filter(([, entry]) => entry.action === 'device.isolation.dead_man_not_enforced').map(([, entry]) => entry.details);
const quietly = async <T>(fn: () => Promise<T>) => {
  const spies = [vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})];
  try { return await fn(); } finally { spies.forEach(spy => spy.mockRestore()); }
};

describe('startNetworkIsolation: dead-man window (#10103)', () => {
  it('sends the policy window, in seconds, to an agent that runs the dead-man, and stores it on the episode', async () => {
    deadManAgent();
    h.resolvePolicy.mockResolvedValue({ ...NO_EXTRAS, deadManMinutes: 30 });
    await startNetworkIsolation(auth, deviceId, input, { requestedByKind: 'user' });
    expect(h.acceptsDeadMan).toHaveBeenCalledWith(expect.objectContaining({ networkIsolationDeadMan: true, agentVersion: NETWORK_ISOLATION_DEAD_MAN_MIN_AGENT_VERSION }));
    expect(sentParams().deadManSeconds).toBe(1800);
    expect(h.row.deadManSeconds).toBe(1800);
    expect(notEnforced()).toEqual([]);
  });

  it('sends 0 with the dead-man off in the policy, and records nothing', async () => {
    deadManAgent();
    await startNetworkIsolation(auth, deviceId, input, { requestedByKind: 'user' });
    expect(sentParams().deadManSeconds).toBe(0);
    expect(h.row.deadManSeconds).toBe(0);
    expect(notEnforced()).toEqual([]);
  });

  it.each([
    ['no dead-man flag (a v1 agent)', () => { h.device.networkIsolationVersion = 1; h.device.networkIsolationDeadMan = false; }],
    ['flag absent', () => { h.device.networkIsolationVersion = 4; delete h.device.networkIsolationDeadMan; }],
    // The isolation gate is the same sentinel, so it is held open here to reach the real dead-man gate.
    ['below the dead-man version gate', () => { deadManAgent(); h.device.agentVersion = '998.0.0'; h.supportsIsolation.mockReturnValue(true); }],
  ])('never sends a non-zero window to an agent that cannot run it (%s); isolates with 0 and records why', async (_name, setup) => {
    setup();
    h.resolvePolicy.mockResolvedValue({ ...NO_EXTRAS, deadManMinutes: 30 });
    const result = await quietly(() => startNetworkIsolation(auth, deviceId, input, { requestedByKind: 'user' }));
    expect(result).not.toHaveProperty('error');
    expect(sentParams().deadManSeconds).toBe(0);
    expect(h.row.deadManSeconds).toBe(0);
    expect(notEnforced()).toEqual([{ isolationId: h.row.id, reason: 'agent_unsupported' }]);
  });

  it('isolates with the dead-man off when the policy cannot be read', async () => {
    deadManAgent();
    h.resolvePolicy.mockRejectedValue(new Error('policy store down'));
    await quietly(() => startNetworkIsolation(auth, deviceId, input, { requestedByKind: 'user' }));
    expect(sentParams().deadManSeconds).toBe(0);
    expect(h.row.deadManSeconds).toBe(0);
  });

  it('refuses a new episode while a self-released one is unacknowledged', async () => {
    deadManAgent();
    h.active = { id: '77777777-7777-4777-8777-777777777777', state: 'self_released' };
    expect(await startNetworkIsolation(auth, deviceId, input, { requestedByKind: 'user' })).toEqual(expect.objectContaining({ error: 'isolation_unacknowledged' }));
    expect(h.dispatch).not.toHaveBeenCalled();
  });
});

describe('listDeviceIsolations: dead-man eligibility (#10103)', () => {
  it('flags a policy window this agent cannot run, so the dialog can say so', async () => {
    h.device.networkIsolationDeadMan = false;
    h.resolvePolicy.mockResolvedValue({ ...NO_EXTRAS, deadManMinutes: 30 });
    const result = await listDeviceIsolations(auth, deviceId) as { startEligibility: Record<string, unknown> };
    expect(result.startEligibility).toMatchObject({ allowed: true, deadManUnsupported: true });
  });

  it.each([
    ['the agent runs it', () => { deadManAgent(); h.resolvePolicy.mockResolvedValue({ ...NO_EXTRAS, deadManMinutes: 30 }); }],
    ['the policy has none', () => { h.device.networkIsolationDeadMan = false; }],
  ])('does not flag it when %s', async (_name, setup) => {
    setup();
    const result = await listDeviceIsolations(auth, deviceId) as { startEligibility: Record<string, unknown> };
    expect(result.startEligibility).toMatchObject({ allowed: true, deadManUnsupported: false });
  });

  it('does not flag it, and stays answerable, when the policy cannot be read', async () => {
    h.resolvePolicy.mockRejectedValue(new Error('policy store down'));
    const result = await quietly(() => listDeviceIsolations(auth, deviceId)) as { startEligibility: Record<string, unknown> };
    expect(result.startEligibility).toMatchObject({ allowed: true, deadManUnsupported: false });
  });
});
