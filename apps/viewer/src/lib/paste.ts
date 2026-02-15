/**
 * Paste-as-keystrokes utilities.
 * Converts clipboard text into a sequence of key events suitable for the agent.
 */

/** Shifted symbol → base key mapping (US keyboard layout). */
export const SHIFTED_TO_BASE: Record<string, string> = {
  '~': '`', '!': '1', '@': '2', '#': '3', '$': '4',
  '%': '5', '^': '6', '&': '7', '*': '8', '(': '9',
  ')': '0', '_': '-', '+': '=', '{': '[', '}': ']',
  '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.',
  '?': '/',
};

export interface PasteKeyEvent {
  type: 'key_press';
  key: string;
  modifiers: string[];
}

/**
 * Convert a single character to an agent key event.
 * Returns null for characters that can't be mapped (e.g. non-ASCII).
 */
export function charToKeyEvent(char: string): PasteKeyEvent | null {
  if (char === '\n' || char === '\r') {
    return { type: 'key_press', key: 'return', modifiers: [] };
  }
  if (char === '\t') {
    return { type: 'key_press', key: 'tab', modifiers: [] };
  }
  if (char >= 'A' && char <= 'Z') {
    return { type: 'key_press', key: char.toLowerCase(), modifiers: ['shift'] };
  }
  if (char in SHIFTED_TO_BASE) {
    return { type: 'key_press', key: SHIFTED_TO_BASE[char], modifiers: ['shift'] };
  }
  if (char.length === 1) {
    return { type: 'key_press', key: char, modifiers: [] };
  }
  return null;
}

/**
 * Convert a text string to a sequence of key events, collapsing CRLF into single Return.
 */
export function textToKeyEvents(text: string): PasteKeyEvent[] {
  const events: PasteKeyEvent[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    // Collapse \r\n into single Return
    if (char === '\r' && text[i + 1] === '\n') {
      events.push({ type: 'key_press', key: 'return', modifiers: [] });
      i++; // skip the \n
      continue;
    }
    const ev = charToKeyEvent(char);
    if (ev) events.push(ev);
  }
  return events;
}
