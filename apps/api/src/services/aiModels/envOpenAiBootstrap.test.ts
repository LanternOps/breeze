/**
 * W06 Task 15 (#7604, Decision D6): the MCP_LLM_* env bootstrap — decision
 * logic at unit level. The store (envOpenAiBootstrapStore.ts) is replaced by
 * an in-memory fake with the same contract; its SQL, the registry lock and
 * the concurrent-replica guarantee are proven against real Postgres in
 * __tests__/integration/envOpenAiBootstrap.integration.test.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ChatDefault = { kind: 'platform' } | { kind: 'none' } | { kind: 'offering'; id: string };
interface FakeOffering { id: string; modelId: string; enabled: boolean; verified: boolean; prices: Record<string, number> }
interface FakeConn { id: string; baseUrl: string; configVersion: number; keyFingerprint: string | null; envModel: string | null; released?: boolean }
interface FakePartner { conn: FakeConn | null; offerings: FakeOffering[]; chat: ChatDefault; otherDefaults: string[] }

const h = vi.hoisted(() => ({
  partners: new Map<string, FakePartner>(),
  cutover: vi.fn(async (_partnerId: string) => true),
  enqueue: vi.fn(async (_input: { offeringId: string; partnerId: string }) => {}),
  hosted: false,
  policy: vi.fn(async (u: string) => u.trim().replace(/\/+$/, '')),
  calls: [] as string[],
  seq: 0,
  /** Throw from insertEnvConnection for these partners. */
  failInsert: new Set<string>(),
  inLock: false,
  released: 0,
  revoked: [] as string[],
  enqueueOpts: [] as unknown[],
  captured: [] as Array<{ error: unknown; tags: unknown }>,
}));

const fp = (key: string) => `fp(${key.length})`;   // never contains the key

vi.mock('../../config/env', async (orig) => ({ ...(await orig<typeof import('../../config/env')>()), isHosted: () => h.hosted }));
vi.mock('../secretCrypto', () => ({ hmacFingerprint: (k: string) => fp(k) }));
vi.mock('../../db', () => ({ runOutsideDbContext: <T>(fn: () => T) => fn() }));
vi.mock('./gatewayConnectionState', () => ({
  revokeGatewayConnectionGrants: async (id: string) => { h.calls.push(`revoke:${id}:${h.inLock ? 'IN_TX' : 'after'}`); h.revoked.push(id); },
}));
vi.mock('../sentry', () => ({ captureException: (error: unknown, _c: unknown, tags: unknown) => { h.captured.push({ error, tags }); } }));
vi.mock('./registryCutover', () => ({ ensurePartnerCutover: (id: string) => { h.calls.push(`cutover:${id}`); return h.cutover(id); } }));
vi.mock('../../jobs/aiModelDiscoveryWorker', () => ({
  enqueueOfferingVerification: (input: { offeringId: string; partnerId: string }, opts?: unknown) => {
    h.calls.push(`enqueue:${input.offeringId}:${h.inLock ? 'IN_TX' : 'after'}`);
    h.enqueueOpts.push(opts);
    return h.enqueue(input);
  },
}));
vi.mock('./gateway/byoEndpointPolicy', async (orig) => ({
  ...(await orig<typeof import('./gateway/byoEndpointPolicy')>()),
  validateByoBaseUrl: (u: string) => {
    h.calls.push(`validate:${h.inLock ? 'IN_TX' : 'outside'}`);
    return h.policy(u);
  },
}));
vi.mock('./gatewayConnections', () => ({
  updateGatewayConnectionLocked: vi.fn(async (input: { partnerId: string; connectionId: string; baseUrl?: string; apiKey?: string | null; expectedConfigVersion: number; allowManaged?: boolean }) => {
    if (!h.inLock) throw new Error('updateGatewayConnectionLocked outside the partner lock');
    const p = h.partners.get(input.partnerId)!;
    if (!input.allowManaged) throw new Error('managed_by_env');
    if (p.conn!.configVersion !== input.expectedConfigVersion) throw new Error('stale_write');
    if (input.baseUrl !== undefined) p.conn!.baseUrl = input.baseUrl;
    if (input.apiKey !== undefined) p.conn!.keyFingerprint = input.apiKey === null ? null : fp(input.apiKey);
    p.conn!.configVersion += 1;
    return {};
  }),
}));

