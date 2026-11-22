import { describe, expect, it } from 'vitest';
import { heartbeatMessageSchema } from './agentWs';

// Learned networks (#12369, index plan call 2): the learner is wired to the REST heartbeat only. The WebSocket
// heartbeat carries no device row, no ephemeral flag and no client address, so it must not accept
// `networkAttachmentsV1`: a WS-only path that started passing the field would learn without those checks.
describe('WebSocket heartbeat message schema (plan call 2)', () => {
  it('the WebSocket heartbeat does not accept networkAttachmentsV1', () => {
    expect(Object.keys(heartbeatMessageSchema.shape).sort()).toEqual(['ipHistoryUpdate', 'timestamp', 'type']);
    const parsed = heartbeatMessageSchema.parse({
      type: 'heartbeat', timestamp: 1, networkAttachmentsV1: { epoch: '9f2c1e7ab4d04c11' },
    });
    expect('networkAttachmentsV1' in parsed).toBe(false);
  });
});
