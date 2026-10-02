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

  // Modifiers — forwarded as standalone key_down/key_up so Shift+Click,
  // Ctrl+Click, etc. work for multi-select on the remote machine.
  ShiftLeft: 'shift', ShiftRight: 'shift',
  ControlLeft: 'ctrl', ControlRight: 'ctrl',
  AltLeft: 'alt', AltRight: 'alt',
  MetaLeft: 'meta', MetaRight: 'meta',
};

/**
 * How the remote agent turns a LETTER key name into an injected key (#7809):
 *
 *  - 'layout'     — Windows (VK_A..VK_Z via SendInput) and Linux (keysym →
 *                   keycode on the active XKB map) resolve the name through the
 *                   REMOTE keyboard layout, so the name must be the letter the
 *                   operator actually typed. Sending the physical US position
 *                   instead is what swapped Y/Z for German QWERTZ users.
 *  - 'positional' — macOS injects fixed kVK_ANSI_* keycodes (US physical
 *                   positions) and lets the remote layout produce the char, so
 *                   the name must stay the physical key.
 *
 * Only ASCII letters are affected. Digits, punctuation, AltGr symbols and
 * non-Latin letters keep the physical key in both modes: their names map to
 * US-layout keys on the agent, and a produced char like "/" (Shift+7 on
 * QWERTZ) or "@" (AltGr+Q) has no single-key equivalent to send.
 */
export type KeyNameMode = 'layout' | 'positional';

export function keyNameModeFor(remoteOs: string | null | undefined): KeyNameMode {
  return remoteOs === 'macos' ? 'positional' : 'layout';
}

const ASCII_LETTER = /^[a-z]$/i;

/**
 * Convert a DOM KeyboardEvent to an agent key name
 */
export function mapKey(e: KeyboardEvent, mode: KeyNameMode = 'layout'): string | null {
  // A letter the active local layout produced (QWERTZ Z on KeyY, AZERTY A on
  // KeyQ / M on Semicolon). Ctrl/Cmd don't change e.key for letters, so
  // shortcuts follow the cap too (Ctrl+Z stays undo on QWERTZ).
  if (mode === 'layout' && ASCII_LETTER.test(e.key)) {
    return e.key.toLowerCase();
  }

  // Otherwise the physical key position
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
 * Name to send on keyup. In 'layout' mode the name depends on e.key, which can
 * differ between a key's down and up (AltGr or a layout switch while held), so
 * the name sent on key_down is remembered per physical key (`heldByCode`) and
 * replayed here. Re-mapping instead would release a different key than was
 * pressed and leave the original stuck down on the remote machine.
 * Consumes the entry.
 */
export function resolveKeyUpName(
  e: KeyboardEvent,
  heldByCode: Map<string, string>,
  mode: KeyNameMode = 'layout'
): string | null {
  const held = e.code ? heldByCode.get(e.code) : undefined;
  if (held !== undefined) {
    heldByCode.delete(e.code);
    return held;
  }
  return mapKey(e, mode);
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

/**
 * Check if a key event is the Caps Lock key itself.
 *
 * Deliberately NOT folded into isModifierOnly: that predicate drives the
 * "hold this modifier down on the remote machine" branch, and Caps Lock is a
 * toggle rather than a key that is held. Treating it as held would latch it in
 * the pressed-key set and emit a release for a key that was never held.
 */
export function isCapsLock(e: KeyboardEvent): boolean {
  return e.code === 'CapsLock' || e.key === 'CapsLock';
}

/**
 * Read the Caps Lock state that is in effect for this key event.
 *
 * Every keyboard event we forward carries this, so the remote machine's Caps
 * Lock state is asserted rather than inferred from a synthetic key press
 * (issue #3595). Two reasons it is per-event rather than sent once on change:
 *
 *  - The input DataChannel is ordered but UNRELIABLE (maxRetransmits: 0), so a
 *    single dropped "caps changed" message would leave the agent applying the
 *    wrong state to every keystroke for the rest of the session.
 *  - macOS reports Caps Lock as keydown-on-engage / keyup-on-disengage rather
 *    than a matched down/up pair, so there is no reliable edge to count.
 *
 * getModifierState is guarded because the Viewer also runs against synthetic
 * events in tests and older webviews.
 */
export function getCapsLockState(e: KeyboardEvent): boolean {
  return typeof e.getModifierState === 'function' && e.getModifierState('CapsLock');
}
