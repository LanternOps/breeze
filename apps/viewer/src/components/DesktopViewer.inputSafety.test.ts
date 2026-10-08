import { describe, it, expect } from 'vitest';
// Source-derived guards, same approach as DesktopViewer.capsLock.test.ts: the
// viewer has no React test harness, and these are wiring invariants whose
// regression is invisible in review. The decisions themselves are unit-tested
// in lib/inputSafety.test.ts.
import source from './DesktopViewer.tsx?raw';

describe('DesktopViewer input safety wiring', () => {
  it('maps mouse buttons through mouseButtonName (back/forward must not click)', () => {
    expect(source).not.toMatch(/e\.button === 2 \? 'right'/);
    expect(source.match(/mouseButtonName\(e\.button\)/g)).toHaveLength(2);
  });

  it('releases held input when the window loses focus or is hidden', () => {
    expect(source).toMatch(/addEventListener\('blur', onWindowBlur\)/);
    expect(source).toMatch(/visibilityState === 'hidden'\) releaseAllKeysRef\.current\(\)/);
    expect(source).toMatch(/onBlur: handleInputBlur/);
  });

  it('releases held mouse buttons, not just keys', () => {
    expect(source).toMatch(/for \(const button of pressedButtonsRef\.current\)/);
  });

  it('captures the pointer so a drag released outside the video still sends mouse_up', () => {
    expect(source).toMatch(/setPointerCapture\(e\.pointerId\)/);
    expect(source).toMatch(/onPointerDown: handlePointerDown/);
  });

  it('leaves remote→local clipboard writes to the controller, which gates them on the focus rule', () => {
    // The rule itself is exercised in lib/clipboardSync.test.ts and
    // lib/vncClipboard.test.ts; here, only that nothing bypasses it.
    expect(source).not.toMatch(/writeText\(payload/);
    expect(source).not.toMatch(/remoteClipboardDecision\(/);
  });

  it('does not hard-code the Cmd↔Ctrl remap on', () => {
    expect(source).not.toMatch(/useState\(true\);\s*\n\s*const \[cursorStreamActive/);
    expect(source).toMatch(/defaultRemapCmdCtrl\(VIEWER_OS, remoteOs\)/);
  });

  it('routes chords through chordRouting in both the key path and the Ctrl+V path', () => {
    expect(source.match(/chordRouting\(\{/g)).toHaveLength(2);
  });

  it('keeps no Ctrl/Cmd+Shift viewer shortcuts — they belong to remote apps', () => {
    expect(source).not.toMatch(/ne\.code === 'KeyF' && ne\.shiftKey/);
    expect(source).not.toMatch(/ne\.code === 'KeyV' && ne\.shiftKey/);
    expect(source).toMatch(/viewerShortcut\(ne, VIEWER_OS\)/);
  });

  it('pushes the clipboard for every paste chord, not just Ctrl/Cmd+V', () => {
    expect(source).toMatch(/if \(isPasteChord\(ne\)\) \{/);
  });

  it('forgets modifiers a key_press released, at both key_press fallbacks', () => {
    expect(source.match(/forgetModifiersReleasedByKeyPress\((modifiers|pasteModifiers)\);/g)).toHaveLength(2);
  });

  it('binds stranded releases to the device they were pressed on', () => {
    expect(source).toMatch(/stranded\.destination === inputDestinationRef\.current/);
  });

  it('flushes stranded releases when the input channel opens after connect', () => {
    expect(source).toMatch(/ch\.addEventListener\('open', onOpen, \{ once: true \}\)/);
  });

  it('records copy intent instead of a blur grace for background clipboard pushes', () => {
    expect(source).toMatch(/if \(isCopyChord\(ne\)\) lastCopyIntentAtRef\.current = Date\.now\(\);/);
    expect(source).not.toMatch(/lastBlurAt/);
  });

  it('runs one clipboard controller per clipboard channel, closing the one it replaces', () => {
    const open = source.indexOf('onClipboardChannel: (channel) => {');
    const close = source.indexOf('clipboardSyncRef.current?.close();', open);
    const create = source.indexOf('new ClipboardSync({', open);
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    expect(create).toBeGreaterThan(close);
  });

  it('pastes through the controller\'s transaction, and no longer through the W1 ack map', () => {
    expect(source).toMatch(/\.pasteTransaction\(dispatchPaste\)/);
    expect(source).not.toMatch(/handleCtrlVPaste/);
    expect(source).not.toMatch(/clipboardAckMapRef/);
  });

  it('closes the clipboard controller on unmount', () => {
    const unmount = source.indexOf("invoke('unregister_session')");
    const close = source.lastIndexOf('clipboardSyncRef.current?.close();', unmount);
    expect(close).toBeGreaterThan(source.indexOf('const oldVnc = vncSessionRef.current;'));
  });

  it('wires VNC clipboard and the toolbar chip', () => {
    expect(source).toMatch(/clipboard: \{\s*readLocalText:/);
    expect(source).toMatch(/clipboardChip=\{\{/);
  });
});