vi.mock('./envOpenAiBootstrapStore', () => {
  const need = (partnerId: string) => {
    if (!h.inLock) throw new Error('store write outside the partner lock');
    return h.partners.get(partnerId)!;
  };
  return {
    listPartnerIds: async () => [...h.partners.keys()],
    inPartnerEnvLock: async <T>(partnerId: string, fn: () => Promise<T>) => {
      h.calls.push(`lock:${partnerId}`);
      h.inLock = true;
      const snapshot = structuredClone(h.partners.get(partnerId));
      try {
        return await fn();
      } catch (error) {
        h.partners.set(partnerId, snapshot!);   // rollback
        throw error;
      } finally {
        h.inLock = false;
      }
    },
    findEnvConnection: async (partnerId: string) => {
      const c = need(partnerId).conn;
      return c ? { ...c } : null;
    },
    insertEnvConnection: async (input: { partnerId: string; name: string; baseUrl: string; apiKey: string | null; model: string }) => {
      const p = need(input.partnerId);
      if (h.failInsert.has(input.partnerId)) throw new Error(`insert exploded for key ${input.apiKey}`);
      p.conn = { id: `conn-${input.partnerId}`, baseUrl: input.baseUrl, configVersion: 1, keyFingerprint: input.apiKey ? fp(input.apiKey) : null, envModel: input.model };
      h.calls.push(`insertConn:${input.partnerId}:${input.name}`);
      return p.conn.id;
    },
    upsertEnvOffering: async (input: { partnerId: string; connectionId: string; model: string; prices: Record<string, number>; enable: boolean }) => {
      const p = need(input.partnerId);
      const existing = p.offerings.find((o) => o.modelId === input.model);
      if (existing) {
        const repriced = JSON.stringify(existing.prices) !== JSON.stringify(input.prices);
        existing.prices = { ...input.prices };
        if (input.enable) existing.enabled = true;
        return { id: existing.id, created: false, repriced, verified: existing.verified };
      }
      const o = { id: `off-${input.model}`, modelId: input.model, enabled: true, verified: false, prices: { ...input.prices } };
      p.offerings.push(o);
      return { id: o.id, created: true, repriced: false, verified: false };
    },
    findConnectionOffering: async (partnerId: string, _connectionId: string, modelId: string) =>
      need(partnerId).offerings.find((o) => o.modelId === modelId)?.id ?? null,
    repointChatDefault: async (input: { partnerId: string; to: string; from: 'platform' | string }) => {
      const p = need(input.partnerId);
      h.calls.push(`repoint:${input.partnerId}:${input.from}->${input.to}`);
      const ok = input.from === 'platform'
        ? p.chat.kind === 'platform' || p.chat.kind === 'none'
        : p.chat.kind === 'offering' && p.chat.id === input.from;
      if (ok) p.chat = { kind: 'offering', id: input.to };
      return ok;
    },
    disableOfferingIfUnused: async (partnerId: string, offeringId: string) => {
      const p = need(partnerId);
      const inUse = (p.chat.kind === 'offering' && p.chat.id === offeringId) || p.otherDefaults.includes(offeringId);
      if (inUse) return false;
      p.offerings.find((o) => o.id === offeringId)!.enabled = false;
      return true;
    },
    setEnvModel: async (partnerId: string, _connectionId: string, model: string) => { need(partnerId).conn!.envModel = model; },
    readoptEnvConnection: async (partnerId: string, connectionId: string) => {
      const c = need(partnerId).conn!;
      if (c.id !== connectionId) throw new Error('readopt of another connection');
      h.calls.push(`readopt:${partnerId}`);
      c.released = false;
    },
    // Release keeps the row (and its key) but marks it released: read-only for the partner.
    releaseEnvManagedConnections: async () => {
      const released: Array<{ id: string; partnerId: string }> = [];
      for (const [partnerId, p] of h.partners) if (p.conn && !p.conn.released) { p.conn.released = true; released.push({ id: p.conn.id, partnerId }); }
      h.released = released.length;
      return released;
    },
    listPartnerIdsWithoutEnvConnection: async () => [...h.partners].filter(([, p]) => p.conn === null).map(([id]) => id),
  };
});

const {
  ENV_BOOTSTRAP_INCOMPLETE_MESSAGE,
  ENV_CONNECTION_NAME,
  ENV_NEW_PARTNER_SYNC_INTERVAL_MS,
  bootstrapEnvOpenAiConnections,
  readEnvOpenAiSettings,
  runEnvOpenAiBootstrapAtBoot,
  runEnvOpenAiBootstrapWithRetry,
  startEnvOpenAiNewPartnerSync,
  syncEnvOpenAiNewPartners,
} = await import('./envOpenAiBootstrap');
const { updateGatewayConnectionLocked } = await import('./gatewayConnections');
const { ByoEndpointRejected } = await import('./gateway/byoEndpointPolicy');
const { MIN_GATEWAY_KEY_LENGTH } = await import('./connections');
const { MCP_LLM_MIN_API_KEY_LENGTH } = await import('../../config/validate');

