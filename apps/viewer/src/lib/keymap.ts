/**
 * Map DOM KeyboardEvent.code/key to agent-compatible key names.
 * The agent input handlers expect key names matching their platform tables
 * (e.g., input_windows.go charToVK, input_darwin.go AppleScript keystroke).
 */

const codeToKey: Record<string, string> = {
  // Letters
  KeyA: 'a', KeyB: 'b', KeyC: 'c', KeyD: 'd', KeyE: 'e',
  KeyF: 'f', KeyG: 'g', KeyH: 'h', KeyI: 'i', KeyJ: 'j',
  KeyK: 'k', KeyL: 'l', KeyM: 'm', KeyN: 'n', KeyO: 'o',
  KeyP: 'p', KeyQ: 'q', KeyR: 'r', KeyS: 's', KeyT: 't',
  KeyU: 'u', KeyV: 'v', KeyW: 'w', KeyX: 'x', KeyY: 'y',
  KeyZ: 'z',

  // Numbers
  Digit0: '0', Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4',
  Digit5: '5', Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9',

  // Function keys
  F1: 'f1', F2: 'f2', F3: 'f3', F4: 'f4', F5: 'f5', F6: 'f6',
  F7: 'f7', F8: 'f8', F9: 'f9', F10: 'f10', F11: 'f11', F12: 'f12',

  // Navigation
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',

  // Editing
  Backspace: 'backspace', Delete: 'delete', Enter: 'return',
  Tab: 'tab', Escape: 'escape', Space: 'space',
  Insert: 'insert',

  // Symbols
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`',
  Comma: ',', Period: '.', Slash: '/',

  // Numpad
  Numpad0: 'num0', Numpad1: 'num1', Numpad2: 'num2', Numpad3: 'num3',
  Numpad4: 'num4', Numpad5: 'num5', Numpad6: 'num6', Numpad7: 'num7',
  Numpad8: 'num8', Numpad9: 'num9',
  NumpadAdd: 'add', NumpadSubtract: 'subtract', NumpadMultiply: 'multiply',
  NumpadDivide: 'divide', NumpadDecimal: 'decimal', NumpadEnter: 'return',

  // Other
  PrintScreen: 'printscreen', ScrollLock: 'scrolllock',
  Pause: 'pause', NumLock: 'numlock', CapsLock: 'capslock',
};

/**
 * Convert a DOM KeyboardEvent to an agent key name
 */
export function mapKey(e: KeyboardEvent): string | null {
  // Try code first (physical key position)
  if (e.code in codeToKey) {
    return codeToKey[e.code];
  }

  // Fall back to key value for characters
  if (e.key.length === 1) {
    return e.key.toLowerCase();
  }

  return null;
}

/**
 * Extract modifiers from a KeyboardEvent
 */
export function getModifiers(e: KeyboardEvent): string[] {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  if (e.metaKey) mods.push('meta');
  return mods;
}

/**
 * Check if a key event is a modifier-only press (don't send to agent)
 */
export function isModifierOnly(e: KeyboardEvent): boolean {
  return ['Control', 'Alt', 'Shift', 'Meta'].includes(e.key);
}
