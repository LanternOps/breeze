import { describe, expect, it } from 'vitest';

import {
  errorMessage,
  initialVoiceState,
  isBusy,
  isListening,
  reduceVoice,
  type VoiceState,
} from './voiceState';

describe('voiceState', () => {
  it('starts idle', () => {
    expect(initialVoiceState).toEqual({ kind: 'idle' });
  });

  it('idle → listening transition (granted permission)', () => {
    let s: VoiceState = initialVoiceState;
    s = reduceVoice(s, { type: 'press', offline: false, permission: 'granted' });
    expect(s.kind).toBe('requesting');

    s = reduceVoice(s, { type: 'started' });
    expect(s.kind).toBe('listening');
    expect(isListening(s)).toBe(true);
  });

  it('listening → transcribing → idle (final result)', () => {
    let s: VoiceState = { kind: 'listening' };
    s = reduceVoice(s, { type: 'stop-requested' });
    expect(s.kind).toBe('transcribing');
    expect(isBusy(s)).toBe(true);

    s = reduceVoice(s, { type: 'final-result' });
    expect(s).toEqual({ kind: 'idle' });
  });

  it('press while listening triggers stop (transcribing)', () => {
    let s: VoiceState = { kind: 'listening' };
    s = reduceVoice(s, { type: 'press', offline: false, permission: 'granted' });
    expect(s.kind).toBe('transcribing');
  });

  it('idle → error when offline', () => {
    let s: VoiceState = initialVoiceState;
    s = reduceVoice(s, { type: 'press', offline: true, permission: 'granted' });
    expect(s).toEqual({ kind: 'error', reason: 'offline' });
    expect(errorMessage(s)).toBe('Connect to use voice.');
  });

  it('idle → error on denied permission press', () => {
    let s: VoiceState = initialVoiceState;
    s = reduceVoice(s, { type: 'press', offline: false, permission: 'denied' });
    expect(s).toEqual({ kind: 'error', reason: 'permission-denied' });
    expect(errorMessage(s)).toMatch(/permission/i);
  });

  it('permission denied during requesting → error', () => {
    let s: VoiceState = { kind: 'requesting' };
    s = reduceVoice(s, { type: 'permission-resolved', granted: false });
    expect(s).toEqual({ kind: 'error', reason: 'permission-denied' });
  });

  it('permission granted during requesting keeps requesting until started', () => {
    let s: VoiceState = { kind: 'requesting' };
    s = reduceVoice(s, { type: 'permission-resolved', granted: true });
    expect(s).toEqual({ kind: 'requesting' });
    s = reduceVoice(s, { type: 'started' });
    expect(s.kind).toBe('listening');
  });

  it('failure event maps to error', () => {
    let s: VoiceState = { kind: 'listening' };
    s = reduceVoice(s, { type: 'failed', reason: 'recognition-failed' });
    expect(s).toEqual({ kind: 'error', reason: 'recognition-failed' });
  });

  it('reset returns to idle from any state', () => {
    const states: VoiceState[] = [
      { kind: 'requesting' },
      { kind: 'listening' },
      { kind: 'transcribing' },
      { kind: 'error', reason: 'offline' },
    ];
    for (const start of states) {
      expect(reduceVoice(start, { type: 'reset' })).toEqual({ kind: 'idle' });
    }
  });

  it('ignores presses while requesting or transcribing', () => {
    expect(
      reduceVoice({ kind: 'requesting' }, {
        type: 'press',
        offline: false,
        permission: 'granted',
      }),
    ).toEqual({ kind: 'requesting' });

    expect(
      reduceVoice({ kind: 'transcribing' }, {
        type: 'press',
        offline: false,
        permission: 'granted',
      }),
    ).toEqual({ kind: 'transcribing' });
  });

  it('full happy path: idle → listening → transcribed → idle', () => {
    let s: VoiceState = initialVoiceState;
    expect(s.kind).toBe('idle');

    s = reduceVoice(s, { type: 'press', offline: false, permission: 'granted' });
    s = reduceVoice(s, { type: 'started' });
    expect(s.kind).toBe('listening');

    s = reduceVoice(s, { type: 'press', offline: false, permission: 'granted' });
    expect(s.kind).toBe('transcribing');

    s = reduceVoice(s, { type: 'final-result' });
    expect(s.kind).toBe('idle');
  });
});
