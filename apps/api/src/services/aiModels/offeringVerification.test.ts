/**
 * W06 Task 12 (#7604): verifyConnectionOffering is the ONLY writer of a
 * gateway verification record, and that record is what grants tool calling.
 * The harness is mocked (its own suite covers the stages); the loopback model
 * gateway and the CONNECT proxy are real, so grant binding and revocation are
 * observed on the wire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FidelityCheckInput, FidelityCheckResult, FidelityTransport } from '../llm/providerFidelityHarness';

const UPSTREAM_KEY = 'sk-upstream-777777777777';

const h = vi.hoisted(() => ({
  harness: null as unknown as FidelityCheckResult,
  harnessImpl: null as null | ((input: FidelityCheckInput, transport: FidelityTransport) => Promise<FidelityCheckResult>),
  harnessArgs: null as null | [FidelityCheckInput, FidelityTransport],
  writes: [] as Array<Record<string, unknown>>,
  writeOutcome: 'written' as 'written' | 'superseded',
  offering: null as Record<string, unknown> | null,
  conn: null as Record<string, unknown> | null,
  credential: { secret: 'sk-upstream-777777777777' } as { secret: string | null } | null,
  platformCaps: null as unknown,
  /** When set, the REAL loadGatewayCredential runs against this key row. */
  material: null as Record<string, unknown> | null,
}));

vi.mock('../../db', async (orig) => ({
  ...(await orig<typeof import('../../db')>()),
  runOutsideDbContext: <T>(fn: () => T) => fn(),
  withSystemDbAccessContext: <T>(fn: () => T) => fn(),
}));
vi.mock('../llm/providerFidelityHarness', async (orig) => ({
  ...(await orig<typeof import('../llm/providerFidelityHarness')>()),
  runFidelityCheck: async (input: FidelityCheckInput, transport: FidelityTransport) => {
    h.harnessArgs = [input, transport];
    return h.harnessImpl ? h.harnessImpl(input, transport) : h.harness;
  },
}));
vi.mock('./offerings', async (orig) => ({ ...(await orig<typeof import('./offerings')>()), getOffering: async () => h.offering }));
vi.mock('./connections', async (orig) => ({
  ...(await orig<typeof import('./connections')>()),
  getConnection: async () => h.conn,
  getConnectionKeyMaterial: async () => h.material,
}));
vi.mock('./gatewayCandidate', async (orig) => {
  const real = await orig<typeof import('./gatewayCandidate')>();
  return {
    ...real,
    loadGatewayCredential: async (conn: Parameters<typeof real.loadGatewayCredential>[0]) => {
      if (h.material) return real.loadGatewayCredential(conn);
      return h.credential ? { ...h.credential } : null;
    },
  };
});
vi.mock('./platformModels', async (orig) => ({
  ...(await orig<typeof import('./platformModels')>()),
  getPlatformModelById: async () => ({ capabilities: h.platformCaps }),
}));
vi.mock('./offeringVerificationStore', () => ({
  writeOfferingVerification: async (input: Record<string, unknown>) => {
    h.writes.push(input);
    return h.writeOutcome;
  },
}));

import { getLlmEgressProxy } from '../llm/llmEgressProxy';
import { closeModelGateway, getModelGateway } from './gateway';
import { endpointFingerprint, verifiedGatewayCapabilities } from './gatewayCapabilities';
import { verifyConnectionOffering } from './offeringVerification';

const BASE_URL = 'https://llm.example.com/v1';
const FINGERPRINT = endpointFingerprint({ kind: 'openai_compatible', baseUrl: BASE_URL, providerConfig: null });

const PASS: FidelityCheckResult = {
  passed: true,
  steps: [{ name: 'direct_tool_use', ok: true }, { name: 'direct_tool_result', ok: true }, { name: 'sdk_subprocess', ok: true }],
  probes: [{ name: 'direct_adaptive_effort', ok: false, detail: 'skipped: not applicable to this connection kind' }],
  verifiedCapabilities: { adaptiveEffort: false },
  harnessVersion: '1',
};

const written = () => h.writes.at(-1)!;
const writtenCaps = () => written().capabilities as Record<string, unknown>;

