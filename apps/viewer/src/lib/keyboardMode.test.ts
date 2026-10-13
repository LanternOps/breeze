import { describe, it, expect } from 'vitest';
import {
  DEFAULT_KEYBOARD_MODE,
  effectiveKeyboardMode,
  isKeyboardMode,
  keyboardModeSupport,
} from './keyboardMode';

const full = { transport: 'webrtc' as const, keyCodes: true, typeText: true };

describe('isKeyboardMode', () => {
  it('accepts only the two modes', () => {
    expect(isKeyboardMode('text')).toBe(true);
    expect(isKeyboardMode('physical')).toBe(true);
    expect(isKeyboardMode('Physical')).toBe(false);
    expect(isKeyboardMode(undefined)).toBe(false);
    expect(isKeyboardMode(1)).toBe(false);
  });

  it('defaults to "Type what I see"', () => {
    expect(DEFAULT_KEYBOARD_MODE).toBe('text');
  });
});

describe('keyboardModeSupport', () => {
  it('WebRTC against a W08 agent with typeText: both modes, composition available', () => {
    const s = keyboardModeSupport(full);
    expect(s.applies).toBe(true);
    expect(s.physical).toBe(true);
    expect(s.physicalUnavailableReason).toBeNull();
    expect(s.composition).toBe(true);
  });

  it('agent without keyCodes: Physical disabled with a reason', () => {
    const s = keyboardModeSupport({ ...full, keyCodes: false });
    expect(s.physical).toBe(false);
    expect(s.physicalUnavailableReason).toMatch(/agent/i);
    expect(s.composition).toBe(true);
  });

  it('agent without typeText: no composition capture', () => {
    expect(keyboardModeSupport({ ...full, typeText: false }).composition).toBe(false);
  });

  it('WebSocket has no control channel: no composition capture, and Physical says why', () => {
    const s = keyboardModeSupport({ ...full, keyCodes: false, transport: 'websocket' });
    expect(s.composition).toBe(false);
    expect(s.applies).toBe(true);
    expect(s.physical).toBe(false);
    expect(s.physicalUnavailableReason).toMatch(/WebRTC/);
  });

  it('VNC: the mode does not apply at all (no code, no typeText)', () => {
    const s = keyboardModeSupport({ ...full, transport: 'vnc' });
    expect(s.applies).toBe(false);
    expect(s.physical).toBe(false);
    expect(s.physicalUnavailableReason).toMatch(/VNC/);
    expect(s.composition).toBe(false);
  });

  it('no transport yet: nothing applies', () => {
    const s = keyboardModeSupport({ ...full, transport: null });
    expect(s.applies).toBe(false);
    expect(s.physical).toBe(false);
    expect(s.composition).toBe(false);
  });
});

describe('effectiveKeyboardMode', () => {
  it('honours Physical only when the session supports it', () => {
    expect(effectiveKeyboardMode('physical', keyboardModeSupport(full))).toBe('physical');
    expect(effectiveKeyboardMode('physical', keyboardModeSupport({ ...full, keyCodes: false }))).toBe('text');
    expect(effectiveKeyboardMode('physical', keyboardModeSupport({ ...full, transport: 'vnc' }))).toBe('text');
  });

  it('text stays text', () => {
    expect(effectiveKeyboardMode('text', keyboardModeSupport(full))).toBe('text');
  });
});
