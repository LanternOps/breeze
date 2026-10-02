import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetGatewayFailureNotesForTests,
  GATEWAY_FAILURE_NOTE_MAX_ENTRIES,
  GATEWAY_FAILURE_NOTE_TTL_MS,
  noteGatewayFailure,
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
