/**
 * #12174: a gateway verification the verifier WRITES must read back as
 * verified everywhere it is judged — the partner snapshot (the badge) and the
 * tool-surface candidate. Real Postgres, real store, real snapshot builder;
 * the record is built exactly as verifyConnectionOffering builds it.
 */
import './setup';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withDbAccessContext } from '../../db';
import { __setLookupForTests } from '../../services/urlSafety';
import { createGatewayConnection, createManualOffering } from '../../services/aiModels/gatewayConnections';
import { endpointFingerprint, verifiedCapabilitiesTree } from '../../services/aiModels/gatewayCapabilities';
import { writeOfferingVerification } from '../../services/aiModels/offeringVerificationStore';
import { buildPartnerModelsSnapshot } from '../../services/aiModels/registryView';
import { breezeToolProfileCatalog } from '../../services/aiModels/toolProfileCatalog';
import { FIDELITY_HARNESS_VERSION, type FidelityCheckResult } from '../../services/llm/providerFidelityHarness';
import { verifyConnectionOffering } from '../../services/aiModels/offeringVerification';
import { closeModelGateway, getModelGateway } from '../../services/aiModels/gateway';
import { getLlmEgressProxy } from '../../services/llm/llmEgressProxy';
import { createPartner } from './db-utils';
import { closeRegistryFixtures, fixtureSql, partnerContext } from './aiModelRegistryFixtures';

afterAll(closeRegistryFixtures);

const ZERO = { inputCentsPerM: 0, outputCentsPerM: 0, cacheReadCentsPerM: 0, cacheWriteCentsPerM: 0 };
const asPartner = <T>(partnerId: string, fn: () => Promise<T>) => withDbAccessContext(partnerContext(partnerId), fn);

beforeEach(async () => {
  __setLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
  await getModelGateway();
});
afterEach(async () => {
  await closeModelGateway();
  await (await getLlmEgressProxy()).close();
});

describe('#12174 gateway verification round trip (real DB)', () => {
  it.each([
    ['an OpenRouter-style slashed model id', 'https://openrouter.ai/api/v1', 'z-ai/glm-5.3-flash'],
    ['a plain model id', 'https://llm.example.com/v1', 'qwen'],
  ])('%s: a passed verification shows verified in the snapshot and grants tools', async (_label, baseUrl, modelId) => {
    const partnerId = (await createPartner()).id;
    const conn = await asPartner(partnerId, () => createGatewayConnection({ partnerId, name: 'gw', baseUrl, apiKey: 'sk-or-v1-secret-123456', connectedBy: null }));
    const off = await asPartner(partnerId, () => createManualOffering({ partnerId, connectionId: conn.id, modelId, prices: ZERO }));
    const fp = endpointFingerprint({ kind: conn.kind, baseUrl: conn.baseUrl, providerConfig: conn.providerConfig ?? null });
    const startedAt = new Date(Date.now() - 1000);
    const tree = verifiedCapabilitiesTree({
      harnessVersion: FIDELITY_HARNESS_VERSION, endpointFingerprint: fp, at: new Date().toISOString(),
      passed: true, toolUse: true, adaptiveEffort: false, summary: null,
    }, null);

    const outcome = await asPartner(partnerId, () => writeOfferingVerification({
      partnerId, offeringId: off.id, connectionId: conn.id, modelId, configVersion: conn.configVersion,
      endpointFingerprint: fp, startedAt, capabilities: tree, surfaceReadiness: {},
    }));
    expect(outcome).toBe('written');

    const [row] = await fixtureSql<Array<{ capabilities: unknown }>>`SELECT capabilities FROM partner_ai_models WHERE id = ${off.id}`;
    expect(row!.capabilities).toMatchObject({ breeze_verification: { passed: true, toolUse: true, harnessVersion: FIDELITY_HARNESS_VERSION } });

    const snap = await asPartner(partnerId, () => buildPartnerModelsSnapshot(partnerId, breezeToolProfileCatalog()));
    const dto = snap.offerings.find((o) => o.id === off.id);
    expect(dto?.verification?.state).toBe('verified');
    expect(dto?.supportsTools).toBe(true);
  });

  it.each([
    ['https://openrouter.ai/api/v1', 'z-ai/glm-5.3-flash'],
    ['https://openrouter.ai/api/v1', 'anthropic/claude-sonnet-5.5'],
  ])('the real verifier (harness stubbed to pass) on %s %s: snapshot shows verified', async (baseUrl, modelId) => {
    const partnerId = (await createPartner()).id;
    const conn = await asPartner(partnerId, () => createGatewayConnection({ partnerId, name: 'or', baseUrl, apiKey: 'sk-or-v1-secret-123456', connectedBy: null }));
    const off = await asPartner(partnerId, () => createManualOffering({ partnerId, connectionId: conn.id, modelId, prices: ZERO }));
    const r = await verifyConnectionOffering({ offeringId: off.id, partnerId }, { runHarness: async () => PASS });
    expect(r.state).toBe('verified');
    const snap = await asPartner(partnerId, () => buildPartnerModelsSnapshot(partnerId, breezeToolProfileCatalog()));
    const dto = snap.offerings.find((o) => o.id === off.id);
    expect(dto?.verification?.state).toBe('verified');
    expect(dto?.supportsTools).toBe(true);
  });
});

const PASS: FidelityCheckResult = {
  passed: true,
  steps: [{ name: 'direct_tool_use', ok: true }, { name: 'direct_tool_result', ok: true }, { name: 'sdk_subprocess', ok: true }],
  probes: [{ name: 'direct_adaptive_effort', ok: false, detail: 'skipped: not applicable to this connection kind' }],
  verifiedCapabilities: { adaptiveEffort: false },
  harnessVersion: FIDELITY_HARNESS_VERSION,
};