const SETTINGS = { baseUrl: 'http://10.0.0.5:8000/v1', apiKey: 'sk-env-key-0001', model: 'qwen', inputCentsPerM: 15, outputCentsPerM: 60 };
const PRICES = { inputCentsPerM: 15, outputCentsPerM: 60, cacheReadCentsPerM: 15, cacheWriteCentsPerM: 0 };

function partner(id: string, init: Partial<FakePartner> = {}): void {
  h.partners.set(id, { conn: null, offerings: [], chat: { kind: 'platform' }, otherDefaults: [], ...init });
}
function envConn(over: Partial<FakeConn> & { partnerId: string }): FakeConn {
  return { id: `conn-${over.partnerId}`, baseUrl: SETTINGS.baseUrl, configVersion: 3, keyFingerprint: fp(SETTINGS.apiKey), envModel: SETTINGS.model, ...over };
}
function offering(modelId: string, over: Partial<FakeOffering> = {}): FakeOffering {
  return { id: `off-${modelId}`, modelId, enabled: true, verified: true, prices: { ...PRICES }, ...over };
}

beforeEach(() => {
  h.partners.clear();
  h.calls.length = 0;
  h.failInsert.clear();
  h.hosted = false;
  h.inLock = false;
  h.cutover.mockReset().mockResolvedValue(true);
  h.enqueue.mockReset().mockResolvedValue(undefined);
  h.enqueueOpts.length = 0;
  h.released = 0;
  h.revoked.length = 0;
  h.captured.length = 0;
  h.policy.mockReset().mockImplementation(async (u: string) => u.trim().replace(/\/+$/, ''));
  vi.mocked(updateGatewayConnectionLocked).mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe('readEnvOpenAiSettings', () => {
  it('null unless MCP_LLM_PROVIDER=openai-compatible', () => {
    expect(readEnvOpenAiSettings({ MCP_LLM_PROVIDER: 'anthropic' } as never)).toBeNull();
  });

  it('converts USD/M to cents/M and trims', () => {
    expect(readEnvOpenAiSettings({
      MCP_LLM_PROVIDER: 'openai-compatible', MCP_LLM_BASE_URL: 'http://10.0.0.5:8000/v1/', MCP_LLM_MODEL: ' qwen ',
      MCP_LLM_API_KEY: ' sk-env-key-0001 ', MCP_LLM_PRICE_INPUT_PER_M_USD: 0.15, MCP_LLM_PRICE_OUTPUT_PER_M_USD: 0.6,
    } as never)).toEqual({ baseUrl: 'http://10.0.0.5:8000/v1', apiKey: 'sk-env-key-0001', model: 'qwen', inputCentsPerM: 15, outputCentsPerM: 60 });
  });

  it('an empty key means keyless', () => {
    expect(readEnvOpenAiSettings({
      MCP_LLM_PROVIDER: 'openai-compatible', MCP_LLM_BASE_URL: 'http://10.0.0.5:8000/v1', MCP_LLM_MODEL: 'qwen',
      MCP_LLM_API_KEY: '  ', MCP_LLM_PRICE_INPUT_PER_M_USD: 0, MCP_LLM_PRICE_OUTPUT_PER_M_USD: 0,
    } as never)?.apiKey).toBeNull();
  });

  it('config validation and the gateway agree on the minimum key length', () => {
    expect(MCP_LLM_MIN_API_KEY_LENGTH).toBe(MIN_GATEWAY_KEY_LENGTH);
  });
});

describe('bootstrapEnvOpenAiConnections', () => {
  it('first boot: creates connection + priced enabled offering, enqueues verification after commit, re-points chat only from a platform default', async () => {
    partner('p1', { chat: { kind: 'platform' } });
    partner('p2', { chat: { kind: 'offering', id: 'byok-offering' } });
    const r = await bootstrapEnvOpenAiConnections({ settings: SETTINGS });
    expect(r).toMatchObject({ partners: 2, created: 2, resynced: 0, chatRepointed: 1, failed: [], error: null });
    expect(h.calls).toContain(`insertConn:p1:${ENV_CONNECTION_NAME}`);
    expect(h.partners.get('p1')!.chat).toEqual({ kind: 'offering', id: 'off-qwen' });
    expect(h.partners.get('p2')!.chat).toEqual({ kind: 'offering', id: 'byok-offering' });
    expect(h.partners.get('p1')!.offerings).toEqual([expect.objectContaining({ modelId: 'qwen', enabled: true, prices: PRICES })]);
    expect(h.enqueue.mock.calls.map(([a]) => a)).toEqual([
      { offeringId: 'off-qwen', partnerId: 'p1' },
      { offeringId: 'off-qwen', partnerId: 'p2' },
    ]);
    // ids-only payload, after every transaction committed, never inside one.
    expect(h.calls.filter((c) => c.startsWith('enqueue:')).every((c) => c.endsWith(':after'))).toBe(true);
    expect(h.calls.indexOf('enqueue:off-qwen:after')).toBeGreaterThan(h.calls.lastIndexOf('lock:p2'));
  });

  it('a partner with no chat default at all is routed to the env offering (legacy env routing served it)', async () => {
    partner('p1', { chat: { kind: 'none' } });
    expect(await bootstrapEnvOpenAiConnections({ settings: SETTINGS })).toMatchObject({ created: 1, chatRepointed: 1 });
  });

  it('validates the base URL once, outside any partner transaction, before any partner work', async () => {
    partner('p1');
    partner('p2');
    await bootstrapEnvOpenAiConnections({ settings: SETTINGS });
    expect(h.calls.filter((c) => c.startsWith('validate:'))).toEqual(['validate:outside']);
    expect(h.calls[0]).toBe('validate:outside');
  });

  it('a base URL refused by policy fails every partner, records why, writes nothing', async () => {
    partner('p1');
    h.policy.mockRejectedValue(new ByoEndpointRejected('That host is not reachable from Breeze (loopback, link-local and metadata addresses are never allowed).', 'egress_blocked'));
    const r = await bootstrapEnvOpenAiConnections({ settings: { ...SETTINGS, baseUrl: 'http://127.0.0.1:8000/v1' } });
    expect(r.created).toBe(0);
    expect(r.failed).toEqual(['p1']);
    expect(r.error).toMatch(/^MCP_LLM_BASE_URL refused: That host is not reachable/);
    expect(h.calls.some((c) => c.startsWith('lock:') || c.startsWith('cutover:'))).toBe(false);
  });

  it('the stored URL is the policy-normalised one, and is what later boots compare against', async () => {
    partner('p1');
    h.policy.mockResolvedValue('http://10.0.0.5:8000/v1');
    await bootstrapEnvOpenAiConnections({ settings: { ...SETTINGS, baseUrl: 'http://10.0.0.5:8000/v1/' } });
    expect(h.partners.get('p1')!.conn!.baseUrl).toBe('http://10.0.0.5:8000/v1');
    const again = await bootstrapEnvOpenAiConnections({ settings: { ...SETTINGS, baseUrl: 'http://10.0.0.5:8000/v1/' } });
    expect(again).toMatchObject({ created: 0, resynced: 0 });
  });

  it('second boot with the same env: no creates, no re-point, no writes (admin choices respected)', async () => {
    partner('p1', { conn: envConn({ partnerId: 'p1' }), offerings: [offering('qwen', { enabled: false })], chat: { kind: 'platform' } });
    const r = await bootstrapEnvOpenAiConnections({ settings: SETTINGS });
    expect(r).toMatchObject({ created: 0, resynced: 0, chatRepointed: 0 });
    expect(h.calls.some((c) => c.startsWith('repoint:'))).toBe(false);
    expect(updateGatewayConnectionLocked).not.toHaveBeenCalled();
    // The admin disabled it; a steady-state boot does not re-enable it.
    expect(h.partners.get('p1')!.offerings[0]!.enabled).toBe(false);
    expect(h.partners.get('p1')!.chat).toEqual({ kind: 'platform' });
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('steady state but never verified (e.g. a lost enqueue) → verification re-enqueued, nothing else', async () => {
    partner('p1', { conn: envConn({ partnerId: 'p1' }), offerings: [offering('qwen', { verified: false })] });
    const r = await bootstrapEnvOpenAiConnections({ settings: SETTINGS });
    expect(r).toMatchObject({ created: 0, resynced: 0 });
    expect(h.enqueue).toHaveBeenCalledWith({ offeringId: 'off-qwen', partnerId: 'p1' });
  });

  it('changed base URL → updateGatewayConnectionLocked(allowManaged, expected version) and re-verification', async () => {
    partner('p1', { conn: envConn({ partnerId: 'p1', baseUrl: 'http://10.0.0.9:8000/v1' }), offerings: [offering('qwen')] });
    const r = await bootstrapEnvOpenAiConnections({ settings: SETTINGS });
    // The configured key always travels with a new URL: the stored one never follows it.
    expect(updateGatewayConnectionLocked).toHaveBeenCalledWith({
      partnerId: 'p1', connectionId: 'conn-p1', baseUrl: SETTINGS.baseUrl, apiKey: SETTINGS.apiKey, expectedConfigVersion: 3, allowManaged: true,
    });
    expect(r).toMatchObject({ resynced: 1, chatRepointed: 0 });
    expect(h.enqueue).toHaveBeenCalledWith({ offeringId: 'off-qwen', partnerId: 'p1' });
  });

  it('rotated key → key rewritten (fingerprint compare), base URL untouched', async () => {
    partner('p1', { conn: envConn({ partnerId: 'p1', keyFingerprint: fp('old-key') }), offerings: [offering('qwen')] });
    await bootstrapEnvOpenAiConnections({ settings: SETTINGS });
    expect(updateGatewayConnectionLocked).toHaveBeenCalledWith({
      partnerId: 'p1', connectionId: 'conn-p1', apiKey: SETTINGS.apiKey, expectedConfigVersion: 3, allowManaged: true,
    });
  });

  it('key removed from env → stored key cleared (keyless)', async () => {
    partner('p1', { conn: envConn({ partnerId: 'p1' }), offerings: [offering('qwen')] });
    await bootstrapEnvOpenAiConnections({ settings: { ...SETTINGS, apiKey: null } });
    expect(updateGatewayConnectionLocked).toHaveBeenCalledWith(expect.objectContaining({ apiKey: null, allowManaged: true }));
    expect(h.partners.get('p1')!.conn!.keyFingerprint).toBeNull();
  });

  it('changed prices → offering re-priced (resynced), no re-verification', async () => {
    partner('p1', { conn: envConn({ partnerId: 'p1' }), offerings: [offering('qwen')] });
    const r = await bootstrapEnvOpenAiConnections({ settings: { ...SETTINGS, inputCentsPerM: 20 } });
    expect(r).toMatchObject({ resynced: 1 });
    expect(h.partners.get('p1')!.offerings[0]!.prices).toMatchObject({ inputCentsPerM: 20, cacheReadCentsPerM: 20 });
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('changed model → new enabled offering; chat moved only where it was exactly the old env offering; old one disabled', async () => {
    partner('p1', { conn: envConn({ partnerId: 'p1', envModel: 'old' }), offerings: [offering('old')], chat: { kind: 'offering', id: 'off-old' } });
    partner('p2', { conn: envConn({ partnerId: 'p2', envModel: 'old' }), offerings: [offering('old')], chat: { kind: 'offering', id: 'admin-choice' } });
    const r = await bootstrapEnvOpenAiConnections({ settings: SETTINGS });
    expect(r).toMatchObject({ resynced: 2, chatRepointed: 1, created: 0 });
    expect(h.partners.get('p1')!.chat).toEqual({ kind: 'offering', id: 'off-qwen' });
    expect(h.partners.get('p2')!.chat).toEqual({ kind: 'offering', id: 'admin-choice' });
    for (const id of ['p1', 'p2']) {
      const offs = h.partners.get(id)!.offerings;
      expect(offs.find((o) => o.modelId === 'old')!.enabled).toBe(false);
      expect(offs.find((o) => o.modelId === 'qwen')!.enabled).toBe(true);
      expect(h.partners.get(id)!.conn!.envModel).toBe('qwen');
    }
    expect(h.enqueue).toHaveBeenCalledTimes(2);
  });

  it('changed model: the old env offering stays enabled while another surface still defaults to it', async () => {
    partner('p1', { conn: envConn({ partnerId: 'p1', envModel: 'old' }), offerings: [offering('old')], otherDefaults: ['off-old'] });
    await bootstrapEnvOpenAiConnections({ settings: SETTINGS });
    expect(h.partners.get('p1')!.offerings.find((o) => o.modelId === 'old')!.enabled).toBe(true);
  });

  it('changed model never disables other (discovered, admin-enabled) offerings on the env connection', async () => {
    partner('p1', { conn: envConn({ partnerId: 'p1', envModel: 'old' }), offerings: [offering('old'), offering('llama', { enabled: true })] });
    await bootstrapEnvOpenAiConnections({ settings: SETTINGS });
    expect(h.partners.get('p1')!.offerings.find((o) => o.modelId === 'llama')!.enabled).toBe(true);
  });

  it('A -> B -> A: chat follows the configured model back to A and B is disabled (Codex review #14)', async () => {
    partner('p1', {
      conn: envConn({ partnerId: 'p1', envModel: 'B' }),
      offerings: [offering('A', { enabled: false }), offering('B')],
      chat: { kind: 'offering', id: 'off-B' },
    });
    await bootstrapEnvOpenAiConnections({ settings: { ...SETTINGS, model: 'A' } });
    expect(h.calls).toContain('repoint:p1:off-B->off-A');
    const offs = h.partners.get('p1')!.offerings;
    expect(offs.find((o) => o.modelId === 'A')!.enabled).toBe(true);
    expect(offs.find((o) => o.modelId === 'B')!.enabled).toBe(false);
  });

  it('one partner failing does not stop the others; report lists it with a reason; its writes roll back', async () => {
    partner('p1');
    partner('p2');
    h.failInsert.add('p1');
    const r = await bootstrapEnvOpenAiConnections({ settings: SETTINGS });
    expect(r.failed).toEqual(['p1']);
    expect(r.failures).toEqual([{ partnerId: 'p1', reason: expect.any(String) }]);
    expect(r.created).toBe(1);
    expect(h.partners.get('p1')!.conn).toBeNull();
    expect(h.enqueue).toHaveBeenCalledTimes(1);
  });

  it('a failed enqueue is reported, never thrown, and other partners are still enqueued', async () => {
    partner('p1');
    partner('p2');
    h.enqueue.mockRejectedValueOnce(new Error('redis down'));
    const r = await bootstrapEnvOpenAiConnections({ settings: SETTINGS });
    expect(h.enqueue).toHaveBeenCalledTimes(2);
    expect(r.created).toBe(2);
    expect(r.verificationEnqueueFailed).toBe(1);
  });

  it('job payload / logs carry no key', async () => {
    const SECRET = 'sk-env-SECRET-999';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    partner('p1', { chat: { kind: 'platform' } });
    partner('p2');
    h.failInsert.add('p2');   // its error message embeds the key (worst case)
    const r = await bootstrapEnvOpenAiConnections({ settings: { ...SETTINGS, apiKey: SECRET } });
    expect(r.created).toBe(1);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    const everything = JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls, h.enqueue.mock.calls, r]);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(SECRET.slice(-12));
    for (const [payload] of h.enqueue.mock.calls) expect(Object.keys(payload).sort()).toEqual(['offeringId', 'partnerId']);
  });

  it('runs only after the partner cutover; a partner whose cutover fails is reported, not bootstrapped (Codex review #4)', async () => {
    partner('p1', { chat: { kind: 'platform' } });
    h.cutover.mockResolvedValue(false);
    expect(await bootstrapEnvOpenAiConnections({ settings: SETTINGS })).toMatchObject({ created: 0, failed: ['p1'] });
    expect(h.calls.some((c) => c.startsWith('lock:'))).toBe(false);
  });

  it('cutover precedes the partner lock for every partner', async () => {
    partner('p1');
    partner('p2');
    await bootstrapEnvOpenAiConnections({ settings: SETTINGS });
    for (const id of ['p1', 'p2']) expect(h.calls.indexOf(`cutover:${id}`)).toBeLessThan(h.calls.indexOf(`lock:${id}`));
  });

  it('variables unset → env-managed connections are released (managedBy cleared), nothing created or deleted, no per-partner work', async () => {
    partner('p1', { conn: envConn({ partnerId: 'p1' }), offerings: [offering('qwen')] });
    const r = await bootstrapEnvOpenAiConnections({ settings: null });
    expect(r).toMatchObject({ released: 1, created: 0 });
    expect(h.calls.some((c) => c.startsWith('cutover:') || c.startsWith('lock:') || c.startsWith('validate:'))).toBe(false);
  });

  it('variables unset → the connection is kept but marked released (not handed to the partner as an editable one)', async () => {
    partner('p1', { conn: envConn({ partnerId: 'p1' }), offerings: [offering('qwen')] });
    await bootstrapEnvOpenAiConnections({ settings: null });
    expect(h.partners.get('p1')!.conn).toMatchObject({ id: 'conn-p1', released: true });
    // A second unset boot releases nothing new.
    expect(await bootstrapEnvOpenAiConnections({ settings: null })).toMatchObject({ released: 0 });
  });

  it('variables set again → the released connection is re-adopted (same id), chat is NOT re-pointed again', async () => {
    partner('p1', {
      conn: envConn({ partnerId: 'p1', released: true }), offerings: [offering('qwen')],
      chat: { kind: 'platform' },   // the admin moved chat back to a platform model meanwhile
    });
    const r = await bootstrapEnvOpenAiConnections({ settings: SETTINGS });
    expect(r).toMatchObject({ created: 0, chatRepointed: 0 });
    expect(h.calls).toContain('readopt:p1');
    expect(h.calls.some((c) => c.startsWith('repoint:'))).toBe(false);
    expect(h.calls.some((c) => c.startsWith('insertConn:'))).toBe(false);
    expect(h.partners.get('p1')!.conn).toMatchObject({ id: 'conn-p1', released: false });
    expect(h.partners.get('p1')!.chat).toEqual({ kind: 'platform' });
  });

  it('re-adopting with a new URL re-syncs URL and key together', async () => {
    partner('p1', { conn: envConn({ partnerId: 'p1', released: true, baseUrl: 'http://10.0.0.9:8000/v1' }), offerings: [offering('qwen')] });
    await bootstrapEnvOpenAiConnections({ settings: SETTINGS });
    expect(updateGatewayConnectionLocked).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: SETTINGS.baseUrl, apiKey: SETTINGS.apiKey, allowManaged: true,
    }));
  });

  it('refuses to run on hosted even if validation was bypassed (defense in depth)', async () => {
    partner('p1');
    h.hosted = true;
    const r = await bootstrapEnvOpenAiConnections({ settings: SETTINGS });
    expect(r.created).toBe(0);
    expect(r.error).toMatch(/hosted/i);
    expect(h.calls).toEqual([]);
  });

  it('the env path enqueues verification with a delayed retry (a failed run is often a still-loading endpoint)', async () => {
    partner('p1');
    await bootstrapEnvOpenAiConnections({ settings: SETTINGS });
    expect(h.enqueue).toHaveBeenCalledWith({ offeringId: 'off-qwen', partnerId: 'p1' });
    expect(h.enqueueOpts).toEqual([{ retryFailed: true }]);
  });

  it('a URL or key re-sync revokes the connection\'s live gateway grants, after the partner transaction', async () => {
    partner('p1', { conn: envConn({ partnerId: 'p1', baseUrl: 'http://10.0.0.9:8000/v1' }), offerings: [offering('qwen')] });
    partner('p2', { conn: envConn({ partnerId: 'p2', keyFingerprint: fp('old-key') }), offerings: [offering('qwen')] });
    await bootstrapEnvOpenAiConnections({ settings: SETTINGS });
    expect(h.calls.filter((c) => c.startsWith('revoke:'))).toEqual(['revoke:conn-p1:after', 'revoke:conn-p2:after']);
  });

  it('a steady-state, re-priced or model-only boot revokes nothing', async () => {
    partner('p1', { conn: envConn({ partnerId: 'p1' }), offerings: [offering('qwen')] });
    partner('p2', { conn: envConn({ partnerId: 'p2', envModel: 'old' }), offerings: [offering('old')] });
    await bootstrapEnvOpenAiConnections({ settings: { ...SETTINGS, inputCentsPerM: 99 } });
    expect(h.revoked).toEqual([]);
  });

  it('release changes no routing field, so it revokes nothing (chat keeps working)', async () => {
    partner('p1', { conn: envConn({ partnerId: 'p1' }), offerings: [offering('qwen')] });
    expect(await bootstrapEnvOpenAiConnections({ settings: null })).toMatchObject({ released: 1 });
    expect(h.revoked).toEqual([]);
  });

  it('partnerIds scopes the run (test seam)', async () => {
    partner('p1');
    partner('p2');
    const r = await bootstrapEnvOpenAiConnections({ settings: SETTINGS, partnerIds: ['p2'] });
    expect(r).toMatchObject({ partners: 1, created: 1 });
    expect(h.partners.get('p1')!.conn).toBeNull();
  });
});

describe('runEnvOpenAiBootstrapWithRetry', () => {
  const ok = { partners: 1, created: 0, resynced: 0, chatRepointed: 0, released: 0, failed: [], failures: [], error: null, verificationEnqueueFailed: 0 };

  it('stops after a clean run', async () => {
    const bootstrap = vi.fn(async () => ok);
    const sleep = vi.fn(async () => {});
    await runEnvOpenAiBootstrapWithRetry({ bootstrap, sleep, retryDelaysMs: [10, 20] });
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a run with failures (e.g. endpoint DNS not up yet) on the bounded schedule', async () => {
    const bootstrap = vi.fn()
      .mockResolvedValueOnce({ ...ok, failed: ['p1'], failures: [{ partnerId: 'p1', reason: 'x' }] })
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(ok);
    const sleep = vi.fn(async () => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await runEnvOpenAiBootstrapWithRetry({ bootstrap, sleep, retryDelaysMs: [10, 20, 30] });
    expect(bootstrap).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[10], [20]]);
    expect(r).toEqual(ok);
  });

  it('gives up after the last delay', async () => {
    const bad = { ...ok, error: 'MCP_LLM_BASE_URL refused: x' };
    const bootstrap = vi.fn(async () => bad);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runEnvOpenAiBootstrapWithRetry({ bootstrap, sleep: async () => {}, retryDelaysMs: [1] });
    expect(bootstrap).toHaveBeenCalledTimes(2);
  });
});

