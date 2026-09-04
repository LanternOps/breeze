import { describe, it, expect } from 'vitest';
import { mapKey, getModifiers, isModifierOnly, isCapsLock, getCapsLockState } from './keymap';

describe('keymap', () => {
  it('maps known KeyboardEvent.code values', () => {
    const e = new KeyboardEvent('keydown', { code: 'ArrowUp', key: 'ArrowUp' });
    expect(mapKey(e)).toBe('up');
  });

  it('falls back to KeyboardEvent.key for single characters', () => {
    const e = new KeyboardEvent('keydown', { code: 'Unidentified', key: 'Z' });
    expect(mapKey(e)).toBe('z');
  });

  it('returns modifiers in a stable order', () => {
    const e = new KeyboardEvent('keydown', {
      code: 'KeyA',
      key: 'a',
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
      metaKey: true,
    });
    expect(getModifiers(e)).toEqual(['ctrl', 'alt', 'shift', 'meta']);
  });

  it('detects modifier-only presses', () => {
    expect(isModifierOnly(new KeyboardEvent('keydown', { key: 'Control' }))).toBe(true);
    expect(isModifierOnly(new KeyboardEvent('keydown', { key: 'a' }))).toBe(false);
  });
});

describe('caps lock (issue #3595)', () => {
  const evt = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

  it('identifies the CapsLock key by physical code', () => {
    expect(isCapsLock(evt({ code: 'CapsLock', key: 'CapsLock' }))).toBe(true);
    expect(isCapsLock(evt({ code: 'KeyA', key: 'a' }))).toBe(false);
  });

  it('identifies CapsLock from either code or key alone', () => {
    // Both halves of the OR are load-bearing: webviews vary in which of the
    // two they populate, and missing the key means the toggle falls through to
    // the ordinary-key path that issue #3595 is about.
    expect(isCapsLock(evt({ code: '', key: 'CapsLock' }))).toBe(true);
    expect(isCapsLock(evt({ code: 'CapsLock', key: 'Unidentified' }))).toBe(true);
  });

  it('is not classified as a modifier-only key', () => {
    // isModifierOnly gates the "hold this modifier down" branch, which would
    // latch capslock in pressedKeysRef and later emit a bogus key_up.
    expect(isModifierOnly(evt({ code: 'CapsLock', key: 'CapsLock' }))).toBe(false);
  });

  it('reads the live CapsLock state off any key event', () => {
    expect(getCapsLockState(evt({ code: 'KeyA', key: 'a', modifierCapsLock: true }))).toBe(true);
    expect(getCapsLockState(evt({ code: 'KeyA', key: 'a' }))).toBe(false);
  });

  it('reports state on the CapsLock key event itself', () => {
    // macOS reports CapsLock as keydown-on-engage / keyup-on-disengage rather
    // than a matched pair, so each event has to carry the resulting state.
    expect(getCapsLockState(evt({ code: 'CapsLock', key: 'CapsLock', modifierCapsLock: true }))).toBe(true);
    expect(
      getCapsLockState(new KeyboardEvent('keyup', { code: 'CapsLock', key: 'CapsLock' }))
    ).toBe(false);
  });

  it('does not report caps lock merely because shift is held', () => {
    expect(getCapsLockState(evt({ code: 'KeyA', key: 'A', shiftKey: true }))).toBe(false);
  });

  it('falls back to false when the platform has no getModifierState', () => {
    const stub = { getModifierState: undefined } as unknown as KeyboardEvent;
    expect(getCapsLockState(stub)).toBe(false);
  });
});
