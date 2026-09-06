import { describe, it, expect } from 'vitest';
// Vite's ?raw import hands us the file as a string. Used instead of node:fs
// because apps/viewer is a browser-targeted package with no @types/node, and
// pulling those in for one test would change type resolution package-wide.
import source from './DesktopViewer.tsx?raw';

/**
 * Source-derived guard for the Caps Lock wiring in DesktopViewer (issue #3595).
 *
 * The fix only works if EVERY keyboard event forwarded from a real
 * KeyboardEvent carries the `capsLock` state. Miss one call site and that key
 * silently falls back to the agent's legacy path, where it inherits the remote
 * machine's ambient AlphaShift — i.e. the original bug, reappearing for one
 * key, intermittently. That is not the kind of regression a reviewer catches by
 * eye.
 *
 * A behavioural test would be better, but apps/viewer has no React test harness
 * at all (no @testing-library/react, no *.test.tsx), and standing one up for a
 * 2,200-line component is its own piece of work. So this asserts over the
 * source text instead — the same approach desktopWs_inputSchema.test.ts already
 * takes against this very file.
 */

/**
 * Emits that legitimately omit `capsLock`, each with the reason it is not a
 * real keystroke. Adding to this list should require the same justification.
 */
const SYNTHETIC_EMITS_WITHOUT_CAPS_STATE = new Map<string, string>([
  [
    "sendInputFn({ type: 'key_up', key });",
    'releaseAllKeys: a bulk release of keys stranded in pressedKeysRef. There ' +
      'is no KeyboardEvent to read a state from, and releasing a key cannot ' +
      'change casing.',
  ],
  [
    "sendInputFn({ type: 'key_press', key, modifiers });",
    'handleSendKeys: toolbar combos (Ctrl+Alt+Del and friends) are pressed by ' +
      'a button, not typed, so they are deliberately Caps Lock independent.',
  ],
]);

function keyboardEmits(): string[] {
  return source.match(/sendInputFn\(\{ type: 'key_[a-z]+'[^)]*\)/g) ?? [];
}

describe('DesktopViewer Caps Lock wiring (issue #3595)', () => {
  const emits = keyboardEmits();

  it('actually found the keyboard emit sites (guards against a vacuous regex)', () => {
    // If the regex ever matches nothing — a refactor renames sendInputFn, say —
    // the assertion below would pass over an empty list and this guard would go
    // silently green while protecting nothing.
    expect(emits.length).toBeGreaterThanOrEqual(9);
    expect(emits.some((e) => e.includes("type: 'key_down'"))).toBe(true);
    expect(emits.some((e) => e.includes("type: 'key_up'"))).toBe(true);
    expect(emits.some((e) => e.includes("type: 'key_press'"))).toBe(true);
  });

  it('every keyboard emit either carries capsLock or is a known synthetic emit', () => {
    const offenders = emits.filter((emit) => {
      if (emit.includes('capsLock')) return false;
      return !SYNTHETIC_EMITS_WITHOUT_CAPS_STATE.has(`${emit};`);
    });

    expect(
      offenders,
      'These keyboard events are forwarded without the operator\'s Caps Lock ' +
        'state, so the agent falls back to inheriting the remote machine\'s ' +
        'ambient AlphaShift for them (issue #3595). Add `capsLock` to the ' +
        'emit, or add it to SYNTHETIC_EMITS_WITHOUT_CAPS_STATE with a reason ' +
        'if it is not a real keystroke.'
    ).toEqual([]);
  });

  it('both handlers read the live state rather than a cached one', () => {
    // Per-event state is what makes this resilient to the input DataChannel
    // being unreliable (maxRetransmits: 0). A cached "last sent" value would
    // reintroduce the desync a dropped packet causes.
    const reads = source.match(/const capsLock = getCapsLockState\(ne\);/g) ?? [];
    expect(reads).toHaveLength(2); // handleKeyDown + handleKeyUp
  });

  it('CapsLock never enters the pressed-key bookkeeping', () => {
    // pressedKeysRef drives releaseAllKeys. Caps Lock is a toggle and is never
    // "held", so adding it would strand it and emit a release for a key that
    // was never pressed.
    expect(source).not.toMatch(/pressedKeysRef\.current\.add\(\s*'capslock'\s*\)/);
  });
});
