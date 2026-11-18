import { describe, expect, it } from 'vitest';
import { isAttachStateEvent, type AiAttachState, type AiStreamEvent } from './ai';

const idle: { type: 'attach_state' } & AiAttachState = {
  type: 'attach_state',
  turn: 'idle',
  turnId: null,
  lastSeq: 0,
  turnUserMessageId: null,
  replay: [],
  partial: false,
  pendingCards: [],
  activePlan: null,
  turnModel: null,
};

describe('attach_state contract (#9427)', () => {
  it('is a member of AiStreamEvent', () => {
    const event: AiStreamEvent = idle;
    expect(event.type).toBe('attach_state');
  });

  it('recognises a well-formed attach_state frame', () => {
    expect(isAttachStateEvent(idle)).toBe(true);
    expect(isAttachStateEvent({ ...idle, turn: 'running', turnId: 't1', lastSeq: 4, turnUserMessageId: 'u1' })).toBe(true);
    expect(isAttachStateEvent({ ...idle, turn: 'unavailable' })).toBe(true);
  });

  it('rejects other events and malformed frames', () => {
    expect(isAttachStateEvent({ type: 'done' })).toBe(false);
    const { turn: _turn, ...noTurn } = idle;
    expect(isAttachStateEvent(noTurn)).toBe(false);
    expect(isAttachStateEvent({ ...idle, turn: 'paused' })).toBe(false);
    expect(isAttachStateEvent({ ...idle, replay: null })).toBe(false);
    expect(isAttachStateEvent({ ...idle, pendingCards: undefined })).toBe(false);
    expect(isAttachStateEvent({ ...idle, lastSeq: '3' })).toBe(false);
    expect(isAttachStateEvent({ ...idle, partial: 'no' })).toBe(false);
    expect(isAttachStateEvent(null)).toBe(false);
    expect(isAttachStateEvent('attach_state')).toBe(false);
  });
});
