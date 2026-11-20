import { describe, it, expect } from 'vitest';
import { suppressedByViewOnly, isReleaseEvent } from './viewOnly';

describe('view-only input gate', () => {
  it('passes everything through when view-only is off', () => {
    for (const type of ['key_down', 'key_up', 'key_press', 'mouse_move', 'mouse_down', 'mouse_up', 'mouse_scroll']) {
      expect(suppressedByViewOnly({ type }, false)).toBe(false);
    }
  });

  it('suppresses every press, move, scroll and chord while view-only', () => {
    for (const type of ['key_down', 'key_press', 'mouse_move', 'mouse_down', 'mouse_scroll', 'type_text', undefined]) {
      expect(suppressedByViewOnly({ type }, true), String(type)).toBe(true);
    }
  });

  it('still lets releases out, so a key held before activation can never stay latched', () => {
    expect(suppressedByViewOnly({ type: 'key_up', key: 'a' }, true)).toBe(false);
    expect(suppressedByViewOnly({ type: 'mouse_up', x: 0, y: 0, button: 'left' }, true)).toBe(false);
  });

  it('only key_up and mouse_up count as releases', () => {
    expect(isReleaseEvent({ type: 'key_up' })).toBe(true);
    expect(isReleaseEvent({ type: 'mouse_up' })).toBe(true);
    expect(isReleaseEvent({ type: 'key_press' })).toBe(false);
    expect(isReleaseEvent({})).toBe(false);
  });
});
