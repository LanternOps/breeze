import { describe, it, expect } from 'vitest';
import { mapKey, getModifiers, isModifierOnly } from './keymap';

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

