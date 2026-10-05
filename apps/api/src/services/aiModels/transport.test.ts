import { describe, expect, it, vi } from 'vitest';

const { UnsupportedWireOptionError } = vi.hoisted(() => ({ UnsupportedWireOptionError: class extends Error {} }));
vi.mock('./wireParams', () => ({
  UnsupportedWireOptionError,
  // Stand-in for a W01 state where the SDK can carry thinking display + geo but not fast mode.
  toAgentSdkOptions: (w: { speed?: string }) => { if (w.speed) throw new UnsupportedWireOptionError('speed'); return {}; },
  toMessagesApiParams: (w: { speed?: string; inferenceGeo?: string; thinking?: { display?: string } }) => {
    if (w.speed || w.inferenceGeo || w.thinking?.display === 'updates') throw new UnsupportedWireOptionError('x');
    return {};
  },
}));

import { defaultTransport, transportCarries } from './transport';

describe('transport', () => {
  it('tool-requiring surfaces run the Agent SDK; one-shots the Messages API', () => {
    expect(defaultTransport('chat')).toBe('agent_sdk');
    expect(defaultTransport('ai_agents')).toBe('agent_sdk');
    expect(defaultTransport('script_reviewer')).toBe('messages_api');
    expect(defaultTransport('patch_test')).toBe('messages_api');
  });
  it('carriage is exactly what W01\'s adapter accepts, per transport', () => {
    expect(transportCarries('agent_sdk')).toEqual({ speed: false, inferenceGeo: true, thinkingDisplayUpdates: true, budgetThinking: true });
    expect(transportCarries('messages_api')).toEqual({ speed: false, inferenceGeo: false, thinkingDisplayUpdates: false, budgetThinking: false });
  });
  it('only the Agent SDK carries budget thinking (W05)', () => {
    expect(transportCarries('agent_sdk').budgetThinking).toBe(true);
    expect(transportCarries('messages_api').budgetThinking).toBe(false);
  });
});
