import { describe, it, expect } from 'vitest';
import {
  mapKey,
  getModifiers,
  isModifierOnly,
  isCapsLock,
  getCapsLockState,
  keyNameModeFor,
  resolveKeyUpName,
} from './keymap';

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

/**
 * Non-US layouts (issue #7809). KeyboardEvent.code names the PHYSICAL key by
 * its US-QWERTY position; KeyboardEvent.key is what the active layout produced.
 * Fixtures are what a browser reports for the key whose cap shows the letter
 * named in the test.
 */
describe('layout-aware letters (issue #7809)', () => {
  const evt = (code: string, key: string, init: KeyboardEventInit = {}) =>
    new KeyboardEvent('keydown', { code, key, ...init });

  describe('German QWERTZ', () => {
    it('sends z for the Z cap (physically KeyY) to a layout-resolving remote', () => {
      expect(mapKey(evt('KeyY', 'z'), 'layout')).toBe('z');
      expect(mapKey(evt('KeyZ', 'y'), 'layout')).toBe('y');
    });

    it('defaults to layout mode', () => {
      expect(mapKey(evt('KeyY', 'z'))).toBe('z');
    });

    it('keeps Ctrl+Z as undo (z), not redo (y)', () => {
      expect(mapKey(evt('KeyY', 'z', { ctrlKey: true }), 'layout')).toBe('z');
    });

    it('lowercases shifted letters (shift travels in modifiers)', () => {
      expect(mapKey(evt('KeyY', 'Z', { shiftKey: true }), 'layout')).toBe('z');
    });

    it('falls back to the physical key when AltGr produced a non-letter', () => {
      // AltGr+Q = "@" on QWERTZ: send q with ctrl+alt so the remote layout
      // produces the symbol itself, exactly as before.
      expect(mapKey(evt('KeyQ', '@', { ctrlKey: true, altKey: true }), 'layout')).toBe('q');
    });

    it('sends positional names to a macOS remote (its injector is positional)', () => {
      expect(mapKey(evt('KeyY', 'z'), 'positional')).toBe('y');
      expect(mapKey(evt('KeyZ', 'y'), 'positional')).toBe('z');
    });
  });

  describe('French AZERTY', () => {
    it('maps the A/Q and Z/W swaps by produced letter', () => {
      expect(mapKey(evt('KeyQ', 'a'), 'layout')).toBe('a');
      expect(mapKey(evt('KeyA', 'q'), 'layout')).toBe('q');
      expect(mapKey(evt('KeyW', 'z'), 'layout')).toBe('z');
      expect(mapKey(evt('KeyZ', 'w'), 'layout')).toBe('w');
    });

    it('maps M (physically Semicolon) to m', () => {
      expect(mapKey(evt('Semicolon', 'm'), 'layout')).toBe('m');
    });

    it('sends positional names to a macOS remote', () => {
      expect(mapKey(evt('KeyQ', 'a'), 'positional')).toBe('q');
      expect(mapKey(evt('Semicolon', 'm'), 'positional')).toBe(';');
    });
  });

  it('ignores non-ASCII letters and keeps the physical key (e.g. Cyrillic)', () => {
    // A Russian layout's "я" sits on KeyZ; the remote's own layout turns z back into я.
    expect(mapKey(evt('KeyZ', 'я'), 'layout')).toBe('z');
  });

  it('ignores dead keys', () => {
    expect(mapKey(evt('BracketLeft', 'Dead'), 'layout')).toBe('[');
  });

  it('never reinterprets non-letter keys', () => {
    expect(mapKey(evt('Digit7', '/', { shiftKey: true }), 'layout')).toBe('7');
    expect(mapKey(evt('ArrowUp', 'ArrowUp'), 'layout')).toBe('up');
    expect(mapKey(evt('ShiftLeft', 'Shift'), 'layout')).toBe('shift');
    expect(mapKey(evt('Space', ' '), 'layout')).toBe('space');
  });
});

describe('keyNameModeFor (issue #7809)', () => {
  it('is positional only for macOS remotes', () => {
    expect(keyNameModeFor('macos')).toBe('positional');
    expect(keyNameModeFor('windows')).toBe('layout');
    expect(keyNameModeFor('linux')).toBe('layout');
    expect(keyNameModeFor(null)).toBe('layout');
  });
});

describe('resolveKeyUpName (issue #7809)', () => {
  const up = (code: string, key: string) => new KeyboardEvent('keyup', { code, key });

  it('releases the exact name that was pressed, even if the produced char changed', () => {
    // Z cap pressed (sent "z"); AltGr engaged before release turns key into a
    // symbol. Re-mapping the keyup would release "y" and strand "z" held down.
    const held = new Map([['KeyY', 'z']]);
    expect(resolveKeyUpName(up('KeyY', '←'), held, 'layout')).toBe('z');
    expect(held.has('KeyY')).toBe(false);
  });

  it('maps normally when the key was not recorded as held', () => {
    expect(resolveKeyUpName(up('KeyY', 'z'), new Map(), 'layout')).toBe('z');
  });
});
