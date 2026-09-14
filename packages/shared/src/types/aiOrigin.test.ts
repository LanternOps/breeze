import { describe, it, expect } from 'vitest';
import {
  AI_INITIATOR_KINDS,
  isAiInitiatorKind,
  serializeAiOrigin,
  deserializeAiOrigin,
} from './aiOrigin';

describe('AiOriginRef', () => {
  it('is a closed two-value vocabulary', () => {
    expect([...AI_INITIATOR_KINDS]).toEqual(['ai_assistant', 'ai_agent']);
    expect(isAiInitiatorKind('ai_agent')).toBe(true);
    expect(isAiInitiatorKind('automation')).toBe(false);
    expect(isAiInitiatorKind(null)).toBe(false);
  });

  it('round-trips through the persisted column shape', () => {
    const origin = { kind: 'ai_agent' as const, sessionId: 's1', agentRunId: 'r1' };
    expect(deserializeAiOrigin(serializeAiOrigin(origin))).toEqual(origin);
  });

  it('serializes an absent origin to three nulls, never to a human default', () => {
    expect(serializeAiOrigin(undefined)).toEqual({
      aiOriginKind: null,
      aiOriginSessionId: null,
      aiOriginAgentRunId: null,
    });
  });

  it('deserializes an all-null row to undefined, not to a fabricated kind', () => {
    expect(
      deserializeAiOrigin({ aiOriginKind: null, aiOriginSessionId: null, aiOriginAgentRunId: null }),
    ).toBeUndefined();
  });

  it('refuses to reconstruct an origin from ids alone when the kind is missing', () => {
    // A row with ids but no kind is a threading bug, not an assistant run.
    expect(
      deserializeAiOrigin({ aiOriginKind: null, aiOriginSessionId: 's1', aiOriginAgentRunId: null }),
    ).toBeUndefined();
  });
});
