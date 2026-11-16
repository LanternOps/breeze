import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  device: {} as any, incident: {} as any, row: null as any, active: null as any, tombstone: null as any,
  writes: [] as any[], order: [] as string[], dispatch: vi.fn(), trust: vi.fn(), audit: vi.fn(),
  txDepth: 0, seal: vi.fn(), decrypt: vi.fn(), resolvePolicy: vi.fn(), auditRefused: vi.fn(),
  acceptsToken: vi.fn(),
}));
// The real gate, observed: both version gates are the same sentinel, so a test cannot fail one alone.
vi.mock('@breeze/shared', async original => {
  const real = await original<typeof import('@breeze/shared')>();
  h.acceptsToken.mockImplementation(real.agentAcceptsReleaseToken);
  return { ...real, agentAcceptsReleaseToken: (...args: Parameters<typeof real.agentAcceptsReleaseToken>) => h.acceptsToken(...args) };
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
import { createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { startNetworkIsolation, getBreakGlassCodes, getReleaseToken } from './service';
import { RELEASE_TOKEN_DOMAIN } from './releaseToken';
import type { AuthContext } from '../../middleware/auth';
// Arbitrary TEST seeds; they protect nothing.
const SEED_A = Buffer.from('b6d4a2d7f0a5f4c1b7e1e1f6a0d6c4f9c2c1a2b3d4e5f60718293a4b5c6d7e8f', 'hex').toString('base64');
const SEED_B = Buffer.alloc(32, 0x42).toString('base64');
const deviceId = '11111111-1111-4111-8111-111111111111';
const orgId = '22222222-2222-4222-8222-222222222222';
const isolationId = '33333333-3333-4333-8333-333333333333';
const auth = { user: { id: '55555555-5555-4555-8555-555555555555' }, canAccessOrg: (id: string) => id === orgId, canAccessSite: () => true } as unknown as AuthContext;
const input = { createIncident: { title: 'Containment investigation', severity: 'p2' as const }, reason: 'Investigation' };
const NO_EXTRAS = { extraAllow: [], revision: 'c1:defaults', refusedGroups: [], requireSignedReleaseToken: false };
function episode(extra: Record<string, unknown> = {}) {
  return { id: isolationId, deviceId, orgId, state: 'verified', desiredState: 'isolated', generation: 3, lastJournalSeq: 5,
    expiresAt: new Date(Date.now() + 3_600_000), breakGlassSecretEnc: 'enc:stored', breakGlassAckSeq: 2,
    lastAgentReport: { generation: 2 }, releaseConfirmedAt: null, failureCode: null, releaseKind: null, allowSnapshotRevision: null, appliedPolicyRevision: null, ...extra };
}
beforeEach(() => {
  vi.clearAllMocks(); vi.unstubAllEnvs();
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

function publicKeyOf(seedB64: string): string {
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seedB64, 'base64')]);
  const jwk = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' });
  return Buffer.from(jwk.x as string, 'base64url').toString('base64');
}
const sentParams = () => h.dispatch.mock.calls[0]![0].payload.parameters as Record<string, unknown>;
const tokenAgent = () => { h.device.networkIsolationVersion = 4; h.device.agentVersion = '999.0.0'; };

describe('startNetworkIsolation: release-token pin (#10102)', () => {
  it('pins nothing by default: no signing key configured', async () => {
    tokenAgent();
    await startNetworkIsolation(auth, deviceId, input, { requestedByKind: 'user' });
    expect(sentParams()).not.toHaveProperty('releaseTokenPublicKey');
    expect(h.row.releaseTokenPublicKey ?? null).toBeNull();
    expect(h.row.releaseTokenRequired ?? false).toBe(false);
  });

  it.each([
    ['capability 3', () => { h.device.networkIsolationVersion = 3; }],
    ['agent below the token version gate', () => { tokenAgent(); h.acceptsToken.mockReturnValueOnce(false); }],
  ])('pins nothing for an agent that cannot take the fields (%s)', async (_name, setup) => {
    vi.stubEnv('NETWORK_ISOLATION_TOKEN_SIGNING_KEY', SEED_A);
    setup();
    await startNetworkIsolation(auth, deviceId, input, { requestedByKind: 'user' });
    expect(sentParams()).not.toHaveProperty('releaseTokenPublicKey');
    expect(sentParams()).not.toHaveProperty('requireSignedReleaseToken');
    expect(h.row.releaseTokenPublicKey ?? null).toBeNull();
  });

  it('pins the public key, the device and the policy requirement on the episode and the command', async () => {
    vi.stubEnv('NETWORK_ISOLATION_TOKEN_SIGNING_KEY', SEED_A);
    tokenAgent();
    h.resolvePolicy.mockResolvedValue({ ...NO_EXTRAS, requireSignedReleaseToken: true });
    await startNetworkIsolation(auth, deviceId, input, { requestedByKind: 'user' });
    expect(h.acceptsToken).toHaveBeenCalledWith(4, '999.0.0');
    expect(sentParams()).toMatchObject({ releaseTokenPublicKey: publicKeyOf(SEED_A), releaseTokenDeviceId: deviceId, requireSignedReleaseToken: true });
    expect(h.row).toMatchObject({ releaseTokenPublicKey: publicKeyOf(SEED_A), releaseTokenRequired: true });
  });

  it('still isolates, without a token key, when the configured key is malformed', async () => {
    vi.stubEnv('NETWORK_ISOLATION_TOKEN_SIGNING_KEY', 'not-a-key');
    tokenAgent();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await startNetworkIsolation(auth, deviceId, input, { requestedByKind: 'user' });
      expect(result).not.toHaveProperty('error');
      expect(sentParams()).not.toHaveProperty('releaseTokenPublicKey');
      expect(JSON.stringify(error.mock.calls)).not.toContain('not-a-key');
    } finally { error.mockRestore(); }
  });
});

describe('getReleaseToken (#10102)', () => {
  const pinned = () => episode({ releaseTokenPublicKey: publicKeyOf(SEED_A), releaseTokenRequired: false });

  it('mints a token for the agent generation, signed by the pinned key, and audits without the token', async () => {
    vi.stubEnv('NETWORK_ISOLATION_TOKEN_SIGNING_KEY', SEED_A);
    h.row = pinned();
    const before = Math.floor(Date.now() / 1000);
    const result = await getReleaseToken(auth, deviceId, isolationId) as { token: string; generation: number; notBefore: Date; expiresAt: Date; qrCodeDataUrl: string };
    expect(result).not.toHaveProperty('error');
    expect(result.generation).toBe(2);
    const [payload, sig] = result.token.split('.');
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
    expect(claims).toMatchObject({ v: 1, iid: isolationId, gen: 2, dev: deviceId });
    expect(claims.nbf).toBeGreaterThanOrEqual(before);
    expect(claims.exp - claims.nbf).toBe(7200);
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKeyOf(SEED_A), 'base64')]), format: 'der', type: 'spki' });
    expect(verify(null, Buffer.from(RELEASE_TOKEN_DOMAIN + payload, 'utf8'), key, Buffer.from(sig!, 'base64url'))).toBe(true);
    expect(result.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'device.isolation.release_token_issued', details: expect.objectContaining({ isolationId, generation: 2 }) }));
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain(result.token);
  });

  it.each([
    ['no key was pinned at start', () => { h.row = episode({ releaseTokenPublicKey: null }); vi.stubEnv('NETWORK_ISOLATION_TOKEN_SIGNING_KEY', SEED_A); }],
    ['no signing key is configured now', () => { h.row = pinned(); }],
    ['the signing key was rotated since start', () => { h.row = pinned(); vi.stubEnv('NETWORK_ISOLATION_TOKEN_SIGNING_KEY', SEED_B); }],
    ['the configured key is malformed', () => { h.row = pinned(); vi.stubEnv('NETWORK_ISOLATION_TOKEN_SIGNING_KEY', 'garbage'); }],
  ])('refuses when %s', async (_name, setup) => {
    setup();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await getReleaseToken(auth, deviceId, isolationId)).toEqual({ error: 'release_token_unavailable' });
      expect(h.audit).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'device.isolation.release_token_issued' }));
    } finally { error.mockRestore(); }
  });

  it('refuses for a resolved episode', async () => {
    vi.stubEnv('NETWORK_ISOLATION_TOKEN_SIGNING_KEY', SEED_A);
    h.row = { ...pinned(), state: 'released', desiredState: 'released' };
    expect(await getReleaseToken(auth, deviceId, isolationId)).toEqual({ error: 'isolation_conflict' });
  });

  it('conceals another organization device', async () => {
    vi.stubEnv('NETWORK_ISOLATION_TOKEN_SIGNING_KEY', SEED_A);
    h.row = pinned(); h.device.orgId = 'other';
    expect(await getReleaseToken(auth, deviceId, isolationId)).toEqual({ error: 'device_not_found' });
  });
});

describe('getBreakGlassCodes when the episode requires a signed token (#10102)', () => {
  it('refuses to show codes the device would refuse, without decrypting the secret', async () => {
    h.row = episode({ releaseTokenPublicKey: publicKeyOf(SEED_A), releaseTokenRequired: true });
    expect(await getBreakGlassCodes(auth, deviceId, isolationId)).toEqual({ error: 'break_glass_code_disabled' });
    expect(h.decrypt).not.toHaveBeenCalled();
  });

  it('still shows codes when tokens are only offered', async () => {
    h.row = episode({ releaseTokenPublicKey: publicKeyOf(SEED_A), releaseTokenRequired: false });
    expect(await getBreakGlassCodes(auth, deviceId, isolationId)).toHaveProperty('current');
  });
});
