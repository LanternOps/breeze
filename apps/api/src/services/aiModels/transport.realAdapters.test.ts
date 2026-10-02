import { describe, expect, it } from 'vitest';
import { __resetTransportCarriageForTests, transportCarries } from './transport';
import { __setAgentSdkFastVerifiedForTests } from './wireParams';

// Pins TODAY's W01 adapters (no mock): until the spike decisions D1–D3 extend
// an adapter, neither transport carries fast mode, a geography or thinking
// display 'updates', so the resolver never applies — or prices — any of them.
describe('transportCarries against the real W01 adapters', () => {
  it('neither transport carries speed, inferenceGeo or thinkingDisplay updates yet', () => {
    const none = { speed: false, inferenceGeo: false, thinkingDisplayUpdates: false };
    // W05: budget thinking is carried by query() only (toMessagesApiParams only REDUCES thinking).
    expect(transportCarries('agent_sdk')).toEqual({ ...none, budgetThinking: true });
    expect(transportCarries('messages_api')).toEqual({ ...none, budgetThinking: false });
  });

  // W05: lives here, not in transport.test.ts — that suite mocks ./wireParams,
  // so the L1 gate seam only exists against the real adapters.
  it('agent_sdk speed carriage follows the L1 gate (W05)', () => {
    __setAgentSdkFastVerifiedForTests(false);
    __resetTransportCarriageForTests();
    expect(transportCarries('agent_sdk').speed).toBe(false);
    __setAgentSdkFastVerifiedForTests(true);
    __resetTransportCarriageForTests();
    expect(transportCarries('agent_sdk').speed).toBe(true);
    expect(transportCarries('messages_api').speed).toBe(false);
    __setAgentSdkFastVerifiedForTests(null);
    __resetTransportCarriageForTests();
    // Shipped default (L1 not yet passed): Fast is never offered in chat.
    expect(transportCarries('agent_sdk').speed).toBe(false);
  });
});