beforeEach(async () => {
  h.harness = PASS;
  h.harnessImpl = null;
  h.harnessArgs = null;
  h.writes = [];
  h.writeOutcome = 'written';
  h.offering = { id: 'o1', partnerId: 'p1', connectionId: 'c1', modelId: 'qwen', source: 'discovered', platformModelId: null, enabled: false };
  h.conn = { id: 'c1', partnerId: 'p1', kind: 'openai_compatible', baseUrl: BASE_URL, providerConfig: null, configVersion: 2, status: 'active' };
  h.credential = { secret: UPSTREAM_KEY };
  h.platformCaps = null;
  h.material = null;
  await getModelGateway();
});
afterEach(async () => {
  await closeModelGateway();
  await (await getLlmEgressProxy()).close();
  vi.restoreAllMocks();
});

describe('verifyConnectionOffering', () => {
  it('an endpoint+key change between the connection read and the key read: refused, the harness never runs, nothing written', async () => {
    h.material = {
      id: 'c1', partnerId: 'p1', status: 'active', kind: 'openai_compatible',
      baseUrl: 'https://attacker.example.net/v1', configVersion: 3, apiKeyEncrypted: null,
    };
    await expect(verifyConnectionOffering({ offeringId: 'o1', partnerId: 'p1' })).rejects.toMatchObject({ code: 'not_eligible', status: 409 });
    expect(h.harnessArgs).toBeNull();
    expect(h.writes).toEqual([]);
  });

  it('a key row from the same routing snapshot is used (keyless control for the race test above)', async () => {
    h.material = { id: 'c1', partnerId: 'p1', status: 'active', kind: 'openai_compatible', baseUrl: BASE_URL, configVersion: 2, apiKeyEncrypted: null };
    const r = await verifyConnectionOffering({ offeringId: 'o1', partnerId: 'p1' });
    expect(r.state).toBe('verified');
  });

  it('passes → stores a verified tree bound to the endpoint fingerprint, tools supported', async () => {
    const r = await verifyConnectionOffering({ offeringId: 'o1', partnerId: 'p1' });
    expect(r.state).toBe('verified');
    expect(writtenCaps()).toMatchObject({
      tool_use: { supported: true },
      breeze_verification: { passed: true, toolUse: true, adaptiveEffort: false, endpointFingerprint: FINGERPRINT, harnessVersion: '1', summary: null },
    });
    // The resolver's read of what was written: verified, tools on, no thinking.
    const read = verifiedGatewayCapabilities(writtenCaps(), FINGERPRINT);
    expect(read.state).toBe('verified');
    expect(read.capabilities.supportsTools).toBe(true);
  });

  it('hands the store the connection version and fingerprint it verified, scoped to partner/connection/model', async () => {
    await verifyConnectionOffering({ offeringId: 'o1', partnerId: 'p1' });
    expect(written()).toMatchObject({
      partnerId: 'p1', offeringId: 'o1', connectionId: 'c1', modelId: 'qwen',
      configVersion: 2, endpointFingerprint: FINGERPRINT, startedAt: expect.any(Date),
    });
  });

  it('drives the harness through a loopback gateway grant with the placeholder key', async () => {
    await verifyConnectionOffering({ offeringId: 'o1', partnerId: 'p1' });
    const [input, transport] = h.harnessArgs!;
    expect(input.apiKey).toBe('breeze-gateway');
    expect(input.providerModel).toBe('qwen');
    expect(input.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/g\/[A-Za-z0-9_-]{43}$/);
    expect(transport.childEnv.ANTHROPIC_BASE_URL).toBe(input.baseUrl);
    expect(transport.childEnv.ANTHROPIC_API_KEY).toBe('breeze-gateway');
    expect(transport.childEnv.HTTPS_PROXY).toMatch(/^http:\/\/breeze:[^@]+@127\.0\.0\.1:\d+$/);
    expect(transport.probeAdaptiveEffort).toBe(false);
    expect(JSON.stringify(transport.childEnv)).not.toContain(UPSTREAM_KEY);
    expect(JSON.stringify(transport.childEnv)).not.toContain('llm.example.com');
  });

  it('grants bind exactly the offering wire model and are revoked when the run ends', async () => {
    let listedByChildGrant: unknown = null;
    let listedByClient: unknown = null;
    let refusedOtherModel = 0;
    h.harnessImpl = async (input, transport) => {
      listedByChildGrant = await (await fetch(`${input.baseUrl}/v1/models`)).json();
      listedByClient = await transport.client.models.list();
      refusedOtherModel = (await fetch(`${input.baseUrl}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-other', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] }),
      })).status;
      return PASS;
    };
    await verifyConnectionOffering({ offeringId: 'o1', partnerId: 'p1' });
    expect((listedByChildGrant as { data: Array<{ id: string }> }).data.map((m) => m.id)).toEqual(['qwen']);
    expect((listedByClient as { data: Array<{ id: string }> }).data.map((m) => m.id)).toEqual(['qwen']);
    expect(refusedOtherModel).toBe(403);
    // Revoked: the child grant URL is dead after the run.
    const [input] = h.harnessArgs!;
    expect((await fetch(`${input.baseUrl}/v1/models`)).status).toBe(401);
  });

  it('revokes the grants even when the harness throws', async () => {
    h.harnessImpl = async () => { throw new Error('programmer error'); };
    await expect(verifyConnectionOffering({ offeringId: 'o1', partnerId: 'p1' })).rejects.toThrow(/could not run/);
    const [input] = h.harnessArgs!;
    expect((await fetch(`${input.baseUrl}/v1/models`)).status).toBe(401);
    expect(h.writes).toHaveLength(0);
  });

  it('fails → state failed, tools off, scrubbed ≤200-char summary; the resolver reads it as failed (no tools)', async () => {
    h.harness = { ...PASS, passed: false, steps: [{ name: 'direct_tool_use', ok: false, detail: `no tool_use block ${'x'.repeat(500)}` }] };
    const r = await verifyConnectionOffering({ offeringId: 'o1', partnerId: 'p1' });
    expect(r.state).toBe('failed');
    const caps = writtenCaps();
    expect(caps.tool_use).toEqual({ supported: false });
    const summary = (caps.breeze_verification as { summary: string }).summary;
    expect(summary.startsWith('direct_tool_use: no tool_use block')).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(200);
    const read = verifiedGatewayCapabilities(caps, FINGERPRINT);
    expect(read.state).toBe('failed');
    expect(read.capabilities.supportsTools).toBe(false);
  });

  it('detail never contains the key (stored summary, logs, error text, grant tokens)', async () => {
    const logged: unknown[][] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args); });
    }
    let childToken = '';
    let proxyToken = '';
    h.harnessImpl = async (input, transport) => {
      childToken = input.baseUrl.split('/g/')[1]!;
      proxyToken = decodeURIComponent(new URL(transport.childEnv.HTTPS_PROXY!).password);
      return {
        ...PASS,
        passed: false,
        steps: [{
          name: 'direct_tool_use',
          ok: false,
          // A hostile endpoint echoing the key in several encodings, plus the grant URLs.
          detail: `upstream said ${UPSTREAM_KEY} / ${encodeURIComponent(UPSTREAM_KEY)} / `
            + `${Buffer.from(UPSTREAM_KEY).toString('base64')} via ${input.baseUrl} ${transport.childEnv.HTTPS_PROXY}`,
        }],
      };
    };
    const r = await verifyConnectionOffering({ offeringId: 'o1', partnerId: 'p1' });
    const stored = JSON.stringify(h.writes);
    const returned = JSON.stringify(r);
    for (const text of [stored, returned, JSON.stringify(logged)]) {
      expect(text).not.toContain(UPSTREAM_KEY);
      expect(text).not.toContain(UPSTREAM_KEY.slice(-12));
      expect(text).not.toContain(Buffer.from(UPSTREAM_KEY).toString('base64'));
      expect(text).not.toContain(childToken);
      expect(text).not.toContain(proxyToken);
    }
    expect((r.record.summary ?? '').length).toBeLessThanOrEqual(200);

    // Error text: a harness that throws with the key in its message.
    h.harnessImpl = async () => { throw new Error(`boom ${UPSTREAM_KEY}`); };
    const error = await verifyConnectionOffering({ offeringId: 'o1', partnerId: 'p1' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain(UPSTREAM_KEY);
    expect(String((error as Error).stack)).not.toContain(UPSTREAM_KEY);
    expect(JSON.stringify(logged)).not.toContain(UPSTREAM_KEY);
  });

  it('superseded (the connection changed while verifying) → nothing claimed, state superseded', async () => {
    h.writeOutcome = 'superseded';
    const r = await verifyConnectionOffering({ offeringId: 'o1', partnerId: 'p1' });
    expect(r.state).toBe('superseded');
  });

  it('a keyless (local) endpoint verifies with no secret', async () => {
    h.credential = { secret: null };
    const r = await verifyConnectionOffering({ offeringId: 'o1', partnerId: 'p1' });
    expect(r.state).toBe('verified');
  });

  it('refuses a missing or foreign offering (404), before any grant or harness run', async () => {
    h.offering = null;
    await expect(verifyConnectionOffering({ offeringId: 'o1', partnerId: 'p1' })).rejects.toMatchObject({ status: 404, code: 'not_found' });
    h.offering = { id: 'o1', partnerId: 'other', connectionId: 'c1', modelId: 'qwen', source: 'discovered', platformModelId: null };
    await expect(verifyConnectionOffering({ offeringId: 'o1', partnerId: 'p1' })).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect(h.harnessArgs).toBeNull();
    expect(h.writes).toHaveLength(0);
  });

  it('refuses a platform offering and a non-gateway connection kind (409 not_gateway)', async () => {
    h.offering = { id: 'o1', partnerId: 'p1', connectionId: null, modelId: null, source: 'platform', platformModelId: 'pm1' };
    await expect(verifyConnectionOffering({ offeringId: 'o1', partnerId: 'p1' })).rejects.toMatchObject({ status: 409, code: 'not_gateway' });
    h.offering = { id: 'o1', partnerId: 'p1', connectionId: 'c1', modelId: 'claude-x', source: 'discovered', platformModelId: null };
    for (const kind of ['anthropic_byok', 'catalog']) {
      h.conn = { ...h.conn!, kind };
      await expect(verifyConnectionOffering({ offeringId: 'o1', partnerId: 'p1' })).rejects.toMatchObject({ status: 409, code: 'not_gateway' });
    }
    expect(h.harnessArgs).toBeNull();
    expect(h.writes).toHaveLength(0);
  });

  it('refuses a connection of another partner (404)', async () => {
    h.conn = { ...h.conn!, partnerId: 'other' };
    await expect(verifyConnectionOffering({ offeringId: 'o1', partnerId: 'p1' })).rejects.toMatchObject({ status: 404 });
    expect(h.harnessArgs).toBeNull();
  });

  it('refuses a disconnected connection, and one whose credential is unusable (409 connection_unavailable)', async () => {
    h.conn = { ...h.conn!, status: 'disconnected' };
    await expect(verifyConnectionOffering({ offeringId: 'o1', partnerId: 'p1' }))
      .rejects.toMatchObject({ status: 409, code: 'not_eligible', details: { reason: 'connection_unavailable' } });
    h.conn = { ...h.conn!, status: 'active' };
    h.credential = null;
    await expect(verifyConnectionOffering({ offeringId: 'o1', partnerId: 'p1' }))
      .rejects.toMatchObject({ status: 409, code: 'not_eligible', details: { reason: 'connection_unavailable' } });
    expect(h.harnessArgs).toBeNull();
    expect(h.writes).toHaveLength(0);
  });

  it('never changes enabled (writes capabilities only)', async () => {
    await verifyConnectionOffering({ offeringId: 'o1', partnerId: 'p1' });
    expect(Object.keys(written())).not.toContain('enabled');
    expect(Object.keys(writtenCaps())).not.toContain('enabled');
  });

  it('a linked platform row never lends thinking to an openai_compatible offering', async () => {
    h.offering = { ...h.offering!, platformModelId: 'pm1' };
    h.platformCaps = { thinking: { types: { adaptive: { supported: true } } }, effort: { supported: true, low: { supported: true } } };
    await verifyConnectionOffering({ offeringId: 'o1', partnerId: 'p1' });
    const read = verifiedGatewayCapabilities(writtenCaps(), FINGERPRINT);
    expect(read.capabilities.thinkingMode).toBe('none');
    expect(read.capabilities.effortLevels).toEqual([]);
  });
});