describe('syncEnvOpenAiNewPartners (partners created after boot)', () => {
  it('bootstraps only partners without a live env connection', async () => {
    partner('old', { conn: envConn({ partnerId: 'old' }), offerings: [offering('qwen')] });
    partner('new', { chat: { kind: 'platform' } });
    const r = await syncEnvOpenAiNewPartners({ settings: SETTINGS });
    expect(r).toMatchObject({ partners: 1, created: 1, chatRepointed: 1 });
    expect(h.calls.filter((c) => c.startsWith('lock:'))).toEqual(['lock:new']);
    expect(h.partners.get('new')!.conn).not.toBeNull();
  });

  it('does nothing when every partner has its connection, when the variables are unset, or on hosted', async () => {
    partner('old', { conn: envConn({ partnerId: 'old' }), offerings: [offering('qwen')] });
    expect(await syncEnvOpenAiNewPartners({ settings: SETTINGS })).toBeNull();
    partner('new');
    expect(await syncEnvOpenAiNewPartners({ settings: null })).toBeNull();
    h.hosted = true;
    expect(await syncEnvOpenAiNewPartners({ settings: SETTINGS })).toBeNull();
    expect(h.calls).toEqual([]);
    expect(h.released).toBe(0);
  });

  it('runs on an interval (every 10 minutes), never overlapping itself', async () => {
    vi.useFakeTimers();
    try {
      expect(ENV_NEW_PARTNER_SYNC_INTERVAL_MS).toBe(10 * 60_000);
      let finish!: () => void;
      const run = vi.fn(() => new Promise<null>((resolve) => { finish = () => resolve(null); }));
      const stop = startEnvOpenAiNewPartnerSync({ run, intervalMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3_000);   // still running: skipped
      expect(run).toHaveBeenCalledTimes(1);
      finish();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(run).toHaveBeenCalledTimes(2);
      stop();
      finish();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a throwing run is logged and the interval keeps going', async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const run = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(null);
      const stop = startEnvOpenAiNewPartnerSync({ run, intervalMs: 1_000 });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(run).toHaveBeenCalledTimes(2);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('runEnvOpenAiBootstrapAtBoot', () => {
  const ok = { partners: 1, created: 0, resynced: 0, chatRepointed: 0, released: 0, failed: [], failures: [], error: null, verificationEnqueueFailed: 0 };

  it.each([
    ['a run-wide error', { ...ok, error: 'MCP_LLM_BASE_URL refused: x' }],
    ['failed partners', { ...ok, failed: ['p1'], failures: [{ partnerId: 'p1', reason: 'sk-env-key-0001 broke' }] }],
    ['a lost verification enqueue', { ...ok, verificationEnqueueFailed: 1 }],
    ['every attempt throwing', null],
  ])('captures ONE fixed-message exception when the retried bootstrap ends incomplete (%s)', async (_label, report) => {
    await runEnvOpenAiBootstrapAtBoot({ runWithRetry: async () => report as never, startNewPartnerSync: () => () => {}, settings: SETTINGS });
    expect(h.captured).toHaveLength(1);
    expect((h.captured[0]!.error as Error).message).toBe(ENV_BOOTSTRAP_INCOMPLETE_MESSAGE);
    expect(h.captured[0]!.tags).toEqual({ area: 'ai_env_openai_bootstrap' });
    expect(JSON.stringify(h.captured)).not.toContain(SETTINGS.apiKey);
  });

  it('a clean run captures nothing and starts the new-partner sync', async () => {
    const start = vi.fn(() => () => {});
    await runEnvOpenAiBootstrapAtBoot({ runWithRetry: async () => ok, startNewPartnerSync: start, settings: SETTINGS });
    expect(h.captured).toEqual([]);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('no new-partner sync when the variables are unset or on hosted', async () => {
    const start = vi.fn(() => () => {});
    await runEnvOpenAiBootstrapAtBoot({ runWithRetry: async () => ok, startNewPartnerSync: start, settings: null });
    h.hosted = true;
    await runEnvOpenAiBootstrapAtBoot({ runWithRetry: async () => ok, startNewPartnerSync: start, settings: SETTINGS });
    expect(start).not.toHaveBeenCalled();
  });
});

describe('boot wiring', () => {
  const code = (rel: string) => readFileSync(join(__dirname, '../..', rel), 'utf8')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

  it('index.ts starts the env bootstrap detached; the W03 cutover sweep is gone (W08: partners are bootstrapped inside it)', () => {
    const text = code('index.ts');
    const bootAt = text.search(/void runEnvOpenAiBootstrapAtBoot\(\)/);
    expect(text).not.toMatch(/runRegistryCutoverSweep/);
    expect(bootAt).toBeGreaterThan(-1);
    expect(text).not.toMatch(/await (runEnvOpenAiBootstrapAtBoot|runEnvOpenAiBootstrapWithRetry|bootstrapEnvOpenAiConnections)\(/);
  });

  it('API and worker boot register the gateway connection check', () => {
    expect(code('index.ts')).toMatch(/registerGatewayConnectionCheck\(\)/);
    expect(code('worker.ts')).toMatch(/registerGatewayConnectionCheck\(\)/);
  });
});
