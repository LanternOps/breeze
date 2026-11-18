import { describe, expect, it } from 'vitest';
import { AI_INITIATOR_KINDS } from '@breeze/shared';
import { aiInitiatorKindEnum } from './aiInitiator';

describe('ai_initiator_kind', () => {
  it('the shared AI_INITIATOR_KINDS vocabulary and the pg enum are the same closed set', () => {
    // A value only on the pg side is unreadable (isAiInitiatorKind rejects it,
    // so the marker silently disappears); a value only on the shared side
    // fails at INSERT. Tool catalog W04 (#5219) added `flow` to both.
    expect([...aiInitiatorKindEnum.enumValues]).toEqual([...AI_INITIATOR_KINDS]);
  });
});
