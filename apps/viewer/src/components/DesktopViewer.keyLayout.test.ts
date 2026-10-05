import { describe, it, expect } from 'vitest';
import source from './DesktopViewer.tsx?raw';

/**
 * Source-derived guard for the layout-aware key wiring (issue #7809). Same
 * approach as DesktopViewer.capsLock.test.ts: apps/viewer has no React test
 * harness, and the behaviour lives in keymap.ts (unit-tested there), so this
 * only pins that the component actually uses it.
 */
describe('DesktopViewer layout-aware keys (issue #7809)', () => {
  it('derives the key-name mode from the remote OS', () => {
    expect(source).toContain('const keyNameMode = keyNameModeFor(remoteOs);');
  });

  it('maps ordinary keystrokes with the remote-OS mode', () => {
    expect(source).toContain('const key = mapKey(ne, keyNameMode);');
  });

  it('records the name sent on key_down per physical key', () => {
    expect(source).toMatch(/heldKeyNameByCodeRef\.current\.set\(\s*ne\.code,\s*key\s*\)/);
  });

  it('releases the recorded name on key_up instead of re-mapping', () => {
    // Re-mapping on keyup can name a different key than the one pressed
    // (AltGr engaged while held), stranding the original down on the remote.
    expect(source).toMatch(
      /let key = resolveKeyUpName\(\s*ne,\s*heldKeyNameByCodeRef\.current,\s*keyNameMode\s*\)/
    );
  });

  it('keeps the Ctrl+V paste key positional (the branch is gated on physical KeyV)', () => {
    expect(source).toContain("const pasteKey = mapKey(ne, 'positional');");
  });

  it('forgets recorded names when all keys are force-released', () => {
    expect(source).toContain('heldKeyNameByCodeRef.current.clear();');
  });

  it('has no other bare mapKey(ne) call that would ignore the remote OS', () => {
    // Only the modifier-only branch may use the default: modifiers are never
    // letters, so the mode cannot change their name.
    const bare = source.match(/mapKey\(ne\)/g) ?? [];
    expect(bare).toHaveLength(1);
    expect(source).toContain('let modKey = mapKey(ne);');
  });
});
