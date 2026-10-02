import { describe, expect, it } from 'vitest';
import { transportCarries } from './transport';

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
});
