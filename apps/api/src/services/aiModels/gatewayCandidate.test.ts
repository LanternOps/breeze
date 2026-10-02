import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  getConnectionKeyMaterial: vi.fn(),
  getConnection: vi.fn(),
  decryptConnectionKey: vi.fn(),
  captureException: vi.fn(),
}));
vi.mock('../sentry', () => ({ captureException: m.captureException }));
vi.mock('../../db', () => ({
  db: {},
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('./connections', () => ({
  getConnectionKeyMaterial: m.getConnectionKeyMaterial,
  getConnection: m.getConnection,
  decryptConnectionKey: m.decryptConnectionKey,
}));

import { FIDELITY_HARNESS_VERSION } from '../llm/providerFidelityHarness';
import { checkEligibility, type EligibilityContext } from './eligibility';
import { endpointFingerprint, verifiedCapabilitiesTree } from './gatewayCapabilities';
import { gatewayCandidate } from './gatewayCandidate';

const CONN = {
  id: 'c1', partnerId: 'p1', kind: 'openai_compatible', name: 'vLLM', baseUrl: 'https://llm.example.com/v1',
  providerConfig: null, status: 'active', configVersion: 4, inferenceGeo: null, catalogEntryId: null,
};
const conn = (over: Record<string, unknown> = {}) => ({ ...CONN, ...over }) as never;
/** The routing fields read in the same row read as the key. */
const ROUTING = { kind: CONN.kind, baseUrl: CONN.baseUrl, configVersion: CONN.configVersion };
const verified = verifiedCapabilitiesTree({
  harnessVersion: FIDELITY_HARNESS_VERSION, endpointFingerprint: endpointFingerprint(CONN),
  at: '2026-11-23T00:00:00.000Z', passed: true, toolUse: true, adaptiveEffort: false, summary: null,
}, null);
const offering = (over: Record<string, unknown> = {}) => ({
  id: 'o1', partnerId: 'p1', connectionId: 'c1', platformModelId: null, modelId: 'qwen2.5-coder:7b',
  source: 'discovered', displayName: null, capabilities: verified, priceInputCentsPerM: 0, priceOutputCentsPerM: 0,
  priceCacheReadCentsPerM: 0, priceCacheWriteCentsPerM: 0, enabled: true, defaultOptions: null, allowedOptions: null,
  requiredPermission: null, refusalFallbackOfferingId: null, lifecycle: 'available', ...over,
}) as never;

const CTX: EligibilityContext = {
  partnerId: 'p1', surface: 'chat', partnerPlan: 'pro', hosted: true, residencyRequired: false,
  geoCarriable: true, userInitiated: false, userHoldsPermission: () => false,
};

beforeEach(() => {
  vi.clearAllMocks();
  m.getConnectionKeyMaterial.mockResolvedValue({ ...ROUTING, id: 'c1', partnerId: 'p1', status: 'active', apiKeyEncrypted: 'enc:x' });
  m.decryptConnectionKey.mockReturnValue('sk-local');
});

describe('gatewayCandidate', () => {
  it('verified, priced (0 is a price) openai offering → dispatchable gateway candidate, partner_key, tools', async () => {
    const c = await gatewayCandidate({ offering: offering(), conn: conn() });
    expect(c.funding).toBe('partner_key');
    expect(c.wireModel).toBe('qwen2.5-coder:7b');
    expect(c.logicalModel).toBe('qwen2.5-coder:7b');
    expect(c.displayName).toBe('qwen2.5-coder:7b');
    expect(c.offeringId).toBe('o1');
    expect(c.connectionId).toBe('c1');
    expect(c.configVersion).toBe(4);
    expect(c.facts).toMatchObject({
      ownerPartnerId: 'p1', platform: null, catalog: null,
      connection: { kind: 'openai_compatible', status: 'active', keyUsable: true }, supportsTools: true,
      rate: { source: 'offering', standard: { inputCentsPerM: 0, outputCentsPerM: 0, cacheReadCentsPerM: 0, cacheWriteCentsPerM: 0 } },
      inferenceGeo: null, supportedInferenceGeos: [],
    });
    expect(c.connection).toEqual({
      id: 'c1', kind: 'openai_compatible',
      config: { source: 'gateway', kind: 'openai_compatible', partnerId: 'p1', connectionId: 'c1', configVersion: 4, baseUrl: 'https://llm.example.com/v1' },
      credential: { secret: 'sk-local' },
    });
    expect(c.capabilities).toEqual({ thinkingMode: 'none', effortLevels: [], supportsTools: true, supportsVision: false });
    expect(c.optionSupport.effort).toEqual([]);
    expect(c.optionSupport.inferenceGeo).toEqual([]);
    expect(c.optionRates).toBeNull();
    expect(c.promptProfile).toBe('generic');
    expect(c.limits).toEqual({ maxInputTokens: null, maxOutputTokens: null });
    expect(checkEligibility(c.facts, CTX)).toBeNull();
  });

  it('keyless connection (active, NULL key) is usable with a null secret; no decrypt attempted', async () => {
    m.getConnectionKeyMaterial.mockResolvedValue({ ...ROUTING, id: 'c1', partnerId: 'p1', status: 'active', apiKeyEncrypted: null });
    const c = await gatewayCandidate({ offering: offering(), conn: conn() });
    expect(c.facts.connection.keyUsable).toBe(true);
    expect(c.connection).toMatchObject({ credential: { secret: null } });
    expect(m.decryptConnectionKey).not.toHaveBeenCalled();
  });

  it.each([null, '', '   '])('an offering with no wire model id (%j) is unusable: never dispatched with an empty model', async (modelId) => {
    const c = await gatewayCandidate({ offering: offering({ modelId }), conn: conn() });
    expect(c.connection).toBeNull();
    expect(c.facts.connection.keyUsable).toBe(false);
    expect(checkEligibility(c.facts, CTX)).toBe('connection_unavailable');
  });

  it('a DISCONNECTED connection (NULL key by constraint) is never read as keyless-and-usable', async () => {
    m.getConnectionKeyMaterial.mockResolvedValue({ ...ROUTING, id: 'c1', partnerId: 'p1', status: 'disconnected', apiKeyEncrypted: null });
    const c = await gatewayCandidate({ offering: offering(), conn: conn({ status: 'disconnected' }) });
    expect(c.facts.connection).toEqual({ kind: 'openai_compatible', status: 'disconnected', keyUsable: false });
    expect(c.connection).toBeNull();
    expect(checkEligibility(c.facts, CTX)).toBe('connection_unavailable');
  });

  it('disconnected between the connection read and the key read: the key row status wins (no keyless race)', async () => {
    m.getConnectionKeyMaterial.mockResolvedValue({ ...ROUTING, id: 'c1', partnerId: 'p1', status: 'disconnected', apiKeyEncrypted: null });
    const c = await gatewayCandidate({ offering: offering(), conn: conn() });
    expect(c.facts.connection.keyUsable).toBe(false);
    expect(c.connection).toBeNull();
    expect(checkEligibility(c.facts, CTX)).toBe('connection_unavailable');
  });

  it('a non-active (error) connection is unusable even with a decryptable key', async () => {
    m.getConnectionKeyMaterial.mockResolvedValue({ ...ROUTING, id: 'c1', partnerId: 'p1', status: 'error', apiKeyEncrypted: 'enc:x' });
    const c = await gatewayCandidate({ offering: offering(), conn: conn({ status: 'error' }) });
    expect(c.facts.connection.keyUsable).toBe(false);
    expect(c.connection).toBeNull();
    expect(m.decryptConnectionKey).not.toHaveBeenCalled();
  });

  it('a missing key row makes the connection unusable', async () => {
    m.getConnectionKeyMaterial.mockResolvedValue(null);
    const c = await gatewayCandidate({ offering: offering(), conn: conn() });
    expect(c.facts.connection.keyUsable).toBe(false);
    expect(c.connection).toBeNull();
  });

  it('a stored key that fails to decrypt makes the connection unusable (and no connection object); secret never in logs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    m.decryptConnectionKey.mockImplementation(() => { throw new Error('bad aad'); });
    const c = await gatewayCandidate({ offering: offering(), conn: conn() });
    expect(c.facts.connection.keyUsable).toBe(false);
    expect(c.connection).toBeNull();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('enc:x');
    warn.mockRestore();
  });

  it('a key LOOKUP failure is infrastructure: it throws, scrubbed (never reported as a dead key)', async () => {
    m.getConnectionKeyMaterial.mockRejectedValue(new Error('connection terminated'));
    await expect(gatewayCandidate({ offering: offering(), conn: conn() })).rejects.toThrow(/key lookup failed/);
  });

  it('unpriced offering → rate null (eligibility says unpriced); no linked-platform inheritance', async () => {
    const c = await gatewayCandidate({
      offering: offering({ platformModelId: 'pm-1', priceInputCentsPerM: null }), conn: conn(),
    });
    expect(c.facts.rate).toBeNull();
    expect(checkEligibility(c.facts, CTX)).toBe('unpriced');
  });

  it('unverified offering → no tools, unknown thinking (tools_unsupported keeps it off tool surfaces)', async () => {
    const c = await gatewayCandidate({ offering: offering({ capabilities: null }), conn: conn() });
    expect(c.facts.supportsTools).toBe(false);
    expect(c.capabilities).toEqual({ thinkingMode: 'unknown', effortLevels: [], supportsTools: false, supportsVision: false });
    expect(checkEligibility(c.facts, CTX)).toBe('tools_unsupported');
    expect(checkEligibility(c.facts, { ...CTX, surface: 'catalog_enrichment' })).toBeNull();
  });

  it('a verification for a different base URL is stale → unverified', async () => {
    m.getConnectionKeyMaterial.mockResolvedValue({ ...ROUTING, id: 'c1', partnerId: 'p1', status: 'active', apiKeyEncrypted: 'enc:x', baseUrl: 'https://other.example.com/v1' });
    const c = await gatewayCandidate({ offering: offering(), conn: conn({ baseUrl: 'https://other.example.com/v1' }) });
    expect(c.facts.supportsTools).toBe(false);
    expect(c.connection).toMatchObject({ config: { baseUrl: 'https://other.example.com/v1' } });
  });

  it('openai_compatible never claims thinking, even from a verification that says adaptiveEffort', async () => {
    const tree = verifiedCapabilitiesTree({
      harnessVersion: FIDELITY_HARNESS_VERSION, endpointFingerprint: endpointFingerprint(CONN),
      at: '2026-11-23T00:00:00.000Z', passed: true, toolUse: true, adaptiveEffort: true, summary: null,
    }, { thinking: { types: { adaptive: { supported: true } } }, effort: { supported: true, high: { supported: true } } });
    const c = await gatewayCandidate({ offering: offering({ capabilities: tree }), conn: conn() });
    expect(c.capabilities).toMatchObject({ thinkingMode: 'none', effortLevels: [], supportsTools: true });
    expect(c.optionSupport.effort).toEqual([]);
  });

  it('never inherits the connection inference geo (D7): residency required → residency_unavailable', async () => {
    const c = await gatewayCandidate({ offering: offering(), conn: conn({ inferenceGeo: 'eu' }) });
    expect(c.facts.inferenceGeo).toBeNull();
    expect(checkEligibility(c.facts, { ...CTX, residencyRequired: true })).toBe('residency_unavailable');
  });

  it('uses the offering display name when set', async () => {
    const c = await gatewayCandidate({ offering: offering({ displayName: 'Qwen Coder' }), conn: conn() });
    expect(c.displayName).toBe('Qwen Coder');
  });

  describe('routing snapshot read with the key', () => {
    const NEW_URL = 'https://attacker.example.net/v1';

    it('an endpoint+key change between the connection read and the key read never pairs the new key with the old URL', async () => {
      // The key row reflects a concurrent update: new URL, new version, new key.
      m.getConnectionKeyMaterial.mockResolvedValue({
        id: 'c1', partnerId: 'p1', status: 'active', apiKeyEncrypted: 'enc:new', kind: 'openai_compatible', baseUrl: NEW_URL, configVersion: 5,
      });
      // The re-read finds the connection still changing (another bump).
      m.getConnection.mockResolvedValue({ ...CONN, baseUrl: NEW_URL, configVersion: 6 });
      m.decryptConnectionKey.mockReturnValue('sk-new-key');
      const c = await gatewayCandidate({ offering: offering(), conn: conn() });
      expect(c.connection).toBeNull();
      expect(c.facts.connection.keyUsable).toBe(false);
      expect(m.decryptConnectionKey).not.toHaveBeenCalled();
    });

    it('retries the resolution once from a fresh connection read: the credential travels with the URL it was read with', async () => {
      m.getConnectionKeyMaterial
        .mockResolvedValueOnce({ id: 'c1', partnerId: 'p1', status: 'active', apiKeyEncrypted: 'enc:new', kind: 'openai_compatible', baseUrl: NEW_URL, configVersion: 5 })
        .mockResolvedValueOnce({ id: 'c1', partnerId: 'p1', status: 'active', apiKeyEncrypted: 'enc:new', kind: 'openai_compatible', baseUrl: NEW_URL, configVersion: 5 });
      m.getConnection.mockResolvedValue({ ...CONN, baseUrl: NEW_URL, configVersion: 5 });
      m.decryptConnectionKey.mockReturnValue('sk-new-key');
      const c = await gatewayCandidate({ offering: offering(), conn: conn() });
      expect(c.connection).toMatchObject({ config: { baseUrl: NEW_URL, configVersion: 5 }, credential: { secret: 'sk-new-key' } });
      expect(c.configVersion).toBe(5);
      expect(m.getConnection).toHaveBeenCalledTimes(1);
    });

    it('loadGatewayCredential refuses a key read whose config_version or base URL differs from the connection it was given', async () => {
      const { loadGatewayCredential } = await import('./gatewayCandidate');
      m.getConnectionKeyMaterial.mockResolvedValue({ ...ROUTING, id: 'c1', partnerId: 'p1', status: 'active', apiKeyEncrypted: 'enc:x', configVersion: 5 });
      expect(await loadGatewayCredential(conn())).toBeNull();
      m.getConnectionKeyMaterial.mockResolvedValue({ ...ROUTING, id: 'c1', partnerId: 'p1', status: 'active', apiKeyEncrypted: 'enc:x', baseUrl: NEW_URL });
      expect(await loadGatewayCredential(conn())).toBeNull();
      expect(m.decryptConnectionKey).not.toHaveBeenCalled();
      m.getConnectionKeyMaterial.mockResolvedValue({ ...ROUTING, id: 'c1', partnerId: 'p1', status: 'active', apiKeyEncrypted: 'enc:x' });
      expect(await loadGatewayCredential(conn())).toEqual({ secret: 'sk-local' });
    });
  });
});
