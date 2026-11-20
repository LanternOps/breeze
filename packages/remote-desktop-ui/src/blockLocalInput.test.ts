import { describe, it, expect } from 'vitest';
import {
  INITIAL_BLOCK_LOCAL_INPUT,
  applyBlockLocalInputResult,
  blockLocalInputMessage,
  blockLocalInputRequested,
  blockLocalInputTimedOut,
  parseBlockLocalInputResult,
} from './blockLocalInput';

describe('block local input wire format', () => {
  it('uses the existing agent control message (non-zero engages, 0 releases)', () => {
    expect(JSON.parse(blockLocalInputMessage(true))).toEqual({ type: 'block_local_input', value: 1 });
    expect(JSON.parse(blockLocalInputMessage(false))).toEqual({ type: 'block_local_input', value: 0 });
  });

  it('parses the agent reply and rejects anything malformed', () => {
    expect(parseBlockLocalInputResult({ type: 'block_local_input_result', supported: true, blocked: true, ok: true }))
      .toEqual({ supported: true, blocked: true, ok: true, error: undefined });
    expect(parseBlockLocalInputResult({ type: 'block_local_input_result', supported: true, blocked: false, ok: false, error: 'denied' }))
      .toEqual({ supported: true, blocked: false, ok: false, error: 'denied' });
    expect(parseBlockLocalInputResult({ type: 'other', supported: true, blocked: true, ok: true })).toBeNull();
    expect(parseBlockLocalInputResult({ type: 'block_local_input_result', supported: 'yes', blocked: true, ok: true })).toBeNull();
    expect(parseBlockLocalInputResult(null)).toBeNull();
  });
});

describe('block local input state', () => {
  it('starts off, unknown support, nothing pending', () => {
    expect(INITIAL_BLOCK_LOCAL_INPUT).toEqual({ supported: null, blocked: false, pending: false, error: null });
  });

  it('is not optimistic: a request only marks pending, the reply sets blocked', () => {
    const pending = blockLocalInputRequested(INITIAL_BLOCK_LOCAL_INPUT);
    expect(pending.blocked).toBe(false);
    expect(pending.pending).toBe(true);
    const done = applyBlockLocalInputResult(pending, { supported: true, blocked: true, ok: true });
    expect(done).toEqual({ supported: true, blocked: true, pending: false, error: null });
  });

  it('records unsupported platforms so the toggle can be disabled', () => {
    const s = applyBlockLocalInputResult(blockLocalInputRequested(INITIAL_BLOCK_LOCAL_INPUT), { supported: false, blocked: false, ok: true });
    expect(s.supported).toBe(false);
    expect(s.blocked).toBe(false);
  });

  it('surfaces the agent error and renders the state the agent reports', () => {
    const s = applyBlockLocalInputResult(
      { supported: true, blocked: true, pending: true, error: null },
      { supported: true, blocked: true, ok: false, error: 'release failed' },
    );
    expect(s).toEqual({ supported: true, blocked: true, pending: false, error: 'release failed' });
  });

  it('gives a generic error when ok is false without a message', () => {
    const s = applyBlockLocalInputResult(INITIAL_BLOCK_LOCAL_INPUT, { supported: true, blocked: false, ok: false });
    expect(s.error).toMatch(/could not/i);
  });

  it('clears a stale error on the next request', () => {
    const s = blockLocalInputRequested({ supported: true, blocked: false, pending: false, error: 'old' });
    expect(s.error).toBeNull();
  });

  it('a request that is never answered stops pending, keeps the last known state, and says so', () => {
    const s = blockLocalInputTimedOut({ supported: null, blocked: false, pending: true, error: null });
    expect(s.pending).toBe(false);
    expect(s.blocked).toBe(false);
    expect(s.error).toMatch(/did not respond/i);
  });

  it('a timeout after the reply already landed is a no-op', () => {
    const answered = { supported: true, blocked: true, pending: false, error: null };
    expect(blockLocalInputTimedOut(answered)).toBe(answered);
  });
});
