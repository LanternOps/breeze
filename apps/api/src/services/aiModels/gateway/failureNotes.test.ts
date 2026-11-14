import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetGatewayFailureNotesForTests,
  GATEWAY_FAILURE_NOTE_MAX_ENTRIES,
  GATEWAY_FAILURE_NOTE_TTL_MS,
  noteGatewayFailure,
  takeGatewayFailure,
  takeGatewayFailureNote,
} from './failureNotes';

afterEach(() => {
  __resetGatewayFailureNotesForTests();
  vi.useRealTimers();
});

describe('gateway failure notes', () => {
  it('a note is read once, by its session', () => {
    noteGatewayFailure('s1', 'reason one');
    expect(takeGatewayFailureNote('s2')).toBeNull();
    expect(takeGatewayFailureNote('s1')).toBe('reason one');
    expect(takeGatewayFailureNote('s1')).toBeNull();
  });

  it('a coded note carries its code, and an uncoded one reads as null (#10577)', () => {
    noteGatewayFailure('s1', 'too big', 'context_window_exceeded');
    noteGatewayFailure('s2', 'other');
    expect(takeGatewayFailure('s1')).toEqual({ message: 'too big', code: 'context_window_exceeded' });
    expect(takeGatewayFailure('s1')).toBeNull();
    expect(takeGatewayFailure('s2')).toEqual({ message: 'other', code: null });
  });

  it('a refused tool batch is noted by code (W04 #11397)', () => {
    noteGatewayFailure('s1', 'refused 1 tool call(s): foo', 'refused_tool_batch');
    expect(takeGatewayFailure('s1')).toEqual({ message: 'refused 1 tool call(s): foo', code: 'refused_tool_batch' });
  });

  it('a refused tool batch never replaces a pending context-window refusal, which is the more specific reason', () => {
    noteGatewayFailure('s1', 'too big', 'context_window_exceeded');
    noteGatewayFailure('s1', 'refused 1 tool call(s): foo', 'refused_tool_batch');
    expect(takeGatewayFailure('s1')).toEqual({ message: 'too big', code: 'context_window_exceeded' });
  });

  it('a later context-window refusal does replace a refused tool batch', () => {
    noteGatewayFailure('s1', 'refused 1 tool call(s): foo', 'refused_tool_batch');
    noteGatewayFailure('s1', 'too big', 'context_window_exceeded');
    expect(takeGatewayFailure('s1')).toEqual({ message: 'too big', code: 'context_window_exceeded' });
  });

  it('the latest note for a session wins', () => {
    noteGatewayFailure('s1', 'first');
    noteGatewayFailure('s1', 'second');
    expect(takeGatewayFailureNote('s1')).toBe('second');
  });

  it('a request with no session (verification, one-shots) is not noted', () => {
    noteGatewayFailure(null, 'x');
    expect(takeGatewayFailureNote(null)).toBeNull();
  });

  it('expires after its TTL', () => {
    vi.useFakeTimers();
    noteGatewayFailure('s1', 'old');
    vi.advanceTimersByTime(GATEWAY_FAILURE_NOTE_TTL_MS + 1);
    expect(takeGatewayFailureNote('s1')).toBeNull();
  });

  it('is bounded: the oldest note is evicted first', () => {
    for (let i = 0; i <= GATEWAY_FAILURE_NOTE_MAX_ENTRIES; i += 1) noteGatewayFailure(`s${i}`, `n${i}`);
    expect(takeGatewayFailureNote('s0')).toBeNull();
    expect(takeGatewayFailureNote(`s${GATEWAY_FAILURE_NOTE_MAX_ENTRIES}`)).toBe(`n${GATEWAY_FAILURE_NOTE_MAX_ENTRIES}`);
  });
});
