import { describe, it, expect } from 'vitest';
import { charToKeyEvent, textToKeyEvents, SHIFTED_TO_BASE } from './paste';

describe('charToKeyEvent', () => {
  it('maps lowercase letters without modifiers', () => {
    expect(charToKeyEvent('a')).toEqual({ type: 'key_press', key: 'a', modifiers: [] });
    expect(charToKeyEvent('z')).toEqual({ type: 'key_press', key: 'z', modifiers: [] });
  });

  it('maps uppercase letters with shift modifier', () => {
    expect(charToKeyEvent('A')).toEqual({ type: 'key_press', key: 'a', modifiers: ['shift'] });
    expect(charToKeyEvent('Z')).toEqual({ type: 'key_press', key: 'z', modifiers: ['shift'] });
  });

  it('maps digits without modifiers', () => {
    expect(charToKeyEvent('0')).toEqual({ type: 'key_press', key: '0', modifiers: [] });
    expect(charToKeyEvent('9')).toEqual({ type: 'key_press', key: '9', modifiers: [] });
  });

  it('maps newline to return', () => {
    expect(charToKeyEvent('\n')).toEqual({ type: 'key_press', key: 'return', modifiers: [] });
    expect(charToKeyEvent('\r')).toEqual({ type: 'key_press', key: 'return', modifiers: [] });
  });

  it('maps tab', () => {
    expect(charToKeyEvent('\t')).toEqual({ type: 'key_press', key: 'tab', modifiers: [] });
  });

  it('maps space', () => {
    expect(charToKeyEvent(' ')).toEqual({ type: 'key_press', key: ' ', modifiers: [] });
  });

  it('maps all shifted symbols to base key + shift', () => {
    for (const [shifted, base] of Object.entries(SHIFTED_TO_BASE)) {
      const result = charToKeyEvent(shifted);
      expect(result, `${shifted} → ${base} + shift`).toEqual({
        type: 'key_press',
        key: base,
        modifiers: ['shift'],
      });
    }
  });

  it('maps unshifted symbols without modifiers', () => {
    const unshifted = ['-', '=', '[', ']', '\\', ';', "'", '`', ',', '.', '/'];
    for (const char of unshifted) {
      const result = charToKeyEvent(char);
      expect(result, `unshifted symbol: ${char}`).toEqual({
        type: 'key_press',
        key: char,
        modifiers: [],
      });
    }
  });
});

describe('textToKeyEvents', () => {
  it('converts plain lowercase text', () => {
    const events = textToKeyEvents('hi');
    expect(events).toEqual([
      { type: 'key_press', key: 'h', modifiers: [] },
      { type: 'key_press', key: 'i', modifiers: [] },
    ]);
  });

  it('handles mixed case', () => {
    const events = textToKeyEvents('Hi');
    expect(events).toEqual([
      { type: 'key_press', key: 'h', modifiers: ['shift'] },
      { type: 'key_press', key: 'i', modifiers: [] },
    ]);
  });

  it('collapses CRLF into single Return', () => {
    const events = textToKeyEvents('a\r\nb');
    expect(events).toEqual([
      { type: 'key_press', key: 'a', modifiers: [] },
      { type: 'key_press', key: 'return', modifiers: [] },
      { type: 'key_press', key: 'b', modifiers: [] },
    ]);
  });

  it('handles lone \\r and lone \\n as separate Returns', () => {
    const events = textToKeyEvents('a\rb\nc');
    expect(events).toEqual([
      { type: 'key_press', key: 'a', modifiers: [] },
      { type: 'key_press', key: 'return', modifiers: [] },
      { type: 'key_press', key: 'b', modifiers: [] },
      { type: 'key_press', key: 'return', modifiers: [] },
      { type: 'key_press', key: 'c', modifiers: [] },
    ]);
  });

  it('handles tabs and shifted symbols', () => {
    const events = textToKeyEvents('a\t!');
    expect(events).toEqual([
      { type: 'key_press', key: 'a', modifiers: [] },
      { type: 'key_press', key: 'tab', modifiers: [] },
      { type: 'key_press', key: '1', modifiers: ['shift'] },
    ]);
  });

  it('returns empty array for empty string', () => {
    expect(textToKeyEvents('')).toEqual([]);
  });

  it('handles realistic multiline text', () => {
    const events = textToKeyEvents('Hello!\r\nWorld');
    expect(events).toHaveLength(12); // H e l l o ! \r\n W o r l d = 5+1+1+5 = 12
    expect(events[0]).toEqual({ type: 'key_press', key: 'h', modifiers: ['shift'] }); // H
    expect(events[5]).toEqual({ type: 'key_press', key: '1', modifiers: ['shift'] }); // !
    expect(events[6]).toEqual({ type: 'key_press', key: 'return', modifiers: [] });   // \r\n
    expect(events[7]).toEqual({ type: 'key_press', key: 'w', modifiers: ['shift'] }); // W
  });
});
